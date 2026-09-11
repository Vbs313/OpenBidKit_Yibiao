// 目录排序：草稿目录、拖动落点、同级重排、保存/放弃，以及「未保存排序」的离开守卫。
//
// 原本散在 OutlineEditPage 里（6 个 useState + 1 个 useRef + 9 个 handler + 1 个 effect，约 130 行），
// 它们互相咬合但只碰 activeOutlineData —— 正好是一簇。页面只保留「渲染目录树」和「工具条」。
//
// 注入的三件事：getMutationLockMessage（能否开始/保存排序由页面说了算）、
// onStartSorting（开始排序要收起编辑态）、onRemapExpandedIds（重排后展开态要跟着 id 走）。

import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useToast } from '../../../shared/ui';
import type { OutlineData, OutlineItem } from '../../../shared/types';
import { composeIdMap, createIdentityIdMap, findOutlineLocation, renumberOutlineItemsWithIdMap, reorderOutlineSiblings } from '../outlineTree';

export interface DropTargetState {
  itemId: string;
  position: 'before' | 'after';
  valid: boolean;
}

export interface UseOutlineSortingOptions {
  outlineData: OutlineData | null;
  onOutlineSaved: (request: { outlineData: OutlineData; reason: 'sort'; idMap: Record<string, string> }) => Promise<void>;
  onSortGuardChange?: (guard: { hasUnsavedSort: () => boolean; saveSort: () => Promise<void>; discardSort: () => void } | null) => void;
  getMutationLockMessage: () => string;
  onStartSorting?: () => void;
  onRemapExpandedIds?: (idMap: Record<string, string>) => void;
  onRemapSelectedId?: (idMap: Record<string, string>) => void;
}

export function useOutlineSorting({
  outlineData,
  onOutlineSaved,
  onSortGuardChange,
  getMutationLockMessage,
  onStartSorting,
  onRemapExpandedIds,
  onRemapSelectedId,
}: UseOutlineSortingOptions) {
  const { showToast } = useToast();
  const [sorting, setSorting] = useState(false);
  const [draftOutlineData, setDraftOutlineData] = useState<OutlineData | null>(null);
  const [sortDirty, setSortDirty] = useState(false);
  const [savingSort, setSavingSort] = useState(false);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);
  const sortIdMapRef = useRef<Record<string, string>>({});

  const activeOutlineData = sorting ? draftOutlineData : outlineData;

  const startSorting = () => {
    if (!outlineData?.outline?.length) {
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      showToast(lockMessage, 'info');
      return;
    }

    setDraftOutlineData(outlineData);
    sortIdMapRef.current = createIdentityIdMap(outlineData.outline);
    setSorting(true);
    setSortDirty(false);
    onStartSorting?.();
    setDraggingItemId(null);
    setDropTarget(null);
    showToast('仅支持同级目录排序；拖动只在前端调整，点击保存排序后才会写入数据库。', 'info');
  };

  const discardSorting = () => {
    setSorting(false);
    setDraftOutlineData(null);
    setSortDirty(false);
    setSavingSort(false);
    setDraggingItemId(null);
    setDropTarget(null);
    sortIdMapRef.current = {};
  };

  const saveSorting = async () => {
    if (!draftOutlineData?.outline?.length) {
      discardSorting();
      return;
    }
    if (!sortDirty) {
      discardSorting();
      return;
    }
    const lockMessage = getMutationLockMessage();
    if (lockMessage) {
      throw new Error(lockMessage);
    }

    setSavingSort(true);
    try {
      await onOutlineSaved({
        outlineData: draftOutlineData,
        reason: 'sort',
        idMap: sortIdMapRef.current,
      });
      discardSorting();
      showToast('目录排序已保存', 'success');
    } finally {
      setSavingSort(false);
    }
  };

  const getDropPosition = (event: DragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  const canDropOnTarget = (draggedId: string, targetId: string) => {
    if (!activeOutlineData?.outline?.length || draggedId === targetId) return false;
    const dragged = findOutlineLocation(activeOutlineData.outline, draggedId);
    const target = findOutlineLocation(activeOutlineData.outline, targetId);
    return Boolean(dragged && target && dragged.parentId === target.parentId && dragged.level === target.level);
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, item: OutlineItem) => {
    if (!sorting) {
      return;
    }
    setDraggingItemId(item.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, item: OutlineItem) => {
    if (!sorting || !draggingItemId) {
      return;
    }
    event.preventDefault();
    const valid = canDropOnTarget(draggingItemId, item.id);
    event.dataTransfer.dropEffect = valid ? 'move' : 'none';
    setDropTarget({ itemId: item.id, position: getDropPosition(event), valid });
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, item: OutlineItem) => {
    event.preventDefault();
    if (!sorting || !draftOutlineData?.outline?.length || !draggingItemId) {
      return;
    }

    const valid = canDropOnTarget(draggingItemId, item.id);
    if (!valid) {
      setDraggingItemId(null);
      setDropTarget(null);
      showToast('只能同级目录排序', 'info');
      return;
    }

    const sourceLocation = findOutlineLocation(draftOutlineData.outline, draggingItemId);
    if (!sourceLocation) {
      setDraggingItemId(null);
      setDropTarget(null);
      return;
    }

    const position = dropTarget?.itemId === item.id ? dropTarget.position : getDropPosition(event);
    const reordered = reorderOutlineSiblings(draftOutlineData.outline, sourceLocation.parentId, draggingItemId, item.id, position);
    const renumbered = renumberOutlineItemsWithIdMap(reordered);
    sortIdMapRef.current = composeIdMap(sortIdMapRef.current, renumbered.idMap);
    setDraftOutlineData({ ...draftOutlineData, outline: renumbered.outline });
    onRemapExpandedIds?.(renumbered.idMap);
    onRemapSelectedId?.(renumbered.idMap);
    setSortDirty(true);
    setDraggingItemId(null);
    setDropTarget(null);
  };

  const handleDragEnd = () => {
    setDraggingItemId(null);
    setDropTarget(null);
  };

  useEffect(() => {
    if (!onSortGuardChange) return;
    onSortGuardChange({
      hasUnsavedSort: () => sorting && sortDirty,
      saveSort: saveSorting,
      discardSort: discardSorting,
    });
    return () => onSortGuardChange(null);
  }, [onSortGuardChange, sorting, sortDirty, draftOutlineData]);

  return {
    sorting,
    draftOutlineData,
    sortDirty,
    savingSort,
    draggingItemId,
    dropTarget,
    activeOutlineData,
    startSorting,
    discardSorting,
    saveSorting,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
  };
}
