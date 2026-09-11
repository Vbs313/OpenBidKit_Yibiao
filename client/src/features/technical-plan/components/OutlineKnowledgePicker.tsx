// 知识库选择器面板：搜索 + 文件夹浏览 + 已选清单。
//
// 原本是 OutlineEditPage 里的 renderKnowledgePicker（108 行）。JSX 逐字搬移，
// 唯一的结构差异是：筛选结果不再内联计算，改为消费 knowledgePickerModel 的视图模型。

import type { KnowledgeDocument } from '../../../shared/types/domains/knowledge-base';
import type { KnowledgePickerViewModel } from '../knowledgePickerModel';

export interface OutlineKnowledgePickerProps {
  loadingKnowledge: boolean;
  viewModel: KnowledgePickerViewModel;
  knowledgeSearch: string;
  setKnowledgeSearch: (value: string) => void;
  knowledgePickingDisabled: boolean;
  expandedKnowledgeFolderIds: Set<string>;
  draftKnowledgeDocumentIds: string[];
  toggleKnowledgeFolder: (folderId: string) => void;
  toggleDraftKnowledgeDocument: (document: KnowledgeDocument) => void;
  selectFolderDocuments: (documents: KnowledgeDocument[]) => void;
  clearFolderDocuments: (documents: KnowledgeDocument[]) => void;
  removeDraftKnowledgeDocument: (documentId: string) => void;
  clearDraftKnowledgeDocuments: () => void;
}

export function OutlineKnowledgePicker({
  loadingKnowledge,
  viewModel,
  knowledgeSearch,
  setKnowledgeSearch,
  knowledgePickingDisabled,
  expandedKnowledgeFolderIds,
  draftKnowledgeDocumentIds,
  toggleKnowledgeFolder,
  toggleDraftKnowledgeDocument,
  selectFolderDocuments,
  clearFolderDocuments,
  removeDraftKnowledgeDocument,
  clearDraftKnowledgeDocuments,
}: OutlineKnowledgePickerProps) {

    if (loadingKnowledge) {
      return <div className="outline-knowledge-empty">正在读取知识库...</div>;
    }

    const { keyword, availableDocuments, selectedDocuments, visibleFolders, visibleDocumentCount } = viewModel;

    if (!availableDocuments.length) {
      return <div className="outline-knowledge-empty">暂无已完成的知识库文档，可先到知识库上传并处理完成后再选择。</div>;
    }

    return (
      <div className="outline-knowledge-compact">
        <div className="outline-knowledge-search-row">
          <input
            className="outline-knowledge-search"
            value={knowledgeSearch}
            onChange={(event) => setKnowledgeSearch(event.target.value)}
            disabled={knowledgePickingDisabled}
            placeholder="搜索文件夹或文档"
          />
          <span>{keyword ? `匹配 ${visibleDocumentCount} 个文档` : `共 ${availableDocuments.length} 个可用文档`}</span>
        </div>
        <div className="outline-knowledge-grid">
          <div className="outline-knowledge-browser">
            <div className="outline-knowledge-pane-head">
              <strong>知识库</strong>
              <span>{visibleFolders.length} 个文件夹</span>
            </div>
            <div className="outline-knowledge-folder-list compact">
              {visibleFolders.length ? visibleFolders.map(({ folder, documents }) => {
                const expanded = keyword ? true : expandedKnowledgeFolderIds.has(folder.id);
                const selectedCount = documents.filter((document) => draftKnowledgeDocumentIds.includes(document.id)).length;

                return (
                  <section className="outline-knowledge-folder compact" key={folder.id}>
                    <div className="outline-knowledge-folder-head compact">
                      <button type="button" onClick={() => toggleKnowledgeFolder(folder.id)} disabled={Boolean(keyword)} aria-expanded={expanded}>
                        <span>{expanded ? '▾' : '▸'}</span>
                        <strong>{folder.name}</strong>
                      </button>
                      <small>{documents.length} 个 / 已选 {selectedCount}</small>
                      <div className="outline-knowledge-folder-actions">
                        <button type="button" onClick={() => selectFolderDocuments(documents)} disabled={knowledgePickingDisabled}>全选</button>
                        <button type="button" onClick={() => clearFolderDocuments(documents)} disabled={knowledgePickingDisabled || !selectedCount}>取消</button>
                      </div>
                    </div>
                    {expanded && (
                      <div className="outline-knowledge-document-list compact">
                        {documents.map((document) => {
                          const selected = draftKnowledgeDocumentIds.includes(document.id);

                          return (
                            <label className={`outline-knowledge-document compact${selected ? ' is-selected' : ''}`} key={document.id}>
                              <input
                                type="checkbox"
                                checked={selected}
                                disabled={knowledgePickingDisabled}
                                onChange={() => toggleDraftKnowledgeDocument(document)}
                              />
                              <strong title={document.file_name}>{document.file_name}</strong>
                              <small>{document.item_count || 0} 条</small>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              }) : <div className="outline-knowledge-empty compact">没有匹配的知识库文档</div>}
            </div>
          </div>
          <aside className="outline-knowledge-selected-pane">
            <div className="outline-knowledge-pane-head">
              <strong>本次已选</strong>
              <button type="button" onClick={clearDraftKnowledgeDocuments} disabled={knowledgePickingDisabled || !draftKnowledgeDocumentIds.length}>清空</button>
            </div>
            {selectedDocuments.length ? (
              <div className="outline-knowledge-selected-list">
                {selectedDocuments.map((document) => (
                  <div className="outline-knowledge-selected-item" key={document.id}>
                    <strong title={document.file_name}>{document.file_name}</strong>
                    <button type="button" onClick={() => removeDraftKnowledgeDocument(document.id)} disabled={knowledgePickingDisabled}>移除</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="outline-knowledge-empty compact">未选择知识库文档</div>
            )}
          </aside>
        </div>
      </div>
    );
}
