// 原方案正文还原子阶段：把原方案原文段映射到待生成小节，并把还原结果写回方案。
//
// 该阶段原本是 runContentGenerationTask 内部的闭包；这里把状态与副作用显式注入，
// 自身不持有模块级状态，可单独测试。
//
// deps 约定：
//   aiService / contentStats                                             直接读的服务与进度对象
//   originalPlanSegmentById / projectOverview / bidAnalysisFactsText / globalFactTitlesText
//                                                                         只读索引与提示词事实文本
//   isExpansionWorkflow / targetItemId / regenerate                       流程开关
//   getOriginalMaterialRuntimeState / buildOriginalMaterialFromSegments   来自 generation/originalMaterialState.cjs
//   state.leaves / state.sections / state.logs / state.originalPlanSegments
//                                                                         读取会被重新赋值的闭包变量
//   state.appendLog(message)                                              追加一行任务日志
//   其余为任务运行时回调与落盘入口

const { progressFor } = require('./../progress.cjs');
const { normalizeOriginalRestoreAssignments } = require('./../agentResponse.cjs');
const {
  parseAgentJsonContent,
  buildAgentOriginalMaterialRestorePrompt,
  buildAgentOriginalMaterialRestoreFiles,
} = require('./../agentRestore.cjs');
const { buildOriginalMaterialRestoreMessages } = require('./../contentMessages.cjs');
const { buildOriginalRestoreRepairMessages } = require('./../promptBuilders.cjs');
const { validateOriginalRestoreAssignments } = require('./../validators.cjs');
const {
  shouldUseAgentForMessages,
  getMessagesContentLength,
  getTextContextLengthLimit,
  AGENT_CONTEXT_THRESHOLD_RATIO,
} = require('./../aiCallContext.cjs');
const { textMetrics } = require('./../textEdits.cjs');

function createOriginalMaterialRestoreStage(deps) {
  const {
    aiService,
    contentStats,
    originalPlanSegmentById,
    projectOverview,
    bidAnalysisFactsText,
    globalFactTitlesText,
    isExpansionWorkflow,
    targetItemId,
    regenerate,

    publishTaskUpdate,
    checkpointTask,
    syncRuntime,
    statsSnapshot,
    writeDeveloperLog,
    pauseIfRequested,

    getOriginalMaterialRuntimeState,
    buildOriginalMaterialFromSegments,
    getContentPlanForItem,
    saveSectionAndContentPlan,
    runContentAgentTask,
  } = deps;
  const { state } = deps;

  async function restoreOriginalMaterialsIfNeeded(targets) {
    if (!isExpansionWorkflow || !state.originalPlanSegments.length || !targets?.length) {
      return;
    }

    const targetStates = targets.map((context) => ({ context, state: getOriginalMaterialRuntimeState(context.item) }));
    const rebuildTargets = targetStates.filter(({ state }) => state.canRebuildRestoredContent || (targetItemId && regenerate && state.validRestored));
    const restoreTargets = targetStates
      .filter(({ state }) => !state.validRestored && !state.canRebuildRestoredContent)
      .map(({ context }) => context);
    if (!restoreTargets.length && !rebuildTargets.length) {
      state.appendLog('原方案还原：当前待生成小节均已完成还原，跳过还原阶段。');
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      return;
    }

    contentStats.phase = 'restoring';
    contentStats.restoration_total = rebuildTargets.length + restoreTargets.length;
    contentStats.restoration_completed = 0;
    state.appendLog(`开始原方案还原：${state.originalPlanSegments.length} 个原文段，${restoreTargets.length} 个候选叶子小节，${rebuildTargets.length} 个小节可直接重建原文。`);
    const restoringRuntime = syncRuntime({ phase: 'restoring' });
    checkpointTask({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: restoringRuntime,
    }, { contentRuntime: restoringRuntime });

    const assignedSourceIds = new Set();
    const completedRestoreTargetIds = new Set();
    let restoredCount = 0;
    for (const { context, state: runtimeState } of rebuildTargets) {
      const segments = runtimeState.sourceSegments;
      segments.forEach((segment) => assignedSourceIds.add(segment.id));
      const restoredContent = segments.map((segment) => segment.content).join('\n\n').trim();
      const originalMaterial = buildOriginalMaterialFromSegments(segments, runtimeState.originalMaterial);
      completedRestoreTargetIds.add(context.item.id);
      contentStats.restoration_completed = completedRestoreTargetIds.size;
      saveSectionAndContentPlan(context.item, { status: 'idle', content: restoredContent, error: undefined }, restoredContent, {
        ...runtimeState.plan,
        original_material: originalMaterial,
      }, { logs: state.logs });
      restoredCount += 1;
    }

    if (restoreTargets.length) {
      const allowedNodeIds = new Set(restoreTargets.map(({ item }) => item.id).filter(Boolean));
      const allowedSourceIds = new Set(state.originalPlanSegments.map((segment) => segment.id));
      const restoreMessages = buildOriginalMaterialRestoreMessages({
        targets: restoreTargets,
        originalSegments: state.originalPlanSegments,
        projectOverview,
        bidAnalysisFactsText,
        globalFactTitlesText,
      });
      let result;
      if (shouldUseAgentForMessages(aiService, restoreMessages)) {
        const messagesLength = getMessagesContentLength(restoreMessages);
        const contextLengthLimit = getTextContextLengthLimit(aiService);
        state.appendLog(`原方案还原映射提示词 ${messagesLength} 字符，超过上下文阈值 ${Math.floor(contextLengthLimit * AGENT_CONTEXT_THRESHOLD_RATIO)}，切换 Agent 文件模式。`);
        writeDeveloperLog('original_restore.agent.start', {
          message_chars: messagesLength,
          context_length_limit: contextLengthLimit,
          threshold_ratio: AGENT_CONTEXT_THRESHOLD_RATIO,
          target_count: restoreTargets.length,
          original_segment_count: state.originalPlanSegments.length,
        });
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
        let validatedRestoreResult = null;
        const { agentResult, outputContent } = await runContentAgentTask({
          title: '原方案正文还原映射 Agent',
          prompt: buildAgentOriginalMaterialRestorePrompt(),
          outputFile: 'original-restore-result.json',
          files: buildAgentOriginalMaterialRestoreFiles({
            targets: restoreTargets,
            originalSegments: state.originalPlanSegments,
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
          repairMessagesBuilder: (context) => buildOriginalRestoreRepairMessages(context, restoreTargets, state.originalPlanSegments),
          progressCallback: (message) => {
            state.appendLog(message || '原方案还原映射格式校验失败，正在修复');
            publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
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
        }, { logs: state.logs });
        restoredCount += 1;
      }
    }

    contentStats.restoration_completed = contentStats.restoration_total;
    const unassignedCount = state.originalPlanSegments.filter((segment) => !assignedSourceIds.has(segment.id)).length;
    state.appendLog(`原方案还原完成：已还原 ${restoredCount} 个小节，未分配原文段 ${unassignedCount} 个。`);
    contentStats.phase = 'generating';
    const generatingRuntime = syncRuntime({ phase: 'generating' });
    checkpointTask({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: generatingRuntime,
    }, { contentRuntime: generatingRuntime });
  }

  return { restoreOriginalMaterialsIfNeeded };
}

module.exports = { createOriginalMaterialRestoreStage };
