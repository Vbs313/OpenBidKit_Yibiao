const {
  ILLUSTRATION_PLAN_VERSION,
  buildIllustrationPlanningContext,
  buildIllustrationPlanningPrompt,
  resolveIllustrationPlan,
} = require('./../contentIllustrationPlanning.cjs');
const {
  HTML_AGENT_THRESHOLD_CHARS,
  applyGeneratedIllustrationsToDocument,
  buildIllustrationExecutionContexts,
  generateAiIllustration,
  generateHtmlIllustration,
  generateMermaidIllustration,
  stripGeneratedIllustrationsFromDocument,
} = require('./../contentIllustrationGeneration.cjs');
const { applyRangeEdits } = require('./../../utils/textEdit.cjs');
const {
  validateContentPlan,
  validateOriginalRestoreAssignments,
  validateContentExpansionPatch,
  validateConsistencyAuditResponse,
} = require('./generation/validators.cjs');

const {
  progressFor,
  clampPercentage,
  percentageFor,
  buildContentPhaseProgress,
  buildContentOverallProgress,
  taskStatusFor,
  isUnresolvedContentSection,
} = require('./generation/progress.cjs');

const {
  textHash,
  textMetrics,
  formatContentWithLineNumbers,
  findExactOccurrences,
  extractLineRangeText,
  replaceLineRange,
  describeConsistencyPatchMatch,
  applyExactConsistencyPatch,
  applyConsistencyRepairPatches,
  findContentExpansionNeedleRanges,
  findContentExpansionTargetTextMatch,
  applyContentExpansionPatch,
} = require('./generation/textEdits.cjs');

const {
  splitOriginalPlanSegments,
  buildAgentOriginalMaterialRestorePrompt,
  buildAgentOriginalMaterialRestoreFiles,
  buildAgentRestoredChapterContentPrompt,
  buildAgentRestoredChapterContentFiles,
  parseAgentJsonContent,
  escapeSectionAttribute,
  parseAgentSectionMarkdown,
} = require('./generation/agentRestore.cjs');

const {
  ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS,
  normalizeOriginalCoverageAuditResponse,
  validateOriginalCoverageAuditResponse,
  buildOriginalCoverageRepairMessages,
} = require('./generation/originalCoverage.cjs');

const {
  collectLeafContexts,
  loadContentKnowledgeReferences,
  resolveKnowledgeContents,
  resolveSelectedFactsText,
  updateOutlineItemContent,
  clearOutlineContent,
} = require('./generation/knowledgeResolution.cjs');

const {
  collectFencedCodeRanges,
  extractContentTableBlocks,
  containsContentTable,
  createTableCleanupBatches,
} = require('./generation/tableExtraction.cjs');

const {
  AGENT_CONTEXT_THRESHOLD_RATIO,
  getMessagesContentLength,
  getTextContextLengthLimit,
  shouldUseAgentForMessages,
  normalizeContentConcurrency,
  normalizeImageConcurrency,
  isDeveloperModeEnabled,
  createContentDeveloperLogger,
  countContentWords,
} = require('./generation/aiCallContext.cjs');

const {
  computeGenerationWordTarget,
  createStoredContentPlan,
  normalizeStoredContentPlan,
  isStoredContentPlanReusableForTableRequirement,
  pruneContentGenerationPlans,
} = require('./generation/storedPlan.cjs');

const {
  validateWordAdjustmentResponse,
  applyWordAdjustmentOperations,
} = require('./generation/wordAdjustment.cjs');

const {
  isAiQueueScopePausedError,
  isContentGenerationPausedError,
  isPauseLikeError,
  createContentGenerationPausedError,
  selectRandomItemIds,
  runItemsWithWorkerPool,
  createInitialSections,
  withSection,
} = require('./generation/taskRuntime.cjs');
const { createTableCleanupStage } = require('./generation/stages/tableCleanup.cjs');
const {
  buildAgentConsistencySectionIndex,
  buildAgentTechnicalPlanMarkdown,
  buildAgentGlobalFactsMarkdown,
  buildAgentConsistencyRepairPrompt,
  validateAgentConsistencySections,
} = require('./generation/agentWorkspace.cjs');
const { createAgentSectionWriter } = require('./generation/agentWorkspace.cjs');
const {
  isSectionWordsOutsideRange,
  getTotalWordDirection,
  buildTotalWordAdjustmentBatch,
} = require('./generation/wordBatching.cjs');
const { createContentWordStats } = require('./generation/contentWordStats.cjs');
const { createConsistencyAuditStage } = require('./generation/stages/consistencyAudit.cjs');
const { createAgentRun } = require('./generation/agentRun.cjs');
const { createOriginalCoverageAuditStage } = require('./generation/stages/originalCoverageAudit.cjs');
const { createAgentConsistencyAuditStage } = require('./generation/stages/agentConsistencyAudit.cjs');
const { createIllustrationStage } = require('./generation/stages/illustration.cjs');

const { TABLE_REQUIREMENT_LABELS } = require('./generation/markdownTables.cjs');
const {
  buildChapterContentPlanMessages,
} = require('./generation/contentMessages.cjs');
const {
  countRetainedTablePlans,
} = require('./generation/storedPlan.cjs');
const {
  CONSISTENCY_REPAIR_MAX_ATTEMPTS,
  buildConsistencyRepairMessages,
} = require('./generation/consistencyRepair.cjs');

const {
  buildContentFactCompletenessInstruction,
  appendSelectedFactsMessage,
  buildTableCleanupMessages,
  buildChapterContentMessages,
  buildRestoredChapterContentMessages,
  buildOriginalMaterialRestoreMessages,
  formatChapterPath,
  formatConsistencyAuditGroupContent,
  buildConsistencyAuditMessages,
  formatOriginalCoverageSources,
  buildOriginalCoverageAuditMessages,
  buildWordAdjustmentMessages,
} = require('./generation/contentMessages.cjs');

const {
  formatGlobalFactsForPrompt,
  formatGlobalFactTitlesForPrompt,
  formatBidAnalysisFactForPrompt,
  formatBidAnalysisFactsForPrompt,
  formatBidKeyInfoForPrompt,
  buildOriginalRestoreRepairMessages,
  buildContentExpansionRepairMessages,
  buildConsistencyAuditRepairMessages,
  buildConsistencyRepairJsonRepairMessages,
  buildOriginalCoverageAuditJsonRepairMessages,
  buildWordAdjustmentRepairMessages,
} = require('./generation/promptBuilders.cjs');

const {
  normalizeGlobalFactsMode,
  normalizeConsistencyRepairMode,
  normalizeOriginalPlanCoverageRepairMode,
  normalizeOutlineWordControlSnapshot,
  normalizeOriginalMaterial,
  normalizeContentPlan,
  normalizeTableCleanupResponse,
  normalizeContentExpansionPatch,
  normalizeNewlines,
  stripPromptLineNumbers,
  normalizeConsistencyAuditResponse,
  normalizeConsistencyRepairResponse,
  normalizeReferenceDocumentIds,
  escapeRegExp,
  stripRepeatedChapterTitle,
  normalizeLeafContentForSave,
  normalizeWordAdjustmentResponse,
  normalizeStringArray,
  normalizeContentGenerationRuntime,
  now,
} = require('./generation/normalize.cjs');

const {
  compactError,
  normalizeOriginalRestoreAssignments,
  singleLine,
  validateConsistencyRepairResponse,
} = require('./generation/agentResponse.cjs');

const {
  normalizeGeneratedMarkdown,
  normalizeTableRequirement,
  maxTablesForRequirement,
  clearContentPlanTable,
  formatTablesForCleanupPrompt,
  validateTableCleanupResponse,
  unwrapMarkdownTitle,
  stripMarkdownHeadingsFromLeafContent,
  pickDistributedTableTargets,
} = require('./generation/markdownTables.cjs');

const MAX_WORD_ADJUSTMENT_ROUNDS = 3;
// 全文扩写不限制有效轮数，仅在连续多轮没有增加字数时退出。
const MAX_EXPANSION_NO_PROGRESS_ROUNDS = 3;
const TOTAL_WORD_ADJUSTMENT_BATCH_SIZE = 10;
// 生成阶段按全文上限倒推每小节目标字数时使用的折扣系数，预留 AI 系统性偏高的缓冲，降低初稿超量概率。
// 全文缩写阶段筛选候选小节时，可缩空间至少要达到本轮单节平均预算的比例，低于此值的小节直接跳过以免空占批次名额。
const TOTAL_WORD_SHRINK_MIN_CAPACITY_RATIO = 0.3;
const CONTENT_WORD_CONTROL_WARNING = '经多轮修复，字数仍未达预期，请您人工核对';
const SECTION_WORD_CONTROL_WARNING = '字数未达预期，请您人工核对';


// 从待生成小节中无放回随机选取开发者模拟失败目标。


async function runContentGenerationTask({ aiService, agentService, workspaceStore, knowledgeBaseService, updateTask: updateManagedTask, checkpointTask: checkpointManagedTask, payload, taskControl, previousState }) {
  const resume = Boolean(payload.resume);
  const storedPlan = resume ? (previousState || {}) : (workspaceStore.loadTechnicalPlan() || {});
  const wordControl = normalizeOutlineWordControlSnapshot(storedPlan.outlineWordControlSnapshot);
  let outlineData = storedPlan.outlineData;

  if (!outlineData?.outline?.length) {
    throw new Error('请先生成目录，再生成正文');
  }

  const globalFacts = Array.isArray(storedPlan.globalFacts) ? storedPlan.globalFacts : [];
  const globalFactsText = formatGlobalFactsForPrompt(globalFacts);
  const globalFactsMode = normalizeGlobalFactsMode(storedPlan.globalFactsMode);
  if (!globalFactsText || storedPlan.globalFactsTask?.status !== 'success') {
    throw new Error('请先完成全局事实设定，再生成正文');
  }
  const globalFactTitlesText = formatGlobalFactTitlesForPrompt(globalFacts);
  const allowedFactTitles = new Set(globalFacts.map((group) => singleLine(group?.title)).filter(Boolean));
  const bidAnalysisFactsText = formatBidAnalysisFactsForPrompt(storedPlan);
  const isExpansionWorkflow = storedPlan.workflowKind === 'existing-plan-expansion';
  let originalPlanMarkdown = '';
  let originalPlanSegments = [];
  if (isExpansionWorkflow) {
    if (!storedPlan.originalPlanFile) {
      throw new Error('请先上传原方案，再生成正文');
    }
    if (!workspaceStore.readOriginalPlanMarkdown) {
      throw new Error('原方案读取服务尚未初始化');
    }
    originalPlanMarkdown = workspaceStore.readOriginalPlanMarkdown();
    if (!String(originalPlanMarkdown || '').trim()) {
      throw new Error('请先上传原方案，再生成正文');
    }
    originalPlanSegments = splitOriginalPlanSegments(originalPlanMarkdown);
    if (!originalPlanSegments.length) {
      throw new Error('原方案正文为空，无法执行已有方案扩写');
    }
  }
  const originalPlanSegmentById = new Map(originalPlanSegments.map((segment) => [segment.id, segment]));

  const projectOverview = outlineData.project_overview || storedPlan.projectOverview || '';
  const techRequirements = storedPlan.techRequirements || '';
  if (resume && storedPlan.contentGenerationTask?.status !== 'paused') {
    throw new Error('没有可继续的已暂停正文生成任务');
  }
  const retryContentCorrection = !resume && Boolean(payload.retryContentCorrection ?? payload.retry_content_correction);
  const rerunIllustrations = !resume && Boolean(payload.rerunIllustrations ?? payload.rerun_illustrations);
  const retryFailedSections = !resume && Boolean(payload.retryFailedSections ?? payload.retry_failed_sections);
  const continuePostProcessing = !resume && Boolean(payload.continuePostProcessing ?? payload.continue_post_processing);
  let contentRuntime = normalizeContentGenerationRuntime(resume || retryContentCorrection || retryFailedSections || continuePostProcessing
    ? (storedPlan.contentGenerationRuntime || previousState?.contentGenerationRuntime)
    : {});
  const runOnlyIllustrationPlanning = rerunIllustrations
    || (resume && contentRuntime.phase === 'illustration-planning')
    || (retryContentCorrection && previousState?.contentGenerationTask?.stats?.content?.phase === 'illustration-planning');
  const runOnlyIllustrationGeneration = (resume && contentRuntime.phase === 'illustration-generating')
    || (retryContentCorrection && previousState?.contentGenerationTask?.stats?.content?.phase === 'illustration-generating');
  const runOnlyIllustrationStage = runOnlyIllustrationPlanning || runOnlyIllustrationGeneration;
  const regenerate = !resume && !retryContentCorrection && !rerunIllustrations && !retryFailedSections && !continuePostProcessing && Boolean(payload.regenerate);
  const targetItemId = resume ? contentRuntime.target_item_id : String(payload.targetItemId || '').trim();
  if (retryContentCorrection && targetItemId) {
    throw new Error('单小节重新生成不支持重试内容矫正');
  }
  const fullRegenerate = regenerate && !targetItemId;
  if (fullRegenerate) {
    workspaceStore.clearMermaidCache?.();
    outlineData = { ...outlineData, outline: clearOutlineContent(outlineData.outline) };
  }

  let leaves = collectLeafContexts(outlineData.outline)
    .filter(({ item }) => item?.content_mode === 'ai-generate');
  if (!leaves.length) {
    throw new Error('当前目录没有标记为“AI生成”的正文小节');
  }
  const regenerateRequirement = resume ? contentRuntime.regenerate_requirement : String(payload.requirement || '').trim();
  const generationOptions = retryFailedSections || continuePostProcessing
    ? storedPlan.contentGenerationOptions || {}
    : payload.generationOptions || payload.generation_options || storedPlan.contentGenerationOptions || {};
  const aiConfig = aiService.getConfig ? aiService.getConfig() : {};
  const contentConcurrency = normalizeContentConcurrency(aiConfig.concurrency_limit);
  const imageConcurrency = normalizeImageConcurrency(aiConfig.image_model?.concurrency_limit);
  const developerModeEnabled = isDeveloperModeEnabled(aiService);
  const tableRequirement = normalizeTableRequirement(generationOptions.tableRequirement ?? generationOptions.table_requirement);
  let maxTables = maxTablesForRequirement(tableRequirement, leaves.length);
  const referenceKnowledgeDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const enableConsistencyAudit = Boolean(generationOptions.enableConsistencyAudit ?? generationOptions.enable_consistency_audit ?? true);
  const requestedConsistencyRepairMode = normalizeConsistencyRepairMode(generationOptions.consistencyRepairMode ?? generationOptions.consistency_repair_mode);
  const consistencyRepairMode = targetItemId ? 'normal' : requestedConsistencyRepairMode;
  const enableOriginalPlanCoverageAudit = isExpansionWorkflow && Boolean(generationOptions.enableOriginalPlanCoverageAudit ?? generationOptions.enable_original_plan_coverage_audit ?? false);
  const requestedOriginalPlanCoverageRepairMode = isExpansionWorkflow
    ? normalizeOriginalPlanCoverageRepairMode(generationOptions.originalPlanCoverageRepairMode ?? generationOptions.original_plan_coverage_repair_mode)
    : 'agent';
  const originalPlanCoverageRepairMode = isExpansionWorkflow && !targetItemId ? requestedOriginalPlanCoverageRepairMode : 'normal';
  const contentStats = {
    phase: 'planning',
    planning_total: 0,
    planning_completed: 0,
    restoration_total: 0,
    restoration_completed: 0,
    generation_total: 0,
    generation_completed: 0,
    minimum_words: wordControl.minimumWords,
    maximum_words: wordControl.maximumWords,
    section_words: wordControl.sectionWords,
    strict_section_words: wordControl.strictSectionWords,
    current_words: 0,
    section_adjustment_total: 0,
    section_adjustment_completed: 0,
    section_adjustment_active_count: 0,
    section_adjustment_item_id: '',
    section_adjustment_round: 0,
    section_adjustment_round_total: MAX_WORD_ADJUSTMENT_ROUNDS,
    total_adjustment_round: 0,
    total_adjustment_round_total: 0,
    total_adjustment_mode: '',
    total_adjustment_batch_total: 0,
    total_adjustment_batch_completed: 0,
    total_adjustment_batch_failed: 0,
    total_adjustment_active_count: 0,
    total_adjustment_item_id: '',
    total_adjustment_remaining_words: 0,
    word_control_warning: undefined,
    audit_group_total: 0,
    audit_group_completed: 0,
    audit_step: '',
    audit_conflict_total: 0,
    audit_fix_total: 0,
    audit_fix_completed: 0,
    audit_fix_failed: 0,
    audit_repair_mode: enableConsistencyAudit ? consistencyRepairMode : '',
    audit_agent_step_total: 0,
    audit_agent_step_completed: 0,
    audit_agent_step_label: '',
    audit_agent_changed_sections: 0,
    audit_agent_failed_sections: 0,
    table_cleanup_total: 0,
    table_cleanup_completed: 0,
    table_cleanup_rewritten: 0,
    table_cleanup_skipped: 0,
    illustration_planning_step_total: 0,
    illustration_planning_step_completed: 0,
    illustration_planning_step_label: '',
    illustration_candidate_ai: 0,
    illustration_candidate_mermaid: 0,
    illustration_candidate_html: 0,
    illustration_selected_ai: 0,
    illustration_selected_mermaid: 0,
    illustration_selected_html: 0,
    illustration_generation_total: 0,
    illustration_generation_completed: 0,
    illustration_generation_ai_total: 0,
    illustration_generation_ai_completed: 0,
    illustration_generation_mermaid_total: 0,
    illustration_generation_mermaid_completed: 0,
    illustration_generation_html_total: 0,
    illustration_generation_html_completed: 0,
    illustration_generation_step_label: '',
    awaiting_content_decision: false,
    ignored_section_count: leaves.filter(({ item }) => storedPlan.contentGenerationSections?.[item.id]?.status === 'ignored').length,
  };
  contentRuntime = normalizeContentGenerationRuntime({
    ...contentRuntime,
    target_item_id: targetItemId,
    regenerate_requirement: regenerateRequirement,
  });
  const completedStages = new Set(contentRuntime.completed_stages);
  const contentPlans = new Map();
  let storedContentPlans = pruneContentGenerationPlans(fullRegenerate ? {} : storedPlan.contentGenerationPlans, leaves);
  let knowledgeItems = [];
  let allowedKnowledgeItemIds = new Set();
  let knowledgeContentMap = new Map();
  let sections = createInitialSections(leaves, fullRegenerate ? {} : storedPlan.contentGenerationSections);
  const touchedItemIds = new Set(contentRuntime.touched_item_ids);
  let tasksToRun = leaves.filter(({ item }) => {
    const section = sections[item.id];
    const content = section?.content || item.content || '';
    const originalState = getOriginalMaterialRuntimeState(item);
    return regenerate || section?.status !== 'ignored'
      && (section?.status === 'error' || !String(content).trim() || originalState.needsOptimization || originalState.needsRestoreRepair);
  });
  if (targetItemId) {
    const targetSection = sections[targetItemId];
    tasksToRun = resume && targetSection?.status === 'success' && touchedItemIds.has(targetItemId)
      ? []
      : leaves.filter(({ item }) => item.id === targetItemId);
    if (!tasksToRun.length && (!resume || targetSection?.status !== 'success')) {
      throw new Error('未找到要重新生成的正文小节');
    }
  }

  if (retryContentCorrection) {
    const successfulIds = leaves
      .filter(({ item }) => {
        const section = sections[item.id] || {};
        return section.status === 'success';
      })
      .map(({ item }) => item.id);
    const ignoredCount = leaves.filter(({ item }) => sections[item.id]?.status === 'ignored').length;
    if (successfulIds.length + ignoredCount !== leaves.length) {
      throw new Error('只有正文小节全部生成成功或已忽略后，才能重试内容矫正');
    }
    successfulIds.forEach((itemId) => touchedItemIds.add(itemId));
    tasksToRun = [];
  }

  if (retryFailedSections) {
    tasksToRun = leaves.filter(({ item }) => isUnresolvedContentSection(sections[item.id]));
  } else if (continuePostProcessing) {
    tasksToRun = [];
  }

  const simulatePartialFailures = !resume
    && !retryContentCorrection
    && !rerunIllustrations
    && !retryFailedSections
    && !continuePostProcessing
    && developerModeEnabled
    && Boolean(payload.simulatePartialFailures ?? payload.simulate_partial_failures)
    && tasksToRun.length > 1;
  const simulatedFailureCount = simulatePartialFailures
    ? Math.min(5, tasksToRun.length - 1, Math.max(1, Math.round(tasksToRun.length * 0.2)))
    : 0;
  const simulatedFailureItemIds = new Set(selectRandomItemIds(
    tasksToRun.map(({ item }) => item.id),
    simulatedFailureCount,
  ));
  contentRuntime = normalizeContentGenerationRuntime({
    ...contentRuntime,
    target_item_id: targetItemId,
    regenerate_requirement: regenerateRequirement,
  });

  const retryItemIds = new Set(tasksToRun
    .filter(({ item }) => isUnresolvedContentSection(sections[item.id]))
    .map(({ item }) => item.id));

  for (const { item } of tasksToRun) {
    const existing = sections[item.id] || {};
    const content = existing.content || item.content || '';
    sections[item.id] = {
      id: item.id,
      title: item.title || '未命名章节',
      status: 'idle',
      content,
      error: undefined,
      updated_at: now(),
    };
  }

  let runLimits = {
    maxTablesForRun: maxTables,
    retainedTableCount: 0,
  };

  function refreshRunLimits(targets = tasksToRun) {
    const taskItemIds = new Set(targets.map(({ item }) => item.id));
    maxTables = maxTablesForRequirement(tableRequirement, leaves.length);
    const retainedTableCount = maxTables === null ? 0 : countRetainedTablePlans(storedContentPlans, taskItemIds);
    runLimits = {
      maxTablesForRun: maxTables === null ? null : Math.max(0, maxTables - retainedTableCount),
      retainedTableCount,
    };
    return runLimits;
  }

  refreshRunLimits(tasksToRun);
  let logs = [retryContentCorrection
    ? `准备重试内容矫正，共 ${leaves.length} 个已生成小节。`
    : resume
      ? `继续已暂停的正文生成任务，共 ${leaves.length} 个小节。`
      : `准备生成正文，共 ${leaves.length} 个小节。`];
  if (targetItemId) {
    logs = [`准备重新生成正文小节：${targetItemId}。`];
  } else if (retryFailedSections) {
    logs = [...logs, `开始重试 ${tasksToRun.length} 个失败或未完成正文小节。`];
  } else if (continuePostProcessing) {
    logs = [...logs, '用户已确认忽略失败或未完成小节，准备直接继续后续流程。'];
  }
  if (simulatedFailureItemIds.size) {
    logs = [...logs, `开发者随机失败模式已启用：本轮将模拟 ${simulatedFailureItemIds.size} 个小节生成失败（${[...simulatedFailureItemIds].join('、')}）。`];
  }
  logs = [...logs, `文本模型并发上限：${contentConcurrency}。`];
  logs = [...logs, tableRequirement === 'heavy'
    ? '表格需求：大量，保持现有表格编排逻辑。'
    : tableRequirement === 'none'
      ? '表格需求：不要，本次正文编排不会安排表格。'
      : `表格需求：${TABLE_REQUIREMENT_LABELS[tableRequirement]}，全文最多 ${maxTables} 个表格，本轮最多新增 ${runLimits.maxTablesForRun} 个。`];
  if (wordControl.minimumWords > 0 || wordControl.maximumWords > 0 || wordControl.sectionWords > 0) {
    logs = [...logs, `目录生效字数配置：最少 ${wordControl.minimumWords || '不限制'} 字，最多 ${wordControl.maximumWords || '不限制'} 字，每小节 ${wordControl.sectionWords || '不控制'} 字。`];
  }
  logs = [...logs, enableConsistencyAudit
    ? `全文一致性审计已启用，正文扩写完成后将使用${consistencyRepairMode === 'agent' ? ' Agent 修复' : '普通修复'}检查并修复事实冲突。`
    : '全文一致性审计未启用。'];
  if (isExpansionWorkflow) {
    logs = [...logs, `已有方案扩写模式：已读取原方案并拆分为 ${originalPlanSegments.length} 个原文段。`];
    logs = [...logs, enableOriginalPlanCoverageAudit
      ? targetItemId
        ? '原方案覆盖审计已启用，本次将使用普通模式检查并修复当前小节的原文保留情况。'
        : `原方案覆盖审计已启用，本次将使用${originalPlanCoverageRepairMode === 'agent' ? ' Agent' : '普通模式'}检查并补回原文保留情况。`
      : '原方案覆盖审计未启用。'];
  }

  const progressMode = resume && storedPlan.contentGenerationTask?.progress_detail?.mode
    ? storedPlan.contentGenerationTask.progress_detail.mode
    : runOnlyIllustrationGeneration
      ? 'illustration-generation'
      : runOnlyIllustrationPlanning
        ? 'illustration'
        : retryContentCorrection
          ? 'correction'
          : targetItemId
            ? 'single'
            : 'full';
  let lastTaskProgress = resume ? Math.max(0, Number(storedPlan.contentGenerationTask?.progress) || 0) : 0;

  // 所有正文任务更新都在这里补充累计进度和当前阶段明细。
  function buildTaskUpdate(partial = {}) {
    const latestLog = (partial.logs || logs || []).at(-1) || '';
    const progressDetail = buildContentPhaseProgress(contentStats, latestLog, progressMode);
    const calculatedProgress = buildContentOverallProgress(progressMode, progressDetail, partial.status);
    lastTaskProgress = partial.status === 'success'
      ? 100
      : Math.max(lastTaskProgress, calculatedProgress);
    return {
      ...partial,
      progress: lastTaskProgress,
      progress_detail: progressDetail,
    };
  }

  function updateTask(partial = {}, workspaceState, eventPatch, options) {
    return updateManagedTask(buildTaskUpdate(partial), workspaceState, eventPatch, options);
  }

  function checkpointTask(partial = {}, workspacePartial, eventPatch) {
    return checkpointManagedTask(buildTaskUpdate(partial), workspacePartial, eventPatch);
  }

  const developerLogger = createContentDeveloperLogger(aiService, {
    name: targetItemId ? `content-generation-${targetItemId}` : 'content-generation',
    meta: {
      mode: targetItemId ? 'single-section' : 'full',
      target_item_id: targetItemId || '',
      resume,
      regenerate,
      full_regenerate: fullRegenerate,
      retry_content_correction: retryContentCorrection,
      retry_failed_sections: retryFailedSections,
      continue_post_processing: continuePostProcessing,
      leaf_count: leaves.length,
      task_count: tasksToRun.length,
      text_concurrency_limit: contentConcurrency,
      table_requirement: tableRequirement,
      word_control: wordControl,
      enable_consistency_audit: enableConsistencyAudit,
      requested_consistency_repair_mode: requestedConsistencyRepairMode,
      consistency_repair_mode: consistencyRepairMode,
      enable_original_plan_coverage_audit: enableOriginalPlanCoverageAudit,
      requested_original_plan_coverage_repair_mode: requestedOriginalPlanCoverageRepairMode,
      original_plan_coverage_repair_mode: originalPlanCoverageRepairMode,
      original_plan_segment_count: originalPlanSegments.length,
      generation_options: generationOptions,
    },
  });

  function writeDeveloperLog(event, payload = {}) {
    if (!developerLogger.enabled) {
      return;
    }
    try {
      developerLogger.write(event, payload);
    } catch {
      // 调试日志不能影响正文生成主流程。
    }
  }


  writeDeveloperLog('content.task.started', {
    sections: leaves.map(({ item }) => ({ id: item.id, title: item.title || '未命名章节' })),
    tasks_to_run: tasksToRun.map(({ item }) => item.id),
  });

  // 持久化并推送正文任务进度，但不重新加载完整技术方案。
  function publishTaskUpdate(partial, eventPatch) {
    updateTask(
      partial,
      { contentGenerationRuntime: contentRuntime },
      eventPatch,
      { skipWorkspaceReload: true },
    );
  }

  function appendDeveloperLog(message) {
    if (!developerModeEnabled) {
      return;
    }
    logs = [...logs, message];
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
  }

  const knowledgeReferences = loadContentKnowledgeReferences(knowledgeBaseService, referenceKnowledgeDocumentIds, (message) => {
    logs = [...logs, message];
  });
  knowledgeItems = knowledgeReferences.items;
  allowedKnowledgeItemIds = new Set(knowledgeItems.map((item) => item.id));
  knowledgeContentMap = knowledgeReferences.contentMap;


  const contentWordCounts = new Map();
  const generationCompletedItemIds = new Set();
  let totalContentWords = 0;

  // 正文可读字数统计：状态与读取入口显式注入，实现见 generation/contentWordStats.cjs。
  const {
    getLeafContentForWords,
    updateContentWordCount,
    rebuildContentWordCounts,
    getLeafWordCount,
    countTotalContentWords,
    leafWordStats,
    statsSnapshot,
  } = createContentWordStats({
    contentStats,
    wordControl,
    contentWordCounts,
    generationCompletedItemIds,
    getLeaves: () => leaves,
    getSections: () => sections,
    getTotalContentWords: () => totalContentWords,
    setTotalContentWords: (value) => {
      totalContentWords = value;
    },
  });

  // 更新单个小节字数及全文累计字数。

  // 正文整体替换后重建内存字数索引。


  function markGenerationCompleted(itemId) {
    if (itemId) generationCompletedItemIds.add(itemId);
    contentStats.generation_completed = generationCompletedItemIds.size;
  }

  function syncRuntime(partial = {}) {
    contentRuntime = normalizeContentGenerationRuntime({
      ...contentRuntime,
      ...partial,
      phase: partial.phase || contentStats.phase,
      touched_item_ids: Array.from(touchedItemIds),
      updated_at: now(),
    });
    return contentRuntime;
  }

  function markStageCompleted(stage) {
    completedStages.add(stage);
    const runtime = syncRuntime({ completed_stages: Array.from(completedStages) });
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });
  }

  function isPauseRequested() {
    return Boolean(taskControl?.isPauseRequested?.());
  }

  function persistPausedContentGeneration(message = '正文生成已暂停，可导出当前已完成内容，稍后继续。') {
    logs = [...logs, message];
    const runtime = syncRuntime();
    checkpointTask({ status: 'paused', progress: progressFor(leaves, sections), logs, stats: statsSnapshot(), pause_requested: false }, {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: runtime,
    });
  }

  // 所有正文请求结束后存在失败时，保存等待用户重试或忽略的稳定状态。
  function persistContentDecisionWait(unresolvedContexts) {
    const unresolvedIds = unresolvedContexts.map(({ item }) => item.id);
    const message = `正文小节生成结束，${unresolvedIds.length} 个小节失败或未完成。请重试失败小节，或确认忽略后继续后续流程。`;
    logs = [...logs, message, `失败或未完成小节：${unresolvedIds.join('、')}。`];
    contentStats.phase = 'generating';
    contentStats.awaiting_content_decision = true;
    contentStats.ignored_section_count = leaves.filter(({ item }) => sections[item.id]?.status === 'ignored').length;
    const runtime = syncRuntime({ phase: 'generating', awaiting_content_decision: true });
    const taskPatch = {
      status: 'error',
      error: message,
      progress: progressFor(leaves, sections),
      logs,
      stats: statsSnapshot(),
      pause_requested: false,
    };
    checkpointTask(taskPatch, {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: runtime,
    });
  }

  function pauseIfRequested(message = '正文生成已暂停，可导出当前已完成内容，稍后继续。') {
    if (!isPauseRequested()) {
      return;
    }

    persistPausedContentGeneration(message);
    throw createContentGenerationPausedError();
  }


  function continueAfterPromptCacheWarmup(message) {
    logs = [...logs, message];
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
    pauseIfRequested('正文生成已在提示词缓存预热后暂停，可导出当前已完成内容，稍后继续。');
  }

  function rememberTouchedItem(itemId) {
    if (itemId) {
      touchedItemIds.add(itemId);
      syncRuntime();
    }
  }

  const initialRuntime = syncRuntime();
  const initialIllustrationPatch = runOnlyIllustrationGeneration || targetItemId ? {} : { contentIllustrationPlan: undefined };
  checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
    outlineData,
    contentGenerationSections: sections,
    contentGenerationPlans: storedContentPlans,
    ...initialIllustrationPatch,
    contentGenerationRuntime: initialRuntime,
    referenceKnowledgeDocumentIds,
  }, {
    contentRuntime: initialRuntime,
    technicalPlanPatch: {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      ...initialIllustrationPatch,
      contentGenerationRuntime: initialRuntime,
      referenceKnowledgeDocumentIds,
    },
  });

  if (!tasksToRun.length && !runOnlyIllustrationStage) {
    logs = [...logs, retryContentCorrection
      ? '正文已全部生成，将直接重试内容矫正和后续处理。'
      : '正文已全部生成，将执行内容复核和字数控制。'];
  }

  function saveSection(item, partial, contentForOutline, taskPartial = {}) {
    const hasPartialContent = Object.prototype.hasOwnProperty.call(partial || {}, 'content');
    const hasOutlineContent = contentForOutline !== undefined;
    const nextPartial = { ...(partial || {}) };
    if (hasPartialContent) {
      nextPartial.content = normalizeLeafContentForSave(nextPartial.content, item);
    }
    sections = withSection(sections, item, nextPartial);
    const currentOutlineData = outlineData;
    const outlineContent = hasOutlineContent || hasPartialContent
      ? normalizeLeafContentForSave(contentForOutline ?? (sections[item.id].content || ''), item)
      : (sections[item.id].content || '');
    if (hasOutlineContent || hasPartialContent) {
      sections = {
        ...sections,
        [item.id]: {
          ...sections[item.id],
          content: outlineContent,
        },
      };
    }
    const nextOutlineData = {
      ...currentOutlineData,
      outline: updateOutlineItemContent(currentOutlineData.outline || outlineData.outline, item.id, outlineContent),
    };
    outlineData = nextOutlineData;
    if (hasOutlineContent || hasPartialContent) {
      updateContentWordCount(item.id, outlineContent);
    }
    const runtime = syncRuntime();
    if (hasOutlineContent || hasPartialContent) {
      writeDeveloperLog('content.section.saved', {
        section_id: item.id,
        title: item.title || '未命名章节',
        status: sections[item.id]?.status || 'idle',
        content_metrics: textMetrics(outlineContent),
      });
    }
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), stats: statsSnapshot(), ...taskPartial }, {
      contentGenerationItem: {
        nodeId: item.id,
        section: sections[item.id],
        runtime,
      },
    }, {
      contentSection: sections[item.id],
      contentRuntime: runtime,
    });
    return sections[item.id];
  }

  function getStoredContentPlan(itemId) {
    return normalizeStoredContentPlan(storedContentPlans[itemId]);
  }

  function applyCurrentTableRequirementToPlan(plan) {
    const normalizedPlan = normalizeContentPlan(plan, allowedKnowledgeItemIds, allowedFactTitles);
    return tableRequirement === 'none' ? clearContentPlanTable(normalizedPlan) : normalizedPlan;
  }

  function getReusableStoredContentPlan(itemId) {
    const storedContentPlan = getStoredContentPlan(itemId);
    if (!storedContentPlan || !isStoredContentPlanReusableForTableRequirement(storedContentPlan, tableRequirement)) {
      return null;
    }
    return {
      ...storedContentPlan,
      plan: applyCurrentTableRequirementToPlan(storedContentPlan.plan),
    };
  }

  function getContentPlanForItem(itemId) {
    const plan = contentPlans.get(itemId) || getReusableStoredContentPlan(itemId)?.plan || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
    contentPlans.set(itemId, plan);
    return plan;
  }

  function saveContentPlanForItem(itemId, plan) {
    contentPlans.set(itemId, plan);
    storedContentPlans = pruneContentGenerationPlans({
      ...storedContentPlans,
      [itemId]: createStoredContentPlan(plan, tableRequirement),
    }, leaves);
    const runtime = syncRuntime();
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationItem: { nodeId: itemId, storedPlan: storedContentPlans[itemId], runtime },
    }, { contentRuntime: runtime });
    return storedContentPlans[itemId];
  }

  function getOriginalMaterialRuntimeState(itemOrId) {
    const itemId = typeof itemOrId === 'string' ? itemOrId : String(itemOrId?.id || '').trim();
    const item = typeof itemOrId === 'string' ? leaves.find((context) => context.item.id === itemId)?.item : itemOrId;
    const plan = contentPlans.get(itemId) || getStoredContentPlan(itemId)?.plan || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
    const originalMaterial = normalizeOriginalMaterial(plan.original_material);
    const sourceSegments = originalMaterial.source_ids.map((sourceId) => originalPlanSegmentById.get(sourceId)).filter(Boolean);
    const allSourcesValid = Boolean(originalMaterial.source_ids.length) && sourceSegments.length === originalMaterial.source_ids.length;
    const content = sections[itemId]?.content || item?.content || '';
    const hasContent = Boolean(String(content || '').trim());
    const validRestored = Boolean(originalMaterial.restored && allSourcesValid && hasContent);
    const needsRestoreRepair = Boolean(originalMaterial.restored && !validRestored);
    return {
      plan,
      originalMaterial,
      sourceSegments,
      allSourcesValid,
      content,
      hasContent,
      validRestored,
      needsRestoreRepair,
      canRebuildRestoredContent: Boolean(originalMaterial.restored && allSourcesValid && !hasContent),
      needsOptimization: Boolean(validRestored && !originalMaterial.optimized),
    };
  }

  function buildOriginalMaterialFromSegments(segments, previous = {}) {
    const restoredContent = segments.map((segment) => segment.content).join('\n\n').trim();
    return normalizeOriginalMaterial({
      restored: true,
      optimized: false,
      source_ids: segments.map((segment) => segment.id),
      source_titles: segments.map((segment) => segment.title_path?.join(' > ') || segment.id),
      source_hashes: segments.map((segment) => segment.hash),
      restored_chars: restoredContent.length,
      restored_at: previous.restored_at || now(),
    });
  }

  function saveSectionAndContentPlan(item, partial, contentForOutline, plan, taskPartial = {}) {
    const hasPartialContent = Object.prototype.hasOwnProperty.call(partial || {}, 'content');
    const hasOutlineContent = contentForOutline !== undefined;
    const nextPartial = { ...(partial || {}) };
    if (hasPartialContent) {
      nextPartial.content = normalizeLeafContentForSave(nextPartial.content, item);
    }
    sections = withSection(sections, item, nextPartial);
    const currentOutlineData = outlineData;
    const outlineContent = hasOutlineContent || hasPartialContent
      ? normalizeLeafContentForSave(contentForOutline ?? (sections[item.id].content || ''), item)
      : (sections[item.id].content || '');
    if (hasOutlineContent || hasPartialContent) {
      sections = {
        ...sections,
        [item.id]: {
          ...sections[item.id],
          content: outlineContent,
        },
      };
    }
    const nextOutlineData = {
      ...currentOutlineData,
      outline: updateOutlineItemContent(currentOutlineData.outline || outlineData.outline, item.id, outlineContent),
    };
    outlineData = nextOutlineData;
    contentPlans.set(item.id, plan);
    storedContentPlans = pruneContentGenerationPlans({
      ...storedContentPlans,
      [item.id]: createStoredContentPlan(plan, tableRequirement),
    }, leaves);
    if (hasOutlineContent || hasPartialContent) {
      updateContentWordCount(item.id, outlineContent);
    }
    const runtime = syncRuntime();
    if (hasOutlineContent || hasPartialContent) {
      writeDeveloperLog('content.section.saved', {
        section_id: item.id,
        title: item.title || '未命名章节',
        status: sections[item.id]?.status || 'idle',
        content_metrics: textMetrics(outlineContent),
      });
    }
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), stats: statsSnapshot(), ...taskPartial }, {
      contentGenerationItem: {
        nodeId: item.id,
        section: sections[item.id],
        storedPlan: storedContentPlans[item.id],
        runtime,
      },
    }, {
      contentSection: sections[item.id],
      contentRuntime: runtime,
      technicalPlanPatch: {
        contentGenerationPlans: storedContentPlans,
        contentGenerationRuntime: runtime,
      },
    });
    return sections[item.id];
  }

  function persistContentPlans(targets) {
    const nextPlans = { ...storedContentPlans };
    for (const context of targets) {
      const contentPlan = contentPlans.get(context.item.id) || normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
      nextPlans[context.item.id] = createStoredContentPlan(contentPlan, tableRequirement);
    }
    storedContentPlans = pruneContentGenerationPlans(nextPlans, leaves);
    const runtime = syncRuntime();
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });
    return storedContentPlans;
  }

  async function planOne(context, { preservedOriginalMaterial } = {}) {
    const { item, parentChapters, siblingChapters } = context;
    let contentPlan;

    try {
      contentPlan = await aiService.collectJsonResponse({
        messages: buildChapterContentPlanMessages({
          chapter: item,
          parentChapters,
          siblingChapters,
          projectOverview,
          bidAnalysisFactsText,
          globalFactTitlesText,
          regenerateRequirement,
          tableRequirement,
          maxTables,
          tableTotalSections: leaves.length,
          knowledgeItems,
        }),
        logTitle: `正文编排-${item.id}-${item.title || '未命名章节'}`,
        progressLabel: '正文编排决策',
        failureMessage: '模型返回的正文编排决策格式无效',
        normalizer: (value) => normalizeContentPlan(value, allowedKnowledgeItemIds, allowedFactTitles),
        validator: validateContentPlan,
      });
    } catch (error) {
      if (isPauseLikeError(error)) {
        throw error;
      }
      contentPlan = normalizeContentPlan({}, allowedKnowledgeItemIds, allowedFactTitles);
      logs = [...logs, `编排失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}，将按纯正文生成。`];
    }

    if (tableRequirement === 'none') {
      contentPlan = clearContentPlanTable(contentPlan);
    }
    if (preservedOriginalMaterial?.restored || preservedOriginalMaterial?.source_ids?.length) {
      contentPlan = {
        ...contentPlan,
        original_material: preservedOriginalMaterial,
      };
    }

    contentPlans.set(item.id, contentPlan);
    storedContentPlans = pruneContentGenerationPlans({
      ...storedContentPlans,
      [item.id]: createStoredContentPlan(contentPlan, tableRequirement),
    }, leaves);
    const runtime = syncRuntime();
    contentStats.planning_completed += 1;
    logs = [...logs, `编排完成：${item.id} ${item.title || '未命名章节'}（知识库：${contentPlan.knowledge.item_ids.length} 条，事实变量：${contentPlan.facts.titles.length} 项，表格：${contentPlan.table.needed ? '需要' : '不需要'}）`];
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationItem: { nodeId: item.id, storedPlan: storedContentPlans[item.id], runtime },
    }, { contentRuntime: runtime });
  }

  async function planAll() {
    refreshRunLimits(tasksToRun);
    contentStats.phase = 'planning';
    contentStats.planning_total = tasksToRun.length;
    const planningTargets = [];
    for (const context of tasksToRun) {
      const storedContentPlan = getReusableStoredContentPlan(context.item.id);
      if (storedContentPlan?.plan) {
        contentPlans.set(context.item.id, storedContentPlan.plan);
      } else {
        planningTargets.push(context);
      }
    }
    contentStats.planning_completed = tasksToRun.length - planningTargets.length;
    contentStats.generation_total = tasksToRun.length;
    logs = [...logs, planningTargets.length === tasksToRun.length
      ? `开始整体编排决策，共 ${tasksToRun.length} 个小节。`
      : `继续整体编排决策，共 ${tasksToRun.length} 个小节，复用 ${tasksToRun.length - planningTargets.length} 个历史编排。`];
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });

    if (planningTargets.length) {
      const [warmupTarget, ...remainingPlanningTargets] = planningTargets;
      logs = [...logs, `开始正文编排预热：${warmupTarget.item.id} ${warmupTarget.item.title || '未命名章节'}。`];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });

      await planOne(warmupTarget);
      pauseIfRequested('正文生成已在编排预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingPlanningTargets.length) {
        continueAfterPromptCacheWarmup(`正文编排预热完成，开始并发编排剩余 ${remainingPlanningTargets.length} 个小节。`);
        logs = [...logs, `开始并发编排剩余 ${remainingPlanningTargets.length} 个小节。`];
        publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
        await runItemsWithWorkerPool(remainingPlanningTargets, contentConcurrency, planOne, isPauseRequested);
      }
    }
    pauseIfRequested('正文生成已在编排阶段暂停，可导出当前已完成内容，稍后继续。');

    const tableCandidates = tasksToRun.filter(({ item }) => contentPlans.get(item.id)?.table.needed);
    const selectedTableIds = runLimits.maxTablesForRun === null
      ? new Set(tableCandidates.map(({ item }) => item.id))
      : pickDistributedTableTargets(tableCandidates, runLimits.maxTablesForRun);
    if (runLimits.maxTablesForRun !== null) {
      for (const { item } of tableCandidates) {
        if (!selectedTableIds.has(item.id)) {
          contentPlans.set(item.id, clearContentPlanTable(contentPlans.get(item.id)));
        }
      }
    }

    logs = [...logs, `整体编排完成：表格候选 ${tableCandidates.length} 个，${runLimits.maxTablesForRun === null ? '保持现有编排' : `入选 ${selectedTableIds.size} 个`}。`];
    persistContentPlans(tasksToRun);
    contentStats.phase = 'generating';
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
  }

  async function restoreOriginalMaterialsIfNeeded(targets) {
    if (!isExpansionWorkflow || !originalPlanSegments.length || !targets?.length) {
      return;
    }

    const targetStates = targets.map((context) => ({ context, state: getOriginalMaterialRuntimeState(context.item) }));
    const rebuildTargets = targetStates.filter(({ state }) => state.canRebuildRestoredContent || (targetItemId && regenerate && state.validRestored));
    const restoreTargets = targetStates
      .filter(({ state }) => !state.validRestored && !state.canRebuildRestoredContent)
      .map(({ context }) => context);
    if (!restoreTargets.length && !rebuildTargets.length) {
      logs = [...logs, '原方案还原：当前待生成小节均已完成还原，跳过还原阶段。'];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      return;
    }

    contentStats.phase = 'restoring';
    contentStats.restoration_total = rebuildTargets.length + restoreTargets.length;
    contentStats.restoration_completed = 0;
    logs = [...logs, `开始原方案还原：${originalPlanSegments.length} 个原文段，${restoreTargets.length} 个候选叶子小节，${rebuildTargets.length} 个小节可直接重建原文。`];
    const restoringRuntime = syncRuntime({ phase: 'restoring' });
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: restoringRuntime,
    }, { contentRuntime: restoringRuntime });

    const assignedSourceIds = new Set();
    const completedRestoreTargetIds = new Set();
    let restoredCount = 0;
    for (const { context, state } of rebuildTargets) {
      const segments = state.sourceSegments;
      segments.forEach((segment) => assignedSourceIds.add(segment.id));
      const restoredContent = segments.map((segment) => segment.content).join('\n\n').trim();
      const originalMaterial = buildOriginalMaterialFromSegments(segments, state.originalMaterial);
      completedRestoreTargetIds.add(context.item.id);
      contentStats.restoration_completed = completedRestoreTargetIds.size;
      saveSectionAndContentPlan(context.item, { status: 'idle', content: restoredContent, error: undefined }, restoredContent, {
        ...state.plan,
        original_material: originalMaterial,
      }, { logs });
      restoredCount += 1;
    }

    if (restoreTargets.length) {
      const allowedNodeIds = new Set(restoreTargets.map(({ item }) => item.id).filter(Boolean));
      const allowedSourceIds = new Set(originalPlanSegments.map((segment) => segment.id));
      const restoreMessages = buildOriginalMaterialRestoreMessages({
        targets: restoreTargets,
        originalSegments: originalPlanSegments,
        projectOverview,
        bidAnalysisFactsText,
        globalFactTitlesText,
      });
      let result;
      if (shouldUseAgentForMessages(aiService, restoreMessages)) {
        const messagesLength = getMessagesContentLength(restoreMessages);
        const contextLengthLimit = getTextContextLengthLimit(aiService);
        logs = [...logs, `原方案还原映射提示词 ${messagesLength} 字符，超过上下文阈值 ${Math.floor(contextLengthLimit * AGENT_CONTEXT_THRESHOLD_RATIO)}，切换 Agent 文件模式。`];
        writeDeveloperLog('original_restore.agent.start', {
          message_chars: messagesLength,
          context_length_limit: contextLengthLimit,
          threshold_ratio: AGENT_CONTEXT_THRESHOLD_RATIO,
          target_count: restoreTargets.length,
          original_segment_count: originalPlanSegments.length,
        });
        publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
        let validatedRestoreResult = null;
        const { agentResult, outputContent } = await runContentAgentTask({
          title: '原方案正文还原映射 Agent',
          prompt: buildAgentOriginalMaterialRestorePrompt(),
          outputFile: 'original-restore-result.json',
          files: buildAgentOriginalMaterialRestoreFiles({
            targets: restoreTargets,
            originalSegments: originalPlanSegments,
            projectOverview,
            bidAnalysisFactsText,
            globalFactTitlesText,
          }),
          eventPrefix: 'original_restore.agent',
          activityLabel: 'Agent 正在判断原方案段落归属',
          startPauseMessage: '正文生成已在原方案还原 Agent 映射开始前暂停，本次 Agent 未启动；继续后将重新执行。',
          resultPauseMessage: '正文生成已在原方案还原 Agent 映射回写前暂停，本次 Agent 输出未回写；继续后将重新执行。',
          pausedLogMessage: '原方案还原 Agent 映射已暂停：本轮 Agent 已取消并清理，继续后将重新执行。',
          validateOutput: (resultForValidation) => {
            const outputForValidation = String(resultForValidation?.output_content || '').trim();
            const parsedForValidation = parseAgentJsonContent(outputForValidation);
            validatedRestoreResult = normalizeOriginalRestoreAssignments(parsedForValidation, { allowedNodeIds, allowedSourceIds });
            validateOriginalRestoreAssignments(validatedRestoreResult);
            return validatedRestoreResult;
          },
        });
        result = validatedRestoreResult || normalizeOriginalRestoreAssignments(parseAgentJsonContent(outputContent), { allowedNodeIds, allowedSourceIds });
        pauseIfRequested('正文生成已在原方案还原 Agent 映射回写前暂停，本次 Agent 输出未回写；继续后将重新执行。');
        writeDeveloperLog('original_restore.agent.validated', {
          assignment_count: result.assignments.length,
          agent_task_id: agentResult?.task_id || '',
          agent_session_id: agentResult?.session_id || '',
          output_metrics: textMetrics(outputContent),
        });
      } else {
        result = await aiService.collectJsonResponse({
          messages: restoreMessages,
          logTitle: '原方案正文还原映射',
          progressLabel: '原方案还原',
          failureMessage: '模型返回的原方案还原映射格式无效',
          normalizer: (value) => normalizeOriginalRestoreAssignments(value, { allowedNodeIds, allowedSourceIds }),
          validator: validateOriginalRestoreAssignments,
          repairMessagesBuilder: (context) => buildOriginalRestoreRepairMessages(context, restoreTargets, originalPlanSegments),
          progressCallback: (message) => {
            logs = [...logs, message || '原方案还原映射格式校验失败，正在修复'];
            publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
          },
        });
      }

      const targetById = new Map(restoreTargets.map((context) => [context.item.id, context]));
      for (const assignment of result.assignments || []) {
        const context = targetById.get(assignment.node_id);
        if (!context) {
          continue;
        }
        const segments = (assignment.source_ids || []).map((sourceId) => originalPlanSegmentById.get(sourceId)).filter(Boolean);
        if (!segments.length) {
          continue;
        }
        segments.forEach((segment) => assignedSourceIds.add(segment.id));
        const restoredContent = segments.map((segment) => segment.content).join('\n\n').trim();
        const plan = getContentPlanForItem(context.item.id);
        const originalMaterial = buildOriginalMaterialFromSegments(segments);
        completedRestoreTargetIds.add(context.item.id);
        contentStats.restoration_completed = completedRestoreTargetIds.size;
        saveSectionAndContentPlan(context.item, { status: 'idle', content: restoredContent, error: undefined }, restoredContent, {
          ...plan,
          original_material: originalMaterial,
        }, { logs });
        restoredCount += 1;
      }
    }

    contentStats.restoration_completed = contentStats.restoration_total;
    const unassignedCount = originalPlanSegments.filter((segment) => !assignedSourceIds.has(segment.id)).length;
    logs = [...logs, `原方案还原完成：已还原 ${restoredCount} 个小节，未分配原文段 ${unassignedCount} 个。`];
    contentStats.phase = 'generating';
    const generatingRuntime = syncRuntime({ phase: 'generating' });
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: generatingRuntime,
    }, { contentRuntime: generatingRuntime });
  }

  async function prepareSingleSectionPlan() {
    const context = tasksToRun[0];
    const previousOriginalMaterial = getOriginalMaterialRuntimeState(context.item).originalMaterial;
    const resumedPlan = resume && Number(storedPlan.contentGenerationTask?.stats?.content?.planning_completed || 0) >= 1
      ? getReusableStoredContentPlan(context.item.id)
      : null;
    contentStats.phase = 'planning';
    contentStats.planning_total = 1;
    contentStats.planning_completed = 0;
    contentStats.generation_total = 1;

    if (resumedPlan) {
      contentPlans.set(context.item.id, resumedPlan.plan);
      contentStats.planning_completed = 1;
      logs = [...logs, `继续当前小节任务，复用本次任务已完成的编排：${context.item.id} ${context.item.title || '未命名章节'}。`];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      contentStats.phase = 'generating';
      return;
    }

    logs = [...logs, `开始重新编排当前小节：${context.item.id} ${context.item.title || '未命名章节'}。`];
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
    await planOne(context, { preservedOriginalMaterial: previousOriginalMaterial });
    pauseIfRequested('正文生成已在小节编排后暂停，可导出当前已完成内容，稍后继续。');
    persistContentPlans([context]);
    logs = [...logs, `当前小节编排已保存：${context.item.id} ${context.item.title || '未命名章节'}。`];

    pauseIfRequested('正文生成已在小节编排阶段暂停，可导出当前已完成内容，稍后继续。');
    contentStats.phase = 'generating';
    publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
  }

  async function runOne(context) {
    const { item } = context;
    const previousSection = sections[item.id] || {};
    const previousContent = previousSection.content || item.content || '';
    const previousStatus = previousSection.status && previousSection.status !== 'running'
      ? previousSection.status
      : previousContent.trim() ? 'success' : 'idle';
    const isSingleSectionRegeneration = Boolean(targetItemId);
    let contentPlan = getContentPlanForItem(item.id);
    let originalState = getOriginalMaterialRuntimeState(item);
    let originalMaterial = originalState.originalMaterial;
    const needsRestoredOptimization = originalState.needsOptimization;
    let rawContent = needsRestoredOptimization ? previousContent : regenerate || retryItemIds.has(item.id) ? '' : previousContent;
    let content = stripRepeatedChapterTitle(normalizeGeneratedMarkdown(rawContent), item);
    logs = [...logs, needsRestoredOptimization
      ? `开始基于原方案优化扩写：${item.id} ${item.title || '未命名章节'}`
      : `开始生成：${item.id} ${item.title || '未命名章节'}`];
    saveSection(item, {
      status: isSingleSectionRegeneration ? previousStatus : 'running',
      content: isSingleSectionRegeneration ? previousContent : content,
      error: undefined,
    }, isSingleSectionRegeneration ? previousContent : content, { logs });

    try {
      if (simulatedFailureItemIds.has(item.id)) {
        throw new Error('开发者模式：随机模拟正文生成失败');
      }
      contentPlan = getContentPlanForItem(item.id);
      originalState = getOriginalMaterialRuntimeState(item);
      originalMaterial = originalState.originalMaterial;
      const knowledgeContents = resolveKnowledgeContents(contentPlan.knowledge?.item_ids, knowledgeContentMap);
      const selectedFactsText = resolveSelectedFactsText(contentPlan, globalFacts);
      const generationTarget = computeGenerationWordTarget(wordControl, leaves.length);
      const contentMessages = needsRestoredOptimization
        ? buildRestoredChapterContentMessages({ chapter: item, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, restoredContent: previousContent, wordControl, generationTarget, globalFactsMode })
        : buildChapterContentMessages({ chapter: item, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, wordControl, generationTarget, globalFactsMode });

      let generatedContent;
      if (needsRestoredOptimization && shouldUseAgentForMessages(aiService, contentMessages)) {
        const messagesLength = getMessagesContentLength(contentMessages);
        const contextLengthLimit = getTextContextLengthLimit(aiService);
        logs = [...logs, `已还原正文优化扩写提示词 ${messagesLength} 字符，超过上下文阈值 ${Math.floor(contextLengthLimit * AGENT_CONTEXT_THRESHOLD_RATIO)}，切换 Agent 文件模式：${item.id} ${item.title || '未命名章节'}。`];
        writeDeveloperLog('restored_optimization.agent.start', {
          section_id: item.id,
          title: item.title || '未命名章节',
          message_chars: messagesLength,
          context_length_limit: contextLengthLimit,
          threshold_ratio: AGENT_CONTEXT_THRESHOLD_RATIO,
          restored_content_metrics: textMetrics(previousContent),
          knowledge_content_count: knowledgeContents.length,
        });
        publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
        const { agentResult, outputContent } = await runContentAgentTask({
          title: `已还原正文优化扩写 Agent-${item.id}`,
          prompt: buildAgentRestoredChapterContentPrompt(globalFactsMode),
          outputFile: 'optimized-section.md',
          files: buildAgentRestoredChapterContentFiles({
            chapter: item,
            projectOverview,
            selectedFactsText,
            regenerateRequirement,
            contentPlan,
            knowledgeContents,
            restoredContent: previousContent,
            wordControl,
            generationTarget,
          }),
          eventPrefix: 'restored_optimization.agent',
          activityLabel: 'Agent 正在优化扩写已还原正文',
          startPauseMessage: '正文生成已在已还原正文优化扩写 Agent 开始前暂停，本次 Agent 未启动；继续后将重新执行。',
          resultPauseMessage: '正文生成已在已还原正文优化扩写 Agent 回写前暂停，本次 Agent 输出未回写；继续后将重新执行。',
          pausedLogMessage: '已还原正文优化扩写 Agent 已暂停：本轮 Agent 已取消并清理，继续后将重新执行。',
        });
        generatedContent = outputContent;
        pauseIfRequested('正文生成已在已还原正文优化扩写 Agent 回写前暂停，本次 Agent 输出未回写；继续后将重新执行。');
        writeDeveloperLog('restored_optimization.agent.done', {
          section_id: item.id,
          title: item.title || '未命名章节',
          agent_task_id: agentResult?.task_id || '',
          agent_session_id: agentResult?.session_id || '',
          output_metrics: textMetrics(outputContent),
        });
      } else {
        generatedContent = await aiService.chat({
          messages: contentMessages,
          logTitle: `${needsRestoredOptimization ? '原方案优化扩写' : '正文生成'}-${item.id}-${item.title || '未命名章节'}`,
        });
      }

      rawContent = needsRestoredOptimization ? generatedContent || '' : rawContent + (generatedContent || '');

      content = normalizeLeafContentForSave(rawContent, item);
      if (countContentWords(content) === 0) {
        throw new Error('正文生成结果没有有效可读内容');
      }
      logs = [...logs, needsRestoredOptimization
        ? `原方案优化扩写完成：${item.id} ${item.title || '未命名章节'}`
        : `生成完成：${item.id} ${item.title || '未命名章节'}`];
      rememberTouchedItem(item.id);
      markGenerationCompleted(item.id);
      if (needsRestoredOptimization) {
        saveSectionAndContentPlan(item, { status: 'success', content, error: undefined }, content, {
          ...contentPlan,
          original_material: normalizeOriginalMaterial({
            ...originalMaterial,
            optimized: true,
            optimized_at: now(),
          }),
        }, { logs });
      } else {
        saveSection(item, { status: 'success', content, error: undefined }, content, { logs });
      }
    } catch (error) {
      if (isPauseLikeError(error)) {
        saveSection(item, {
          status: previousStatus,
          content: previousContent,
          error: previousSection.error,
        }, previousContent, { logs });
        throw error;
      }
      const message = error.message || '正文生成失败';
      const fallbackContent = isSingleSectionRegeneration
        ? previousContent
        : countContentWords(content) > 0
          ? content
          : previousContent;
      const hasReadableFallback = !isSingleSectionRegeneration && countContentWords(fallbackContent) > 0;
      logs = [...logs, hasReadableFallback
        ? `生成请求未产生可用新内容：${item.id} ${item.title || '未命名章节'}，${message}。已保留当前有效正文。`
        : `生成失败：${item.id} ${item.title || '未命名章节'}，${message}${isSingleSectionRegeneration ? '。已保留原正文。' : ''}`];
      markGenerationCompleted(item.id);
      saveSection(item, {
        status: hasReadableFallback ? 'success' : 'error',
        content: fallbackContent,
        error: hasReadableFallback ? undefined : message,
      }, fallbackContent, { logs });
    }
  }

  function getContentPromptWarmupKey(context) {
    const originalState = getOriginalMaterialRuntimeState(context.item);
    const contentPlan = getContentPlanForItem(context.item.id);
    const branch = originalState.needsOptimization ? 'restored' : 'normal';
    const tableMode = contentPlan?.table?.needed ? 'table' : 'plain';
    return `${branch}:${tableMode}`;
  }

  function formatContentPromptWarmupLabel(key) {
    if (key === 'restored:table') return '已还原优化扩写/允许表格';
    if (key === 'restored:plain') return '已还原优化扩写/无表格';
    if (key === 'normal:table') return '普通正文/允许表格';
    return '普通正文/无表格';
  }

  async function runContentTargetsWithWarmup(targets, label = '正文生成') {
    if (!targets.length) {
      return;
    }

    const groups = new Map();
    for (const context of targets) {
      const key = getContentPromptWarmupKey(context);
      const group = groups.get(key) || [];
      group.push(context);
      groups.set(key, group);
    }

    const warmupContexts = new Set();
    const warmups = [];
    for (const [key, groupTargets] of groups.entries()) {
      if (groupTargets.length <= 1) {
        continue;
      }
      const context = groupTargets[0];
      warmups.push({ key, context });
      warmupContexts.add(context);
    }

    for (const { key, context } of warmups) {
      logs = [...logs, `开始${label}预热（${formatContentPromptWarmupLabel(key)}）：${context.item.id} ${context.item.title || '未命名章节'}。`];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });

      await runOne(context);
      pauseIfRequested(`正文生成已在${label}预热后暂停，可导出当前已完成内容，稍后继续。`);
    }

    const remainingTargets = targets.filter((context) => !warmupContexts.has(context));

    if (remainingTargets.length) {
      if (warmups.length) {
        continueAfterPromptCacheWarmup(`${label}分组预热完成，开始并发生成剩余 ${remainingTargets.length} 个小节。`);
      }
      logs = [...logs, warmups.length
        ? `开始并发生成剩余 ${remainingTargets.length} 个小节。`
        : `${label}无需分组预热，开始并发生成 ${remainingTargets.length} 个小节。`];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      await runItemsWithWorkerPool(remainingTargets, contentConcurrency, runOne, isPauseRequested);
    }
  }

  function setWordAdjustmentRuntime(stage, itemId = '', round = 0, completedItemIds = [], itemRounds = {}, noProgressRounds = 0, roundStartWords = 0) {
    const runtime = syncRuntime({
      word_adjustment_stage: stage,
      word_adjustment_item_id: itemId,
      word_adjustment_round: round,
      word_adjustment_item_rounds: itemRounds,
      word_adjustment_completed_item_ids: completedItemIds,
      word_adjustment_no_progress_rounds: noProgressRounds,
      word_adjustment_round_start_words: roundStartWords,
    });
    checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });
  }

  async function requestWordAdjustment(context, options) {
    const { item } = context;
    const currentContent = getLeafContentForWords(item);
    const currentWords = getLeafWordCount(item);
    const selectedFactsText = resolveSelectedFactsText(getContentPlanForItem(item.id), globalFacts);
    pauseIfRequested('正文生成已在字数调整请求前暂停，继续后将重新执行本轮。');
    const adjustment = await aiService.collectJsonResponse({
      messages: buildWordAdjustmentMessages({
        context,
        currentContent,
        currentWords,
        targetWords: options.targetWords,
        mode: options.mode,
        granularity: options.granularity,
        selectedFactsText,
        maximumChangeWords: options.maximumChangeWords,
        totalRemainingWords: options.totalRemainingWords,
        totalWords: targetItemId ? undefined : countTotalContentWords(),
        minimumWords: targetItemId ? 0 : wordControl.minimumWords,
        maximumWords: targetItemId ? 0 : wordControl.maximumWords,
        globalFactsMode,
      }),
      logTitle: `正文${options.mode === 'expand' ? '扩写' : '缩写'}-${item.id}-${item.title || '未命名章节'}`,
      progressLabel: '正文字数调整',
      failureMessage: '模型返回的正文字数调整结果格式无效',
      max_retries: 0,
      normalizer: normalizeWordAdjustmentResponse,
      validator: (value) => {
        validateWordAdjustmentResponse(value);
        if (value.mode !== options.mode || value.granularity !== options.granularity) {
          throw new Error('模型返回的调整方向或粒度与当前要求不一致');
        }
      },
      repairMessagesBuilder: (repairContext) => buildWordAdjustmentRepairMessages(repairContext, options.mode, options.granularity, currentContent),
    });
    pauseIfRequested('正文生成已在字数调整结果应用前暂停，继续后将重新执行本轮。');
    const nextContent = normalizeLeafContentForSave(applyWordAdjustmentOperations(currentContent, adjustment), item);
    const nextWords = countContentWords(nextContent);
    if (nextWords <= 0) throw new Error('字数调整后正文没有有效可读内容');
    if (options.mode === 'expand' && nextWords <= currentWords) throw new Error('扩写后字数没有增加');
    if (options.mode === 'shrink' && nextWords >= currentWords) throw new Error('缩写后字数没有减少');
    if (Math.abs(nextWords - currentWords) > options.maximumChangeWords) {
      throw new Error('本轮实际调整字数超过允许额度');
    }
    if (Math.abs(nextWords - options.targetWords) >= Math.abs(currentWords - options.targetWords)) {
      throw new Error('字数调整后与目标的差距没有缩小');
    }
    if (options.enforceSectionBounds && wordControl.strictSectionWords) {
      if (nextWords < wordControl.sectionMinimumWords || nextWords > wordControl.sectionMaximumWords) {
        throw new Error('本轮调整会使小节超出强控范围');
      }
    }
    if (options.enforceTotalBounds !== false) {
      const nextTotalWords = countTotalContentWords() - currentWords + nextWords;
      if (wordControl.maximumWords > 0 && options.mode === 'expand' && nextTotalWords > wordControl.maximumWords) {
        throw new Error('本轮扩写会使全文超过最多字数');
      }
      if (wordControl.minimumWords > 0 && options.mode === 'shrink' && nextTotalWords < wordControl.minimumWords) {
        throw new Error('本轮缩写会使全文低于最少字数');
      }
    }
    rememberTouchedItem(item.id);
    saveSection(item, { status: 'success', content: nextContent, error: undefined }, nextContent, { logs });
    return { currentWords, nextWords };
  }


  async function adjustSectionToRange(context, stage, itemRounds, completedItemIds) {
    const { item } = context;
    let rounds = Math.min(MAX_WORD_ADJUSTMENT_ROUNDS, Math.max(0, Number(itemRounds[item.id]) || 0));
    while (rounds < MAX_WORD_ADJUSTMENT_ROUNDS) {
      const currentWords = getLeafWordCount(item);
      if (!isSectionWordsOutsideRange(wordControl, currentWords)) return true;
      rounds += 1;
      const mode = currentWords < wordControl.sectionMinimumWords ? 'expand' : 'shrink';
      const differenceRatio = Math.abs(currentWords - wordControl.sectionWords) / wordControl.sectionWords;
      const granularity = differenceRatio > 0.2 ? 'paragraph' : 'sentence';
      contentStats.section_adjustment_item_id = item.id;
      contentStats.section_adjustment_round = rounds;
      itemRounds[item.id] = rounds - 1;
      setWordAdjustmentRuntime(stage, item.id, rounds - 1, completedItemIds, itemRounds);
      logs = [...logs, `调整小节字数：${item.id} ${item.title || '未命名章节'}，第 ${rounds}/${MAX_WORD_ADJUSTMENT_ROUNDS} 轮，当前 ${currentWords} 字。`];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      try {
        await requestWordAdjustment(context, {
          mode,
          granularity,
          targetWords: wordControl.sectionWords,
          maximumChangeWords: Math.abs(currentWords - wordControl.sectionWords),
          enforceSectionBounds: false,
          enforceTotalBounds: !targetItemId,
        });
      } catch (error) {
        if (isPauseLikeError(error)) throw error;
        logs = [...logs, `小节字数第 ${rounds} 轮调整未应用：${item.id}，${error.message || String(error)}。`];
      }
      itemRounds[item.id] = rounds;
      setWordAdjustmentRuntime(stage, item.id, rounds, completedItemIds, itemRounds);
      pauseIfRequested('正文生成已在字数调整结果处理后暂停，可稍后继续。');
    }
    return !isSectionWordsOutsideRange(wordControl, getLeafWordCount(item));
  }

  async function runSectionWordAdjustments(targets, stage) {
    if (!wordControl.strictSectionWords) return [];
    const candidates = (targets || []).filter(({ item }) => sections[item.id]?.status === 'success' && getLeafWordCount(item) > 0);
    const violations = candidates.filter(({ item }) => isSectionWordsOutsideRange(wordControl, getLeafWordCount(item)));
    const resumingStage = resume && contentRuntime.word_adjustment_stage === stage;
    const completedItemIds = resumingStage ? [...contentRuntime.word_adjustment_completed_item_ids] : [];
    const completedItemIdSet = new Set(completedItemIds);
    const itemRounds = resumingStage ? { ...contentRuntime.word_adjustment_item_rounds } : {};
    const activeItemIds = new Set();
    const pendingViolations = violations.filter(({ item }) => !completedItemIdSet.has(item.id));
    contentStats.phase = stage === 'final-section' ? 'final-section-word-adjusting' : 'section-word-adjusting';
    contentStats.section_adjustment_total = completedItemIds.length + pendingViolations.length;
    contentStats.section_adjustment_completed = completedItemIds.length;
    contentStats.section_adjustment_active_count = 0;
    if (!resumingStage) setWordAdjustmentRuntime(stage, '', 0, completedItemIds, itemRounds);
    const unresolved = new Set(violations.filter(({ item }) => completedItemIdSet.has(item.id)).map(({ item }) => item.id));
    await runItemsWithWorkerPool(pendingViolations, contentConcurrency, async (context) => {
      activeItemIds.add(context.item.id);
      contentStats.section_adjustment_active_count = activeItemIds.size;
      contentStats.section_adjustment_item_id = context.item.id;
      contentStats.section_adjustment_round = Number(itemRounds[context.item.id]) || 0;
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });

      if (!await adjustSectionToRange(context, stage, itemRounds, completedItemIds)) unresolved.add(context.item.id);
      completedItemIds.push(context.item.id);
      completedItemIdSet.add(context.item.id);
      activeItemIds.delete(context.item.id);
      const nextActiveItemId = activeItemIds.values().next().value || '';
      contentStats.section_adjustment_active_count = activeItemIds.size;
      contentStats.section_adjustment_completed = completedItemIds.length;
      contentStats.section_adjustment_item_id = nextActiveItemId;
      contentStats.section_adjustment_round = nextActiveItemId ? Number(itemRounds[nextActiveItemId]) || 0 : 0;
      setWordAdjustmentRuntime(stage, nextActiveItemId, contentStats.section_adjustment_round, completedItemIds, itemRounds);
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
    }, isPauseRequested);
    contentStats.section_adjustment_item_id = '';
    contentStats.section_adjustment_round = 0;
    contentStats.section_adjustment_active_count = 0;
    return [...unresolved];
  }


  // 扩写先按小节指导缺口分配，剩余额度再均摊；3000 仅是 sectionWords 为 0 时的内部指导值，不构成小节上限。

  // 强控缩写限制单次最多减少 25%；非强控只受全文差额和正文可读空间限制。

  // 每轮最多选择十个小节，批次总预算不超过当前全文差额。

  async function runTotalWordAdjustments() {
    if (!wordControl.minimumWords && !wordControl.maximumWords || targetItemId || runOnlyIllustrationStage) return;
    contentStats.phase = 'total-word-adjusting';
    const resumingStage = resume && contentRuntime.word_adjustment_stage === 'total';
    const initialRound = resumingStage
      ? Math.max(1, Number(contentRuntime.word_adjustment_round) || 1)
      : 1;
    if (!resumingStage) setWordAdjustmentRuntime('total', '', 0, [], {}, 0, 0);
    let lastItemId = resumingStage ? contentRuntime.word_adjustment_item_id : '';
    let noProgressRounds = resumingStage
      ? Math.max(0, Number(contentRuntime.word_adjustment_no_progress_rounds) || 0)
      : 0;
    let round = initialRound;
    while (true) {
      let direction = getTotalWordDirection(wordControl, countTotalContentWords());
      if (!direction) return;
      const isExpansion = direction.mode === 'expand';
      if (!isExpansion && round > MAX_WORD_ADJUSTMENT_ROUNDS) return;
      const resumingRound = resumingStage && round === initialRound;
      const persistedRoundStartWords = Math.max(0, Number(contentRuntime.word_adjustment_round_start_words) || 0);
      const roundStartWords = resumingRound && persistedRoundStartWords > 0
        ? persistedRoundStartWords
        : direction.currentWords;
      contentStats.total_adjustment_mode = direction.mode;
      contentStats.total_adjustment_round = round;
      contentStats.total_adjustment_round_total = isExpansion ? 0 : MAX_WORD_ADJUSTMENT_ROUNDS;
      const completedItemIds = resumingRound
        ? [...contentRuntime.word_adjustment_completed_item_ids]
        : [];
      const completedItemIdSet = new Set(completedItemIds);
      setWordAdjustmentRuntime('total', lastItemId, round, completedItemIds, {}, noProgressRounds, roundStartWords);
      const differenceRatio = Math.abs(direction.currentWords - direction.targetWords) / direction.targetWords;
      const granularity = differenceRatio > 0.2 ? 'paragraph' : 'sentence';
      // 本轮单节平均预算，用于缩写时过滤可缩空间过小的小节，避免它们占用批次名额却几乎缩不动。
      const averageBudget = Math.abs(direction.currentWords - direction.targetWords) / TOTAL_WORD_ADJUSTMENT_BATCH_SIZE;
      let candidates = leafWordStats().filter(({ item, words }) => {
        if (sections[item.id]?.status !== 'success' || words <= 0) return false;
        if (completedItemIdSet.has(item.id)) return false;
        if (!wordControl.strictSectionWords) return true;
        if (direction.mode === 'expand') return words < wordControl.sectionMaximumWords;
        // 缩写：仅保留可缩空间不小于平均预算 30% 的小节，集中资源到真正缩得动的小节上。
        const shrinkableWords = words - wordControl.sectionMinimumWords;
        return shrinkableWords >= averageBudget * TOTAL_WORD_SHRINK_MIN_CAPACITY_RATIO;
      }).sort((left, right) => direction.mode === 'expand' ? left.words - right.words : right.words - left.words);
      if (candidates.length > 1 && candidates[0].item.id === lastItemId) candidates = [...candidates.slice(1), candidates[0]];
      const remainingSlots = Math.max(0, TOTAL_WORD_ADJUSTMENT_BATCH_SIZE - completedItemIds.length);
      const batch = buildTotalWordAdjustmentBatch(wordControl, candidates, direction, remainingSlots);
      const previousContentStats = storedPlan.contentGenerationTask?.stats?.content;
      contentStats.total_adjustment_batch_total = completedItemIds.length + batch.length;
      contentStats.total_adjustment_batch_completed = completedItemIds.length;
      contentStats.total_adjustment_batch_failed = resumingRound
        ? Number(previousContentStats?.total_adjustment_batch_failed) || 0
        : 0;
      contentStats.total_adjustment_active_count = 0;
      contentStats.total_adjustment_item_id = '';
      contentStats.total_adjustment_remaining_words = Math.abs(direction.currentWords - direction.targetWords);
      if (!batch.length && !completedItemIds.length) {
        if (isExpansion) {
          logs = [...logs, '全文扩写没有可继续调整的小节，停止自动扩写。'];
          publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
          return;
        }
        round += 1;
        setWordAdjustmentRuntime('total', '', round, [], {}, noProgressRounds, 0);
        continue;
      }

      if (batch.length) {
        const roundLabel = isExpansion ? `第 ${round} 轮` : `第 ${round}/${MAX_WORD_ADJUSTMENT_ROUNDS} 轮`;
        logs = [...logs, `全文字数调整${roundLabel}：提交 ${batch.length} 个小节，当前还需${direction.mode === 'expand' ? '增加' : '减少'} ${contentStats.total_adjustment_remaining_words} 字。`];
        publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
        const activeItemIds = new Set();
        const batchResults = await Promise.allSettled(batch.map(async ({ context: candidate, budget, guidanceWords }) => {
          activeItemIds.add(candidate.item.id);
          contentStats.total_adjustment_active_count = activeItemIds.size;
          contentStats.total_adjustment_item_id = candidate.item.id;
          logs = [...logs, direction.mode === 'expand'
            ? `全文扩写已提交：${candidate.item.id} ${candidate.item.title || '未命名章节'}，当前 ${candidate.words} 字，内部指导 ${guidanceWords} 字，本次预算 ${budget} 字。`
            : `全文缩写已提交：${candidate.item.id} ${candidate.item.title || '未命名章节'}，本次预算 ${budget} 字。`];
          publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
          let failed = false;
          try {
            await requestWordAdjustment(candidate, {
              mode: direction.mode,
              granularity,
              targetWords: direction.mode === 'expand' ? candidate.words + budget : Math.max(1, candidate.words - budget),
              maximumChangeWords: budget,
              totalRemainingWords: contentStats.total_adjustment_remaining_words,
              enforceSectionBounds: wordControl.strictSectionWords,
            });
            lastItemId = candidate.item.id;
          } catch (error) {
            if (isPauseLikeError(error)) throw error;
            failed = true;
            logs = [...logs, `全文字数调整未应用：${candidate.item.id}，${error.message || String(error)}。`];
          }
          completedItemIds.push(candidate.item.id);
          completedItemIdSet.add(candidate.item.id);
          activeItemIds.delete(candidate.item.id);
          const nextActiveItemId = activeItemIds.values().next().value || '';
          const nextDirection = getTotalWordDirection(wordControl, countTotalContentWords());
          contentStats.total_adjustment_batch_completed = completedItemIds.length;
          if (failed) contentStats.total_adjustment_batch_failed += 1;
          contentStats.total_adjustment_active_count = activeItemIds.size;
          contentStats.total_adjustment_item_id = nextActiveItemId;
          contentStats.total_adjustment_remaining_words = nextDirection
            ? Math.abs(nextDirection.currentWords - nextDirection.targetWords)
            : 0;
          setWordAdjustmentRuntime('total', candidate.item.id, round, completedItemIds, {}, noProgressRounds, roundStartWords);
          publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
          pauseIfRequested('正文生成已在全文字数调整后暂停，可稍后继续。');
        }));
        const rejected = batchResults.find((result) => result.status === 'rejected');
        if (rejected) throw rejected.reason;
      }

      const currentWords = countTotalContentWords();
      if (isExpansion) {
        if (currentWords > roundStartWords) {
          noProgressRounds = 0;
        } else {
          noProgressRounds += 1;
          logs = [...logs, `全文扩写第 ${round} 轮未增加有效字数，连续无进展 ${noProgressRounds}/${MAX_EXPANSION_NO_PROGRESS_ROUNDS} 轮。`];
        }
      }
      const nextDirection = getTotalWordDirection(wordControl, countTotalContentWords());
      contentStats.total_adjustment_remaining_words = nextDirection
        ? Math.abs(nextDirection.currentWords - nextDirection.targetWords)
        : 0;
      round += 1;
      setWordAdjustmentRuntime('total', '', round, [], {}, noProgressRounds, 0);
      if (isExpansion && noProgressRounds >= MAX_EXPANSION_NO_PROGRESS_ROUNDS) {
        logs = [...logs, `全文扩写连续 ${MAX_EXPANSION_NO_PROGRESS_ROUNDS} 轮没有增加有效字数，停止自动扩写。`];
        publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
        return;
      }
    }
  }


  // 阶段模块的注入门面：把会被重新赋值的闭包变量暴露成 getter/setter，
  // 编排函数内部继续使用原来的裸变量，两者始终指向同一份状态。
  // 后续把阶段搬到 generation/stages/ 时直接传 ctx 即可，不必改动上面的代码。
  const ctx = {
    get outlineData() { return outlineData; },
    set outlineData(value) { outlineData = value; },
    get originalPlanMarkdown() { return originalPlanMarkdown; },
    set originalPlanMarkdown(value) { originalPlanMarkdown = value; },
    get originalPlanSegments() { return originalPlanSegments; },
    set originalPlanSegments(value) { originalPlanSegments = value; },
    get contentRuntime() { return contentRuntime; },
    set contentRuntime(value) { contentRuntime = value; },
    get leaves() { return leaves; },
    set leaves(value) { leaves = value; },
    get maxTables() { return maxTables; },
    set maxTables(value) { maxTables = value; },
    get storedContentPlans() { return storedContentPlans; },
    set storedContentPlans(value) { storedContentPlans = value; },
    get knowledgeItems() { return knowledgeItems; },
    set knowledgeItems(value) { knowledgeItems = value; },
    get allowedKnowledgeItemIds() { return allowedKnowledgeItemIds; },
    set allowedKnowledgeItemIds(value) { allowedKnowledgeItemIds = value; },
    get knowledgeContentMap() { return knowledgeContentMap; },
    set knowledgeContentMap(value) { knowledgeContentMap = value; },
    get sections() { return sections; },
    set sections(value) { sections = value; },
    get tasksToRun() { return tasksToRun; },
    set tasksToRun(value) { tasksToRun = value; },
    get runLimits() { return runLimits; },
    set runLimits(value) { runLimits = value; },
    get logs() { return logs; },
    set logs(value) { logs = value; },
    get lastTaskProgress() { return lastTaskProgress; },
    set lastTaskProgress(value) { lastTaskProgress = value; },
    get totalContentWords() { return totalContentWords; },
    set totalContentWords(value) { totalContentWords = value; },
    appendLog(message) {
      logs = [...logs, message];
    },
  };

  // Agent 子任务执行层：错误诊断、忙碌判定、进度透传与失败输出恢复，
  // 实现见 generation/agentRun.cjs。
  const {
    agentErrorDiagnostics,
    isAgentBusyResult,
    createAgentActivityProgressHandler,
    runAgentTaskWithRecoveredOutput,
    runContentAgentTask,
  } = createAgentRun({
    state: ctx,
    agentService,
    publishTaskUpdate,
    statsSnapshot,
    writeDeveloperLog,
    pauseIfRequested,
    isPauseRequested,
  });

  // Agent 回包小节写回：状态与落盘回调显式注入，实现见 generation/agentWorkspace.cjs。
  const { applyAgentConsistencySections } = createAgentSectionWriter({
    state: ctx,
    rememberTouchedItem,
    saveSection,
  });
  // 原方案覆盖子阶段（正常审计 + Agent 修复两种模式）：
  // 状态与副作用显式注入，实现见 generation/stages/originalCoverageAudit.cjs。
  const { runOriginalPlanCoverageAuditIfEnabled, runAgentOriginalCoverageRepairIfEnabled } = createOriginalCoverageAuditStage({
    state: ctx,
    aiService,
    agentService,
    contentStats,
    contentConcurrency,
    enableOriginalPlanCoverageAudit,
    isExpansionWorkflow,
    tableRequirement,
    targetItemId,
    publishTaskUpdate,
    checkpointTask,
    syncRuntime,
    statsSnapshot,
    writeDeveloperLog,
    pauseIfRequested,
    isPauseRequested,
    continueAfterPromptCacheWarmup,
    rememberTouchedItem,
    saveSection,
    getOriginalMaterialRuntimeState,
    applyAgentConsistencySections,
    runAgentTaskWithRecoveredOutput,
    createAgentActivityProgressHandler,
    isAgentBusyResult,
    agentErrorDiagnostics,
  });
  // 全文一致性审计子阶段（普通模式）：实现见 generation/stages/consistencyAudit.cjs。
  const { buildConsistencyAuditTargets, runConsistencyAuditIfEnabled } = createConsistencyAuditStage({
    state: ctx,
    aiService,
    contentStats,
    contentConcurrency,
    globalFactsText,
    bidAnalysisFactsText,
    globalFactsMode,
    tableRequirement,
    targetItemId,
    enableConsistencyAudit,
    publishTaskUpdate,
    checkpointTask,
    syncRuntime,
    statsSnapshot,
    writeDeveloperLog,
    pauseIfRequested,
    isPauseRequested,
    continueAfterPromptCacheWarmup,
    rememberTouchedItem,
    saveSection,
    getLeafWordCount,
  });

  // Agent 模式的一致性审计阶段：实现见 generation/stages/agentConsistencyAudit.cjs。
  const { runAgentConsistencyRepairIfEnabled } = createAgentConsistencyAuditStage({
    state: ctx,
    agentService,
    contentStats,
    enableConsistencyAudit,
    globalFactsText,
    bidAnalysisFactsText,
    globalFactsMode,
    targetItemId,
    publishTaskUpdate,
    checkpointTask,
    syncRuntime,
    statsSnapshot,
    writeDeveloperLog,
    pauseIfRequested,
    isPauseRequested,
    buildConsistencyAuditTargets,
    applyAgentConsistencySections,
    runAgentTaskWithRecoveredOutput,
    createAgentActivityProgressHandler,
    isAgentBusyResult,
    agentErrorDiagnostics,
  });
  // 配图子阶段（规划 + 生成）：实现见 generation/stages/illustration.cjs。
  const { runIllustrationPlanning, runIllustrationGeneration } = createIllustrationStage({
    state: ctx,
    aiService,
    workspaceStore,
    generationOptions,
    contentStats,
    contentConcurrency,
    imageConcurrency,
    publishTaskUpdate,
    checkpointTask,
    syncRuntime,
    statsSnapshot,
    writeDeveloperLog,
    pauseIfRequested,
    isPauseRequested,
    rebuildContentWordCounts,
    runContentAgentTask,
  });
  // 正文去表格子阶段：状态与副作用显式注入，实现见 generation/stages/tableCleanup.cjs。
  const { removeTablesBeforeIllustration } = createTableCleanupStage({
    state: ctx,
    aiService,
    contentStats,
    tableRequirement,
    targetItemId,
    publishTaskUpdate,
    checkpointTask,
    syncRuntime,
    statsSnapshot,
    writeDeveloperLog,
    pauseIfRequested,
    rememberTouchedItem,
    saveSection,
  });


  try {
    if (continuePostProcessing) {
      const ignoredContexts = leaves.filter(({ item }) => isUnresolvedContentSection(sections[item.id]));
      for (const { item } of ignoredContexts) {
        const content = String(sections[item.id]?.content || item.content || '');
        saveSection(item, {
          status: 'ignored',
          content,
          error: undefined,
        }, content, { logs });
      }
      contentStats.ignored_section_count = ignoredContexts.length;
      contentStats.awaiting_content_decision = false;
      contentRuntime = syncRuntime({ awaiting_content_decision: false });
      logs = [...logs, `已按用户确认忽略 ${ignoredContexts.length} 个失败或未完成小节，开始执行后续流程。`];
      checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
        contentGenerationRuntime: contentRuntime,
      }, { contentRuntime });
    }

    if (!runOnlyIllustrationStage && tasksToRun.length) {
      if (targetItemId) {
        await prepareSingleSectionPlan();
        pauseIfRequested('正文生成已在正文编排后暂停，可导出当前已完成内容，稍后继续。');
        await restoreOriginalMaterialsIfNeeded(tasksToRun);
        pauseIfRequested('正文生成已在原方案还原阶段暂停，可导出当前已完成内容，稍后继续。');
        await runItemsWithWorkerPool(tasksToRun, contentConcurrency, runOne, isPauseRequested);
        pauseIfRequested('正文生成已在正文生成阶段暂停，可导出当前已完成内容，稍后继续。');
      } else {
        await planAll();
        pauseIfRequested('正文生成已在正文编排后暂停，可导出当前已完成内容，稍后继续。');
        await restoreOriginalMaterialsIfNeeded(tasksToRun);
        pauseIfRequested('正文生成已在原方案还原阶段暂停，可导出当前已完成内容，稍后继续。');
        if (tasksToRun.length) {
          await runContentTargetsWithWarmup(tasksToRun);
          pauseIfRequested('正文生成已在正文生成阶段暂停，可导出当前已完成内容，稍后继续。');
        }
      }
    }

    if (!runOnlyIllustrationStage && !targetItemId && !retryContentCorrection && !continuePostProcessing) {
      const unresolvedContexts = leaves.filter(({ item }) => isUnresolvedContentSection(sections[item.id]));
      if (unresolvedContexts.length) {
        persistContentDecisionWait(unresolvedContexts);
        return;
      }
      contentStats.awaiting_content_decision = false;
      contentRuntime = syncRuntime({ awaiting_content_decision: false });
      checkpointTask({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() }, {
        contentGenerationRuntime: contentRuntime,
      }, { contentRuntime });
    }

    if (!runOnlyIllustrationStage && !targetItemId && !retryContentCorrection && !completedStages.has('section-word-adjusting')) {
      await runSectionWordAdjustments(leaves, 'section');
      markStageCompleted('section-word-adjusting');
      pauseIfRequested('正文生成已在小节字数调整后暂停，可导出当前已完成内容，稍后继续。');
    }

    if (!runOnlyIllustrationStage && !targetItemId) {
      if (retryContentCorrection) {
        logs = [...logs, '本次为内容矫正重试，跳过正文生成，直接进入内容矫正阶段。'];
        publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
      }
      if (!completedStages.has('original-auditing')) {
        if (originalPlanCoverageRepairMode === 'agent') {
          await runAgentOriginalCoverageRepairIfEnabled();
        } else {
          await runOriginalPlanCoverageAuditIfEnabled();
        }
        markStageCompleted('original-auditing');
      }
      pauseIfRequested('正文生成已在原方案覆盖审计后暂停，可导出当前已完成内容，稍后继续。');
      if (!completedStages.has('auditing')) {
        if (consistencyRepairMode === 'agent') {
          await runAgentConsistencyRepairIfEnabled();
        } else {
          await runConsistencyAuditIfEnabled();
        }
        markStageCompleted('auditing');
      }
      if (!completedStages.has('table-cleaning')) {
        await removeTablesBeforeIllustration();
        markStageCompleted('table-cleaning');
      }
      pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
      const unresolvedSections = completedStages.has('final-section-word-adjusting')
        ? leaves.filter(({ item }) => sections[item.id]?.status === 'success' && isSectionWordsOutsideRange(wordControl, getLeafWordCount(item))).map(({ item }) => item.id)
        : await runSectionWordAdjustments(leaves, 'final-section');
      markStageCompleted('final-section-word-adjusting');
      if (!completedStages.has('total-word-adjusting')) {
        await runTotalWordAdjustments();
        markStageCompleted('total-word-adjusting');
      }
      const postAdjustmentSectionViolations = wordControl.strictSectionWords
        ? leaves.filter(({ item }) => sections[item.id]?.status === 'success' && isSectionWordsOutsideRange(wordControl, getLeafWordCount(item)))
        : [];
      if (unresolvedSections.length && !postAdjustmentSectionViolations.length) {
        logs = [...logs, '全文调整已同时修复此前未达标的小节字数。'];
      }
    } else if (!runOnlyIllustrationStage) {
      if (!completedStages.has('original-auditing')) {
        await runOriginalPlanCoverageAuditIfEnabled({ targetItemId });
        markStageCompleted('original-auditing');
      }
      pauseIfRequested('正文生成已在原方案覆盖审计后暂停，可导出当前已完成内容，稍后继续。');
      if (!completedStages.has('auditing')) {
        await runConsistencyAuditIfEnabled({ targetItemId });
        markStageCompleted('auditing');
      }
      if (!completedStages.has('table-cleaning')) {
        await removeTablesBeforeIllustration({ targetItemId });
        markStageCompleted('table-cleaning');
      }
      pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
      const targetContext = leaves.find(({ item }) => item.id === targetItemId);
      if (targetContext && wordControl.strictSectionWords && !completedStages.has('section-word-adjusting')) {
        contentStats.phase = 'section-word-adjusting';
        contentStats.section_adjustment_total = 1;
        contentStats.section_adjustment_completed = 0;
        contentStats.section_adjustment_active_count = 1;
        const resumingSectionAdjustment = resume
          && contentRuntime.word_adjustment_stage === 'section';
        const itemRounds = resumingSectionAdjustment ? { ...contentRuntime.word_adjustment_item_rounds } : {};
        const completedItemIds = resumingSectionAdjustment ? [...contentRuntime.word_adjustment_completed_item_ids] : [];
        if (!resumingSectionAdjustment) setWordAdjustmentRuntime('section', targetItemId, 0, completedItemIds, itemRounds);
        await adjustSectionToRange(
          targetContext,
          'section',
          itemRounds,
          completedItemIds,
        );
        if (!completedItemIds.includes(targetItemId)) completedItemIds.push(targetItemId);
        contentStats.section_adjustment_completed = 1;
        contentStats.section_adjustment_active_count = 0;
        contentStats.section_adjustment_item_id = '';
        contentStats.section_adjustment_round = 0;
        setWordAdjustmentRuntime('section', '', 0, completedItemIds, itemRounds);
        markStageCompleted('section-word-adjusting');
      }
    } else if (runOnlyIllustrationPlanning) {
      logs = [...logs, rerunIllustrations
        ? '开始仅重新配图：清除旧配图后，重新执行全文图片编排和生成阶段。'
        : '继续全文图片编排，跳过已完成的正文生成和内容矫正阶段。'];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
    } else {
      logs = [...logs, '继续图片生成，跳过已完成的正文生成、内容矫正和图片编排阶段。'];
      publishTaskUpdate({ status: 'running', progress: progressFor(leaves, sections), logs, stats: statsSnapshot() });
    }

    if (!targetItemId) {
      let illustrationPlan = runOnlyIllustrationGeneration ? storedPlan.contentIllustrationPlan : null;
      if (!runOnlyIllustrationGeneration) {
        pauseIfRequested('正文生成已在全文图片编排前暂停，可导出当前已完成内容，稍后继续。');
        illustrationPlan = await runIllustrationPlanning();
      }
      pauseIfRequested('正文生成已在图片生成前暂停，可导出当前已完成内容，稍后继续。');
      await runIllustrationGeneration(illustrationPlan);
    }
    pauseIfRequested('正文生成已在完成前暂停，可导出当前已完成内容，稍后继续。');

    const statusLeaves = targetItemId ? leaves.filter(({ item }) => item.id === targetItemId) : leaves;
    for (const { item } of statusLeaves) {
      const status = sections[item.id]?.status;
      if (status === 'error' || status === 'ignored') continue;
      const content = getLeafContentForWords(item);
      if (countContentWords(content) > 0) {
        if (status !== 'success') {
          saveSection(item, { status: 'success', content, error: undefined }, content, { logs });
        }
        continue;
      }
      const message = '正文最终结果没有有效可读内容';
      logs = [...logs, `正文有效性检查失败：${item.id} ${item.title || '未命名章节'}，${message}。`];
      saveSection(item, { status: 'error', content, error: message }, content, { logs });
    }
    rebuildContentWordCounts();
    const finalSectionViolations = wordControl.strictSectionWords
      ? statusLeaves.filter(({ item }) => sections[item.id]?.status === 'success' && isSectionWordsOutsideRange(wordControl, getLeafWordCount(item)))
      : [];
    const finalTotalDirection = targetItemId ? null : getTotalWordDirection(wordControl, countTotalContentWords());
    contentStats.word_control_warning = finalSectionViolations.length || finalTotalDirection
      ? (targetItemId ? SECTION_WORD_CONTROL_WARNING : CONTENT_WORD_CONTROL_WARNING)
      : undefined;
    const failedCount = statusLeaves.filter(({ item }) => sections[item.id]?.status === 'error').length;
    const finalProgress = progressFor(leaves, sections);
    const finalStatus = taskStatusFor(statusLeaves, sections);
    contentStats.phase = 'done';
    logs = [...logs, targetItemId
      ? (failedCount ? `小节重新生成结束，当前整体进度 ${finalProgress}%，${failedCount} 个小节失败。` : `小节重新生成完成，当前整体进度 ${finalProgress}%。`)
      : (failedCount ? `正文生成完成，${failedCount} 个小节失败。` : '正文生成完成。')];
    if (contentStats.word_control_warning) logs = [...logs, contentStats.word_control_warning];
    writeDeveloperLog('content.task.completed', {
      status: finalStatus,
      progress: finalProgress,
      failed_count: failedCount,
      stats: statsSnapshot(),
      touched_item_ids: [...touchedItemIds],
    });
    checkpointTask({ status: finalStatus, progress: finalProgress, logs, stats: statsSnapshot(), pause_requested: false }, {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationPlans: storedContentPlans,
      contentGenerationRuntime: undefined,
    });
  } catch (error) {
    if (isAiQueueScopePausedError(error)) {
      persistPausedContentGeneration('正文生成已暂停，未发起的 AI 请求已从队列丢弃，可导出当前已完成内容，稍后继续。');
      writeDeveloperLog('content.task.paused', {
        message: error.message || 'queue paused',
        stats: statsSnapshot(),
        touched_item_ids: [...touchedItemIds],
      });
      return;
    }
    if (isContentGenerationPausedError(error)) {
      writeDeveloperLog('content.task.paused', {
        message: error.message || 'paused',
        stats: statsSnapshot(),
        touched_item_ids: [...touchedItemIds],
      });
      return;
    }
    writeDeveloperLog('content.task.error', {
      error: error.message || '任务执行失败',
      stack: error.stack || '',
      stats: statsSnapshot(),
    });
    throw error;
  }
}

// 仅供开发者局部测试页复用当前正式正文扩写 patch runtime。
// 正式业务入口仍然只使用 runContentGenerationTask；测试页不得复制这组逻辑另起实现。
const __developerContentExpansionPatchRuntime = {
  normalizeContentExpansionPatch,
  validateContentExpansionPatch,
  buildContentExpansionRepairMessages,
  findContentExpansionTargetTextMatch,
  applyContentExpansionPatch,
};

module.exports = { runContentGenerationTask, stripRepeatedChapterTitle, __developerContentExpansionPatchRuntime };
