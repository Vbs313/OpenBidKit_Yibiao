const test = require('node:test');
const assert = require('node:assert/strict');

const { repairInvalidJsonStringEscapes } = require('./jsonRepair.cjs');

test('repairInvalidJsonStringEscapes 原样返回合法 JSON', () => {
  const valid = '{"a":"b","c":[1,2,{"d":"e"}]}';
  assert.equal(repairInvalidJsonStringEscapes(valid), valid);
});

test('repairInvalidJsonStringEscapes 保留合法转义', () => {
  const valid = JSON.stringify({ path: 'C:\\temp\\a.png', quote: '他说"好"', line: '第一行\n第二行', cn: '中' });
  const repaired = repairInvalidJsonStringEscapes(valid);
  assert.equal(repaired, valid);
  assert.equal(JSON.parse(repaired).quote, '他说"好"');
  assert.equal(JSON.parse(repaired).line, '第一行\n第二行');
});

test('repairInvalidJsonStringEscapes 把非法转义补成合法转义', () => {
  const broken = String.raw`{"a":"\q"}`;
  const repaired = repairInvalidJsonStringEscapes(broken);
  assert.doesNotThrow(() => JSON.parse(repaired));
  assert.equal(JSON.parse(repaired).a, '\\q');
});

test('repairInvalidJsonStringEscapes 去掉 Markdown 前多余的反斜杠', () => {
  const input = String.raw`{"title":"1\. 总体方案","note":"\(一\) 概述"}`;
  const repaired = repairInvalidJsonStringEscapes(input);
  assert.doesNotThrow(() => JSON.parse(repaired));
  assert.equal(JSON.parse(repaired).title, '1. 总体方案');
  assert.equal(JSON.parse(repaired).note, '(一) 概述');
});

test('repairInvalidJsonStringEscapes 容忍空串与普通文本', () => {
  assert.equal(repairInvalidJsonStringEscapes(''), '');
  assert.equal(repairInvalidJsonStringEscapes('纯文本'), '纯文本');
  assert.equal(repairInvalidJsonStringEscapes(null), '');
});
