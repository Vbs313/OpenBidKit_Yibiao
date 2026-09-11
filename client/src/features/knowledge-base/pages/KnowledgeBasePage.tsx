import { Profiler, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { trackPageView } from '../../../shared/analytics/analytics';
import { AppDialog, InlineSpinner, isLibreOfficeRequiredMessage, MarkdownFullscreenViewer, MarkdownRenderer, ProgressBar, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { KnowledgeAnalysisSnapshot, KnowledgeBaseIndex, KnowledgeBaseSearchPage, KnowledgeBaseSearchResult, KnowledgeDocument, KnowledgeItem } from '../../../shared/types/domains/knowledge-base';
import {
  nowMs,
  roundMs,
  logRenderDebug,
  createRenderDebugTrace,
  updateTraceContentMetrics,
  updateTraceItemsMetrics,
  finishRenderDebugTrace,
} from '../renderProfiling';
import type {
  RenderDebugKind,
  RenderDebugTrace,
} from '../renderProfiling';
import {
  canOpenAnalysis,
  canOpenMarkdown,
  canMoveKnowledgeDocument,
  mergeDocuments,
} from '../model';
import type {
  KnowledgeViewer,
} from '../model';
import {
  KnowledgeDocumentViewer,
  KnowledgeSearchResults,
} from '../components/documentViews';


declare global {
  interface Window {
    __knowledgeRenderDebugLogs?: Array<Record<string, unknown>>;
  }
}

const emptyIndex: KnowledgeBaseIndex = { folders: [], documents: [] };
const emptyDocuments: KnowledgeDocument[] = [];
const documentRenderBatchSize = 80;

const statusLabels: Record<KnowledgeDocument['status'], string> = {
  pending: '等待处理',
  copying: '复制文件',
  converting: '转换 Markdown',
  extracting: '提取条目',
  ready_for_matching: '待匹配',
  matching: '匹配段落',
  recovering: '补漏中',
  analyzing: 'AI 整理中',
  saving: '保存结果',
  success: '完成',
  error: '失败',
};

type KnowledgeDropPosition = 'before' | 'after';
type KnowledgeDragPayload =
  | { kind: 'folder'; folderId: string }
  | { kind: 'document'; documentId: string; folderId: string };

interface KnowledgeDocumentDropTarget {
  documentId: string;
  position: KnowledgeDropPosition;
}

function KnowledgeBasePage() {
  const [index, setIndex] = useState<KnowledgeBaseIndex>(emptyIndex);
  const [activeFolderId, setActiveFolderId] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState<KnowledgeViewer | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerTrace, setViewerTrace] = useState<RenderDebugTrace | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState('');
  const [itemsPreview, setItemsPreview] = useState<KnowledgeItem[]>([]);
  const [analysisSnapshot, setAnalysisSnapshot] = useState<KnowledgeAnalysisSnapshot | null>(null);
  const [startingMatching, setStartingMatching] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [retryingDocumentIds, setRetryingDocumentIds] = useState<Set<string>>(() => new Set());
  const [visibleDocumentCount, setVisibleDocumentCount] = useState(documentRenderBatchSize);
  const [dragPayload, setDragPayload] = useState<KnowledgeDragPayload | null>(null);
  const [folderDropTargetId, setFolderDropTargetId] = useState<string | null>(null);
  const [documentDropTarget, setDocumentDropTarget] = useState<KnowledgeDocumentDropTarget | null>(null);
  const [dragSaving, setDragSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { type: 'folder'; folderId: string; folderName: string; count: number }
    | { type: 'document'; document: KnowledgeDocument }
    | null
  >(null);
  const [deletingConfirm, setDeletingConfirm] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [submittedSearchKeyword, setSubmittedSearchKeyword] = useState('');
  const [searchPage, setSearchPage] = useState<KnowledgeBaseSearchPage | null>(null);
  const [searchError, setSearchError] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const searchRequestIdRef = useRef(0);
  const autoMatchingIdsRef = useRef(new Set<string>());
  const documentParseNoticeIdsRef = useRef(new Set<string>());
  const viewerRequestIdRef = useRef(0);
  const viewerTraceRef = useRef<RenderDebugTrace | null>(null);
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();

  const activeFolder = index.folders.find((folder) => folder.id === activeFolderId) || index.folders[0];
  const documentsByFolder = useMemo(() => {
    const grouped = new Map<string, KnowledgeDocument[]>();
    index.documents.forEach((document) => {
      const folderDocuments = grouped.get(document.folder_id);
      if (folderDocuments) {
        folderDocuments.push(document);
        return;
      }
      grouped.set(document.folder_id, [document]);
    });
    return grouped;
  }, [index.documents]);
  const documents = activeFolder ? documentsByFolder.get(activeFolder.id) || emptyDocuments : emptyDocuments;
  const visibleDocuments = documents.slice(0, Math.min(visibleDocumentCount, documents.length));

  useEffect(() => {
    trackPageView(viewer ? `knowledge-base/viewer/${viewer.mode}` : 'knowledge-base/library');
  }, [viewer?.mode]);

  useEffect(() => {
    void loadInitialData();
    window.addEventListener('focus', loadDeveloperMode);
    document.addEventListener('visibilitychange', loadDeveloperMode);
    const unsubscribe = window.yibiao?.knowledgeBase.onEvent(({ document }) => {
      const parseMessage = document.error || document.message;
      if (document.status === 'error'
        && isLibreOfficeRequiredMessage(parseMessage)
        && !documentParseNoticeIdsRef.current.has(document.id)) {
        documentParseNoticeIdsRef.current.add(document.id);
        showDocumentParseNotice(parseMessage);
      }
      setIndex((prev) => ({
        ...prev,
        documents: prev.documents.some((item) => item.id === document.id)
          ? prev.documents.map((item) => (item.id === document.id ? document : item))
          : [...prev.documents, document],
      }));
      setViewer((prev) => (prev?.document.id === document.id ? { ...prev, document } : prev));
      setAnalysisSnapshot((prev) => (prev?.document.id === document.id ? { ...prev, document } : prev));
    });
    return () => {
      window.removeEventListener('focus', loadDeveloperMode);
      document.removeEventListener('visibilitychange', loadDeveloperMode);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    setVisibleDocumentCount(documentRenderBatchSize);
  }, [activeFolder?.id, documents.length]);

  useEffect(() => {
    if (visibleDocumentCount >= documents.length) return undefined;
    const timeoutId = window.setTimeout(() => {
      startTransition(() => {
        setVisibleDocumentCount((count) => Math.min(count + documentRenderBatchSize, documents.length));
      });
    }, 24);
    return () => window.clearTimeout(timeoutId);
  }, [documents.length, visibleDocumentCount]);

  useEffect(() => {
    if (developerMode) return;
    const pendingDocuments = index.documents.filter((document) => document.status === 'ready_for_matching' && !autoMatchingIdsRef.current.has(document.id));
    pendingDocuments.forEach((document) => {
      autoMatchingIdsRef.current.add(document.id);
      void startMatching(document, { silent: true });
    });
  }, [developerMode, index.documents]);

  useEffect(() => {
    if (!developerMode && viewer?.mode === 'analysis') {
      viewerRequestIdRef.current += 1;
      setViewer(null);
      setViewerLoading(false);
      setAnalysisSnapshot(null);
    }
  }, [developerMode, viewer?.mode]);

  useEffect(() => {
    if ((!activeFolderId || !index.folders.some((folder) => folder.id === activeFolderId)) && index.folders[0]) {
      setActiveFolderId(index.folders[0].id);
    }
  }, [activeFolderId, index.folders]);

  useEffect(() => {
    if (viewer?.mode === 'analysis') {
      void loadAnalysis(viewer.document.id, { silent: true });
    }
  }, [viewer?.document.id, viewer?.document.status, viewer?.mode]);

  const loadInitialData = async () => {
    try {
      setListLoading(true);
      const config = await window.yibiao?.config.load();
      setDeveloperMode(Boolean(config?.developer_mode));
      const data = await window.yibiao?.knowledgeBase.list();
      if (data) {
        setIndex(data);
        setActiveFolderId((currentId) => (
          data.folders.some((folder) => folder.id === currentId) ? currentId : data.folders[0]?.id || ''
        ));
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取知识库失败', 'error');
    } finally {
      setLoading(false);
      setListLoading(false);
    }
  };

  const applyKnowledgeIndex = (data: KnowledgeBaseIndex) => {
    setIndex(data);
    setActiveFolderId((currentId) => (
      data.folders.some((folder) => folder.id === currentId) ? currentId : data.folders[0]?.id || ''
    ));
  };

  const clearDragState = () => {
    setDragPayload(null);
    setFolderDropTargetId(null);
    setDocumentDropTarget(null);
  };

  const getDropPosition = (event: DragEvent<HTMLElement>): KnowledgeDropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  const startFolderDrag = (event: DragEvent<HTMLElement>, folderId: string) => {
    if (dragSaving) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `folder:${folderId}`);
    setDragPayload({ kind: 'folder', folderId });
  };

  const startDocumentDrag = (event: DragEvent<HTMLElement>, document: KnowledgeDocument) => {
    if (dragSaving || !canMoveKnowledgeDocument(document)) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `document:${document.id}`);
    setDragPayload({ kind: 'document', documentId: document.id, folderId: document.folder_id });
  };

  const handleFolderDragOver = (event: DragEvent<HTMLElement>, folderId: string) => {
    if (!dragPayload || dragSaving) return;
    if (dragPayload.kind === 'folder' && dragPayload.folderId === folderId) return;
    if (dragPayload.kind === 'document' && dragPayload.folderId === folderId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setFolderDropTargetId(folderId);
    setDocumentDropTarget(null);
  };

  const handleFolderDrop = async (event: DragEvent<HTMLElement>, folderId: string) => {
    if (!dragPayload || dragSaving) return;
    event.preventDefault();
    const payload = dragPayload;
    const position = getDropPosition(event);
    setDragSaving(true);
    try {
      const result = payload.kind === 'folder'
        ? await window.yibiao?.knowledgeBase.reorderFolder(payload.folderId, folderId, position)
        : await window.yibiao?.knowledgeBase.moveDocument(payload.documentId, folderId, null, 'after');
      if (!result?.success) {
        throw new Error(result?.message || '拖拽操作失败');
      }
      const data = await window.yibiao?.knowledgeBase.list();
      if (!data) throw new Error('拖拽操作已保存，但读取知识库列表失败');
      applyKnowledgeIndex(data);
      showToast(result.message, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '拖拽操作失败', 'error');
    } finally {
      setDragSaving(false);
      clearDragState();
    }
  };

  const handleDocumentDragOver = (event: DragEvent<HTMLElement>, document: KnowledgeDocument) => {
    if (!dragPayload || dragPayload.kind !== 'document' || dragSaving || dragPayload.documentId === document.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setFolderDropTargetId(null);
    setDocumentDropTarget({ documentId: document.id, position: getDropPosition(event) });
  };

  const handleDocumentDrop = async (event: DragEvent<HTMLElement>, document: KnowledgeDocument) => {
    if (!dragPayload || dragPayload.kind !== 'document' || dragSaving || dragPayload.documentId === document.id) return;
    event.preventDefault();
    const position = getDropPosition(event);
    setDragSaving(true);
    try {
      const result = await window.yibiao?.knowledgeBase.moveDocument(dragPayload.documentId, document.folder_id, document.id, position);
      if (!result?.success) {
        throw new Error(result?.message || '文档排序失败');
      }
      const data = await window.yibiao?.knowledgeBase.list();
      if (!data) throw new Error('文档排序已保存，但读取知识库列表失败');
      applyKnowledgeIndex(data);
      setActiveFolderId(document.folder_id);
      showToast(result.message, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '文档排序失败', 'error');
    } finally {
      setDragSaving(false);
      clearDragState();
    }
  };

  const loadDeveloperMode = async () => {
    try {
      const config = await window.yibiao?.config.load();
      setDeveloperMode(Boolean(config?.developer_mode));
    } catch (error) {
      console.warn('读取开发者模式失败', error);
      setDeveloperMode(false);
    }
  };

  const loadAnalysis = async (documentId: string, options?: { silent?: boolean }) => {
    try {
      const data = await window.yibiao?.knowledgeBase.readAnalysis(documentId);
      if (data) setAnalysisSnapshot(data);
    } catch (error) {
      if (!options?.silent) {
        showToast(error instanceof Error ? error.message : '读取分析结果失败', 'error');
      }
    }
  };

  const fetchGlobalSearch = async (keyword: string, page: number) => {
    const requestId = ++searchRequestIdRef.current;
    setSearchError('');
    setSearchLoading(true);
    try {
      const result = await window.yibiao.knowledgeBase.search({ keyword, page });
      if (searchRequestIdRef.current !== requestId) return;
      setSearchPage(result);
    } catch (error) {
      if (searchRequestIdRef.current === requestId) {
        const message = error instanceof Error ? error.message : '知识库检索失败';
        setSearchError(message);
        showToast(message, 'error');
      }
    } finally {
      if (searchRequestIdRef.current === requestId) setSearchLoading(false);
    }
  };

  const runGlobalSearch = async () => {
    const keyword = searchKeyword.trim();
    if (!keyword) {
      clearGlobalSearch();
      return;
    }
    setSubmittedSearchKeyword(keyword);
    setSearchPage(null);
    await fetchGlobalSearch(keyword, 1);
  };

  const clearGlobalSearch = () => {
    searchRequestIdRef.current += 1;
    setSearchKeyword('');
    setSubmittedSearchKeyword('');
    setSearchPage(null);
    setSearchError('');
    setSearchLoading(false);
  };

  const openSearchResult = async (result: KnowledgeBaseSearchResult) => {
    const document = index.documents.find((item) => item.id === result.document_id);
    if (!document) {
      showToast('对应知识文档已不存在，请重新检索', 'info');
      return;
    }
    setActiveFolderId(result.folder_id);
    await openDocument(document, 'items', result.item_id);
  };


  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      showToast('请输入文件夹名称', 'info');
      return;
    }

    try {
      setCreatingFolder(true);
      const folder = await window.yibiao?.knowledgeBase.createFolder(name.trim());
      if (!folder) return;
      setIndex((prev) => ({ ...prev, folders: [...prev.folders, folder] }));
      setActiveFolderId(folder.id);
      setNewFolderName('');
      setShowCreateFolder(false);
      showToast('文件夹已创建', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '创建文件夹失败', 'error');
    } finally {
      setCreatingFolder(false);
    }
  };

  const uploadDocuments = async () => {
    if (!activeFolder) {
      showToast('请先创建文件夹', 'info');
      return;
    }

    try {
      setLoading(true);
      const result = await window.yibiao?.knowledgeBase.uploadDocuments(activeFolder.id);
      if (!result?.success) {
        const message = result?.message || '未选择文档';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, 'info');
        return;
      }
      if (result.documents?.length) {
        setIndex((prev) => ({ ...prev, documents: mergeDocuments(prev.documents, result.documents || []) }));
      }
      showToast(result.message, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传文档失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const renameFolder = async (folderId: string, currentName: string) => {
    const name = window.prompt('请输入新的文件夹名称', currentName)?.trim();
    if (!name || name === currentName) return;

    try {
      const folder = await window.yibiao?.knowledgeBase.renameFolder(folderId, name);
      if (!folder) return;
      setIndex((prev) => ({
        ...prev,
        folders: prev.folders.map((item) => (item.id === folder.id ? folder : item)),
      }));
      showToast('文件夹已重命名', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重命名文件夹失败', 'error');
    }
  };

  const deleteFolder = (folderId: string, folderName: string) => {
    const count = documentsByFolder.get(folderId)?.length || 0;
    setDeleteConfirm({ type: 'folder', folderId, folderName, count });
  };

  const deleteDocument = (document: KnowledgeDocument) => {
    setDeleteConfirm({ type: 'document', document });
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    setDeletingConfirm(true);
    try {
      if (deleteConfirm.type === 'folder') {
        const { folderId } = deleteConfirm;
        const result = await window.yibiao?.knowledgeBase.deleteFolder(folderId);
        const folders = index.folders.filter((item) => item.id !== folderId);
        const documents = index.documents.filter((document) => document.folder_id !== folderId);
        setIndex({ folders, documents });
        if (activeFolderId === folderId) {
          setActiveFolderId(folders[0]?.id || '');
        }
        setViewer((prev) => (prev?.document.folder_id === folderId ? null : prev));
        showToast(result?.message || '文件夹已删除', 'success');
      } else {
        const { document } = deleteConfirm;
        const result = await window.yibiao?.knowledgeBase.deleteDocument(document.id);
        setIndex((prev) => ({ ...prev, documents: prev.documents.filter((item) => item.id !== document.id) }));
        setViewer((prev) => (prev?.document.id === document.id ? null : prev));
        showToast(result?.message || '文档已删除', 'success');
      }
      setDeleteConfirm(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : deleteConfirm.type === 'folder' ? '删除文件夹失败' : '删除文档失败', 'error');
    } finally {
      setDeletingConfirm(false);
    }
  };

  const retryDocument = async (document: KnowledgeDocument) => {
    setRetryingDocumentIds((prev) => new Set(prev).add(document.id));
    try {
      const result = await window.yibiao?.knowledgeBase.retryDocument(document.id);
      if (result?.document) {
        const updatedDocument = result.document;
        setIndex((prev) => ({ ...prev, documents: mergeDocuments(prev.documents, [updatedDocument]) }));
        setViewer((prev) => (prev?.document.id === updatedDocument.id ? { ...prev, document: updatedDocument } : prev));
        setAnalysisSnapshot((prev) => (prev?.document.id === updatedDocument.id ? { ...prev, document: updatedDocument } : prev));
      }
      if (!result?.success) {
        const message = result?.message || '重试失败';
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, 'info');
        return;
      }
      showToast(result.message || '已重新开始解析', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : '重试失败';
      if (isLibreOfficeRequiredMessage(message)) {
        showDocumentParseNotice(message);
        return;
      }
      showToast(message, 'error');
    } finally {
      setRetryingDocumentIds((prev) => {
        const next = new Set(prev);
        next.delete(document.id);
        return next;
      });
    }
  };

  const finishActiveViewerTrace = (reason: string, payload: Record<string, unknown> = {}) => {
    finishRenderDebugTrace(viewerTraceRef.current, reason, payload);
    viewerTraceRef.current = null;
    setViewerTrace(null);
  };

  const createViewerTrace = (document: KnowledgeDocument, mode: KnowledgeViewer['mode'], requestId: number) => {
    finishActiveViewerTrace('viewer-trace-replaced', { nextMode: mode, requestId });
    if (!developerMode || mode === 'analysis') {
      return null;
    }

    const kind: RenderDebugKind = mode === 'markdown' ? 'document-markdown' : 'document-items';
    const trace = createRenderDebugTrace(kind, document, '');
    viewerTraceRef.current = trace;
    setViewerTrace(trace);
    logRenderDebug(trace, 'click:open-document', {
      mode,
      requestId,
      status: document.status,
      itemCount: document.item_count || 0,
      blockCount: document.block_count || 0,
      filteredBlockCount: document.filtered_block_count || 0,
      candidateItemCount: document.candidate_item_count || 0,
    });
    return trace;
  };

  // 打开文档，可指定首次自动查看原文的知识条目。
  const openDocument = async (document: KnowledgeDocument, mode: KnowledgeViewer['mode'], targetItemId?: string) => {
    if (mode === 'analysis' && !developerMode) {
      return;
    }
    const requestId = viewerRequestIdRef.current + 1;
    viewerRequestIdRef.current = requestId;
    const trace = createViewerTrace(document, mode, requestId);
    setViewerLoading(mode !== 'analysis');
    logRenderDebug(trace, 'state:loading-start', { loading: mode !== 'analysis' });
    startTransition(() => {
      setViewer({ document, mode, targetItemId });
      setMarkdownPreview('');
      setItemsPreview([]);
      if (mode === 'analysis') {
        setAnalysisSnapshot(null);
      }
    });
    logRenderDebug(trace, 'state:viewer-transition-scheduled', { mode });
    if (mode === 'analysis') {
      await loadAnalysis(document.id);
      return;
    }

    try {
      if (mode === 'markdown') {
        const readStartedAt = nowMs();
        logRenderDebug(trace, 'ipc:read:start', { api: 'knowledgeBase.readMarkdown', requestId });
        const markdown = await window.yibiao?.knowledgeBase.readMarkdown(document.id);
        const content = markdown || '';
        logRenderDebug(trace, 'ipc:read:end', {
          api: 'knowledgeBase.readMarkdown',
          requestId,
          readMs: roundMs(nowMs() - readStartedAt),
          contentLength: content.length,
        });
        if (viewerRequestIdRef.current !== requestId) {
          finishRenderDebugTrace(trace, 'stale-read-result', { requestId, latestRequestId: viewerRequestIdRef.current });
          return;
        }
        updateTraceContentMetrics(trace, content);
        if (viewerRequestIdRef.current === requestId) {
          logRenderDebug(trace, 'state:set-markdown-preview', { contentLength: content.length });
          setMarkdownPreview(content);
        }
      } else {
        const readStartedAt = nowMs();
        logRenderDebug(trace, 'ipc:read:start', { api: 'knowledgeBase.readItems', requestId });
        const items = await window.yibiao?.knowledgeBase.readItems(document.id);
        const nextItems = items || [];
        logRenderDebug(trace, 'ipc:read:end', {
          api: 'knowledgeBase.readItems',
          requestId,
          readMs: roundMs(nowMs() - readStartedAt),
          itemCount: nextItems.length,
        });
        if (viewerRequestIdRef.current !== requestId) {
          finishRenderDebugTrace(trace, 'stale-read-result', { requestId, latestRequestId: viewerRequestIdRef.current });
          return;
        }
        updateTraceItemsMetrics(trace, nextItems);
        if (targetItemId && !nextItems.some((item) => item.id === targetItemId)) {
          showToast('对应知识条目已不存在，请重新检索', 'info');
          closeViewer();
          return;
        }
        if (viewerRequestIdRef.current === requestId) {
          logRenderDebug(trace, 'state:set-items-preview', { itemCount: nextItems.length });
          setItemsPreview(nextItems);
        }
      }
    } catch (error) {
      if (viewerRequestIdRef.current === requestId) {
        logRenderDebug(trace, 'ipc:read:error', { message: error instanceof Error ? error.message : String(error) });
        finishRenderDebugTrace(trace, 'read-error');
        showToast(error instanceof Error ? error.message : '读取文档结果失败', 'error');
      }
    } finally {
      if (viewerRequestIdRef.current === requestId) {
        setViewerLoading(false);
        logRenderDebug(trace, 'state:loading-false');
      }
    }
  };

  const closeViewer = () => {
    viewerRequestIdRef.current += 1;
    finishActiveViewerTrace('viewer-closed');
    startTransition(() => {
      setViewer(null);
      setViewerLoading(false);
      setViewerTrace(null);
      setItemsPreview([]);
      setMarkdownPreview('');
      setAnalysisSnapshot(null);
    });
  };

  const startMatching = async (targetDocument = viewer?.document, options?: { silent?: boolean }) => {
    if (!targetDocument) return;
    try {
      setStartingMatching(true);
      const result = await window.yibiao?.knowledgeBase.startMatching(targetDocument.id);
      if (!options?.silent) {
        showToast(result?.message || '已提交匹配任务', result?.success ? 'success' : 'info');
      }
      if (developerMode) {
        await loadAnalysis(targetDocument.id, { silent: true });
      }
    } catch (error) {
      if (!options?.silent) {
        showToast(error instanceof Error ? error.message : '启动段落匹配失败', 'error');
      }
    } finally {
      setStartingMatching(false);
    }
  };

  if (viewer) {
    return (
      <>
        <KnowledgeDocumentViewer
          document={viewer.document}
          mode={viewer.mode}
          targetItemId={viewer.targetItemId}
          itemsPreview={itemsPreview}
          markdownPreview={markdownPreview}
          analysisSnapshot={analysisSnapshot}
          viewerLoading={viewerLoading}
          viewerTrace={viewerTrace}
          startingMatching={startingMatching}
          developerMode={developerMode}
          onBack={closeViewer}
          onModeChange={(mode) => void openDocument(viewer.document, mode)}
          onStartMatching={() => void startMatching()}
          onRefreshAnalysis={() => void loadAnalysis(viewer.document.id)}
        />
      </>
    );
  }

  return (
    <>
      <div className="page-stack knowledge-page">
        <section className="knowledge-workspace-bar">
        <div className="knowledge-breadcrumb">
          <span>知识库</span>
          <strong>{activeFolder?.name || '未选择文件夹'}</strong>
          <small>{index.folders.length} 个文件夹 / {index.documents.length} 个文档</small>
        </div>
        <div className="knowledge-toolbar-actions">
          <button type="button" className="secondary-action" onClick={() => setShowCreateFolder((value) => !value)} disabled={listLoading}>新建文件夹</button>
          <button type="button" className="primary-action" onClick={uploadDocuments} disabled={loading || !activeFolder}>
            {loading ? '处理中...' : '上传文档'}
          </button>
        </div>
      </section>

      <form
        className="knowledge-global-search"
        onSubmit={(event) => {
          event.preventDefault();
          void runGlobalSearch();
        }}
      >
        <label htmlFor="knowledge-global-search-input">全库检索</label>
        <div className="knowledge-global-search-controls">
          <input
            id="knowledge-global-search-input"
            value={searchKeyword}
            onChange={(event) => setSearchKeyword(event.target.value)}
            placeholder="输入知识关键字，检索所有已完成文档"
          />
          <button type="submit" className="primary-action" disabled={searchLoading || !searchKeyword.trim()}>
            {searchLoading ? '检索中...' : '检索'}
          </button>
          {submittedSearchKeyword && <button type="button" className="secondary-action" onClick={clearGlobalSearch}>返回文件夹</button>}
        </div>
      </form>

      {showCreateFolder && (
        <form
          className="knowledge-create-folder-bar"
          onSubmit={(event) => {
            event.preventDefault();
            void createFolder();
          }}
        >
          <input
            autoFocus
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            placeholder="输入文件夹名称"
          />
          <button type="submit" className="primary-action" disabled={creatingFolder}>{creatingFolder ? '创建中...' : '创建'}</button>
          <button
            type="button"
            className="secondary-action"
            onClick={() => {
              setNewFolderName('');
              setShowCreateFolder(false);
            }}
          >
            取消
          </button>
        </form>
      )}

      {submittedSearchKeyword && (
        <KnowledgeSearchResults
          keyword={submittedSearchKeyword}
          resultPage={searchPage}
          error={searchError}
          onPageChange={(page) => { void fetchGlobalSearch(submittedSearchKeyword, page); }}
          loading={searchLoading}
          onOpenResult={(result) => { void openSearchResult(result); }}
        />
      )}

      {!submittedSearchKeyword && <section className="knowledge-layout">
        <aside className="knowledge-folder-panel">
          <div className="knowledge-panel-head">
            <strong>文件夹</strong>
            <span>{index.folders.length} 个</span>
          </div>
          {listLoading ? (
            <div className="knowledge-empty-box">
              <strong>正在读取知识库...</strong>
              <p>请稍候，正在加载文件夹和文档列表。</p>
            </div>
          ) : index.folders.length ? (
            <div className="knowledge-folder-list">
              {index.folders.map((folder) => {
                const count = documentsByFolder.get(folder.id)?.length || 0;
                const dragging = dragPayload?.kind === 'folder' && dragPayload.folderId === folder.id;
                const dropTarget = folderDropTargetId === folder.id;
                return (
                  <article
                    key={folder.id}
                    className={`knowledge-folder-card ${folder.id === activeFolder?.id ? 'is-active' : ''}${dragging ? ' is-dragging' : ''}${dropTarget ? ' is-drop-target' : ''}`}
                    onDragOver={(event) => handleFolderDragOver(event, folder.id)}
                    onDrop={(event) => { void handleFolderDrop(event, folder.id); }}
                  >
                    <div className="knowledge-folder-row">
                      <span
                        className="knowledge-drag-handle"
                        draggable={!dragSaving}
                        onDragStart={(event) => startFolderDrag(event, folder.id)}
                        onDragEnd={clearDragState}
                        title="拖拽排序"
                        aria-hidden="true"
                      >⋮⋮</span>
                      <button type="button" className="knowledge-folder-main" onClick={() => startTransition(() => setActiveFolderId(folder.id))}>
                        <span aria-hidden="true">F</span>
                        <strong>{folder.name}</strong>
                        <small>{dropTarget && dragPayload?.kind === 'document' ? '松开移动到此文件夹' : `${count} 个文档`}</small>
                      </button>
                    </div>
                    <div className="knowledge-folder-actions">
                      <button type="button" onClick={() => void renameFolder(folder.id, folder.name)}>重命名</button>
                      <button type="button" className="is-danger" onClick={() => void deleteFolder(folder.id, folder.name)}>删除</button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="knowledge-empty-box">
              <strong>还没有文件夹</strong>
              <p>先创建一个文件夹，再上传历史资料。</p>
              <button type="button" className="primary-action" onClick={() => setShowCreateFolder(true)}>新建文件夹</button>
            </div>
          )}
        </aside>

        <main className="knowledge-document-panel">
          <div className="knowledge-panel-head">
            <strong>{activeFolder?.name || '未选择文件夹'}</strong>
            <span>{documents.length} 个文档</span>
          </div>

          {listLoading ? (
            <div className="knowledge-empty-box large">
              <strong>正在读取知识库...</strong>
              <p>文档列表加载完成后会自动显示。</p>
            </div>
          ) : documents.length ? (
            <div className="knowledge-document-list">
              {visibleDocuments.map((document) => {
                const retrying = retryingDocumentIds.has(document.id);
                const canDragDocument = canMoveKnowledgeDocument(document) && !dragSaving;
                const dragging = dragPayload?.kind === 'document' && dragPayload.documentId === document.id;
                const dropTarget = documentDropTarget?.documentId === document.id ? ` is-drop-${documentDropTarget.position}` : '';
                return (
                  <article
                    className={`knowledge-document-card${dragging ? ' is-dragging' : ''}${dropTarget}`}
                    key={document.id}
                    onDragOver={(event) => handleDocumentDragOver(event, document)}
                    onDrop={(event) => { void handleDocumentDrop(event, document); }}
                  >
                    <div className="knowledge-document-title">
                      <div className="knowledge-document-title-main">
                        <span
                          className="knowledge-drag-handle"
                          draggable={canDragDocument}
                          onDragStart={(event) => startDocumentDrag(event, document)}
                          onDragEnd={clearDragState}
                          title={canDragDocument ? '拖拽排序或移动到文件夹' : '处理中，暂不可拖动'}
                          aria-hidden="true"
                        >⋮⋮</span>
                        <div className="knowledge-document-name">
                          <strong>{document.file_name}</strong>
                          {developerMode && <code className="knowledge-entity-id">文档ID：{document.id}</code>}
                        </div>
                      </div>
                      <span className={`knowledge-status is-${document.status}`}>{statusLabels[document.status]}</span>
                    </div>
                    <ProgressBar value={document.progress || 0} label={`处理进度 ${document.progress}%`} />
                    <div className="knowledge-document-meta">
                      <span>{document.message}</span>
                      <span>{document.item_count || 0} 条知识</span>
                      <span>{document.candidate_item_count || 0} 个候选</span>
                      <span>{document.block_count || 0} 个 block</span>
                    </div>
                    <div className="knowledge-document-actions">
                      {developerMode && <button type="button" onClick={() => void openDocument(document, 'analysis')} disabled={!canOpenAnalysis(document)}>分析调试</button>}
                      <button type="button" onClick={() => void openDocument(document, 'items')} disabled={document.status !== 'success'}>查看条目</button>
                      <button type="button" onClick={() => void openDocument(document, 'markdown')} disabled={!canOpenMarkdown(document)}>查看 Markdown</button>
                      {document.status === 'error' && (
                        <button type="button" className="is-retry" onClick={() => void retryDocument(document)} disabled={retrying}>
                          {retrying ? '重试中...' : '重试'}
                        </button>
                      )}
                      <button type="button" className="is-danger" onClick={() => void deleteDocument(document)}>删除</button>
                    </div>
                  </article>
                );
              })}
              {visibleDocuments.length < documents.length && (
                <div className="knowledge-empty-box">
                  <strong>正在加载更多文档...</strong>
                  <p>已显示 {visibleDocuments.length} / {documents.length} 个文档。</p>
                </div>
              )}
            </div>
          ) : (
            <div className="knowledge-empty-box large">
              <strong>当前文件夹暂无文档</strong>
              <p>支持上传 .doc、.docx、.wps、.pdf、.md、.xls、.xlsx 文档。</p>
              <button type="button" className="primary-action" onClick={uploadDocuments} disabled={loading || !activeFolder}>
                {loading ? '处理中...' : '上传文档'}
              </button>
            </div>
          )}
        </main>
        </section>}
      </div>

      <AppDialog
        open={Boolean(deleteConfirm)}
        onOpenChange={(open) => !open && !deletingConfirm && setDeleteConfirm(null)}
        kicker="知识库"
        title={deleteConfirm?.type === 'folder' ? `确定删除文件夹“${deleteConfirm.folderName}”吗？` : `确定删除文档“${deleteConfirm?.type === 'document' ? deleteConfirm.document.file_name : ''}”吗？`}
        description={deleteConfirm?.type === 'folder' ? `其中 ${deleteConfirm.count} 个文档也会一起删除，删除后不可恢复。` : '删除后不可恢复。'}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setDeleteConfirm(null)} disabled={deletingConfirm}>取消</button>
            <button type="button" className="danger-action" onClick={() => { void confirmDelete(); }} disabled={deletingConfirm}>
              {deletingConfirm ? '正在删除...' : '确认删除'}
            </button>
          </>
        )}
      />
    </>
  );
}

export default KnowledgeBasePage;

