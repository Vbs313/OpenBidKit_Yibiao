const test = require('node:test');
const assert = require('node:assert/strict');

const N = require('./tableAndNumbering.cjs');

const custom = (template, extra = {}) => ({ numbering_format: 'custom', numbering_template: template, ...extra });

test('formatOutlineNumber 非大纲编号样式返回空串', () => {
  assert.equal(N.formatOutlineNumber('1.2.3', null), '');
  assert.equal(N.formatOutlineNumber('1.2.3', { numbering_format: 'none' }), '');
  assert.equal(N.formatOutlineNumber('', { numbering_format: 'outline-decimal' }), '');
});

test('formatOutlineNumber 大纲十进制原样拼接', () => {
  assert.equal(N.formatOutlineNumber('2.3.1', { numbering_format: 'outline-decimal' }), '2.3.1');
});

test('formatOutlineNumber 自定义模板替换中文数字与序号占位符', () => {
  assert.equal(N.formatOutlineNumber('1.2.3', custom('{zh}、')), '三、');
  assert.equal(N.formatOutlineNumber('1.2.3', custom('{num}.')), '3.');
  assert.equal(N.formatOutlineNumber('1.2.3', custom('{full}')), '1.2.3');
  assert.equal(N.formatOutlineNumber('1.2.3', custom('{alpha})')), 'c)');
  assert.equal(N.formatOutlineNumber('1.2.3', custom('{ALPHA})')), 'C)');
  assert.equal(N.formatOutlineNumber('1.2.3', custom('{roman}.')), 'iii.');
  assert.equal(N.formatOutlineNumber('1.2.3', custom('{ROMAN}.')), 'III.');
  assert.equal(N.formatOutlineNumber('1.2.3', custom('{circled}')), '③');
});

test('formatOutlineNumber tail 占位符按层级取尾部', () => {
  assert.equal(N.formatOutlineNumber('1.2.3', custom('{tail}')), '3');
  assert.equal(N.formatOutlineNumber('1.2.3.4', custom('{tail}')), '3.4');
  assert.equal(N.formatOutlineNumber('1.2.3.4', custom('{tail2}')), '2.3.4');
  assert.equal(N.formatOutlineNumber('1.2.3.4', custom('{tail9}')), '');
});

test('expandCompressedMarkdownTableRows 把压行的分隔行与数据行拆开', () => {
  const lines = N.expandCompressedMarkdownTableRows('| 项目 | 说明 |', '| --- | --- | 甲 | 乙 |');
  assert.ok(Array.isArray(lines));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /\|\s*项目\s*\|\s*说明\s*\|/);
  assert.match(lines[1], /---/);
  assert.match(lines[2], /甲/);
  assert.match(lines[2], /乙/);
});

test('expandCompressedMarkdownTableRows 非压行场景返回 null', () => {
  assert.equal(N.expandCompressedMarkdownTableRows('不是表格', '| --- | --- | v |'), null);
  assert.equal(N.expandCompressedMarkdownTableRows('| A | B |', '| --- | --- |'), null);
  assert.equal(N.expandCompressedMarkdownTableRows('| A | B |', '| 1 | 2 | 3 |'), null);
  assert.equal(N.expandCompressedMarkdownTableRows('| A |', '| --- | x |'), null);
});
