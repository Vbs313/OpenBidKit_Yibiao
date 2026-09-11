// Google 生图：请求体与 URL 构造、回包解析、内联图片数据提取，以及 Gemini 文本提取。
//
// 这些原本是 aiService.cjs 的模块级函数；搬出来后只依赖同目录的请求工具，可单独测试。

const { normalizeGoogleImageSize, safeImageResponse, createAiResponseDataError, ensureOk } = require('./requestUtils.cjs');
const { extractGoogleUsage, extractGoogleCandidateParts } = require('./providerParsers.cjs');
const { readSseJsonStream } = require('./streamReading.cjs');
const { markAiRequestError, runWithAiRetry } = require('../../utils/aiRetry.cjs');
const { createAiRequestId: createRequestId, resolveAiLogTitle, writeAiLog, getAiErrorLogResponse, getAiErrorLogError } = require('../../utils/aiLog.cjs');
const { trackAiRequest } = require('./requestTracking.cjs');
const { emitAiHttpErrorToWindows } = require('../../utils/aiHttpError.cjs');
const {
  AI_REQUEST_TIMEOUT_MS,
  requireBaseUrl,
  createAbortError,
  runWithOperationTimeout,
  normalizeImagePrompt,
  copyRawAiErrorResponse,
  saveGeneratedImage,
  IMAGE_MODEL_TEST_TIMEOUT_MESSAGE,
} = require('./requestUtils.cjs');
const { normalizeImageRequestMode } = require('./imagePayloads.cjs');

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

async function testGoogleImageModel(app, config) {
  const imageConfig = config.image_model || {};
  let analyticsTracked = false;

  if (!imageConfig.api_key) {
    throw new Error('请先填写 Google AI Studio API Key');
  }

  if (!imageConfig.model_name) {
    throw new Error('请先填写 Google 生图模型名称');
  }

  const baseUrl = requireBaseUrl(imageConfig.base_url, 'Google AI Studio Base URL 缺失，请重新选择服务商后保存配置');
  const requestMode = normalizeImageRequestMode(imageConfig);
  const requestId = createRequestId();
  const logTitle = 'AI生图测试-Google AI Studio';
  const requestBody = createGoogleImageRequestBody('大字报，内容是“易标AI老好了”', normalizeGoogleImageSize(imageConfig));
  const url = createGoogleImageUrl(baseUrl, imageConfig.model_name, requestMode);
  let responseData = null;

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-test-pending',
      provider: 'google-ai-studio',
      request_mode: requestMode,
      url,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    responseData = await runWithAiRetry(() => runWithOperationTimeout(
      (signal) => requestGoogleImageData(
        baseUrl,
        imageConfig,
        requestBody,
        requestMode,
        'Google AI Studio 生图测试失败',
        { signal },
      ),
      AI_REQUEST_TIMEOUT_MS,
    ));
    trackAiRequest(app, config, { ai_request_type: 'image', usage: extractGoogleUsage(responseData) });
    analyticsTracked = true;
    const text = getGoogleText(responseData);
    const inlineData = getGoogleImageInlineData(responseData);

    if (!inlineData?.data) {
      throw createAiResponseDataError('Google AI Studio 生图测试未返回图片数据', responseData);
    }

    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-test',
      provider: 'google-ai-studio',
      request_mode: requestMode,
      request: requestBody,
      response: safeImageResponse(responseData),
      result: {
        image_data: '[base64 omitted]',
        mime_type: inlineData?.mimeType || inlineData?.mime_type || 'image/png',
      },
      created_at: new Date().toISOString(),
    });

    return {
      success: true,
      message: `测试成功：已返回图片${text ? `，${text}` : ''}`,
      image_data: inlineData.data,
      mime_type: inlineData?.mimeType || inlineData?.mime_type || 'image/png',
    };
  } catch (error) {
    if (!analyticsTracked) {
      trackAiRequest(app, config, { ai_request_type: 'image' });
    }
    const errorMessage = error?.name === 'AbortError' ? IMAGE_MODEL_TEST_TIMEOUT_MESSAGE : error?.message || '生图模型测试失败';
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-test-error',
      provider: 'google-ai-studio',
      request_mode: requestMode,
      request: requestBody,
      response: getAiErrorLogResponse(error, responseData ? safeImageResponse(responseData) : null),
      error: getAiErrorLogError(error, errorMessage),
      created_at: new Date().toISOString(),
    });
    const wrappedError = copyRawAiErrorResponse(error, new Error(errorMessage));
    emitAiHttpErrorToWindows(wrappedError);
    throw wrappedError;
  }
}

async function generateGoogleImage(app, config, request) {
  const imageConfig = config.image_model || {};
  const requestId = createRequestId();
  const logTitle = resolveAiLogTitle(request, request.title ? `AI生图-${request.title}` : 'AI生图');
  const requestMode = normalizeImageRequestMode(imageConfig);
  const requestBody = createGoogleImageRequestBody(normalizeImagePrompt(request), normalizeGoogleImageSize(imageConfig));
  const baseUrl = requireBaseUrl(imageConfig.base_url, 'Google AI Studio Base URL 缺失，请重新选择服务商后保存配置');
  const url = createGoogleImageUrl(baseUrl, imageConfig.model_name, requestMode);
  let responseData = null;
  let analyticsTracked = false;

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-pending',
      provider: 'google-ai-studio',
      request_mode: requestMode,
      url,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    responseData = await runWithAiRetry(() => runWithOperationTimeout(
      (signal) => requestGoogleImageData(
        baseUrl,
        imageConfig,
        requestBody,
        requestMode,
        'Google AI Studio 生图失败',
        { signal },
      ),
      AI_REQUEST_TIMEOUT_MS,
      request.signal,
    ));
    trackAiRequest(app, config, { ai_request_type: 'image', usage: extractGoogleUsage(responseData) });
    analyticsTracked = true;
    const inlineData = getGoogleImageInlineData(responseData);

    if (!inlineData?.data) {
      throw createAiResponseDataError('Google AI Studio 生图未返回图片数据', responseData);
    }

    const saved = saveGeneratedImage(app, {
      buffer: Buffer.from(inlineData.data, 'base64'),
      mime_type: inlineData.mimeType || inlineData.mime_type || 'image/png',
    });
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image',
      provider: 'google-ai-studio',
      request_mode: requestMode,
      request: requestBody,
      response: safeImageResponse(responseData),
      result: saved,
      created_at: new Date().toISOString(),
    });
    return { success: true, title: request.title || '', ...saved };
  } catch (error) {
    if (!analyticsTracked) {
      trackAiRequest(app, config, { ai_request_type: 'image' });
      analyticsTracked = true;
    }
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-error',
      provider: 'google-ai-studio',
      request_mode: requestMode,
      request: requestBody,
      response: getAiErrorLogResponse(error, responseData ? safeImageResponse(responseData) : null),
      error: getAiErrorLogError(error, error.message),
      created_at: new Date().toISOString(),
    });
    const finalError = markAiRequestError(error, { retryable: false });
    emitAiHttpErrorToWindows(finalError);
    throw finalError;
  }
}

module.exports = {
  testGoogleImageModel,
  generateGoogleImage,
  createGoogleImageRequestBody,
  createGoogleImageUrl,
  createGoogleHeaders,
  appendGoogleImagePayload,
  readGoogleImageStream,
  requestGoogleImageData,
  getGoogleImageInlineData,
  getGoogleText,
};
