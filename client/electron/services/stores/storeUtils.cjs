// 各 *Store 共用的读写小工具：时间戳、自有属性判断、JSON 安全解析。
function now() {
  return new Date().toISOString();
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

module.exports = { now, hasOwn, safeJsonParse, jsonOrNull };
