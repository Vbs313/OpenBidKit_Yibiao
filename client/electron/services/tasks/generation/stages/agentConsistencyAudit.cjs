// Agent 模式的全文一致性审计阶段：把全部成功正文交给 Agent 审计并回写改动小节。
//
// 该阶段原本是 runContentGenerationTask 内部的闭包；这里把状态与副作用显式注入，
// 自身不持有模块级状态，可单独测试。
//
// deps 约定：
//   agentService / contentStats                                             直接读的对象
//   enableConsistencyAudit / globalFactsText / bidAnalysisFactsText / globalFactsMode / targetItemId
//                                                                         开关与模型参数
//   buildConsistencyAuditTargets                                            来自 consistencyAudit 阶段
//   applyAgentConsistencySections                                           来自 agentWorkspace 的小节写回器
//   runAgentTaskWithRecoveredOutput 等                                      来自 generation/agentRun.cjs
//   state.leaves / state.sections / state.logs / state.outlineData          读取会被重新赋值的闭包变量
//   state.appendLog(message)                                                追加一行任务日志
//   其余为任务运行时回调（进度、检查点、开发者日志、暂停）

const { progressFor } = require('./../progress.cjs');
const { isPauseLikeError, createContentGenerationPausedError } = require('./../taskRuntime.cjs');
const { textMetrics } = require('./../textEdits.cjs');
const { parseAgentSectionMarkdown } = require('./../agentRestore.cjs');
const {
  buildAgentConsistencySectionIndex,
  buildAgentTechnicalPlanMarkdown,
  buildAgentGlobalFactsMarkdown,
  buildAgentConsistencyRepairPrompt,
  validateAgentConsistencySections,
} = require('./../agentWorkspace.cjs');

function createAgentConsistencyAuditStage(deps) {
  const {
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
  } = deps;
  const { state } = deps;

  function updateAgentConsistencyProgress(step, label, extra = {}) {
    contentStats.phase = 'auditing';
    contentStats.audit_step = 'agent';
    contentStats.audit_repair_mode = 'agent';
    contentStats.audit_agent_step_total = 5;
    contentStats.audit_agent_step_completed = Math.max(0, Math.min(5, Number(step) || 0));
    contentStats.audit_agent_step_label = label || '';
    Object.assign(contentStats, extra || {});
    const runtime = syncRuntime({ phase: 'auditing' });
    checkpointTask({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });
    return runtime;
  }

  async function runAgentConsistencyRepairIfEnabled(options = {}) {
    if (!enableConsistencyAudit) {
      writeDeveloperLog('consistency.agent.skipped', { reason: 'disabled' });
      state.appendLog('全文一致性审计未启用，跳过 Agent 一致性修复阶段。');
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }
    if (!agentService?.runTask) {
      throw new Error('Agent 服务尚未初始化，无法执行 Agent 一致性修复');
    }

    const allTargets = buildConsistencyAuditTargets('');
    const sectionIndex = buildAgentConsistencySectionIndex(allTargets);
    if (!sectionIndex.size) {
      writeDeveloperLog('consistency.agent.skipped', { reason: 'no_targets', target_item_id: options.targetItemId || targetItemId || '' });
      state.appendLog('Agent 一致性修复跳过：没有可审计的成功正文小节。');
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const normalizedTargetId = String(options.targetItemId || targetItemId || '').trim();
    const writableIds = normalizedTargetId ? new Set([normalizedTargetId]) : new Set(sectionIndex.keys());
    if (normalizedTargetId && !sectionIndex.has(normalizedTargetId)) {
      state.appendLog(`Agent 一致性修复跳过：目标小节 ${normalizedTargetId} 当前没有成功正文。`);
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
    state.appendLog(`开始 Agent 全文一致性修复：共 ${sectionIndex.size} 个正文小节${normalizedTargetId ? `，仅回写目标小节 ${normalizedTargetId}` : ''}。`);
    writeDeveloperLog('consistency.agent.start', {
      target_item_id: normalizedTargetId,
      section_count: sectionIndex.size,
      writable_ids: [...writableIds],
      sections: Array.from(sectionIndex.values()).map((section) => ({
        id: section.item.id,
        title: section.item.title || '未命名章节',
        content_metrics: textMetrics(section.originalContent),
      })),
    });

    updateAgentConsistencyProgress(1, '准备 Agent 输入文件');
    const files = [
      { path: 'global-facts.md', content: buildAgentGlobalFactsMarkdown(globalFactsText, bidAnalysisFactsText) },
      { path: 'technical-plan.md', content: buildAgentTechnicalPlanMarkdown(state.outlineData, sectionIndex) },
    ];
    pauseIfRequested('正文生成已在 Agent 全文一致性修复开始前暂停，本次 Agent 未启动；继续后将重新执行 Agent 修复。');

    updateAgentConsistencyProgress(2, 'Agent 正在审计并修复全文');
    const agentAbortController = new AbortController();
    let pauseWatcher = null;
    let pauseLogged = false;
    function abortAgentIfPauseRequested() {
      if (!isPauseRequested()) {
        return;
      }
      if (!pauseLogged) {
        pauseLogged = true;
        state.appendLog('已请求暂停 Agent 一致性修复，正在取消本轮 Agent 任务。');
        updateAgentConsistencyProgress(0, '正在取消本轮 Agent 修复，继续后将重新执行');
      }
      if (!agentAbortController.signal.aborted) {
        agentAbortController.abort(createContentGenerationPausedError());
      }
    }
    pauseWatcher = setInterval(abortAgentIfPauseRequested, 1000);

    try {
      abortAgentIfPauseRequested();
      pauseIfRequested('正文生成已在 Agent 全文一致性修复开始前暂停，本次 Agent 未启动；继续后将重新执行 Agent 修复。');
      const agentResult = await runAgentTaskWithRecoveredOutput({
        title: '全文一致性 Agent 修复',
        prompt: buildAgentConsistencyRepairPrompt(globalFactsMode),
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
        onActivity: createAgentActivityProgressHandler(updateAgentConsistencyProgress, 2, 'Agent 正在审计并修复全文'),
      }, 'consistency.agent');
      if (isAgentBusyResult(agentResult)) {
        state.appendLog('Agent 正在处理其他任务，本轮跳过 Agent 一致性修复。');
        writeDeveloperLog('consistency.agent.busy', { active_task: agentResult?.active_task || null });
        updateAgentConsistencyProgress(0, 'Agent 正忙，已跳过本轮 Agent 修复', {
          audit_agent_changed_sections: 0,
          audit_agent_failed_sections: 0,
        });
        return { ran: false, fixedCount: 0, failedCount: 0, skipped: true, reason: 'busy' };
      }
      pauseIfRequested('正文生成已在 Agent 全文一致性修复结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行 Agent 修复。');

      updateAgentConsistencyProgress(3, '读取 Agent 修复后的全文');
      const repairedMarkdown = String(agentResult?.output_content || '').trim();
      if (!repairedMarkdown) {
        writeDeveloperLog('consistency.agent.empty_output', { agent_result: agentResult });
        throw new Error('Agent 未返回修复后的 technical-plan.md');
      }

      updateAgentConsistencyProgress(4, '解析并校验 Agent 修复结果');
      const parsedSections = parseAgentSectionMarkdown(repairedMarkdown);
      validateAgentConsistencySections(parsedSections, sectionIndex);
      pauseIfRequested('正文生成已在 Agent 全文一致性修复结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行 Agent 修复。');

      updateAgentConsistencyProgress(5, '回写 Agent 修改的小节');
      const applyResult = applyAgentConsistencySections(parsedSections, sectionIndex, writableIds);
      contentStats.audit_agent_changed_sections = applyResult.changedCount;
      state.appendLog(applyResult.changedCount
        ? `Agent 一致性修复完成：已回写 ${applyResult.changedCount} 个小节（${applyResult.changedIds.join('、')}）。`
        : 'Agent 一致性修复完成：未发现需要回写的小节。');
      writeDeveloperLog('consistency.agent.done', {
        changed_count: applyResult.changedCount,
        skipped_count: applyResult.skippedCount,
        changed_ids: applyResult.changedIds,
        agent_task_id: agentResult?.task_id || '',
        agent_session_id: agentResult?.session_id || '',
      });
      updateAgentConsistencyProgress(5, 'Agent 一致性修复完成', { audit_agent_changed_sections: applyResult.changedCount });
      return { ran: true, fixedCount: applyResult.changedCount, failedCount: 0 };
    } catch (error) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        contentStats.audit_agent_changed_sections = 0;
        contentStats.audit_agent_failed_sections = 0;
        state.appendLog('Agent 一致性修复已暂停：本轮 Agent 已取消并清理，继续后将重新执行。');
        writeDeveloperLog('consistency.agent.paused', {
          target_item_id: normalizedTargetId,
          section_count: sectionIndex.size,
          error: error.message || String(error),
        });
        updateAgentConsistencyProgress(0, 'Agent 修复已暂停，继续后将重新执行', {
          audit_agent_changed_sections: 0,
          audit_agent_failed_sections: 0,
        });
        pauseIfRequested('正文生成已在 Agent 全文一致性修复阶段暂停，本次 Agent 已取消；继续后将重新执行 Agent 修复。');
      }
      const failedCount = normalizedTargetId ? 1 : sectionIndex.size;
      contentStats.audit_agent_failed_sections = failedCount;
      state.appendLog(`Agent 一致性修复失败：${error.message || '未知错误'}。已保留原正文，未回退普通修复。`);
      writeDeveloperLog('consistency.agent.failed', {
        target_item_id: normalizedTargetId,
        failed_count: failedCount,
        ...agentErrorDiagnostics(error),
      });
      updateAgentConsistencyProgress(contentStats.audit_agent_step_completed || 2, 'Agent 一致性修复失败', {
        audit_agent_failed_sections: failedCount,
      });
      throw error;
    } finally {
      if (pauseWatcher) clearInterval(pauseWatcher);
    }
  }

  return {
    updateAgentConsistencyProgress,
    runAgentConsistencyRepairIfEnabled,
  };
}

module.exports = { createAgentConsistencyAuditStage };
