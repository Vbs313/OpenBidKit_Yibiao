// 正文生成页的进度/状态视图模型。
//
// 原本是 ContentEditPage 里约 230 行的派生 const（98 个中间量 + 21 个对外值）：
// 阶段标志、字数/小节统计、审计与配图进度、按钮文案、进度条文案……
// 它们全是「几个输入 → 一堆标量/字符串」的纯计算，抽出来后页面只剩「喂输入、取输出」。
//
// 两个 useMemo（outlineMeta / contentSummary）刻意留在页面保持缓存，作为输入传进来。

import type { BackgroundTaskState, ContentIllustrationKind, ContentIllustrationPlanState } from '../../shared/types/domains/technical-plan';
import type { OutlineContentMode, OutlineItem, OutlineWordControlOptions } from '../../shared/types';
import type { ProgressBarTone } from '../../shared/ui';
import type { OutlineNodeMeta } from './contentEditModel';
import { illustrationKinds } from './contentEditModel';

export interface ContentProgressInputs {
  running: boolean;
  pausing: boolean;
  paused: boolean;
  taskFailed: boolean;
  taskInFlight: boolean;
  phaseVisible: boolean;
  contentStats: NonNullable<BackgroundTaskState['stats']>['content'];
  progressDetail: BackgroundTaskState['progress_detail'];
  illustrationStats: Record<ContentIllustrationKind, { planned: number; success: number }>;
  contentIllustrationPlan: ContentIllustrationPlanState | null | undefined;
  task: BackgroundTaskState | undefined;
  outlineWordControlSnapshot: OutlineWordControlOptions | undefined;
  planning: boolean;
  developerMode: boolean;
  outlineMeta: Map<string, OutlineNodeMeta>;
  contentSummary: { completedCount: number; failedCount: number; ignoredCount: number; totalWords: number };
  leaves: OutlineItem[];
  allLeaves: OutlineItem[];
  selectedItem: OutlineItem | null;
  selectedIsLeaf: boolean;
  editingItemId: string | null;
}

export function buildContentProgressViewModel(input: ContentProgressInputs) {
  const {
    planning,
    task,
    outlineWordControlSnapshot,
    running,
    pausing,
    paused,
    taskFailed,
    taskInFlight,
    phaseVisible,
    contentStats,
    progressDetail,
    illustrationStats,
    contentIllustrationPlan,
    developerMode,
    outlineMeta,
    contentSummary,
    leaves,
    allLeaves,
    selectedItem,
    selectedIsLeaf,
    editingItemId,
  } = input;

  const { completedCount, failedCount, ignoredCount, totalWords } = contentSummary;

  const illustrationPlannedTotal = illustrationKinds.reduce((sum, kind) => sum + illustrationStats[kind].planned, 0);
  const illustrationSuccessTotal = illustrationKinds.reduce((sum, kind) => sum + illustrationStats[kind].success, 0);
  const showIllustrationStats = developerMode && Boolean(contentIllustrationPlan);
  const restoring = phaseVisible && contentStats?.phase === 'restoring';
  const sectionWordAdjusting = phaseVisible && contentStats?.phase === 'section-word-adjusting';
  const finalSectionWordAdjusting = phaseVisible && contentStats?.phase === 'final-section-word-adjusting';
  const totalWordAdjusting = phaseVisible && contentStats?.phase === 'total-word-adjusting';
  const originalAuditing = phaseVisible && contentStats?.phase === 'original-auditing';
  const auditing = phaseVisible && contentStats?.phase === 'auditing';
  const tableCleaning = phaseVisible && contentStats?.phase === 'table-cleaning';
  const contentCorrecting = originalAuditing || auditing || tableCleaning;
  const illustrationPlanning = phaseVisible && contentStats?.phase === 'illustration-planning';
  const illustrationGenerating = phaseVisible && contentStats?.phase === 'illustration-generating';

  const resolvedCount = completedCount + ignoredCount;
  const unresolvedCount = Math.max(0, leaves.length - resolvedCount);
  const modeCounts = allLeaves.reduce<Record<OutlineContentMode, number>>((counts, item) => {
    if (item.content_mode) counts[item.content_mode] += 1;
    return counts;
  }, { 'ai-generate': 0, 'template-fill': 0, 'point-to-point': 0, other: 0 });
  const pendingCount = modeCounts['template-fill'] + modeCounts['point-to-point'] + modeCounts.other;
  const progress = leaves.length ? Math.round((resolvedCount / leaves.length) * 100) : 0;
  const planningTotal = contentStats?.planning_total || leaves.length;
  const planningCompleted = contentStats?.planning_completed || 0;
  const planningProgress = planningTotal ? Math.round((planningCompleted / planningTotal) * 100) : 0;
  const minimumWords = contentStats?.minimum_words ?? outlineWordControlSnapshot?.minimumWords ?? 0;
  const maximumWords = contentStats?.maximum_words ?? outlineWordControlSnapshot?.maximumWords ?? 0;
  const currentWords = contentStats?.current_words ?? totalWords;
  const sectionAdjustmentTotal = contentStats?.section_adjustment_total || 0;
  const sectionAdjustmentCompleted = contentStats?.section_adjustment_completed || 0;
  const sectionAdjustmentActiveCount = contentStats?.section_adjustment_active_count || 0;
  const sectionAdjustmentItemId = contentStats?.section_adjustment_item_id || '';
  const sectionAdjustmentRound = contentStats?.section_adjustment_round || 0;
  const sectionAdjustmentRoundTotal = contentStats?.section_adjustment_round_total || 3;
  const sectionAdjustmentCurrentWords = sectionAdjustmentItemId ? outlineMeta.get(sectionAdjustmentItemId)?.words || 0 : 0;
  const totalAdjustmentRound = contentStats?.total_adjustment_round || 0;
  const totalAdjustmentRoundTotal = contentStats?.total_adjustment_round_total || 3;
  const totalAdjustmentRoundText = contentStats?.total_adjustment_mode === 'expand'
    ? `第 ${totalAdjustmentRound} 轮`
    : `第 ${totalAdjustmentRound}/${totalAdjustmentRoundTotal} 轮`;
  const totalAdjustmentBatchTotal = contentStats?.total_adjustment_batch_total || 0;
  const totalAdjustmentBatchCompleted = contentStats?.total_adjustment_batch_completed || 0;
  const totalAdjustmentBatchFailed = contentStats?.total_adjustment_batch_failed || 0;
  const totalAdjustmentActiveCount = contentStats?.total_adjustment_active_count || 0;
  const totalAdjustmentItemId = contentStats?.total_adjustment_item_id || '';
  const totalAdjustmentRemainingWords = contentStats?.total_adjustment_remaining_words || 0;
  const canRetryContentCorrection = taskFailed
    && leaves.length > 0
    && resolvedCount === leaves.length
    && ['original-auditing', 'auditing', 'table-cleaning', 'final-section-word-adjusting', 'total-word-adjusting', 'illustration-planning', 'illustration-generating'].includes(String(contentStats?.phase || ''));
  const awaitingContentDecision = taskFailed && Boolean(contentStats?.awaiting_content_decision);
  const generationStrategyLocked = paused;
  const retryingIllustrationPlanning = canRetryContentCorrection && contentStats?.phase === 'illustration-planning';
  const retryingIllustrationGeneration = canRetryContentCorrection && contentStats?.phase === 'illustration-generating';
  const contentRetryTargetLabel = retryingIllustrationGeneration
    ? '图片生成'
    : retryingIllustrationPlanning
      ? '全文图片编排'
      : '内容矫正';
  const latestTaskLog = task?.logs?.[task.logs.length - 1] || '';
  const taskErrorMessage = task?.error || latestTaskLog || '正文生成任务失败';
  const auditGroupTotal = contentStats?.audit_group_total || 0;
  const auditGroupCompleted = contentStats?.audit_group_completed || 0;
  const auditConflictTotal = contentStats?.audit_conflict_total || 0;
  const auditFixTotal = contentStats?.audit_fix_total || 0;
  const auditFixCompleted = contentStats?.audit_fix_completed || 0;
  const auditFixFailed = contentStats?.audit_fix_failed || 0;
  const auditAgentMode = contentStats?.audit_repair_mode === 'agent';
  const auditAgentStepTotal = contentStats?.audit_agent_step_total || 0;
  const auditAgentStepCompleted = contentStats?.audit_agent_step_completed || 0;
  const auditAgentStepLabel = contentStats?.audit_agent_step_label || '';
  const auditAgentChangedSections = contentStats?.audit_agent_changed_sections || 0;
  const auditAgentFailedSections = contentStats?.audit_agent_failed_sections || 0;
  const auditProgress = auditAgentMode && auditAgentStepTotal
    ? Math.round((auditAgentStepCompleted / auditAgentStepTotal) * 100)
    : auditFixTotal
    ? Math.round((auditFixCompleted / auditFixTotal) * 100)
    : auditGroupTotal
      ? Math.round((auditGroupCompleted / auditGroupTotal) * 100)
      : 0;
  const tableCleanupTotal = contentStats?.table_cleanup_total || 0;
  const tableCleanupCompleted = contentStats?.table_cleanup_completed || 0;
  const tableCleanupRewritten = contentStats?.table_cleanup_rewritten || 0;
  const tableCleanupSkipped = contentStats?.table_cleanup_skipped || 0;
  const tableCleanupProgress = tableCleanupTotal ? Math.round((tableCleanupCompleted / tableCleanupTotal) * 100) : 0;
  const auditCorrectionCount = auditFixTotal
    ? `${auditFixCompleted}/${auditFixTotal}`
    : auditAgentMode && auditAgentStepTotal
      ? `${auditAgentStepCompleted}/${auditAgentStepTotal}`
      : auditGroupTotal
        ? `${auditGroupCompleted}/${auditGroupTotal}`
        : '检查中';
  const contentCorrectionProgress = tableCleaning ? tableCleanupProgress : auditProgress;
  const contentCorrectionCount = tableCleaning
    ? tableCleanupTotal ? `${tableCleanupCompleted}/${tableCleanupTotal}` : '检查中'
    : auditCorrectionCount;
  const illustrationPlanningStepTotal = contentStats?.illustration_planning_step_total || 3;
  const illustrationPlanningStepCompleted = contentStats?.illustration_planning_step_completed || 0;
  const illustrationPlanningStepLabel = contentStats?.illustration_planning_step_label || '';
  const illustrationCandidateTotal = (contentStats?.illustration_candidate_html || 0)
    + (contentStats?.illustration_candidate_mermaid || 0)
    + (contentStats?.illustration_candidate_ai || 0);
  const illustrationSelectedTotal = (contentStats?.illustration_selected_html || 0)
    + (contentStats?.illustration_selected_mermaid || 0)
    + (contentStats?.illustration_selected_ai || 0);
  const illustrationPlanningProgress = Math.round((illustrationPlanningStepCompleted / illustrationPlanningStepTotal) * 100);
  const illustrationGenerationTotal = contentStats?.illustration_generation_total || 0;
  const illustrationGenerationCompleted = contentStats?.illustration_generation_completed || 0;
  const illustrationGenerationProgress = illustrationGenerationTotal ? Math.round((illustrationGenerationCompleted / illustrationGenerationTotal) * 100) : 0;
  const illustrationGenerationStepLabel = contentStats?.illustration_generation_step_label || '';
  const illustrationGenerationCount = `HTML ${contentStats?.illustration_generation_html_completed || 0}/${contentStats?.illustration_generation_html_total || 0}，Mermaid ${contentStats?.illustration_generation_mermaid_completed || 0}/${contentStats?.illustration_generation_mermaid_total || 0}，AI ${contentStats?.illustration_generation_ai_completed || 0}/${contentStats?.illustration_generation_ai_total || 0}`;
  const wordTargetText = minimumWords > 0 && maximumWords > 0 ? `${minimumWords} 至 ${maximumWords} 字` : minimumWords > 0 ? `不少于 ${minimumWords} 字` : maximumWords > 0 ? `不超过 ${maximumWords} 字` : '未限制';
  const wordAdjusting = sectionWordAdjusting || finalSectionWordAdjusting || totalWordAdjusting;
  const sectionAdjustmentProgress = sectionAdjustmentTotal ? Math.round((sectionAdjustmentCompleted / sectionAdjustmentTotal) * 100) : 0;
  const totalAdjustmentProgress = Math.min(100, Math.round((((Math.max(1, totalAdjustmentRound) - 1) + (totalAdjustmentBatchTotal ? totalAdjustmentBatchCompleted / totalAdjustmentBatchTotal : 0)) / totalAdjustmentRoundTotal) * 100));
  const currentProgressDetail = phaseVisible && progressDetail?.phase === contentStats?.phase ? progressDetail : undefined;
  const displayProgress = currentProgressDetail ? currentProgressDetail.phase_progress : planning ? planningProgress : sectionWordAdjusting || finalSectionWordAdjusting ? sectionAdjustmentProgress : totalWordAdjusting ? totalAdjustmentProgress : contentCorrecting ? contentCorrectionProgress : illustrationPlanning ? illustrationPlanningProgress : illustrationGenerating ? illustrationGenerationProgress : progress;
  const displayProgressLabel = currentProgressDetail ? currentProgressDetail.phase_label : planning ? '编排统计' : restoring ? '原方案还原' : sectionWordAdjusting ? '小节字数调整' : finalSectionWordAdjusting ? '最终小节复核' : totalWordAdjusting ? '全文字数调整' : contentCorrecting ? '内容矫正' : illustrationPlanning ? '图片编排' : illustrationGenerating ? '图片生成' : '生成统计';
  const displayProgressCount = planning
    ? `${planningCompleted}/${planningTotal}`
    : restoring && currentProgressDetail
      ? `${currentProgressDetail.completed}/${currentProgressDetail.total}`
    : sectionWordAdjusting || finalSectionWordAdjusting
      ? `${sectionAdjustmentCompleted}/${sectionAdjustmentTotal}`
      : totalWordAdjusting
        ? `${currentWords} 字`
        : contentCorrecting
          ? contentCorrectionCount
          : illustrationPlanning
            ? `${illustrationPlanningStepCompleted}/${illustrationPlanningStepTotal}`
            : illustrationGenerating
              ? `${illustrationGenerationCompleted}/${illustrationGenerationTotal}`
            : `${resolvedCount}/${leaves.length}`;
  const progressPhaseLabel = currentProgressDetail ? currentProgressDetail.phase_label : planning ? '正文编排' : restoring ? '原方案还原' : sectionWordAdjusting ? '小节字数调整' : finalSectionWordAdjusting ? '最终小节复核' : totalWordAdjusting ? '全文字数调整' : contentCorrecting ? '内容矫正' : illustrationPlanning ? '全文图片编排' : illustrationGenerating ? '全文图片生成' : '正文生成';
  // 显式标注：这个值直接喂给 ProgressBar 的 tone，收窄成它认的字面量联合，避免被推断成 string。
  const progressTone: ProgressBarTone = planning
    ? 'success'
    : wordAdjusting
      ? 'warning'
      : contentCorrecting
        ? 'sky'
        : illustrationPlanning || illustrationGenerating
          ? 'violet'
          : 'primary';
  const progressActive = taskInFlight && (planning || restoring || wordAdjusting || contentCorrecting || illustrationPlanning || illustrationGenerating);
  const progressDescription = taskFailed
    ? taskErrorMessage
    : planning
    ? paused ? `正文生成已暂停在编排阶段，已完成 ${planningCompleted}/${planningTotal} 个小节。` : `正在编排正文结构，已完成 ${planningCompleted}/${planningTotal} 个小节。`
    : restoring
      ? paused
        ? `正文生成已暂停在原方案还原阶段，已完成 ${progressDetail?.completed || 0}/${progressDetail?.total || 0} 个小节。`
        : `${progressDetail?.step_label || '正在还原原方案内容'}，已完成 ${progressDetail?.completed || 0}/${progressDetail?.total || 0} 个小节。`
    : sectionWordAdjusting
      ? paused
        ? `小节字数调整已暂停，已完成 ${sectionAdjustmentCompleted}/${sectionAdjustmentTotal} 个小节。`
        : sectionAdjustmentActiveCount > 1
          ? `正在并发调整 ${sectionAdjustmentActiveCount} 个小节，已完成 ${sectionAdjustmentCompleted}/${sectionAdjustmentTotal} 个小节。`
          : `正在进行小节字数调整：${sectionAdjustmentItemId || '当前小节'}，第 ${sectionAdjustmentRound}/${sectionAdjustmentRoundTotal} 轮，当前约 ${sectionAdjustmentCurrentWords} 字。`
      : finalSectionWordAdjusting
        ? paused
          ? `最终小节复核已暂停，已完成 ${sectionAdjustmentCompleted}/${sectionAdjustmentTotal} 个小节。`
          : sectionAdjustmentActiveCount > 1
            ? `正在并发进行最终小节复核，当前处理 ${sectionAdjustmentActiveCount} 个，已完成 ${sectionAdjustmentCompleted}/${sectionAdjustmentTotal} 个小节。`
            : `正在进行最终小节复核：${sectionAdjustmentItemId || '当前小节'}，第 ${sectionAdjustmentRound}/${sectionAdjustmentRoundTotal} 轮。`
        : totalWordAdjusting
          ? paused
            ? `全文字数调整已暂停，当前 ${currentWords} 字，目标 ${wordTargetText}，${totalAdjustmentRoundText}已完成 ${totalAdjustmentBatchCompleted}/${totalAdjustmentBatchTotal} 个小节。`
            : `正在进行全文字数调整，当前 ${currentWords} 字，目标 ${wordTargetText}，${totalAdjustmentRoundText}已完成 ${totalAdjustmentBatchCompleted}/${totalAdjustmentBatchTotal} 个小节，正在处理 ${totalAdjustmentActiveCount} 个${totalAdjustmentItemId ? `（最近：${totalAdjustmentItemId}）` : ''}${totalAdjustmentBatchFailed ? `，失败 ${totalAdjustmentBatchFailed} 个` : ''}${totalAdjustmentRemainingWords ? `，仍需调整约 ${totalAdjustmentRemainingWords} 字` : ''}。`
        : originalAuditing
            ? paused
              ? auditAgentMode
                ? `内容矫正已暂停在原方案覆盖 Agent 修复阶段，步骤 ${auditAgentStepCompleted}/${auditAgentStepTotal}。${auditAgentStepLabel}`
                : `内容矫正已暂停在原方案覆盖检查阶段，审计 ${auditGroupCompleted}/${auditGroupTotal} 个小节，修复 ${auditFixCompleted}/${auditFixTotal} 个小节。`
              : auditAgentMode
                ? auditAgentFailedSections
                  ? `原方案覆盖 Agent 修复未完成：${auditAgentFailedSections} 个小节需人工核对，任务将继续进入后续流程。`
                  : auditAgentStepCompleted >= auditAgentStepTotal && auditAgentChangedSections
                    ? `原方案覆盖 Agent 修复完成：已回写 ${auditAgentChangedSections} 个小节。`
                    : `正在内容矫正：${auditAgentStepLabel || 'Agent 正在检查并补回原方案内容'}，步骤 ${auditAgentStepCompleted}/${auditAgentStepTotal || 5}。`
                : auditFixTotal
                ? `正在内容矫正：补写原方案缺失内容，已完成 ${auditFixCompleted}/${auditFixTotal} 个小节${auditFixFailed ? `，${auditFixFailed} 个需人工核对` : ''}。`
                : `正在内容矫正：检查原方案覆盖情况，已完成 ${auditGroupCompleted}/${auditGroupTotal} 个小节${auditConflictTotal ? `，发现 ${auditConflictTotal} 个需核对来源段` : ''}。`
          : auditing
            ? paused
              ? auditAgentMode
                ? `内容矫正已暂停在 Agent 全文一致性修复阶段，步骤 ${auditAgentStepCompleted}/${auditAgentStepTotal}。${auditAgentStepLabel}`
                : `内容矫正已暂停在全文一致性检查阶段，审计 ${auditGroupCompleted}/${auditGroupTotal} 组，修复 ${auditFixCompleted}/${auditFixTotal} 个小节。`
              : auditAgentMode
                ? auditAgentStepCompleted >= auditAgentStepTotal && auditAgentChangedSections
                  ? `Agent 一致性修复完成：已回写 ${auditAgentChangedSections} 个小节。`
                  : `正在内容矫正：${auditAgentStepLabel || 'Agent 正在审计并修复全文'}，步骤 ${auditAgentStepCompleted}/${auditAgentStepTotal || 5}。`
                : auditFixTotal
                ? `正在内容矫正：修复一致性冲突，已完成 ${auditFixCompleted}/${auditFixTotal} 个小节${auditFixFailed ? `，${auditFixFailed} 个需人工核对` : ''}。`
                : `正在内容矫正：检查全文一致性，已完成 ${auditGroupCompleted}/${auditGroupTotal} 组${auditConflictTotal ? `，发现 ${auditConflictTotal} 个冲突小节` : ''}。`
            : tableCleaning
              ? paused
                ? `内容矫正已暂停在表格清理阶段，已处理 ${tableCleanupCompleted}/${tableCleanupTotal} 个表格。`
                : tableCleanupTotal
                  ? `正在内容矫正：将表格转换为普通文字描述，已处理 ${tableCleanupCompleted}/${tableCleanupTotal} 个表格，已转换 ${tableCleanupRewritten} 个${tableCleanupSkipped ? `，跳过 ${tableCleanupSkipped} 个` : ''}。`
                  : '正在内容矫正：检查正文中是否存在需要转换的表格。'
              : illustrationPlanning
                ? paused
                  ? `正文生成已暂停在全文图片编排阶段，步骤 ${illustrationPlanningStepCompleted}/${illustrationPlanningStepTotal}。${illustrationPlanningStepLabel}`
                  : `${illustrationPlanningStepLabel || 'Agent 正在阅读全文并编排图片'}，步骤 ${illustrationPlanningStepCompleted}/${illustrationPlanningStepTotal}${illustrationCandidateTotal ? `，候选 ${illustrationCandidateTotal} 项，保留 ${illustrationSelectedTotal} 项` : ''}。`
                : illustrationGenerating
                  ? paused
                    ? `正文生成已暂停在图片生成阶段，已完成 ${illustrationGenerationCompleted}/${illustrationGenerationTotal} 项。${illustrationGenerationCount}`
                    : `${illustrationGenerationStepLabel || '正在根据最终正文生成图片'}，已完成 ${illustrationGenerationCompleted}/${illustrationGenerationTotal} 项。${illustrationGenerationCount}`
                : pausing
                  ? '正在暂停正文生成，已发出的 AI 请求完成后会停止调度新任务。'
                  : running
                    ? latestTaskLog || '正文生成任务正在运行。'
                    : paused
                      ? '正文生成已暂停，可导出当前已完成内容或点击继续。'
                      : resolvedCount
                        ? `已生成 ${completedCount} 个小节${ignoredCount ? `，已忽略 ${ignoredCount} 个小节` : ''}，共 ${totalWords} 字。`
                        : '点击生成正文后，目录会实时显示每个小节状态。';
  const selectedStatus = selectedItem ? outlineMeta.get(selectedItem.id)?.status || 'idle' : 'idle';
  const generationButtonLabel = pausing
    ? '正在暂停中...'
    : running
      ? '暂停'
      : paused
        ? '继续'
        : canRetryContentCorrection
          ? `重试${contentRetryTargetLabel}`
          : resolvedCount === leaves.length && leaves.length
              ? '重新生成正文'
              : completedCount > 0
                ? '继续生成正文'
                : '生成正文';
  const editing = Boolean(selectedItem && selectedIsLeaf && editingItemId === selectedItem.id);

  return {
    illustrationPlannedTotal,
    illustrationSuccessTotal,
    showIllustrationStats,
    resolvedCount,
    unresolvedCount,
    modeCounts,
    pendingCount,
    canRetryContentCorrection,
    awaitingContentDecision,
    generationStrategyLocked,
    contentRetryTargetLabel,
    displayProgress,
    displayProgressLabel,
    displayProgressCount,
    progressPhaseLabel,
    progressTone,
    progressActive,
    progressDescription,
    selectedStatus,
    generationButtonLabel,
    editing,
  };
}
