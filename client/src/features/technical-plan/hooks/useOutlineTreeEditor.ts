// 目录项编辑：编辑态（标题/描述/内容处理模式）+ 增删改五连。
//
// 原本散在 OutlineEditPage 里（5 个 useState + 5 个 handler，约 110 行）。
// 边界：expandedItems / selectedItemId 留在页面——它们同时被排序 hook 与目录树渲染使用，
// 所以这两个 setter 由页面注入；「保存」也由页面提供（saveOutlineChange 是 IPC 胶水）。

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useToast } from '../../../shared/ui';
import type { OutlineContentMode, OutlineData, OutlineItem } from '../../../shared/types';
import type { SaveOutlineRequest } from '../../../shared/types/domains/technical-plan';
import { collectOutlineIds, deleteOutlineItem, findOutlineItem, updateOutlineItem } from '../outlineTree';

export interface UseOutlineTreeEditorOptions {
  outlineData: OutlineData | null;
  sorting: boolean;
  outlineMutationLocked: boolean;
  setExpandedItems: Dispatch<SetStateAction<Set<string>>>;
  setSelectedItemId: Dispatch<SetStateAction<string | null>>;
  saveOutlineChange: (outline: OutlineItem[], reason: SaveOutlineRequest['reason'], affectedNodeIds?: string[]) => Promise<void>;
}

export function useOutlineTreeEditor({
  outlineData,
  sorting,
  outlineMutationLocked,
  setExpandedItems,
  setSelectedItemId,
  saveOutlineChange,
}: UseOutlineTreeEditorOptions) {
  const { showToast } = useToast();
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editContentMode, setEditContentMode] = useState<OutlineContentMode>('ai-generate');
  const [editContentModeNote, setEditContentModeNote] = useState('');

  const startEditing = (item: OutlineItem) => {
    if (sorting || outlineMutationLocked) {
      return;
    }
    setSelectedItemId(item.id);
    setEditingItemId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description);
    setEditContentMode(item.content_mode || 'ai-generate');
    setEditContentModeNote(item.content_mode_note || '');
  };

  const saveEditing = async () => {
    if (!outlineData || !editingItemId || sorting || outlineMutationLocked) {
      return;
    }

    try {
      await saveOutlineChange(updateOutlineItem(outlineData.outline, editingItemId, (item) => ({
        ...item,
        title: editTitle.trim() || item.title,
        description: editDescription.trim(),
        ...(!item.children?.length ? {
          content_mode: editContentMode,
          content_mode_note: editContentMode === 'other' ? editContentModeNote.trim() || undefined : undefined,
        } : {}),
      })), 'edit', [editingItemId]);
      setEditingItemId(null);
      showToast('目录项已更新，相关正文已清空', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存目录项失败', 'error');
    }
  };

  const addRootItem = async () => {
    if (!outlineData || sorting || outlineMutationLocked) {
      return;
    }

    const newItem: OutlineItem = {
      id: `${outlineData.outline.length + 1}`,
      title: '新目录项',
      description: '请编辑描述',
      content_mode: 'ai-generate',
    };
    try {
      await saveOutlineChange([...outlineData.outline, newItem], 'add-root');
      setSelectedItemId(newItem.id);
      setEditingItemId(newItem.id);
      setEditTitle(newItem.title);
      setEditDescription(newItem.description);
      setEditContentMode(newItem.content_mode || 'ai-generate');
      setEditContentModeNote(newItem.content_mode_note || '');
      showToast('一级目录已添加', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '添加一级目录失败', 'error');
    }
  };

  const addChildItem = async (parentId: string) => {
    if (!outlineData || sorting || outlineMutationLocked) {
      return;
    }

    const parent = findOutlineItem(outlineData.outline, parentId);
    const nextIndex = (parent?.children?.length || 0) + 1;
    const newItem: OutlineItem = {
      id: `${parentId}.${nextIndex}`,
      title: '新目录项',
      description: '请编辑描述',
      content_mode: 'ai-generate',
    };

    try {
      await saveOutlineChange(updateOutlineItem(outlineData.outline, parentId, (item) => ({
        ...item,
        children: [...(item.children || []), newItem],
      })), 'add-child', [parentId]);
      setExpandedItems((prev) => new Set(prev).add(parentId));
      setSelectedItemId(newItem.id);
      setEditingItemId(newItem.id);
      setEditTitle(newItem.title);
      setEditDescription(newItem.description);
      setEditContentMode(newItem.content_mode || 'ai-generate');
      setEditContentModeNote(newItem.content_mode_note || '');
      showToast('子目录已添加，父目录正文已清空', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '添加子目录失败', 'error');
    }
  };

  const removeItem = async (itemId: string) => {
    if (!outlineData || sorting || outlineMutationLocked) {
      return;
    }
    try {
      const removedItem = findOutlineItem(outlineData.outline, itemId);
      const removedIds = removedItem ? [...collectOutlineIds([removedItem])] : [itemId];
      const nextOutline = deleteOutlineItem(outlineData.outline, itemId);
      if (!nextOutline.length) {
        showToast('至少保留一个目录项', 'info');
        return;
      }
      await saveOutlineChange(nextOutline, 'delete', removedIds);
      setSelectedItemId(null);
      showToast('目录项已删除', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除目录项失败', 'error');
    }
  };

  return {
    editingItemId,
    editTitle,
    editDescription,
    editContentMode,
    editContentModeNote,
    setEditingItemId,
    setEditTitle,
    setEditDescription,
    setEditContentMode,
    setEditContentModeNote,
    startEditing,
    saveEditing,
    addRootItem,
    addChildItem,
    removeItem,
  };
}
