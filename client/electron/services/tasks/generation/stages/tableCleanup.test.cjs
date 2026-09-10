const test = require('node:test');
const assert = require('node:assert/strict');

const { createTableCleanupStage } = require('./tableCleanup.cjs');

const TABLE = '| A | B |\n| --- | --- |\n| 1 | 2 |';

function makeStage(overrides = {}) {
  const state = {
    leaves: [],
    sections: {},
    logs: [],
    saved: [],
    devLogs: [],
    published: [],
    checkpoints: [],
  };
  const deps = {
    aiService: { collectJsonResponse: async () => ({ replacements: [] }) },
    contentStats: {},
    tableRequirement: 'none',
    targetItemId: '',
    getLeaves: () => state.leaves,
    getSections: () => state.sections,
    getLogs: () => state.logs,
    appendLog: (message) => { state.logs.push(message); },
    publishTaskUpdate: (partial) => { state.published.push(partial); },
    checkpointTask: (...args) => { state.checkpoints.push(args); },
    syncRuntime: (partial) => ({ ...partial }),
    statsSnapshot: () => ({}),
    writeDeveloperLog: (event, payload) => { state.devLogs.push([event, payload]); },
    pauseIfRequested: () => {},
    rememberTouchedItem: () => {},
    saveSection: (item, partial, content) => { state.saved.push({ item, partial, content }); },
  };
  return { stage: createTableCleanupStage({ ...deps, ...overrides }), state, deps };
}

test('表格需求不是“不要”时整个阶段直接跳过', async () => {
  const { stage, state } = makeStage({ tableRequirement: 'heavy' });
  const result = await stage.removeTablesBeforeIllustration();
  assert.deepEqual(result, { ran: false, rewrittenCount: 0, skippedCount: 0 });
  assert.equal(state.checkpoints.length, 0);
  assert.equal(state.logs.length, 0);
});

test('没有可转换的表格时给出提示并返回 ran', async () => {
  const { stage, state } = makeStage();
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  state.sections = { a: { status: 'success', content: '纯文字正文' } };
  const result = await stage.removeTablesBeforeIllustration();
  assert.deepEqual(result, { ran: true, rewrittenCount: 0, skippedCount: 0 });
  assert.equal(state.checkpoints.length, 1);
  assert.ok(state.logs.some((m) => m.includes('未发现需要转换的表格')));
  assert.equal(state.sections.a.content, '纯文字正文');
});

test('把表格改写成普通文字并落盘', async () => {
  const { stage, state } = makeStage({
    aiService: {
      collectJsonResponse: async () => ({ replacements: [{ table_id: 'T001', replacement_text: '这里改成普通文字描述' }] }),
    },
  });
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  state.sections = { a: { status: 'success', content: `前文\n\n${TABLE}\n\n后文` } };

  const result = await stage.removeTablesBeforeIllustration();
  assert.equal(result.ran, true);
  assert.equal(result.rewrittenCount, 1);
  assert.equal(result.skippedCount, 0);
  assert.equal(state.saved.length, 1);
  assert.ok(state.saved[0].content.includes('这里改成普通文字描述'));
  assert.ok(!state.saved[0].content.includes('| --- |'));
  assert.equal(state.saved[0].partial.status, 'success');
  assert.ok(state.logs.some((m) => m.includes('成功转换 1 个表格')));
  assert.ok(state.devLogs.some(([event]) => event === 'table_cleanup.start'));
  assert.ok(state.devLogs.some(([event]) => event === 'table_cleanup.apply.success'));
  assert.ok(state.devLogs.some(([event]) => event === 'table_cleanup.done'));
});

test('模型返回仍含表格的替换文本时跳过该条', async () => {
  const { stage, state } = makeStage({
    aiService: {
      collectJsonResponse: async () => ({ replacements: [{ table_id: 'T001', replacement_text: TABLE }] }),
    },
  });
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  state.sections = { a: { status: 'success', content: TABLE } };

  const result = await stage.removeTablesBeforeIllustration();
  assert.equal(result.rewrittenCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(state.saved.length, 0);
  assert.ok(state.devLogs.some(([event]) => event === 'table_cleanup.replacement.skipped'));
});

test('普通错误被吞掉并记日志，暂停类错误向上抛', async () => {
  const plain = makeStage({ aiService: { collectJsonResponse: async () => { throw new Error('boom'); } } });
  plain.state.leaves = [{ item: { id: 'a', title: 'A' } }];
  plain.state.sections = { a: { status: 'success', content: TABLE } };
  const result = await plain.stage.removeTablesBeforeIllustration();
  assert.equal(result.rewrittenCount, 0);
  assert.ok(plain.state.logs.some((m) => m.includes('正文去表格跳过')));
  assert.ok(plain.state.devLogs.some(([event]) => event === 'table_cleanup.batch.error'));

  const paused = makeStage({
    aiService: {
      collectJsonResponse: async () => {
        const error = new Error('paused');
        error.code = 'CONTENT_GENERATION_PAUSED';
        throw error;
      },
    },
  });
  paused.state.leaves = [{ item: { id: 'a', title: 'A' } }];
  paused.state.sections = { a: { status: 'success', content: TABLE } };
  await assert.rejects(() => paused.stage.removeTablesBeforeIllustration(), /paused/);
});

test('只处理指定小节并把统计写进 contentStats', async () => {
  const { stage, state, deps } = makeStage({
    aiService: {
      collectJsonResponse: async () => ({ replacements: [{ table_id: 'T001', replacement_text: '普通文字' }] }),
    },
  });
  state.leaves = [{ item: { id: 'a', title: 'A' } }, { item: { id: 'b', title: 'B' } }];
  state.sections = {
    a: { status: 'success', content: TABLE },
    b: { status: 'success', content: TABLE },
  };

  const result = await stage.removeTablesBeforeIllustration({ targetItemId: 'a' });
  assert.equal(result.rewrittenCount, 1);
  assert.equal(deps.contentStats.table_cleanup_total, 1);
  assert.equal(deps.contentStats.table_cleanup_rewritten, 1);
  assert.equal(deps.contentStats.table_cleanup_completed, 1);
  assert.equal(deps.contentStats.phase, 'table-cleaning');
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].item.id, 'a');
});

test('非成功状态的正文不进入去表格目标', async () => {
  const { stage, state } = makeStage();
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  state.sections = { a: { status: 'error', content: TABLE } };
  const result = await stage.removeTablesBeforeIllustration();
  assert.equal(result.rewrittenCount, 0);
  assert.ok(state.logs.some((m) => m.includes('未发现需要转换的表格')));
});