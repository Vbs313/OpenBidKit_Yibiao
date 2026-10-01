// 标书版本快照：保存/恢复/列出 outline + content 状态，支持回滚到任意快照。
//
// 用途：标书编制过程中的版本管理，避免误操作丢失内容。
// 设计：
// 1. 快照保存在 SQLite 表 technical_plan_snapshots（独立表，不动主表）。
// 2. 每个快照含：snapshot_id、label、created_at、outline_json、content_sections_json。
// 3. 回滚时先自动保存当前状态为「回滚前快照」，再写入目标快照数据。
// 4. 纯 Store 层，不接触 UI 或任务状态。

const crypto = require('node:crypto');
const { now } = require('./storeUtils.cjs');

function createSnapshotId() {
  return `snap-${crypto.randomUUID()}`;
}

function snapshotFromRow(row) {
  if (!row) return null;
  return {
    snapshot_id: row.snapshot_id,
    label: row.label,
    created_at: row.created_at,
    outline_json: row.outline_json,
    content_sections_json: row.content_sections_json,
  };
}

function createSnapshotStore({ db }) {
  function listSnapshots() {
    return db.prepare(`
      SELECT snapshot_id, label, created_at
      FROM technical_plan_snapshots
      ORDER BY created_at DESC
    `).all();
  }

  function getSnapshot(snapshotId) {
    const row = db.prepare(`
      SELECT snapshot_id, label, created_at, outline_json, content_sections_json
      FROM technical_plan_snapshots
      WHERE snapshot_id = ?
    `).get(snapshotId);
    return snapshotFromRow(row);
  }

  function saveSnapshot({ label, outline_json, content_sections_json }) {
    const snapshotId = createSnapshotId();
    const timestamp = now();
    db.prepare(`
      INSERT INTO technical_plan_snapshots (snapshot_id, label, outline_json, content_sections_json, created_at)
      VALUES (@snapshot_id, @label, @outline_json, @content_sections_json, @created_at)
    `).run({
      snapshot_id: snapshotId,
      label: String(label || '未命名快照').slice(0, 100),
      outline_json: JSON.stringify(outline_json || {}),
      content_sections_json: JSON.stringify(content_sections_json || {}),
      created_at: timestamp,
    });
    return { snapshot_id: snapshotId, label, created_at: timestamp };
  }

  function deleteSnapshot(snapshotId) {
    const result = db.prepare('DELETE FROM technical_plan_snapshots WHERE snapshot_id = ?').run(snapshotId);
    return { success: result.changes > 0, message: result.changes > 0 ? '快照已删除' : '快照不存在' };
  }

  /** 回滚到指定快照：返回目标快照数据，由调用方写回主表（先自动保存当前状态）。 */
  function loadSnapshotForRestore(snapshotId) {
    return getSnapshot(snapshotId);
  }

  return {
    listSnapshots,
    getSnapshot,
    saveSnapshot,
    deleteSnapshot,
    loadSnapshotForRestore,
  };
}

module.exports = { createSnapshotStore };
