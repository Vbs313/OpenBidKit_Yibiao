// 正文小节生成阶段：逐小节编排（planOne）→ 全文编排预热（planAll）→ 逐小节生成（runOne）。
//
// 该阶段原本是 runContentGenerationTask 内部的闭包；这里把状态与副作用显式注入，
// 自身不持有模块级状态，可单独测试。
//
// deps 约定：
//   aiService / contentStats / contentConcurrency                                直接读的服务与进度对象
//   contentPlans / wordControl / tableRequirement / targetItemId / regenerate /
//   regenerateRequirement / resume / projectOverview / bidAnalysisFactsText /
//   globalFactTitlesText / globalFactsMode / globalFacts / storedPlan /
//   retryItemIds / simulatedFailureItemIds                                      运行参数与事实输入
//   state.leaves / state.sections / state.logs / state.tasksToRun /
//   state.storedContentPlans / state.runLimits / state.maxTables / state.knowledgeItems /
//   state.allowedKnowledgeItemIds / state.knowledgeContentMap                    会被重新赋值的闭包变量
//   state.appendLog(message)                                                     追加一行任务日志
//   其余为任务运行时回调与落盘入口

const { progressFor } = require('./../progress.cjs');
const { isPauseLikeError, runItemsWithWorkerPool } = require('./../taskRuntime.cjs');
const { textMetrics } = require('./../textEdits.cjs');
const {
  normalizeContentPlan,
  normalizeOriginalMaterial,
  normalizeLeafContentForSave,
  stripRepeatedChapterTitle,
  now,
} = require('./../normalize.cjs');
const { validateContentPlan } = require('./../validators.cjs');
const {
  normalizeGeneratedMarkdown,
  clearContentPlanTable,
  pickDistributedTableTargets,
} = require('./../markdownTables.cjs');
const {
  computeGenerationWordTarget,
  createStoredContentPlan,
  pruneContentGenerationPlans,
} = require('./../storedPlan.cjs');
const {
  buildChapterContentPlanMessages,
  buildChapterContentMessages,
  buildRestoredChapterContentMessages,
} = require('./../contentMessages.cjs');
const { resolveKnowledgeContents, resolveSelectedFactsText } = require('./../knowledgeResolution.cjs');
const {
  shouldUseAgentForMessages,
  getMessagesContentLength,
  getTextContextLengthLimit,
  AGENT_CONTEXT_THRESHOLD_RATIO,
  countContentWords,
} = require('./../aiCallContext.cjs');
const {
  buildAgentRestoredChapterContentPrompt,
  buildAgentRestoredChapterContentFiles,
} = require('./../agentRestore.cjs');

function createSectionGenerationStage(deps) {
  const {
    aiService,
    contentStats,
    contentConcurrency,
    contentPlans,
    wordControl,
    tableRequirement,
    targetItemId,
    regenerate,
    regenerateRequirement,
    resume,
    projectOverview,
    bidAnalysisFactsText,
    globalFactTitlesText,
    globalFactsMode,
    globalFacts,
    storedPlan,
    retryItemIds,
    simulatedFailureItemIds,

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
    saveSectionAndContentPlan,
    markGenerationCompleted,
    persistContentPlans,
    getReusableStoredContentPlan,
    getContentPlanForItem,
    refreshRunLimits,
    getOriginalMaterialRuntimeState,
    allowedFactTitles,
    runContentAgentTask,
  } = deps;
  const { state } = deps;

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
          maxTables: state.maxTables,
          tableTotalSections: state.leaves.length,
          knowledgeItems: state.knowledgeItems,
        }),
        logTitle: `正文编排-${item.id}-${item.title || '未命名章节'}`,
        progressLabel: '正文编排决策',
        failureMessage: '模型返回的正文编排决策格式无效',
        normalizer: (value) => normalizeContentPlan(value, state.allowedKnowledgeItemIds, allowedFactTitles),
        validator: validateContentPlan,
      });
    } catch (error) {
      if (isPauseLikeError(error)) {
        throw error;
      }
      contentPlan = normalizeContentPlan({}, state.allowedKnowledgeItemIds, allowedFactTitles);
      state.appendLog(`编排失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}，将按纯正文生成。`);
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
    state.storedContentPlans = pruneContentGenerationPlans({
      ...state.storedContentPlans,
      [item.id]: createStoredContentPlan(contentPlan, tableRequirement),
    }, state.leaves);
    const runtime = syncRuntime();
    contentStats.planning_completed += 1;
    state.appendLog(`编排完成：${item.id} ${item.title || '未命名章节'}（知识库：${contentPlan.knowledge.item_ids.length} 条，事实变量：${contentPlan.facts.titles.length} 项，表格：${contentPlan.table.needed ? '需要' : '不需要'}）`);
    checkpointTask({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() }, {
      contentGenerationItem: { nodeId: item.id, storedPlan: state.storedContentPlans[item.id], runtime },
    }, { contentRuntime: runtime });
  }

  async function planAll() {
    refreshRunLimits(state.tasksToRun);
    contentStats.phase = 'planning';
    contentStats.planning_total = state.tasksToRun.length;
    const planningTargets = [];
    for (const context of state.tasksToRun) {
      const storedContentPlan = getReusableStoredContentPlan(context.item.id);
      if (storedContentPlan?.plan) {
        contentPlans.set(context.item.id, storedContentPlan.plan);
      } else {
        planningTargets.push(context);
      }
    }
    contentStats.planning_completed = state.tasksToRun.length - planningTargets.length;
    contentStats.generation_total = state.tasksToRun.length;
    state.appendLog(planningTargets.length === state.tasksToRun.length
      ? `开始整体编排决策，共 ${state.tasksToRun.length} 个小节。`
      : `继续整体编排决策，共 ${state.tasksToRun.length} 个小节，复用 ${state.tasksToRun.length - planningTargets.length} 个历史编排。`);
    publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });

    if (planningTargets.length) {
      const [warmupTarget, ...remainingPlanningTargets] = planningTargets;
      state.appendLog(`开始正文编排预热：${warmupTarget.item.id} ${warmupTarget.item.title || '未命名章节'}。`);
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });

      await planOne(warmupTarget);
      pauseIfRequested('正文生成已在编排预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingPlanningTargets.length) {
        continueAfterPromptCacheWarmup(`正文编排预热完成，开始并发编排剩余 ${remainingPlanningTargets.length} 个小节。`);
        state.appendLog(`开始并发编排剩余 ${remainingPlanningTargets.length} 个小节。`);
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
        await runItemsWithWorkerPool(remainingPlanningTargets, contentConcurrency, planOne, isPauseRequested);
      }
    }
    pauseIfRequested('正文生成已在编排阶段暂停，可导出当前已完成内容，稍后继续。');

    const tableCandidates = state.tasksToRun.filter(({ item }) => contentPlans.get(item.id)?.table.needed);
    const selectedTableIds = state.runLimits.maxTablesForRun === null
      ? new Set(tableCandidates.map(({ item }) => item.id))
      : pickDistributedTableTargets(tableCandidates, state.runLimits.maxTablesForRun);
    if (state.runLimits.maxTablesForRun !== null) {
      for (const { item } of tableCandidates) {
        if (!selectedTableIds.has(item.id)) {
          contentPlans.set(item.id, clearContentPlanTable(contentPlans.get(item.id)));
        }
      }
    }

    state.appendLog(`整体编排完成：表格候选 ${tableCandidates.length} 个，${state.runLimits.maxTablesForRun === null ? '保持现有编排' : `入选 ${selectedTableIds.size} 个`}。`);
    persistContentPlans(state.tasksToRun);
    contentStats.phase = 'generating';
    publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
  }

  async function prepareSingleSectionPlan() {
    const context = state.tasksToRun[0];
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
      state.appendLog(`继续当前小节任务，复用本次任务已完成的编排：${context.item.id} ${context.item.title || '未命名章节'}。`);
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      contentStats.phase = 'generating';
      return;
    }

    state.appendLog(`开始重新编排当前小节：${context.item.id} ${context.item.title || '未命名章节'}。`);
    publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
    await planOne(context, { preservedOriginalMaterial: previousOriginalMaterial });
    pauseIfRequested('正文生成已在小节编排后暂停，可导出当前已完成内容，稍后继续。');
    persistContentPlans([context]);
    state.appendLog(`当前小节编排已保存：${context.item.id} ${context.item.title || '未命名章节'}。`);

    pauseIfRequested('正文生成已在小节编排阶段暂停，可导出当前已完成内容，稍后继续。');
    contentStats.phase = 'generating';
    publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
  }

  async function runOne(context) {
    const { item } = context;
    const previousSection = state.sections[item.id] || {};
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
    state.appendLog(needsRestoredOptimization
      ? `开始基于原方案优化扩写：${item.id} ${item.title || '未命名章节'}`
      : `开始生成：${item.id} ${item.title || '未命名章节'}`);
    saveSection(item, {
      status: isSingleSectionRegeneration ? previousStatus : 'running',
      content: isSingleSectionRegeneration ? previousContent : content,
      error: undefined,
    }, isSingleSectionRegeneration ? previousContent : content, { logs: state.logs });

    try {
      if (simulatedFailureItemIds.has(item.id)) {
        throw new Error('开发者模式：随机模拟正文生成失败');
      }
      contentPlan = getContentPlanForItem(item.id);
      originalState = getOriginalMaterialRuntimeState(item);
      originalMaterial = originalState.originalMaterial;
      const knowledgeContents = resolveKnowledgeContents(contentPlan.knowledge?.item_ids, state.knowledgeContentMap);
      const selectedFactsText = resolveSelectedFactsText(contentPlan, globalFacts);
      const generationTarget = computeGenerationWordTarget(wordControl, state.leaves.length);
      const contentMessages = needsRestoredOptimization
        ? buildRestoredChapterContentMessages({ chapter: item, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, restoredContent: previousContent, wordControl, generationTarget, globalFactsMode })
        : buildChapterContentMessages({ chapter: item, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, wordControl, generationTarget, globalFactsMode });

      let generatedContent;
      if (needsRestoredOptimization && shouldUseAgentForMessages(aiService, contentMessages)) {
        const messagesLength = getMessagesContentLength(contentMessages);
        const contextLengthLimit = getTextContextLengthLimit(aiService);
        state.appendLog(`已还原正文优化扩写提示词 ${messagesLength} 字符，超过上下文阈值 ${Math.floor(contextLengthLimit * AGENT_CONTEXT_THRESHOLD_RATIO)}，切换 Agent 文件模式：${item.id} ${item.title || '未命名章节'}。`);
        writeDeveloperLog('restored_optimization.agent.start', {
          section_id: item.id,
          title: item.title || '未命名章节',
          message_chars: messagesLength,
          context_length_limit: contextLengthLimit,
          threshold_ratio: AGENT_CONTEXT_THRESHOLD_RATIO,
          restored_content_metrics: textMetrics(previousContent),
          knowledge_content_count: knowledgeContents.length,
        });
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
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
      state.appendLog(needsRestoredOptimization
        ? `原方案优化扩写完成：${item.id} ${item.title || '未命名章节'}`
        : `生成完成：${item.id} ${item.title || '未命名章节'}`);
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
        }, { logs: state.logs });
      } else {
        saveSection(item, { status: 'success', content, error: undefined }, content, { logs: state.logs });
      }
    } catch (error) {
      if (isPauseLikeError(error)) {
        saveSection(item, {
          status: previousStatus,
          content: previousContent,
          error: previousSection.error,
        }, previousContent, { logs: state.logs });
        throw error;
      }
      const message = error.message || '正文生成失败';
      const fallbackContent = isSingleSectionRegeneration
        ? previousContent
        : countContentWords(content) > 0
          ? content
          : previousContent;
      const hasReadableFallback = !isSingleSectionRegeneration && countContentWords(fallbackContent) > 0;
      state.appendLog(hasReadableFallback
        ? `生成请求未产生可用新内容：${item.id} ${item.title || '未命名章节'}，${message}。已保留当前有效正文。`
        : `生成失败：${item.id} ${item.title || '未命名章节'}，${message}${isSingleSectionRegeneration ? '。已保留原正文。' : ''}`);
      markGenerationCompleted(item.id);
      saveSection(item, {
        status: hasReadableFallback ? 'success' : 'error',
        content: fallbackContent,
        error: hasReadableFallback ? undefined : message,
      }, fallbackContent, { logs: state.logs });
    }
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
      state.appendLog(`开始${label}预热（${formatContentPromptWarmupLabel(key)}）：${context.item.id} ${context.item.title || '未命名章节'}。`);
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });

      await runOne(context);
      pauseIfRequested(`正文生成已在${label}预热后暂停，可导出当前已完成内容，稍后继续。`);
    }

    const remainingTargets = targets.filter((context) => !warmupContexts.has(context));

    if (remainingTargets.length) {
      if (warmups.length) {
        continueAfterPromptCacheWarmup(`${label}分组预热完成，开始并发生成剩余 ${remainingTargets.length} 个小节。`);
      }
      state.appendLog(warmups.length
        ? `开始并发生成剩余 ${remainingTargets.length} 个小节。`
        : `${label}无需分组预热，开始并发生成 ${remainingTargets.length} 个小节。`);
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      await runItemsWithWorkerPool(remainingTargets, contentConcurrency, runOne, isPauseRequested);
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

  return {
    planOne,
    planAll,
    prepareSingleSectionPlan,
    runOne,
    runContentTargetsWithWarmup,
  };
}

module.exports = { createSectionGenerationStage };
