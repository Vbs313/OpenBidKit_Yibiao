// 渲染性能探针：采集内容/DOM 指标并按渲染批次打点。
//
// 原本是 KnowledgeBasePage.tsx 的模块级助手（约 240 行），与页面状态无关，独立成模块。

import type { KnowledgeDocument, KnowledgeItem } from '../../shared/types/domains/knowledge-base';

type RenderDebugKind = 'item-source' | 'document-markdown' | 'document-items';

interface RenderDebugTrace {
  id: string;
  kind: RenderDebugKind;
  startedAt: number;
  documentId: string;
  documentName: string;
  itemId?: string;
  itemTitle?: string;
  contentLength: number;
  contentMetrics: Record<string, number>;
  longTasks: Array<Record<string, number | string>>;
  longTaskObserver?: PerformanceObserver;
  finished?: boolean;
}

let renderDebugSeq = 0;

const contentMetricKeys = [
  'chars',
  'lines',
  'htmlTags',
  'htmlTables',
  'htmlRows',
  'htmlCells',
  'markdownImages',
  'htmlImages',
  'importedAssets',
  'bareUrls',
  'markdownLinks',
] as const;

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function roundMs(value: number) {
  return Math.round(value * 10) / 10;
}

function countMatches(text: string, pattern: RegExp) {
  return (text.match(pattern) || []).length;
}

function collectContentMetrics(content: string) {
  const text = String(content || '');
  return {
    chars: text.length,
    lines: text ? text.split(/\r?\n/).length : 0,
    htmlTags: countMatches(text, /<[^>]+>/g),
    htmlTables: countMatches(text, /<table\b/gi),
    htmlRows: countMatches(text, /<tr\b/gi),
    htmlCells: countMatches(text, /<(?:td|th)\b/gi),
    markdownImages: countMatches(text, /!\[[^\]]*\]\([^)]*\)/g),
    htmlImages: countMatches(text, /<img\b/gi),
    importedAssets: countMatches(text, /yibiao-asset:\/\/imported-images/gi),
    bareUrls: countMatches(text, /\b(?:https?:\/\/|www\.)[^\s)）]+/gi),
    markdownLinks: countMatches(text, /\[[^\]]{0,200}\]\([^)]{1,500}\)/g),
  };
}

function collectItemsContentMetrics(items: KnowledgeItem[]) {
  const totals: Record<string, number> = Object.fromEntries(contentMetricKeys.map((key) => [key, 0]));
  let totalTitleChars = 0;
  let totalResumeChars = 0;
  let maxItemContentLength = 0;
  let maxItemId = '';
  let maxItemTitle = '';
  let itemsWithHtml = 0;
  let itemsWithTables = 0;
  let itemsWithImages = 0;
  let itemsWithImportedAssets = 0;
  let itemsWithBareUrls = 0;

  items.forEach((item) => {
    const content = String(item.content || '');
    const metrics = collectContentMetrics(content);
    contentMetricKeys.forEach((key) => {
      totals[key] += metrics[key];
    });
    totalTitleChars += String(item.title || '').length;
    totalResumeChars += String(item.resume || '').length;
    if (metrics.chars > maxItemContentLength) {
      maxItemContentLength = metrics.chars;
      maxItemId = item.id;
      maxItemTitle = item.title;
    }
    if (metrics.htmlTags) itemsWithHtml += 1;
    if (metrics.htmlTables) itemsWithTables += 1;
    if (metrics.markdownImages || metrics.htmlImages) itemsWithImages += 1;
    if (metrics.importedAssets) itemsWithImportedAssets += 1;
    if (metrics.bareUrls) itemsWithBareUrls += 1;
  });

  const metrics: Record<string, number> = {
    ...totals,
    itemCount: items.length,
    totalTitleChars,
    totalResumeChars,
    maxItemContentLength,
    itemsWithHtml,
    itemsWithTables,
    itemsWithImages,
    itemsWithImportedAssets,
    itemsWithBareUrls,
  };

  return {
    metrics,
    maxItemId,
    maxItemTitle,
  };
}

function collectDomMetrics(element: HTMLElement | null) {
  if (!element) return {};
  return {
    domNodes: element.querySelectorAll('*').length,
    tables: element.querySelectorAll('table').length,
    rows: element.querySelectorAll('tr').length,
    cells: element.querySelectorAll('td, th').length,
    images: element.querySelectorAll('img').length,
    links: element.querySelectorAll('a').length,
    textChars: element.textContent?.length || 0,
    htmlChars: element.innerHTML.length,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

function logRenderDebug(trace: RenderDebugTrace | null | undefined, event: string, payload: Record<string, unknown> = {}) {
  if (!trace || trace.finished) return;
  const entry = {
    traceId: trace.id,
    kind: trace.kind,
    event,
    elapsedMs: roundMs(nowMs() - trace.startedAt),
    documentId: trace.documentId,
    itemId: trace.itemId,
    ...payload,
  };
  if (typeof window !== 'undefined') {
    window.__knowledgeRenderDebugLogs = window.__knowledgeRenderDebugLogs || [];
    window.__knowledgeRenderDebugLogs.push(entry);
  }
  console.info('[knowledge-render-debug]', entry);
}

function startLongTaskObserver(trace: RenderDebugTrace) {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        const task = {
          startMs: roundMs(entry.startTime - trace.startedAt),
          durationMs: roundMs(entry.duration),
          name: entry.name || 'longtask',
        };
        trace.longTasks.push(task);
        logRenderDebug(trace, 'longtask', task);
      });
    });
    observer.observe({ entryTypes: ['longtask'] });
    trace.longTaskObserver = observer;
  } catch (error) {
    logRenderDebug(trace, 'longtask:observer-unavailable', { message: error instanceof Error ? error.message : String(error) });
  }
}

function createRenderDebugTrace(kind: RenderDebugKind, document: KnowledgeDocument, content: string, item?: KnowledgeItem) {
  const trace: RenderDebugTrace = {
    id: `${kind}-${Date.now()}-${++renderDebugSeq}`,
    kind,
    startedAt: nowMs(),
    documentId: document.id,
    documentName: document.file_name,
    itemId: item?.id,
    itemTitle: item?.title,
    contentLength: String(content || '').length,
    contentMetrics: collectContentMetrics(content),
    longTasks: [],
  };
  startLongTaskObserver(trace);
  logRenderDebug(trace, 'trace:start', {
    documentName: trace.documentName,
    itemTitle: trace.itemTitle,
    contentLength: trace.contentLength,
    metrics: trace.contentMetrics,
  });
  console.table([{ traceId: trace.id, ...trace.contentMetrics }]);
  return trace;
}

function updateTraceContentMetrics(trace: RenderDebugTrace | null | undefined, content: string) {
  if (!trace || trace.finished) return;
  const metrics = collectContentMetrics(content);
  trace.contentLength = String(content || '').length;
  trace.contentMetrics = metrics;
  logRenderDebug(trace, 'content:metrics', {
    contentLength: trace.contentLength,
    metrics,
  });
}

function updateTraceItemsMetrics(trace: RenderDebugTrace | null | undefined, items: KnowledgeItem[]) {
  if (!trace || trace.finished) return;
  const { metrics, maxItemId, maxItemTitle } = collectItemsContentMetrics(items);
  trace.contentLength = metrics.chars;
  trace.contentMetrics = metrics;
  logRenderDebug(trace, 'items:metrics', {
    itemCount: items.length,
    contentLength: trace.contentLength,
    metrics,
    maxItemId,
    maxItemTitle,
  });
}

function finishRenderDebugTrace(trace: RenderDebugTrace | null | undefined, reason: string, payload: Record<string, unknown> = {}) {
  if (!trace || trace.finished) return;
  logRenderDebug(trace, 'trace:finish', {
    reason,
    totalMs: roundMs(nowMs() - trace.startedAt),
    longTaskCount: trace.longTasks.length,
    ...payload,
  });
  if (trace.longTasks.length) {
    console.table(trace.longTasks.map((task) => ({ traceId: trace.id, ...task })));
  }
  trace.longTaskObserver?.disconnect();
  trace.finished = true;
}

function logProfilerRender(
  trace: RenderDebugTrace | null | undefined,
  profilerId: string,
  phase: string,
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number
) {
  logRenderDebug(trace, 'react-profiler', {
    profilerId,
    phase,
    actualDurationMs: roundMs(actualDuration),
    baseDurationMs: roundMs(baseDuration),
    profilerStartMs: roundMs(startTime - (trace?.startedAt || 0)),
    profilerCommitMs: roundMs(commitTime - (trace?.startedAt || 0)),
  });
}

export type {
  RenderDebugKind,
  RenderDebugTrace,
};

export {
  renderDebugSeq,
  contentMetricKeys,
  nowMs,
  roundMs,
  countMatches,
  collectContentMetrics,
  collectItemsContentMetrics,
  collectDomMetrics,
  logRenderDebug,
  startLongTaskObserver,
  createRenderDebugTrace,
  updateTraceContentMetrics,
  updateTraceItemsMetrics,
  finishRenderDebugTrace,
  logProfilerRender,
};
