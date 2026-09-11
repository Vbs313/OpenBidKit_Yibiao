const test = require('node:test');
const assert = require('node:assert/strict');

const J = require('./jsonResponse.cjs');

test('parseJsonContent 直接解析纯净 JSON', () => {
  assert.deepEqual(J.parseJsonContent('{"a":1}'), { a: 1 });
  assert.deepEqual(J.parseJsonContent('  \uFEFF{"a":[1,2]}  '), { a: [1, 2] });
});

test('parseJsonContent 解析代码块与夹带说明的输出', () => {
  assert.deepEqual(J.parseJsonContent('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(J.parseJsonContent('好的，结果如下：\n{"a":2}\n以上。'), { a: 2 });
});

test('parseJsonContent 修复非法转义后再解析', () => {
  const parsed = J.parseJsonContent(String.raw`{"title":"1\. 总体方案"}`);
  assert.equal(parsed.title, '1. 总体方案');
});

test('parseJsonContent 无法解析时抛错', () => {
  assert.throws(() => J.parseJsonContent(''), /无法解析 JSON|JSON/);
  assert.throws(() => J.parseJsonContent('完全不是 JSON'), /JSON/);
});

test('formatJsonIssues 区分语法错误与业务校验错误', () => {
  const syntax = J.formatJsonIssues(new SyntaxError('Unexpected token'));
  assert.equal(syntax.length, 1);
  assert.match(syntax[0], /^JSON 语法错误：/);
  assert.deepEqual(J.formatJsonIssues(new Error('缺少字段 items')), ['缺少字段 items']);
  assert.deepEqual(J.formatJsonIssues(null), ['字段校验失败']);
});

test('buildJsonRepairMessages 生成系统提示与上下文', () => {
  const messages = J.buildJsonRepairMessages('{"a":}', ['第 1 行多余逗号'], '章节计划');
  assert.equal(messages.length, 5);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /JSON 修复助手/);
  assert.equal(messages[1].content, '目标结果类型：章节计划');
  assert.match(messages[2].content, /1\. 第 1 行多余逗号/);
  assert.match(messages[3].content, /```json/);
  assert.deepEqual(J.buildJsonRepairMessages('{}', [], 'x').slice(2, 3)[0].content, '当前校验问题：\n');
});

test('buildJsonRepairMessages 截断过长的待修复内容', () => {
  const long = 'x'.repeat(70000);
  const messages = J.buildJsonRepairMessages(long, [], 't');
  assert.ok(messages[3].content.length < 70000);
  assert.ok(messages[3].content.includes('x'.repeat(60000)));
});

test('emitProgress 无回调时静默返回，有回调时等待其完成', async () => {
  await assert.doesNotReject(() => J.emitProgress(null, '消息'));
  const seen = [];
  await J.emitProgress(async (message) => { seen.push(message); }, '校验失败，正在修复');
  assert.deepEqual(seen, ['校验失败，正在修复']);
});

test('normalizeJsonPayload 依次应用 normalizer 与 validator', () => {
  const calls = [];
  const result = J.normalizeJsonPayload({
    normalizer: (value) => { calls.push('normalize'); return { ...value, extra: true }; },
    validator: (value) => { calls.push('validate'); assert.equal(value.extra, true); },
  }, { a: 1 });
  assert.deepEqual(result, { a: 1, extra: true });
  assert.deepEqual(calls, ['normalize', 'validate']);
});

test('normalizeJsonPayload 透传校验异常', () => {
  assert.throws(() => J.normalizeJsonPayload({ validator: () => { throw new Error('字段缺失'); } }, {}), /字段缺失/);
  assert.deepEqual(J.normalizeJsonPayload({}, { a: 1 }), { a: 1 });
});
