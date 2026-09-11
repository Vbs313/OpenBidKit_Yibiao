// 生图请求体与回包解析：OpenAI 兼容协议的请求构造、流式回包累积，以及 ComfyUI 工作流改写。
// 这些原本是 aiService.cjs 里的模块级工具函数；搬出来后 aiService 只负责编排与重试。
// 纯函数（只依赖 crypto 与同目录的错误文案归一），可单独测试。

const crypto = require('node:crypto');
const { normalizeStreamPayloadError } = require('./streamErrors.cjs');

function normalizeImageRequestMode(imageConfig) {
  return imageConfig?.request_mode === 'normal' ? 'normal' : 'stream';
}

function normalizeOpenAICompatibleImageSize(imageConfig, requestSize) {
  const requested = String(requestSize || '').trim();
  const configured = String(imageConfig?.image_size || '').trim();
  return requested || configured || '1024x1024';
}

const AGNES_IMAGE_2_0_SIZES = new Set(['1024x768', '1024x1024', '768x1024']);
const AGNES_IMAGE_2_1_SIZES = new Set(['1K', '2K', '3K', '4K']);
const AGNES_IMAGE_RATIOS = new Set(['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']);

// 按服务商协议构造 OpenAI 兼容生图请求。
function createOpenAICompatibleImageRequestBody(provider, imageConfig, prompt, requestSize) {
  const requestMode = normalizeImageRequestMode(imageConfig);
  const model = String(imageConfig?.model_name || '').trim();
  const size = normalizeOpenAICompatibleImageSize(imageConfig, requestSize);

  if (provider !== 'agnes') {
    return {
      model,
      prompt,
      size,
      response_format: 'url',
      ...(requestMode === 'stream' ? { stream: true } : {}),
    };
  }

  if (requestMode === 'stream') {
    throw new Error('Agnes AI 生图仅支持普通请求，请在设置中将请求方式改为普通请求');
  }
  if (size === 'auto') {
    throw new Error('Agnes AI 生图不支持自动尺寸，请在设置中选择具体图片尺寸');
  }

  if (model === 'agnes-image-2.0-flash' && !AGNES_IMAGE_2_0_SIZES.has(size)) {
    throw new Error('Agnes Image 2.0 Flash 仅支持 1024x768、1024x1024 或 768x1024');
  }
  if (model === 'agnes-image-2.1-flash' && !AGNES_IMAGE_2_1_SIZES.has(size)) {
    throw new Error('Agnes Image 2.1 Flash 请使用 1K、2K、3K 或 4K 图片尺寸');
  }

  const body = {
    model,
    prompt,
    size,
    extra_body: { response_format: 'url' },
  };
  if (model === 'agnes-image-2.1-flash') {
    const ratio = String(imageConfig?.image_ratio || '1:1').trim();
    body.ratio = AGNES_IMAGE_RATIOS.has(ratio) ? ratio : '1:1';
  }
  return body;
}

function appendOpenAICompatibleImageItem(state, item) {
  const url = String(item?.url || '');
  const b64Json = String(item?.b64_json || '');
  if (!url && !b64Json) {
    return;
  }

  state.images.push({
    ...item,
    url,
    b64_json: b64Json,
    mime_type: item?.mime_type || item?.mimeType || 'image/png',
  });
}

function appendOpenAICompatibleImageError(state, payload) {
  state.errors.push({
    image_index: payload?.image_index,
    code: payload?.error?.code || '',
    message: normalizeStreamPayloadError(payload?.error, '图片生成失败'),
    raw_payload: payload,
  });
}

function appendOpenAICompatibleImagePayload(payload, state) {
  if (payload?.usage) {
    state.usage = payload.usage;
  }

  if (payload?.error && payload?.type !== 'image_generation.completed' && payload?.type !== 'image_generation.partial_failed') {
    appendOpenAICompatibleImageError(state, payload);
    return;
  }

  if (payload?.type === 'image_generation.completed') {
    state.completed = payload;
    if (payload.usage) {
      state.usage = payload.usage;
    }
    if (Array.isArray(payload?.data)) {
      payload.data.forEach((item) => appendOpenAICompatibleImageItem(state, item));
    } else {
      appendOpenAICompatibleImageItem(state, payload);
    }
    if (payload.error) {
      appendOpenAICompatibleImageError(state, payload);
    }
    return;
  }

  if (payload?.type === 'image_generation.partial_failed') {
    appendOpenAICompatibleImageError(state, payload);
    return;
  }

  if (payload?.type === 'image_generation.partial_succeeded') {
    appendOpenAICompatibleImageItem(state, payload);
    return;
  }

  if (Array.isArray(payload?.data)) {
    payload.data.forEach((item) => appendOpenAICompatibleImageItem(state, item));
    return;
  }

  appendOpenAICompatibleImageItem(state, payload);
}

function buildComfyUIImageWorkflow(baseWorkflow, prompt, size) {
  const workflow = JSON.parse(JSON.stringify(baseWorkflow));
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new Error('ComfyUI 工作流格式不正确');
  }
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) {
    throw new Error('生图提示词为空，请检查输入内容');
  }

  const nodes = Object.entries(workflow);
  let samplerNode = null;
  let latentNode = null;
  let saveNode = null;
  for (const [, node] of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') samplerNode = samplerNode || node;
    if (node.class_type === 'EmptySD3LatentImage' || node.class_type === 'EmptyLatentImage') latentNode = latentNode || node;
    if (node.class_type === 'SaveImage') saveNode = saveNode || node;
  }

  // 正向提示词写入采样器 positive 指向的文本节点。
  // 兜底时必须排除采样器 negative 指向的节点，否则提示词会被写进负向节点（效果完全相反）
  let promptNode = null;
  const positiveRef = samplerNode?.inputs?.positive;
  if (Array.isArray(positiveRef) && workflow[positiveRef[0]]?.class_type === 'CLIPTextEncode') {
    promptNode = workflow[positiveRef[0]];
  }
  if (!promptNode) {
    const negativeRef = samplerNode?.inputs?.negative;
    const negativeNodeId = Array.isArray(negativeRef) ? String(negativeRef[0]) : null;
    const candidates = [];
    for (const [nodeId, node] of nodes) {
      if (node?.class_type === 'CLIPTextEncode' && nodeId !== negativeNodeId) {
        candidates.push(node);
      }
    }
    // 典型工作流里正向节点留空待注入、负向节点预填词，优先选空文本节点
    promptNode = candidates.find((node) => !String(node.inputs?.text || '').trim()) || candidates[0] || null;
  }
  if (!promptNode) {
    throw new Error('ComfyUI 工作流中没有可用的 CLIPTextEncode 正向提示词节点（positive 连接无效，且负向节点之外没有其他文本节点），请检查工作流连接');
  }
  promptNode.inputs = { ...promptNode.inputs, text: normalizedPrompt };

  if (latentNode) {
    latentNode.inputs = { ...latentNode.inputs, width: size.width, height: size.height };
  }

  // seed 为节点链接（数组）时保持原样，不能用随机数覆盖断链
  if (typeof samplerNode?.inputs?.seed === 'number') {
    samplerNode.inputs = { ...samplerNode.inputs, seed: crypto.randomInt(0, 4294967296) };
  } else if (typeof samplerNode?.inputs?.noise_seed === 'number') {
    samplerNode.inputs = { ...samplerNode.inputs, noise_seed: crypto.randomInt(0, 4294967296) };
  }

  if (saveNode) {
    saveNode.inputs = { ...saveNode.inputs, filename_prefix: 'yibiao' };
  }

  return workflow;
}

module.exports = {
  normalizeImageRequestMode,
  createOpenAICompatibleImageRequestBody,
  appendOpenAICompatibleImagePayload,
  buildComfyUIImageWorkflow,
};
