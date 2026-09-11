// 配图子阶段：先规划图片清单，再按类型并发或串行生成，最后写回正文与方案状态。
//
// 该阶段原本是 runContentGenerationTask 内部的闭包；这里把状态与副作用显式注入，
// 自身不持有模块级状态，可单独测试。
//
// deps 约定：
//   aiService / workspaceStore / generationOptions                         直接读的服务与参数
//   contentStats / contentConcurrency / imageConcurrency                    进度与并发上限
//   state.leaves / state.sections / state.logs / state.outlineData          读取会被重新赋值的闭包变量
//   state.appendLog(message)                                                追加一行任务日志
//   rebuildContentWordCounts / runContentAgentTask                          编排函数内的既有助手
//   其余为任务运行时回调（进度、检查点、开发者日志、暂停）

const {
  ILLUSTRATION_PLAN_VERSION,
  buildIllustrationPlanningContext,
  buildIllustrationPlanningPrompt,
  resolveIllustrationPlan,
} = require('./../../../contentIllustrationPlanning.cjs');
const {
  HTML_AGENT_THRESHOLD_CHARS,
  applyGeneratedIllustrationsToDocument,
  buildIllustrationExecutionContexts,
  generateAiIllustration,
  generateHtmlIllustration,
  generateMermaidIllustration,
  stripGeneratedIllustrationsFromDocument,
} = require('./../../../contentIllustrationGeneration.cjs');
const { progressFor } = require('./../progress.cjs');
const { isPauseLikeError, runItemsWithWorkerPool, createContentGenerationPausedError } = require('./../taskRuntime.cjs');
const { now } = require('./../normalize.cjs');
const { compactError } = require('./../agentResponse.cjs');

function createIllustrationStage(deps) {
  const {
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
  } = deps;
  const { state } = deps;

  async function runIllustrationPlanning() {
    contentStats.phase = 'illustration-planning';
    contentStats.illustration_planning_step_total = 3;
    contentStats.illustration_planning_step_completed = 0;
    contentStats.illustration_planning_step_label = '正在准备全文和目录输入';
    const strippedDocument = stripGeneratedIllustrationsFromDocument(state.outlineData, state.sections);
    state.outlineData = strippedDocument.outlineData;
    state.sections = strippedDocument.sections;
    rebuildContentWordCounts();
    workspaceStore.clearIllustrationFiles?.();
    const phaseRuntime = syncRuntime({ phase: 'illustration-planning' });
    state.appendLog('正文后处理完成，开始使用 Agent 编排全文图片计划。');
    checkpointTask({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() }, {
      outlineData: state.outlineData,
      contentGenerationSections: state.sections,
      contentGenerationRuntime: phaseRuntime,
    }, {
      outlineData: state.outlineData,
      contentRuntime: phaseRuntime,
    });
    workspaceStore.clearUnreferencedGeneratedImages?.();

    const imageAvailability = aiService.getImageModelAvailability
      ? aiService.getImageModelAvailability()
      : { available: false };
    const planningContext = buildIllustrationPlanningContext({
      outlineData: state.outlineData,
      sections: state.sections,
      options: generationOptions,
      aiImagesAvailable: imageAvailability.available,
    });
    contentStats.illustration_planning_step_completed = 1;
    contentStats.illustration_planning_step_label = '正在执行全文图片编排 Agent';
    pauseIfRequested('正文生成已在图片编排输入准备后暂停，本次 Agent 未启动；继续后将重新执行。');

    const enabledKinds = ['html', 'ai', 'mermaid'].filter((kind) => planningContext.config[kind].enabled);
    let resolved;
    if (!planningContext.eligibleSectionIds.length || !enabledKinds.length) {
      resolved = resolveIllustrationPlan({ items: [] }, planningContext);
      state.appendLog(planningContext.eligibleSectionIds.length
        ? '所有图片类型均未启用，已生成空的全文图片计划。'
        : '没有可编排的成功正文小节，已生成空的全文图片计划。');
    } else {
      let validatedPlan = null;
      const { agentResult, outputContent } = await runContentAgentTask({
        title: '技术方案全文图片编排 Agent',
        prompt: buildIllustrationPlanningPrompt(),
        outputFile: 'illustration-plan.json',
        files: planningContext.files,
        eventPrefix: 'illustration_planning.agent',
        activityLabel: 'Agent 正在阅读全文并编排图片',
        startPauseMessage: '正文生成已在全文图片编排 Agent 开始前暂停，本次 Agent 未启动；继续后将重新执行。',
        resultPauseMessage: '正文生成已在全文图片编排结果保存前暂停，本次 Agent 输出未保存；继续后将重新执行。',
        pausedLogMessage: '全文图片编排 Agent 已暂停：本轮 Agent 已取消并清理，继续后将重新执行。',
        validateOutput: (resultForValidation) => {
          validatedPlan = resolveIllustrationPlan(resultForValidation?.output_content || '', planningContext);
          return validatedPlan;
        },
      });
      resolved = validatedPlan || resolveIllustrationPlan(outputContent, planningContext);
      writeDeveloperLog('illustration_planning.agent.done', {
        agent_task_id: agentResult?.task_id || '',
        agent_session_id: agentResult?.session_id || '',
        candidate_stats: resolved.stats.candidate,
        selected_stats: resolved.stats.selected,
        selected_items: resolved.plan.items.map((item) => ({
          item_id: item.item_id,
          kind: item.kind,
          image_type: item.image_type,
          title: item.title,
          section_ids: item.section_ids,
        })),
      });
    }

    pauseIfRequested('正文生成已在全文图片编排结果保存前暂停，本次计划未保存；继续后将重新执行。');
    contentStats.illustration_planning_step_completed = 2;
    contentStats.illustration_planning_step_label = '正在保存全文图片计划';
    contentStats.illustration_candidate_ai = resolved.stats.candidate.ai;
    contentStats.illustration_candidate_mermaid = resolved.stats.candidate.mermaid;
    contentStats.illustration_candidate_html = resolved.stats.candidate.html;
    contentStats.illustration_selected_ai = resolved.stats.selected.ai;
    contentStats.illustration_selected_mermaid = resolved.stats.selected.mermaid;
    contentStats.illustration_selected_html = resolved.stats.selected.html;
    const planRuntime = syncRuntime({ phase: 'illustration-planning' });
    contentStats.illustration_planning_step_completed = 3;
    contentStats.illustration_planning_step_label = '全文图片编排完成';
    state.appendLog(`全文图片编排完成：候选 ${resolved.stats.candidate.html + resolved.stats.candidate.mermaid + resolved.stats.candidate.ai} 项，最终保留 HTML ${resolved.stats.selected.html} 项、Mermaid ${resolved.stats.selected.mermaid} 项、AI ${resolved.stats.selected.ai} 项。`);
    checkpointTask({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() }, {
      contentIllustrationPlan: resolved.plan,
      contentGenerationRuntime: planRuntime,
    }, {
      contentRuntime: planRuntime,
      technicalPlanPatch: { contentIllustrationPlan: resolved.plan, contentGenerationRuntime: planRuntime },
    });
    return resolved.plan;
  }

  async function runIllustrationGeneration(initialPlan) {
    let illustrationPlan = initialPlan;
    if (Number(illustrationPlan?.plan_version) !== ILLUSTRATION_PLAN_VERSION) {
      throw new Error('图片计划版本无效');
    }
    if (!illustrationPlan?.items?.length) {
      state.appendLog('全文图片计划为空，跳过图片生成。');
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      return illustrationPlan;
    }

    illustrationPlan = {
      ...illustrationPlan,
      items: illustrationPlan.items.map((item) => item.generation?.status === 'running'
        ? { ...item, generation: { ...item.generation, status: 'pending', error: undefined, updated_at: now() } }
        : item),
    };
    const executions = buildIllustrationExecutionContexts(illustrationPlan, state.leaves, state.sections);
    const aiExecutions = executions.filter(({ planItem }) => planItem.kind === 'ai');
    const normalTextExecutions = executions.filter(({ planItem, reference }) => planItem.kind === 'mermaid'
      || (planItem.kind === 'html' && reference.length <= HTML_AGENT_THRESHOLD_CHARS));
    const agentHtmlExecutions = executions.filter(({ planItem, reference }) => planItem.kind === 'html' && reference.length > HTML_AGENT_THRESHOLD_CHARS);

    function countCompleted(kind) {
      return illustrationPlan.items.filter((item) => item.kind === kind && ['success', 'error'].includes(item.generation?.status)).length;
    }

    function refreshIllustrationGenerationStats(label) {
      contentStats.illustration_generation_total = illustrationPlan.items.length;
      contentStats.illustration_generation_completed = illustrationPlan.items.filter((item) => ['success', 'error'].includes(item.generation?.status)).length;
      contentStats.illustration_generation_ai_total = aiExecutions.length;
      contentStats.illustration_generation_ai_completed = countCompleted('ai');
      contentStats.illustration_generation_mermaid_total = executions.filter(({ planItem }) => planItem.kind === 'mermaid').length;
      contentStats.illustration_generation_mermaid_completed = countCompleted('mermaid');
      contentStats.illustration_generation_html_total = executions.filter(({ planItem }) => planItem.kind === 'html').length;
      contentStats.illustration_generation_html_completed = countCompleted('html');
      contentStats.illustration_generation_step_label = label || contentStats.illustration_generation_step_label;
    }

    function persistIllustrationGeneration(itemId, generation, label) {
      illustrationPlan = {
        ...illustrationPlan,
        items: illustrationPlan.items.map((item) => item.item_id === itemId
          ? { ...item, generation: { ...(item.generation || {}), ...generation, updated_at: now() } }
          : item),
        updated_at: now(),
      };
      refreshIllustrationGenerationStats(label);
      const runtime = syncRuntime({ phase: 'illustration-generating' });
      const changedItem = illustrationPlan.items.find((item) => item.item_id === itemId);
      const taskPatch = { status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() };
      const eventPatch = {
        contentRuntime: runtime,
        technicalPlanPatch: { contentIllustrationPlan: illustrationPlan, contentGenerationRuntime: runtime },
      };
      if (changedItem && ['success', 'error'].includes(changedItem.generation?.status)) {
        checkpointTask(taskPatch, {
          contentIllustrationItem: changedItem,
          contentGenerationRuntime: runtime,
        }, eventPatch);
        return;
      }
      publishTaskUpdate(taskPatch, eventPatch);
    }

    async function runExecution(execution) {
      const { planItem } = execution;
      if (['success', 'error'].includes(planItem.generation?.status)) return;
      persistIllustrationGeneration(planItem.item_id, { status: 'running', error: undefined }, `正在生成${planItem.kind === 'ai' ? ' AI' : planItem.kind === 'mermaid' ? ' Mermaid' : ' HTML'} 图片`);
      try {
        let result;
        if (planItem.kind === 'ai') {
          result = await generateAiIllustration(aiService, execution);
          state.appendLog(`AI 配图完成：${planItem.section_ids[0]} ${planItem.title}`);
        } else if (planItem.kind === 'mermaid') {
          result = await generateMermaidIllustration(aiService, execution, isPauseLikeError);
          state.appendLog(result.attempts
            ? `Mermaid 配图已修复并完成：${planItem.section_ids[0]} ${planItem.title}（修复 ${result.attempts} 轮）`
            : `Mermaid 配图完成：${planItem.section_ids[0]} ${planItem.title}`);
        } else {
          result = await generateHtmlIllustration({
            aiService,
            execution,
            plan: illustrationPlan,
            workspaceStore,
            onSourceSaved: (source) => persistIllustrationGeneration(
              planItem.item_id,
              { status: 'running', error: undefined, ...source },
              'HTML 源文件已保存，正在转换图片',
            ),
            runAgentHtml: async ({ title, prompt, outputFile, files, validateOutput }) => {
              const response = await runContentAgentTask({
                title,
                prompt,
                outputFile,
                files,
                eventPrefix: 'html_illustration.agent',
                activityLabel: 'Agent 正在生成 HTML 图片',
                startPauseMessage: '正文生成已在 HTML 图片 Agent 开始前暂停，本次 Agent 未启动；继续后将重新执行。',
                resultPauseMessage: '正文生成已在 HTML 图片 Agent 结果保存前暂停，本次输出未保存；继续后将重新执行。',
                pausedLogMessage: 'HTML 图片 Agent 已暂停：本轮 Agent 已取消并清理，继续后将重新执行。',
                validateOutput,
              });
              return response.outputContent;
            },
            onRenderRetry: (attempt, error) => writeDeveloperLog('illustration.html.render.retry', {
              item_id: planItem.item_id,
              attempt,
              error: compactError(error?.message || error),
            }),
            isPauseRequested,
            createPauseError: createContentGenerationPausedError,
          });
        }
        persistIllustrationGeneration(planItem.item_id, { status: 'success', error: undefined, ...result }, '正在汇总已生成图片');
      } catch (error) {
        if (isPauseLikeError(error) || isPauseRequested()) throw error;
        const partial = error?.illustrationGeneration || {};
        persistIllustrationGeneration(planItem.item_id, {
          status: 'error',
          ...partial,
          error: compactError(error?.message || error),
        }, '正在继续生成其他图片');
        writeDeveloperLog(`illustration.${planItem.kind}.failed`, {
          item_id: planItem.item_id,
          section_ids: planItem.section_ids,
          image_type: planItem.image_type,
          title: planItem.title,
          error: compactError(error?.message || error),
        });
        const kindLabel = planItem.kind === 'ai' ? 'AI' : planItem.kind === 'mermaid' ? 'Mermaid' : 'HTML';
        state.appendLog(`${kindLabel} 配图失败：${planItem.section_ids[0]}，${error.message || '生成失败'}，已保留正文。`);
      }
    }

    contentStats.phase = 'illustration-generating';
    refreshIllustrationGenerationStats('正在启动文本组和生图组');
    state.appendLog(`开始生成图片：文本组 ${normalTextExecutions.length} 项（并发 ${contentConcurrency}），超长 HTML Agent ${agentHtmlExecutions.length} 项（串行），AI 生图组 ${aiExecutions.length} 项（并发 ${imageConcurrency}）。`);
    const runtime = syncRuntime({ phase: 'illustration-generating' });
    checkpointTask({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, {
      contentRuntime: runtime,
      technicalPlanPatch: { contentIllustrationPlan: illustrationPlan, contentGenerationRuntime: runtime },
    });

    async function runTextGroup() {
      await runItemsWithWorkerPool(normalTextExecutions, contentConcurrency, runExecution, isPauseRequested);
      pauseIfRequested('正文生成已在普通文本图片完成后暂停，超长 HTML Agent 尚未继续执行。');
      for (const execution of agentHtmlExecutions) {
        pauseIfRequested('正文生成已在超长 HTML 图片 Agent 开始前暂停，继续后将重新执行。');
        await runExecution(execution);
      }
    }

    const settled = await Promise.allSettled([
      runTextGroup(),
      runItemsWithWorkerPool(aiExecutions, imageConcurrency, runExecution, isPauseRequested),
    ]);
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected?.reason) throw rejected.reason;
    pauseIfRequested('正文生成已在图片生成阶段暂停，可导出当前已完成正文，稍后继续。');

    const applied = applyGeneratedIllustrationsToDocument(illustrationPlan, state.outlineData, state.sections);
    state.outlineData = applied.outlineData;
    state.sections = applied.sections;
    rebuildContentWordCounts();
    refreshIllustrationGenerationStats('图片生成和正文插入完成');
    const completedRuntime = syncRuntime({ phase: 'illustration-generating' });
    state.appendLog('图片生成阶段完成。');
    checkpointTask({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() }, {
      outlineData: state.outlineData,
      contentGenerationSections: state.sections,
      contentGenerationRuntime: completedRuntime,
    }, {
      outlineData: state.outlineData,
      contentRuntime: completedRuntime,
      technicalPlanPatch: {
        contentGenerationSections: state.sections,
        contentIllustrationPlan: illustrationPlan,
        contentGenerationRuntime: completedRuntime,
      },
    });
    return illustrationPlan;
  }

  return { runIllustrationPlanning, runIllustrationGeneration };
}

module.exports = { createIllustrationStage };
