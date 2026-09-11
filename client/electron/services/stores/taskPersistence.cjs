// 技术方案任务与运行时的持久化：任务行读写、原文大纲运行态、引用文档 id 列表。
//
// 这些原本是 createTechnicalPlanStore 工厂里的闭包函数；这里只注入两个状态归一助手，
// 其余依赖来自本文件与 storeUtils，函数本身不持有可变闭包状态。

const fs = require('node:fs');
const path = require('node:path');
const { now, safeJsonParse, jsonOrNull } = require('./storeUtils.cjs');

function toDbBool(value) {
  return value ? 1 : 0;
}

function fromDbBool(value) {
  return Number(value) === 1;
}

function createTaskPersistence(deps) {
  const {
    db,
    taskLogStore,
    originalOutlineRuntimePath,
    updateMeta,
    normalizeStatus,
    normalizeBidSectionExtractionStatus,
  } = deps;

  function saveTask(type, task) {
    if (!task) {
      db.prepare('DELETE FROM technical_plan_tasks WHERE type = ?').run(type);
      if (type === 'bid-section-extraction') {
        updateMeta({ bid_section_extraction_status: 'idle', bid_section_extraction_error: null });
      }
      return;
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO technical_plan_tasks (type, task_id, status, progress, stats_json, error, pause_requested, started_at, updated_at)
      VALUES (@type, @task_id, @status, @progress, @stats_json, @error, @pause_requested, @started_at, @updated_at)
      ON CONFLICT(type) DO UPDATE SET
        task_id = excluded.task_id,
        status = excluded.status,
        progress = excluded.progress,
        stats_json = excluded.stats_json,
        error = excluded.error,
        pause_requested = excluded.pause_requested,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `).run({
      type,
      task_id: String(task.task_id || ''),
      status: String(task.status || 'running'),
      progress: Math.max(0, Math.min(100, Math.round(Number(task.progress || 0)))),
      stats_json: jsonOrNull(task.stats),
      error: task.error ? String(task.error) : null,
      pause_requested: toDbBool(task.pause_requested),
      started_at: task.started_at || timestamp,
      updated_at: task.updated_at || timestamp,
    });
    taskLogStore.sync('technical-plan', type, String(task.task_id || ''), task.logs, task.updated_at || timestamp);
    if (type === 'bid-section-extraction') {
      updateMeta({
        bid_section_extraction_status: normalizeBidSectionExtractionStatus(task.status),
        bid_section_extraction_error: task.error ? String(task.error) : null,
      });
    }
  }

  function readOriginalOutlineRuntime() {
    if (!fs.existsSync(originalOutlineRuntimePath)) {
      return null;
    }
    try {
      const runtime = safeJsonParse(fs.readFileSync(originalOutlineRuntimePath, 'utf-8'), null);
      if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
        clearOriginalOutlineRuntime();
        return null;
      }
      return runtime;
    } catch {
      clearOriginalOutlineRuntime();
      return null;
    }
  }

  function clearOriginalOutlineRuntime() {
    if (!fs.existsSync(originalOutlineRuntimePath)) {
      return;
    }
    fs.rmSync(originalOutlineRuntimePath, { force: true });
  }

  function saveOriginalOutlineRuntime(runtime) {
    const targetDir = path.dirname(originalOutlineRuntimePath);
    const tempPath = path.join(targetDir, `original-outline-runtime-${Date.now()}.tmp.json`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(runtime || {}, null, 2)}\n`, 'utf-8');
    try {
      fs.renameSync(tempPath, originalOutlineRuntimePath);
    } catch (error) {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }

  function loadReferenceDocumentIds() {
    return db.prepare('SELECT document_id FROM technical_plan_reference_docs ORDER BY sort_order ASC').all()
      .map((row) => row.document_id);
  }

  function replaceReferenceDocumentIds(documentIds) {
    db.prepare('DELETE FROM technical_plan_reference_docs').run();
    const insert = db.prepare('INSERT INTO technical_plan_reference_docs (document_id, sort_order) VALUES (@document_id, @sort_order)');
    [...new Set((Array.isArray(documentIds) ? documentIds : []).map((id) => String(id || '').trim()).filter(Boolean))]
      .forEach((documentId, index) => insert.run({ document_id: documentId, sort_order: index }));
  }

  function taskFromRow(row) {
    if (!row) return undefined;
    return {
      task_id: row.task_id,
      type: row.type,
      status: normalizeStatus(row.status, ['running', 'pausing', 'paused', 'success', 'error'], 'running'),
      progress: Number(row.progress || 0),
      logs: taskLogStore.list('technical-plan', row.type, row.task_id),
      started_at: row.started_at,
      updated_at: row.updated_at,
      error: row.error || undefined,
      stats: safeJsonParse(row.stats_json, undefined),
      pause_requested: fromDbBool(row.pause_requested),
    };
  }

  return {
    saveTask,
    taskFromRow,
    readOriginalOutlineRuntime,
    saveOriginalOutlineRuntime,
    clearOriginalOutlineRuntime,
    loadReferenceDocumentIds,
    replaceReferenceDocumentIds,
  };
}

module.exports = { createTaskPersistence };
