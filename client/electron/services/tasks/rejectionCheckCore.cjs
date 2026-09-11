// 废标项检查的底层纯助手：文本/数组取数、id 生成、投标文件展示与去重。
//
// 这些函数被提示词构造、模型输出归一化、滚动状态三处共用，原本埋在 rejectionCheckTask.cjs（1728 行）里。
// 拆分方向：core ← findings ← rolling ← prompts ← 编排（主文件）。

const crypto = require('node:crypto');

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function stripTripleQuoteWrapper(content) {
  const trimmed = String(content || '').trim();
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''")) {
    return trimmed.slice(3, -3).trim();
  }
  return String(content || '');
}

function normalizeText(value) {
  return String(value || '').trim();
}

function truncatePromptText(value, maxLength) {
  const text = normalizeText(value);
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function getBidDocumentIdFromItem(item, bidDocumentIds) {
  const candidates = [item.bidDocumentId, item.bid_document_id, item.documentId, item.document_id, item.fileId, item.file_id, item.sourceFile, item.source_file]
    .map((value) => normalizeText(value))
    .filter(Boolean);
  for (const candidate of candidates) {
    if (bidDocumentIds.has(candidate)) return candidate;
  }
  return bidDocumentIds.size === 1 ? Array.from(bidDocumentIds)[0] : '';
}

function formatBidDocumentsForPrompt(input) {
  const documents = Array.isArray(input.bidDocuments) ? input.bidDocuments : [];
  return documents.map((document, index) => `【投标文件${index + 1}｜bidDocumentId：${document.id}｜文件名：${document.fileName || document.id}】\n${document.content}`).join('\n\n--- 投标文件分隔线 ---\n\n');
}

function getArrayPayload(parsed, keys) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return [];
}

function normalizeFindingType(value) {
  const raw = String(value || '').trim();
  if (raw === 'invalidBid' || raw.includes('无效')) return 'invalidBid';
  return 'rejectionItem';
}

function normalizeSeverity(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'high' || raw.includes('高')) return 'high';
  if (raw === 'low' || raw.includes('低')) return 'low';
  return 'medium';
}

function getBidDocumentDisplayName(document, documentIndex) {
  return `投标文件${documentIndex + 1}${document.fileName ? `（${document.fileName}）` : ''}`;
}

function formatBidDocumentIdList(bidDocuments) {
  return (Array.isArray(bidDocuments) ? bidDocuments : [])
    .map((document, index) => `- ${getBidDocumentDisplayName(document, index)}：${document.id}`)
    .join('\n');
}

function getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId = '') {
  const bidDocumentIds = new Set((Array.isArray(bidDocuments) ? bidDocuments : []).map((document) => document.id).filter(Boolean));
  return getBidDocumentIdFromItem(item, bidDocumentIds) || (bidDocumentIds.has(fallbackBidDocumentId) ? fallbackBidDocumentId : '');
}

function limitDedupeItems(items, maxCount, keyBuilder) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const key = normalizeText(keyBuilder(item)) || JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= maxCount) break;
  }
  return result;
}

function dedupeItems(items, keyBuilder) {
  return limitDedupeItems(items, Number.MAX_SAFE_INTEGER, keyBuilder);
}

module.exports = {
  now,
  createId,
  stripTripleQuoteWrapper,
  normalizeText,
  truncatePromptText,
  getBidDocumentIdFromItem,
  formatBidDocumentsForPrompt,
  getArrayPayload,
  normalizeFindingType,
  normalizeSeverity,
  getBidDocumentDisplayName,
  formatBidDocumentIdList,
  getPackageBidDocumentId,
  limitDedupeItems,
  dedupeItems,
};
