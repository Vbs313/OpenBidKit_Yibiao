// 全文一致性审计子阶段（普通模式）：先按字数把成功正文小节拆组审计，
// 再对冲突小节做局部替换，最后回写。
//
// 该阶段原本是 runContentGenerationTask 内部的闭包；这里把状态与副作用全部改成
// 由 createConsistencyAuditStage(deps) 显式注入，自身不持有模块级状态，可单独测试。
//
// deps 约定：
//   aiService / contentStats / contentConcurrency / globalFacts* / tableRequirement /
//   targetItemId / enableConsistencyAudit                        直接读的对象或常量
//   state.leaves / state.sections / state.logs                     读取会被重新赋值的闭包变量
//   state.appendLog(message)                                          追加一行任务日志
//   其余为任务运行时回调（进度、检查点、开发者日志、暂停、落盘）

const {
  buildConsistencyAuditMessages,
  buildConsistencyAuditRepairMessages,
  buildConsistencyRepairJsonRepairMessages,
} = require('./../contentMessages.cjs');
const {
  normalizeConsistencyAuditResponse,
  normalizeConsistencyRepairResponse,
} = require('./../normalize.cjs');
const { validateConsistencyAuditResponse } = require('./../validators.cjs');
const { validateConsistencyRepairResponse } = require('./../agentResponse.cjs');
const { progressFor } = require('./../progress.cjs');
const { isPauseLikeError, runItemsWithWorkerPool } = require('./../taskRuntime.cjs');
const { textMetrics, applyConsistencyRepairPatches } = require('./../textEdits.cjs');
const {
  buildConsistencyRepairMessages,
  CONSISTENCY_REPAIR_MAX_ATTEMPTS,
} = require('./../consistencyRepair.cjs');

const CONSISTENCY_AUDIT_GROUP_WORD_LIMIT = 300000;

function createConsistencyAuditStage(deps) {
  const {
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
  } = deps;
  const { state } = deps;

  function buildConsistencyAuditTargets(auditTargetItemId = '') {
    const normalizedTargetId = String(auditTargetItemId || '').trim();
    return state.leaves
      .filter(({ item }) => !normalizedTargetId || item.id === normalizedTargetId)
      .map((context) => {
        const content = state.sections[context.item.id]?.content || context.item.content || '';
        return {
          ...context,
          content,
          words: getLeafWordCount(context.item),
        };
      })
      .filter(({ item, content }) => state.sections[item.id]?.status === 'success' && String(content || '').trim());
  }

  function buildConsistencyAuditGroups(targets) {
    const totalWords = (targets || []).reduce((sum, item) => sum + item.words, 0);
    if (!targets?.length) {
      return [];
    }

    let groupCount = 1;
    if (totalWords > CONSISTENCY_AUDIT_GROUP_WORD_LIMIT) {
      groupCount = 2;
      while (totalWords / groupCount > CONSISTENCY_AUDIT_GROUP_WORD_LIMIT) {
        groupCount += 1;
      }
    }
    const targetWords = Math.max(1, Math.ceil(totalWords / groupCount));
    const groups = [];
    let current = { index: 1, items: [], words: 0, targetWords };

    for (const target of targets) {
      if (current.items.length && current.words + target.words > targetWords && groups.length < groupCount - 1) {
        groups.push(current);
        current = { index: groups.length + 1, items: [], words: 0, targetWords };
      }
      current.items.push(target);
      current.words += target.words;
    }
    if (current.items.length) {
      groups.push(current);
    }
    return groups.map((group, index) => ({ ...group, index: index + 1, total: groups.length, totalWords }));
  }

  async function repairConsistencySection({ context, conflicts }) {
    const { item } = context;
    let currentContent = state.sections[item.id]?.content || item.content || '';
    let failures = [];
    let appliedTotal = 0;
    writeDeveloperLog('consistency.repair.section.start', {
      section_id: item.id,
      title: item.title || '未命名章节',
      conflict_count: (conflicts || []).length,
      conflicts,
      content_metrics: textMetrics(currentContent),
    });

    for (let attempt = 1; attempt <= CONSISTENCY_REPAIR_MAX_ATTEMPTS; attempt += 1) {
      if (isPauseRequested()) {
        writeDeveloperLog('consistency.repair.section.paused', {
          section_id: item.id,
          title: item.title || '未命名章节',
          applied_count: appliedTotal,
        });
        return { appliedCount: appliedTotal, failed: false, paused: true };
      }

      try {
        writeDeveloperLog('consistency.repair.attempt.start', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          max_attempts: CONSISTENCY_REPAIR_MAX_ATTEMPTS,
          previous_failures: failures,
          content_metrics: textMetrics(currentContent),
        });
        const response = await aiService.collectJsonResponse({
          messages: buildConsistencyRepairMessages({
            context,
            conflicts,
            globalFactsText,
            bidAnalysisFactsText,
            currentContent,
            attempt,
            failures,
            tableRequirement,
            globalFactsMode,
          }),
          logTitle: `一致性修复-${item.id}-${item.title || '未命名章节'}`,
          progressLabel: '正文一致性修复',
          failureMessage: '模型返回的正文一致性修复结果格式无效',
          normalizer: (value) => normalizeConsistencyRepairResponse(value, item.id),
          validator: validateConsistencyRepairResponse,
          repairMessagesBuilder: (contextForRepair) => buildConsistencyRepairJsonRepairMessages(contextForRepair, item.id),
          max_retries: 1,
        });
        writeDeveloperLog('consistency.repair.response', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          patch_count: response.patches.length,
          patches: response.patches,
        });

        if (!response.patches.length) {
          failures = ['模型未返回可应用的 patches'];
          writeDeveloperLog('consistency.repair.no_patches', {
            section_id: item.id,
            title: item.title || '未命名章节',
            attempt,
          });
        } else {
          const result = applyConsistencyRepairPatches(currentContent, response.patches);
          writeDeveloperLog('consistency.repair.apply_result', {
            section_id: item.id,
            title: item.title || '未命名章节',
            attempt,
            applied_count: result.appliedCount,
            errors: result.errors,
            patch_results: result.patchResults,
          });
          if (result.appliedCount > 0) {
            currentContent = result.content;
            appliedTotal += result.appliedCount;
            rememberTouchedItem(item.id);
            saveSection(item, { status: 'success', content: currentContent, error: undefined }, currentContent, { logs: state.logs });
            writeDeveloperLog('consistency.repair.section.saved', {
              section_id: item.id,
              title: item.title || '未命名章节',
              attempt,
              applied_total: appliedTotal,
              content_metrics: textMetrics(currentContent),
            });
          }
          if (!result.errors.length) {
            writeDeveloperLog('consistency.repair.section.done', {
              section_id: item.id,
              title: item.title || '未命名章节',
              applied_count: appliedTotal,
              failed: false,
            });
            return { appliedCount: appliedTotal, failed: false, paused: false };
          }
          failures = result.errors;
        }
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        failures = [error.message || '模型返回无效'];
        writeDeveloperLog('consistency.repair.attempt.error', {
          section_id: item.id,
          title: item.title || '未命名章节',
          attempt,
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
      }

      state.appendLog(`一致性修复第 ${attempt}/${CONSISTENCY_REPAIR_MAX_ATTEMPTS} 次未完成：${item.id} ${item.title || '未命名章节'}，${failures.join('；')}。`);
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
    }

    writeDeveloperLog('consistency.repair.section.done', {
      section_id: item.id,
      title: item.title || '未命名章节',
      applied_count: appliedTotal,
      failed: true,
      errors: failures,
    });
    return { appliedCount: appliedTotal, failed: true, paused: false, errors: failures };
  }

  async function runConsistencyAuditIfEnabled(options = {}) {
    if (!enableConsistencyAudit) {
      writeDeveloperLog('consistency.audit.skipped', { reason: 'disabled' });
      state.appendLog('全文一致性审计未启用，跳过审计阶段。');
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const auditTargets = buildConsistencyAuditTargets(options.targetItemId || targetItemId);
    if (!auditTargets.length) {
      writeDeveloperLog('consistency.audit.skipped', { reason: 'no_targets', target_item_id: options.targetItemId || targetItemId || '' });
      state.appendLog('全文一致性审计跳过：没有可审计的成功正文小节。');
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      return { ran: false, fixedCount: 0, failedCount: 0 };
    }

    const auditGroups = buildConsistencyAuditGroups(auditTargets);
    const targetById = new Map(auditTargets.map((context) => [context.item.id, context]));
    const conflictsBySectionId = new Map();

    contentStats.phase = 'auditing';
    contentStats.audit_step = 'checking';
    contentStats.audit_repair_mode = 'normal';
    contentStats.audit_group_total = auditGroups.length;
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
    state.appendLog(`开始全文一致性审计：${auditTargets.length} 个小节，拆分为 ${auditGroups.length} 组，并发 ${contentConcurrency}。`);
    const auditRuntime = syncRuntime({ phase: 'auditing' });
    writeDeveloperLog('consistency.audit.start', {
      target_item_id: options.targetItemId || targetItemId || '',
      target_count: auditTargets.length,
      group_count: auditGroups.length,
      concurrency: contentConcurrency,
      group_word_limit: CONSISTENCY_AUDIT_GROUP_WORD_LIMIT,
      groups: auditGroups.map((group) => ({
        index: group.index,
        total: group.total,
        words: group.words,
        target_words: group.targetWords,
        total_words: group.totalWords,
        sections: group.items.map(({ item, words, content }) => ({
          id: item.id,
          title: item.title || '未命名章节',
          words,
          content_metrics: textMetrics(content),
        })),
      })),
    });
    checkpointTask({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() }, {
      contentGenerationRuntime: auditRuntime,
    }, { contentRuntime: auditRuntime });

    async function auditConsistencyGroup(group) {
      const allowedIds = new Set(group.items.map(({ item }) => item.id).filter(Boolean));
      try {
        writeDeveloperLog('consistency.audit.group.start', {
          index: group.index,
          total: group.total,
          words: group.words,
          allowed_ids: [...allowedIds],
        });
        const response = await aiService.collectJsonResponse({
          messages: buildConsistencyAuditMessages({ group, globalFactsText, bidAnalysisFactsText, globalFactsMode }),
          logTitle: `一致性审计-${group.index}-${group.total}`,
          progressLabel: '全文一致性审计',
          failureMessage: '模型返回的一致性审计结果格式无效',
          normalizer: (value) => normalizeConsistencyAuditResponse(value, allowedIds),
          validator: validateConsistencyAuditResponse,
          repairMessagesBuilder: (contextForRepair) => buildConsistencyAuditRepairMessages(contextForRepair, allowedIds),
          max_retries: 1,
        });

        for (const conflict of response.conflicts) {
          const list = conflictsBySectionId.get(conflict.section_id) || [];
          list.push(conflict);
          conflictsBySectionId.set(conflict.section_id, list);
        }
        contentStats.audit_conflict_total = conflictsBySectionId.size;
        state.appendLog(`一致性审计完成：第 ${group.index}/${group.total} 组，发现 ${response.conflicts.length} 条冲突，累计 ${conflictsBySectionId.size} 个冲突小节。`);
        writeDeveloperLog('consistency.audit.group.success', {
          index: group.index,
          total: group.total,
          conflict_count: response.conflicts.length,
          conflicts: response.conflicts,
          conflict_section_count: conflictsBySectionId.size,
        });
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        state.appendLog(`一致性审计失败：第 ${group.index}/${group.total} 组，${error.message || '模型返回无效'}，已跳过该组。`);
        writeDeveloperLog('consistency.audit.group.error', {
          index: group.index,
          total: group.total,
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
      } finally {
        contentStats.audit_group_completed += 1;
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      }
    }

    if (auditGroups.length > 1) {
      const [warmupGroup, ...remainingGroups] = auditGroups;
      state.appendLog(`开始全文一致性审计预热：第 ${warmupGroup.index}/${warmupGroup.total} 组。`);
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });

      await auditConsistencyGroup(warmupGroup);
      pauseIfRequested('正文生成已在一致性审计预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingGroups.length) {
        continueAfterPromptCacheWarmup(`全文一致性审计预热完成，开始并发审计剩余 ${remainingGroups.length} 组。`);
        state.appendLog(`开始并发审计剩余 ${remainingGroups.length} 组。`);
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
        await runItemsWithWorkerPool(remainingGroups, contentConcurrency, auditConsistencyGroup, isPauseRequested);
      }
    } else {
      await runItemsWithWorkerPool(auditGroups, contentConcurrency, auditConsistencyGroup, isPauseRequested);
    }

    pauseIfRequested('正文生成已在一致性审计阶段暂停，可导出当前已完成内容，稍后继续。');

    const repairTargets = Array.from(conflictsBySectionId.entries())
      .map(([sectionId, conflicts]) => ({ context: targetById.get(sectionId), conflicts }))
      .filter((target) => target.context);
    contentStats.audit_step = 'fixing';
    contentStats.audit_fix_total = repairTargets.length;
    contentStats.audit_fix_completed = 0;
    contentStats.audit_fix_failed = 0;
    state.appendLog(repairTargets.length
      ? `一致性审计发现 ${repairTargets.length} 个冲突小节，开始局部修复，并发 ${contentConcurrency}。`
      : '一致性审计未发现需要修复的事实冲突。');
    writeDeveloperLog('consistency.repair.start', {
      target_count: repairTargets.length,
      concurrency: contentConcurrency,
      targets: repairTargets.map(({ context, conflicts }) => ({
        section_id: context.item.id,
        title: context.item.title || '未命名章节',
        conflict_count: conflicts.length,
        conflicts,
      })),
    });
    publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });

    if (!repairTargets.length) {
      writeDeveloperLog('consistency.audit.done', { fixed_count: 0, failed_count: 0, repair_target_count: 0 });
      return { ran: true, fixedCount: 0, failedCount: 0 };
    }

    let fixedCount = 0;
    async function repairConsistencyTarget(target) {
      const item = target.context.item;
      try {
        const result = await repairConsistencySection(target);
        if (result.appliedCount > 0) {
          fixedCount += 1;
          state.appendLog(`一致性修复完成：${item.id} ${item.title || '未命名章节'}，应用 ${result.appliedCount} 个局部替换。`);
        }
        if (result.failed) {
          contentStats.audit_fix_failed += 1;
          state.appendLog(`一致性修复需人工核对：${item.id} ${item.title || '未命名章节'}，${(result.errors || []).join('；') || '未能唯一定位替换内容'}。`);
        }
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        contentStats.audit_fix_failed += 1;
        state.appendLog(`一致性修复失败：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}。`);
      } finally {
        contentStats.audit_fix_completed += 1;
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      }
    }

    if (repairTargets.length > 1) {
      const [warmupTarget, ...remainingTargets] = repairTargets;
      state.appendLog(`开始一致性修复预热：${warmupTarget.context.item.id} ${warmupTarget.context.item.title || '未命名章节'}。`);
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });

      await repairConsistencyTarget(warmupTarget);
      pauseIfRequested('正文生成已在一致性修复预热后暂停，可导出当前已完成内容，稍后继续。');

      if (remainingTargets.length) {
        continueAfterPromptCacheWarmup(`一致性修复预热完成，开始并发修复剩余 ${remainingTargets.length} 个小节。`);
        state.appendLog(`开始并发修复剩余 ${remainingTargets.length} 个小节。`);
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
        await runItemsWithWorkerPool(remainingTargets, contentConcurrency, repairConsistencyTarget, isPauseRequested);
      }
    } else {
      await runItemsWithWorkerPool(repairTargets, contentConcurrency, repairConsistencyTarget, isPauseRequested);
    }

    pauseIfRequested('正文生成已在一致性修复阶段暂停，可导出当前已完成内容，稍后继续。');

    state.appendLog(`一致性审计完成：发现 ${repairTargets.length} 个冲突小节，成功修复 ${fixedCount} 个，${contentStats.audit_fix_failed} 个需人工核对。`);
    contentStats.audit_step = 'done';
    writeDeveloperLog('consistency.audit.done', {
      repair_target_count: repairTargets.length,
      fixed_count: fixedCount,
      failed_count: contentStats.audit_fix_failed,
    });
    publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
    return { ran: true, fixedCount, failedCount: contentStats.audit_fix_failed };
  }

  return { buildConsistencyAuditTargets, runConsistencyAuditIfEnabled };
}

module.exports = { createConsistencyAuditStage };
