const test = require('node:test');
const assert = require('node:assert/strict');

const { createTaskPersistence } = require('./taskPersistence.cjs');

function makeHarness() {
  const state = { runs: [], syncs: [], logs: ['当日志'], meta: {} };
  const db = { prepare: (sql) => ({ run: (params) => { state.runs.push({ sql, params }); }, get: () => null, all: () => [] }) };
  const taskLogStore = {
    sync: (...args) => state.syncs.push(args),
    list: () => state.logs,
  };
  const api = createTaskPersistence({
    db,
    taskLogStore,
    originalOutlineRuntimePath: '/tmp/runtime.json',
    updateMeta: (fields) => Object.assign(state.meta, fields),
    normalizeStatus: (value, allowed, fallback) => (allowed.includes(value) ? value : fallback),
    normalizeBidSectionExtractionStatus: (value) => (value === 'running' ? 'running' : 'idle'),
  });
  return { api, state };
}

test('createTaskPersistence 暴露任务与运行时接口', () => {
  const { api } = makeHarness();
  for (const n of ['saveTask','taskFromRow','readOriginalOutlineRuntime','saveOriginalOutlineRuntime','clearOriginalOutlineRuntime','loadReferenceDocumentIds','replaceReferenceDocumentIds']) {
    assert.equal(typeof api[n], 'function', 'missing ' + n);
  }
});

test('saveTask 归一化字段并同步任务日志', () => {
  const { api, state } = makeHarness();
  api.saveTask('outline', {
    task_id: 123,
    status: 'running',
    progress: 150,
    stats: { done: 1 },
    pause_requested: true,
    logs: ['a'],
  });
  const run = state.runs.find((item) => item.sql.includes('INSERT INTO technical_plan_tasks'));
  assert.ok(run);
  assert.equal(run.params.task_id, '123');
  assert.equal(run.params.progress, 100);
  assert.equal(run.params.pause_requested, 1);
  assert.equal(run.params.stats_json, '{"done":1}');
  assert.equal(run.params.error, null);
  assert.equal(state.syncs.length, 1);
  assert.equal(state.syncs[0][1], 'outline');
});

test('saveTask 对招标分节提取任务同步 meta 状态', () => {
  const { api, state } = makeHarness();
  api.saveTask('bid-section-extraction', { task_id: 't1', status: 'running', progress: 10 });
  assert.equal(state.meta.bid_section_extraction_status, 'running');
  assert.equal(state.meta.bid_section_extraction_error, null);
});

test('saveTask 传 null 时删除任务并复位 meta', () => {
  const { api, state } = makeHarness();
  api.saveTask('bid-section-extraction', null);
  const run = state.runs.find((item) => item.sql.includes('DELETE FROM technical_plan_tasks'));
  assert.ok(run);
  assert.equal(state.meta.bid_section_extraction_status, 'idle');
});

test('taskFromRow 还原任务对象并解析 stats 与暂停标记', () => {
  const { api, state } = makeHarness();
  const task = api.taskFromRow({
    task_id: 't1',
    type: 'outline',
    status: 'paused',
    progress: '30',
    started_at: 's',
    updated_at: 'u',
    error: '',
    stats_json: '{"a":1}',
    pause_requested: 1,
  });
  assert.equal(task.status, 'paused');
  assert.equal(task.progress, 30);
  assert.deepEqual(task.stats, { a: 1 });
  assert.equal(task.pause_requested, true);
  assert.deepEqual(task.logs, state.logs);
  assert.equal(task.error, undefined);
  assert.equal(api.taskFromRow(null), undefined);
});

test('taskFromRow 对非法状态回退到 running', () => {
  const { api } = makeHarness();
  assert.equal(api.taskFromRow({ task_id: 't', type: 'x', status: 'weird' }).status, 'running');
});
