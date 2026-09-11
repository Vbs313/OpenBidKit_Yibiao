// 知识库选择器的纯视图模型：从索引 + 搜索词 + 已选 id 算出「可用文档 / 已选文档 / 可见文件夹」。
//
// 这段筛选逻辑原本内联在 OutlineEditPage 的 renderKnowledgePicker 里（约 15 行），
// 抽出来后可单测：关键字命中的是文件夹名或文件名、只保留 status=success、空文件夹不显示。

import type { KnowledgeBaseIndex, KnowledgeDocument, KnowledgeFolder } from '../../shared/types/domains/knowledge-base';

export interface KnowledgePickerFolderGroup {
  folder: KnowledgeFolder;
  documents: KnowledgeDocument[];
}

export interface KnowledgePickerViewModel {
  keyword: string;
  availableDocuments: KnowledgeDocument[];
  selectedDocuments: KnowledgeDocument[];
  visibleFolders: KnowledgePickerFolderGroup[];
  visibleDocumentCount: number;
}

export function includesKeyword(value: string, keyword: string) {
  return value.toLowerCase().includes(keyword);
}

export function buildKnowledgePickerViewModel(
  index: KnowledgeBaseIndex,
  search: string,
  draftDocumentIds: string[],
): KnowledgePickerViewModel {
  const keyword = search.trim().toLowerCase();
  const availableDocuments = index.documents.filter((document) => document.status === 'success');
  const selectedDocuments = draftDocumentIds
    .map((documentId) => index.documents.find((document) => document.id === documentId))
    .filter((document): document is KnowledgeDocument => Boolean(document));
  const visibleFolders = index.folders.flatMap((folder) => {
    const folderDocuments = availableDocuments.filter((document) => document.folder_id === folder.id);
    const folderMatched = keyword ? includesKeyword(folder.name, keyword) : false;
    const documents = keyword
      ? folderDocuments.filter((document) => folderMatched || includesKeyword(document.file_name, keyword))
      : folderDocuments;

    return documents.length ? [{ folder, documents }] : [];
  });
  const visibleDocumentCount = visibleFolders.reduce((total, group) => total + group.documents.length, 0);

  return { keyword, availableDocuments, selectedDocuments, visibleFolders, visibleDocumentCount };
}
