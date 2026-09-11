// ComfyUI 生图：工作流尺寸解析与校验、模板挑选、提交与轮询、执行错误提取、图片下载。
//
// 这些原本是 aiService.cjs 的模块级函数；搬出来后只依赖同目录的请求工具与生图请求体构造，可单独测试。

const path = require('node:path');
const { buildComfyUIImageWorkflow } = require('./imagePayloads.cjs');
const { trackAiRequest } = require('./requestTracking.cjs');
const { extractComfyUIHistoryWorkflow, extractComfyUIImages } = require('./providerParsers.cjs');
const { markAiRequestError, runWithAiRetry } = require('../../utils/aiRetry.cjs');
const { emitAiHttpErrorToWindows } = require('../../utils/aiHttpError.cjs');
const {
  createAiRequestId: createRequestId,
  resolveAiLogTitle,
  writeAiLog,
  getAiErrorLogResponse,
  getAiErrorLogError,
} = require('../../utils/aiLog.cjs');
const {
  AI_REQUEST_TIMEOUT_MS,
  requireBaseUrl,
  createAbortError,
  runWithOperationTimeout,
  normalizeImagePrompt,
  safeImageResponse,
  copyRawAiErrorResponse,
  createAiResponseDataError,
  saveGeneratedImage,
  ensureOk,
} = require('./requestUtils.cjs');

const IMAGE_MODEL_TEST_TIMEOUT_MESSAGE = '生图模型测试超时，请检查 Base URL、API Key 或模型名称';
const COMFYUI_POLL_INTERVAL_MS = 2000;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const COMFYUI_MIN_IMAGE_DIMENSION = 64;
const COMFYUI_MAX_IMAGE_DIMENSION = 8192;

function isValidComfyUIDimension(value) {
  return Number.isInteger(value)
    && value >= COMFYUI_MIN_IMAGE_DIMENSION
    && value <= COMFYUI_MAX_IMAGE_DIMENSION
    && value % 8 === 0;
}

function resolveComfyUIImageSize(imageConfig, requestSize) {
  const fallback = String(imageConfig?.image_size || '').trim() || '1024x1024';
  const requested = String(requestSize || '').trim();
  // 归一化常见写法：中文乘号 × / ✕、大写 X、内部空白
  const raw = (requested || fallback).replace(/[×✕X]/g, 'x').replace(/\s+/g, '');
  const direct = raw.match(/^(\d{1,5})x(\d{1,5})$/i);
  if (direct) {
    const width = Number(direct[1]);
    const height = Number(direct[2]);
    if (isValidComfyUIDimension(width) && isValidComfyUIDimension(height)) {
      return { width, height };
    }
  }
  switch (raw.toLowerCase()) {
    case '512':
      return { width: 512, height: 512 };
    case '2k':
      return { width: 2048, height: 2048 };
    case '4k':
      return { width: 4096, height: 4096 };
    default:
      // 'auto' / '1K' / 无法识别的写法统一回退默认方图
      return { width: 1024, height: 1024 };
  }
}

function parseComfyUIWorkflowJson(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ComfyUI 工作流 JSON 解析失败，请检查设置中粘贴的工作流内容');
  }
  // 兼容带 prompt 外层包装的导出内容
  if (parsed && typeof parsed === 'object' && parsed.prompt && typeof parsed.prompt === 'object') {
    parsed = parsed.prompt;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ComfyUI 工作流格式不正确，请粘贴 API 格式（Save API Format）导出的 JSON');
  }
  const hasNode = Object.values(parsed).some((node) => node && typeof node === 'object' && typeof node.class_type === 'string');
  if (!hasNode) {
    throw new Error('ComfyUI 工作流内容为空或不包含有效节点，请粘贴 API 格式（Save API Format）导出的 JSON');
  }
  return parsed;
}

function isComfyUITextToImageWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return false;
  let hasSampler = false;
  let hasTextEncode = false;
  let hasLatent = false;
  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object') continue;
    if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') hasSampler = true;
    if (node.class_type === 'CLIPTextEncode') hasTextEncode = true;
    if (node.class_type === 'EmptySD3LatentImage' || node.class_type === 'EmptyLatentImage') hasLatent = true;
  }
  return hasSampler && hasTextEncode && hasLatent;
}

// 历史条目的 prompt 元组在不同版本里布局不同（[prio, workflow, ...] 或 [prio, id, workflow, ...]），
// 取第一个"值为节点对象"的元素即为工作流

// 从执行消息中取时间戳（execution_start/execution_success），用于排序
function getComfyUIHistoryEntryTimestamp(entry) {
  const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
  let timestamp = 0;
  for (const message of messages) {
    if (Array.isArray(message) && (message[0] === 'execution_start' || message[0] === 'execution_success')) {
      const value = Number(message[1]?.timestamp);
      if (Number.isFinite(value) && value > timestamp) timestamp = value;
    }
  }
  return timestamp;
}

// 从 /history 中挑出最近一次成功执行的文生图工作流
function pickComfyUIHistoryWorkflow(historyData) {
  if (!historyData || typeof historyData !== 'object') return null;
  let picked = null;
  let pickedRank = -1;
  let index = 0;
  for (const entry of Object.values(historyData)) {
    index += 1;
    if (entry?.status?.status_str !== 'success') continue;
    const workflow = extractComfyUIHistoryWorkflow(entry?.prompt);
    if (!isComfyUITextToImageWorkflow(workflow)) continue;
    // 优先按执行时间戳取最新；时间戳缺失时退化为遍历顺序（>= 保证取到更靠后的条目）
    const rank = getComfyUIHistoryEntryTimestamp(entry) || index;
    if (rank >= pickedRank) {
      picked = workflow;
      pickedRank = rank;
    }
  }
  return picked;
}

async function fetchComfyUIJson(baseUrl, path, options = {}) {
  let response = null;
  try {
    response = await fetch(`${baseUrl}${path}`, { signal: options.signal });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// 服务器装有 checkpoint 模型时，按标准结构组装一个最简文生图工作流
function buildComfyUICheckpointWorkflow(objectInfo) {
  const checkpoints = objectInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  if (!Array.isArray(checkpoints)) return null;
  const checkpointName = checkpoints.find((name) => typeof name === 'string' && name.trim());
  if (!checkpointName) return null;
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpointName } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: 0, steps: 20, cfg: 7.0, sampler_name: 'euler', scheduler: 'normal', denoise: 1.0 } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'yibiao' } },
  };
}

// 工作流模板优先级：手动粘贴的 JSON > 服务器最近成功执行的工作流 > 按服务器已装模型自动组装
async function resolveComfyUIWorkflowTemplate(baseUrl, imageConfig, options = {}) {
  const raw = String(imageConfig?.comfyui_workflow || '').trim();
  if (raw) {
    const customWorkflow = parseComfyUIWorkflowJson(raw);
    if (!isComfyUITextToImageWorkflow(customWorkflow)) {
      throw new Error('设置中粘贴的工作流不是完整的文生图工作流：需要包含 KSampler、CLIPTextEncode 与 Empty Latent 节点（当前仅支持文生图，img2img 等工作流暂不支持）');
    }
    return { workflow: customWorkflow, source: 'custom' };
  }
  const historyData = await fetchComfyUIJson(baseUrl, '/history?max_items=50', options);
  const historyWorkflow = pickComfyUIHistoryWorkflow(historyData);
  if (historyWorkflow) {
    return { workflow: historyWorkflow, source: 'history' };
  }
  const objectInfo = await fetchComfyUIJson(baseUrl, '/object_info', options);
  const builtWorkflow = buildComfyUICheckpointWorkflow(objectInfo);
  if (builtWorkflow) {
    return { workflow: builtWorkflow, source: 'auto' };
  }
  throw new Error('未能从 ComfyUI 自动探测到可用的文生图工作流：请先在 ComfyUI 中成功运行一次文生图工作流（软件会自动复用最近一次的工作流），或在设置中粘贴 API 格式的工作流 JSON');
}

async function submitComfyUIPrompt(baseUrl, workflow, options = {}) {
  let response = null;
  try {
    response = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
      signal: options.signal,
    });
  } catch (error) {
    // 提交非幂等：网络错误时任务可能已入队，重试会导致同一提示词重复排队
    throw markAiRequestError(error, { retryable: false });
  }
  await ensureOk(response, 'ComfyUI 任务提交失败', { source: options.source || 'comfyui-image-model' });
  try {
    return await response.json();
  } catch (error) {
    throw markAiRequestError(error, { retryable: false });
  }
}

function getComfyUIExecutionError(entry) {
  const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
  for (const message of messages) {
    if (Array.isArray(message) && message[0] === 'execution_error') {
      const detail = message[1] || {};
      return detail.exception_message || detail.error || 'ComfyUI 节点执行失败';
    }
  }
  return 'ComfyUI 任务执行失败';
}

async function waitComfyUIImageResult(baseUrl, promptId, options = {}) {
  const deadline = Date.now() + AI_REQUEST_TIMEOUT_MS;
  let lastEntry = null;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw createAbortError();
    }
    try {
      const response = await fetch(`${baseUrl}/history/${promptId}`, { signal: options.signal });
      if (response.ok) {
        const data = await response.json();
        const entry = data?.[promptId];
        if (entry) {
          lastEntry = entry;
          const statusStr = entry.status?.status_str || '';
          if (statusStr === 'error') {
            throw createAiResponseDataError(getComfyUIExecutionError(entry), entry.status);
          }
          if (entry.status?.completed || statusStr === 'success') {
            const images = extractComfyUIImages(entry);
            if (images.length > 0) {
              return { entry, images };
            }
            // 已到终态但没有图片输出（典型原因：工作流缺少 SaveImage 节点），继续轮询不会有变化
            throw createAiResponseDataError('ComfyUI 任务已完成但没有产出图片，请检查工作流是否包含 SaveImage 等图片输出节点', entry.status);
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted || error?.name === 'AbortError') throw error;
      if (error?.raw_response_data) throw error;
      // 轮询期间的瞬时网络错误不致命，继续等待
    }
    await sleepMs(COMFYUI_POLL_INTERVAL_MS);
  }
  throw createAiResponseDataError('ComfyUI 生图等待超时', lastEntry?.status || null);
}

async function fetchComfyUIImage(baseUrl, image, options = {}) {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || '',
    type: image.type || 'output',
  });
  let response = null;
  try {
    response = await fetch(`${baseUrl}/view?${params.toString()}`, { signal: options.signal });
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  }
  await ensureOk(response, 'ComfyUI 图片下载失败', { source: options.source || 'comfyui-image-model' });
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mime_type: response.headers.get('content-type') || 'image/png',
  };
}

async function runComfyUIImageGeneration(app, config, request, options = {}) {
  const imageConfig = config.image_model || {};
  const baseUrl = requireBaseUrl(imageConfig.base_url, 'ComfyUI 服务地址缺失，请在设置中填写后保存配置');
  const overridePrompt = String(options.promptOverride || '').trim();
  const prompt = overridePrompt || normalizeImagePrompt(request);
  const size = options.sizeOverride || resolveComfyUIImageSize(imageConfig, request.size);
  const requestId = createRequestId();
  const logTitle = resolveAiLogTitle(request, request.title ? `AI生图-${request.title}` : 'AI生图');
  const logExtra = options.logExtra || {};
  let responseData = null;
  let analyticsTracked = false;

  try {
    const template = await resolveComfyUIWorkflowTemplate(baseUrl, imageConfig, { signal: request.signal });
    const workflow = buildComfyUIImageWorkflow(template.workflow, prompt, size);
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: logExtra.pendingType || 'image-pending',
      provider: 'comfyui',
      request_mode: 'normal',
      url: `${baseUrl}/prompt`,
      request: { prompt, size: `${size.width}x${size.height}`, workflow_source: template.source, workflow },
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    const submitted = await runWithAiRetry(() => runWithOperationTimeout(
      (signal) => submitComfyUIPrompt(baseUrl, workflow, { signal }),
      AI_REQUEST_TIMEOUT_MS,
      request.signal,
    ));
    const promptId = submitted?.prompt_id;
    if (!promptId) {
      throw createAiResponseDataError('ComfyUI 未返回任务 ID', submitted);
    }

    const { entry, images } = await runWithOperationTimeout(
      (signal) => waitComfyUIImageResult(baseUrl, promptId, { signal }),
      AI_REQUEST_TIMEOUT_MS,
      request.signal,
    );
    responseData = { prompt_id: promptId, status: entry?.status || null, images };
    trackAiRequest(app, config, { ai_request_type: 'image' });
    analyticsTracked = true;

    const image = await runWithOperationTimeout(
      (signal) => fetchComfyUIImage(baseUrl, images[0], { signal }),
      AI_REQUEST_TIMEOUT_MS,
      request.signal,
    );

    if (options.returnRawImage) {
      writeAiLog(app, config, {
        request_id: requestId,
        log_title: logTitle,
        type: logExtra.successType || 'image',
        provider: 'comfyui',
        request_mode: 'normal',
        request: { prompt, size: `${size.width}x${size.height}` },
        response: responseData,
        result: { filename: images[0].filename },
        created_at: new Date().toISOString(),
      });
      return { responseData, image, workflow_source: template.source };
    }

    const saved = saveGeneratedImage(app, image);
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image',
      provider: 'comfyui',
      request_mode: 'normal',
      request: { prompt, size: `${size.width}x${size.height}` },
      response: responseData,
      result: saved,
      created_at: new Date().toISOString(),
    });
    return { success: true, title: request.title || '', ...saved };
  } catch (error) {
    if (!analyticsTracked) {
      trackAiRequest(app, config, { ai_request_type: 'image' });
    }
    const errorMessage = options.isTest && error?.name === 'AbortError' ? IMAGE_MODEL_TEST_TIMEOUT_MESSAGE : error?.message || 'ComfyUI 生图失败';
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: logExtra.errorType || 'image-error',
      provider: 'comfyui',
      request_mode: 'normal',
      request: { prompt, size: `${size.width}x${size.height}` },
      response: getAiErrorLogResponse(error, responseData),
      error: getAiErrorLogError(error, errorMessage),
      created_at: new Date().toISOString(),
    });
    const finalError = markAiRequestError(copyRawAiErrorResponse(error, new Error(errorMessage)), { retryable: false });
    emitAiHttpErrorToWindows(finalError);
    throw finalError;
  }
}

async function generateComfyUIImage(app, config, request) {
  return runComfyUIImageGeneration(app, config, request);
}

module.exports = {
  runComfyUIImageGeneration,
  generateComfyUIImage,
  IMAGE_MODEL_TEST_TIMEOUT_MESSAGE,
  parseComfyUIWorkflowJson,
  isComfyUITextToImageWorkflow,
  resolveComfyUIImageSize,
};
