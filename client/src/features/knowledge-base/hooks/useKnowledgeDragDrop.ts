// 知识库的拖拽排序：文件夹之间、文件夹内部文档之间的拖动落点与落库。
//
// 原本是 KnowledgeBasePage 里的 4 个 state + 8 个 handler（约 100 行）。
// 注入两件事：applyKnowledgeIndex（拖完重新读列表）、setActiveFolderId（文档跨夹后切换当前文件夹）。

import { useState } from 'react';
import type { DragEvent } from 'react';
import { useToast } from '../../../shared/ui';
import type { KnowledgeDocument } from '../../../shared/types/domains/knowledge-base';
import type { KnowledgeDocumentDropTarget, KnowledgeDragPayload, KnowledgeDropPosition } from '../model';
import { canMoveKnowledgeDocument } from '../model';

export interface UseKnowledgeDragDropOptions {
  applyKnowledgeIndex: (data: import('../../../shared/types/domains/knowledge-base').KnowledgeBaseIndex) => void;
  setActiveFolderId: (folderId: string) => void;
}

export function useKnowledgeDragDrop({ applyKnowledgeIndex, setActiveFolderId }: UseKnowledgeDragDropOptions) {
  const { showToast } = useToast();
  const [dragPayload, setDragPayload] = useState<KnowledgeDragPayload | null>(null);
  const [folderDropTargetId, setFolderDropTargetId] = useState<string | null>(null);
  const [documentDropTarget, setDocumentDropTarget] = useState<KnowledgeDocumentDropTarget | null>(null);
  const [dragSaving, setDragSaving] = useState(false);

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

  return {
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
  };
}
