// 查重用的文件签名小工具：稳定文件 id、载荷里的招标文件清单、签名串与哈希。
// 这些原本是 duplicateCheckService.cjs 的模块级工具；搬出来后 service 与元数据模块共用。

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

function now() {
  return new Date().toISOString();
}

function stableFileId(file) {
  return file?.id || crypto.createHash('sha1').update(String(file?.file_path || file?.file_name || '')).digest('hex');
}

function getTenderFilesFromPayload(payload = {}) {
  return Array.isArray(payload.tenderFiles) ? payload.tenderFiles : [payload.tenderFile].filter(Boolean);
}

function createSignature(payload = {}) {
  const files = [...getTenderFilesFromPayload(payload), ...(Array.isArray(payload.bidFiles) ? payload.bidFiles : [])]
    .filter(Boolean)
    .map((file) => `${file.file_path}|${file.size}|${file.modified_at}`);
  return crypto.createHash('sha1').update(files.join('\n')).digest('hex');
}

async function hashFileSha256(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

module.exports = {
  now,
  stableFileId,
  getTenderFilesFromPayload,
  createSignature,
  hashFileSha256,
  hashText,
};
