// 知识库选择器：索引加载 + 已选草稿 + 文件夹展开 + 6 个选择动作。
//
// 原本是 OutlineEditPage 里的 5 个 useState + 索引加载 + 6 个 handler（约 70 行）。
// 「筛选成视图模型」交给 knowledgePickerModel（纯函数，可测）；「禁用与否」由页面注入（generating）。

import { useState } from 'react';
import { useToast } from '../../../shared/ui';
import type { KnowledgeBaseIndex, KnowledgeDocument } from '../../../shared/types/domains/knowledge-base';

const emptyKnowledgeIndex: KnowledgeBaseIndex = { folders: [], documents: [] };

export function getInitialExpandedKnowledgeFolders(index: KnowledgeBaseIndex) {
  const firstAvailableFolder = index.folders.find((folder) => (
    index.documents.some((document) => document.folder_id === folder.id && document.status === 'success')
  ));
  return new Set(firstAvailableFolder ? [firstAvailableFolder.id] : []);
}

export interface UseOutlineKnowledgePickerOptions {
  referenceKnowledgeDocumentIds: string[];
  disabled: boolean;
}

export function useOutlineKnowledgePicker({ referenceKnowledgeDocumentIds, disabled }: UseOutlineKnowledgePickerOptions) {
  const { showToast } = useToast();
  const [draftKnowledgeDocumentIds, setDraftKnowledgeDocumentIds] = useState<string[]>(referenceKnowledgeDocumentIds);
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const [expandedKnowledgeFolderIds, setExpandedKnowledgeFolderIds] = useState<Set<string>>(new Set());
  const [knowledgeIndex, setKnowledgeIndex] = useState<KnowledgeBaseIndex>(emptyKnowledgeIndex);
  const [loadingKnowledge, setLoadingKnowledge] = useState(false);

  const loadKnowledgeIndex = async () => {
    try {
      setLoadingKnowledge(true);
      const data = await window.yibiao?.knowledgeBase.list();
      setKnowledgeIndex(data || emptyKnowledgeIndex);
      setExpandedKnowledgeFolderIds(getInitialExpandedKnowledgeFolders(data || emptyKnowledgeIndex));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取知识库失败', 'error');
      setKnowledgeIndex(emptyKnowledgeIndex);
      setExpandedKnowledgeFolderIds(new Set());
    } finally {
      setLoadingKnowledge(false);
    }
  };

  const toggleDraftKnowledgeDocument = (document: KnowledgeDocument) => {
    if (document.status !== 'success' || disabled) {
      return;
    }

    setDraftKnowledgeDocumentIds((prev) => (
      prev.includes(document.id)
        ? prev.filter((id) => id !== document.id)
        : [...prev, document.id]
    ));
  };

  const toggleKnowledgeFolder = (folderId: string) => {
    setExpandedKnowledgeFolderIds((prev) => (prev.has(folderId) ? new Set() : new Set([folderId])));
  };

  const selectFolderDocuments = (documents: KnowledgeDocument[]) => {
    if (disabled) {
      return;
    }
    const ids = documents.filter((document) => document.status === 'success').map((document) => document.id);
    setDraftKnowledgeDocumentIds((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
  };

  const clearFolderDocuments = (documents: KnowledgeDocument[]) => {
    if (disabled) {
      return;
    }
    const ids = new Set(documents.map((document) => document.id));
    setDraftKnowledgeDocumentIds((prev) => prev.filter((id) => !ids.has(id)));
  };

  const removeDraftKnowledgeDocument = (documentId: string) => {
    if (disabled) {
      return;
    }
    setDraftKnowledgeDocumentIds((prev) => prev.filter((id) => id !== documentId));
  };

  const clearDraftKnowledgeDocuments = () => {
    if (disabled) {
      return;
    }
    setDraftKnowledgeDocumentIds([]);
  };

  // 打开目录生成弹窗时把草稿重置为已保存的参考文档。
  const resetDraft = () => {
    setDraftKnowledgeDocumentIds(referenceKnowledgeDocumentIds);
    setKnowledgeSearch('');
  };

  return {
    draftKnowledgeDocumentIds,
    setDraftKnowledgeDocumentIds,
    knowledgeSearch,
    setKnowledgeSearch,
    expandedKnowledgeFolderIds,
    knowledgeIndex,
    loadingKnowledge,
    loadKnowledgeIndex,
    resetDraft,
    toggleDraftKnowledgeDocument,
    toggleKnowledgeFolder,
    selectFolderDocuments,
    clearFolderDocuments,
    removeDraftKnowledgeDocument,
    clearDraftKnowledgeDocuments,
  };
}
