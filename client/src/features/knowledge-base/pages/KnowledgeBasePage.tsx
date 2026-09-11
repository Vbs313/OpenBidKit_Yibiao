import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { trackPageView } from '../../../shared/analytics/analytics';
import { AppDialog, isLibreOfficeRequiredMessage, ProgressBar, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { KnowledgeBaseIndex, KnowledgeDocument } from '../../../shared/types/domains/knowledge-base';
import {
  canOpenAnalysis,
  canOpenMarkdown,
  canMoveKnowledgeDocument,
} from '../model';
import { useKnowledgeDragDrop } from '../hooks/useKnowledgeDragDrop';
import { useKnowledgeSearch } from '../hooks/useKnowledgeSearch';
import { useKnowledgeDocumentActions } from '../hooks/useKnowledgeDocumentActions';
import { useKnowledgeViewer } from '../hooks/useKnowledgeViewer';
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


function KnowledgeBasePage() {
  const [index, setIndex] = useState<KnowledgeBaseIndex>(emptyIndex);
  const [activeFolderId, setActiveFolderId] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [startingMatching, setStartingMatching] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);

  const {
    viewer,
    setViewer,
    viewerLoading,
    viewerTrace,
    markdownPreview,
    itemsPreview,
    analysisSnapshot,
    setAnalysisSnapshot,
    openDocument,
    closeViewer,
    loadAnalysis,
    syncDocument,
  } = useKnowledgeViewer({ developerMode });
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [visibleDocumentCount, setVisibleDocumentCount] = useState(documentRenderBatchSize);
  const autoMatchingIdsRef = useRef(new Set<string>());
  const documentParseNoticeIdsRef = useRef(new Set<string>());
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
      syncDocument(document);
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
    if ((!activeFolderId || !index.folders.some((folder) => folder.id === activeFolderId)) && index.folders[0]) {
      setActiveFolderId(index.folders[0].id);
    }
  }, [activeFolderId, index.folders]);


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

  const {
    dragPayload,
    folderDropTargetId,
    documentDropTarget,
    dragSaving,
    clearDragState,
    startFolderDrag,
    startDocumentDrag,
    handleFolderDragOver,
    handleFolderDrop,
    handleDocumentDragOver,
    handleDocumentDrop,
  } = useKnowledgeDragDrop({
    applyKnowledgeIndex,
    setActiveFolderId,
  });









  const loadDeveloperMode = async () => {
    try {
      const config = await window.yibiao?.config.load();
      setDeveloperMode(Boolean(config?.developer_mode));
    } catch (error) {
      console.warn('读取开发者模式失败', error);
      setDeveloperMode(false);
    }
  };















  const {
    newFolderName,
    setNewFolderName,
    creatingFolder,
    retryingDocumentIds,
    deleteConfirm,
    setDeleteConfirm,
    deletingConfirm,
    createFolder,
    uploadDocuments,
    renameFolder,
    deleteFolder,
    deleteDocument,
    confirmDelete,
    retryDocument,
  } = useKnowledgeDocumentActions({
    index,
    setIndex,
    activeFolder,
    documentsByFolder,
    activeFolderId,
    setActiveFolderId,
    setShowCreateFolder,
    setLoading,
    setViewer,
    setAnalysisSnapshot,
  });

  const {
    fetchGlobalSearch,
    searchKeyword,
    setSearchKeyword,
    submittedSearchKeyword,
    searchPage,
    searchError,
    searchLoading,
    runGlobalSearch,
    clearGlobalSearch,
    openSearchResult,
  } = useKnowledgeSearch({
    index,
    setActiveFolderId,
    openDocument,
  });


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
