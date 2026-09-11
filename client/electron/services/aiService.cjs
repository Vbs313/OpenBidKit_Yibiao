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
  IMAGE_MODEL_TEST_TIMEOUT_MESSAGE,
} = require('./ai/requestUtils.cjs');
const {
  runComfyUIImageGeneration,
  generateComfyUIImage,
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
const { testOpenAICompatibleImageModel, generateOpenAICompatibleImage } = require('./ai/openaiImages.cjs');
const {
  collectJsonResponseWithConfig,
  parseOrRepairJsonResponseWithConfig,
  repairJsonResponse,
  chatWithConfig,
  runAgentChatCompletionWithConfig,
  createChatRequestBody,
  createAgentChatRequestBody,
  JINLONG_DEPRECATED_MODEL_MAP,
} = require('./ai/textChat.cjs');


const MODEL_INFO_ENDPOINT = 'https://analytics.agnet.top/model-info';


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
