// ContentEditPage 的纯模型：生成选项的默认值与归一化、大纲树的生成状态推导。
//
// 原本是页面顶部的 16 块纯代码（约 150 行）——它们只依赖类型与 countReadableWords，
// 抽出来后可单测；页面只负责把 sections / options 传进来、把状态渲染成树。

import type { OutlineItem } from '../../shared/types';
import type { ConsistencyRepairMode, ContentGenerationOptions, ContentGenerationSectionStatus, ContentGenerationSections, ContentTableRequirement, OriginalPlanCoverageRepairMode } from '../../shared/types/domains/technical-plan';
import { countReadableWords } from '../../shared/utils/wordCount';

export type TreeStatus = ContentGenerationSectionStatus | 'partial' | 'planning' | 'pending';

export interface OutlineNodeMeta {
  status: TreeStatus;
  leafCount: number;
  words: number;
}

export const tableRequirementOptions: Array<{ value: ContentTableRequirement; label: string }> = [
  { value: 'none', label: '不要' },
  { value: 'light', label: '少量' },
  { value: 'moderate', label: '适中' },
  { value: 'heavy', label: '大量' },
];


export const consistencyRepairModeOptions: Array<{ value: ConsistencyRepairMode; label: string }> = [
  { value: 'agent', label: 'Agent 修复（推荐）' },
  { value: 'normal', label: '普通修复' },
];


export const originalPlanCoverageRepairModeOptions: Array<{ value: OriginalPlanCoverageRepairMode; label: string }> = [
  { value: 'agent', label: 'Agent 修复（推荐）' },
  { value: 'normal', label: '普通修复' },
];


// 默认的 HTML 配图类型清单。
export const DEFAULT_HTML_IMAGE_TYPES = '甘特图、进度网络图、组织架构图、泳道图、RACI 职责矩阵、风险矩阵、系统架构与拓扑图、WBS 工作分解结构图、鱼骨图、柱状图、折线图、饼图';

export const defaultContentGenerationOptions: ContentGenerationOptions = {
  useAiImages: false,
  maxAiImages: 6,
  useMermaidImages: true,
  maxMermaidImages: 5,
  useHtmlImages: true,
  maxHtmlImages: 10,
  htmlImageTypes: DEFAULT_HTML_IMAGE_TYPES,
  tableRequirement: 'heavy',
  enableConsistencyAudit: true,
  consistencyRepairMode: 'agent',
  enableOriginalPlanCoverageAudit: false,
  originalPlanCoverageRepairMode: 'agent',
};



export function isContentTableRequirement(value: unknown): value is ContentTableRequirement {
  return tableRequirementOptions.some((option) => option.value === value);
}

export function isConsistencyRepairMode(value: unknown): value is ConsistencyRepairMode {
  return consistencyRepairModeOptions.some((option) => option.value === value);
}

export function isOriginalPlanCoverageRepairMode(value: unknown): value is OriginalPlanCoverageRepairMode {
  return originalPlanCoverageRepairModeOptions.some((option) => option.value === value);
}

export function buildDefaultGenerationOptions(imageModelAvailable: boolean, leafCount: number): ContentGenerationOptions {
  const imageLimit = Math.max(1, leafCount);
  return {
    ...defaultContentGenerationOptions,
    useAiImages: imageModelAvailable,
    maxAiImages: Math.min(defaultContentGenerationOptions.maxAiImages, imageLimit),
    maxMermaidImages: Math.min(defaultContentGenerationOptions.maxMermaidImages, imageLimit),
    maxHtmlImages: Math.min(defaultContentGenerationOptions.maxHtmlImages, imageLimit),
  };
}

export function normalizeGenerationOptions(options: ContentGenerationOptions | undefined, imageModelAvailable: boolean, leafCount: number, isExpansionWorkflow = false): ContentGenerationOptions {
  const fallback = buildDefaultGenerationOptions(imageModelAvailable, leafCount);
  const maxAiImagesLimit = Math.max(1, leafCount);
  const requestedMaxAiImages = Number(options?.maxAiImages ?? fallback.maxAiImages);
  const requestedMaxMermaidImages = Number(options?.maxMermaidImages ?? fallback.maxMermaidImages);
  const requestedMaxHtmlImages = Number(options?.maxHtmlImages ?? fallback.maxHtmlImages);
  const tableRequirement = options?.tableRequirement;

  return {
    useAiImages: Boolean(options?.useAiImages ?? fallback.useAiImages) && imageModelAvailable,
    maxAiImages: Math.max(0, Math.min(Number.isFinite(requestedMaxAiImages) ? Math.round(requestedMaxAiImages) : fallback.maxAiImages, maxAiImagesLimit)),
    useMermaidImages: Boolean(options?.useMermaidImages ?? fallback.useMermaidImages),
    maxMermaidImages: Math.max(0, Math.min(Number.isFinite(requestedMaxMermaidImages) ? Math.round(requestedMaxMermaidImages) : fallback.maxMermaidImages, maxAiImagesLimit)),
    useHtmlImages: Boolean(options?.useHtmlImages ?? fallback.useHtmlImages),
    maxHtmlImages: Math.max(0, Math.min(Number.isFinite(requestedMaxHtmlImages) ? Math.round(requestedMaxHtmlImages) : fallback.maxHtmlImages, maxAiImagesLimit)),
    htmlImageTypes: String(options?.htmlImageTypes ?? fallback.htmlImageTypes),
    tableRequirement: isContentTableRequirement(tableRequirement) ? tableRequirement : fallback.tableRequirement,
    enableConsistencyAudit: Boolean(options?.enableConsistencyAudit ?? fallback.enableConsistencyAudit),
    consistencyRepairMode: isConsistencyRepairMode(options?.consistencyRepairMode) ? options.consistencyRepairMode : fallback.consistencyRepairMode,
    enableOriginalPlanCoverageAudit: isExpansionWorkflow ? Boolean(options?.enableOriginalPlanCoverageAudit ?? fallback.enableOriginalPlanCoverageAudit) : false,
    originalPlanCoverageRepairMode: isExpansionWorkflow && isOriginalPlanCoverageRepairMode(options?.originalPlanCoverageRepairMode) ? options.originalPlanCoverageRepairMode : fallback.originalPlanCoverageRepairMode,
  };
}

export function countWords(content: string) {
  return countReadableWords(content);
}

export function getLeafContent(item: OutlineItem, sections: ContentGenerationSections) {
  const section = sections[item.id];
  return section && Object.prototype.hasOwnProperty.call(section, 'content')
    ? section.content || ''
    : item.content || '';
}

export function getLeafStatus(item: OutlineItem, sections: ContentGenerationSections): TreeStatus {
  const section = sections[item.id];
  if (section?.status) {
    return section.status;
  }

  if (getLeafContent(item, sections).trim()) return 'success';
  return item.content_mode === 'ai-generate' ? 'idle' : 'pending';
}

export function getTreeStatus(item: OutlineItem, sections: ContentGenerationSections): TreeStatus {
  if (!item.children?.length) {
    return getLeafStatus(item, sections);
  }

  const childStatuses = item.children.map((child) => getTreeStatus(child, sections));
  if (childStatuses.some((status) => status === 'running')) {
    return 'running';
  }
  if (childStatuses.every((status) => status === 'success')) {
    return 'success';
  }
  if (childStatuses.every((status) => status === 'ignored')) {
    return 'ignored';
  }
  if (childStatuses.every((status) => status === 'pending')) {
    return 'pending';
  }
  if (childStatuses.some((status) => status === 'error')) {
    return 'error';
  }
  if (childStatuses.some((status) => status === 'success' || status === 'ignored' || status === 'partial' || status === 'pending')) {
    return 'partial';
  }

  return 'idle';
}

export function getParentStatus(childStatuses: TreeStatus[]): TreeStatus {
  if (childStatuses.some((status) => status === 'running')) return 'running';
  if (childStatuses.every((status) => status === 'success')) return 'success';
  if (childStatuses.every((status) => status === 'ignored')) return 'ignored';
  if (childStatuses.every((status) => status === 'pending')) return 'pending';
  if (childStatuses.some((status) => status === 'error')) return 'error';
  if (childStatuses.some((status) => status === 'success' || status === 'ignored' || status === 'partial' || status === 'pending')) return 'partial';
  if (childStatuses.some((status) => status === 'planning')) return 'planning';
  return 'idle';
}

export function buildOutlineMeta(items: OutlineItem[], sections: ContentGenerationSections, planning: boolean) {
  const meta = new Map<string, OutlineNodeMeta>();

  function visit(item: OutlineItem): OutlineNodeMeta {
    if (!item.children?.length) {
      const baseStatus = getLeafStatus(item, sections);
      const status: TreeStatus = planning && item.content_mode === 'ai-generate' && baseStatus === 'idle' ? 'planning' : baseStatus;
      const nodeMeta: OutlineNodeMeta = { status, leafCount: 1, words: countWords(getLeafContent(item, sections)) };
      meta.set(item.id, nodeMeta);
      return nodeMeta;
    }

    const children = item.children.map(visit);
    const nodeMeta = {
      status: getParentStatus(children.map((child) => child.status)),
      leafCount: children.reduce((sum, child) => sum + child.leafCount, 0),
      words: children.reduce((sum, child) => sum + child.words, 0),
    };
    meta.set(item.id, nodeMeta);
    return nodeMeta;
  }

  items.forEach(visit);
  return meta;
}
