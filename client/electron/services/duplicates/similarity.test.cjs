const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('./similarity.cjs');

test('intersectSize 统计集合交集大小', () => {
  assert.equal(S.intersectSize(new Set(['a', 'b']), new Set(['b', 'c'])), 1);
  assert.equal(S.intersectSize(new Set(), new Set(['a'])), 0);
});

test('lcsSimilarity 最长公共子序列占比', () => {
  assert.equal(S.lcsSimilarity('abc', 'abc'), 1);
  assert.equal(S.lcsSimilarity('', 'x'), 0);
  assert.equal(S.lcsSimilarity('abcd', 'abce'), 0.75);
  assert.equal(S.lcsSimilarity('abc', 'ab'), 2 / 3);
});

test('riskFromScore 按阈值分档（含边界）', () => {
  assert.equal(S.riskFromScore(0.8), 'high');
  assert.equal(S.riskFromScore(0.75), 'high');
  assert.equal(S.riskFromScore(0.6), 'medium');
  assert.equal(S.riskFromScore(0.55), 'medium');
  assert.equal(S.riskFromScore(0.4), 'low');
  assert.equal(S.riskFromScore(0.35), 'low');
  assert.equal(S.riskFromScore(0.34), 'none');
});

test('charBigramsFromLooseText 生成字符二元组', () => {
  assert.deepEqual([...S.charBigramsFromLooseText('abc')], ['ab', 'bc']);
  assert.deepEqual([...S.charBigramsFromLooseText('a')], ['a']);
  assert.equal(S.charBigramsFromLooseText('').size, 0);
});

test('diceSimilarityFromShared 计算 Dice 系数并避免除零', () => {
  assert.equal(S.diceSimilarityFromShared(1, 2, 2), 0.5);
  assert.equal(S.diceSimilarityFromShared(0, 0, 0), 0);
  assert.equal(S.diceSimilarityFromShared(3, 3, 3), 1);
});
