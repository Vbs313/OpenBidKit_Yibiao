// 废标项检查的纯助手：状态/分页归一化、三引号剥离、文档与检查输入的签名。
//
// 原本躺在 rejectionCheckStore.cjs 顶部（约 90 行），和数据库/文件写入混在一起，且整个 store 没有测试。
// 这些函数不碰 db / fs / app，抽出来即可单测（见 rejectionCheckUtils.test.cjs）。

const crypto = require('node:crypto');

function appendImportFailureParts(messageParts, errors) {
  const failed = Array.isArray(errors)
    ? errors.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!failed.length) return;
  messageParts.push(`失败 ${failed.length} 份`);
  messageParts.push(failed.join('；'));
}

function stableHash(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function normalizeStatus(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeStep(value) {
  return value === 'items' || value === 'results' ? value : 'documents';
}

function normalizeDocumentRole(value) {
  return value === 'bid' ? 'bid' : 'tender';
}

function normalizeDocumentTab(value) {
  const tab = String(value || '').trim();
  return tab || 'tender';
}

function normalizeResultTab(value) {
  return value === 'custom' ? 'custom' : 'analysis';
}

function normalizeCheckResultTab(value) {
  return ['rejection', 'typo', 'logic'].includes(value) ? value : 'rejection';
}

function normalizeCheckOptions(options) {
  return {
    rejectionCheck: true,
    typoCheck: options?.typoCheck !== false,
    logicCheck: options?.logicCheck !== false,
  };
}

function stripTripleQuoteWrapper(content) {
  const trimmed = String(content || '').trim();
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''")) {
    return trimmed.slice(3, -3).trim();
  }
  return String(content || '');
}

function createDocumentSignature(document) {
  if (!document) return '';
  const content = String(document.content || '').trim();
  const signatureId = document.role === 'bid' && document.id === 'bid-1' ? 'bid' : document.id || document.role;
  return [
    signatureId,
    document.source,
    document.fileName,
    content.length,
    content.slice(0, 800),
    content.slice(-800),
  ].join('\n---yibiao-rejection-signature---\n');
}

function createRejectionCheckInputSignature(bidDocuments, invalidBidAndRejectionItems, customCheckItems) {
  const documents = Array.isArray(bidDocuments) ? bidDocuments : [bidDocuments].filter(Boolean);
  const bidSignature = documents.map(createDocumentSignature).filter(Boolean).join('\n---yibiao-rejection-bid-document---\n');
  const analysis = String(invalidBidAndRejectionItems || '').trim();
  if (!bidSignature || !analysis) return '';
  const custom = String(customCheckItems || '').trim();
  return [
    bidSignature,
    analysis.length,
    analysis.slice(0, 800),
    analysis.slice(-800),
    custom.length,
    custom.slice(0, 800),
    custom.slice(-800),
  ].join('\n---yibiao-rejection-check-input---\n');
}

function getTechnicalPlanDiscardedBids(technicalPlan) {
  const task = technicalPlan?.bidAnalysisTasks?.discardedBids;
  return task?.status === 'success' && task.content?.trim() ? stripTripleQuoteWrapper(task.content) : '';
}

module.exports = {
  appendImportFailureParts,
  stableHash,
  normalizeStatus,
  normalizeStep,
  normalizeDocumentRole,
  normalizeDocumentTab,
  normalizeResultTab,
  normalizeCheckResultTab,
  normalizeCheckOptions,
  stripTripleQuoteWrapper,
  createDocumentSignature,
  createRejectionCheckInputSignature,
  getTechnicalPlanDiscardedBids,
};
