const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTenderMeta } = require('./tenderMeta.cjs');

function makeHarness(initialRow = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-meta-'));
  const workspaceDir = path.join(root, 'ws');
  const technicalPlanDir = path.join(workspaceDir, 'technical-plan');
  fs.mkdirSync(technicalPlanDir, { recursive: true });
  const tenderMarkdownPath = path.join(technicalPlanDir, 'tender.md');
  const state = { row: initialRow ? { id: 1, ...initialRow } : null, updates: [] };
  const db = {
    prepare(sql) {
      return {
        get: () => (sql.includes('SELECT') ? state.row : null),
        run: (params = {}) => {
          state.updates.push({ sql, params });
          if (sql.includes('INSERT')) state.row = { id: 1, workflow_kind: 'technical-plan', step: 'document-analysis', ...params };
          else if (sql.includes('UPDATE')) state.row = { ...(state.row || { id: 1 }), ...params };
          return { changes: 1 };
        },
      };
    },
  };
  const api = createTenderMeta({ db, tenderMarkdownPath, tenderMarkdownRelativePath: 'technical-plan/tender.md' });
  return { root, workspaceDir, technicalPlanDir, tenderMarkdownPath, state, api };
}

test('ensureMetaRow 缺行时插入、有行时原样返回', () => {
  const h = makeHarness();
  const created = h.api.ensureMetaRow();
  assert.equal(created.id, 1);
  assert.equal(created.workflow_kind, 'technical-plan');
  assert.equal(h.state.updates.filter((u) => u.sql.includes('INSERT')).length, 1);
  const again = h.api.ensureMetaRow();
  assert.equal(again.id, 1);
  assert.equal(h.state.updates.filter((u) => u.sql.includes('INSERT')).length, 1);
});

test('readMetaRow 没有行时抛错', () => {
  const h = makeHarness();
  assert.throws(() => h.api.readMetaRow(), /技术方案数据库尚未初始化/);
});

test('updateMeta 过滤 undefined 字段并写入 updated_at', () => {
  const h = makeHarness({ id: 1, step: 'document-analysis' });
  h.api.updateMeta({ step: 'outline', note: undefined });
  assert.equal(h.state.row.step, 'outline');
  assert.ok(h.state.row.updated_at);
  const update = h.state.updates.find((u) => u.sql.includes('UPDATE'));
  assert.ok(update.sql.includes('step = @step'));
  assert.equal(update.sql.includes('note = @note'), false);
});

test('resolveMarkdownPath 处理空值、绝对路径与相对路径', () => {
  const h = makeHarness();
  assert.equal(h.api.resolveMarkdownPath(''), h.tenderMarkdownPath);
  const absolute = path.join(h.root, 'other.md');
  assert.equal(h.api.resolveMarkdownPath(absolute), absolute);
  assert.equal(h.api.resolveMarkdownPath('technical-plan/tender.md'), h.tenderMarkdownPath);
});

test('isPendingTenderMarkdownPath 只认技术方案目录下的临时待选文件', () => {
  const h = makeHarness();
  const pending = path.join(h.technicalPlanDir, 'tender-pending-123.tmp.md');
  assert.equal(h.api.isPendingTenderMarkdownPath(pending), true);
  assert.equal(h.api.isPendingTenderMarkdownPath(path.join(h.technicalPlanDir, 'tender.md')), false);
  assert.equal(h.api.isPendingTenderMarkdownPath(path.join(h.root, 'tender-pending-123.tmp.md')), false);
});

test('cleanupOrphanPendingTenderFiles 保留当前待选、清掉孤儿', () => {
  const h = makeHarness();
  const active = path.join(h.technicalPlanDir, 'tender-pending-1.tmp.md');
  const orphan = path.join(h.technicalPlanDir, 'tender-pending-2.tmp.md');
  fs.writeFileSync(active, 'active');
  fs.writeFileSync(orphan, 'orphan');
  h.api.cleanupOrphanPendingTenderFiles(active);
  assert.equal(fs.existsSync(active), true);
  assert.equal(fs.existsSync(orphan), false);
});

test('removePendingTenderMarkdown 只删临时待选文件', () => {
  const h = makeHarness();
  const pending = path.join(h.technicalPlanDir, 'tender-pending-3.tmp.md');
  const normal = path.join(h.technicalPlanDir, 'tender.md');
  fs.writeFileSync(pending, 'x');
  fs.writeFileSync(normal, 'y');
  h.api.removePendingTenderMarkdown(pending);
  h.api.removePendingTenderMarkdown(normal);
  assert.equal(fs.existsSync(pending), false);
  assert.equal(fs.existsSync(normal), true);
});

test('cleanupLegacyPendingTenderState 有遗留待选时清理并返回 true', () => {
  const h = makeHarness({ id: 1, pending_tender_file_name: '某招标文件.pdf' });
  const cleaned = h.api.cleanupLegacyPendingTenderState();
  assert.equal(cleaned, true);
  assert.equal(h.state.row.pending_tender_file_name, null);
  assert.equal(h.state.row.pending_tender_markdown_path, null);
});

test('cleanupLegacyPendingTenderState 没有遗留时只清孤儿并返回 false', () => {
  const h = makeHarness({ id: 1 });
  const orphan = path.join(h.technicalPlanDir, 'tender-pending-9.tmp.md');
  fs.writeFileSync(orphan, 'x');
  assert.equal(h.api.cleanupLegacyPendingTenderState(), false);
  assert.equal(fs.existsSync(orphan), false);
});

test('readTenderMarkdown 按元数据读取正文', () => {
  const empty = makeHarness({ id: 1 });
  assert.equal(empty.api.readTenderMarkdown(), '');
  const withFile = makeHarness({ id: 1, tender_markdown_path: 'technical-plan/tender.md' });
  fs.writeFileSync(withFile.tenderMarkdownPath, '招标正文');
  assert.equal(withFile.api.readTenderMarkdown(), '招标正文');
});
