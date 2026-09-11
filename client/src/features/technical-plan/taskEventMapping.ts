// 技术方案页的「后台任务事件 → 页面状态」映射。
//
// 原本是 TechnicalPlanHome.tsx 里一个 165 行的 useEffect 内联 setState 回调；
// 它是纯数据变换（不碰 React、不发请求），抽成纯函数后副作用只剩「订阅 → 调用」。
//
// 说明：任务事件与补丁的形状由主进程 IPC 契约决定，这里只做键级合并，不做结构校验，
// 因此补丁参数声明为宽松记录类型；映射体本身逐字来自原实现。

import type { BackgroundTaskState, TechnicalPlanState } from '../../shared/types/domains/technical-plan';
import type { OutlineData, OutlineItem } from '../../shared/types';

const MAX_UI_TASK_LOGS = 80;

function hasOwnField<T extends object>(value: T, field: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

export function trimTaskLogs(task?: BackgroundTaskState): BackgroundTaskState | undefined {
  if (!task?.logs || task.logs.length <= MAX_UI_TASK_LOGS) {
    return task;
  }

  return { ...task, logs: task.logs.slice(-MAX_UI_TASK_LOGS) };
}

export function updateOutlineItemContent(items: OutlineItem[], itemId: string, content: string): OutlineItem[] {
  return items.map((item) => {
    if (item.id === itemId) {
      return { ...item, content };
    }

    return item.children?.length
      ? { ...item, children: updateOutlineItemContent(item.children, itemId, content) }
      : item;
  });
}

/** 把一次后台任务事件合并进当前页面状态；未出现在补丁里的字段保持原值。 */
export function applyTaskEventToState(
  prev: TechnicalPlanState,
  params: {
    taskType: string | undefined;
    latestTask: BackgroundTaskState | undefined;
    technicalPlan: Record<string, any>;
    event: Record<string, any>;
  },
): TechnicalPlanState {
  const { taskType, latestTask, technicalPlan, event } = params;

        if (taskType === 'bid-section-extraction') {
          return {
            ...prev,
            bidSectionExtractionTask: trimTaskLogs(technicalPlan.bidSectionExtractionTask) || latestTask,
            bidSectionMode: technicalPlan.bidSectionMode ?? prev.bidSectionMode,
            bidSections: Array.isArray(technicalPlan.bidSections) ? technicalPlan.bidSections : prev.bidSections,
            bidSectionExtractionStatus: technicalPlan.bidSectionExtractionStatus ?? prev.bidSectionExtractionStatus,
            bidSectionExtractionError: technicalPlan.bidSectionExtractionError ?? prev.bidSectionExtractionError,
            tenderFile: technicalPlan.tenderFile ?? prev.tenderFile,
            bidAnalysisTask: hasOwnField(technicalPlan, 'bidAnalysisTask') ? trimTaskLogs(technicalPlan.bidAnalysisTask) : prev.bidAnalysisTask,
            bidAnalysisTasks: hasOwnField(technicalPlan, 'bidAnalysisTasks') ? (technicalPlan.bidAnalysisTasks || {}) : prev.bidAnalysisTasks,
            bidAnalysisProgress: technicalPlan.bidAnalysisProgress ?? prev.bidAnalysisProgress,
            projectOverview: technicalPlan.projectOverview ?? prev.projectOverview,
            techRequirements: technicalPlan.techRequirements ?? prev.techRequirements,
            outlineData: hasOwnField(technicalPlan, 'outlineData') ? (technicalPlan.outlineData || null) : prev.outlineData,
            outlineWordControlSnapshot: hasOwnField(technicalPlan, 'outlineWordControlSnapshot') ? technicalPlan.outlineWordControlSnapshot : prev.outlineWordControlSnapshot,
            outlineGenerationTask: hasOwnField(technicalPlan, 'outlineGenerationTask') ? trimTaskLogs(technicalPlan.outlineGenerationTask) : prev.outlineGenerationTask,
            referenceKnowledgeDocumentIds: Array.isArray(technicalPlan.referenceKnowledgeDocumentIds) ? technicalPlan.referenceKnowledgeDocumentIds : prev.referenceKnowledgeDocumentIds,
            globalFactsTask: hasOwnField(technicalPlan, 'globalFactsTask') ? trimTaskLogs(technicalPlan.globalFactsTask) : prev.globalFactsTask,
            globalFactsAdjustmentTask: hasOwnField(technicalPlan, 'globalFactsAdjustmentTask') ? trimTaskLogs(technicalPlan.globalFactsAdjustmentTask) : prev.globalFactsAdjustmentTask,
            globalFacts: hasOwnField(technicalPlan, 'globalFacts') ? (technicalPlan.globalFacts || []) : prev.globalFacts,
            contentGenerationTask: hasOwnField(technicalPlan, 'contentGenerationTask') ? trimTaskLogs(technicalPlan.contentGenerationTask) : prev.contentGenerationTask,
            contentGenerationOptions: hasOwnField(technicalPlan, 'contentGenerationOptions') ? technicalPlan.contentGenerationOptions : prev.contentGenerationOptions,
            contentGenerationSections: hasOwnField(technicalPlan, 'contentGenerationSections') ? (technicalPlan.contentGenerationSections || {}) : prev.contentGenerationSections,
            contentGenerationPlans: hasOwnField(technicalPlan, 'contentGenerationPlans') ? (technicalPlan.contentGenerationPlans || {}) : prev.contentGenerationPlans,
            contentIllustrationPlan: hasOwnField(technicalPlan, 'contentIllustrationPlan') ? technicalPlan.contentIllustrationPlan : prev.contentIllustrationPlan,
            contentGenerationRuntime: hasOwnField(technicalPlan, 'contentGenerationRuntime') ? technicalPlan.contentGenerationRuntime : prev.contentGenerationRuntime,
          };
        }

        if (taskType === 'bid-analysis') {
          const outlineDataReset = hasOwnField(technicalPlan, 'outlineData') && technicalPlan.outlineData === null;
          return {
            ...prev,
            bidAnalysisTask: trimTaskLogs(technicalPlan.bidAnalysisTask) || latestTask,
            bidAnalysisMode: technicalPlan.bidAnalysisMode ?? prev.bidAnalysisMode,
            bidAnalysisSelectedTaskIds: Array.isArray(technicalPlan.bidAnalysisSelectedTaskIds)
              ? technicalPlan.bidAnalysisSelectedTaskIds
              : prev.bidAnalysisSelectedTaskIds,
            bidAnalysisTasks: {
              ...prev.bidAnalysisTasks,
              ...(technicalPlan.bidAnalysisTasks || {}),
              ...(event.bidItem ? { [event.bidItem.id]: event.bidItem } : {}),
            },
            bidAnalysisProgress: technicalPlan.bidAnalysisProgress ?? prev.bidAnalysisProgress,
            projectOverview: technicalPlan.projectOverview ?? prev.projectOverview,
            techRequirements: technicalPlan.techRequirements ?? prev.techRequirements,
            outlineGenerationTask: outlineDataReset ? undefined : prev.outlineGenerationTask,
            globalFactsTask: outlineDataReset ? undefined : prev.globalFactsTask,
            globalFactsAdjustmentTask: outlineDataReset ? undefined : prev.globalFactsAdjustmentTask,
            globalFacts: outlineDataReset ? [] : prev.globalFacts,
            contentGenerationTask: outlineDataReset ? undefined : prev.contentGenerationTask,
            contentGenerationOptions: outlineDataReset ? undefined : prev.contentGenerationOptions,
            contentGenerationSections: outlineDataReset ? {} : prev.contentGenerationSections,
            contentGenerationPlans: outlineDataReset ? {} : prev.contentGenerationPlans,
            contentIllustrationPlan: outlineDataReset ? undefined : prev.contentIllustrationPlan,
            contentGenerationRuntime: outlineDataReset ? undefined : prev.contentGenerationRuntime,
            outlineWordControlSnapshot: outlineDataReset ? undefined : prev.outlineWordControlSnapshot,
            outlineData: hasOwnField(technicalPlan, 'outlineData') ? (technicalPlan.outlineData || null) : prev.outlineData,
          };
        }

        if (taskType === 'outline-generation') {
          const hasOutlineData = hasOwnField(technicalPlan, 'outlineData');
          const nextOutlineData = hasOutlineData ? (technicalPlan.outlineData || null) : prev.outlineData;
          const outlineDataChanged = nextOutlineData !== prev.outlineData;

          return {
            ...prev,
            outlineGenerationTask: trimTaskLogs(technicalPlan.outlineGenerationTask) || latestTask,
            outlineMode: technicalPlan.outlineMode ?? prev.outlineMode,
            outlineExpansionMode: technicalPlan.outlineExpansionMode ?? prev.outlineExpansionMode,
            outlineWordControlOptions: technicalPlan.outlineWordControlOptions ?? prev.outlineWordControlOptions,
            outlineWordControlSnapshot: hasOwnField(technicalPlan, 'outlineWordControlSnapshot') ? technicalPlan.outlineWordControlSnapshot : prev.outlineWordControlSnapshot,
            referenceKnowledgeDocumentIds: Array.isArray(technicalPlan.referenceKnowledgeDocumentIds)
              ? technicalPlan.referenceKnowledgeDocumentIds
              : prev.referenceKnowledgeDocumentIds,
            outlineData: nextOutlineData,
            globalFactsTask: hasOwnField(technicalPlan, 'globalFactsTask') ? trimTaskLogs(technicalPlan.globalFactsTask) : prev.globalFactsTask,
            globalFactsAdjustmentTask: hasOwnField(technicalPlan, 'globalFactsAdjustmentTask') ? trimTaskLogs(technicalPlan.globalFactsAdjustmentTask) : prev.globalFactsAdjustmentTask,
            globalFacts: hasOwnField(technicalPlan, 'globalFacts') ? (technicalPlan.globalFacts || []) : prev.globalFacts,
            contentGenerationTask: hasOwnField(technicalPlan, 'contentGenerationTask') ? trimTaskLogs(technicalPlan.contentGenerationTask) : (outlineDataChanged ? undefined : prev.contentGenerationTask),
            contentGenerationSections: hasOwnField(technicalPlan, 'contentGenerationSections') ? (technicalPlan.contentGenerationSections || {}) : (outlineDataChanged ? {} : prev.contentGenerationSections),
            contentGenerationPlans: hasOwnField(technicalPlan, 'contentGenerationPlans') ? (technicalPlan.contentGenerationPlans || {}) : (outlineDataChanged ? {} : prev.contentGenerationPlans),
            contentIllustrationPlan: hasOwnField(technicalPlan, 'contentIllustrationPlan') ? technicalPlan.contentIllustrationPlan : (outlineDataChanged ? undefined : prev.contentIllustrationPlan),
            contentGenerationRuntime: hasOwnField(technicalPlan, 'contentGenerationRuntime') ? technicalPlan.contentGenerationRuntime : (outlineDataChanged ? undefined : prev.contentGenerationRuntime),
            bidTemplateExists: hasOwnField(technicalPlan, 'bidTemplateExists') ? Boolean(technicalPlan.bidTemplateExists) : prev.bidTemplateExists,
          };
        }

        if (taskType === 'outline-adjustment') {
          const hasOutlineData = hasOwnField(technicalPlan, 'outlineData');
          return {
            ...prev,
            outlineAdjustmentTask: trimTaskLogs(technicalPlan.outlineAdjustmentTask) || latestTask,
            outlineData: hasOutlineData ? (technicalPlan.outlineData || null) : prev.outlineData,
            contentGenerationTask: hasOwnField(technicalPlan, 'contentGenerationTask') ? trimTaskLogs(technicalPlan.contentGenerationTask) : prev.contentGenerationTask,
            contentGenerationSections: hasOwnField(technicalPlan, 'contentGenerationSections') ? (technicalPlan.contentGenerationSections || {}) : prev.contentGenerationSections,
            contentGenerationPlans: hasOwnField(technicalPlan, 'contentGenerationPlans') ? (technicalPlan.contentGenerationPlans || {}) : prev.contentGenerationPlans,
            contentIllustrationPlan: hasOwnField(technicalPlan, 'contentIllustrationPlan') ? technicalPlan.contentIllustrationPlan : prev.contentIllustrationPlan,
            contentGenerationRuntime: hasOwnField(technicalPlan, 'contentGenerationRuntime') ? technicalPlan.contentGenerationRuntime : prev.contentGenerationRuntime,
          };
        }

        if (taskType === 'global-facts-generation') {
          const hasGlobalFacts = hasOwnField(technicalPlan, 'globalFacts');
          return {
            ...prev,
            globalFactsTask: trimTaskLogs(technicalPlan.globalFactsTask) || latestTask,
            globalFactsAdjustmentTask: hasOwnField(technicalPlan, 'globalFactsAdjustmentTask') ? trimTaskLogs(technicalPlan.globalFactsAdjustmentTask) : prev.globalFactsAdjustmentTask,
            globalFacts: hasGlobalFacts ? (technicalPlan.globalFacts || []) : prev.globalFacts,
            contentGenerationTask: hasOwnField(technicalPlan, 'contentGenerationTask') ? trimTaskLogs(technicalPlan.contentGenerationTask) : prev.contentGenerationTask,
            contentGenerationSections: hasOwnField(technicalPlan, 'contentGenerationSections') ? (technicalPlan.contentGenerationSections || {}) : prev.contentGenerationSections,
            contentGenerationPlans: hasOwnField(technicalPlan, 'contentGenerationPlans') ? (technicalPlan.contentGenerationPlans || {}) : prev.contentGenerationPlans,
            contentIllustrationPlan: hasOwnField(technicalPlan, 'contentIllustrationPlan') ? technicalPlan.contentIllustrationPlan : prev.contentIllustrationPlan,
            contentGenerationRuntime: hasOwnField(technicalPlan, 'contentGenerationRuntime') ? technicalPlan.contentGenerationRuntime : prev.contentGenerationRuntime,
          };
        }

        if (taskType === 'global-facts-adjustment') {
          const hasGlobalFacts = hasOwnField(technicalPlan, 'globalFacts');
          return {
            ...prev,
            globalFactsAdjustmentTask: trimTaskLogs(technicalPlan.globalFactsAdjustmentTask) || latestTask,
            globalFacts: hasGlobalFacts ? (technicalPlan.globalFacts || []) : prev.globalFacts,
            contentGenerationTask: hasOwnField(technicalPlan, 'contentGenerationTask') ? trimTaskLogs(technicalPlan.contentGenerationTask) : prev.contentGenerationTask,
            contentGenerationSections: hasOwnField(technicalPlan, 'contentGenerationSections') ? (technicalPlan.contentGenerationSections || {}) : prev.contentGenerationSections,
            contentGenerationPlans: hasOwnField(technicalPlan, 'contentGenerationPlans') ? (technicalPlan.contentGenerationPlans || {}) : prev.contentGenerationPlans,
            contentIllustrationPlan: hasOwnField(technicalPlan, 'contentIllustrationPlan') ? technicalPlan.contentIllustrationPlan : prev.contentIllustrationPlan,
            contentGenerationRuntime: hasOwnField(technicalPlan, 'contentGenerationRuntime') ? technicalPlan.contentGenerationRuntime : prev.contentGenerationRuntime,
          };
        }

        if (taskType === 'content-generation') {
          const hasPatchOutlineData = hasOwnField(technicalPlan, 'outlineData') || hasOwnField(event, 'outlineData');
          const patchOutlineData = hasOwnField(technicalPlan, 'outlineData') ? technicalPlan.outlineData : event.outlineData;
          const contentSection = event.contentSection;
          const nextSections = hasOwnField(technicalPlan, 'contentGenerationSections')
            ? (technicalPlan.contentGenerationSections || {})
            : contentSection
              ? { ...prev.contentGenerationSections, [contentSection.id]: contentSection }
              : prev.contentGenerationSections;
          const nextOutlineData = hasPatchOutlineData
            ? (patchOutlineData || null)
            : contentSection?.content !== undefined && prev.outlineData
              ? { ...prev.outlineData, outline: updateOutlineItemContent(prev.outlineData.outline, contentSection.id, contentSection.content) }
              : prev.outlineData;
          return {
            ...prev,
            contentGenerationTask: latestTask || trimTaskLogs(technicalPlan.contentGenerationTask),
            outlineWordControlSnapshot: hasOwnField(technicalPlan, 'outlineWordControlSnapshot') ? technicalPlan.outlineWordControlSnapshot : prev.outlineWordControlSnapshot,
            outlineMode: technicalPlan.outlineMode ?? prev.outlineMode,
            referenceKnowledgeDocumentIds: Array.isArray(technicalPlan.referenceKnowledgeDocumentIds)
              ? technicalPlan.referenceKnowledgeDocumentIds
              : prev.referenceKnowledgeDocumentIds,
            contentGenerationSections: nextSections,
            contentGenerationPlans: hasOwnField(technicalPlan, 'contentGenerationPlans') ? (technicalPlan.contentGenerationPlans || {}) : prev.contentGenerationPlans,
            contentIllustrationPlan: hasOwnField(technicalPlan, 'contentIllustrationPlan') ? technicalPlan.contentIllustrationPlan : prev.contentIllustrationPlan,
            contentGenerationRuntime: hasOwnField(technicalPlan, 'contentGenerationRuntime') ? technicalPlan.contentGenerationRuntime : prev.contentGenerationRuntime,
            outlineData: nextOutlineData,
          };
        }

        return prev;
}
