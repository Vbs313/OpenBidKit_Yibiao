const { RESPONSE_SCHEMA } = require('./resultSchema.cjs');

const PROTOCOL_VERSION = '1.0';

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

function createRequest({ jobId, action, input }) {
  const normalizedJobId = String(jobId || '').trim();
  if (!normalizedJobId) throw new Error('jobId 不能为空');
  const normalizedAction = String(action || '').trim();
  if (!normalizedAction) throw new Error('action 不能为空');
  return {
    version: PROTOCOL_VERSION,
    job_id: normalizedJobId,
    action: normalizedAction,
    ...(input !== undefined ? { input } : {}),
  };
}

function isProgressMessage(message) {
  return Boolean(message && typeof message === 'object' && message.type === 'progress' && typeof message.job_id === 'string');
}

function createProtocolError(code, message, detail) {
  return {
    version: PROTOCOL_VERSION,
    job_id: '',
    status: 'error',
    results: [],
    error: { code, message, ...(detail ? { detail } : {}) },
  };
}

module.exports = {
  PROTOCOL_VERSION,
  createProtocolError,
  createRequest,
  isProgressMessage,
  validateResponse,
};
