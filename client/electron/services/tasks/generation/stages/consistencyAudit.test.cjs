const test = require('node:test');
const assert = require('node:assert/strict');

const { createConsistencyAuditStage } = require('./consistencyAudit.cjs');

function makeStage(overrides = {}) {
  const state = {
    leaves: [],
    sections: {},
    logs: [],
    saved: [],
    devLogs: [],
    published: [],
    checkpoints: [],
    pauses: [],
    warmups: [],
  };
  // 与编排函数里的 ctx 门面同形：每次属性访问都取当前值，不缓存快照。
  const liveState = {
    get leaves() { return state.leaves; },
    get sections() { return state.sections; },
    get logs() { return state.logs; },
    appendLog: (message) => { state.logs.push(message); },
  };
  const deps = {
    state: liveState,
    aiService: { collectJsonResponse: async () => ({ conflicts: [] }) },
    contentStats: {},
    contentConcurrency: 2,
    globalFactsText: '',
    bidAnalysisFactsText: '',
    globalFactsMode: 'strict',
    tableRequirement: 'none',
    targetItemId: '',
    enableConsistencyAudit: true,
    publishTaskUpdate: (partial) => { state.published.push(partial); },
    checkpointTask: (...args) => { state.checkpoints.push(args); },
    syncRuntime: (partial) => ({ ...partial }),
    statsSnapshot: () => ({ phase: 'auditing' }),
    writeDeveloperLog: (event, payload) => { state.devLogs.push([event, payload]); },
    pauseIfRequested: (message) => { state.pauses.push(message); },
    isPauseRequested: () => false,
    continueAfterPromptCacheWarmup: (message) => { state.warmups.push(message); },
    rememberTouchedItem: () => {},
    saveSection: (item, partial, content) => { state.saved.push({ item, partial, content }); },
    getLeafWordCount: () => 100,
  };
  return { stage: createConsistencyAuditStage({ ...deps, ...overrides }), state, deps };
}

function makeAiService({ audit, repair } = {}) {
  return {
    collectJsonResponse: async ({ logTitle }) => {
      if (String(logTitle).startsWith('一致性审计')) return audit ?? { conflicts: [] };
      if (String(logTitle).startsWith('一致性修复')) return repair ?? { patches: [] };
      throw new Error('未预期的模型调用：' + logTitle);
    },
  };
}

function seedTargets(state, contents = { a: '这里写着预算金额为一百万元。' }) {
  state.leaves = Object.keys(contents).map((id) => ({ item: { id, title: id.toUpperCase(), description: '' } }));
  state.sections = Object.fromEntries(Object.entries(contents).map(([id, content]) => [id, { status: 'success', content }]));
}

const CONFLICT = [{ section_id: 'a', fact_title: '预算金额', evidence: '一百万元', reason: '与甲方事实不符', severity: 'high' }];
const PATCH = [{ section_id: 'a', start_line: 0, end_line: 0, old_text: '一百万元', new_text: '两百万元', reason: '对齐事实' }];

test('未启用一致性审计时直接跳过并说明原因', async () => {
  const { stage, state } = makeStage({ enableConsistencyAudit: false });
  seedTargets(state);
  const result = await stage.runConsistencyAuditIfEnabled();
  assert.deepEqual(result, { ran: false, fixedCount: 0, failedCount: 0 });
  assert.ok(state.logs.some((m) => m.includes('全文一致性审计未启用，跳过审计阶段')));
  assert.equal(state.devLogs.filter(([event]) => event === 'consistency.audit.skipped').length, 1);
  assert.equal(state.checkpoints.length, 0);
});

test('没有可审计的成功正文小节时跳过', async () => {
  const { stage, state } = makeStage();
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  state.sections = { a: { status: 'error', content: '失败的正文' } };
  const result = await stage.runConsistencyAuditIfEnabled();
  assert.deepEqual(result, { ran: false, fixedCount: 0, failedCount: 0 });
  assert.ok(state.logs.some((m) => m.includes('没有可审计的成功正文小节')));
});

test('审计发现冲突后应用局部替换并落盘', async () => {
  const { stage, state, deps } = makeStage({ aiService: makeAiService({ audit: { conflicts: CONFLICT }, repair: { patches: PATCH } }) });
  seedTargets(state);
  const result = await stage.runConsistencyAuditIfEnabled();
  assert.deepEqual(result, { ran: true, fixedCount: 1, failedCount: 0 });
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].item.id, 'a');
  assert.equal(state.saved[0].content, '这里写着预算金额为两百万元。');
  assert.equal(state.saved[0].partial.status, 'success');
  assert.ok(state.logs.some((m) => m.includes('开始全文一致性审计')));
  assert.ok(state.logs.some((m) => m.includes('一致性修复完成：a')));
  assert.ok(state.logs.some((m) => m.includes('成功修复 1 个')));
  assert.equal(deps.contentStats.phase, 'auditing');
  assert.equal(deps.contentStats.audit_group_total, 1);
  assert.equal(deps.contentStats.audit_fix_total, 1);
  assert.equal(deps.contentStats.audit_fix_failed, 0);
  assert.equal(deps.contentStats.audit_step, 'done');
  assert.equal(state.checkpoints.length, 1);
  assert.ok(state.devLogs.some(([event]) => event === 'consistency.audit.start'));
  assert.ok(state.devLogs.some(([event]) => event === 'consistency.repair.section.saved'));
  assert.ok(state.devLogs.some(([event]) => event === 'consistency.audit.done'));
});

test('没有冲突时不进入修复并记为完成', async () => {
  const { stage, state, deps } = makeStage({ aiService: makeAiService({ audit: { conflicts: [] } }) });
  seedTargets(state);
  const result = await stage.runConsistencyAuditIfEnabled();
  assert.deepEqual(result, { ran: true, fixedCount: 0, failedCount: 0 });
  assert.equal(state.saved.length, 0);
  assert.ok(state.logs.some((m) => m.includes('未发现需要修复的事实冲突')));
  assert.equal(deps.contentStats.audit_fix_total, 0);
});

test('只审计指定小节，忽略其它小节', async () => {
  const { stage, state } = makeStage({ aiService: makeAiService({ audit: { conflicts: CONFLICT }, repair: { patches: PATCH } }) });
  seedTargets(state, { a: '这里写着预算金额为一百万元。', b: '这里也写着预算金额为一百万元。' });
  const result = await stage.runConsistencyAuditIfEnabled({ targetItemId: 'a' });
  assert.equal(result.fixedCount, 1);
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].item.id, 'a');
  assert.equal(state.sections.b.content, '这里也写着预算金额为一百万元。');
});

test('审计组普通错误被吞掉，暂停类错误向上抛', async () => {
  const plain = makeStage({
    aiService: { collectJsonResponse: async () => { throw new Error('boom'); } },
  });
  seedTargets(plain.state);
  const result = await plain.stage.runConsistencyAuditIfEnabled();
  assert.deepEqual(result, { ran: true, fixedCount: 0, failedCount: 0 });
  assert.ok(plain.state.logs.some((m) => m.includes('一致性审计失败：第 1/1 组')));
  assert.ok(plain.state.devLogs.some(([event]) => event === 'consistency.audit.group.error'));

  const paused = makeStage({
    aiService: {
      collectJsonResponse: async () => {
        const error = new Error('paused');
        error.code = 'CONTENT_GENERATION_PAUSED';
        throw error;
      },
    },
  });
  seedTargets(paused.state);
  await assert.rejects(() => paused.stage.runConsistencyAuditIfEnabled(), /paused/);
});

test('修复无法唯一匹配时记人工核对并累计失败数', async () => {
  const { stage, state, deps } = makeStage({
    aiService: makeAiService({
      audit: { conflicts: CONFLICT },
      repair: { patches: [{ section_id: 'a', start_line: 0, end_line: 0, old_text: '这段文字并不存在', new_text: '替换文本', reason: '' }] },
    }),
  });
  seedTargets(state);
  const result = await stage.runConsistencyAuditIfEnabled();
  assert.equal(result.fixedCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(state.saved.length, 0);
  assert.equal(deps.contentStats.audit_fix_failed, 1);
  assert.ok(state.logs.some((m) => m.includes('一致性修复需人工核对：a')));
});

test('buildConsistencyAuditTargets 只挑成功且非空的小节', () => {
  const { stage, state } = makeStage();
  state.leaves = [
    { item: { id: 'a', title: 'A' } },
    { item: { id: 'b', title: 'B' } },
    { item: { id: 'c', title: 'C' } },
  ];
  state.sections = {
    a: { status: 'success', content: '有正文' },
    b: { status: 'success', content: '   ' },
    c: { status: 'error', content: '有正文' },
  };
  const targets = stage.buildConsistencyAuditTargets();
  assert.deepEqual(targets.map(({ item }) => item.id), ['a']);
  assert.equal(targets[0].words, 100);
});
