const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('./storedPlan.cjs');

const validPlan = () => ({ writing_focus: '重点', knowledge: { item_ids: [] }, facts: { titles: [] }, table: { needed: false } });
const wordControl = (over = {}) => ({ strictSectionWords: true, maximumWords: 100000, sectionMinimumWords: 1000, sectionWords: 3000, ...over });

test('computeGenerationWordTarget 只在强控且有余量时倒推目标', () => {
  assert.equal(S.computeGenerationWordTarget(wordControl({ strictSectionWords: false }), 25), 0);
  assert.equal(S.computeGenerationWordTarget(wordControl({ maximumWords: 0 }), 25), 0);
  assert.equal(S.computeGenerationWordTarget(wordControl(), 0), 0);
  assert.equal(S.computeGenerationWordTarget(wordControl(), 25), 3200);
  assert.equal(S.computeGenerationWordTarget(wordControl({ sectionMinimumWords: 5000 }), 25), 5000);
});

test('createStoredContentPlan 打上版本号与时间戳', () => {
  const stored = S.createStoredContentPlan(validPlan(), '');
  assert.equal(stored.plan_version, 4);
  assert.equal(stored.plan.writing_focus, '重点');
  assert.equal(typeof stored.updated_at, 'string');
  assert.ok(stored.updated_at.length > 0);
  assert.equal('table_requirement' in stored, false);

  const withTable = S.createStoredContentPlan(validPlan(), 'light');
  assert.equal(withTable.table_requirement, 'light');
});

test('normalizeStoredContentPlan 拒绝旧版本、缺事实选择与非法编排', () => {
  assert.equal(S.normalizeStoredContentPlan(null), null);
  assert.equal(S.normalizeStoredContentPlan(undefined), null);
  assert.equal(S.normalizeStoredContentPlan('x'), null);
  assert.equal(S.normalizeStoredContentPlan({ plan_version: 1, plan: validPlan() }), null);
  assert.equal(S.normalizeStoredContentPlan({ plan_version: 4, plan: { writing_focus: 'x' } }), null);
  assert.equal(S.normalizeStoredContentPlan({ plan_version: 4, facts: { titles: [] }, plan: { writing_focus: 'x' } }), null);
});

test('normalizeStoredContentPlan 通过校验时补齐版本与时间戳', () => {
  const created = S.createStoredContentPlan(validPlan(), 'light');
  const normalized = S.normalizeStoredContentPlan(created);
  assert.equal(normalized.plan_version, 4);
  assert.equal(normalized.table_requirement, 'light');
  assert.equal(normalized.updated_at, created.updated_at);
  assert.equal(normalized.plan.writing_focus, '重点');

  const withoutTime = S.normalizeStoredContentPlan({ plan_version: 4, facts: { titles: [] }, plan: validPlan() });
  assert.equal(withoutTime.plan_version, 4);
  assert.equal(typeof withoutTime.updated_at, 'string');
});

test('isStoredContentPlanReusableForTableRequirement 按表格需求决定能否复用', () => {
  assert.equal(S.isStoredContentPlanReusableForTableRequirement({ table_requirement: 'light' }, 'light'), true);
  assert.equal(S.isStoredContentPlanReusableForTableRequirement({ table_requirement: 'light' }, 'heavy'), false);
  assert.equal(S.isStoredContentPlanReusableForTableRequirement({}, 'none'), true);
  assert.equal(S.isStoredContentPlanReusableForTableRequirement({}, 'light'), false);
  assert.equal(S.isStoredContentPlanReusableForTableRequirement(null, 'none'), true);
  assert.equal(S.isStoredContentPlanReusableForTableRequirement(null, 'heavy'), false);
});

test('pruneContentGenerationPlans 丢掉非叶子与失效的存盘', () => {
  const good = S.createStoredContentPlan(validPlan(), 'light');
  const plans = { a: good, b: good, c: { plan_version: 1 } };
  const leaves = [{ item: { id: 'a' } }, { item: { id: 'c' } }];
  const pruned = S.pruneContentGenerationPlans(plans, leaves);
  assert.deepEqual(Object.keys(pruned), ['a']);
  assert.equal(pruned.a.plan_version, 4);
  assert.deepEqual(S.pruneContentGenerationPlans(null, leaves), {});
  assert.deepEqual(S.pruneContentGenerationPlans(plans, []), {});
});
test('countRetainedTablePlans 只数仍需要表格且未被排除的存盘', () => {
  const withTable = S.createStoredContentPlan({ writing_focus: 'x', knowledge: { item_ids: [] }, facts: { titles: [] }, table: { needed: true } }, 'light');
  const withoutTable = S.createStoredContentPlan({ writing_focus: 'x', knowledge: { item_ids: [] }, facts: { titles: [] }, table: { needed: false } }, 'light');
  const plans = { a: withTable, b: withTable, c: withoutTable, d: { plan_version: 1 } };
  assert.equal(S.countRetainedTablePlans(plans, new Set()), 2);
  assert.equal(S.countRetainedTablePlans(plans, new Set(['a'])), 1);
  assert.equal(S.countRetainedTablePlans(plans, new Set(['a', 'b'])), 0);
  assert.equal(S.countRetainedTablePlans(null, new Set()), 0);
});
