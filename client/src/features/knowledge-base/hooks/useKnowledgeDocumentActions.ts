// 知识库的文件夹 / 文档管理：新建、上传、重命名、删除（含确认弹窗状态）、失败重试。
//
// 原本是 KnowledgeBasePage 里的 5 个 state + 7 个 handler（约 150 行）。
//
// 注入的都是页面持有的东西：索引缓存（index/setIndex）、当前文件夹、按文件夹分组的文档数、
// 新建文件夹表单的开关，以及删除/重试后要同步的查看器与分析快照。

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { isLibreOfficeRequiredMessage, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { KnowledgeAnalysisSnapshot, KnowledgeBaseIndex, KnowledgeDocument, KnowledgeFolder } from '../../../shared/types/domains/knowledge-base';
import { mergeDocuments } from '../model';
import type { KnowledgeViewer } from '../model';

export interface UseKnowledgeDocumentActionsOptions {
  index: KnowledgeBaseIndex;
  setIndex: Dispatch<SetStateAction<KnowledgeBaseIndex>>;
  activeFolder: KnowledgeFolder | undefined;
  documentsByFolder: Map<string, KnowledgeDocument[]>;
  activeFolderId: string;
  setActiveFolderId: (folderId: string) => void;
  setShowCreateFolder: (open: boolean) => void;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setViewer: Dispatch<SetStateAction<KnowledgeViewer | null>>;
  setAnalysisSnapshot: Dispatch<SetStateAction<KnowledgeAnalysisSnapshot | null>>;
}

export function useKnowledgeDocumentActions({
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
}: UseKnowledgeDocumentActionsOptions) {
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [retryingDocumentIds, setRetryingDocumentIds] = useState<Set<string>>(() => new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { type: 'folder'; folderId: string; folderName: string; count: number }
    | { type: 'document'; document: KnowledgeDocument }
    | null
  >(null);
  const [deletingConfirm, setDeletingConfirm] = useState(false);

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

  return {
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
  };
}
