const { RESPONSE_SCHEMA } = require('./resultSchema.cjs');

const PROTOCOL_VERSION = '1.0';

// model_config 是 LLM 检查的模型路由信息，只允许描述“走哪个端点、用哪个模型”。
// API Key 由 B 侧持有，禁止出现在 stdin、stdout、日志和 SQLite 中。
const MODEL_CONFIG_FIELDS = ['base_url', 'model', 'reasoning_effort'];
const CREDENTIAL_FIELD_PATTERN = /^(api[-_ ]?key|apikey|access[-_ ]?key|secret[-_ ]?key|authorization|auth|token|bearer|x-api-key|openai[-_ ]?api[-_ ]?key)$/i;

let validateWithAjv = null;
try {
  const Ajv = require('ajv');
  const ajv = new Ajv({ allErrors: true, strict: false });
  validateWithAjv = ajv.compile(RESPONSE_SCHEMA);
} catch {
  validateWithAjv = null;
}


function formatValidationErrors(errors = []) {
  return errors.map((error) => `${error.instancePath || '/'} ${error.message || '不符合协议'}`).join('; ');
}

function validateResponseFallback(message) {
  const errors = [];
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { valid: false, errors: ['响应必须是 JSON 对象'] };
  }
  if (message.version !== PROTOCOL_VERSION) errors.push(`version 必须为 ${PROTOCOL_VERSION}`);
  if (typeof message.job_id !== 'string' || !message.job_id.trim()) errors.push('缺少 job_id');
  if (!['success', 'error'].includes(message.status)) errors.push('status 必须为 success 或 error');
  if (!Array.isArray(message.results)) errors.push('results 必须是数组');
  return { valid: errors.length === 0, errors };
}

function validateResponse(message) {
  if (validateWithAjv) {
    const valid = validateWithAjv(message);
    return { valid, errors: valid ? [] : formatValidationErrors(validateWithAjv.errors) };
  }
  return validateResponseFallback(message);
}

function findCredentialField(value, path = 'root', seen = new Set()) {
  if (!value || typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_FIELD_PATTERN.test(String(key))) {
      return `${path}.${key}`;
    }
    const nested = findCredentialField(item, `${path}.${key}`, seen);
    if (nested) return nested;
  }
  return '';
}

// 请求写进 stdin 之前先做结构化的凭据扫描，避免密钥被日志或 SQLite 间接带走。
function assertNoCredentialFields(payload, label = '请求') {
  const field = findCredentialField(payload);
  if (field) {
    const error = new Error(`${label}包含凭据字段 ${field}，合规检查协议只允许 model_config 描述模型路由`);
    error.code = 'COMPLIANCE_CREDENTIAL_FIELD_FORBIDDEN';
    throw error;
  }
}

function isLoopbackBaseUrl(baseUrl) {
  try {
    const parsed = new URL(String(baseUrl));
    if (parsed.username || parsed.password) return false;
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// 只允许指向 B 本地代理的 base_url，防止 Sidecar 绕过 B 的队列和统计直连第三方。
function normalizeModelConfig(modelConfig) {
  if (modelConfig === undefined || modelConfig === null) return undefined;
  if (typeof modelConfig !== 'object' || Array.isArray(modelConfig)) {
    const error = new Error('model_config 必须是对象');
    error.code = 'COMPLIANCE_MODEL_CONFIG_INVALID';
    throw error;
  }

  const unknown = Object.keys(modelConfig).filter((key) => !MODEL_CONFIG_FIELDS.includes(key));
  if (unknown.length) {
    const error = new Error(`model_config 含不支持的字段: ${unknown.join(', ')}；API Key 不得进入合规检查协议`);
    error.code = 'COMPLIANCE_MODEL_CONFIG_INVALID';
    throw error;
  }

  const next = {};
  if (modelConfig.model !== undefined) {
    const model = String(modelConfig.model || '').trim();
    if (!model) {
      const error = new Error('model_config.model 不能为空字符串');
      error.code = 'COMPLIANCE_MODEL_CONFIG_INVALID';
      throw error;
    }
    next.model = model;
  }
  if (modelConfig.reasoning_effort !== undefined) {
    next.reasoning_effort = String(modelConfig.reasoning_effort || '').trim();
  }
  if (modelConfig.base_url !== undefined) {
    const baseUrl = String(modelConfig.base_url || '').trim();
    if (!isLoopbackBaseUrl(baseUrl)) {
      const error = new Error('model_config.base_url 只允许指向本机回环地址的本地模型代理');
      error.code = 'COMPLIANCE_MODEL_CONFIG_INVALID';
      throw error;
    }
    next.base_url = baseUrl;
  }
  assertNoCredentialFields(next, 'model_config');
  return Object.keys(next).length ? next : undefined;
}

function createRequest({ jobId, action, input, modelConfig } = {}) {
  const normalizedJobId = String(jobId || '').trim();
  if (!normalizedJobId) throw new Error('jobId 不能为空');
  const normalizedAction = String(action || '').trim();
  if (!normalizedAction) throw new Error('action 不能为空');

  const request = {
    version: PROTOCOL_VERSION,
    job_id: normalizedJobId,
    action: normalizedAction,
    ...(input !== undefined ? { input } : {}),
  };
  const normalizedModelConfig = normalizeModelConfig(modelConfig);
  if (normalizedModelConfig) request.model_config = normalizedModelConfig;
  assertNoCredentialFields(request, '合规检查请求');
  return request;
}

// 递归剔除凭据字段，用于落库前的兜底清洗（project_metadata 是自由结构）。
function stripCredentialFields(value, seen = new Set()) {
  if (Array.isArray(value)) return value.map((item) => stripCredentialFields(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_FIELD_PATTERN.test(String(key))) continue;
    next[key] = stripCredentialFields(item, seen);
  }
  return next;
}

function isProgressMessage(message) {
  return Boolean(message && typeof message === 'object' && message.type === 'progress' && typeof message.job_id === 'string');
}

module.exports = {
  MODEL_CONFIG_FIELDS,
  PROTOCOL_VERSION,
  assertNoCredentialFields,
  createRequest,
  isProgressMessage,
  stripCredentialFields,
  validateResponse,
};
