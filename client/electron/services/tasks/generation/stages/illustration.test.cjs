const test = require('node:test');
const assert = require('node:assert/strict');

const { createIllustrationStage } = require('./illustration.cjs');
const { ILLUSTRATION_PLAN_VERSION } = require('./../../../contentIllustrationPlanning.cjs');

function makeStage(overrides = {}) {
  const state = {
    leaves: [],
    sections: {},
    logs: [],
    outlineData: { outline: [] },
    published: [],
    checkpoints: [],
    devLogs: [],
    pauses: [],
    rebuilds: 0,
  };
  const liveState = {
    get leaves() { return state.leaves; },
    get sections() { return state.sections; },
    set sections(value) { state.sections = value; },
    get logs() { return state.logs; },
    get outlineData() { return state.outlineData; },
    set outlineData(value) { state.outlineData = value; },
    appendLog: (message) => { state.logs.push(message); },
  };
  const deps = {
    state: liveState,
    aiService: {},
    workspaceStore: { clearIllustrationFiles: () => {}, clearUnreferencedGeneratedImages: () => {} },
    generationOptions: { useAiImages: false, useMermaidImages: false, useHtmlImages: false },
    contentStats: {},
    contentConcurrency: 2,
    imageConcurrency: 1,
    publishTaskUpdate: (partial) => { state.published.push(partial); },
    checkpointTask: (...args) => { state.checkpoints.push(args); },
    syncRuntime: (partial) => ({ ...partial }),
    statsSnapshot: () => ({ phase: 'illustration' }),
    writeDeveloperLog: (event, payload) => { state.devLogs.push([event, payload]); },
    pauseIfRequested: (message) => { state.pauses.push(message); },
    isPauseRequested: () => false,
    rebuildContentWordCounts: () => { state.rebuilds += 1; },
    runContentAgentTask: async () => ({ agentResult: { task_id: 't1', session_id: 's1' }, outputContent: '{"items":[]}' }),
  };
  const merged = { ...deps, ...overrides };
  return { stage: createIllustrationStage(merged), state, contentStats: merged.contentStats };
}

function seedEligibleSection(state) {
  state.outlineData = { outline: [{ id: 'a', title: 'A', description: '', content_mode: 'ai-generate', children: [] }] };
  state.sections = { a: { status: 'success', content: '正文 A' } };
  state.leaves = [{ item: state.outlineData.outline[0] }];
}

test('图片计划版本不匹配时直接抛错', async () => {
  const { stage } = makeStage();
  await assert.rejects(() => stage.runIllustrationGeneration({ plan_version: 0, items: [] }), /图片计划版本无效/);
});

test('图片计划为空时跳过生成', async () => {
  const { stage, state } = makeStage();
  const plan = { plan_version: ILLUSTRATION_PLAN_VERSION, items: [] };
  const returned = await stage.runIllustrationGeneration(plan);
  assert.equal(returned, plan);
  assert.ok(state.logs.some((m) => m.includes('全文图片计划为空，跳过图片生成。')));
  assert.equal(state.checkpoints.length, 0);
});

test('生成失败时把小节标记为 error 并继续收尾', async () => {
  const { stage, state, contentStats } = makeStage();
  seedEligibleSection(state);
  const plan = {
    plan_version: ILLUSTRATION_PLAN_VERSION,
    items: [{
      item_id: 'img1',
      kind: 'ai',
      image_type: 'realistic_photo',
      title: '配图一',
      section_ids: ['a'],
      generation: { status: 'running' },
    }],
  };
  const returned = await stage.runIllustrationGeneration(plan);
  assert.equal(returned.items[0].generation.status, 'error');
  assert.ok(state.logs.some((m) => m.includes('开始生成图片：文本组 0 项')));
  assert.ok(state.logs.some((m) => m.includes('AI 配图失败：a')));
  assert.ok(state.logs.some((m) => m.includes('图片生成阶段完成。')));
  assert.equal(contentStats.phase, 'illustration-generating');
  assert.equal(contentStats.illustration_generation_total, 1);
  assert.equal(contentStats.illustration_generation_completed, 1);
});

test('生成阶段把上一次的 running 状态重置为 pending', async () => {
  const { stage, state } = makeStage({ isPauseRequested: () => true });
  seedEligibleSection(state);
  const plan = {
    plan_version: ILLUSTRATION_PLAN_VERSION,
    items: [{
      item_id: 'img1',
      kind: 'ai',
      image_type: 'realistic_photo',
      title: '配图一',
      section_ids: ['a'],
      generation: { status: 'running' },
    }],
  };
  const returned = await stage.runIllustrationGeneration(plan);
  assert.equal(returned.items[0].generation.status, 'pending');
  assert.equal(state.logs.some((m) => m.includes('AI 配图失败')), false);
});

test('没有可编排小节时产出空图片计划', async () => {
  const { stage, state, contentStats } = makeStage();
  const plan = await stage.runIllustrationPlanning();
  assert.equal(plan.plan_version, ILLUSTRATION_PLAN_VERSION);
  assert.deepEqual(plan.items, []);
  assert.ok(state.logs.some((m) => m.includes('没有可编排的成功正文小节，已生成空的全文图片计划。')));
  assert.ok(state.checkpoints.some(([, statePatch, planPatch]) => statePatch?.contentIllustrationPlan
    || planPatch?.technicalPlanPatch?.contentIllustrationPlan));
  assert.equal(contentStats.illustration_candidate_html, 0);
  assert.equal(contentStats.illustration_planning_step_completed, 3);
});

test('所有图片类型未启用时产出空图片计划', async () => {
  const { stage, state } = makeStage();
  seedEligibleSection(state);
  const plan = await stage.runIllustrationPlanning();
  assert.deepEqual(plan.items, []);
  assert.ok(state.logs.some((m) => m.includes('所有图片类型均未启用，已生成空的全文图片计划。')));
});

test('有可编排小节时走 Agent 编排并保存计划', async () => {
  const calls = [];
  const { stage, state, contentStats } = makeStage({
    aiService: { getImageModelAvailability: () => ({ available: true }) },
    generationOptions: { useAiImages: true, useMermaidImages: true, useHtmlImages: false },
    runContentAgentTask: async (payload) => {
      calls.push(payload);
      return { agentResult: { task_id: 't1', session_id: 's1' }, outputContent: '{"items":[]}' };
    },
  });
  seedEligibleSection(state);
  const plan = await stage.runIllustrationPlanning();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].outputFile, 'illustration-plan.json');
  assert.ok(calls[0].prompt.includes('图片'));
  assert.equal(plan.plan_version, ILLUSTRATION_PLAN_VERSION);
  assert.deepEqual(plan.items, []);
  assert.ok(state.logs.some((m) => m.includes('全文图片编排完成：候选 0 项')));
  assert.ok(state.devLogs.some(([event]) => event === 'illustration_planning.agent.done'));
  assert.equal(contentStats.illustration_planning_step_label, '全文图片编排完成');
});

test('图片编排会先清理旧配图并重算字数', async () => {
  const cleared = [];
  const { stage, state } = makeStage({
    workspaceStore: {
      clearIllustrationFiles: () => cleared.push('files'),
      clearUnreferencedGeneratedImages: () => cleared.push('images'),
    },
  });
  seedEligibleSection(state);
  await stage.runIllustrationPlanning();
  assert.deepEqual(cleared, ['files', 'images']);
  assert.ok(state.rebuilds >= 1);
  assert.ok(state.checkpoints.length >= 1);
});
