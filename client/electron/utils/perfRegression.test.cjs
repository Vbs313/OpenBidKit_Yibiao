const test = require('node:test');
const assert = require('node:assert/strict');
const { detectRegressions, DEFAULT_REGRESSION_THRESHOLD } = require('./perfRegression.cjs');

test('detectRegressions p95 退化超阈值时标记回归', () => {
  const baseline = { 'ai.text.total': { p50: 100, p95: 200, count: 10 } };
  const current = { 'ai.text.total': { p50: 110, p95: 300, count: 10 } };
  const result = detectRegressions(baseline, current);
  assert.equal(result.regressions.length, 1);
  assert.equal(result.regressions[0].name, 'ai.text.total');
  assert.ok(result.regressions[0].delta_ratio > DEFAULT_REGRESSION_THRESHOLD);
});

test('detectRegressions p95 改进时标记改进', () => {
  const baseline = { 'ai.text.total': { p50: 100, p95: 300, count: 10 } };
  const current = { 'ai.text.total': { p50: 100, p95: 150, count: 10 } };
  const result = detectRegressions(baseline, current);
  assert.equal(result.regressions.length, 0);
  assert.equal(result.improvements.length, 1);
});

test('detectRegressions 变化在阈值内标记不变', () => {
  const baseline = { 'ai.text.total': { p50: 100, p95: 200, count: 10 } };
  const current = { 'ai.text.total': { p50: 100, p95: 210, count: 10 } };
  const result = detectRegressions(baseline, current);
  assert.equal(result.regressions.length, 0);
  assert.equal(result.improvements.length, 0);
  assert.equal(result.unchanged.length, 1);
});

test('detectRegressions 当前未触发的指标跳过', () => {
  const baseline = { 'ai.text.total': { p50: 100, p95: 200, count: 10 }, 'ai.image.total': { p50: 200, p95: 400, count: 5 } };
  const current = { 'ai.text.total': { p50: 100, p95: 210, count: 10 } };
  const result = detectRegressions(baseline, current);
  assert.equal(result.unchanged.length, 1);
  assert.equal(result.regressions.length, 0);
});

test('detectRegressions 自定义阈值生效', () => {
  const baseline = { 'x': { p50: 100, p95: 100, count: 10 } };
  const current = { 'x': { p50: 100, p95: 120, count: 10 } };
  const strict = detectRegressions(baseline, current, { threshold: 0.1 });
  const loose = detectRegressions(baseline, current, { threshold: 0.5 });
  assert.equal(strict.regressions.length, 1);
  assert.equal(loose.regressions.length, 0);
});

test('detectRegressions 空基线返回空结果', () => {
  const result = detectRegressions({}, {});
  assert.equal(result.regressions.length, 0);
  assert.equal(result.improvements.length, 0);
  assert.equal(result.unchanged.length, 0);
});
