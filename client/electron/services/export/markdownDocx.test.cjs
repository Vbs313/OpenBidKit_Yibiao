const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('./markdownDocx.cjs');

test('normalizeColumnSpan 只接受大于 1 的整数跨度', () => {
  assert.equal(M.normalizeColumnSpan('3'), 3);
  assert.equal(M.normalizeColumnSpan(2.9), 2);
  assert.equal(M.normalizeColumnSpan('0'), 1);
  assert.equal(M.normalizeColumnSpan('abc'), 1);
  assert.equal(M.normalizeColumnSpan(null), 1);
});

test('isMarkdownTableRowLine 要求首尾竖线', () => {
  assert.equal(M.isMarkdownTableRowLine('| a | b |'), true);
  assert.equal(M.isMarkdownTableRowLine('  | a |  '), true);
  assert.equal(M.isMarkdownTableRowLine('a | b'), false);
});

test('isMarkdownTableDelimiterLine 至少两列才算分隔行', () => {
  assert.equal(M.isMarkdownTableDelimiterLine('| --- | --- |'), true);
  assert.equal(M.isMarkdownTableDelimiterLine('--- | ---'), true);
  assert.equal(M.isMarkdownTableDelimiterLine('| --- |'), false);
});

test('isMarkdownTableDelimiterCell 认对齐冒号但不认短横线', () => {
  assert.equal(M.isMarkdownTableDelimiterCell('---'), true);
  assert.equal(M.isMarkdownTableDelimiterCell(':---:'), true);
  assert.equal(M.isMarkdownTableDelimiterCell('--'), false);
  assert.equal(M.isMarkdownTableDelimiterCell('---x'), false);
});

test('splitMarkdownTableCells 切列、保留转义竖线、无竖线返回空数组', () => {
  assert.deepEqual(M.splitMarkdownTableCells('| a | b |'), ['a', 'b']);
  assert.deepEqual(M.splitMarkdownTableCells('a | b'), ['a', 'b']);
  assert.deepEqual(M.splitMarkdownTableCells('| a \\| b | c |'), ['a \\| b', 'c']);
  assert.deepEqual(M.splitMarkdownTableCells('no pipe'), []);
});

test('formatMarkdownTableRow 重新拼行并保留缩进', () => {
  assert.equal(M.formatMarkdownTableRow(['a', 'b'], '  '), '  | a | b |');
  assert.equal(M.formatMarkdownTableRow(['a', null]), '| a |  |');
});

test('normalizeMarkdownListMarkersForDocx 把各种项目符号换成短横线', () => {
  assert.equal(M.normalizeMarkdownListMarkersForDocx('  \u2022 item\n- keep\n\t\u25cf two'), '  - item\n- keep\n\t- two');
  assert.equal(M.normalizeMarkdownListMarkersForDocx('普通段落'), '普通段落');
});
