const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { nativeImage } = require('electron');
const { getGeneratedImagesDir } = require('../utils/paths.cjs');
const { createDeveloperLogger } = require('../utils/developerLog.cjs');
const { createAiRequestQueue } = require('../utils/aiRequestQueue.cjs');
const {
  copyAiHttpError,
  createAiHttpErrorFromResponse,
  emitAiHttpErrorToWindows,
} = require('../utils/aiHttpError.cjs');
const {
  copyAiRequestErrorMeta,
  markAiRequestError,
  runWithAiRetry,
} = require('../utils/aiRetry.cjs');
const {
  createAiRequestId: createRequestId,
  getAiErrorLogError,
  getAiErrorLogResponse,
  resolveAiLogTitle,
  writeAiLog,
} = require('../utils/aiLog.cjs');
const textTokenStatsStore = require('./stores/textTokenStatsStore.cjs');
const { normalizeTokenUsage } = textTokenStatsStore;
const perfTrace = require('../utils/perfTrace.cjs');
const {
  extractOpenAIUsage,
  extractGoogleUsage,
  extractJsonContent,
  extractFencedJsonBlocks,
  extractBalancedJsonCandidates,
  extractGoogleCandidateParts,
  extractComfyUIHistoryWorkflow,
  extractComfyUIImages,
} = require('./ai/providerParsers.cjs');
const { trackAiRequest } = require('./ai/requestTracking.cjs');
const { repairInvalidJsonStringEscapes } = require('./ai/jsonRepair.cjs');
const {
  parseJsonContent,
  formatJsonIssues,
  buildJsonRepairMessages,
  normalizeJsonPayload,
  emitProgress,
} = require('./ai/jsonResponse.cjs');
const {
  readSseJsonStream,
  readOpenAIChatStream,
} = require('./ai/streamReading.cjs');
const { normalizeStreamPayloadError } = require('./ai/streamErrors.cjs');
const {
  normalizeImageRequestMode,
  createOpenAICompatibleImageRequestBody,
  appendOpenAICompatibleImagePayload,
  buildComfyUIImageWorkflow,
} = require('./ai/imagePayloads.cjs');
const {
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
} = require('./ai/requestUtils.cjs');
const {
  runComfyUIImageGeneration,
  generateComfyUIImage,
  IMAGE_MODEL_TEST_TIMEOUT_MESSAGE,
  parseComfyUIWorkflowJson,
  isComfyUITextToImageWorkflow,
  resolveComfyUIImageSize,
} = require('./ai/comfyuiImage.cjs');
const {
  createGoogleImageRequestBody,
  createGoogleImageUrl,
  requestGoogleImageData,
  getGoogleImageInlineData,
  getGoogleText,
} = require('./ai/googleImages.cjs');


// 金龙中转站废弃模型映射：使用这些模型时自动切换到替代模型
const JINLONG_DEPRECATED_MODEL_MAP = {
  'codex-auto-review': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-terra',
};
const MODEL_INFO_ENDPOINT = 'https://analytics.agnet.top/model-info';
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


async function repairJsonResponse(app, config, invalidContent, issues, responseFormat, progressCallback, progressLabel, repairMessagesBuilder, logTitle, signal) {
  await emitProgress(progressCallback, `${progressLabel}格式校验失败，正在基于当前结果进行修复。`);
  return chatWithConfig(app, config, {
    messages: repairMessagesBuilder
      ? repairMessagesBuilder({ invalidContent, issues, progressLabel })
      : buildJsonRepairMessages(invalidContent, issues, progressLabel),
    response_format: responseFormat,
    logTitle: logTitle ? `${logTitle}修复` : `${progressLabel}修复`,
    signal,
  });
}

async function parseOrRepairJsonResponseWithConfig(app, config, request, content) {
  const responseFormat = request.response_format || { type: 'json_object' };
  const progressLabel = request.progressLabel || 'JSON结果';
  const failureMessage = request.failureMessage || '模型返回的 JSON 数据格式无效';
  const logTitle = resolveAiLogTitle(request, progressLabel);

  try {
    return normalizeJsonPayload(request, parseJsonContent(content));
  } catch (error) {
    const issues = formatJsonIssues(error);
    try {
      const repairedContent = await repairJsonResponse(
        app,
        config,
        content,
        issues,
        responseFormat,
        request.progressCallback,
        progressLabel,
        request.repairMessagesBuilder,
        logTitle,
        request.signal,
      );
      return normalizeJsonPayload(request, parseJsonContent(repairedContent));
    } catch {
      throw new Error(failureMessage);
    }
  }
}

async function collectJsonResponseWithConfig(app, config, request) {
  const preparedMessages = await prepareMultimodalMessages(config, request.messages);
  const maxRetries = request.max_retries ?? 2;
  const totalAttempts = maxRetries + 1;
  const responseFormat = request.response_format || { type: 'json_object' };
  const progressLabel = request.progressLabel || 'JSON结果';
  const failureMessage = request.failureMessage || '模型返回的 JSON 数据格式无效';
  const logTitle = resolveAiLogTitle(request, progressLabel);
  let lastError = null;

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const content = await chatWithConfig(app, config, {
      messages: preparedMessages,
      response_format: responseFormat,
      timeout_ms: request.timeout_ms,
      timeout_message: request.timeout_message,
      logTitle,
      signal: request.signal,
    });

    try {
      const parsed = parseJsonContent(content);
      return normalizeJsonPayload(request, parsed);
    } catch (error) {
      lastError = error;
      const issues = formatJsonIssues(error);

      try {
        const repairedContent = await repairJsonResponse(
          app,
          config,
          content,
          issues,
          responseFormat,
          request.progressCallback,
          progressLabel,
          request.repairMessagesBuilder,
          logTitle,
          request.signal,
        );
        const repairedParsed = parseJsonContent(repairedContent);
        return normalizeJsonPayload(request, repairedParsed);
      } catch (repairError) {
        lastError = repairError;

        if (attempt === maxRetries) {
          await emitProgress(request.progressCallback, `${progressLabel}连续 ${totalAttempts} 次校验失败。`);
          throw new Error(failureMessage);
        }

        await emitProgress(request.progressCallback, `${progressLabel}第 ${attempt + 1}/${totalAttempts} 次校验失败，正在重试。`);
      }
    }
  }

  throw new Error(lastError?.message || failureMessage);
}

function createChatRequestBody(config, request, options = {}) {
  const modelName = JINLONG_DEPRECATED_MODEL_MAP[config.model_name] || config.model_name;
  const body = {
    model: modelName,
    messages: request.messages,
  };

  if (config.temperature_enabled) {
    body.temperature = config.temperature;
  }

  if (config.reasoning_effort) {
    body.reasoning_effort = config.reasoning_effort;
  }

  if (options.stream) {
    body.stream = true;
  }

  if (request.response_format && !options.omitResponseFormat) {
    body.response_format = request.response_format;
  }

  return body;
}

// 保留 Pi 工具调用协议字段，并统一应用当前文本模型配置。
function createAgentChatRequestBody(config, sourceBody) {
  const source = sourceBody && typeof sourceBody === 'object' ? sourceBody : {};
  const messages = Array.isArray(source.messages) ? source.messages : [];
  if (!messages.length) {
    throw new Error('Agent 代理请求缺少 messages');
  }

  const body = {
    ...source,
    model: config.model_name,
    messages,
    stream: normalizeTextRequestMode(config) === 'stream',
  };
  if (!body.stream) delete body.stream_options;
  if (config.temperature_enabled) {
    body.temperature = config.temperature;
  } else {
    delete body.temperature;
  }
  if (config.reasoning_effort) {
    body.reasoning_effort = config.reasoning_effort;
  } else {
    delete body.reasoning_effort;
  }

  // 部分 OpenAI 兼容上游会拒绝 Agent SDK 注入的输出长度参数。
  delete body.max_tokens;
  delete body.max_output_tokens;
  delete body.max_completion_tokens;
  return body;
}

async function fetchChatCompletion(app, config, body, options = {}) {
  const controller = options.signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS) : null;
  const baseUrl = requireBaseUrl(config.base_url, '请先在设置中配置文本模型 Base URL');
  try {
    return await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: createHeaders(config.api_key),
      body: JSON.stringify(body),
      signal: options.signal || controller.signal,
    });
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function ensureTextAiResponseOk(response, fallbackMessage) {
  if (response.ok) {
    return;
  }

  throw await createAiHttpErrorFromResponse(response, fallbackMessage, {
    source: 'text-model',
    responseFormatUnsupportedChecker: isResponseFormatUnsupported,
  });
}


async function requestTextAiNormal(app, config, requestBody, options = {}) {
  const response = await fetchChatCompletion(app, config, requestBody, { signal: options.signal });
  await ensureTextAiResponseOk(response, 'AI 请求失败');
  let responseData = null;
  try {
    responseData = await response.json();
  } catch (error) {
    throw markAiRequestError(error, { retryable: true });
  }
  return {
    content: responseData.choices?.[0]?.message?.content || '',
    usage: extractOpenAIUsage(responseData),
    responseData,
  };
}

async function requestTextAiStream(app, config, requestBody, options = {}) {
  const response = await fetchChatCompletion(app, config, requestBody, { signal: options.signal });
  await ensureTextAiResponseOk(response, 'AI 请求失败');
  return readOpenAIChatStream(response);
}

async function requestTextAi(app, config, requestBody, options = {}) {
  return perfTrace.time('ai', options.requestMode === 'stream' ? 'text.request_stream' : 'text.request_normal', async () => {
    if (options.requestMode === 'stream') {
      return requestTextAiStream(app, config, requestBody, options);
    }
    return requestTextAiNormal(app, config, requestBody, options);
  });
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


async function chatWithConfig(app, config, request) {
  if (!config.api_key) {
    throw new Error('请先在设置中配置文本模型 API Key');
  }

  if (!config.model_name) {
    throw new Error('请先在设置中配置文本模型名称');
  }

  requireBaseUrl(config.base_url, '请先在设置中配置文本模型 Base URL');

  const preparedRequest = {
    ...request,
    messages: await prepareMultimodalMessages(config, request.messages),
  };
  const requestId = createRequestId();
  const logTitle = resolveAiLogTitle(request, '文本请求');
  const requestMode = normalizeTextRequestMode(config);
  let requestBody = createChatRequestBody(config, preparedRequest, { stream: requestMode === 'stream' });
  let responseData = null;
  let errorMessage = '';
  let analyticsTracked = false;
  const timeoutMs = normalizeRequestTimeoutMs(request);

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'chat-pending',
      request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    let result = null;
    result = await runWithAiRetry(() => runWithOperationTimeout(async (signal) => {
      try {
        return await requestTextAi(app, config, requestBody, { signal, requestMode });
      } catch (error) {
        if (!preparedRequest.response_format || !error.responseFormatUnsupported) {
          throw error;
        }

        requestBody = createChatRequestBody(config, preparedRequest, { omitResponseFormat: true, stream: requestMode === 'stream' });
        return requestTextAi(app, config, requestBody, { signal, requestMode });
      }
    }, timeoutMs, request.signal));

    responseData = result.responseData;
    recordTextTokenStats(config, result.usage);
    trackAiRequest(app, config, { ai_request_type: 'text', usage: result.usage });
    analyticsTracked = true;
    const content = result.content || '';
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'chat',
      request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      response: responseData,
      content,
      created_at: new Date().toISOString(),
    });
    return content;
  } catch (error) {
    errorMessage = error.name === 'AbortError'
      ? request.timeout_message || `AI 请求超时（${timeoutMs / 1000} 秒）`
      : error.message;
    if (!analyticsTracked) {
      recordTextTokenStats(config, null);
      trackAiRequest(app, config, { ai_request_type: 'text' });
      analyticsTracked = true;
    }
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'chat-error',
      request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      response: getAiErrorLogResponse(error, responseData),
      error: getAiErrorLogError(error, errorMessage),
      created_at: new Date().toISOString(),
    });
    const wrappedError = new Error(errorMessage || 'AI 请求失败');
    if (error.status || error.statusCode) {
      wrappedError.status = error.status || error.statusCode;
      wrappedError.statusCode = error.status || error.statusCode;
    }
    copyRawAiErrorResponse(error, wrappedError);
    copyAiRequestErrorMeta(error, wrappedError);
    markAiRequestError(wrappedError, { retryable: false });
    emitAiHttpErrorToWindows(wrappedError);
    throw wrappedError;
  }
}

// 通过统一文本出口执行一次 Agent Chat Completions 请求，响应消费完成后才释放队列槽。
async function runAgentChatCompletionWithConfig(app, config, request) {
  if (!config.api_key) {
    throw new Error('请先在设置中配置文本模型 API Key');
  }
  if (!config.model_name) {
    throw new Error('请先在设置中配置文本模型名称');
  }
  requireBaseUrl(config.base_url, '请先在设置中配置文本模型 Base URL');
  if (typeof request.consumeResponse !== 'function') {
    throw new Error('Agent 代理请求缺少响应消费函数');
  }

  const requestId = createRequestId();
  const requestBody = createAgentChatRequestBody(config, request.body);
  ensureMultimodalEnabled(config, requestBody.messages);
  const requestMode = requestBody.stream ? 'stream' : 'normal';
  const logTitle = resolveAiLogTitle(request, 'Pi Agent');
  let responseData = null;
  let analyticsTracked = false;

  try {
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'chat-pending',
      request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    await Promise.resolve(request.onRequestStart?.({ config, requestBody, requestId }));
    const response = await fetchChatCompletion(app, config, requestBody, { signal: request.signal });
    await ensureTextAiResponseOk(response, 'AI 请求失败');
    const result = await request.consumeResponse(response, {
      config,
      requestBody,
      requestId,
    });
    responseData = result?.responseData ?? null;
    recordTextTokenStats(config, result?.usage);
    trackAiRequest(app, config, { ai_request_type: 'text', usage: result?.usage });
    analyticsTracked = true;
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'chat',
      request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      response: responseData,
      content: result?.content || '',
      created_at: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    if (!analyticsTracked) {
      recordTextTokenStats(config, null);
      trackAiRequest(app, config, { ai_request_type: 'text' });
    }
    writeAiLog(app, config, {
      request_id: requestId,
      log_title: logTitle,
      type: 'chat-error',
      request_mode: requestMode,
      url: `${trimBaseUrl(config.base_url)}/chat/completions`,
      request: requestBody,
      response: getAiErrorLogResponse(error, responseData),
      error: getAiErrorLogError(error, error?.message || 'AI 请求失败'),
      created_at: new Date().toISOString(),
    });
    throw error;
  }
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


async function testComfyUIImageModel(app, config) {
  const testRequest = {
    title: '测试',
    prompt: '大字报，内容是"易标AI老好了"',
  };
  const { image, workflow_source: workflowSource } = await runComfyUIImageGeneration(app, config, testRequest, {
    returnRawImage: true,
    isTest: true,
    logExtra: { pendingType: 'image-test-pending', successType: 'image-test', errorType: 'image-test-error' },
  });
  const sourceLabel = workflowSource === 'custom' ? '设置中粘贴的工作流'
    : workflowSource === 'history' ? '服务器最近成功执行的工作流'
      : '按服务器已装模型自动组装的工作流';
  return {
    success: true,
    message: `测试成功：ComfyUI 已返回生成的图片（复用${sourceLabel}）`,
    image_url: '',
    image_data: image.buffer.toString('base64'),
    mime_type: image.mime_type || 'image/png',
  };
}
async function generateImageWithConfig(app, config, request) {
  const availability = getImageModelAvailability(config);
  if (!availability.available) {
    throw new Error(availability.message);
  }

  if (config.image_model?.provider === 'jinlong' || config.image_model?.provider === 'volcengine' || config.image_model?.provider === 'agnes' || config.image_model?.provider === 'custom') {
    return generateOpenAICompatibleImage(app, config, request, config.image_model.provider);
  }

  if (config.image_model?.provider === 'google-ai-studio') {
    return generateGoogleImage(app, config, request);
  }

  if (config.image_model?.provider === 'comfyui') {
    return generateComfyUIImage(app, config, request);
  }

  throw new Error('当前生图服务商暂不支持正文配图');
}

function createAiService({ app, configStore }) {
  const textRequestQueue = createAiRequestQueue({
    defaultLimit: 10,
    getLimit() {
      return configStore.load()?.concurrency_limit;
    },
  });
  const imageRequestQueue = createAiRequestQueue({
    defaultLimit: 2,
    getLimit() {
      return configStore.load()?.image_model?.concurrency_limit;
    },
  });

  function getQueueScopeId(request) {
    return String(request?.queueScopeId || request?.queue_scope_id || '').trim();
  }

  function withQueueScope(request, queueScopeId, signal) {
    const normalizedScopeId = String(queueScopeId || '').trim();
    if (!normalizedScopeId || !request || typeof request !== 'object') {
      return request;
    }

    return {
      ...request,
      queueScopeId: getQueueScopeId(request) || normalizedScopeId,
      ...(signal && !request.signal ? { signal } : {}),
    };
  }

  // 排队等待是“点了没反应”的第一现场，这里只测不改：记录首次出队等待与整体耗时。
  function instrumentedRunner(label, runner) {
    const beganAt = performance.now();
    let dequeued = false;
    return (...args) => {
      if (!dequeued) {
        dequeued = true;
        perfTrace.record('ai', `${label}.queue_wait`, performance.now() - beganAt);
      }
      return runner(...args);
    };
  }

  function enqueueTextRequest(request, runner, options = {}) {
    const beganAt = performance.now();
    return textRequestQueue.enqueue(instrumentedRunner('text', runner), {
      scopeId: getQueueScopeId(request),
      signal: options.signal,
      maxAttempts: options.maxAttempts,
    }).then((value) => {
      perfTrace.record('ai', 'text.total', performance.now() - beganAt);
      return value;
    }, (error) => {
      perfTrace.record('ai', 'text.total', performance.now() - beganAt, { error: true });
      throw error;
    });
  }

  function enqueueImageRequest(request, runner) {
    const beganAt = performance.now();
    return imageRequestQueue.enqueue(instrumentedRunner('image', runner), { scopeId: getQueueScopeId(request), signal: request?.signal })
      .then((value) => {
        perfTrace.record('ai', 'image.total', performance.now() - beganAt);
        return value;
      }, (error) => {
        perfTrace.record('ai', 'image.total', performance.now() - beganAt, { error: true });
        throw error;
      });
  }

  const service = {
    getConfig() {
      return configStore.load();
    },

    async chat(request) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return chatWithConfig(app, config, request);
      }, { signal: request?.signal });
    },

    async runAgentChatCompletion(request) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return runAgentChatCompletionWithConfig(app, config, request);
      }, {
        signal: request?.signal,
        // Pi Session 保留回合级原生重试，本队列只负责统一调度和并发控制。
        maxAttempts: 1,
      });
    },

    async requestJson(request) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return collectJsonResponseWithConfig(app, config, request);
      }, { signal: request?.signal });
    },

    async collectJsonResponse(request) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return collectJsonResponseWithConfig(app, config, request);
      }, { signal: request?.signal });
    },

    async parseJsonResponseContent(request, content) {
      return enqueueTextRequest(request, () => {
        const config = configStore.load();
        return parseOrRepairJsonResponseWithConfig(app, config, request, content);
      }, { signal: request?.signal });
    },

    pauseQueueScope(scopeId) {
      return textRequestQueue.pauseScope(scopeId) + imageRequestQueue.pauseScope(scopeId);
    },

    resumeQueueScope(scopeId) {
      textRequestQueue.resumeScope(scopeId);
      imageRequestQueue.resumeScope(scopeId);
    },

    getTextQueueStatus() {
      return textRequestQueue.getStatus();
    },

    getImageQueueStatus() {
      return imageRequestQueue.getStatus();
    },

    getTextTokenStats() {
      return getTextTokenStatsSnapshot();
    },

    resetTextTokenStats() {
      return resetTextTokenStats();
    },

    onTextTokenStatsChanged(listener) {
      return onTextTokenStatsChanged(listener);
    },

    withQueueScope(scopeId, signal) {
      return {
        ...service,
        chat(request) {
          return service.chat(withQueueScope(request, scopeId, signal));
        },
        requestJson(request) {
          return service.requestJson(withQueueScope(request, scopeId, signal));
        },
        collectJsonResponse(request) {
          return service.collectJsonResponse(withQueueScope(request, scopeId, signal));
        },
        parseJsonResponseContent(request, content) {
          return service.parseJsonResponseContent(withQueueScope(request, scopeId, signal), content);
        },
        runAgentChatCompletion(request) {
          return service.runAgentChatCompletion(withQueueScope(request, scopeId, signal));
        },
        generateImage(request) {
          return service.generateImage(withQueueScope(request, scopeId, signal));
        },
      };
    },

    async testImageModel(config) {
      const currentConfig = configStore.load();
      const trackedConfig = {
        ...config,
        analytics_client_id: config.analytics_client_id || currentConfig.analytics_client_id,
        analytics_created_at: config.analytics_created_at || currentConfig.analytics_created_at,
      };

      if (trackedConfig.image_model?.provider === 'jinlong' || trackedConfig.image_model?.provider === 'volcengine' || trackedConfig.image_model?.provider === 'agnes' || trackedConfig.image_model?.provider === 'custom') {
        return testOpenAICompatibleImageModel(app, trackedConfig, trackedConfig.image_model.provider);
      }

      if (trackedConfig.image_model?.provider === 'google-ai-studio') {
        return testGoogleImageModel(app, trackedConfig);
      }

      if (trackedConfig.image_model?.provider === 'comfyui') {
        return testComfyUIImageModel(app, trackedConfig);
      }

      throw new Error('当前服务商暂不支持测试');
    },

    getImageModelAvailability() {
      return getImageModelAvailability(configStore.load());
    },

    isDeveloperMode() {
      return Boolean(configStore.load()?.developer_mode);
    },

    createTechnicalPlanDeveloperLogger(request) {
      const config = configStore.load();
      return createModuleDeveloperLogger(app, config, 'technical-plan', request);
    },

    createDeveloperLogger(moduleName, request) {
      const config = configStore.load();
      return createModuleDeveloperLogger(app, config, moduleName, request);
    },

    async generateImage(request) {
      return enqueueImageRequest(request, () => {
        const config = configStore.load();
        return generateImageWithConfig(app, config, request);
      });
    },

    async listModels(configOverride) {
      const config = configOverride || configStore.load();

      if (!config.api_key) {
        return { success: false, message: '请先填写文本模型 API Key', models: [] };
      }

      if (!trimBaseUrl(config.base_url)) {
        return { success: false, message: '请先填写文本模型 Base URL', models: [] };
      }

      let data = null;
      try {
        data = await runWithAiRetry(async () => {
          let response = null;
          try {
            response = await fetch(`${trimBaseUrl(config.base_url)}/models`, {
              method: 'GET',
              headers: createHeaders(config.api_key),
            });
          } catch (error) {
            throw markAiRequestError(error, { retryable: true });
          }

          await ensureOk(response, '获取模型列表失败');
          try {
            return await response.json();
          } catch (error) {
            throw markAiRequestError(error, { retryable: true });
          }
        });
      } catch (error) {
        emitAiHttpErrorToWindows(error);
        throw error;
      }

      return {
        success: true,
        message: '模型列表已更新',
        models: Array.isArray(data.data) 
          ? data.data.map((item) => item.id).filter(Boolean).filter(id => !Object.keys(JINLONG_DEPRECATED_MODEL_MAP).includes(id))
          : [],
      };
    },

    async getModelInfo(modelName) {
      const normalizedModelName = String(modelName || '').trim();
      if (!normalizedModelName) {
        return { success: false, message: '请先填写文本模型名称', modelName: '', model: null, syncedAt: '' };
      }

      const response = await fetch(`${MODEL_INFO_ENDPOINT}?modelName=${encodeURIComponent(normalizedModelName)}`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.code !== 0) {
        throw new Error(data?.message || `获取模型信息失败：HTTP ${response.status}`);
      }
      if (!data.model) {
        return {
          success: false,
          message: `模型信息缓存中未找到 ${normalizedModelName}，请手动录入`,
          modelName: normalizedModelName,
          model: null,
          syncedAt: data.syncedAt || '',
        };
      }
      return {
        success: true,
        message: '模型信息已获取',
        modelName: normalizedModelName,
        model: {
          reasoningEfforts: Array.isArray(data.model.reasoningEfforts)
            ? data.model.reasoningEfforts.map((value) => String(value || '').trim()).filter(Boolean)
            : [],
          context: Math.max(0, Math.floor(Number(data.model.context) || 0)),
          output: Math.max(0, Math.floor(Number(data.model.output) || 0)),
          inputModalities: Array.isArray(data.model.inputModalities)
            ? data.model.inputModalities.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
            : [],
          outputModalities: Array.isArray(data.model.outputModalities)
            ? data.model.outputModalities.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
            : [],
          imageInputStatus: ['supported', 'unsupported', 'mixed', 'unknown'].includes(data.model.imageInputStatus)
            ? data.model.imageInputStatus
            : 'unknown',
          temperatureStatus: ['supported', 'unsupported', 'mixed', 'unknown'].includes(data.model.temperatureStatus)
            ? data.model.temperatureStatus
            : 'unknown',
          concurrencyLimit: Number.isFinite(Number(data.model.concurrencyLimit)) && Number(data.model.concurrencyLimit) > 0
            ? Math.floor(Number(data.model.concurrencyLimit))
            : 10,
          requestMode: data.model.requestMode === 'normal' ? 'normal' : 'stream',
          sourceCount: Math.max(0, Math.floor(Number(data.model.sourceCount) || 0)),
        },
        syncedAt: data.syncedAt || '',
      };
    },
  };

  return service;
}

module.exports = {
  createAiService,
};
