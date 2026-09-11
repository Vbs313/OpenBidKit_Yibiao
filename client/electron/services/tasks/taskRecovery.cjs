// 任务中断恢复：应用异常退出后，把各领域的「运行中」任务收敛成可继续/可重跑的状态。
//
// 该组原本是 createTaskService 内部的闭包；这里把任务表、事件出口、各领域 store 与
// 少量任务规则显式注入。启动期的调用顺序仍留在 taskService.cjs（组合点）。

function createTaskRecovery(deps) {
  const {
    activeTasks,
    emit,
    buildSnapshot,
    getTaskDefinition,
    startManagedTask,
    isActiveTaskStatus,
    now,
    normalizeInterruptedContentSections,
    inferContentGenerationPhase,
    OUTLINE_AGENT_TASK_KEY,
    TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
    runOutlineGenerationTaskV2,
    agentService,
    technicalPlanStore,
    rejectionCheckStore,
    duplicateCheckStore,
    feasibilityReportStore,
  } = deps;
function recoverInterruptedContentGenerationTask(technicalPlan) {
    if (activeTasks.has('content-generation')) {
      return;
    }

    const contentTask = technicalPlan.contentGenerationTask;
    if (!isActiveTaskStatus(contentTask?.status)) {
      return;
    }

    const { sections, outlineData, interruptedIds } = normalizeInterruptedContentSections(technicalPlan);
    const normalizedPlan = interruptedIds.size
      ? { ...technicalPlan, contentGenerationSections: sections, outlineData }
      : technicalPlan;
    const phase = inferContentGenerationPhase(normalizedPlan);
    const nextLogs = [
      ...(Array.isArray(contentTask.logs) ? contentTask.logs : []),
      '上次正文生成因应用关闭而暂停，可点击继续恢复。',
    ];
    const nextStats = {
      ...(contentTask.stats || {}),
      content: {
        ...(contentTask.stats?.content || {}),
        phase,
      },
    };
    const pausedTask = {
      ...contentTask,
      status: 'paused',
      pause_requested: false,
      logs: nextLogs,
      stats: nextStats,
      updated_at: now(),
    };
    const partial = {
      outlineData,
      contentGenerationSections: sections,
      contentGenerationTask: pausedTask,
      contentGenerationRuntime: {
        ...(normalizedPlan.contentGenerationRuntime || {}),
        phase,
        updated_at: now(),
      },
    };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(pausedTask, buildSnapshot(getTaskDefinition('content-generation'), partial, pausedTask));
  }

function recoverInterruptedOutlineGenerationTask(technicalPlan) {
    if (activeTasks.has('outline-generation')) {
      return;
    }

    const outlineTask = technicalPlan.outlineGenerationTask;
    if (!isActiveTaskStatus(outlineTask?.status)) {
      return;
    }

    const agentState = outlineTask.stats?.agent || {};
    let persistentTask = null;
    let templatePersistentTask = null;
    try {
      persistentTask = agentService.loadPersistentTask(OUTLINE_AGENT_TASK_KEY);
    } catch {}
    try {
      templatePersistentTask = agentService.loadPersistentTask(TEMPLATE_EXTRACTION_AGENT_TASK_KEY);
    } catch {}
    const recoverableWaiting = persistentTask?.state?.run_id === outlineTask.task_id
      && persistentTask.state.status === 'waiting-outline-selection'
      && persistentTask.state.phase === 'outline-selection'
      && persistentTask.state.agent_connection === 'idle'
      && Boolean(persistentTask.state.session_file)
      && agentService.hasPersistentTaskSession(OUTLINE_AGENT_TASK_KEY)
      && Boolean(outlineTask.stats?.outline_selection?.items?.length)
      && outlineTask.stats.outline_selection.confirmed !== true;
    if (recoverableWaiting) {
      startManagedTask('outline-generation', {
        ...(agentState.resume_payload || {}),
        agent_resume: {
          phase: 'outline-selection',
        },
      }, runOutlineGenerationTaskV2, {}, {
        existingTask: outlineTask,
        skipInitialStateUpdate: true,
        restoreOutlineSelectionWaiter: true,
        primarySession: agentService.isPrimarySession({ task_key: OUTLINE_AGENT_TASK_KEY }),
      });
      return;
    }

    const message = '上次目录生成未完成，请重新生成目录。';
    if (persistentTask) {
      try {
        agentService.updatePersistentTask(OUTLINE_AGENT_TASK_KEY, {
          status: 'interrupted',
          agent_connection: 'idle',
          error: message,
        });
      } catch {}
    }
    if (templatePersistentTask) {
      try {
        agentService.updatePersistentTask(TEMPLATE_EXTRACTION_AGENT_TASK_KEY, {
          status: 'interrupted',
          agent_connection: 'idle',
          error: message,
        });
      } catch {}
    }
    try { technicalPlanStore.clearBidTemplate(); } catch {}
    const recoveredStats = { ...(outlineTask.stats || {}) };
    delete recoveredStats.outline_selection;
    if (recoveredStats.agent) {
      recoveredStats.agent = {
        ...recoveredStats.agent,
        status: 'interrupted',
        agent_connection: 'idle',
      };
    }
    if (recoveredStats.template_agent) {
      recoveredStats.template_agent = {
        ...recoveredStats.template_agent,
        status: 'interrupted',
        agent_connection: 'idle',
      };
    }
    const recoveredTask = {
      ...outlineTask,
      status: 'error',
      progress: Math.max(0, Math.min(99, Number(outlineTask.progress || 0) || 0)),
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(outlineTask.logs) ? outlineTask.logs : []), message],
      stats: recoveredStats,
      updated_at: now(),
    };
    const partial = { outlineGenerationTask: recoveredTask };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('outline-generation'), partial, recoveredTask));
  }

function recoverInterruptedOutlineAdjustmentTask(technicalPlan) {
    if (activeTasks.has('outline-adjustment')) {
      return;
    }

    const adjustmentTask = technicalPlan.outlineAdjustmentTask;
    if (!isActiveTaskStatus(adjustmentTask?.status)) {
      return;
    }

    const message = '上次目录 AI 调整未完成，请重新发送调整要求。';
    const recoveredTask = {
      ...adjustmentTask,
      status: 'error',
      progress: Math.max(0, Math.min(99, Number(adjustmentTask.progress || 0) || 0)),
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(adjustmentTask.logs) ? adjustmentTask.logs : []), message],
      updated_at: now(),
    };
    const partial = { outlineAdjustmentTask: recoveredTask };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('outline-adjustment'), partial, recoveredTask));
  }

function recoverInterruptedGlobalFactsAdjustmentTask(technicalPlan) {
    if (activeTasks.has('global-facts-adjustment')) {
      return;
    }

    const adjustmentTask = technicalPlan.globalFactsAdjustmentTask;
    if (!isActiveTaskStatus(adjustmentTask?.status)) {
      return;
    }

    const message = '上次全局事实 AI 调整未完成，请重新发送调整要求。';
    const recoveredTask = {
      ...adjustmentTask,
      status: 'error',
      progress: Math.max(0, Math.min(99, Number(adjustmentTask.progress || 0) || 0)),
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(adjustmentTask.logs) ? adjustmentTask.logs : []), message],
      updated_at: now(),
    };
    const partial = { globalFactsAdjustmentTask: recoveredTask };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('global-facts-adjustment'), partial, recoveredTask));
  }

function recoverInterruptedBidAnalysisTask(technicalPlan) {
    if (activeTasks.has('bid-analysis')) {
      return;
    }

    const bidAnalysisTask = technicalPlan.bidAnalysisTask;
    if (!isActiveTaskStatus(bidAnalysisTask?.status)) {
      return;
    }

    const message = '上次招标文件解析未完成，请重新解析';
    const interruptedBidAnalysisTasks = {};
    for (const [itemId, item] of Object.entries(technicalPlan.bidAnalysisTasks || {})) {
      if (item?.status === 'running') {
        interruptedBidAnalysisTasks[itemId] = {
          ...item,
          status: 'error',
          error: message,
        };
      }
    }

    const logs = Array.isArray(bidAnalysisTask.logs) ? bidAnalysisTask.logs : [];
    const recoveredTask = {
      ...bidAnalysisTask,
      status: 'error',
      progress: 100,
      pause_requested: false,
      error: message,
      logs: logs.includes(message) ? logs : [...logs, message],
      updated_at: now(),
    };
    const partial = Object.keys(interruptedBidAnalysisTasks).length
      ? { bidAnalysisTask: recoveredTask, bidAnalysisTasks: interruptedBidAnalysisTasks }
      : { bidAnalysisTask: recoveredTask };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('bid-analysis'), partial, recoveredTask));
  }

function recoverInterruptedBidSectionExtractionTask(technicalPlan) {
    if (activeTasks.has('bid-section-extraction')) {
      return;
    }

    const extractionTask = technicalPlan.bidSectionExtractionTask;
    if (!isActiveTaskStatus(extractionTask?.status)) {
      return;
    }

    const message = '上次多标段识别未完成，请重新识别';
    const recoveredTask = {
      ...extractionTask,
      status: 'error',
      progress: 100,
      pause_requested: false,
      error: message,
      logs: [...(Array.isArray(extractionTask.logs) ? extractionTask.logs : []), message],
      updated_at: now(),
    };
    const partial = {
      bidSectionExtractionTask: recoveredTask,
      bidSectionExtractionStatus: 'error',
      bidSectionExtractionError: message,
    };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('bid-section-extraction'), partial, recoveredTask));
  }

function recoverInterruptedGlobalFactsTask(technicalPlan) {
    if (activeTasks.has('global-facts-generation')) {
      return;
    }

    const globalFactsTask = technicalPlan.globalFactsTask;
    if (!isActiveTaskStatus(globalFactsTask?.status)) {
      return;
    }

    const message = '上次全局事实设定未完成，请重新解析';
    const recoveredTask = {
      ...globalFactsTask,
      status: 'error',
      progress: 100,
      error: message,
      logs: [...(Array.isArray(globalFactsTask.logs) ? globalFactsTask.logs : []), message],
      updated_at: now(),
    };
    const partial = { globalFactsTask: recoveredTask };
    technicalPlanStore.updateTechnicalPlanWithoutReload(partial);
    emit(recoveredTask, buildSnapshot(getTaskDefinition('global-facts-generation'), partial, recoveredTask));
  }

function recoverInterruptedRejectionCheckTasks(state) {
    const staleExtractionMessage = '上次解析未完成，请重新解析';
    const staleCheckMessage = '上次检查未完成，请重新检查';
    const partial = {};

    if (!activeTasks.has('rejection-items-extraction') && state.extractionTask?.status === 'running') {
      partial.invalidBidAndRejectionItems = state.invalidBidAndRejectionItems?.status === 'running'
        ? { ...state.invalidBidAndRejectionItems, status: 'error', error: staleExtractionMessage, updatedAt: now() }
        : state.invalidBidAndRejectionItems;
      partial.extractionTask = {
        ...state.extractionTask,
        status: 'error',
        progress: 100,
        error: staleExtractionMessage,
        logs: [staleExtractionMessage],
        updated_at: now(),
      };
    }

    if (!activeTasks.has('rejection-check-run') && state.checkTask?.status === 'running') {
      const markResult = (result) => result?.status === 'running'
        ? { ...result, status: 'error', error: staleCheckMessage, progressMessage: staleCheckMessage, updatedAt: now() }
        : result;
      partial.rejectionCheckResult = markResult(state.rejectionCheckResult);
      partial.typoCheckResult = markResult(state.typoCheckResult);
      partial.logicCheckResult = markResult(state.logicCheckResult);
      partial.checkTask = {
        ...state.checkTask,
        status: 'error',
        progress: 100,
        error: staleCheckMessage,
        logs: [staleCheckMessage],
        updated_at: now(),
      };
    }

    if (Object.keys(partial).length) {
      rejectionCheckStore.updateRejectionCheckWithoutReload(partial);
    }
  }

function recoverInterruptedDuplicateCheckTask(state) {
    if (activeTasks.has('duplicate-analysis')) {
      return;
    }
    if (state.analysisTask?.status !== 'running') {
      return;
    }
    const message = '上次标书查重分析未完成，请重新分析';
    const markAnalysis = (analysis) => analysis?.status === 'running'
      ? { ...analysis, status: 'error', progress: 100, message, updated_at: now() }
      : analysis;
    const recoveredTask = {
      ...state.analysisTask,
      status: 'error',
      progress: 100,
      logs: [message],
      error: message,
      updated_at: now(),
    };
    const partial = {
      analysisTask: recoveredTask,
      metadataAnalysis: markAnalysis(state.metadataAnalysis),
      outlineAnalysis: markAnalysis(state.outlineAnalysis),
      contentAnalysis: markAnalysis(state.contentAnalysis),
      imageAnalysis: markAnalysis(state.imageAnalysis),
    };
    duplicateCheckStore.updateDuplicateCheckWithoutReload(partial);
    emit(recoveredTask, { duplicateCheckPatch: partial });
  }

function recoverInterruptedFeasibilityTasks(state) {
    if (!feasibilityReportStore) return;
    const markError = (task, message) => {
      if (!isActiveTaskStatus(task?.status)) return undefined;
      return {
        ...task,
        status: 'error',
        progress: 100,
        error: message,
        logs: [...(Array.isArray(task.logs) ? task.logs : []), message],
        updated_at: now(),
      };
    };
    const interruptMessage = '上次任务因应用关闭而中断，请重新开始。';
    const pausedMessage = '上次正文生成因应用关闭而暂停，可点击继续恢复。';
    const partial = {};
    const analysisTask = markError(state.analysisTask, interruptMessage);
    const outlineTask = markError(state.outlineTask, interruptMessage);
    const parametersTask = markError(state.parametersTask, interruptMessage);
    const humanWritingTask = markError(state.humanWritingTask, interruptMessage);
    if (analysisTask) partial.analysisTask = analysisTask;
    if (outlineTask) partial.outlineTask = outlineTask;
    if (parametersTask) partial.parametersTask = parametersTask;
    if (humanWritingTask) partial.humanWritingTask = humanWritingTask;
    if (isActiveTaskStatus(state.outlineAdjustmentTask?.status)) {
      const message = '上次目录 AI 调整未完成，请重新发送调整要求。';
      partial.outlineAdjustmentTask = {
        ...state.outlineAdjustmentTask,
        status: 'error',
        progress: Math.max(0, Math.min(99, Number(state.outlineAdjustmentTask.progress || 0) || 0)),
        pause_requested: false,
        error: message,
        logs: [...(Array.isArray(state.outlineAdjustmentTask.logs) ? state.outlineAdjustmentTask.logs : []), message],
        updated_at: now(),
      };
    }
    if (isActiveTaskStatus(state.contentTask?.status)) {
      partial.contentTask = {
        ...state.contentTask,
        status: 'paused',
        pause_requested: false,
        logs: [...(Array.isArray(state.contentTask.logs) ? state.contentTask.logs : []), pausedMessage],
        updated_at: now(),
      };
    }
    if (!Object.keys(partial).length) return;
    feasibilityReportStore.updateFeasibilityReportWithoutReload(partial);
    const recovered = partial.contentTask || analysisTask || outlineTask || partial.outlineAdjustmentTask || parametersTask || humanWritingTask;
    if (recovered) emit(recovered, { feasibilityReportPatch: partial });
  }
  return {
    recoverInterruptedContentGenerationTask,
    recoverInterruptedOutlineGenerationTask,
    recoverInterruptedOutlineAdjustmentTask,
    recoverInterruptedGlobalFactsAdjustmentTask,
    recoverInterruptedBidAnalysisTask,
    recoverInterruptedBidSectionExtractionTask,
    recoverInterruptedGlobalFactsTask,
    recoverInterruptedRejectionCheckTasks,
    recoverInterruptedDuplicateCheckTask,
    recoverInterruptedFeasibilityTasks,
  };
}

module.exports = { createTaskRecovery };
