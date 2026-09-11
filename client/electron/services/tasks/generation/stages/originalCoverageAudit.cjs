// 原方案覆盖子阶段：正常模式先做覆盖审计再局部补写；Agent 模式让模型直接改写 technical-plan.md。
//
// 该阶段原本是 runContentGenerationTask 内部的闭包；这里把状态与副作用显式注入，
// 自身不持有模块级状态，可单独测试。
//
// deps 约定：
//   aiService / agentService / contentStats / contentConcurrency / tableRequirement / targetItemId
//   enableOriginalPlanCoverageAudit / isExpansionWorkflow                直接读的开关或常量
//   state.leaves / state.sections / state.logs / state.originalPlanSegments / state.outlineData
//                                                                       读取会被重新赋值的闭包变量
//   state.appendLog(message)                                              追加一行任务日志
//   getOriginalMaterialRuntimeState / applyAgentConsistencySections       编排函数内的既有助手
//   runAgentTaskWithRecoveredOutput 等                                    来自 generation/agentRun.cjs
//   其余为任务运行时回调（进度、检查点、开发者日志、暂停、落盘）

const { progressFor } = require('./../progress.cjs');
const {
  isPauseLikeError,
  runItemsWithWorkerPool,
  createContentGenerationPausedError,
} = require('./../taskRuntime.cjs');
const { textMetrics, applyContentExpansionPatch } = require('./../textEdits.cjs');
const { normalizeContentExpansionPatch, normalizeNewlines } = require('./../normalize.cjs');
const { validateContentExpansionPatch } = require('./../validators.cjs');
const { parseAgentSectionMarkdown } = require('./../agentRestore.cjs');
const {
  buildAgentConsistencySectionIndex,
  buildAgentTechnicalPlanMarkdown,
  validateAgentConsistencySections,
} = require('./../agentWorkspace.cjs');
const {
  formatChapterPath,
  formatOriginalCoverageSources,
  buildOriginalCoverageAuditMessages,
} = require('./../contentMessages.cjs');
const {
  buildContentExpansionRepairMessages,
  buildOriginalCoverageAuditJsonRepairMessages,
} = require('./../promptBuilders.cjs');
const {
  ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS,
  normalizeOriginalCoverageAuditResponse,
  validateOriginalCoverageAuditResponse,
  buildOriginalCoverageRepairMessages,
} = require('./../originalCoverage.cjs');

function createOriginalCoverageAuditStage(deps) {
  const {
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
  } = deps;
  const { state } = deps;

  function buildOriginalCoverageAuditTargets(auditTargetItemId = '') {
    if (!isExpansionWorkflow || !state.originalPlanSegments.length) {
      return [];
    }
    const normalizedTargetId = String(auditTargetItemId || '').trim();
    const segmentMap = new Map(state.originalPlanSegments.map((segment) => [segment.id, segment]));
    return state.leaves
      .filter(({ item }) => !normalizedTargetId || item.id === normalizedTargetId)
      .map((context) => {
        const originalState = getOriginalMaterialRuntimeState(context.item);
        const sources = originalState.originalMaterial.source_ids.map((sourceId) => segmentMap.get(sourceId)).filter(Boolean);
        return {
          ...context,
          content: originalState.content,
          originalMaterial: originalState.originalMaterial,
          sources,
          originalState,
        };
      })
      .filter(({ item, originalState, sources }) => state.sections[item.id]?.status === 'success' && originalState.validRestored && !originalState.needsOptimization && sources.length);
  }

  function buildAgentOriginalCoverageSourcesMarkdown(targets) {
    const lines = ['# 原方案覆盖来源段', ''];
    for (const target of targets || []) {
      const id = target.item?.id || 'unknown';
      const title = target.item?.title || '未命名章节';
      lines.push(`## ${id} ${title}`);
      lines.push(`章节路径：${formatChapterPath(target)}`);
      lines.push('需要保留的来源段：');
      lines.push(formatOriginalCoverageSources(target.sources) || '未提供');
      lines.push('');
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  }

  function buildAgentOriginalCoverageRepairPrompt() {
    return `请在当前工作目录中完成原方案覆盖修复，让 technical-plan.md 成为程序可继续解析和回写的最终正文文件。

workspace 文件说明：
- original-coverage-sources.md：每个章节对应需要保留的来源段，是判断原方案核心内容是否已保留的依据。
- technical-plan.md：当前技术方案正文，包含章节标题、section id 和 yibiao-section-start / yibiao-section-end 标记。

任务目标：
检查并修复 technical-plan.md，使各章节正文尽量保留 original-coverage-sources.md 中对应来源段的实质内容。

工作方式由你自行决定。可以搜索、分段读取、建立索引、创建草稿或中间文件，并多轮编辑 technical-plan.md；不需要按固定顺序读取文件，也不需要在单次模型输出中完成全部修复。

最终 technical-plan.md 需要满足：
- 保留所有章节编号、章节标题、HTML 注释标记和 section id。
- 保留原章节结构，不新增、删除或重排章节。
- 正文修改范围限定在 yibiao-section-start 和 yibiao-section-end 标记之间。
- 补回来源段中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后、实施方法等内容；不追求逐字一致。
- 如果来源段与当前正文存在明显冲突，可以保留当前正文，后续会由全文一致性审计或人工核对处理。
- 用户可见正文中不出现“原方案”“来源段”“用户原文”或类似过程性表述。`;
  }

  function updateAgentOriginalCoverageProgress(step, label, extra = {}) {
    contentStats.phase = 'original-auditing';
    contentStats.audit_step = 'agent';
    contentStats.audit_repair_mode = 'agent';
    contentStats.audit_agent_step_total = 5;
    contentStats.audit_agent_step_completed = Math.max(0, Math.min(5, Number(step) || 0));
    contentStats.audit_agent_step_label = label || '';
    Object.assign(contentStats, extra || {});
    const runtime = syncRuntime({ phase: 'original-auditing' });
    checkpointTask({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });
    return runtime;
  }

  async function repairOriginalCoverageSection({ target, coverageItems }) {
    const { item } = target;
    let currentContent = state.sections[item.id]?.content || item.content || '';
    let failures = [];
    let appliedTotal = 0;
    writeDeveloperLog('original_coverage.repair.section.start', {
      section_id: item.id,
      title: item.title || '未命名章节',
      issue_count: (coverageItems || []).length,
      coverage_items: coverageItems,
      content_metrics: textMetrics(currentContent),
    });

    for (let attempt = 1; attempt <= ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS; attempt += 1) {
      if (isPauseRequested()) {
        writeDeveloperLog('original_coverage.repair.section.paused', {
          section_id: item.id,
          title: item.title || '未命名章节',
          applied_count: appliedTotal,
        });
        return { appliedCount: appliedTotal, failed: false, paused: true };
      }

      try {
        writeDeveloperLog('original_coverage.repair.attempt.start', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          max_attempts: ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS,
          previous_failures: failures,
          content_metrics: textMetrics(currentContent),
        });
        const patch = await aiService.collectJsonResponse({
          messages: buildOriginalCoverageRepairMessages({
            target,
            coverageItems,
            currentContent,
            attempt,
            failures,
            tableRequirement,
          }),
          logTitle: `原方案覆盖修复-${item.id}-${item.title || '未命名章节'}`,
          progressLabel: '原方案覆盖修复',
          failureMessage: '模型返回的原方案覆盖修复结果格式无效',
          normalizer: normalizeContentExpansionPatch,
          validator: validateContentExpansionPatch,
          repairMessagesBuilder: (contextForRepair) => buildContentExpansionRepairMessages(contextForRepair, currentContent),
          max_retries: 1,
        });
        writeDeveloperLog('original_coverage.repair.response', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          patch,
        });

        const nextContent = applyContentExpansionPatch(currentContent, patch);
        if (normalizeNewlines(nextContent).trim() === normalizeNewlines(currentContent).trim()) {
          failures = ['补写 patch 应用后正文没有变化'];
          writeDeveloperLog('original_coverage.repair.no_change', {
            section_id: item.id,
            title: item.title || '未命名章节',
            attempt,
            patch,
          });
        } else {
          currentContent = nextContent;
          appliedTotal += 1;
          rememberTouchedItem(item.id);
          saveSection(item, { status: 'success', content: currentContent, error: undefined }, currentContent, { logs: state.logs });
          writeDeveloperLog('original_coverage.repair.section.saved', {
            section_id: item.id,
            title: item.title || '未命名章节',
            attempt,
            applied_total: appliedTotal,
            content_metrics: textMetrics(currentContent),
          });
          return { appliedCount: appliedTotal, failed: false, paused: false };
        }
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        failures = [error.message || '模型返回无效'];
        writeDeveloperLog('original_coverage.repair.attempt.error', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
      }

      state.appendLog(`原方案覆盖修复第 ${attempt}/${ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS} 次未完成：${item.id} ${item.title || '未命名章节'}，${failures.join('；')}。`);
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
    }

    writeDeveloperLog('original_coverage.repair.section.done', {
      section_id: item.id,
      title: item.title || '未命名章节',
      applied_count: appliedTotal,
      failed: true,
      errors: failures,
    });
    return { appliedCount: appliedTotal, failed: true, paused: false, errors: failures };
  }

  async function runAgentOriginalCoverageRepairIfEnabled() {
    if (!isExpansionWorkflow) {
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }
    if (!enableOriginalPlanCoverageAudit) {
      writeDeveloperLog('original_coverage.agent.skipped', { reason: 'disabled' });
      state.appendLog('原方案覆盖审计未启用，跳过 Agent 覆盖修复阶段。');
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const coverageTargets = buildOriginalCoverageAuditTargets('');
    const sectionIndex = buildAgentConsistencySectionIndex(coverageTargets);
    if (!sectionIndex.size) {
      writeDeveloperLog('original_coverage.agent.skipped', { reason: 'no_targets' });
      state.appendLog('原方案覆盖 Agent 修复跳过：没有可检查的已还原成功正文小节。');
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    contentStats.audit_group_total = 0;
    contentStats.audit_group_completed = 0;
    contentStats.audit_conflict_total = 0;
    contentStats.audit_fix_total = 0;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    contentStats.audit_agent_changed_sections = 0;
    contentStats.audit_agent_failed_sections = 0;
    state.appendLog(`开始 Agent 原方案覆盖修复：共 ${sectionIndex.size} 个已还原小节。`);
    writeDeveloperLog('original_coverage.agent.start', {
      section_count: sectionIndex.size,
      sections: coverageTargets.map((target) => ({
        id: target.item.id,
        title: target.item.title || '未命名章节',
        source_ids: target.sources.map((segment) => segment.id),
        content_metrics: textMetrics(target.content),
      })),
    });

    updateAgentOriginalCoverageProgress(1, '准备原方案覆盖 Agent 输入文件');
    const files = [
      { path: 'original-coverage-sources.md', content: buildAgentOriginalCoverageSourcesMarkdown(coverageTargets) },
      { path: 'technical-plan.md', content: buildAgentTechnicalPlanMarkdown(state.outlineData, sectionIndex) },
    ];
    pauseIfRequested('正文生成已在原方案覆盖 Agent 修复开始前暂停，本次 Agent 未启动；继续后将重新执行。');

    if (!agentService?.runTask) {
      const failedCount = sectionIndex.size;
      contentStats.audit_agent_failed_sections = failedCount;
      state.appendLog(`原方案覆盖 Agent 修复无法启动：Agent 服务尚未初始化，${failedCount} 个小节需人工核对。`);
      writeDeveloperLog('original_coverage.agent.unavailable', { failed_count: failedCount });
      updateAgentOriginalCoverageProgress(5, '原方案覆盖 Agent 不可用', { audit_agent_failed_sections: failedCount });
      return { ran: true, fixedCount: 0, failedCount };
    }

    updateAgentOriginalCoverageProgress(2, 'Agent 正在检查并补回原方案内容');
    const agentAbortController = new AbortController();
    let pauseWatcher = null;
    let pauseLogged = false;
    function abortAgentIfPauseRequested() {
      if (!isPauseRequested()) {
        return;
      }
      if (!pauseLogged) {
        pauseLogged = true;
        state.appendLog('已请求暂停原方案覆盖 Agent 修复，正在取消本轮 Agent 任务。');
        updateAgentOriginalCoverageProgress(0, '正在取消本轮原方案覆盖 Agent 修复，继续后将重新执行');
      }
      if (!agentAbortController.signal.aborted) {
        agentAbortController.abort(createContentGenerationPausedError());
      }
    }
    pauseWatcher = setInterval(abortAgentIfPauseRequested, 1000);

    try {
      abortAgentIfPauseRequested();
      pauseIfRequested('正文生成已在原方案覆盖 Agent 修复开始前暂停，本次 Agent 未启动；继续后将重新执行。');
      const agentResult = await runAgentTaskWithRecoveredOutput({
        title: '原方案覆盖 Agent 修复',
        prompt: buildAgentOriginalCoverageRepairPrompt(),
        output_file: 'technical-plan.md',
        files,
        timeout_ms: 30 * 60 * 1000,
        max_retries: 1,
        signal: agentAbortController.signal,
        validateOutput: (resultForValidation) => {
          const repairedMarkdownForValidation = String(resultForValidation?.output_content || '').trim();
          if (!repairedMarkdownForValidation) {
            throw new Error('Agent 未返回修复后的 technical-plan.md');
          }
          const parsedSectionsForValidation = parseAgentSectionMarkdown(repairedMarkdownForValidation);
          validateAgentConsistencySections(parsedSectionsForValidation, sectionIndex);
          return { section_count: parsedSectionsForValidation.size };
        },
        onActivity: createAgentActivityProgressHandler(updateAgentOriginalCoverageProgress, 2, 'Agent 正在检查并补回原方案内容'),
      }, 'original_coverage.agent');
      if (isAgentBusyResult(agentResult)) {
        state.appendLog('Agent 正在处理其他任务，本轮跳过原方案覆盖 Agent 修复。');
        writeDeveloperLog('original_coverage.agent.busy', { active_task: agentResult?.active_task || null });
        updateAgentOriginalCoverageProgress(0, 'Agent 正忙，已跳过原方案覆盖 Agent 修复', {
          audit_agent_changed_sections: 0,
          audit_agent_failed_sections: 0,
        });
        return { ran: false, fixedCount: 0, failedCount: 0, skipped: true, reason: 'busy' };
      }
      pauseIfRequested('正文生成已在原方案覆盖 Agent 修复结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行。');

      updateAgentOriginalCoverageProgress(3, '读取 Agent 修复后的正文');
      const repairedMarkdown = String(agentResult?.output_content || '').trim();
      if (!repairedMarkdown) {
        writeDeveloperLog('original_coverage.agent.empty_output', { agent_result: agentResult });
        throw new Error('Agent 未返回修复后的 technical-plan.md');
      }

      updateAgentOriginalCoverageProgress(4, '解析并校验 Agent 修复结果');
      const parsedSections = parseAgentSectionMarkdown(repairedMarkdown);
      validateAgentConsistencySections(parsedSections, sectionIndex);
      pauseIfRequested('正文生成已在原方案覆盖 Agent 修复结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行。');

      updateAgentOriginalCoverageProgress(5, '回写 Agent 修改的小节');
      const applyResult = applyAgentConsistencySections(parsedSections, sectionIndex, new Set(sectionIndex.keys()));
      contentStats.audit_agent_changed_sections = applyResult.changedCount;
      state.appendLog(applyResult.changedCount
        ? `原方案覆盖 Agent 修复完成：已回写 ${applyResult.changedCount} 个小节（${applyResult.changedIds.join('、')}）。`
        : '原方案覆盖 Agent 修复完成：未发现需要回写的小节。');
      writeDeveloperLog('original_coverage.agent.done', {
        changed_count: applyResult.changedCount,
        skipped_count: applyResult.skippedCount,
        changed_ids: applyResult.changedIds,
        agent_task_id: agentResult?.task_id || '',
        agent_session_id: agentResult?.session_id || '',
      });
      updateAgentOriginalCoverageProgress(5, '原方案覆盖 Agent 修复完成', { audit_agent_changed_sections: applyResult.changedCount });
      return { ran: true, fixedCount: applyResult.changedCount, failedCount: 0 };
    } catch (error) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        contentStats.audit_agent_changed_sections = 0;
        contentStats.audit_agent_failed_sections = 0;
        state.appendLog('原方案覆盖 Agent 修复已暂停：本轮 Agent 已取消并清理，继续后将重新执行。');
        writeDeveloperLog('original_coverage.agent.paused', {
          section_count: sectionIndex.size,
          error: error.message || String(error),
        });
        updateAgentOriginalCoverageProgress(0, '原方案覆盖 Agent 修复已暂停，继续后将重新执行', {
          audit_agent_changed_sections: 0,
          audit_agent_failed_sections: 0,
        });
        pauseIfRequested('正文生成已在原方案覆盖 Agent 修复阶段暂停，本次 Agent 已取消；继续后将重新执行。');
      }

      const failedCount = sectionIndex.size;
      contentStats.audit_agent_failed_sections = failedCount;
      state.appendLog(`原方案覆盖 Agent 修复失败：${error.message || '未知错误'}。已保留原正文，${failedCount} 个小节需人工核对，任务将继续进入后续流程。`);
      writeDeveloperLog('original_coverage.agent.failed', {
        failed_count: failedCount,
        ...agentErrorDiagnostics(error),
      });
      updateAgentOriginalCoverageProgress(contentStats.audit_agent_step_completed || 2, '原方案覆盖 Agent 修复失败', {
        audit_agent_failed_sections: failedCount,
      });
      return { ran: true, fixedCount: 0, failedCount };
    } finally {
      if (pauseWatcher) clearInterval(pauseWatcher);
    }
  }

  async function runOriginalPlanCoverageAuditIfEnabled(options = {}) {
    if (!isExpansionWorkflow) {
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }
    if (!enableOriginalPlanCoverageAudit) {
      writeDeveloperLog('original_coverage.audit.skipped', { reason: 'disabled' });
      state.appendLog('原方案覆盖审计未启用，跳过审计阶段。');
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const auditTargets = buildOriginalCoverageAuditTargets(options.targetItemId || targetItemId);
    if (!auditTargets.length) {
      writeDeveloperLog('original_coverage.audit.skipped', { reason: 'no_targets', target_item_id: options.targetItemId || targetItemId || '' });
      state.appendLog('原方案覆盖审计跳过：没有可审计的已还原成功正文小节。');
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const coverageIssuesBySectionId = new Map();
    let issueCount = 0;
    let conflictCount = 0;
    contentStats.phase = 'original-auditing';
    contentStats.audit_step = 'checking';
    contentStats.audit_repair_mode = 'normal';
    contentStats.audit_group_total = auditTargets.length;
    contentStats.audit_group_completed = 0;
    contentStats.audit_conflict_total = 0;
    contentStats.audit_fix_total = 0;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    contentStats.audit_agent_step_total = 0;
    contentStats.audit_agent_step_completed = 0;
    contentStats.audit_agent_step_label = '';
    contentStats.audit_agent_changed_sections = 0;
    contentStats.audit_agent_failed_sections = 0;
    state.appendLog(`开始原方案覆盖审计：${auditTargets.length} 个已还原小节，并发 ${contentConcurrency}。`);
    const originalAuditRuntime = syncRuntime({ phase: 'original-auditing' });
    writeDeveloperLog('original_coverage.audit.start', {
      target_item_id: options.targetItemId || targetItemId || '',
      target_count: auditTargets.length,
      concurrency: contentConcurrency,
      targets: auditTargets.map((target) => ({
        section_id: target.item.id,
        title: target.item.title || '未命名章节',
        source_ids: target.sources.map((segment) => segment.id),
        content_metrics: textMetrics(target.content),
      })),
    });
    checkpointTask({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: originalAuditRuntime,
    }, { contentRuntime: originalAuditRuntime });

    async function auditOriginalCoverageTarget(target) {
      const allowedSourceIds = new Set(target.sources.map((segment) => segment.id).filter(Boolean));
      try {
        writeDeveloperLog('original_coverage.audit.section.start', {
          section_id: target.item.id,
          title: target.item.title || '未命名章节',
          source_ids: [...allowedSourceIds],
        });
        const response = await aiService.collectJsonResponse({
          messages: buildOriginalCoverageAuditMessages({ target }),
          logTitle: `原方案覆盖审计-${target.item.id}-${target.item.title || '未命名章节'}`,
          progressLabel: '原方案覆盖审计',
          failureMessage: '模型返回的原方案覆盖审计结果格式无效',
          normalizer: (value) => normalizeOriginalCoverageAuditResponse(value, { allowedSourceIds, expectedNodeId: target.item.id }),
          validator: (value) => validateOriginalCoverageAuditResponse(value, allowedSourceIds),
          repairMessagesBuilder: (contextForRepair) => buildOriginalCoverageAuditJsonRepairMessages(contextForRepair, target),
          max_retries: 1,
        });
        const coverageItems = response.items || [];
        const repairItems = coverageItems.filter((item) => ['partial', 'missing'].includes(item.status));
        const conflictItems = coverageItems.filter((item) => item.status === 'conflict');
        if (repairItems.length) {
          coverageIssuesBySectionId.set(target.item.id, { target, coverageItems: repairItems });
        }
        issueCount += repairItems.length + conflictItems.length;
        conflictCount += conflictItems.length;
        contentStats.audit_conflict_total = issueCount;
        state.appendLog(`原方案覆盖审计完成：${target.item.id} ${target.item.title || '未命名章节'}，需补写 ${repairItems.length} 段，冲突 ${conflictItems.length} 段。`);
        writeDeveloperLog('original_coverage.audit.section.success', {
          section_id: target.item.id,
          title: target.item.title || '未命名章节',
          items: coverageItems,
          repair_count: repairItems.length,
          conflict_count: conflictItems.length,
        });
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        state.appendLog(`原方案覆盖审计失败：${target.item.id} ${target.item.title || '未命名章节'}，${error.message || '模型返回无效'}，已跳过该小节。`);
        writeDeveloperLog('original_coverage.audit.section.error', {
          section_id: target.item.id,
          title: target.item.title || '未命名章节',
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
      } finally {
        contentStats.audit_group_completed += 1;
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      }
    }

    if (auditTargets.length > 1) {
      const [warmupTarget, ...remainingTargets] = auditTargets;
      state.appendLog(`开始原方案覆盖审计预热：${warmupTarget.item.id} ${warmupTarget.item.title || '未命名章节'}。`);
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });

      await auditOriginalCoverageTarget(warmupTarget);
      pauseIfRequested('正文生成已在原方案覆盖审计预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingTargets.length) {
        continueAfterPromptCacheWarmup(`原方案覆盖审计预热完成，开始并发审计剩余 ${remainingTargets.length} 个小节。`);
        state.appendLog(`开始并发审计剩余 ${remainingTargets.length} 个小节。`);
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
        await runItemsWithWorkerPool(remainingTargets, contentConcurrency, auditOriginalCoverageTarget, isPauseRequested);
      }
    } else {
      await runItemsWithWorkerPool(auditTargets, contentConcurrency, auditOriginalCoverageTarget, isPauseRequested);
    }

    pauseIfRequested('正文生成已在原方案覆盖审计阶段暂停，可导出当前已完成内容，稍后继续。');

    const repairTargets = Array.from(coverageIssuesBySectionId.values());
    contentStats.audit_step = 'fixing';
    contentStats.audit_fix_total = repairTargets.length;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    state.appendLog(repairTargets.length
      ? `原方案覆盖审计发现 ${repairTargets.length} 个小节需要补写，开始局部修复。${conflictCount ? `另有 ${conflictCount} 个来源段存在冲突，保留给一致性审计或人工核对。` : ''}`
      : `原方案覆盖审计未发现需要自动补写的来源段。${conflictCount ? `发现 ${conflictCount} 个冲突来源段，保留给一致性审计或人工核对。` : ''}`);
    writeDeveloperLog('original_coverage.repair.start', {
      target_count: repairTargets.length,
      conflict_count: conflictCount,
      issue_count: issueCount,
      concurrency: contentConcurrency,
      targets: repairTargets.map(({ target, coverageItems }) => ({
        section_id: target.item.id,
        title: target.item.title || '未命名章节',
        coverage_items: coverageItems,
      })),
    });
    publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });

    if (!repairTargets.length) {
      writeDeveloperLog('original_coverage.audit.done', { fixed_count: 0, failed_count: 0, repair_target_count: 0, conflict_count: conflictCount });
      return { ran: true, fixedCount: 0, failedCount: 0 };
    }

    let fixedCount = 0;
    async function repairOriginalCoverageTarget(target) {
      const item = target.target.item;
      try {
        const result = await repairOriginalCoverageSection(target);
        if (result.appliedCount > 0) {
          fixedCount += 1;
          state.appendLog(`原方案覆盖修复完成：${item.id} ${item.title || '未命名章节'}，应用 ${result.appliedCount} 个局部补写。`);
        }
        if (result.failed) {
          contentStats.audit_fix_failed += 1;
          state.appendLog(`原方案覆盖修复需人工核对：${item.id} ${item.title || '未命名章节'}，${(result.errors || []).join('；') || '未能应用补写 patch'}。`);
        }
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        contentStats.audit_fix_failed += 1;
        state.appendLog(`原方案覆盖修复失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}。`);
      } finally {
        contentStats.audit_fix_completed += 1;
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      }
    }

    if (repairTargets.length > 1) {
      const [warmupTarget, ...remainingTargets] = repairTargets;
      state.appendLog(`开始原方案覆盖修复预热：${warmupTarget.target.item.id} ${warmupTarget.target.item.title || '未命名章节'}。`);
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });

      await repairOriginalCoverageTarget(warmupTarget);
      pauseIfRequested('正文生成已在原方案覆盖修复预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingTargets.length) {
        continueAfterPromptCacheWarmup(`原方案覆盖修复预热完成，开始并发修复剩余 ${remainingTargets.length} 个小节。`);
        state.appendLog(`开始并发修复剩余 ${remainingTargets.length} 个小节。`);
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
        await runItemsWithWorkerPool(remainingTargets, contentConcurrency, repairOriginalCoverageTarget, isPauseRequested);
      }
    } else {
      await runItemsWithWorkerPool(repairTargets, contentConcurrency, repairOriginalCoverageTarget, isPauseRequested);
    }

    pauseIfRequested('正文生成已在原方案覆盖修复阶段暂停，可导出当前已完成内容，稍后继续。');

    state.appendLog(`原方案覆盖审计完成：发现 ${repairTargets.length} 个需补写小节，成功修复 ${fixedCount} 个，${contentStats.audit_fix_failed} 个需人工核对。`);
    contentStats.audit_step = 'done';
    writeDeveloperLog('original_coverage.audit.done', {
      repair_target_count: repairTargets.length,
      fixed_count: fixedCount,
      failed_count: contentStats.audit_fix_failed,
      conflict_count: conflictCount,
      issue_count: issueCount,
    });
    publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
    return { ran: true, fixedCount, failedCount: contentStats.audit_fix_failed };
  }

  return {
    buildOriginalCoverageAuditTargets,
    runOriginalPlanCoverageAuditIfEnabled,
    runAgentOriginalCoverageRepairIfEnabled,
  };
}

module.exports = { createOriginalCoverageAuditStage };
