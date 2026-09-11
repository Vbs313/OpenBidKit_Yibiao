const crypto = require('node:crypto');
const path = require('node:path');

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

function stableHash(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function safeFileNamePart(value) {
  return String(value || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'file';
}

function filePathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function createTenderSourceId(fileName, markdown, index) {
  const hash = stableHash(`${fileName}\n${markdown}`).slice(0, 12);
  return `tender-${String(index + 1).padStart(2, '0')}-${hash}`;
}

module.exports = { now, hasOwn, safeJsonParse, jsonOrNull, stableHash, safeFileNamePart, filePathKey, createTenderSourceId };
