// 废标项检查的纯模型层：状态归一化、格式化、签名计算与展示用标签。
//
// 这些原本散在 RejectionCheckPage.tsx 的模块顶层（约 340 行）。它们不依赖 React、不读组件状态，
// 只做纯变换，因此下沉为独立的 .ts 模块；页面与展示组件反过来从这里 import。
import type {
  LogicCheckFinding,
  LogicCheckResultState,
  RejectionBackgroundTaskState,
  RejectionCheckFinding,
  RejectionCheckOptions,
  RejectionCheckResultState,
  RejectionCheckResultTab,
  RejectionCheckRunStatus,
  RejectionCheckStep,
  RejectionDocumentContent,
  RejectionDocumentRole,
  RejectionDocumentSource,
  RejectionExtractionState,
  RejectionResultTab,
  TypoCheckFinding,
  TypoCheckResultState,
} from '../../shared/types/domains/rejection-check';

const steps: RejectionCheckStep[] = ['documents', 'items', 'results'];

const stepLabels: Record<RejectionCheckStep, string> = {
  documents: '选择标书',
  items: '无效与废标项',
  results: '检查结果',
};

const resultTabs: Array<{ id: RejectionResultTab; label: string }> = [
  { id: 'analysis', label: '解析结果' },
  { id: 'custom', label: '自定义检查项' },
];

const checkResultTabs: Array<{ id: RejectionCheckResultTab; label: string; description: string }> = [
  { id: 'rejection', label: '废标项检查', description: '根据无效与废标项检查投标文件响应风险' },
  { id: 'typo', label: '错别字检查', description: '检查投标文件中的错别字和明显文字错误' },
  { id: 'logic', label: '逻辑谬误检查', description: '检查前后矛盾、逻辑不一致和表达漏洞' },
];

const defaultCheckOptions: RejectionCheckOptions = {
  rejectionCheck: true,
  typoCheck: true,
  logicCheck: true,
};

const documentLabels: Record<RejectionDocumentRole, string> = {
  tender: '招标文件',
  bid: '投标文件',
};

const sourceLabels: Record<RejectionDocumentSource, string> = {
  upload: '上传解析',
  'technical-plan': '技术方案',
};

const extractionStatusLabels: Record<RejectionExtractionState['status'], string> = {
  idle: '待解析',
  running: '解析中',
  success: '已完成',
  error: '解析失败',
};

const checkRunStatusLabels: Record<RejectionCheckRunStatus, string> = {
  idle: '待检查',
  running: '检查中',
  success: '已完成',
  error: '检查失败',
};

type RejectionCheckTabStatus = RejectionCheckRunStatus | 'disabled';

const checkTabStatusLabels: Record<RejectionCheckTabStatus, string> = {
  ...checkRunStatusLabels,
  disabled: '未启用',
};

const findingTypeLabels: Record<RejectionCheckFinding['type'], string> = {
  invalidBid: '无效标',
  rejectionItem: '废标项',
};

const findingSeverityLabels: Record<RejectionCheckFinding['severity'], string> = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
};

function createEmptyExtractionState(): RejectionExtractionState {
  return { status: 'idle', content: '' };
}

function createEmptyRejectionCheckResultState(): RejectionCheckResultState {
  return { status: 'idle', findings: [] };
}

function createEmptyTypoCheckResultState(): TypoCheckResultState {
  return { status: 'idle', findings: [] };
}

function createEmptyLogicCheckResultState(): LogicCheckResultState {
  return { status: 'idle', findings: [] };
}

function normalizeBackgroundTaskState(state?: Partial<RejectionBackgroundTaskState> | null): RejectionBackgroundTaskState | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const type = state.type === 'rejection-items-extraction' || state.type === 'rejection-check-run' ? state.type : undefined;
  const status = state.status === 'running' || state.status === 'success' || state.status === 'error' ? state.status : undefined;
  if (!type || !status || typeof state.task_id !== 'string') return undefined;

  return {
    task_id: state.task_id,
    type,
    status,
    progress: Number.isFinite(Number(state.progress)) ? Number(state.progress) : 0,
    logs: Array.isArray(state.logs) ? state.logs.map((item) => String(item)) : [],
    started_at: typeof state.started_at === 'string' ? state.started_at : new Date().toISOString(),
    updated_at: typeof state.updated_at === 'string' ? state.updated_at : new Date().toISOString(),
    error: typeof state.error === 'string' ? state.error : undefined,
  };
}

function normalizeCheckOptions(options?: Partial<RejectionCheckOptions> | null): RejectionCheckOptions {
  return {
    rejectionCheck: true,
    typoCheck: options?.typoCheck !== false,
    logicCheck: options?.logicCheck !== false,
  };
}

function isCheckResultTabEnabled(tabId: RejectionCheckResultTab, options: RejectionCheckOptions) {
  if (tabId === 'rejection') return options.rejectionCheck;
  if (tabId === 'typo') return options.typoCheck;
  return options.logicCheck;
}

function getCheckResultTabProgress(status: RejectionCheckTabStatus, progressMessage?: string) {
  if (status === 'success' || status === 'error') return 100;
  if (status !== 'running') return 0;
  if (progressMessage?.includes('第三轮')) return 85;
  if (progressMessage?.includes('校验')) return 78;
  if (progressMessage?.includes('第二轮')) return 60;
  if (progressMessage?.includes('识别') || progressMessage?.includes('逻辑')) return 55;
  return 30;
}

function normalizeExtractionState(state?: Partial<RejectionExtractionState> | null): RejectionExtractionState {
  if (!state) {
    return createEmptyExtractionState();
  }

  const content = typeof state.content === 'string' ? stripTripleQuoteWrapper(state.content) : '';
  const status = ['idle', 'running', 'success', 'error'].includes(state.status || '') ? state.status : 'idle';
  return {
    ...state,
    status: status as RejectionExtractionState['status'],
    content,
    error: state.error,
  };
}

function normalizeFindingState(item: Partial<RejectionCheckFinding> | null | undefined, index: number): RejectionCheckFinding | null {
  if (!item) return null;
  const type = item.type === 'invalidBid' || item.type === 'rejectionItem' ? item.type : 'rejectionItem';
  const severity = item.severity === 'high' || item.severity === 'medium' || item.severity === 'low' ? item.severity : 'medium';
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const bidEvidence = typeof item.bidEvidence === 'string' ? item.bidEvidence.trim() : '';
  const riskReason = typeof item.riskReason === 'string' ? item.riskReason.trim() : '';
  if (!title || !bidEvidence || !riskReason) return null;

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `rejection-finding-${index + 1}`,
    bidDocumentId: typeof item.bidDocumentId === 'string' && item.bidDocumentId.trim() ? item.bidDocumentId.trim() : '',
    type,
    severity,
    title,
    summary: typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim() : title,
    requirement: typeof item.requirement === 'string' && item.requirement.trim() ? item.requirement.trim() : '未明确引用具体检查依据，请人工复核。',
    bidEvidence,
    riskReason,
    suggestion: typeof item.suggestion === 'string' && item.suggestion.trim() ? item.suggestion.trim() : '请结合招标文件要求和投标文件原文人工复核后处理。',
  };
}

function normalizeRejectionCheckResultState(state?: Partial<RejectionCheckResultState> | null): RejectionCheckResultState {
  if (!state) {
    return createEmptyRejectionCheckResultState();
  }

  const findings = Array.isArray(state.findings)
    ? state.findings.map((item, index) => normalizeFindingState(item, index)).filter((item): item is RejectionCheckFinding => Boolean(item))
    : [];
  const status = ['idle', 'running', 'success', 'error'].includes(state.status || '') ? state.status : 'idle';
  const activeFindingId = findings.some((item) => item.id === state.activeFindingId) ? state.activeFindingId : undefined;

  return {
    ...state,
    status: status as RejectionCheckRunStatus,
    findings,
    activeFindingId,
  };
}

function normalizeTypoFindingState(item: Partial<TypoCheckFinding> | null | undefined, index: number): TypoCheckFinding | null {
  if (!item) return null;
  const wrongText = typeof item.wrongText === 'string' ? item.wrongText.trim() : '';
  const correctText = typeof item.correctText === 'string' ? item.correctText.trim() : '';
  const originalExcerpt = typeof item.originalExcerpt === 'string' ? item.originalExcerpt.trim() : '';
  if (!wrongText || !correctText || !originalExcerpt || wrongText === correctText) return null;

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `typo-finding-${index + 1}`,
    bidDocumentId: typeof item.bidDocumentId === 'string' && item.bidDocumentId.trim() ? item.bidDocumentId.trim() : '',
    wrongText,
    correctText,
    originalExcerpt,
    reason: typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : '疑似错别字，请结合原文复核。',
    locationHint: typeof item.locationHint === 'string' && item.locationHint.trim() ? item.locationHint.trim() : undefined,
  };
}

function normalizeTypoCheckResultState(state?: Partial<TypoCheckResultState> | null): TypoCheckResultState {
  if (!state) {
    return createEmptyTypoCheckResultState();
  }

  const findings = Array.isArray(state.findings)
    ? state.findings.map((item, index) => normalizeTypoFindingState(item, index)).filter((item): item is TypoCheckFinding => Boolean(item))
    : [];
  const status = ['idle', 'running', 'success', 'error'].includes(state.status || '') ? state.status : 'idle';
  const activeFindingId = findings.some((item) => item.id === state.activeFindingId) ? state.activeFindingId : undefined;

  return {
    ...state,
    status: status as RejectionCheckRunStatus,
    findings,
    activeFindingId,
  };
}

function normalizeLogicFindingState(item: Partial<LogicCheckFinding> | null | undefined, index: number): LogicCheckFinding | null {
  if (!item) return null;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const fallacyReason = typeof item.fallacyReason === 'string' ? item.fallacyReason.trim() : '';
  if (!title || !fallacyReason) return null;

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `logic-finding-${index + 1}`,
    bidDocumentId: typeof item.bidDocumentId === 'string' && item.bidDocumentId.trim() ? item.bidDocumentId.trim() : '',
    title,
    originalText: typeof item.originalText === 'string' && item.originalText.trim() ? item.originalText.trim() : '未提供明确原文摘录，请结合位置线索复核。',
    locationHint: typeof item.locationHint === 'string' && item.locationHint.trim() ? item.locationHint.trim() : '未明确具体位置，请结合原文摘录复核。',
    fallacyReason,
    suggestion: typeof item.suggestion === 'string' && item.suggestion.trim() ? item.suggestion.trim() : '请结合投标文件上下文人工复核后修改。',
  };
}

function normalizeLogicCheckResultState(state?: Partial<LogicCheckResultState> | null): LogicCheckResultState {
  if (!state) {
    return createEmptyLogicCheckResultState();
  }

  const findings = Array.isArray(state.findings)
    ? state.findings.map((item, index) => normalizeLogicFindingState(item, index)).filter((item): item is LogicCheckFinding => Boolean(item))
    : [];
  const status = ['idle', 'running', 'success', 'error'].includes(state.status || '') ? state.status : 'idle';
  const activeFindingId = findings.some((item) => item.id === state.activeFindingId) ? state.activeFindingId : undefined;

  return {
    ...state,
    status: status as RejectionCheckRunStatus,
    findings,
    activeFindingId,
  };
}

function formatCharacterCount(length: number) {
  if (length >= 10000) return `${(length / 10000).toFixed(1)} 万字`;
  return `${length} 字`;
}

function formatContentLength(content: string) {
  return formatCharacterCount(content.trim().length);
}

function formatImportedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function getFileBadge(document: RejectionDocumentContent) {
  if (document.source === 'technical-plan') return '方案';
  const extension = document.fileName.split('.').pop()?.trim();
  return extension ? extension.slice(0, 4).toUpperCase() : 'DOC';
}

function createDocumentSignature(document: RejectionDocumentContent | null) {
  if (!document) {
    return '';
  }

  const content = document.content.trim();
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

function createRejectionCheckInputSignature(
  bidDocuments: RejectionDocumentContent[],
  invalidBidAndRejectionItems: string,
  customCheckItems: string,
) {
  const bidSignature = bidDocuments.map(createDocumentSignature).filter(Boolean).join('\n---yibiao-rejection-bid-document---\n');
  const analysis = invalidBidAndRejectionItems.trim();
  if (!bidSignature || !analysis) {
    return '';
  }

  const custom = customCheckItems.trim();
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

function getBidDocumentLabel(bidDocuments: RejectionDocumentContent[], documentId: string) {
  const index = bidDocuments.findIndex((document) => document.id === documentId);
  return index >= 0 ? `投标文件${index + 1}` : '投标文件';
}

function getTenderDocumentLabel(tenderDocuments: RejectionDocumentContent[], documentId: string) {
  const index = tenderDocuments.findIndex((document) => document.id === documentId);
  return index >= 0 ? `招标文件${index + 1}` : '招标文件';
}

function resolveImportToastType(message: string, success: boolean) {
  if (message.includes('失败')) return 'error' as const;
  if (success) return 'success' as const;
  if (message === '已取消选择' || message.startsWith('已跳过')) return 'info' as const;
  return 'error' as const;
}

function createBidDocumentsSignature(bidDocuments: RejectionDocumentContent[]) {
  return bidDocuments.map(createDocumentSignature).filter(Boolean).join('\n---yibiao-rejection-bid-signature---\n');
}

function stripTripleQuoteWrapper(content: string) {
  const trimmed = content.trim();
  if (trimmed.startsWith("'''") && trimmed.endsWith("'''")) {
    return trimmed.slice(3, -3).trim();
  }
  return content;
}
function escapeInlineHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightMarkdownText(content: string, target: string) {
  if (!target) {
    return content;
  }

  const parts = content.split(target);
  if (parts.length <= 1) {
    return content;
  }

  return parts.map((part, index) => index < parts.length - 1
    ? `${part}<mark>${escapeInlineHtml(target)}</mark>`
    : part).join('');
}

export type { RejectionCheckTabStatus };

export {
  escapeInlineHtml,
  highlightMarkdownText,
  steps,
  stepLabels,
  resultTabs,
  checkResultTabs,
  defaultCheckOptions,
  documentLabels,
  sourceLabels,
  extractionStatusLabels,
  checkRunStatusLabels,
  checkTabStatusLabels,
  findingTypeLabels,
  findingSeverityLabels,
  createEmptyExtractionState,
  createEmptyRejectionCheckResultState,
  createEmptyTypoCheckResultState,
  createEmptyLogicCheckResultState,
  normalizeBackgroundTaskState,
  normalizeCheckOptions,
  isCheckResultTabEnabled,
  getCheckResultTabProgress,
  normalizeExtractionState,
  normalizeFindingState,
  normalizeRejectionCheckResultState,
  normalizeTypoFindingState,
  normalizeTypoCheckResultState,
  normalizeLogicFindingState,
  normalizeLogicCheckResultState,
  formatCharacterCount,
  formatContentLength,
  formatImportedAt,
  getFileBadge,
  createDocumentSignature,
  createRejectionCheckInputSignature,
  getBidDocumentLabel,
  getTenderDocumentLabel,
  resolveImportToastType,
  createBidDocumentsSignature,
  stripTripleQuoteWrapper,
};
