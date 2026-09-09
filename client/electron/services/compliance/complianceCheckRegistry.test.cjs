const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_COMPLIANCE_CHECKS,
  assertKnownChecks,
  listComplianceChecks,
  normalizeCheckIds,
  requiresModel,
} = require('./complianceCheckRegistry.cjs');

test('registry defaults cover every registered check and never return unknown ids', () => {
  const ids = listComplianceChecks().map((item) => item.check_id);
  assert.deepEqual(normalizeCheckIds([]), ids, '空输入应回落到全部已登记检查项');
  assert.deepEqual(normalizeCheckIds(['pricing_arithmetic', 'pricing_arithmetic', '', 'nope']), ['pricing_arithmetic']);
  assert.equal(normalizeCheckIds(undefined).length, DEFAULT_COMPLIANCE_CHECKS.length);
});

test('requires_model drives whether model_config must be prepared', () => {
  assert.equal(requiresModel(['pricing_arithmetic']), false);
  assert.equal(requiresModel(['pricing_arithmetic', 'cross_check']), true);
  assert.equal(listComplianceChecks().some((item) => item.requires_model === true), true);
});

test('unknown check ids fail loudly instead of silently dropping checks', () => {
  assert.doesNotThrow(() => assertKnownChecks(['deposit', 'validity']));
  assert.throws(() => assertKnownChecks(['']), { message: '没有可用的合规检查项' });
  assert.throws(
    () => assertKnownChecks(['pricing_arithmetic', 'ghost_check']),
    (error) => error.message.includes('ghost_check') && error.code === 'COMPLIANCE_UNKNOWN_CHECK',
  );
});
