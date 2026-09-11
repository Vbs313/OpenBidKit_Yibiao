const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeStreamPayloadError } = require('./streamErrors.cjs');

test('normalizeStreamPayloadError 返回字符串错误本身', () => {
  assert.equal(normalizeStreamPayloadError('模型拒绝', '兜底'), '模型拒绝');
});

test('normalizeStreamPayloadError 优先取 message 再取 code', () => {
  assert.equal(normalizeStreamPayloadError({ message: '限流', code: '429' }, '兜底'), '限流');
  assert.equal(normalizeStreamPayloadError({ code: '429' }, '兜底'), '429');
});

test('normalizeStreamPayloadError 对空值返回兜底文案', () => {
  assert.equal(normalizeStreamPayloadError(null, '图片生成失败'), '图片生成失败');
  assert.equal(normalizeStreamPayloadError(undefined, '图片生成失败'), '图片生成失败');
  assert.equal(normalizeStreamPayloadError({}, '图片生成失败'), '图片生成失败');
});
