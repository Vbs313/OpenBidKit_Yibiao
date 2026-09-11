const test = require('node:test');
const assert = require('node:assert/strict');

const { createSectionGenerationStage } = require('./sectionGeneration.cjs');
const { normalizeContentPlan } = require('./../normalize.cjs');
const { countContentWords } = require('./../aiCallContext.cjs');

const makePlan = () => normalizeContentPlan({}, new Set(), new Set());

function makeStage(overrides = {}) {
  const state = {
    leaves: [],
    sections: {},
    logs: [],
    tasksToRun: [],
    storedContentPlans: {},
    runLimits: { maxTablesForRun: null },
    maxTables: 3,
    knowledgeItems: [],
    allowedKnowledgeItemIds: new Set(),
    knowledgeContentMap: new Map(),
    saved: [],
    published: [],
    checkpoints: [],
    devLogs: [],
    pauses: [],
    completed: [],
    persisted: [],
  };
  const liveState = {
    get leaves() { return state.leaves; },
    get sections() { return state.sections; },
    set sections(value) { state.sections = value; },
    get logs() { return state.logs; },
    get tasksToRun() { return state.tasksToRun; },
    get storedContentPlans() { return state.storedContentPlans; },
    set storedContentPlans(value) { state.storedContentPlans = value; },
    get runLimits() { return state.runLimits; },
    get maxTables() { return state.maxTables; },
    get knowledgeItems() { return state.knowledgeItems; },
    get allowedKnowledgeItemIds() { return state.allowedKnowledgeItemIds; },
    get knowledgeContentMap() { return state.knowledgeContentMap; },
    appendLog: (message) => { state.logs.push(message); },
  };
  const contentPlans = new Map();
  const deps = {
    state: liveState,
    aiService: { chat: async () => '这是生成的正文内容' },
    contentStats: {},
    contentConcurrency: 1,
    contentPlans,
    wordControl: {},
    tableRequirement: 'none',
    targetItemId: '',
    regenerate: false,
    regenerateRequirement: '',
    resume: false,
    projectOverview: '项目概述',
    bidAnalysisFactsText: '解析结果',
    globalFactTitlesText: '事实标题',
    globalFactsMode: 'strict',
    globalFacts: [],
    storedPlan: {},
    retryItemIds: new Set(),
    simulatedFailureItemIds: new Set(),
    publishTaskUpdate: (partial) => { state.published.push(partial); },
    checkpointTask: (...args) => { state.checkpoints.push(args); },
    syncRuntime: (partial) => ({ ...partial }),
    statsSnapshot: () => ({ phase: 'generating' }),
    writeDeveloperLog: (event, payload) => { state.devLogs.push([event, payload]); },
    pauseIfRequested: (message) => { state.pauses.push(message); },
    isPauseRequested: () => false,
    continueAfterPromptCacheWarmup: () => {},
    rememberTouchedItem: () => {},
    saveSection: (item, patch, content) => {
      state.saved.push({ item, patch, content });
      state.sections = { ...state.sections, [item.id]: { ...(state.sections[item.id] || {}), ...patch, content } };
    },
    saveSectionAndContentPlan: (item, patch, content, planPatch) => {
      state.saved.push({ item, patch, content, planPatch });
      state.sections = { ...state.sections, [item.id]: { ...(state.sections[item.id] || {}), ...patch, content } };
    },
    markGenerationCompleted: (id) => { state.completed.push(id); },
    persistContentPlans: (targets) => { state.persisted.push(targets.map(({ item }) => item.id)); },
    getReusableStoredContentPlan: () => null,
    getContentPlanForItem: () => makePlan(),
    refreshRunLimits: (targets) => { state.runLimits = { ...state.runLimits, refreshed: targets.length }; },
    getContentPromptWarmupKey: () => 'k',
    formatContentPromptWarmupLabel: (key) => String(key),
    getOriginalMaterialRuntimeState: () => ({ originalMaterial: {}, needsOptimization: false, validRestored: false }),
    allowedFactTitles: new Set(),
    runContentAgentTask: async () => ({ agentResult: {}, outputContent: 'Agent 输出正文' }),
  };
  const merged = { ...deps, ...overrides };
  return { stage: createSectionGenerationStage(merged), state, contentPlans: merged.contentPlans, contentStats: merged.contentStats };
}

function seedSingle(state) {
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  state.sections = { a: { status: 'idle', content: '' } };
  state.tasksToRun = [{ item: { id: 'a', title: 'A' } }];
}

test('runOne 生成正文并落盘', async () => {
  const { stage, state, contentStats } = makeStage();
  seedSingle(state);
  await stage.runOne({ item: { id: 'a', title: 'A' } });
  assert.equal(state.sections.a.status, 'success');
  assert.ok(state.sections.a.content.includes('这是生成的正文内容'));
  assert.deepEqual(state.completed, ['a']);
  assert.ok(state.logs.some((m) => m.includes('开始生成：a A')));
  assert.ok(state.logs.some((m) => m.includes('生成完成：a A')));
  assert.ok(state.saved.length >= 2);
});

test('runOne 生成失败时标记 error 并记录原因', async () => {
  const { stage, state } = makeStage({ aiService: { chat: async () => { throw new Error('模型炸了'); } } });
  seedSingle(state);
  await stage.runOne({ item: { id: 'a', title: 'A' } });
  assert.equal(state.sections.a.status, 'error');
  assert.equal(state.sections.a.error, '模型炸了');
  assert.ok(state.logs.some((m) => m.includes('生成失败：a A，模型炸了')));
  assert.deepEqual(state.completed, ['a']);
});

test('runOne 命中模拟失败开关时按生成失败处理', async () => {
  const { stage, state } = makeStage({ simulatedFailureItemIds: new Set(['a']) });
  seedSingle(state);
  await stage.runOne({ item: { id: 'a', title: 'A' } });
  assert.equal(state.sections.a.status, 'error');
  assert.ok(state.sections.a.error.includes('模拟正文生成失败'));
});

test('runOne 对已还原正文走优化扩写并回写 original_material', async () => {
  const { stage, state } = makeStage({
    getOriginalMaterialRuntimeState: () => ({
      originalMaterial: { restored: true, optimized: false, source_ids: ['P1'] },
      needsOptimization: true,
      validRestored: true,
    }),
  });
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  state.sections = { a: { status: 'success', content: '已还原的正文内容' } };
  await stage.runOne({ item: { id: 'a', title: 'A' } });
  assert.ok(state.logs.some((m) => m.includes('开始基于原方案优化扩写：a A')));
  assert.ok(state.logs.some((m) => m.includes('原方案优化扩写完成：a A')));
  const withPlan = state.saved.find((entry) => entry.planPatch);
  assert.ok(withPlan);
  assert.equal(withPlan.planPatch.original_material.optimized, true);
});

test('planAll 复用历史编排时不再调用编排模型', async () => {
  const { stage, state, contentPlans, contentStats } = makeStage({
    getReusableStoredContentPlan: () => ({ plan: makePlan() }),
    aiService: { chat: async () => '正文', collectJsonResponse: async () => { throw new Error('不应编排'); } },
  });
  seedSingle(state);
  await stage.planAll();
  assert.equal(contentPlans.has('a'), true);
  assert.ok(state.logs.some((m) => m.includes('复用 1 个历史编排')));
  assert.equal(contentStats.phase, 'generating');
  assert.deepEqual(state.persisted, [['a']]);
});

test('planAll 有预热目标时先编排再进入生成', async () => {
  const { stage, state, contentStats } = makeStage({
    aiService: {
      chat: async () => '正文',
      collectJsonResponse: async () => makePlan(),
    },
  });
  seedSingle(state);
  await stage.planAll();
  assert.ok(state.logs.some((m) => m.includes('开始整体编排决策，共 1 个小节')));
  assert.ok(state.logs.some((m) => m.includes('开始正文编排预热：a A')));
  assert.equal(contentStats.phase, 'generating');
});

test('runContentTargetsWithWarmup 无目标时直接返回', async () => {
  const { stage, state } = makeStage();
  await stage.runContentTargetsWithWarmup([]);
  assert.equal(state.logs.length, 0);
});

test('runContentTargetsWithWarmup 分组预热后并发生成剩余小节', async () => {
  const { stage, state } = makeStage();
  state.leaves = [{ item: { id: 'a', title: 'A' } }, { item: { id: 'b', title: 'B' } }];
  state.sections = { a: { status: 'idle', content: '' }, b: { status: 'idle', content: '' } };
  const targets = [{ item: { id: 'a', title: 'A' } }, { item: { id: 'b', title: 'B' } }];
  await stage.runContentTargetsWithWarmup(targets);
  assert.ok(state.logs.some((m) => m.includes('开始正文生成预热')));
  assert.ok(state.logs.some((m) => m.includes('并发生成剩余 1 个小节')));
  assert.equal(state.sections.a.status, 'success');
  assert.equal(state.sections.b.status, 'success');
});

test('prepareSingleSectionPlan 复用本次任务已完成的编排', async () => {
  const { stage, state, contentPlans, contentStats } = makeStage({
    resume: true,
    storedPlan: { contentGenerationTask: { stats: { content: { planning_completed: 1 } } } },
    getReusableStoredContentPlan: () => ({ plan: makePlan() }),
    aiService: { chat: async () => '正文', collectJsonResponse: async () => { throw new Error('不应编排'); } },
  });
  seedSingle(state);
  await stage.prepareSingleSectionPlan();
  assert.equal(contentPlans.has('a'), true);
  assert.ok(state.logs.some((m) => m.includes('复用本次任务已完成的编排')));
  assert.equal(contentStats.phase, 'generating');
});
