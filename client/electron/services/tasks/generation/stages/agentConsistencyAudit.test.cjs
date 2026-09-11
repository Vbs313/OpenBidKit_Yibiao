const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgentConsistencyAuditStage } = require('./agentConsistencyAudit.cjs');

function makeStage(overrides = {}) {
  const state = {
    leaves: [],
    sections: {},
    logs: [],
    outlineData: { outline: [] },
    agentTargets: [],
    published: [],
    checkpoints: [],
    devLogs: [],
    pauses: [],
  };
  const liveState = {
    get leaves() { return state.leaves; },
    get sections() { return state.sections; },
    get logs() { return state.logs; },
    get outlineData() { return state.outlineData; },
    appendLog: (message) => { state.logs.push(message); },
  };
  const deps = {
    state: liveState,
    agentService: { runTask: async () => ({ success: true, output_content: '' }) },
    contentStats: {},
    enableConsistencyAudit: true,
    globalFactsText: '',
    bidAnalysisFactsText: '',
    globalFactsMode: 'strict',
    targetItemId: '',
    publishTaskUpdate: (partial) => { state.published.push(partial); },
    checkpointTask: (...args) => { state.checkpoints.push(args); },
    syncRuntime: (partial) => ({ ...partial }),
    statsSnapshot: () => ({ phase: 'auditing' }),
    writeDeveloperLog: (event, payload) => { state.devLogs.push([event, payload]); },
    pauseIfRequested: (message) => { state.pauses.push(message); },
    isPauseRequested: () => false,
    buildConsistencyAuditTargets: () => state.agentTargets,
    applyAgentConsistencySections: () => ({ changedCount: 0, skippedCount: 0, changedIds: [] }),
    runAgentTaskWithRecoveredOutput: async () => ({ success: true, output_content: '' }),
    createAgentActivityProgressHandler: () => () => {},
    isAgentBusyResult: () => false,
    agentErrorDiagnostics: (error) => ({ error: error?.message || '' }),
  };
  const merged = { ...deps, ...overrides };
  return { stage: createAgentConsistencyAuditStage(merged), state, contentStats: merged.contentStats };
}

function seedTargets(state, ids = ['a']) {
  state.agentTargets = ids.map((id) => ({ item: { id, title: id.toUpperCase(), description: '' }, content: `正文-${id}` }));
  state.leaves = state.agentTargets.map(({ item }) => ({ item }));
  state.sections = Object.fromEntries(ids.map((id) => [id, { status: 'success', content: `正文-${id}` }]));
  state.outlineData = { outline: ids.map((id) => ({ id, title: id.toUpperCase(), children: [] })) };
}

const sectionMarkdown = (id, text) => `<!-- yibiao-section-start id="${id}" -->\n${text}\n<!-- yibiao-section-end id="${id}" -->`;

test('未启用一致性审计时跳过 Agent 修复', async () => {
  const { stage, state } = makeStage({ enableConsistencyAudit: false });
  seedTargets(state);
  const result = await stage.runAgentConsistencyRepairIfEnabled();
  assert.deepEqual(result, { ran: false, fixedCount: 0, failedCount: 0 });
  assert.ok(state.logs.some((m) => m.includes('全文一致性审计未启用，跳过 Agent 一致性修复阶段。')));
  assert.ok(state.devLogs.some(([event, payload]) => event === 'consistency.agent.skipped' && payload.reason === 'disabled'));
});

test('Agent 服务缺失时直接抛错（不静默降级）', async () => {
  const { stage, state } = makeStage({ agentService: {} });
  seedTargets(state);
  await assert.rejects(() => stage.runAgentConsistencyRepairIfEnabled(), /Agent 服务尚未初始化，无法执行 Agent 一致性修复/);
});

test('没有可审计小节时跳过', async () => {
  const { stage, state } = makeStage();
  const result = await stage.runAgentConsistencyRepairIfEnabled();
  assert.deepEqual(result, { ran: false, fixedCount: 0, failedCount: 0 });
  assert.ok(state.logs.some((m) => m.includes('Agent 一致性修复跳过：没有可审计的成功正文小节。')));
});

test('目标小节没有成功正文时跳过', async () => {
  const { stage, state } = makeStage();
  seedTargets(state, ['a']);
  const result = await stage.runAgentConsistencyRepairIfEnabled({ targetItemId: 'zzz' });
  assert.deepEqual(result, { ran: false, fixedCount: 0, failedCount: 0 });
  assert.ok(state.logs.some((m) => m.includes('Agent 一致性修复跳过：目标小节 zzz 当前没有成功正文。')));
});

test('Agent 修复成功后回写改动小节', async () => {
  const applied = [];
  const { stage, state, contentStats } = makeStage({
    runAgentTaskWithRecoveredOutput: async () => ({
      success: true,
      task_id: 't1',
      session_id: 's1',
      output_content: sectionMarkdown('a', '改后的正文'),
    }),
    applyAgentConsistencySections: (parsedSections, sectionIndex, writableIds) => {
      applied.push({ parsedSections, writableIds });
      return { changedCount: 1, skippedCount: 0, changedIds: ['a'] };
    },
  });
  seedTargets(state);
  const result = await stage.runAgentConsistencyRepairIfEnabled();
  assert.deepEqual(result, { ran: true, fixedCount: 1, failedCount: 0 });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].parsedSections.get('a'), '改后的正文');
  assert.deepEqual([...applied[0].writableIds], ['a']);
  assert.equal(contentStats.audit_agent_changed_sections, 1);
  assert.equal(contentStats.audit_step, 'agent');
  assert.equal(contentStats.audit_repair_mode, 'agent');
  assert.ok(state.logs.some((m) => m.includes('开始 Agent 全文一致性修复：共 1 个正文小节')));
  assert.ok(state.logs.some((m) => m.includes('Agent 一致性修复完成：已回写 1 个小节（a）。')));
  assert.ok(state.devLogs.some(([event]) => event === 'consistency.agent.done'));
});

test('只回写指定目标小节时把可写范围收窄', async () => {
  const applied = [];
  const { stage, state } = makeStage({
    runAgentTaskWithRecoveredOutput: async () => ({
      success: true,
      output_content: `${sectionMarkdown('a', '改后的 A')}\n${sectionMarkdown('b', '改后的 B')}`,
    }),
    applyAgentConsistencySections: (parsedSections, sectionIndex, writableIds) => {
      applied.push({ parsedSections, writableIds });
      return { changedCount: 1, skippedCount: 1, changedIds: ['a'] };
    },
  });
  seedTargets(state, ['a', 'b']);
  const result = await stage.runAgentConsistencyRepairIfEnabled({ targetItemId: 'a' });
  assert.equal(result.fixedCount, 1);
  assert.equal(applied[0].writableIds.size, 1);
  assert.equal(applied[0].writableIds.has('a'), true);
  assert.equal(applied[0].writableIds.has('b'), false);
  assert.ok(state.logs.some((m) => m.includes('仅回写目标小节 a')));
});

test('Agent 忙碌时跳过本轮修复', async () => {
  const { stage, state, contentStats } = makeStage({
    runAgentTaskWithRecoveredOutput: async () => ({ status: 'busy', active_task: { id: 'x' } }),
    isAgentBusyResult: (result) => result?.status === 'busy',
  });
  seedTargets(state);
  const result = await stage.runAgentConsistencyRepairIfEnabled();
  assert.deepEqual(result, { ran: false, fixedCount: 0, failedCount: 0, skipped: true, reason: 'busy' });
  assert.ok(state.logs.some((m) => m.includes('Agent 正在处理其他任务，本轮跳过 Agent 一致性修复。')));
  assert.equal(contentStats.audit_agent_changed_sections, 0);
  assert.equal(contentStats.audit_agent_failed_sections, 0);
});

test('Agent 输出非法时记录失败并向上抛', async () => {
  const { stage, state, contentStats } = makeStage({
    runAgentTaskWithRecoveredOutput: async () => ({ success: true, output_content: '没有小节标记' }),
  });
  seedTargets(state);
  await assert.rejects(() => stage.runAgentConsistencyRepairIfEnabled(), /缺少小节：a/);
  assert.equal(contentStats.audit_agent_failed_sections, 1);
  assert.ok(state.logs.some((m) => m.includes('Agent 一致性修复失败')));
  assert.ok(state.devLogs.some(([event]) => event === 'consistency.agent.failed'));
});

test('指定目标小节失败时只计一个小节', async () => {
  const { stage, state, contentStats } = makeStage({
    runAgentTaskWithRecoveredOutput: async () => ({ success: true, output_content: '没有小节标记' }),
  });
  seedTargets(state, ['a', 'b']);
  await assert.rejects(() => stage.runAgentConsistencyRepairIfEnabled({ targetItemId: 'a' }));
  assert.equal(contentStats.audit_agent_failed_sections, 1);
});

test('暂停类错误记暂停日志后仍向上抛', async () => {
  const { stage, state } = makeStage({
    runAgentTaskWithRecoveredOutput: async () => {
      const error = new Error('paused');
      error.code = 'CONTENT_GENERATION_PAUSED';
      throw error;
    },
  });
  seedTargets(state);
  await assert.rejects(() => stage.runAgentConsistencyRepairIfEnabled(), /paused/);
  assert.ok(state.logs.some((m) => m.includes('Agent 一致性修复已暂停：本轮 Agent 已取消并清理，继续后将重新执行。')));
  assert.ok(state.devLogs.some(([event]) => event === 'consistency.agent.paused'));
  assert.ok(state.pauses.some((m) => m.includes('Agent 全文一致性修复阶段暂停')));
});

test('Agent 输入文件包含全局事实与正文计划', async () => {
  let payload = null;
  const { stage, state } = makeStage({
    globalFactsText: '事实变量',
    bidAnalysisFactsText: '解析结果',
    runAgentTaskWithRecoveredOutput: async (received) => {
      payload = received;
      return { success: true, output_content: sectionMarkdown('a', '正文-a') };
    },
  });
  seedTargets(state);
  await stage.runAgentConsistencyRepairIfEnabled();
  assert.ok(payload);
  const byPath = new Map(payload.files.map((file) => [file.path, file.content]));
  assert.ok(byPath.get('global-facts.md').includes('事实变量'));
  assert.ok(byPath.get('global-facts.md').includes('解析结果'));
  assert.ok(byPath.get('technical-plan.md').includes('yibiao-section-start'));
  assert.equal(payload.output_file, 'technical-plan.md');
});
