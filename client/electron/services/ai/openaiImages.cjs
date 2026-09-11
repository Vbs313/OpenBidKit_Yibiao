// OpenAI 兼容生图：模型可用性测试与正式生图两条链路（请求、流式/普通回包、落盘、错误包装）。
//
// 这些原本是 aiService.cjs 的模块级函数；搬出来后依赖同目录的请求工具与生图请求体构造，可单独测试。

const path = require('node:path');
const {
  createOpenAICompatibleImageRequestBody,
  appendOpenAICompatibleImagePayload,
  normalizeImageRequestMode,
} = require('./imagePayloads.cjs');
const { trackAiRequest } = require('./requestTracking.cjs');
const { extractOpenAIUsage } = require('./providerParsers.cjs');
const { readSseJsonStream } = require('./streamReading.cjs');
const { markAiRequestError, runWithAiRetry } = require('../../utils/aiRetry.cjs');
const { createAiHttpErrorFromResponse, emitAiHttpErrorToWindows } = require('../../utils/aiHttpError.cjs');
const { createAiRequestId: createRequestId, resolveAiLogTitle, writeAiLog, getAiErrorLogResponse, getAiErrorLogError } = require('../../utils/aiLog.cjs');
const {
  AI_REQUEST_TIMEOUT_MS,
  requireBaseUrl,
  createAbortError,
  createHeaders,
  runWithOperationTimeout,
  normalizeImagePrompt,
  safeImageResponse,
  copyRawAiErrorResponse,
  createAiResponseDataError,
  saveGeneratedImage,
  ensureOk,
  normalizeRequestTimeoutMs,
  isResponseFormatUnsupported,
  downloadImage,
  IMAGE_MODEL_TEST_TIMEOUT_MESSAGE,
} = require('./requestUtils.cjs');

async function fetchOpenAICompatibleImageResponse(baseUrl, apiKey, requestBody, fallbackMessage, options = {}) {
  const sendRequest = async (body) => {
    try {
      return await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: createHeaders(apiKey),
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      throw markAiRequestError(error, { retryable: true });
    }
  };
  const response = await sendRequest(requestBody);
  if (response.ok) {
    return response;
  }

  const error = await createAiHttpErrorFromResponse(response, fallbackMessage, {
    source: options.source || 'openai-compatible-image-model',
    responseFormatUnsupportedChecker: isResponseFormatUnsupported,
  });

  if (requestBody.response_format && error.responseFormatUnsupported) {
    const retryBody = { ...requestBody };
    delete retryBody.response_format;
    const retryResponse = await sendRequest(retryBody);
    await ensureOk(retryResponse, fallbackMessage, { source: options.source || 'openai-compatible-image-model' });
    return retryResponse;
  }

  throw error;
}

async function readOpenAICompatibleImageStream(response) {
  const state = { images: [], errors: [], completed: null, usage: null };

  await readSseJsonStream(response, {
    unreadableMessage: '生图流式响应不可读',
    parseErrorMessage: '生图流式响应解析失败',
    failureMessage: '生图流式请求失败',
    throwOnPayloadError: false,
    onPayload(payload) {
      appendOpenAICompatibleImagePayload(payload, state);
    },
  });

  return {
    stream: true,
    data: state.images,
    errors: state.errors,
    completed: state.completed,
    usage: state.usage,
  };
}

async function requestOpenAICompatibleImageData(baseUrl, apiKey, requestBody, fallbackMessage, options = {}) {
  const response = await fetchOpenAICompatibleImageResponse(baseUrl, apiKey, requestBody, fallbackMessage, options);
  if (requestBody.stream) {
    return readOpenAICompatibleImageStream(response);
  }
  try {
    return await response.json();
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  }
}

async function createImageFromOpenAICompatibleItem(item, options = {}) {
  if (item?.b64_json) {
    return {
      buffer: Buffer.from(item.b64_json, 'base64'),
      mime_type: item.mime_type || item.mimeType || 'image/png',
    };
  }

  if (item?.url) {
    return downloadImage(item.url, options);
  }

  return null;
}

function getOpenAICompatibleImageFailureMessage(responseData, fallbackMessage) {
  const firstError = Array.isArray(responseData?.errors) ? responseData.errors.find((item) => item?.message) : null;
  return firstError?.message || fallbackMessage;
}

async function testOpenAICompatibleImageModel(app, config, provider) {
  const imageConfig = config.image_model || {};
  const meta = OPENAI_IMAGE_PROVIDER_META[provider] || OPENAI_IMAGE_PROVIDER_META.volcengine;
  let responseData = null;
  let analyticsTracked = false;

  if (!imageConfig.api_key) {
    throw new Error(`请先填写${meta.label} API Key`);
  }

  if (!imageConfig.model_name) {
    throw new Error(`请先填写${meta.label}${meta.modelLabel}`);
  }

  const baseUrl = requireBaseUrl(imageConfig.base_url, `${meta.label} Base URL 缺失，请重新选择服务商后保存配置`);
  const requestMode = normalizeImageRequestMode(imageConfig);
  const requestId = createRequestId();
  const logTitle = `AI生图测试-${meta.label}`;
  const requestBody = createOpenAICompatibleImageRequestBody(
    provider,
    imageConfig,
    '大字报，内容是“易标AI老好了”',
  );

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-test-pending',
      provider: meta.logProvider,
      request_mode: requestMode,
      url: `${baseUrl}/images/generations`,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    try {
      responseData = await runWithAiRetry(() => runWithOperationTimeout(
        (signal) => requestOpenAICompatibleImageData(
          baseUrl,
          imageConfig.api_key,
          requestBody,
          `${meta.label}生图测试失败`,
          { signal },
        ),
        AI_REQUEST_TIMEOUT_MS,
      ));
    } catch (error) {
      const message = error.message || '';
      if (message.includes('does not exist') || message.includes('do not have access')) {
        throw copyRawAiErrorResponse(
          error,
          new Error(`${meta.label}生图模型不可用，请确认${meta.modelLabel}已开通并可访问。原始错误：${message}`),
        );
      }

      throw error;
    }

    trackAiRequest(app, config, { ai_request_type: 'image', usage: extractOpenAIUsage(responseData) });
    analyticsTracked = true;
    const firstImage = responseData.data?.[0] || {};
    const imageUrl = firstImage.url || '';
    const imageData = firstImage.b64_json || '';

    if (!imageUrl && !imageData) {
      throw createAiResponseDataError(getOpenAICompatibleImageFailureMessage(responseData, `${meta.label}生图测试未返回图片数据`), responseData);
    }

    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-test',
      provider: meta.logProvider,
      request_mode: requestMode,
      request: requestBody,
      response: safeImageResponse(responseData),
      result: {
        image_url: imageUrl,
        image_data: imageData ? '[base64 omitted]' : '',
        mime_type: 'image/png',
      },
      created_at: new Date().toISOString(),
    });

    return {
      success: true,
      message: imageUrl ? `测试成功：已生成图片 ${imageUrl}` : '测试成功：已返回生图结果',
      image_url: imageUrl,
      image_data: imageData,
      mime_type: 'image/png',
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
      provider: meta.logProvider,
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

async function generateOpenAICompatibleImage(app, config, request, provider) {
  const imageConfig = config.image_model || {};
  const meta = OPENAI_IMAGE_PROVIDER_META[provider] || OPENAI_IMAGE_PROVIDER_META.volcengine;
  const requestId = createRequestId();
  const logTitle = resolveAiLogTitle(request, request.title ? `AI生图-${request.title}` : 'AI生图');
  const requestMode = normalizeImageRequestMode(imageConfig);
  const requestBody = createOpenAICompatibleImageRequestBody(
    provider,
    imageConfig,
    normalizeImagePrompt(request),
    request.size,
  );
  const baseUrl = requireBaseUrl(imageConfig.base_url, `${meta.label} Base URL 缺失，请重新选择服务商后保存配置`);
  let responseData = null;
  let analyticsTracked = false;

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image-pending',
      provider: meta.logProvider,
      request_mode: requestMode,
      url: `${baseUrl}/images/generations`,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    responseData = await runWithAiRetry(() => runWithOperationTimeout(
      (signal) => requestOpenAICompatibleImageData(
        baseUrl,
        imageConfig.api_key,
        requestBody,
        `${meta.label}生图失败`,
        { signal, source: `${meta.logProvider}-image-model` },
      ),
      AI_REQUEST_TIMEOUT_MS,
      request.signal,
    ));
    trackAiRequest(app, config, { ai_request_type: 'image', usage: extractOpenAIUsage(responseData) });
    analyticsTracked = true;

    const item = responseData.data?.[0] || {};
    const image = await runWithOperationTimeout(
      (signal) => createImageFromOpenAICompatibleItem(item, { signal }),
      AI_REQUEST_TIMEOUT_MS,
      request.signal,
    );

    if (!image) {
      throw createAiResponseDataError(getOpenAICompatibleImageFailureMessage(responseData, `${meta.label}生图未返回图片数据`), responseData);
    }

    const saved = saveGeneratedImage(app, image);
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'image',
      provider: meta.logProvider,
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
      provider: meta.logProvider,
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

const OPENAI_IMAGE_PROVIDER_META = {
  jinlong: {
    label: '金龙中转站',
    defaultBaseUrl: 'https://img-api.jlaudeapi.com/v1',
    logProvider: 'jinlong',
    modelLabel: '生图模型名称',
  },
  volcengine: {
    label: '火山方舟',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    logProvider: 'volcengine',
    modelLabel: '模型名称或推理接入点 ID',
  },
  agnes: {
    label: 'Agnes AI',
    defaultBaseUrl: 'https://apihub.agnes-ai.com/v1',
    logProvider: 'agnes',
    modelLabel: '生图模型名称',
  },
  custom: {
    label: '自定义生图服务',
    defaultBaseUrl: '',
    logProvider: 'custom',
    modelLabel: '生图模型名称',
  },
};

module.exports = {
  testOpenAICompatibleImageModel,
  generateOpenAICompatibleImage,
  createImageFromOpenAICompatibleItem,
  getOpenAICompatibleImageFailureMessage,
};
