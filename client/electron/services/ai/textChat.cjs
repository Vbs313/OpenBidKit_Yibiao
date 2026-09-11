// 文本对话链路：请求体构造（普通 / Agent）、流式与普通请求、JSON 收取与一次修复重试。
//
// 这些原本是 aiService.cjs 的模块级函数；搬出来后依赖同目录的请求工具与流式/JSON 解析层，可单独测试。

const perfTrace = require('../../utils/perfTrace.cjs');
const {
  writeAiLog,
  resolveAiLogTitle,
  getAiErrorLogResponse,
  getAiErrorLogError,
  createAiRequestId: createRequestId,
} = require('../../utils/aiLog.cjs');
const { runWithAiRetry, markAiRequestError, copyAiRequestErrorMeta } = require('../../utils/aiRetry.cjs');
const { createAiHttpErrorFromResponse, emitAiHttpErrorToWindows } = require('../../utils/aiHttpError.cjs');
const { extractOpenAIUsage } = require('./providerParsers.cjs');
const { trackAiRequest } = require('./requestTracking.cjs');
const { readOpenAIChatStream, readSseJsonStream } = require('./streamReading.cjs');
const {
  buildJsonRepairMessages,
  parseJsonContent,
  normalizeJsonPayload,
  emitProgress,
  formatJsonIssues,
} = require('./jsonResponse.cjs');
const {
  AI_REQUEST_TIMEOUT_MS,
  requireBaseUrl,
  createAbortError,
  createHeaders,
  normalizeRequestTimeoutMs,
  normalizeTextRequestMode,
  runWithOperationTimeout,
  ensureOk,
  isResponseFormatUnsupported,
  copyRawAiErrorResponse,
  createAiResponseDataError,
  trimBaseUrl,
  recordTextTokenStats,
  ensureMultimodalEnabled,
  prepareMultimodalMessages,
} = require('./requestUtils.cjs');

// 金龙中转站废弃模型映射：使用这些模型时自动切换到替代模型
const JINLONG_DEPRECATED_MODEL_MAP = {
  'codex-auto-review': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-terra',
};

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

module.exports = {
  JINLONG_DEPRECATED_MODEL_MAP,
  collectJsonResponseWithConfig,
  parseOrRepairJsonResponseWithConfig,
  chatWithConfig,
  runAgentChatCompletionWithConfig,
  repairJsonResponse,
  createChatRequestBody,
  createAgentChatRequestBody,
};
