// 废标项检查的「模型输出归一化」：把 LLM 返回的 JSON 变成可信的 findings。
//
// 三类结果（废标项 / 错别字 / 逻辑）各有自己的形状，共同点是：认别名字段、解析 bidDocumentId、
// 补默认文案、丢弃不完整项、去重。错别字还要在原文里**校验位置**（找不到就丢弃）。
//
// 依赖方向：core ← findings ← rolling ← prompts ← 编排（主文件）。

const {
  createId,
  getArrayPayload,
  getBidDocumentIdFromItem,
  normalizeFindingType,
  normalizeSeverity,
  normalizeText,
} = require('./rejectionCheckCore.cjs');

const typoExcerptRadius = 8;

function normalizeRejectionCheckFindings(parsed, bidDocuments) {
  const bidDocumentIds = new Set((Array.isArray(bidDocuments) ? bidDocuments : []).map((document) => document.id).filter(Boolean));
  return getArrayPayload(parsed, ['findings', 'items', 'risks'])
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const bidDocumentId = getBidDocumentIdFromItem(item, bidDocumentIds);
      const title = normalizeText(item.title).slice(0, 80);
      const bidEvidence = normalizeText(item.bidEvidence || item.evidence || item.bid_evidence);
      const riskReason = normalizeText(item.riskReason || item.reason || item.risk_reason);
      return {
        id: normalizeText(item.id) || createId('rejection_finding'),
        bidDocumentId,
        type: normalizeFindingType(item.type),
        severity: normalizeSeverity(item.severity),
        title,
        summary: normalizeText(item.summary) || title,
        requirement: normalizeText(item.requirement || item.source) || '未明确引用具体检查依据，请人工复核。',
        bidEvidence,
        riskReason,
        suggestion: normalizeText(item.suggestion) || '请结合招标文件要求和投标文件原文人工复核后处理。',
      };
    })
    .filter((item) => item.bidDocumentId && item.title && item.bidEvidence && item.riskReason);
}

function findVerifiedTypoPosition(bidContent, wrongText, originalExcerpt, options = {}) {
  if (!wrongText) return -1;
  const segmentStartOffset = Number.isFinite(Number(options.segmentStartOffset))
    ? Math.max(0, Math.floor(Number(options.segmentStartOffset)))
    : 0;
  const segmentEndOffset = Number.isFinite(Number(options.segmentEndOffset))
    ? Math.min(bidContent.length, Math.max(segmentStartOffset, Math.floor(Number(options.segmentEndOffset))))
    : bidContent.length;
  if (segmentStartOffset > 0 || segmentEndOffset < bidContent.length) {
    const segmentContent = bidContent.slice(segmentStartOffset, segmentEndOffset);
    if (originalExcerpt) {
      const excerptIndex = segmentContent.indexOf(originalExcerpt);
      const wrongIndexInExcerpt = originalExcerpt.indexOf(wrongText);
      if (excerptIndex >= 0 && wrongIndexInExcerpt >= 0) return segmentStartOffset + excerptIndex + wrongIndexInExcerpt;
    }
    const wrongIndexInSegment = segmentContent.indexOf(wrongText);
    if (wrongIndexInSegment >= 0) return segmentStartOffset + wrongIndexInSegment;
  }
  if (originalExcerpt) {
    const excerptIndex = bidContent.indexOf(originalExcerpt);
    const wrongIndexInExcerpt = originalExcerpt.indexOf(wrongText);
    if (excerptIndex >= 0 && wrongIndexInExcerpt >= 0) return excerptIndex + wrongIndexInExcerpt;
  }
  return bidContent.indexOf(wrongText);
}

function createVerifiedTypoExcerpt(bidContent, position, wrongText) {
  let start = Math.max(0, position - typoExcerptRadius);
  let end = Math.min(bidContent.length, position + wrongText.length + typoExcerptRadius);
  const startTagOpen = bidContent.lastIndexOf('<', start);
  const startTagClose = bidContent.lastIndexOf('>', start);
  if (startTagOpen > startTagClose) {
    const tagEnd = bidContent.indexOf('>', start);
    if (tagEnd >= 0 && tagEnd < position) start = tagEnd + 1;
  }
  const endTagOpen = bidContent.lastIndexOf('<', end);
  const endTagClose = bidContent.lastIndexOf('>', end);
  if (endTagOpen > endTagClose) {
    const tagEnd = bidContent.indexOf('>', end);
    if (tagEnd >= 0) end = Math.min(bidContent.length, tagEnd + 1);
  }
  return bidContent.slice(start, end).trim();
}

function createLineLocationHint(bidContent, position) {
  const before = bidContent.slice(0, Math.max(0, position));
  return `原文第 ${before.split(/\r\n|\r|\n/).length} 行附近`;
}

function normalizeTypoCheckFindings(parsed, bidDocuments, options = {}) {
  const documents = Array.isArray(bidDocuments) ? bidDocuments : [];
  const bidDocumentIds = new Set(documents.map((document) => document.id).filter(Boolean));
  const documentMap = new Map(documents.map((document) => [document.id, document]));
  const seen = new Set();
  const findings = [];
  for (const item of getArrayPayload(parsed, ['findings', 'items', 'typos'])) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const bidDocumentId = getBidDocumentIdFromItem(item, bidDocumentIds);
    const bidDocument = documentMap.get(bidDocumentId);
    if (!bidDocument?.content) continue;
    const wrongText = normalizeText(item.wrongText || item.wrong_text || item.wrong || item.typo).slice(0, 60);
    const correctText = normalizeText(item.correctText || item.correct_text || item.correct || item.suggestion).slice(0, 60);
    const originalExcerpt = normalizeText(item.originalExcerpt || item.original_excerpt || item.excerpt || item.context);
    const reason = normalizeText(item.reason || item.riskReason || item.detail) || '疑似错别字，请结合原文复核。';
    if (!wrongText || !correctText || wrongText === correctText) continue;
    const position = findVerifiedTypoPosition(bidDocument.content, wrongText, originalExcerpt, options);
    if (position < 0) continue;
    const key = `${bidDocumentId}\u0000${wrongText}\u0000${correctText}\u0000${position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      id: normalizeText(item.id) || createId('typo_finding'),
      bidDocumentId,
      wrongText,
      correctText,
      originalExcerpt: createVerifiedTypoExcerpt(bidDocument.content, position, wrongText),
      reason,
      locationHint: createLineLocationHint(bidDocument.content, position),
      position,
    });
  }
  return findings;
}

function normalizeLogicCheckFindings(parsed, bidDocuments) {
  const bidDocumentIds = new Set((Array.isArray(bidDocuments) ? bidDocuments : []).map((document) => document.id).filter(Boolean));
  const seen = new Set();
  const findings = [];
  for (const item of getArrayPayload(parsed, ['findings', 'items', 'risks', 'issues'])) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const bidDocumentId = getBidDocumentIdFromItem(item, bidDocumentIds);
    const title = normalizeText(item.title || item.summary).slice(0, 80);
    const originalText = normalizeText(item.originalText || item.original_text || item.evidence || item.bidEvidence) || '未提供明确原文摘录，请结合位置线索复核。';
    const locationHint = normalizeText(item.locationHint || item.location_hint || item.location || item.position) || '未明确具体位置，请结合原文摘录复核。';
    const fallacyReason = normalizeText(item.fallacyReason || item.fallacy_reason || item.reason || item.riskReason);
    const suggestion = normalizeText(item.suggestion || item.recommendation) || '请结合投标文件上下文人工复核后修改。';
    if (!bidDocumentId || !title || !fallacyReason) continue;
    const key = `${bidDocumentId}\u0000${title}\u0000${fallacyReason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ id: normalizeText(item.id) || createId('logic_finding'), bidDocumentId, title, originalText, locationHint, fallacyReason, suggestion });
  }
  return findings;
}

module.exports = {
  normalizeRejectionCheckFindings,
  findVerifiedTypoPosition,
  createVerifiedTypoExcerpt,
  createLineLocationHint,
  normalizeTypoCheckFindings,
  normalizeLogicCheckFindings,
};
