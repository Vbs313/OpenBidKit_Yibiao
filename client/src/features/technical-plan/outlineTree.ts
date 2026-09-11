// 大纲树（OutlineItem[]）的纯操作：编号重排、内容模式归一化、查找、增删、同级排序。
//
// 原本是 OutlineEditPage.tsx 里的 13 个模块级函数 + 2 个局部接口 —— 它们只依赖 OutlineItem 类型，
// 和 React 没有任何关系，留在 1500 行的页面文件里既难找也测不了。

import type { OutlineItem } from '../../shared/types';

export interface RenumberResult {
  outline: OutlineItem[];
  idMap: Record<string, string>;
}


export interface OutlineLocation {
  parentId: string | null;
  level: number;
  index: number;
}


// 父节点不保存处理模式，叶子保留已经明确选择的处理模式。
export function collectOutlineIds(items: OutlineItem[], ids = new Set<string>()) {
  items.forEach((item) => {
    ids.add(item.id);
    if (item.children?.length) {
      collectOutlineIds(item.children, ids);
    }
  });
  return ids;
}

export function collectRootIds(items: OutlineItem[]) {
  return new Set(items.map((item) => item.id));
}

export function renumberOutlineItemsWithIdMap(items: OutlineItem[], parentPrefix = ''): RenumberResult {
  const idMap: Record<string, string> = {};
  const outline = items.map((item, index) => {
    const id = parentPrefix ? `${parentPrefix}.${index + 1}` : `${index + 1}`;
    const childResult = item.children?.length ? renumberOutlineItemsWithIdMap(item.children, id) : null;
    idMap[item.id] = id;
    if (childResult) {
      Object.assign(idMap, childResult.idMap);
    }
    return {
      ...item,
      id,
      children: childResult?.outline,
    };
  });

  return { outline, idMap };
}

export function normalizeOutlineContentModes(items: OutlineItem[]): OutlineItem[] {
  return items.map((item) => {
    if (item.children?.length) {
      const branch = { ...item };
      delete branch.content_mode;
      delete branch.content_mode_note;
      return { ...branch, children: normalizeOutlineContentModes(item.children) };
    }
    const leaf = { ...item };
    delete leaf.children;
    const contentMode = item.content_mode;
    return {
      ...leaf,
      content_mode: contentMode,
      ...(contentMode === 'other' && item.content_mode_note?.trim()
        ? { content_mode_note: item.content_mode_note.trim() }
        : { content_mode_note: undefined }),
    };
  });
}

export function assertLeafContentModes(items: OutlineItem[]) {
  items.forEach((item) => {
    if (item.children?.length) {
      assertLeafContentModes(item.children);
    } else if (!item.content_mode) {
      throw new Error(`目录“${item.title}”缺少内容处理模式，请重新生成目录`);
    }
  });
}

export function createIdentityIdMap(items: OutlineItem[], idMap: Record<string, string> = {}) {
  items.forEach((item) => {
    idMap[item.id] = item.id;
    if (item.children?.length) {
      createIdentityIdMap(item.children, idMap);
    }
  });
  return idMap;
}

export function composeIdMap(baseMap: Record<string, string>, stepMap: Record<string, string>) {
  return Object.fromEntries(Object.entries(baseMap).map(([oldId, currentId]) => [oldId, stepMap[currentId] || currentId]));
}

export function findOutlineLocation(items: OutlineItem[], itemId: string, parentId: string | null = null, level = 0): OutlineLocation | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.id === itemId) {
      return { parentId, level, index };
    }
    if (item.children?.length) {
      const child = findOutlineLocation(item.children, itemId, item.id, level + 1);
      if (child) return child;
    }
  }
  return null;
}

export function reorderSiblingItems(items: OutlineItem[], draggedId: string, targetId: string, position: 'before' | 'after') {
  const draggedIndex = items.findIndex((item) => item.id === draggedId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
    return items;
  }

  const next = [...items];
  const [dragged] = next.splice(draggedIndex, 1);
  const adjustedTargetIndex = next.findIndex((item) => item.id === targetId);
  const insertIndex = position === 'before' ? adjustedTargetIndex : adjustedTargetIndex + 1;
  next.splice(insertIndex, 0, dragged);
  return next;
}

export function reorderOutlineSiblings(items: OutlineItem[], parentId: string | null, draggedId: string, targetId: string, position: 'before' | 'after'): OutlineItem[] {
  if (parentId === null) {
    return reorderSiblingItems(items, draggedId, targetId, position);
  }

  return items.map((item) => {
    if (item.id === parentId) {
      return {
        ...item,
        children: reorderSiblingItems(item.children || [], draggedId, targetId, position),
      };
    }
    return item.children?.length
      ? { ...item, children: reorderOutlineSiblings(item.children, parentId, draggedId, targetId, position) }
      : item;
  });
}

export function updateOutlineItem(items: OutlineItem[], itemId: string, updater: (item: OutlineItem) => OutlineItem): OutlineItem[] {
  return items.map((item) => {
    if (item.id === itemId) {
      return updater(item);
    }

    return {
      ...item,
      children: item.children ? updateOutlineItem(item.children, itemId, updater) : undefined,
    };
  });
}

export function deleteOutlineItem(items: OutlineItem[], itemId: string): OutlineItem[] {
  return items.flatMap((item) => {
    if (item.id === itemId) {
      return [];
    }

    const children = item.children ? deleteOutlineItem(item.children, itemId) : undefined;
    return [{
      ...item,
      children: children?.length ? children : undefined,
      ...(!children?.length && item.children?.length ? { content_mode: 'ai-generate' as const } : {}),
    }];
  });
}

export function findOutlineItem(items: OutlineItem[], itemId: string): OutlineItem | null {
  for (const item of items) {
    if (item.id === itemId) {
      return item;
    }
    const child = item.children ? findOutlineItem(item.children, itemId) : null;
    if (child) {
      return child;
    }
  }
  return null;
}
