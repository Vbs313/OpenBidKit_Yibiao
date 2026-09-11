// Google 生图：请求体与 URL 构造、回包解析、内联图片数据提取，以及 Gemini 文本提取。
//
// 这些原本是 aiService.cjs 的模块级函数；搬出来后只依赖同目录的请求工具，可单独测试。

const { normalizeGoogleImageSize, safeImageResponse, createAiResponseDataError, ensureOk } = require('./requestUtils.cjs');
const { extractGoogleUsage, extractGoogleCandidateParts } = require('./providerParsers.cjs');
const { readSseJsonStream } = require('./streamReading.cjs');
const { markAiRequestError } = require('../../utils/aiRetry.cjs');

function createGoogleImageRequestBody(prompt, imageSize) {
  const generationConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
  };
  const normalizedImageSize = String(imageSize || '').trim();
  if (normalizedImageSize) {
    generationConfig.imageConfig = { imageSize: normalizedImageSize };
  }

  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig,
  };
}

function createGoogleImageUrl(baseUrl, modelName, requestMode) {
  const action = requestMode === 'stream' ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return `${baseUrl}/models/${encodeURIComponent(modelName)}:${action}`;
}

function createGoogleHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

function appendGoogleImagePayload(payload, state) {
  if (payload?.usageMetadata || payload?.usage_metadata) {
    state.usageMetadata = payload.usageMetadata || payload.usage_metadata;
  }

  state.parts.push(...extractGoogleCandidateParts(payload));
}

async function readGoogleImageStream(response) {
  const state = { parts: [], usageMetadata: null };

  await readSseJsonStream(response, {
    unreadableMessage: '生图流式响应不可读',
    parseErrorMessage: '生图流式响应解析失败',
    failureMessage: 'Google AI Studio 生图流式请求失败',
    onPayload(payload) {
      appendGoogleImagePayload(payload, state);
    },
  });

  return {
    stream: true,
    candidates: [{ content: { parts: state.parts } }],
    usageMetadata: state.usageMetadata,
  };
}

async function requestGoogleImageData(baseUrl, imageConfig, requestBody, requestMode, fallbackMessage, options = {}) {
  let response = null;
  try {
    response = await fetch(createGoogleImageUrl(baseUrl, imageConfig.model_name, requestMode), {
      method: 'POST',
      headers: createGoogleHeaders(imageConfig.api_key),
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  }

  await ensureOk(response, fallbackMessage, { source: 'google-image-model' });
  if (requestMode === 'stream') {
    return readGoogleImageStream(response);
  }
  try {
    return await response.json();
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  }
}

function getGoogleImageInlineData(responseData) {
  const imagePart = extractGoogleCandidateParts(responseData).find((part) => part.inlineData?.data || part.inline_data?.data);
  return imagePart?.inlineData || imagePart?.inline_data || null;
}

function getGoogleText(responseData) {
  return extractGoogleCandidateParts(responseData)
    .map((part) => part.text || '')
    .filter(Boolean)
    .join('')
    .trim();
}

module.exports = {
  createGoogleImageRequestBody,
  createGoogleImageUrl,
  createGoogleHeaders,
  appendGoogleImagePayload,
  readGoogleImageStream,
  requestGoogleImageData,
  getGoogleImageInlineData,
  getGoogleText,
};
