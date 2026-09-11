const test = require('node:test');
const assert = require('node:assert/strict');

const { createOriginalMaterialRestoreStage } = require('./originalMaterialRestore.cjs');
const { createOriginalMaterialState } = require('./../originalMaterialState.cjs');

function makeStage(overrides = {}) {
  const state = {
    leaves: [],
    sections: {},
    logs: [],
    originalPlanSegments: [],
    allowedKnowledgeItemIds: new Set(),
    saved: [],
    published: [],
    checkpoints: [],
    devLogs: [],
    pauses: [],
  };
  const liveState = {
    get leaves() { return state.leaves; },
    get sections() { return state.sections; },
    set sections(value) { state.sections = value; },
    get logs() { return state.logs; },
    get originalPlanSegments() { return state.originalPlanSegments; },
    get allowedKnowledgeItemIds() { return state.allowedKnowledgeItemIds; },
    appendLog: (message) => { state.logs.push(message); },
  };
  const contentPlans = new Map();
  const originalPlanSegmentById = new Map();
  const shared = { state: liveState, contentPlans, originalPlanSegmentById, allowedFactTitles: new Set(), getStoredContentPlan: () => undefined };
  const mod = createOriginalMaterialState(shared);
  const deps = {
    state: liveState,
    aiService: { collectJsonResponse: async () => ({ assignments: [] }) },
    contentStats: {},
    originalPlanSegmentById,
    projectOverview: '项目概述',
    bidAnalysisFactsText: '解析结果',
    globalFactTitlesText: '事实标题',
    isExpansionWorkflow: true,
    targetItemId: '',
    regenerate: false,
    publishTaskUpdate: (partial) => { state.published.push(partial); },
    checkpointTask: (...args) => { state.checkpoints.push(args); },
    syncRuntime: (partial) => ({ ...partial }),
    statsSnapshot: () => ({ phase: 'restoring' }),
    writeDeveloperLog: (event, payload) => { state.devLogs.push([event, payload]); },
    pauseIfRequested: (message) => { state.pauses.push(message); },
    getOriginalMaterialRuntimeState: mod.getOriginalMaterialRuntimeState,
    buildOriginalMaterialFromSegments: mod.buildOriginalMaterialFromSegments,
    getContentPlanForItem: () => ({}),
    saveSectionAndContentPlan: (item, sectionPatch, content, planPatch) => {
      state.saved.push({ item, sectionPatch, content, planPatch });
      state.sections = { ...state.sections, [item.id]: { ...(state.sections[item.id] || {}), ...sectionPatch } };
    },
    runContentAgentTask: async () => ({ agentResult: {}, outputContent: '{}' }),
  };
  const merged = { ...deps, ...overrides };
  return {
    stage: createOriginalMaterialRestoreStage(merged),
    state,
    contentStats: merged.contentStats,
    contentPlans: merged.contentPlans || contentPlans,
    segments: merged.originalPlanSegmentById,
  };
}

function seedSegment(state, segments, id = 'P1', content = '原方案原文') {
  state.originalPlanSegments = [{ id, content, title_path: ['章节'], hash: 'h-' + id }];
  segments.set(id, state.originalPlanSegments[0]);
}

function seedRestoredPlan(plans, itemId, sourceIds) {
  plans.set(itemId, { original_material: { restored: true, optimized: false, source_ids: sourceIds } });
}

test('非扩写工作流直接跳过原方案还原', async () => {
  const { stage, state, segments } = makeStage({ isExpansionWorkflow: false });
  seedSegment(state, segments, 'P1');
  await stage.restoreOriginalMaterialsIfNeeded([{ item: { id: 'a' } }]);
  assert.equal(state.logs.length, 0);
  assert.equal(state.saved.length, 0);
});

test('没有待还原小节时直接返回', async () => {
  const { stage, state } = makeStage();
  await stage.restoreOriginalMaterialsIfNeeded([]);
  assert.equal(state.logs.length, 0);
});

test('全部小节已完成还原时跳过还原阶段', async () => {
  const { stage, state, contentPlans, segments } = makeStage();
  seedSegment(state, segments, 'P1');
  seedRestoredPlan(contentPlans, 'a', ['P1']);
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  state.sections = { a: { status: 'success', content: '已还原正文' } };
  await stage.restoreOriginalMaterialsIfNeeded([{ item: { id: 'a', title: 'A' } }]);
  assert.ok(state.logs.some((m) => m.includes('当前待生成小节均已完成还原，跳过还原阶段')));
  assert.equal(state.saved.length, 0);
});

test('可直接重建原文的小节不调用模型', async () => {
  const { stage, state, contentPlans, segments } = makeStage({
    aiService: { collectJsonResponse: async () => { throw new Error('不应调用模型'); } },
  });
  seedSegment(state, segments, 'P1', '原方案原文');
  seedRestoredPlan(contentPlans, 'a', ['P1']);
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  state.sections = { a: { status: 'idle', content: '' } };
  await stage.restoreOriginalMaterialsIfNeeded([{ item: { id: 'a', title: 'A' } }]);
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].sectionPatch.status, 'idle');
  assert.equal(state.saved[0].content, '原方案原文');
  assert.equal(state.saved[0].planPatch.original_material.restored, true);
  assert.ok(state.logs.some((m) => m.includes('可直接重建原文')));
});

test('未还原的小节走模型映射并落盘', async () => {
  const { stage, state, segments } = makeStage({
    aiService: { collectJsonResponse: async () => ({ assignments: [{ node_id: 'a', source_ids: ['P1'] }] }) },
  });
  seedSegment(state, segments, 'P1', '原方案原文');
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  state.sections = { a: { status: 'idle', content: '' } };
  await stage.restoreOriginalMaterialsIfNeeded([{ item: { id: 'a', title: 'A' } }]);
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].content, '原方案原文');
  assert.equal(state.saved[0].planPatch.original_material.source_ids[0], 'P1');
  assert.ok(state.logs.some((m) => m.includes('开始原方案还原：1 个原文段')));
  assert.ok(state.logs.some((m) => m.includes('原方案还原完成：已还原 1 个小节，未分配原文段 0 个。')));
  assert.ok(state.checkpoints.length >= 1);
});

test('还原完成后把阶段推进到 generating', async () => {
  const { stage, state, contentStats, segments } = makeStage({
    aiService: { collectJsonResponse: async () => ({ assignments: [{ node_id: 'a', source_ids: ['P1'] }] }) },
  });
  seedSegment(state, segments, 'P1');
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  state.sections = { a: { status: 'idle', content: '' } };
  await stage.restoreOriginalMaterialsIfNeeded([{ item: { id: 'a', title: 'A' } }]);
  assert.equal(contentStats.phase, 'generating');
  assert.equal(contentStats.restoration_total, 1);
  assert.equal(contentStats.restoration_completed, 1);
});
