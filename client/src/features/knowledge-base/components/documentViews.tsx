// 知识库页面的展示组件：文档阅读器、条目卡片、来源弹窗、分析视图、搜索结果。
//
// 这些原本是 KnowledgeBasePage.tsx 的模块级组件（已是显式 props），抽到 components/ 后页面只负责编排。

import * as Dialog from '@radix-ui/react-dialog';
import { InlineSpinner, MarkdownFullscreenViewer, MarkdownRenderer, useToast } from '../../../shared/ui';
import { Profiler, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KnowledgeAnalysisSnapshot, KnowledgeBaseSearchPage, KnowledgeBaseSearchResult, KnowledgeDocument, KnowledgeItem } from '../../../shared/types/domains/knowledge-base';
import type { ReactNode } from 'react';
import { collectDomMetrics, createRenderDebugTrace, finishRenderDebugTrace, logProfilerRender, logRenderDebug } from '../renderProfiling';
import { canOpenMarkdown, formatInteger, formatPercent } from '../model';
import type { KnowledgeViewer } from '../model';
import type { RenderDebugTrace } from '../renderProfiling';

interface KnowledgeDocumentViewerProps {
  document: KnowledgeDocument;
  mode: KnowledgeViewer['mode'];
  targetItemId?: string;
  itemsPreview: KnowledgeItem[];
  markdownPreview: string;
  analysisSnapshot: KnowledgeAnalysisSnapshot | null;
  viewerLoading: boolean;
  viewerTrace: RenderDebugTrace | null;
  startingMatching: boolean;
  developerMode: boolean;
  onBack: () => void;
  onModeChange: (mode: KnowledgeViewer['mode']) => void;
  onStartMatching: () => void;
  onRefreshAnalysis: () => void;
}

interface KnowledgeItemCardProps {
  item: KnowledgeItem;
  developerMode: boolean;
  onOpenSource: () => void;
}

interface KnowledgeItemSourceViewerProps {
  item: KnowledgeItem;
  developerMode: boolean;
  rendering: boolean;
  debugTrace: RenderDebugTrace | null;
  onClose: () => void;
}

interface DebuggableMarkdownContentProps {
  children: ReactNode;
  className: string;
  debugTrace: RenderDebugTrace | null;
  developerMode: boolean;
  profilerId: string;
}

interface KnowledgeAnalysisViewProps {
  document: KnowledgeDocument;
  snapshot: KnowledgeAnalysisSnapshot | null;
  startingMatching: boolean;
  onStartMatching: () => void;
  onRefresh: () => void;
}

interface KnowledgeSearchResultsProps {
  keyword: string;
  resultPage: KnowledgeBaseSearchPage | null;
  error: string;
  loading: boolean;
  onPageChange: (page: number) => void;
  onOpenResult: (result: KnowledgeBaseSearchResult) => void;
}

function KnowledgeDocumentViewer({
  document,
  mode,
  targetItemId,
  itemsPreview,
  markdownPreview,
  analysisSnapshot,
  viewerLoading,
  viewerTrace,
  startingMatching,
  developerMode,
  onBack,
  onModeChange,
  onStartMatching,
  onRefreshAnalysis,
}: KnowledgeDocumentViewerProps) {
  const { showToast } = useToast();
  const [sourceItem, setSourceItem] = useState<KnowledgeItem | null>(null);
  const [sourceRendering, setSourceRendering] = useState(false);
  const [sourceTrace, setSourceTrace] = useState<RenderDebugTrace | null>(null);
  const renderRequestIdRef = useRef(0);
  const sourceTraceRef = useRef<RenderDebugTrace | null>(null);
  const pendingTargetItemIdRef = useRef(targetItemId);

  useEffect(() => {
    finishRenderDebugTrace(sourceTraceRef.current, 'viewer-reset');
    sourceTraceRef.current = null;
    setSourceItem(null);
    setSourceRendering(false);
    setSourceTrace(null);
    renderRequestIdRef.current += 1;
    pendingTargetItemIdRef.current = targetItemId;
  }, [document.id, mode, targetItemId]);

  // 复用原文打开流程，保留渲染进度和开发者调试记录。
  const openSourceItem = useCallback((item: KnowledgeItem) => {
    renderRequestIdRef.current += 1;
    const requestId = renderRequestIdRef.current;
    finishRenderDebugTrace(sourceTraceRef.current, 'source-trace-replaced');
    const trace = developerMode ? createRenderDebugTrace('item-source', document, item.content || '', item) : null;
    sourceTraceRef.current = trace;

    setSourceItem(item);
    setSourceRendering(true);
    setSourceTrace(trace);
    logRenderDebug(trace, 'click:open-source');
    window.requestAnimationFrame(() => {
      if (renderRequestIdRef.current === requestId) {
        logRenderDebug(trace, 'raf:release-markdown-render');
        setSourceRendering(false);
      }
    });
  }, [developerMode, document]);

  // 搜索定位只消费一次，关闭原文后不再自动弹出。
  useEffect(() => {
    if (mode !== 'items' || viewerLoading || !pendingTargetItemIdRef.current) return;
    const item = itemsPreview.find((entry) => entry.id === pendingTargetItemIdRef.current);
    if (!item) return;
    pendingTargetItemIdRef.current = undefined;
    openSourceItem(item);
  }, [itemsPreview, mode, targetItemId, viewerLoading, openSourceItem]);

  const closeSourceItem = () => {
    renderRequestIdRef.current += 1;
    finishRenderDebugTrace(sourceTraceRef.current, 'source-view-closed');
    sourceTraceRef.current = null;
    setSourceItem(null);
    setSourceRendering(false);
    setSourceTrace(null);
  };

  const copyDebugLogs = async () => {
    const logs = window.__knowledgeRenderDebugLogs || [];
    if (!logs.length) {
      showToast('暂无渲染调试日志', 'info');
      return;
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
      showToast(`渲染调试日志已复制（${logs.length} 条）`, 'success');
    } catch (error) {
      console.warn('复制渲染调试日志失败', error);
      showToast('复制调试日志失败', 'error');
    }
  };

  return (
    <div className="page-stack knowledge-viewer-page">
      <section className="knowledge-workspace-bar knowledge-viewer-bar">
        <div className="knowledge-breadcrumb">
          <span>知识库</span>
          <strong>{document.file_name}</strong>
          {developerMode && <code className="knowledge-entity-id">文档ID：{document.id}</code>}
          <small>{mode === 'analysis' ? '分析调试' : mode === 'items' ? `${document.item_count || 0} 条知识` : 'Markdown 原文'}</small>
        </div>
        <div className="knowledge-toolbar-actions">
          <button type="button" className="secondary-action" onClick={onBack}>返回知识库</button>
          {developerMode && <button type="button" className="secondary-action" onClick={() => void copyDebugLogs()}>复制调试日志</button>}
          {developerMode && <button type="button" className={`secondary-action ${mode === 'analysis' ? 'is-active' : ''}`} onClick={() => onModeChange('analysis')}>分析调试</button>}
          <button type="button" className={`secondary-action ${mode === 'items' ? 'is-active' : ''}`} onClick={() => onModeChange('items')} disabled={document.status !== 'success'}>知识条目</button>
          <button type="button" className={`secondary-action ${mode === 'markdown' ? 'is-active' : ''}`} onClick={() => onModeChange('markdown')} disabled={!canOpenMarkdown(document)}>Markdown</button>
        </div>
      </section>

      <section className="knowledge-viewer-panel">
        {mode === 'analysis' && developerMode ? (
          <KnowledgeAnalysisView
            document={document}
            snapshot={analysisSnapshot}
            startingMatching={startingMatching}
            onStartMatching={onStartMatching}
            onRefresh={onRefreshAnalysis}
          />
        ) : mode === 'items' ? (
          viewerLoading ? (
            <div className="knowledge-empty-box">
              <strong>正在读取知识条目...</strong>
              <p>条目较多时需要稍等片刻。</p>
            </div>
          ) : (
            <DebuggableMarkdownContent
              className="knowledge-item-list knowledge-viewer-item-list"
              debugTrace={mode === 'items' ? viewerTrace : null}
              developerMode={developerMode}
              profilerId="knowledge-items-list"
            >
              {itemsPreview.length ? itemsPreview.map((item) => (
                <KnowledgeItemCard
                  key={item.id}
                  item={item}
                  developerMode={developerMode}
                  onOpenSource={() => openSourceItem(item)}
                />
              )) : <div className="knowledge-empty-box"><strong>暂无知识条目</strong><p>文档完成整理后会显示结果。</p></div>}
            </DebuggableMarkdownContent>
          )
        ) : (
          <MarkdownFullscreenViewer
            className="markdown-viewer knowledge-viewer-markdown"
            title={`${document.file_name}全屏查看`}
            fullscreenChildren={viewerLoading ? (
              <div className="knowledge-empty-box large">
                <strong>正在读取 Markdown...</strong>
                <p>原文内容较大时需要稍等片刻。</p>
              </div>
            ) : (
              <MarkdownRenderer>{markdownPreview || '暂无 Markdown 内容'}</MarkdownRenderer>
            )}
          >
            {viewerLoading ? (
              <div className="knowledge-empty-box large">
                <strong>正在读取 Markdown...</strong>
                <p>原文内容较大时需要稍等片刻。</p>
              </div>
            ) : (
              <DebuggableMarkdownContent
                className="knowledge-markdown-debug-content"
                debugTrace={mode === 'markdown' ? viewerTrace : null}
                developerMode={developerMode}
                profilerId="knowledge-document-markdown"
              >
                <MarkdownRenderer>{markdownPreview || '暂无 Markdown 内容'}</MarkdownRenderer>
              </DebuggableMarkdownContent>
            )}
          </MarkdownFullscreenViewer>
        )}
      </section>

      <Dialog.Root open={Boolean(sourceItem)} onOpenChange={(open) => !open && closeSourceItem()}>
        <Dialog.Portal>
          <Dialog.Overlay className="knowledge-source-modal" />
          {sourceItem && (
            <KnowledgeItemSourceDialog
              item={sourceItem}
              developerMode={developerMode}
              rendering={sourceRendering}
              debugTrace={sourceTrace}
              onClose={closeSourceItem}
            />
          )}
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function KnowledgeItemCard({ item, developerMode, onOpenSource }: KnowledgeItemCardProps) {
  return (
    <article className="knowledge-item-card">
      {developerMode && <code className="knowledge-entity-id">条目ID：{item.id}</code>}
      <strong>{item.title}</strong>
      <p>{item.resume}</p>
      <button type="button" className="knowledge-item-source-action" onClick={onOpenSource}>查看原文</button>
    </article>
  );
}

function KnowledgeItemSourceDialog({ item, developerMode, rendering, debugTrace, onClose }: KnowledgeItemSourceViewerProps) {
  useLayoutEffect(() => {
    if (!developerMode || !debugTrace || !rendering) return;
    logRenderDebug(debugTrace, 'loading:commit');
  }, [debugTrace, developerMode, rendering]);

  useEffect(() => {
    if (!developerMode || !debugTrace || !rendering) return undefined;
    const frameId = window.requestAnimationFrame(() => {
      logRenderDebug(debugTrace, 'loading:next-frame-visible');
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [debugTrace, developerMode, rendering]);

  return (
    <Dialog.Content className="knowledge-source-dialog-card knowledge-source-viewer">
      <div className="knowledge-source-head">
        <div>
          <span>知识条目原文</span>
          <Dialog.Title>{item.title}</Dialog.Title>
          <Dialog.Description>查看该知识条目对应的原始 Markdown 片段。</Dialog.Description>
          {developerMode && <code className="knowledge-entity-id">条目ID：{item.id}</code>}
        </div>
        <button type="button" className="secondary-action" onClick={onClose}>关闭</button>
      </div>
      {rendering ? (
        <div className="knowledge-empty-box large knowledge-source-loading">
          <InlineSpinner />
          <strong>正在渲染原文...</strong>
          <p>内容较大时需要稍等片刻。</p>
        </div>
      ) : (
        <MarkdownFullscreenViewer
          className="markdown-viewer knowledge-source-content"
          title={`${item.title}原文全屏查看`}
          fullscreenChildren={(
            <MarkdownRenderer enableGfm={false} linkMode="text" linkTextClassName="knowledge-item-link-text" imageMode="lazy">
              {item.content || '暂无原文内容'}
            </MarkdownRenderer>
          )}
        >
          <DebuggableMarkdownContent
            className="knowledge-source-debug-content"
            debugTrace={debugTrace}
            developerMode={developerMode}
            profilerId="knowledge-item-source"
          >
            <MarkdownRenderer enableGfm={false} linkMode="text" linkTextClassName="knowledge-item-link-text" imageMode="lazy">
              {item.content || '暂无原文内容'}
            </MarkdownRenderer>
          </DebuggableMarkdownContent>
        </MarkdownFullscreenViewer>
      )}
    </Dialog.Content>
  );
}

function DebuggableMarkdownContent({ children, className, debugTrace, developerMode, profilerId }: DebuggableMarkdownContentProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!developerMode || !debugTrace) return;
    logRenderDebug(debugTrace, 'dom:commit', collectDomMetrics(contentRef.current));
  });

  useEffect(() => {
    if (!developerMode || !debugTrace) return undefined;
    const frameId = window.requestAnimationFrame(() => {
      logRenderDebug(debugTrace, 'dom:next-frame-visible', collectDomMetrics(contentRef.current));
      finishRenderDebugTrace(debugTrace, 'next-frame-visible');
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [debugTrace, developerMode]);

  const content = <div ref={contentRef} className={className}>{children}</div>;
  if (!developerMode || !debugTrace) return content;

  return (
    <Profiler
      id={profilerId}
      onRender={(id, phase, actualDuration, baseDuration, startTime, commitTime) => {
        logProfilerRender(debugTrace, id, phase, actualDuration, baseDuration, startTime, commitTime);
      }}
    >
      {content}
    </Profiler>
  );
}

function KnowledgeAnalysisView({ document, snapshot, startingMatching, onStartMatching, onRefresh }: KnowledgeAnalysisViewProps) {
  const report = snapshot?.report;
  const canStart = ['ready_for_matching', 'success', 'error'].includes(document.status) && Boolean(snapshot?.candidate_items.length);

  return (
    <div className="knowledge-analysis-view">
      <div className="knowledge-analysis-command">
        <div>
          <strong>自动分段段落匹配</strong>
          <p>按模型上下文长度自动分段匹配段落，并在匹配后执行遗漏补漏。</p>
        </div>
        <button type="button" className="primary-action" onClick={onStartMatching} disabled={!canStart || startingMatching}>
          {startingMatching ? '提交中...' : document.status === 'success' ? '重新匹配' : '开始匹配'}
        </button>
        <button type="button" className="secondary-action" onClick={onRefresh}>刷新</button>
      </div>

      <div className="knowledge-analysis-stats">
        <StatCard label="有效 block" value={snapshot?.block_count ?? document.block_count ?? 0} />
        <StatCard label="筛除 block" value={snapshot?.filtered_blocks_count ?? document.filtered_block_count ?? 0} />
        <StatCard label="候选条目" value={snapshot?.candidate_items.length ?? document.candidate_item_count ?? 0} />
        <StatCard label="最终条目" value={report?.final_items_count ?? document.item_count ?? 0} />
        <StatCard label="覆盖率" value={report ? `${Math.round(report.coverage_rate * 100)}%` : '-'} />
        <StatCard label="补漏新增" value={report?.new_items_from_recovery_count ?? 0} />
        <StatCard label="Markdown 字符" value={formatInteger(snapshot?.markdown_chars)} />
        <StatCard label="保留 block 字符" value={formatInteger(snapshot?.kept_block_chars)} />
        <StatCard label="条目覆盖字符" value={formatInteger(snapshot?.covered_unique_content_chars)} />
        <StatCard label="原文真实覆盖率" value={formatPercent(snapshot?.coverage_rate_vs_markdown)} />
      </div>

      {report && (
        <div className="knowledge-analysis-report">
          <strong>处理报告</strong>
          <span>已匹配 {report.matched_blocks_count} 个 block</span>
          <span>AI 舍弃 {report.discarded_blocks_count} 个 block</span>
          <span>重试后系统舍弃 {report.system_discarded_after_retry_count} 个 block</span>
          <span>补漏轮次 {report.recovery_attempt_count}</span>
          <span>block 段数 {report.batch_size}</span>
        </div>
      )}

      {snapshot?.debug_log_path && (
        <div className="knowledge-analysis-debug-log">
          <strong>开发者日志</strong>
          <code>{snapshot.debug_log_path}</code>
        </div>
      )}

      <div className="knowledge-analysis-grid">
        <section className="knowledge-analysis-section">
          <div className="knowledge-panel-head">
            <strong>候选知识条目</strong>
            <span>{snapshot?.candidate_items.length || 0} 条</span>
          </div>
          <div className="knowledge-candidate-list">
            {snapshot?.candidate_items.length ? snapshot.candidate_items.map((item) => (
              <article className="knowledge-candidate-card" key={item.id}>
                <small>{item.id}</small>
                <strong>{item.title}</strong>
                <p>{item.summary}</p>
              </article>
            )) : <div className="knowledge-empty-box"><strong>暂无候选条目</strong><p>上传处理完成后会显示 AI 提取出的知识条目。</p></div>}
          </div>
        </section>

        <section className="knowledge-analysis-section">
          <div className="knowledge-panel-head">
            <strong>舍弃记录</strong>
            <span>{(snapshot?.discarded.length || 0) + (snapshot?.system_discarded_after_retry.length || 0)} 组</span>
          </div>
          <div className="knowledge-candidate-list">
            {snapshot && (snapshot.discarded.length || snapshot.system_discarded_after_retry.length) ? (
              [...snapshot.discarded, ...snapshot.system_discarded_after_retry].map((item, index) => (
                <article className="knowledge-candidate-card" key={`${item.reason}-${index}`}>
                  <small>{item.block_ids.length} 个 block</small>
                  <strong>{item.reason}</strong>
                  <p>{item.block_ids.join('、')}</p>
                </article>
              ))
            ) : <div className="knowledge-empty-box"><strong>暂无舍弃记录</strong><p>完成段落匹配和补漏后会显示。</p></div>}
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="knowledge-stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function KnowledgeSearchResults({ keyword, resultPage, error, loading, onPageChange, onOpenResult }: KnowledgeSearchResultsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [resultPage]);
  const results = resultPage?.items || [];
  const totalPages = resultPage ? Math.max(1, Math.ceil(resultPage.total / resultPage.pageSize)) : 1;

  return (
    <section className="knowledge-search-panel" aria-busy={loading}>
      <div className="knowledge-panel-head">
        <strong>“{keyword}”的检索结果</strong>
        <span aria-live="polite">{loading ? '正在检索' : resultPage ? `共 ${resultPage.total} 条知识` : '检索失败'}</span>
      </div>
      {resultPage ? (
        <div className="knowledge-search-result-list" ref={listRef}>
          {error && <p role="alert">检索失败，仍显示上次成功的结果。请重新检索或翻页。{error}</p>}
          {results.length ? results.map((result) => (
            <article className="knowledge-search-result-card" key={`${result.document_id}:${result.item_id}`}>
              <div className="knowledge-search-result-path">
                <span>{result.folder_name}</span>
                <span aria-hidden="true">/</span>
                <strong>{result.file_name}</strong>
              </div>
              <h3>{result.title}</h3>
              <p>{result.snippet || result.resume || '该条目暂无可显示片段'}</p>
              <button type="button" className="knowledge-item-source-action" onClick={() => onOpenResult(result)}>打开知识条目</button>
            </article>
          )) : (
            <div className="knowledge-empty-box large">
              <strong>没有找到相关知识</strong>
              <p>请更换关键字，或确认相关文档已经完成知识整理。</p>
            </div>
          )}
        </div>
      ) : (
        <div className="knowledge-empty-box large">
          {loading ? <>
            <InlineSpinner />
            <strong>正在检索全部知识库...</strong>
            <p>检索完成后会显示对应文档和知识片段。</p>
          </> : <>
            <strong>知识库检索失败</strong>
            <p role="alert">{error} 请点击“检索”重试。</p>
          </>}
        </div>
      )}
      {resultPage && resultPage.total > 0 && (
        <div className="knowledge-search-pagination">
          <span>第 {resultPage.page} / {totalPages} 页 · 当前显示 {(resultPage.page - 1) * resultPage.pageSize + 1}–{(resultPage.page - 1) * resultPage.pageSize + results.length} 条</span>
          <div>
            <button type="button" className="secondary-action" disabled={loading || resultPage.page <= 1} onClick={() => onPageChange(resultPage.page - 1)}>上一页</button>
            <button type="button" className="secondary-action" disabled={loading || resultPage.page >= totalPages} onClick={() => onPageChange(resultPage.page + 1)}>下一页</button>
          </div>
        </div>
      )}
    </section>
  );
}

export type {
  KnowledgeDocumentViewerProps,
  KnowledgeItemCardProps,
  KnowledgeItemSourceViewerProps,
  DebuggableMarkdownContentProps,
  KnowledgeAnalysisViewProps,
  KnowledgeSearchResultsProps,
};

export {
  KnowledgeDocumentViewer,
  KnowledgeItemCard,
  KnowledgeItemSourceDialog,
  DebuggableMarkdownContent,
  KnowledgeAnalysisView,
  StatCard,
  KnowledgeSearchResults,
};
