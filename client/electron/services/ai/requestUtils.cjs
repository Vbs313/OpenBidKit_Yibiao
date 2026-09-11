// AI 请求的通用工具层：Base URL / 超时 / 请求头 / 多模态与本地图片处理、用量统计、错误包装与图片落盘。
//
// 这些原本是 aiService.cjs 顶部的模块级常量与函数；搬出来后 aiService 只保留编排与各家 provider 的调用。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { nativeImage } = require('electron');
const { getGeneratedImagesDir } = require('../../utils/paths.cjs');
const { createDeveloperLogger } = require('../../utils/developerLog.cjs');
const textTokenStatsStore = require('../stores/textTokenStatsStore.cjs');
const { markAiRequestError } = require('../../utils/aiRetry.cjs');
const { copyAiHttpError, createAiHttpErrorFromResponse } = require('../../utils/aiHttpError.cjs');

const AI_REQUEST_TIMEOUT_MS = 600000;
const MULTIMODAL_IMAGE_MAX_EDGE = 2048;
const MULTIMODAL_IMAGE_JPEG_QUALITY = 85;

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function requireBaseUrl(baseUrl, message) {
  const trimmed = trimBaseUrl(baseUrl);
  if (!trimmed) {
    throw new Error(message);
  }
  return trimmed;
}

function isResponseFormatUnsupported(message) {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('response_format') && [
    'not supported',
    'does not support',
    'not support',
    'unsupported',
    'unknown parameter',
    'invalid parameter',
    'must be',
  ].some((marker) => normalized.includes(marker));
}

function createModuleDeveloperLogger(app, config, moduleName, request = {}) {
  return createDeveloperLogger({
    app,
    config,
    moduleName,
    name: request.name || request.logTitle || moduleName,
    meta: request.meta || {},
  });
}

function getTextTokenStatsSnapshot() {
  return textTokenStatsStore.getTextTokenStatsSnapshot();
}

function recordTextTokenStats(config, usage) {
  if (!config?.developer_mode) {
    return;
  }

  textTokenStatsStore.recordTextTokenStats(usage);
}

function resetTextTokenStats() {
  return textTokenStatsStore.resetTextTokenStats();
}

function onTextTokenStatsChanged(listener) {
  return textTokenStatsStore.onTextTokenStatsChanged(listener);
}

function normalizeRequestTimeoutMs(request) {
  const timeoutMs = Number(request?.timeout_ms);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : AI_REQUEST_TIMEOUT_MS;
}

function normalizeTextRequestMode(config) {
  return config?.request_mode === 'normal' ? 'normal' : 'stream';
}

// 读取本地图片，按原比例缩小最长边并编码为 JPEG Base64 Data URL。
async function compressLocalImageToDataUrl(filePath) {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath) {
    throw new Error('本地图片路径不能为空');
  }

  try {
    const sourceBuffer = await fs.promises.readFile(normalizedPath);
    const sourceImage = nativeImage.createFromBuffer(sourceBuffer);
    if (sourceImage.isEmpty()) {
      throw new Error('图片格式不受支持或文件已损坏');
    }

    const { width, height } = sourceImage.getSize();
    const maxEdge = Math.max(width, height);
    const image = maxEdge > MULTIMODAL_IMAGE_MAX_EDGE
      ? sourceImage.resize(width >= height
        ? { width: MULTIMODAL_IMAGE_MAX_EDGE, quality: 'best' }
        : { height: MULTIMODAL_IMAGE_MAX_EDGE, quality: 'best' })
      : sourceImage;
    const compressedBuffer = image.toJPEG(MULTIMODAL_IMAGE_JPEG_QUALITY);
    if (!compressedBuffer.length) {
      throw new Error('图片压缩结果为空');
    }

    return `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;
  } catch (error) {
    throw new Error(`图片读取或压缩失败（${path.basename(normalizedPath)}）：${error.message}`);
  }
}

// 未启用多模态时阻止包含图片的文本模型请求。
function ensureMultimodalEnabled(config, messages) {
  if (config.multimodal_enabled) return;
  const hasImage = messages.some((message) => Array.isArray(message.content)
    && message.content.some((part) => part?.type === 'local_image' || part?.type === 'image_url'));
  if (hasImage) {
    throw new Error('当前文本模型未开启多模态支持，请在设置中开启后重试');
  }
}

// 校验多模态能力，并将本地图片串行转换为 OpenAI Chat Completions 图片内容块。
async function prepareMultimodalMessages(config, messages) {
  ensureMultimodalEnabled(config, messages);
  const preparedMessages = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      preparedMessages.push(message);
      continue;
    }

    const content = [];
    for (const part of message.content) {
      if (part?.type !== 'local_image') {
        content.push(part);
        continue;
      }

      content.push({
        type: 'image_url',
        image_url: {
          url: await compressLocalImageToDataUrl(part.path),
          ...(part.detail ? { detail: part.detail } : {}),
        },
      });
    }
    preparedMessages.push({ ...message, content });
  }
  return preparedMessages;
}

function normalizeGoogleImageSize(imageConfig) {
  const size = String(imageConfig?.image_size || '1K').trim();
  return size || '1K';
}

function createAbortError() {
  const error = new Error('AI 请求超时');
  error.name = 'AbortError';
  return markAiRequestError(error, { retryable: true });
}

function createOperationTimeout(timeoutMs) {
  const controller = new AbortController();
  const timeoutPromise = new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(createAbortError());
    }, timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  });

  return {
    signal: controller.signal,
    run(promise) {
      return Promise.race([promise, timeoutPromise]);
    },
    clear() {
      controller.abort();
    },
  };
}

async function runWithOperationTimeout(runner, timeoutMs = AI_REQUEST_TIMEOUT_MS, parentSignal) {
  const timeout = createOperationTimeout(timeoutMs);
  try {
    const signal = parentSignal ? AbortSignal.any([timeout.signal, parentSignal]) : timeout.signal;
    return await timeout.run(runner(signal));
  } finally {
    timeout.clear();
  }
}

function createHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function imageExtensionFromMime(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('bmp')) return 'bmp';
  return 'png';
}

function getImageModelAvailability(config) {
  const imageConfig = config.image_model || {};
  if (imageConfig.status !== 'available') {
    return { available: false, status: imageConfig.status || 'untested', message: '生图模型未测试可用' };
  }

  if (imageConfig.provider === 'comfyui') {
    if (!trimBaseUrl(imageConfig.base_url)) {
      return { available: false, status: 'unavailable', message: '请先填写 ComfyUI 服务地址' };
    }
    return { available: true, status: 'available', message: '生图模型可用' };
  }

  if (!imageConfig.api_key) {
    return { available: false, status: 'unavailable', message: '请先填写生图模型 API Key' };
  }

  if (!imageConfig.model_name) {
    return { available: false, status: 'unavailable', message: '请先填写生图模型名称' };
  }

  if (!trimBaseUrl(imageConfig.base_url)) {
    return { available: false, status: 'unavailable', message: '请先填写生图模型 Base URL' };
  }

  return { available: true, status: 'available', message: '生图模型可用' };
}

function normalizeImagePrompt(request) {
  const prompt = String(request.prompt || '').trim();
  if (!prompt) {
    throw new Error('生图提示词为空');
  }

  const styleHint = request.style === 'realistic_photo'
    ? '画面采用专业实景照片风格，真实、克制、适合投标技术方案插图。'
    : '画面采用工程项目图示风格，结构清晰、专业克制、适合投标技术方案插图。';
  return `${prompt}\n\n${styleHint}\n避免出现品牌标识、水印、夸张营销元素和无关文字。`;
}

function safeImageResponse(data) {
  return {
    ...data,
    data: Array.isArray(data?.data)
      ? data.data.map((item) => ({ ...item, b64_json: item.b64_json ? '[base64 omitted]' : item.b64_json }))
      : data?.data,
    candidates: Array.isArray(data?.candidates) ? '[candidates omitted]' : data?.candidates,
  };
}

function copyRawAiErrorResponse(source, target) {
  for (const key of ['raw_response_body', 'raw_response_payload', 'raw_response_data', 'raw_sse_data']) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) {
      target[key] = source[key];
    }
  }
  return copyAiHttpError(source, target);
}

function createAiResponseDataError(message, responseData) {
  const error = new Error(message);
  error.raw_response_data = responseData;
  return error;
}

async function downloadImage(url, options = {}) {
  let response = null;
  try {
    response = await fetch(url, { signal: options.signal });
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  }
  await ensureOk(response, '图片下载失败');
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mime_type: response.headers.get('content-type') || 'image/png',
  };
}

function saveGeneratedImage(app, image) {
  const imagesDir = getGeneratedImagesDir(app);
  fs.mkdirSync(imagesDir, { recursive: true });
  const extension = imageExtensionFromMime(image.mime_type);
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.${extension}`;
  const filePath = path.join(imagesDir, fileName);
  fs.writeFileSync(filePath, image.buffer);
  return {
    asset_url: `yibiao-asset://generated-images/${encodeURIComponent(fileName)}`,
    file_path: filePath,
    mime_type: image.mime_type,
  };
}

async function ensureOk(response, fallbackMessage, options = {}) {
  if (response.ok) {
    return;
  }

  throw await createAiHttpErrorFromResponse(response, fallbackMessage, { source: options.source || 'ai-service' });
}

module.exports = {
  trimBaseUrl,
  requireBaseUrl,
  isResponseFormatUnsupported,
  createModuleDeveloperLogger,
  getTextTokenStatsSnapshot,
  recordTextTokenStats,
  resetTextTokenStats,
  onTextTokenStatsChanged,
  normalizeRequestTimeoutMs,
  normalizeTextRequestMode,
  compressLocalImageToDataUrl,
  ensureMultimodalEnabled,
  prepareMultimodalMessages,
  normalizeGoogleImageSize,
  createAbortError,
  createOperationTimeout,
  runWithOperationTimeout,
  createHeaders,
  imageExtensionFromMime,
  getImageModelAvailability,
  normalizeImagePrompt,
  safeImageResponse,
  copyRawAiErrorResponse,
  createAiResponseDataError,
  downloadImage,
  saveGeneratedImage,
  ensureOk,
  AI_REQUEST_TIMEOUT_MS,
};
