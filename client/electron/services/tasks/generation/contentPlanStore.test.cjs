const test = require('node:test');
const assert = require('node:assert/strict');

const { createContentPlanStore } = require('./contentPlanStore.cjs');
const { normalizeContentPlan } = require('./normalize.cjs');
const { createStoredContentPlan } = require('./storedPlan.cjs');

const makePlan = (patch = {}) => normalizeContentPlan({ writing_focus: '重点', ...patch }, new Set(), new Set());

function makeStore(overrides = {}) {
  const state = {
    storedContentPlans: {},
    allowedKnowledgeItemIds: new Set(),
  };
  const liveState = {
    get storedContentPlans() { return state.storedContentPlans; },
    set storedContentPlans(value) { state.storedContentPlans = value; },
    get allowedKnowledgeItemIds() { return state.allowedKnowledgeItemIds; },
  };
  const deps = {
    state: liveState,
    contentPlans: new Map(),
    allowedFactTitles: new Set(),
    tableRequirement: 'none',
  };
  const merged = { ...deps, ...overrides };
  return { store: createContentPlanStore(merged), state, contentPlans: merged.contentPlans };
}

test('getStoredContentPlan 归一化有效历史编排', () => {
  const { store, state } = makeStore();
  state.storedContentPlans = { a: createStoredContentPlan(makePlan({ table: { needed: true, purpose: '对比表' } }), 'heavy') };
  const stored = store.getStoredContentPlan('a');
  assert.ok(stored);
  assert.equal(stored.plan.table.needed, true);
  assert.equal(stored.table_requirement, 'heavy');
});

test('getStoredContentPlan 对缺失或无效值返回 null', () => {
  const { store, state } = makeStore();
  assert.equal(store.getStoredContentPlan('missing'), null);
  state.storedContentPlans = { broken: { plan_version: 0 } };
  assert.equal(store.getStoredContentPlan('broken'), null);
});

test('表格要求为 none 时清掉编排里的表格', () => {
  const { store } = makeStore({ tableRequirement: 'none' });
  const cleared = store.applyCurrentTableRequirementToPlan(makePlan({ table: { needed: true, purpose: '对比表' } }));
  assert.equal(cleared.table.needed, false);
});

test('表格要求非 none 时保留编排里的表格', () => {
  const { store } = makeStore({ tableRequirement: 'heavy' });
  const kept = store.applyCurrentTableRequirementToPlan(makePlan({ table: { needed: true, purpose: '对比表' } }));
  assert.equal(kept.table.needed, true);
});

test('getReusableStoredContentPlan 在表格要求不一致时返回 null', () => {
  const { store, state } = makeStore({ tableRequirement: 'none' });
  state.storedContentPlans = { a: createStoredContentPlan(makePlan(), 'heavy') };
  assert.equal(store.getReusableStoredContentPlan('a'), null);
});

test('getReusableStoredContentPlan 命中时按当前表格要求重算', () => {
  const { store, state } = makeStore({ tableRequirement: 'heavy' });
  state.storedContentPlans = { a: createStoredContentPlan(makePlan({ table: { needed: true, purpose: '对比表' } }), 'heavy') };
  const reusable = store.getReusableStoredContentPlan('a');
  assert.ok(reusable);
  assert.equal(reusable.plan.table.needed, true);
});

test('getContentPlanForItem 优先使用本次任务缓存', () => {
  const { store, state, contentPlans } = makeStore();
  const cached = makePlan({ writing_focus: '缓存里的' });
  contentPlans.set('a', cached);
  state.storedContentPlans = { a: createStoredContentPlan(makePlan({ writing_focus: '历史里的' }), 'none') };
  assert.equal(store.getContentPlanForItem('a').writing_focus, '缓存里的');
});

test('getContentPlanForItem 回落到历史编排并写入缓存', () => {
  const { store, state, contentPlans } = makeStore();
  state.storedContentPlans = { a: createStoredContentPlan(makePlan({ writing_focus: '历史里的' }), 'none') };
  const plan = store.getContentPlanForItem('a');
  assert.equal(plan.writing_focus, '历史里的');
  assert.equal(contentPlans.get('a'), plan);
});

test('getContentPlanForItem 没有可用来源时给出空编排并缓存', () => {
  const { store, contentPlans } = makeStore();
  const plan = store.getContentPlanForItem('a');
  assert.equal(plan.table.needed, false);
  assert.deepEqual(plan.knowledge.item_ids, []);
  assert.equal(contentPlans.get('a'), plan);
});
