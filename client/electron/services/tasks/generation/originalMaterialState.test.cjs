const test = require('node:test');
const assert = require('node:assert/strict');

const { createOriginalMaterialState } = require('./originalMaterialState.cjs');

function makeState(overrides = {}) {
  const state = {
    leaves: [],
    sections: {},
    allowedKnowledgeItemIds: new Set(),
  };
  const liveState = {
    get leaves() { return state.leaves; },
    get sections() { return state.sections; },
    get allowedKnowledgeItemIds() { return state.allowedKnowledgeItemIds; },
  };
  const deps = {
    state: liveState,
    contentPlans: new Map(),
    originalPlanSegmentById: new Map(),
    allowedFactTitles: new Set(),
    getStoredContentPlan: () => undefined,
  };
  const merged = { ...deps, ...overrides };
  return { api: createOriginalMaterialState(merged), state, contentPlans: merged.contentPlans, segments: merged.originalPlanSegmentById };
}

function seedSegment(state, segments, id = 'P1', content = '原方案原文') {
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  const segment = { id, content, title_path: ['章节'], hash: 'h-' + id };
  segments.set(id, segment);
  return segment;
}

test('已还原且有正文的小节标记为待优化', () => {
  const { api, state, contentPlans, segments } = makeState();
  seedSegment(state, segments, 'P1');
  contentPlans.set('a', { original_material: { restored: true, optimized: false, source_ids: ['P1'] } });
  state.sections = { a: { status: 'success', content: '已还原正文' } };
  const result = api.getOriginalMaterialRuntimeState({ id: 'a' });
  assert.equal(result.validRestored, true);
  assert.equal(result.needsOptimization, true);
  assert.equal(result.needsRestoreRepair, false);
  assert.equal(result.canRebuildRestoredContent, false);
  assert.equal(result.content, '已还原正文');
  assert.deepEqual(result.sourceSegments.map((segment) => segment.id), ['P1']);
});

test('已还原但正文为空的小节可直接重建', () => {
  const { api, state, contentPlans, segments } = makeState();
  seedSegment(state, segments, 'P1');
  contentPlans.set('a', { original_material: { restored: true, optimized: true, source_ids: ['P1'] } });
  state.sections = { a: { status: 'idle', content: '' } };
  const result = api.getOriginalMaterialRuntimeState('a');
  assert.equal(result.validRestored, false);
  assert.equal(result.canRebuildRestoredContent, true);
  // 已还原但正文为空：既可直接重建，也算“还原结果需要修复”。
  assert.equal(result.needsRestoreRepair, true);
});

test('来源段缺失时标记为需要修复还原', () => {
  const { api, state, contentPlans } = makeState();
  state.leaves = [{ item: { id: 'a', title: 'A' } }];
  contentPlans.set('a', { original_material: { restored: true, optimized: false, source_ids: ['P9'] } });
  state.sections = { a: { status: 'success', content: '正文' } };
  const result = api.getOriginalMaterialRuntimeState({ id: 'a' });
  assert.equal(result.validRestored, false);
  assert.equal(result.needsRestoreRepair, true);
  assert.equal(result.allSourcesValid, false);
});

test('没有原方案信息的小节返回空态', () => {
  const { api } = makeState();
  const result = api.getOriginalMaterialRuntimeState('zzz');
  assert.equal(result.validRestored, false);
  assert.equal(result.canRebuildRestoredContent, false);
  assert.deepEqual(result.originalMaterial.source_ids, []);
});

test('按 id 查找小节时使用 leaves 中的 item', () => {
  const { api, state } = makeState();
  state.leaves = [{ item: { id: 'a', title: 'A', content: '来自小节的内容' } }];
  const result = api.getOriginalMaterialRuntimeState('a');
  assert.equal(result.content, '来自小节的内容');
  assert.equal(result.hasContent, true);
});

test('buildOriginalMaterialFromSegments 汇总来源段元信息', () => {
  const { api } = makeState();
  const material = api.buildOriginalMaterialFromSegments([
    { id: 'P1', content: '原文一', title_path: ['一', '章'], hash: 'h1' },
    { id: 'P2', content: '原文二', title_path: ['二'], hash: 'h2' },
  ]);
  assert.equal(material.restored, true);
  assert.equal(material.optimized, false);
  assert.deepEqual(material.source_ids, ['P1', 'P2']);
  assert.deepEqual(material.source_titles, ['一 > 章', '二']);
  assert.deepEqual(material.source_hashes, ['h1', 'h2']);
  assert.equal(material.restored_chars, '原文一\n\n原文二'.length);
});

test('buildOriginalMaterialFromSegments 保留上次还原时间', () => {
  const { api } = makeState();
  const material = api.buildOriginalMaterialFromSegments([{ id: 'P1', content: 'x' }], { restored_at: '2020-01-01T00:00:00.000Z' });
  assert.equal(material.restored_at, '2020-01-01T00:00:00.000Z');
});
