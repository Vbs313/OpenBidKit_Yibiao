// TechnicalPlanHome 的纯模型：字数警告弹窗的构造、mermaid 计数、必选分析任务判定、工作流判定。
//
// 这些函数原本躺在 1476 行的页面文件顶部（约 180 行），只依赖类型与两个纯工具，
// 抽出来后可单测；页面只负责把 state / task 传进去、把返回值渲染出来。

import type { BackgroundTaskState, BidAnalysisTasks, TechnicalPlanState, TechnicalPlanWorkflowKind } from '../../shared/types/domains/technical-plan';
import type { OutlineData, OutlineItem, OutlineWordControlOptions } from '../../shared/types';
import { countReadableWords } from '../../shared/utils/wordCount';
import { getBidAnalysisTasks } from './services/bidAnalysisWorkflow';
import { collectLeafItems } from './outlineTree';

export interface WordControlWarningMetric {
  label: string;
  expected: string;
  actual: string;
}


export interface WordControlWarningSection {
  id: string;
  title: string;
  words: number;
}


export interface WordControlWarningDialogState {
  taskId: string;
  title: string;
  message: string;
  metrics: WordControlWarningMetric[];
  sections: WordControlWarningSection[];
}


export const requiredBidAnalysisTasks = getBidAnalysisTasks('key');


// 根据任务最终统计构建需要用户处理的字数警告弹窗。
export function isOutlineLeafCountOutsideRange(outlineData: OutlineData, options: OutlineWordControlOptions) {
  if (options.minimumWords === 0 && options.maximumWords === 0) return false;
  const effectiveSectionWords = options.sectionWords > 0 ? options.sectionWords : 3000;
  const leafCount = collectLeafItems(outlineData.outline || []).filter((item) => item.content_mode === 'ai-generate').length;
  const minimumLeafCount = options.minimumWords > 0 ? Math.ceil(options.minimumWords / effectiveSectionWords) : null;
  const maximumLeafCount = options.maximumWords > 0 ? Math.floor(options.maximumWords / effectiveSectionWords) : null;
  return (minimumLeafCount !== null && leafCount < minimumLeafCount)
    || (maximumLeafCount !== null && leafCount > maximumLeafCount);
}

export function countMermaidDiagrams(content: string) {
  const mermaidBlocks = (String(content || '').match(/```mermaid[\s\S]*?```/gi) || []).length;
  const mermaidInkImages = (String(content || '').match(/https:\/\/mermaid\.ink\/img\//gi) || []).length;
  return mermaidBlocks + mermaidInkImages;
}

export function countOutlineMermaidDiagrams(items: OutlineItem[]) {
  return collectLeafItems(items).reduce((sum, item) => sum + countMermaidDiagrams(item.content || ''), 0);
}

export function formatCountRange(minimum: number, maximum: number, unit: string) {
  if (minimum > 0 && maximum > 0) return `${minimum.toLocaleString('zh-CN')} 至 ${maximum.toLocaleString('zh-CN')} ${unit}`;
  if (minimum > 0) return `不少于 ${minimum.toLocaleString('zh-CN')} ${unit}`;
  if (maximum > 0) return `不超过 ${maximum.toLocaleString('zh-CN')} ${unit}`;
  return '未限制';
}

export function buildWordControlWarningDialog(task: BackgroundTaskState, state: TechnicalPlanState): WordControlWarningDialogState | null {
  const outlineStats = task.stats?.outline;
  if (outlineStats?.word_adjustment_warning) {
    // 质量类：叶子数量已达标，仅二审发现可优化点，不展示会误导的叶子数对比。
    if (outlineStats.word_adjustment_warning_kind === 'quality') {
      return {
        taskId: task.task_id,
        title: '目录已生成，建议人工核对',
        message: outlineStats.word_adjustment_warning,
        metrics: [],
        sections: [],
      };
    }
    // 数量类：叶子数量未进入区间，展示预期与实际对比。
    const minimumLeafCount = outlineStats.minimum_leaf_count || 0;
    const maximumLeafCount = outlineStats.maximum_leaf_count || 0;
    const targetLeafCount = outlineStats.target_leaf_count;
    const currentLeafCount = outlineStats.current_leaf_count || 0;
    return {
      taskId: task.task_id,
      title: 'AI生成小节数量未达到预期',
      message: outlineStats.word_adjustment_warning,
      metrics: [{
        label: 'AI生成小节',
        expected: typeof targetLeafCount === 'number'
          ? `${targetLeafCount.toLocaleString('zh-CN')} 个`
          : formatCountRange(minimumLeafCount, maximumLeafCount, '个'),
        actual: `${currentLeafCount.toLocaleString('zh-CN')} 个`,
      }],
      sections: [],
    };
  }

  const contentStats = task.stats?.content;
  if (!contentStats?.word_control_warning) return null;

  const minimumWords = contentStats.minimum_words || 0;
  const maximumWords = contentStats.maximum_words || 0;
  const sectionWords = contentStats.section_words || 0;
  const sectionMinimumWords = sectionWords > 0 ? Math.ceil(sectionWords * 0.8) : 0;
  const sectionMaximumWords = sectionWords > 0 ? Math.floor(sectionWords * 1.2) : 0;
  const orderedLeaves = state.outlineData?.outline?.length
    ? collectLeafItems(state.outlineData.outline).filter((item) => item.content_mode === 'ai-generate')
    : [];
  const sectionSources = orderedLeaves.length
    ? orderedLeaves.map((item) => ({
        id: item.id,
        title: item.title || state.contentGenerationSections[item.id]?.title || '未命名章节',
        status: state.contentGenerationSections[item.id]?.status,
        content: state.contentGenerationSections[item.id]?.content ?? item.content ?? '',
      }))
    : Object.values(state.contentGenerationSections);
  const sections = contentStats.strict_section_words && sectionWords > 0
    ? sectionSources
        .filter((section) => section.status === 'success')
        .map((section) => ({ ...section, words: countReadableWords(section.content) }))
        .filter((section) => section.words < sectionMinimumWords || section.words > sectionMaximumWords)
        .map(({ id, title, words }) => ({ id, title, words }))
    : [];
  const metrics: WordControlWarningMetric[] = [];
  if (minimumWords > 0 || maximumWords > 0) {
    metrics.push({
      label: '全文字数',
      expected: formatCountRange(minimumWords, maximumWords, '字'),
      actual: `${(contentStats.current_words || 0).toLocaleString('zh-CN')} 字`,
    });
  }
  if (contentStats.strict_section_words && sectionWords > 0) {
    metrics.push({
      label: '单个小节',
      expected: `${sectionMinimumWords.toLocaleString('zh-CN')} 至 ${sectionMaximumWords.toLocaleString('zh-CN')} 字（目标 ${sectionWords.toLocaleString('zh-CN')} 字）`,
      actual: `${sections.length.toLocaleString('zh-CN')} 个小节未达标`,
    });
  }

  return {
    taskId: task.task_id,
    title: '正文字数未达到预期',
    message: contentStats.word_control_warning,
    metrics,
    sections,
  };
}

export function areRequiredBidAnalysisTasksReady(tasks: BidAnalysisTasks) {
  return requiredBidAnalysisTasks.every((task) => {
    const state = tasks[task.id];
    return state?.status === 'success' && state.content.trim();
  });
}

export function workflowKindFromSection(section?: string): TechnicalPlanWorkflowKind | null {
  if (section === 'technical-plan') return 'technical-plan';
  if (section === 'existing-plan-expansion') return 'existing-plan-expansion';
  return null;
}

export function workflowLabel(kind: TechnicalPlanWorkflowKind) {
  return kind === 'existing-plan-expansion' ? '已有方案扩写' : '生成技术方案';
}

export function hasRunningTechnicalPlanTask(state: TechnicalPlanState) {
  return [state.bidSectionExtractionTask, state.bidAnalysisTask, state.outlineGenerationTask, state.outlineAdjustmentTask, state.globalFactsTask, state.globalFactsAdjustmentTask, state.contentGenerationTask]
    .some((task) => task?.status === 'running' || task?.status === 'pausing');
}

export function hasWorkflowSpecificProgress(state: TechnicalPlanState) {
  return Boolean(
    state.originalPlanFile
    || state.bidSectionMode === 'multiple'
    || state.bidSections.length > 0
    || state.bidSectionExtractionTask
    || state.outlineData
    || state.globalFacts.length > 0
    || Object.keys(state.contentGenerationSections || {}).length > 0
    || Object.keys(state.contentGenerationPlans || {}).length > 0
    || state.contentIllustrationPlan
    || state.contentGenerationRuntime
    || state.contentGenerationOptions
    || state.outlineGenerationTask
    || state.globalFactsTask
    || state.contentGenerationTask
    || ['outline-generation', 'global-facts', 'content-edit', 'expand'].includes(state.step),
  );
}
