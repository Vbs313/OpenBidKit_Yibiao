// 大纲树的公共度量：叶子收集、mermaid 图计数。
//
// 这三段逻辑此前在客户端里存在**三份**：
//   - technical-plan/outlineTree.ts（叶子收集）
//   - technical-plan/technicalPlanHomeModel.ts（mermaid 计数）
//   - export-format/pages/ExportFormatPage.tsx（三个都有）
// 统一放到 shared，两个 feature 都从这里取，避免以后再各自长一份。

import type { OutlineItem } from '../types';

export function collectLeafItems(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => item.children?.length ? collectLeafItems(item.children) : [item]);
}

export function countMermaidDiagrams(content: string) {
  const mermaidBlocks = (String(content || '').match(/```mermaid[\s\S]*?```/gi) || []).length;
  const mermaidInkImages = (String(content || '').match(/https:\/\/mermaid\.ink\/img\//gi) || []).length;
  return mermaidBlocks + mermaidInkImages;
}

export function countOutlineMermaidDiagrams(items: OutlineItem[]) {
  return collectLeafItems(items).reduce((sum, item) => sum + countMermaidDiagrams(item.content || ''), 0);
}
