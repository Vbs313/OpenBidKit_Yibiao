const test = require('node:test');
const assert = require('node:assert/strict');

const { createOriginalCoverageAuditStage } = require('./originalCoverageAudit.cjs');

const APPEND_PATCH = { operation: 'append', anchor: 'end', target_text: '', content: '补回来的来源段内容' };
const BAD_PATCH = { operation: 'replace', anchor: 'end', target_text: '这段原文不存在', content: '替换文本' };

function makeStage(overrides = {}) {
  const state = {
    leaves: [],
    sections: {},
    logs: [],
    originalPlanSegments: [],
    outlineData: { outline: [] },
    restoredById: null,
    sourceIds: [],
    saved: [],
    devLogs: [],
    published: [],
    checkpoints: [],
    pauses: [],
    warmups: [],
    touched: [],
  };
  const liveState = {
    get leaves() { return state.leaves; },
    get sections() { return state.sections; },
    get logs() { return state.logs; },
    get originalPlanSegments() { return state.originalPlanSegments; },
    get outlineData() { return state.outlineData; },
    appendLog: (message) => { state.logs.push(message); },
  };
  const deps = {
    state: liveState,
    aiService: { collectJsonResponse: async () => ({ items: [] }) },
    agentService: { runTask: async () => ({ success: true, output_content: '' }) },
    contentStats: {},
    contentConcurrency: 1,
    enableOriginalPlanCoverageAudit: true,
    isExpansionWorkflow: true,
    tableRequirement: 'none',
    targetItemId: '',
    publishTaskUpdate: (partial) => { state.published.push(partial); },
    checkpointTask: (...args) => { state.checkpoints.push(args); },
    syncRuntime: (partial) => ({ ...partial }),
    statsSnapshot: () => ({ phase: 'original-auditing' }),
    writeDeveloperLog: (event, payload) => { state.devLogs.push([event, payload]); },
    pauseIfRequested: (message) => { state.pauses.push(message); },
    isPauseRequested: () => false,
    continueAfterPromptCacheWarmup: (message) => { state.warmups.push(message); },
    rememberTouchedItem: (id) => { state.touched.push(id); },
    saveSection: (item, partial, content) => { state.saved.push({ item, partial, content }); },
    getOriginalMaterialRuntimeState: (item) => {
      if (!state.restoredById || !(item.id in state.restoredById)) {
        return { originalMaterial: { source_ids: [] }, content: '', validRestored: false, needsOptimization: false };
      }
      return {
        content: state.restoredById[item.id],
        originalMaterial: { source_ids: state.sourceIds },
        validRestored: true,
        needsOptimization: false,
      };
    },
    applyAgentConsistencySections: () => ({ changedCount: 0, skippedCount: 0, changedIds: [] }),
    runAgentTaskWithRecoveredOutput: async () => ({ success: true, output_content: '' }),
    createAgentActivityProgressHandler: () => () => {},
    isAgentBusyResult: () => false,
    agentErrorDiagnostics: (error) => ({ error: error?.message || '' }),
  };
  const merged = { ...deps, ...overrides };
  return { stage: createOriginalCoverageAuditStage(merged), state, contentStats: merged.contentStats };
}

// 让一个小节处于“已还原成功、无需优化、有来源段”的可审计状态。
function seedRestored(state, ids = ['a'], sourceIds = ['P001']) {
  state.originalPlanSegments = sourceIds.map((id) => ({ id, text: '来源段内容' }));
  state.leaves = ids.map((id) => ({ item: { id, title: id.toUpperCase(), description: '' } }));
  state.sections = Object.fromEntries(ids.map((id) => [id, { status: 'success', content: `正文-${id}` }]));
  state.outlineData = { outline: ids.map((id) => ({ id, title: id.toUpperCase(), children: [] })) };
  state.sourceIds = sourceIds;
  state.restoredById = Object.fromEntries(ids.map((id) => [id, `正文-${id}`]));
}

function makeAiService({ auditItems, patch } = {}) {
  return {
    collectJsonResponse: async ({ logTitle }) => {
      const title = String(logTitle || '');
      if (title.startsWith('原方案覆盖审计')) return { items: auditItems ?? [] };
      if (title.startsWith('原方案覆盖修复')) return patch ?? APPEND_PATCH;
      throw new Error('未预期的模型调用：' + title);
    },
  };
}

test('非扩写工作流不产生覆盖审计目标', () => {
  const { stage, state } = makeStage({ isExpansionWorkflow: false });
  seedRestored(state);
  assert.deepEqual(stage.buildOriginalCoverageAuditTargets(), []);
});

test('没有原方案来源段时不产生覆盖审计目标', () => {
  const { stage, state } = makeStage();
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  state.sections = { a: { status: 'success', content: '正文' } };
  assert.deepEqual(stage.buildOriginalCoverageAuditTargets(), []);
});

test('只保留已还原成功、无需优化且有来源段的小节', () => {
  const { stage, state } = makeStage();
  seedRestored(state, ['a', 'b', 'c', 'd']);
  state.sections.c.status = 'error';
  state.restoredById.b = '正文-b';
  const original = {
    a: { validRestored: true, needsOptimization: false },
    b: { validRestored: true, needsOptimization: true },
    c: { validRestored: true, needsOptimization: false },
    d: { validRestored: false, needsOptimization: false },
  };
  const scoped = makeStage({
    getOriginalMaterialRuntimeState: (item) => ({
      content: `正文-${item.id}`,
      originalMaterial: { source_ids: ['P001'] },
      validRestored: !!original[item.id]?.validRestored,
      needsOptimization: !!original[item.id]?.needsOptimization,
    }),
  });
  Object.assign(scoped.state, {
    originalPlanSegments: state.originalPlanSegments,
    leaves: state.leaves,
    sections: state.sections,
    outlineData: state.outlineData,
  });
  const targets = scoped.stage.buildOriginalCoverageAuditTargets();
  assert.deepEqual(targets.map((target) => target.item.id), ['a']);
  assert.deepEqual(targets[0].sources.map((segment) => segment.id), ['P001']);
});

test('非扩写工作流整体跳过覆盖审计', async () => {
  const { stage, state } = makeStage({ isExpansionWorkflow: false });
  const result = await stage.runOriginalPlanCoverageAuditIfEnabled();
  assert.deepEqual(result, { ran: false, fixedCount: 0, failedCount: 0 });
  assert.equal(state.logs.length, 0);
});

test('未启用原方案覆盖审计时跳过并记录原因', async () => {
  const { stage, state } = makeStage({ enableOriginalPlanCoverageAudit: false });
  const result = await stage.runOriginalPlanCoverageAuditIfEnabled();
  assert.deepEqual(result, { ran: false, fixedCount: 0, failedCount: 0 });
  assert.ok(state.logs.some((m) => m.includes('原方案覆盖审计未启用，跳过审计阶段。')));
  assert.equal(
    state.devLogs.filter(([event, payload]) => event === 'original_coverage.audit.skipped' && payload.reason === 'disabled').length,
    1,
  );
});

test('没有可审计小节时跳过', async () => {
  const { stage, state } = makeStage();
  state.originalPlanSegments = [{ id: 'P001' }];
  const result = await stage.runOriginalPlanCoverageAuditIfEnabled();
  assert.deepEqual(result, { ran: false, fixedCount: 0, failedCount: 0 });
  assert.ok(state.logs.some((m) => m.includes('没有可审计的已还原成功正文小节')));
});

test('审计发现缺口后补写并落盘', async () => {
  const { stage, state } = makeStage({ aiService: makeAiService({ auditItems: [{ source_id: 'P001', status: 'partial' }] }) });
  seedRestored(state);
  const result = await stage.runOriginalPlanCoverageAuditIfEnabled();
  assert.deepEqual(result, { ran: true, fixedCount: 1, failedCount: 0 });
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].item.id, 'a');
  assert.ok(state.saved[0].content.includes('补回来的来源段内容'));
  assert.deepEqual(state.touched, ['a']);
  assert.ok(state.logs.some((m) => m.includes('开始原方案覆盖审计：1 个已还原小节')));
  assert.ok(state.logs.some((m) => m.includes('原方案覆盖审计完成：a A，需补写 1 段，冲突 0 段。')));
  assert.ok(state.logs.some((m) => m.includes('原方案覆盖审计完成：发现 1 个需补写小节，成功修复 1 个，0 个需人工核对。')));
  assert.ok(state.devLogs.some(([event]) => event === 'original_coverage.repair.section.saved'));
  assert.ok(state.devLogs.some(([event]) => event === 'original_coverage.audit.done'));
});

test('只有冲突来源段时不做自动补写并留给后续阶段', async () => {
  const { stage, state } = makeStage({ aiService: makeAiService({ auditItems: [{ source_id: 'P001', status: 'conflict' }] }) });
  seedRestored(state);
  const result = await stage.runOriginalPlanCoverageAuditIfEnabled();
  assert.deepEqual(result, { ran: true, fixedCount: 0, failedCount: 0 });
  assert.equal(state.saved.length, 0);
  assert.ok(state.logs.some((m) => m.includes('原方案覆盖审计未发现需要自动补写的来源段')));
  assert.ok(state.logs.some((m) => m.includes('发现 1 个冲突来源段')));
});

test('覆盖审计把阶段进度写进 contentStats', async () => {
  const { stage, state, contentStats } = makeStage({
    aiService: makeAiService({ auditItems: [{ source_id: 'P001', status: 'partial' }] }),
  });
  seedRestored(state);
  await stage.runOriginalPlanCoverageAuditIfEnabled();
  assert.equal(contentStats.phase, 'original-auditing');
  assert.equal(contentStats.audit_step, 'done');
  assert.equal(contentStats.audit_repair_mode, 'normal');
  assert.equal(contentStats.audit_group_total, 1);
  assert.equal(contentStats.audit_group_completed, 1);
  assert.equal(contentStats.audit_conflict_total, 1);
  assert.equal(contentStats.audit_fix_total, 1);
  assert.equal(contentStats.audit_fix_completed, 1);
  assert.equal(contentStats.audit_fix_failed, 0);
});

test('补写无法应用时记人工核对并累计失败数', async () => {
  const { stage, state } = makeStage({
    aiService: makeAiService({ auditItems: [{ source_id: 'P001', status: 'missing' }], patch: BAD_PATCH }),
  });
  seedRestored(state);
  const result = await stage.runOriginalPlanCoverageAuditIfEnabled();
  assert.equal(result.fixedCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(state.saved.length, 0);
  assert.ok(state.logs.some((m) => m.includes('原方案覆盖修复需人工核对：a')));
});

test('审计小节普通错误被吞掉，暂停类错误向上抛', async () => {
  const plain = makeStage({ aiService: { collectJsonResponse: async () => { throw new Error('boom'); } } });
  seedRestored(plain.state);
  const result = await plain.stage.runOriginalPlanCoverageAuditIfEnabled();
  assert.deepEqual(result, { ran: true, fixedCount: 0, failedCount: 0 });
  assert.ok(plain.state.logs.some((m) => m.includes('原方案覆盖审计失败：a A')));
  assert.ok(plain.state.devLogs.some(([event]) => event === 'original_coverage.audit.section.error'));

  const paused = makeStage({
    aiService: {
      collectJsonResponse: async () => {
        const error = new Error('paused');
        error.code = 'CONTENT_GENERATION_PAUSED';
        throw error;
      },
    },
  });
  seedRestored(paused.state);
  await assert.rejects(() => paused.stage.runOriginalPlanCoverageAuditIfEnabled(), /paused/);
});

test('Agent 模式未启用时跳过', async () => {
  const { stage, state } = makeStage({ enableOriginalPlanCoverageAudit: false });
  const result = await stage.runAgentOriginalCoverageRepairIfEnabled();
  assert.deepEqual(result, { ran: false, fixedCount: 0, failedCount: 0 });
  assert.ok(state.logs.some((m) => m.includes('原方案覆盖审计未启用，跳过 Agent 覆盖修复阶段。')));
});

test('Agent 模式没有可修复小节时跳过', async () => {
  const { stage, state } = makeStage();
  state.originalPlanSegments = [{ id: 'P001' }];
  const result = await stage.runAgentOriginalCoverageRepairIfEnabled();
  assert.deepEqual(result, { ran: false, fixedCount: 0, failedCount: 0 });
  assert.ok(state.logs.some((m) => m.includes('没有可检查的已还原成功正文小节')));
});

test('Agent 服务不可用时记人工核对而不是抛错', async () => {
  const { stage, state } = makeStage({ agentService: {} });
  seedRestored(state);
  const result = await stage.runAgentOriginalCoverageRepairIfEnabled();
  assert.deepEqual(result, { ran: true, fixedCount: 0, failedCount: 1 });
  assert.ok(state.logs.some((m) => m.includes('Agent 服务尚未初始化')));
  assert.equal(state.saved.length, 0);
});

test('Agent 修复成功时按解析结果回写小节', async () => {
  const applied = [];
  const { stage, state } = makeStage({
    runAgentTaskWithRecoveredOutput: async () => ({
      success: true,
      task_id: 't1',
      session_id: 's1',
      output_content: '<!-- yibiao-section-start id="a" -->\n补回后的正文\n<!-- yibiao-section-end id="a" -->',
    }),
    applyAgentConsistencySections: (parsedSections, sectionIndex, writableIds) => {
      applied.push({ parsedSections, sectionIndex, writableIds });
      return { changedCount: 1, skippedCount: 0, changedIds: ['a'] };
    },
  });
  seedRestored(state);
  const result = await stage.runAgentOriginalCoverageRepairIfEnabled();
  assert.deepEqual(result, { ran: true, fixedCount: 1, failedCount: 0 });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].parsedSections.get('a'), '补回后的正文');
  assert.deepEqual([...applied[0].writableIds], ['a']);
  assert.ok(state.logs.some((m) => m.includes('原方案覆盖 Agent 修复完成：已回写 1 个小节（a）。')));
  assert.ok(state.devLogs.some(([event]) => event === 'original_coverage.agent.done'));
});

test('Agent 负载带上来源段说明与正文文件', async () => {
  let payload = null;
  const { stage, state } = makeStage({
    runAgentTaskWithRecoveredOutput: async (received) => {
      payload = received;
      return { success: true, output_content: '<!-- yibiao-section-start id="a" -->\n正文\n<!-- yibiao-section-end id="a" -->' };
    },
  });
  seedRestored(state);
  await stage.runAgentOriginalCoverageRepairIfEnabled();
  assert.ok(payload);
  assert.equal(payload.output_file, 'technical-plan.md');
  const byPath = new Map(payload.files.map((file) => [file.path, file.content]));
  assert.ok(byPath.get('original-coverage-sources.md').includes('# 原方案覆盖来源段'));
  assert.ok(byPath.get('original-coverage-sources.md').includes('P001'));
  assert.ok(byPath.get('technical-plan.md').includes('yibiao-section-start'));
  assert.ok(payload.prompt.includes('original-coverage-sources.md'));
});

test('Agent 忙碌时整段跳过且不覆盖正文', async () => {
  const { stage, state } = makeStage({
    runAgentTaskWithRecoveredOutput: async () => ({ status: 'busy', active_task: { id: 'x' } }),
    isAgentBusyResult: (result) => result?.status === 'busy',
  });
  seedRestored(state);
  const result = await stage.runAgentOriginalCoverageRepairIfEnabled();
  assert.deepEqual(result, { ran: false, fixedCount: 0, failedCount: 0, skipped: true, reason: 'busy' });
  assert.equal(state.saved.length, 0);
  assert.ok(state.logs.some((m) => m.includes('Agent 正在处理其他任务，本轮跳过原方案覆盖 Agent 修复。')));
  assert.ok(state.devLogs.some(([event]) => event === 'original_coverage.agent.busy'));
});

test('Agent 输出缺少小节时改为人工核对', async () => {
  const { stage, state } = makeStage({
    runAgentTaskWithRecoveredOutput: async () => ({ success: true, output_content: '没有任何小节标记' }),
  });
  seedRestored(state);
  const result = await stage.runAgentOriginalCoverageRepairIfEnabled();
  assert.equal(result.ran, true);
  assert.equal(result.fixedCount, 0);
  assert.equal(result.failedCount, 1);
  assert.ok(state.logs.some((m) => m.includes('原方案覆盖 Agent 修复失败')));
  assert.ok(state.devLogs.some(([event]) => event === 'original_coverage.agent.failed'));
});
