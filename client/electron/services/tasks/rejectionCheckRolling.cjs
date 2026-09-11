// 废标项检查的「滚动窗口状态」：模型每段返回的补丁怎么归一化、怎么合并进累计状态、怎么汇总成下一段提示词。
//
// 这是长文档检查的核心：一次喂不进上下文，就分段跑，每段把新证据/待确认风险/已排除风险合并进状态，
// 下一段只带「最近的证据 + 汇总」。状态机本身是纯函数（输入 state + patch → 新 state）。
//
// 依赖方向：core ← findings ← rolling ← prompts ← 编排（主文件）。

const {
  dedupeItems,
  getArrayPayload,
  getPackageBidDocumentId,
  normalizeFindingType,
  normalizeSeverity,
  normalizeText,
  truncatePromptText,
} = require('./rejectionCheckCore.cjs');
const { normalizeRejectionCheckFindings } = require('./rejectionCheckFindings.cjs');

function normalizeRollingEvidenceItem(item, bidDocuments, fallbackBidDocumentId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const bidDocumentId = getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId);
  const name = truncatePromptText(item.name || item.title || item.material || item.item || item.requirement, 80);
  const evidence = truncatePromptText(item.evidence || item.originalText || item.original_text || item.excerpt || item.content || item.description, 600);
  const locationHint = truncatePromptText(item.locationHint || item.location_hint || item.location || item.position, 160);
  const source = truncatePromptText(item.source || item.requirement || item.reason, 240);
  if (!name && !evidence) return null;
  return {
    bidDocumentId,
    name: name || truncatePromptText(evidence, 80),
    evidence,
    locationHint,
    source,
  };
}

function normalizeRollingRejectionRiskItem(item, bidDocuments, fallbackBidDocumentId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const bidDocumentId = getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId);
  const title = truncatePromptText(item.title || item.summary || item.requirement, 80);
  if (!title) return null;
  return {
    bidDocumentId,
    type: normalizeFindingType(item.type),
    severity: normalizeSeverity(item.severity),
    title,
    summary: truncatePromptText(item.summary || title, 180),
    requirement: truncatePromptText(item.requirement || item.source, 360),
    bidEvidence: truncatePromptText(item.bidEvidence || item.evidence || item.bid_evidence, 600),
    riskReason: truncatePromptText(item.riskReason || item.reason || item.risk_reason, 600),
    suggestion: truncatePromptText(item.suggestion || item.recommendation, 300),
    statusReason: truncatePromptText(item.statusReason || item.status_reason || item.pendingReason || item.pending_reason, 360),
  };
}

function normalizeResolvedSummaryItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const title = truncatePromptText(item.title || item.summary || item.name, 100);
  const reason = truncatePromptText(item.reason || item.resolvedReason || item.resolved_reason || item.evidence, 360);
  if (!title && !reason) return null;
  return {
    title: title || truncatePromptText(reason, 100),
    reason,
    locationHint: truncatePromptText(item.locationHint || item.location_hint || item.location, 160),
  };
}

function normalizePatchReferenceId(item, keys) {
  for (const key of keys) {
    const value = normalizeText(item?.[key]);
    if (value) return value;
  }
  return '';
}

function createSequentialStateId(prefix, sequence) {
  return `${prefix}_${String(sequence).padStart(4, '0')}`;
}

function assignRejectionEvidenceId(state, item) {
  const id = createSequentialStateId('evidence', state.nextEvidenceSeq);
  state.nextEvidenceSeq += 1;
  return { ...item, id };
}

function assignRejectionRiskId(state, item) {
  const id = createSequentialStateId('risk', state.nextRiskSeq);
  state.nextRiskSeq += 1;
  return { ...item, id };
}

function assignLogicFactId(state, item) {
  const id = createSequentialStateId('fact', state.nextFactSeq);
  state.nextFactSeq += 1;
  return { ...item, id };
}

function assignLogicIssueId(state, item) {
  const id = createSequentialStateId('issue', state.nextIssueSeq);
  state.nextIssueSeq += 1;
  return { ...item, id };
}

function normalizeRollingRejectionRiskUpdate(item, bidDocuments, fallbackBidDocumentId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = normalizePatchReferenceId(item, ['id', 'riskId', 'risk_id', 'pendingRiskId', 'pending_risk_id']);
  if (!id) return null;
  return {
    id,
    bidDocumentId: getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId),
    type: item.type ? normalizeFindingType(item.type) : undefined,
    severity: item.severity ? normalizeSeverity(item.severity) : undefined,
    title: truncatePromptText(item.title || item.summary || item.requirement, 80),
    summary: truncatePromptText(item.summary, 180),
    requirement: truncatePromptText(item.requirement || item.source, 360),
    bidEvidence: truncatePromptText(item.bidEvidence || item.evidence || item.bid_evidence, 600),
    riskReason: truncatePromptText(item.riskReason || item.reason || item.risk_reason, 600),
    suggestion: truncatePromptText(item.suggestion || item.recommendation, 300),
    statusReason: truncatePromptText(item.statusReason || item.status_reason || item.pendingReason || item.pending_reason, 360),
  };
}

function normalizeRollingRejectionResolve(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = normalizePatchReferenceId(item, ['id', 'riskId', 'risk_id', 'pendingRiskId', 'pending_risk_id']);
  if (!id) return null;
  return {
    id,
    title: truncatePromptText(item.title || item.summary || item.name, 100),
    reason: truncatePromptText(item.reason || item.resolvedReason || item.resolved_reason || item.evidence, 360),
    locationHint: truncatePromptText(item.locationHint || item.location_hint || item.location, 160),
  };
}

function normalizeRollingRejectionPatch(parsed, bidDocuments, fallbackBidDocumentId = '') {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const evidenceAdds = getArrayPayload(source, ['evidenceAdds', 'evidence_adds', 'submittedEvidenceAdds', 'submitted_evidence_adds', 'submittedEvidence', 'submitted_evidence'])
    .map((item) => normalizeRollingEvidenceItem(item, bidDocuments, fallbackBidDocumentId))
    .filter(Boolean);
  const pendingRiskAdds = getArrayPayload(source, ['pendingRiskAdds', 'pending_risk_adds', 'pendingRisks', 'pending_risks'])
    .map((item) => normalizeRollingRejectionRiskItem(item, bidDocuments, fallbackBidDocumentId))
    .filter(Boolean);
  const pendingRiskUpdates = getArrayPayload(source, ['pendingRiskUpdates', 'pending_risk_updates', 'riskUpdates', 'risk_updates'])
    .map((item) => normalizeRollingRejectionRiskUpdate(item, bidDocuments, fallbackBidDocumentId))
    .filter(Boolean);
  const pendingRiskResolves = getArrayPayload(source, ['pendingRiskResolves', 'pending_risk_resolves', 'riskResolves', 'risk_resolves', 'resolvedRisks', 'resolved_risks'])
    .map(normalizeRollingRejectionResolve)
    .filter(Boolean);
  const confirmedRisks = normalizeRejectionCheckFindings({
    findings: getArrayPayload(source, ['confirmedRiskAdds', 'confirmed_risk_adds', 'confirmedRisks', 'confirmed_risks', 'confirmedFindings', 'confirmed_findings', 'findings']),
  }, bidDocuments);

  return { evidenceAdds, pendingRiskAdds, pendingRiskUpdates, pendingRiskResolves, confirmedRiskAdds: confirmedRisks };
}

function mergeDefinedFields(target, update, fields) {
  const next = { ...target };
  for (const field of fields) {
    if (update[field] !== undefined && update[field] !== '') {
      next[field] = update[field];
    }
  }
  return next;
}

function applyRollingRejectionPatch(state, patch) {
  const next = {
    ...state,
    submittedEvidence: [...state.submittedEvidence],
    pendingRisks: [...state.pendingRisks],
    resolvedRisks: [...state.resolvedRisks],
    confirmedRisks: [...state.confirmedRisks],
  };

  for (const item of patch.evidenceAdds || []) {
    const key = `${item.bidDocumentId}\u0000${item.name}\u0000${item.evidence}`;
    const exists = next.submittedEvidence.some((evidence) => `${evidence.bidDocumentId}\u0000${evidence.name}\u0000${evidence.evidence}` === key);
    if (!exists) next.submittedEvidence.push(assignRejectionEvidenceId(next, item));
  }

  for (const item of patch.pendingRiskAdds || []) {
    const key = `${item.bidDocumentId}\u0000${item.type}\u0000${item.title}\u0000${item.requirement}`;
    const exists = next.pendingRisks.some((risk) => `${risk.bidDocumentId}\u0000${risk.type}\u0000${risk.title}\u0000${risk.requirement}` === key)
      || next.confirmedRisks.some((risk) => `${risk.bidDocumentId}\u0000${risk.type}\u0000${risk.title}\u0000${risk.requirement}` === key);
    if (!exists) next.pendingRisks.push(assignRejectionRiskId(next, item));
  }

  for (const update of patch.pendingRiskUpdates || []) {
    next.pendingRisks = next.pendingRisks.map((risk) => risk.id === update.id
      ? mergeDefinedFields(risk, update, ['type', 'severity', 'title', 'summary', 'requirement', 'bidEvidence', 'riskReason', 'suggestion', 'statusReason'])
      : risk);
  }

  for (const resolve of patch.pendingRiskResolves || []) {
    const riskIndex = next.pendingRisks.findIndex((risk) => risk.id === resolve.id);
    if (riskIndex < 0) continue;
    const [risk] = next.pendingRisks.splice(riskIndex, 1);
    next.resolvedRisks.push({
      id: `resolved_${risk.id}`,
      riskId: risk.id,
      title: resolve.title || risk.title,
      reason: resolve.reason || '后续片段已提供线索，原待确认风险被排除。',
      locationHint: resolve.locationHint || risk.locationHint,
    });
  }

  for (const item of patch.confirmedRiskAdds || []) {
    const key = `${item.bidDocumentId}\u0000${item.type}\u0000${item.title}\u0000${item.bidEvidence}`;
    const exists = next.confirmedRisks.some((risk) => `${risk.bidDocumentId}\u0000${risk.type}\u0000${risk.title}\u0000${risk.bidEvidence}` === key);
    if (!exists) next.confirmedRisks.push(assignRejectionRiskId(next, item));
  }

  return {
    ...next,
    submittedEvidence: dedupeItems(next.submittedEvidence, (item) => `${item.bidDocumentId}\u0000${item.name}\u0000${item.evidence}`),
    pendingRisks: dedupeItems(next.pendingRisks, (item) => `${item.bidDocumentId}\u0000${item.type}\u0000${item.title}\u0000${item.requirement}`),
    resolvedRisks: dedupeItems(next.resolvedRisks, (item) => `${item.title}\u0000${item.reason}`),
    confirmedRisks: dedupeItems(next.confirmedRisks, (item) => `${item.bidDocumentId}\u0000${item.type}\u0000${item.title}\u0000${item.bidEvidence}`),
  };
}

function createEmptyRollingRejectionState() {
  return {
    nextEvidenceSeq: 1,
    nextRiskSeq: 1,
    submittedEvidence: [],
    pendingRisks: [],
    resolvedRisks: [],
    confirmedRisks: [],
  };
}

function normalizeLogicFactItem(item, bidDocuments, fallbackBidDocumentId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const bidDocumentId = getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId);
  const category = truncatePromptText(item.category || item.type || item.field || '关键事实', 60);
  const name = truncatePromptText(item.name || item.title || item.fieldName || item.field_name, 100);
  const value = truncatePromptText(item.value || item.fact || item.content || item.description, 500);
  const evidence = truncatePromptText(item.evidence || item.originalText || item.original_text || item.excerpt, 500);
  const locationHint = truncatePromptText(item.locationHint || item.location_hint || item.location || item.position, 160);
  if (!name && !value && !evidence) return null;
  return {
    bidDocumentId,
    category,
    name: name || truncatePromptText(value || evidence, 100),
    value,
    evidence,
    locationHint,
  };
}

function normalizeRollingLogicIssueItem(item, bidDocuments, fallbackBidDocumentId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const bidDocumentId = getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId);
  const title = truncatePromptText(item.title || item.summary || item.name, 80);
  const fallacyReason = truncatePromptText(item.fallacyReason || item.fallacy_reason || item.reason || item.riskReason, 600);
  if (!title && !fallacyReason) return null;
  return {
    bidDocumentId,
    title: title || truncatePromptText(fallacyReason, 80),
    originalText: truncatePromptText(item.originalText || item.original_text || item.evidence || item.bidEvidence, 700),
    locationHint: truncatePromptText(item.locationHint || item.location_hint || item.location || item.position, 180),
    fallacyReason,
    suggestion: truncatePromptText(item.suggestion || item.recommendation, 300),
    statusReason: truncatePromptText(item.statusReason || item.status_reason || item.pendingReason || item.pending_reason, 360),
  };
}

function normalizeRollingLogicIssueUpdate(item, bidDocuments, fallbackBidDocumentId = '') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = normalizePatchReferenceId(item, ['id', 'issueId', 'issue_id', 'pendingIssueId', 'pending_issue_id']);
  if (!id) return null;
  return {
    id,
    bidDocumentId: getPackageBidDocumentId(item, bidDocuments, fallbackBidDocumentId),
    title: truncatePromptText(item.title || item.summary || item.name, 80),
    originalText: truncatePromptText(item.originalText || item.original_text || item.evidence || item.bidEvidence, 700),
    locationHint: truncatePromptText(item.locationHint || item.location_hint || item.location || item.position, 180),
    fallacyReason: truncatePromptText(item.fallacyReason || item.fallacy_reason || item.reason || item.riskReason, 600),
    suggestion: truncatePromptText(item.suggestion || item.recommendation, 300),
    statusReason: truncatePromptText(item.statusReason || item.status_reason || item.pendingReason || item.pending_reason, 360),
  };
}

function normalizeRollingLogicResolve(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = normalizePatchReferenceId(item, ['id', 'issueId', 'issue_id', 'pendingIssueId', 'pending_issue_id']);
  if (!id) return null;
  return {
    id,
    title: truncatePromptText(item.title || item.summary || item.name, 100),
    reason: truncatePromptText(item.reason || item.resolvedReason || item.resolved_reason || item.evidence, 360),
    locationHint: truncatePromptText(item.locationHint || item.location_hint || item.location, 160),
  };
}

function normalizeRollingLogicPatch(parsed, bidDocuments, fallbackBidDocumentId = '') {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const factAdds = getArrayPayload(source, ['factAdds', 'fact_adds', 'factRegisterAdds', 'fact_register_adds', 'facts', 'factRegister', 'fact_register'])
    .map((item) => normalizeLogicFactItem(item, bidDocuments, fallbackBidDocumentId))
    .filter(Boolean);
  const pendingIssueAdds = getArrayPayload(source, ['pendingIssueAdds', 'pending_issue_adds', 'pendingIssues', 'pending_issues'])
    .map((item) => normalizeRollingLogicIssueItem(item, bidDocuments, fallbackBidDocumentId))
    .filter(Boolean);
  const pendingIssueUpdates = getArrayPayload(source, ['pendingIssueUpdates', 'pending_issue_updates', 'issueUpdates', 'issue_updates'])
    .map((item) => normalizeRollingLogicIssueUpdate(item, bidDocuments, fallbackBidDocumentId))
    .filter(Boolean);
  const pendingIssueResolves = getArrayPayload(source, ['pendingIssueResolves', 'pending_issue_resolves', 'issueResolves', 'issue_resolves', 'resolvedIssues', 'resolved_issues'])
    .map(normalizeRollingLogicResolve)
    .filter(Boolean);
  const confirmedIssues = normalizeLogicCheckFindings({
    findings: getArrayPayload(source, ['confirmedIssueAdds', 'confirmed_issue_adds', 'confirmedIssues', 'confirmed_issues', 'confirmedFindings', 'confirmed_findings', 'findings']),
  }, bidDocuments);

  return { factAdds, pendingIssueAdds, pendingIssueUpdates, pendingIssueResolves, confirmedIssueAdds: confirmedIssues };
}

function applyRollingLogicPatch(state, patch) {
  const next = {
    ...state,
    factRegister: [...state.factRegister],
    pendingIssues: [...state.pendingIssues],
    resolvedIssues: [...state.resolvedIssues],
    confirmedIssues: [...state.confirmedIssues],
  };

  for (const item of patch.factAdds || []) {
    const key = `${item.bidDocumentId}\u0000${item.category}\u0000${item.name}\u0000${item.value}`;
    const exists = next.factRegister.some((fact) => `${fact.bidDocumentId}\u0000${fact.category}\u0000${fact.name}\u0000${fact.value}` === key);
    if (!exists) next.factRegister.push(assignLogicFactId(next, item));
  }

  for (const item of patch.pendingIssueAdds || []) {
    const key = `${item.bidDocumentId}\u0000${item.title}\u0000${item.fallacyReason}`;
    const exists = next.pendingIssues.some((issue) => `${issue.bidDocumentId}\u0000${issue.title}\u0000${issue.fallacyReason}` === key)
      || next.confirmedIssues.some((issue) => `${issue.bidDocumentId}\u0000${issue.title}\u0000${issue.fallacyReason}` === key);
    if (!exists) next.pendingIssues.push(assignLogicIssueId(next, item));
  }

  for (const update of patch.pendingIssueUpdates || []) {
    next.pendingIssues = next.pendingIssues.map((issue) => issue.id === update.id
      ? mergeDefinedFields(issue, update, ['title', 'originalText', 'locationHint', 'fallacyReason', 'suggestion', 'statusReason'])
      : issue);
  }

  for (const resolve of patch.pendingIssueResolves || []) {
    const issueIndex = next.pendingIssues.findIndex((issue) => issue.id === resolve.id);
    if (issueIndex < 0) continue;
    const [issue] = next.pendingIssues.splice(issueIndex, 1);
    next.resolvedIssues.push({
      id: `resolved_${issue.id}`,
      issueId: issue.id,
      title: resolve.title || issue.title,
      reason: resolve.reason || '后续片段已解释或修正，原待确认问题被排除。',
      locationHint: resolve.locationHint || issue.locationHint,
    });
  }

  for (const item of patch.confirmedIssueAdds || []) {
    const key = `${item.bidDocumentId}\u0000${item.title}\u0000${item.fallacyReason}`;
    const exists = next.confirmedIssues.some((issue) => `${issue.bidDocumentId}\u0000${issue.title}\u0000${issue.fallacyReason}` === key);
    if (!exists) next.confirmedIssues.push(assignLogicIssueId(next, item));
  }

  return {
    ...next,
    factRegister: dedupeItems(next.factRegister, (item) => `${item.bidDocumentId}\u0000${item.category}\u0000${item.name}\u0000${item.value}`),
    pendingIssues: dedupeItems(next.pendingIssues, (item) => `${item.bidDocumentId}\u0000${item.title}\u0000${item.fallacyReason}`),
    resolvedIssues: dedupeItems(next.resolvedIssues, (item) => `${item.title}\u0000${item.reason}`),
    confirmedIssues: dedupeItems(next.confirmedIssues, (item) => `${item.bidDocumentId}\u0000${item.title}\u0000${item.fallacyReason}`),
  };
}

function createEmptyRollingLogicState() {
  return {
    nextFactSeq: 1,
    nextIssueSeq: 1,
    factRegister: [],
    pendingIssues: [],
    resolvedIssues: [],
    confirmedIssues: [],
  };
}

function dedupeRejectionFindings(findings) {
  return limitDedupeItems(findings, Number.MAX_SAFE_INTEGER, (item) => `${item.bidDocumentId}\u0000${item.type}\u0000${item.title}\u0000${item.bidEvidence}\u0000${item.riskReason}`);
}

function dedupeTypoFindings(findings) {
  return limitDedupeItems(findings, Number.MAX_SAFE_INTEGER, (item) => {
    const position = Number(item.position);
    const positionKey = Number.isFinite(position) ? String(Math.floor(position)) : `${item.locationHint || ''}\u0000${item.originalExcerpt || ''}`;
    return `${item.bidDocumentId}\u0000${item.wrongText}\u0000${item.correctText}\u0000${positionKey}`;
  });
}

function dedupeLogicFindings(findings) {
  return limitDedupeItems(findings, Number.MAX_SAFE_INTEGER, (item) => `${item.bidDocumentId}\u0000${item.title}\u0000${item.locationHint}\u0000${item.fallacyReason}`);
}

function takeRecentItems(items, limit) {
  const source = Array.isArray(items) ? items : [];
  return source.slice(Math.max(0, source.length - limit));
}

function createRollingRejectionStateSummary(state) {
  return {
    counts: {
      submittedEvidence: state.submittedEvidence.length,
      pendingRisks: state.pendingRisks.length,
      resolvedRisks: state.resolvedRisks.length,
      confirmedRisks: state.confirmedRisks.length,
    },
    submittedEvidence: takeRecentItems(state.submittedEvidence, rollingSummaryEvidenceLimit).map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      name: item.name,
      evidence: truncatePromptText(item.evidence, 220),
      locationHint: item.locationHint,
      source: truncatePromptText(item.source, 160),
    })),
    pendingRisks: state.pendingRisks.map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      type: item.type,
      severity: item.severity,
      title: item.title,
      requirement: truncatePromptText(item.requirement, 220),
      bidEvidence: truncatePromptText(item.bidEvidence, 260),
      riskReason: truncatePromptText(item.riskReason, 260),
      statusReason: truncatePromptText(item.statusReason, 180),
    })),
    resolvedRisks: takeRecentItems(state.resolvedRisks, rollingSummaryResolvedLimit),
    confirmedRisks: takeRecentItems(state.confirmedRisks, rollingSummaryConfirmedLimit).map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      type: item.type,
      severity: item.severity,
      title: item.title,
      bidEvidence: truncatePromptText(item.bidEvidence, 260),
      riskReason: truncatePromptText(item.riskReason, 260),
    })),
  };
}

function createRollingLogicStateSummary(state) {
  return {
    counts: {
      factRegister: state.factRegister.length,
      pendingIssues: state.pendingIssues.length,
      resolvedIssues: state.resolvedIssues.length,
      confirmedIssues: state.confirmedIssues.length,
    },
    factRegister: takeRecentItems(state.factRegister, rollingSummaryEvidenceLimit).map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      category: item.category,
      name: item.name,
      value: truncatePromptText(item.value, 220),
      evidence: truncatePromptText(item.evidence, 220),
      locationHint: item.locationHint,
    })),
    pendingIssues: state.pendingIssues.map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      title: item.title,
      originalText: truncatePromptText(item.originalText, 260),
      locationHint: item.locationHint,
      fallacyReason: truncatePromptText(item.fallacyReason, 260),
      statusReason: truncatePromptText(item.statusReason, 180),
    })),
    resolvedIssues: takeRecentItems(state.resolvedIssues, rollingSummaryResolvedLimit),
    confirmedIssues: takeRecentItems(state.confirmedIssues, rollingSummaryConfirmedLimit).map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      title: item.title,
      originalText: truncatePromptText(item.originalText, 260),
      locationHint: item.locationHint,
      fallacyReason: truncatePromptText(item.fallacyReason, 260),
    })),
  };
}

function createFinalRejectionStateSummary(state) {
  return {
    counts: {
      submittedEvidence: state.submittedEvidence.length,
      pendingRisks: state.pendingRisks.length,
      resolvedRisks: state.resolvedRisks.length,
      confirmedRisks: state.confirmedRisks.length,
    },
    submittedEvidenceIndex: state.submittedEvidence.map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      name: item.name,
      evidence: truncatePromptText(item.evidence, 180),
      locationHint: item.locationHint,
      source: truncatePromptText(item.source, 120),
    })),
    resolvedRisks: state.resolvedRisks.map((item) => ({
      id: item.id,
      riskId: item.riskId,
      title: item.title,
      reason: truncatePromptText(item.reason, 220),
      locationHint: item.locationHint,
    })),
  };
}

function createFinalLogicStateSummary(state) {
  return {
    counts: {
      factRegister: state.factRegister.length,
      pendingIssues: state.pendingIssues.length,
      resolvedIssues: state.resolvedIssues.length,
      confirmedIssues: state.confirmedIssues.length,
    },
    factRegisterIndex: state.factRegister.map((item) => ({
      id: item.id,
      bidDocumentId: item.bidDocumentId,
      category: item.category,
      name: item.name,
      value: truncatePromptText(item.value, 180),
      evidence: truncatePromptText(item.evidence, 180),
      locationHint: item.locationHint,
    })),
    resolvedIssues: state.resolvedIssues.map((item) => ({
      id: item.id,
      issueId: item.issueId,
      title: item.title,
      reason: truncatePromptText(item.reason, 220),
      locationHint: item.locationHint,
    })),
  };
}

function chunkItems(items, batchSize) {
  const result = [];
  const source = Array.isArray(items) ? items : [];
  for (let index = 0; index < source.length; index += batchSize) {
    result.push(source.slice(index, index + batchSize));
  }
  return result;
}

function createRejectionFinalCandidates(state) {
  return [
    ...state.confirmedRisks.map((item) => ({ ...item, candidateStatus: 'confirmed' })),
    ...state.pendingRisks.map((item) => ({ ...item, candidateStatus: 'pending' })),
  ];
}

function createLogicFinalCandidates(state) {
  return [
    ...state.confirmedIssues.map((item) => ({ ...item, candidateStatus: 'confirmed' })),
    ...state.pendingIssues.map((item) => ({ ...item, candidateStatus: 'pending' })),
  ];
}

module.exports = {
  normalizeRollingEvidenceItem,
  normalizeRollingRejectionRiskItem,
  normalizeResolvedSummaryItem,
  normalizePatchReferenceId,
  createSequentialStateId,
  assignRejectionEvidenceId,
  assignRejectionRiskId,
  assignLogicFactId,
  assignLogicIssueId,
  normalizeRollingRejectionRiskUpdate,
  normalizeRollingRejectionResolve,
  normalizeRollingRejectionPatch,
  mergeDefinedFields,
  applyRollingRejectionPatch,
  createEmptyRollingRejectionState,
  normalizeLogicFactItem,
  normalizeRollingLogicIssueItem,
  normalizeRollingLogicIssueUpdate,
  normalizeRollingLogicResolve,
  normalizeRollingLogicPatch,
  applyRollingLogicPatch,
  createEmptyRollingLogicState,
  dedupeRejectionFindings,
  dedupeTypoFindings,
  dedupeLogicFindings,
  takeRecentItems,
  createRollingRejectionStateSummary,
  createRollingLogicStateSummary,
  createFinalRejectionStateSummary,
  createFinalLogicStateSummary,
  chunkItems,
  createRejectionFinalCandidates,
  createLogicFinalCandidates,
};
