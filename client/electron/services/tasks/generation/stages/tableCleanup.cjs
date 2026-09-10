// 正文去表格子阶段：把指定小节里的 Markdown/HTML 表格改写为普通文字描述。
// 该阶段原本是 runContentGenerationTask 内部的闭包；这里把状态与副作用全部改成
// 由 createTableCleanupStage(deps) 显式注入，自身不持有模块级状态，可单独测试。
//
// deps 约定：
//   aiService / contentStats / tableRequirement / targetItemId  直接读的对象或常量
//   getLeaves() / getSections() / getLogs()                     读取会被重新赋值的闭包变量
//   appendLog(message)                                          追加一行任务日志
//   其余为任务运行时回调（进度、检查点、开发者日志、暂停、落盘）

const { applyRangeEdits } = require('./../../../../utils/textEdit.cjs');
const {
  createTableCleanupBatches,
  extractContentTableBlocks,
  containsContentTable,
} = require('./../tableExtraction.cjs');
const { buildTableCleanupMessages } = require('./../contentMessages.cjs');
const { normalizeTableCleanupResponse } = require('./../normalize.cjs');
const { validateTableCleanupResponse } = require('./../markdownTables.cjs');
const { textMetrics } = require('./../textEdits.cjs');
const { progressFor } = require('./../progress.cjs');
const { isPauseLikeError } = require('./../taskRuntime.cjs');

function createTableCleanupStage(deps) {
  const {
    aiService,
    contentStats,
    tableRequirement,
    targetItemId,
    getLeaves,
    getSections,
    getLogs,
    appendLog,
    publishTaskUpdate,
    checkpointTask,
    syncRuntime,
    statsSnapshot,
    writeDeveloperLog,
    pauseIfRequested,
    rememberTouchedItem,
    saveSection,
  } = deps;

  function getCurrentSuccessfulContent(item) {
    const section = getSections()[item.id] || {};
    return section.status === 'success' ? String(section.content || '') : '';
  }

  function buildTableCleanupTargets(cleanupTargetItemId = '') {
    const normalizedTargetId = String(cleanupTargetItemId || '').trim();
    return getLeaves()
      .filter(({ item }) => !normalizedTargetId || item.id === normalizedTargetId)
      .map((context) => {
        const content = getCurrentSuccessfulContent(context.item);
        return {
          ...context,
          content,
          tables: extractContentTableBlocks(content),
        };
      })
      .filter(({ content, tables }) => String(content || '').trim() && tables.length);
  }

  async function cleanupTablesForSection(target) {
    const { item } = target;
    let currentContent = target.content;
    const originalTables = extractContentTableBlocks(currentContent);
    let rewrittenCount = 0;
    let skippedCount = 0;
    if (!originalTables.length) {
      return { rewrittenCount, skippedCount };
    }

    const batches = createTableCleanupBatches(originalTables).reverse();
    writeDeveloperLog('table_cleanup.section.start', {
      section_id: item.id,
      title: item.title || '未命名章节',
      table_count: originalTables.length,
      batch_count: batches.length,
      content_metrics: textMetrics(currentContent),
    });

    for (const batch of batches) {
      pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
      const allowedTableIds = new Set(batch.map((table) => table.id));
      const tableById = new Map(batch.map((table) => [table.id, table]));
      try {
        const response = await aiService.collectJsonResponse({
          messages: buildTableCleanupMessages({ chapter: item, tables: batch }),
          logTitle: `正文去表格-${item.id}-${item.title || '未命名章节'}`,
          progressLabel: '正文去表格',
          failureMessage: '模型返回的表格转换结果格式无效',
          normalizer: (value) => normalizeTableCleanupResponse(value, allowedTableIds),
          validator: validateTableCleanupResponse,
          max_retries: 1,
        });
        const edits = [];
        const returnedIds = new Set();
        for (const replacement of response.replacements || []) {
          const table = tableById.get(replacement.table_id);
          returnedIds.add(replacement.table_id);
          if (!table) {
            continue;
          }
          if (containsContentTable(replacement.replacement_text)) {
            skippedCount += 1;
            writeDeveloperLog('table_cleanup.replacement.skipped', {
              section_id: item.id,
              table_id: table.id,
              reason: 'replacement_still_contains_table',
              replacement_metrics: textMetrics(replacement.replacement_text),
            });
            continue;
          }
          edits.push({ start: table.start, end: table.end, newText: replacement.replacement_text });
        }

        const missingCount = batch.filter((table) => !returnedIds.has(table.id)).length;
        skippedCount += missingCount;
        if (!edits.length) {
          contentStats.table_cleanup_completed += batch.length;
          publishTaskUpdate({ status: 'running', progress: progressFor(getLeaves(), getSections()), logs: getLogs(), stats: statsSnapshot() });
          continue;
        }

        const editResult = applyRangeEdits(currentContent, edits);
        if (editResult.errors.length) {
          skippedCount += edits.length;
          writeDeveloperLog('table_cleanup.apply.failed', {
            section_id: item.id,
            errors: editResult.errors,
            edit_count: edits.length,
          });
        } else {
          currentContent = editResult.content;
          rewrittenCount += editResult.edits.length;
          contentStats.table_cleanup_rewritten += editResult.edits.length;
          rememberTouchedItem(item.id);
          saveSection(item, { status: 'success', content: currentContent, error: undefined }, currentContent, { logs: getLogs() });
          writeDeveloperLog('table_cleanup.apply.success', {
            section_id: item.id,
            applied_count: editResult.edits.length,
            edit_results: editResult.edits,
            content_metrics: textMetrics(currentContent),
          });
        }
        contentStats.table_cleanup_completed += batch.length;
        publishTaskUpdate({ status: 'running', progress: progressFor(getLeaves(), getSections()), logs: getLogs(), stats: statsSnapshot() });
      } catch (error) {
        if (isPauseLikeError(error)) {
          throw error;
        }
        skippedCount += batch.length;
        contentStats.table_cleanup_completed += batch.length;
        appendLog(`正文去表格跳过：${item.id} ${item.title || '未命名章节'}，${error.message || '模型返回无效'}。`);
        writeDeveloperLog('table_cleanup.batch.error', {
          section_id: item.id,
          title: item.title || '未命名章节',
          table_ids: batch.map((table) => table.id),
          error: error.message || '模型返回无效',
          stack: error.stack || '',
        });
        publishTaskUpdate({ status: 'running', progress: progressFor(getLeaves(), getSections()), logs: getLogs(), stats: statsSnapshot() });
      }
    }

    const remainingTables = extractContentTableBlocks(currentContent).length;
    if (remainingTables) {
      writeDeveloperLog('table_cleanup.section.remaining', {
        section_id: item.id,
        title: item.title || '未命名章节',
        remaining_tables: remainingTables,
      });
    }
    return { rewrittenCount, skippedCount: Math.max(0, originalTables.length - rewrittenCount) };
  }

  async function removeTablesBeforeIllustration(options = {}) {
    if (tableRequirement !== 'none') {
      return { ran: false, rewrittenCount: 0, skippedCount: 0 };
    }

    contentStats.phase = 'table-cleaning';
    contentStats.table_cleanup_total = 0;
    contentStats.table_cleanup_completed = 0;
    contentStats.table_cleanup_rewritten = 0;
    contentStats.table_cleanup_skipped = 0;
    const runtime = syncRuntime({ phase: 'table-cleaning' });
    checkpointTask({ status: 'running', progress: progressFor(getLeaves(), getSections()), logs: getLogs(), stats: statsSnapshot() }, {
      contentGenerationRuntime: runtime,
    }, { contentRuntime: runtime });

    const targets = buildTableCleanupTargets(options.targetItemId || targetItemId);
    const tableTotal = targets.reduce((sum, target) => sum + target.tables.length, 0);
    contentStats.table_cleanup_total = tableTotal;

    if (!tableTotal) {
      appendLog('正文去表格检查完成：未发现需要转换的表格。');
      publishTaskUpdate({ status: 'running', progress: progressFor(getLeaves(), getSections()), logs: getLogs(), stats: statsSnapshot() });
      return { ran: true, rewrittenCount: 0, skippedCount: 0 };
    }

    appendLog(`开始正文去表格：发现 ${targets.length} 个小节、${tableTotal} 个表格，将按小节并发转换为普通文字描述。`);
    writeDeveloperLog('table_cleanup.start', {
      target_item_id: options.targetItemId || targetItemId || '',
      section_count: targets.length,
      table_count: tableTotal,
      sections: targets.map(({ item, tables }) => ({ id: item.id, title: item.title || '未命名章节', table_count: tables.length })),
    });
    publishTaskUpdate({ status: 'running', progress: progressFor(getLeaves(), getSections()), logs: getLogs(), stats: statsSnapshot() });

    let rewrittenCount = 0;
    let skippedCount = 0;
    pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
    const settled = await Promise.allSettled(targets.map(async (target) => {
      const result = await cleanupTablesForSection(target);
      rewrittenCount += result.rewrittenCount;
      skippedCount += result.skippedCount;
      contentStats.table_cleanup_skipped = skippedCount;
      publishTaskUpdate({ status: 'running', progress: progressFor(getLeaves(), getSections()), logs: getLogs(), stats: statsSnapshot() });
    }));
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected) throw rejected.reason;

    pauseIfRequested('正文生成已在去表格阶段暂停，可导出当前已完成内容，稍后继续。');
    appendLog(`正文去表格完成：成功转换 ${rewrittenCount} 个表格，跳过 ${skippedCount} 个。`);
    writeDeveloperLog('table_cleanup.done', {
      table_count: tableTotal,
      rewritten_count: rewrittenCount,
      skipped_count: skippedCount,
    });
    publishTaskUpdate({ status: 'running', progress: progressFor(getLeaves(), getSections()), logs: getLogs(), stats: statsSnapshot() });
    return { ran: true, rewrittenCount, skippedCount };
  }

  return { removeTablesBeforeIllustration };
}

module.exports = { createTableCleanupStage };