const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('./validators.cjs');

const validPlan = () => ({ writing_focus: '重点', knowledge: { item_ids: [] }, facts: { titles: [] }, table: { needed: false } });

test('validateContentPlan 逐字段校验编排决策', () => {
  assert.doesNotThrow(() => V.validateContentPlan(validPlan()));
  assert.throws(() => V.validateContentPlan(null), /必须是对象/);
  assert.throws(() => V.validateContentPlan({ ...validPlan(), knowledge: {} }), /knowledge\.item_ids/);
  assert.throws(() => V.validateContentPlan({ ...validPlan(), facts: { titles: 'x' } }), /facts\.titles/);
  assert.throws(() => V.validateContentPlan({ ...validPlan(), writing_focus: '   ' }), /writing_focus/);
  assert.throws(() => V.validateContentPlan({ ...validPlan(), table: { needed: 'yes' } }), /table\.needed/);
});

test('validateOriginalRestoreAssignments 要求 assignments 数组与有效项', () => {
  assert.doesNotThrow(() => V.validateOriginalRestoreAssignments({ assignments: [] }));
  assert.doesNotThrow(() => V.validateOriginalRestoreAssignments({ assignments: [{ node_id: 'n1', source_ids: [] }] }));
  assert.throws(() => V.validateOriginalRestoreAssignments({}), /assignments/);
  assert.throws(() => V.validateOriginalRestoreAssignments({ assignments: [{}] }), /node_id/);
});

test('validateContentExpansionPatch 校验操作类型与必填内容', () => {
  assert.doesNotThrow(() => V.validateContentExpansionPatch({ operation: 'insert', content: '新增' }));
  assert.doesNotThrow(() => V.validateContentExpansionPatch({ operation: 'replace', target_text: '旧文', content: '新文' }));
  assert.throws(() => V.validateContentExpansionPatch({ operation: 'delete', content: 'x' }), /operation 无效/);
  assert.throws(() => V.validateContentExpansionPatch({ operation: 'replace', content: 'x' }), /target_text/);
  assert.throws(() => V.validateContentExpansionPatch({ operation: 'insert', content: '   ' }), /content/);
});

test('validateConsistencyAuditResponse 要求 conflicts 数组', () => {
  assert.doesNotThrow(() => V.validateConsistencyAuditResponse({ conflicts: [] }));
  assert.throws(() => V.validateConsistencyAuditResponse({}), /conflicts/);
  assert.throws(() => V.validateConsistencyAuditResponse({ conflicts: 'x' }), /conflicts/);
});
