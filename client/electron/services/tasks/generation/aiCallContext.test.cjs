const test = require('node:test');
const assert = require('node:assert/strict');

const A = require('./aiCallContext.cjs');

test('getMessagesContentLength 统计 role 与各类 content 长度', () => {
  assert.equal(A.getMessagesContentLength([{ role: 'user', content: 'abc' }]), 7);
  assert.equal(A.getMessagesContentLength([{ role: '', content: [{ text: 'ab' }, { content: 'cde' }] }]), 5);
  assert.equal(A.getMessagesContentLength([{ content: { a: 1 } }]), 7);
  assert.equal(A.getMessagesContentLength([{ role: 'user', content: null }]), 4);
  assert.equal(A.getMessagesContentLength([{ role: '', content: undefined }]), 0);
  assert.equal(A.getMessagesContentLength(null), 0);
  assert.equal(A.getMessagesContentLength('x'), 0);
  assert.equal(A.getMessagesContentLength(undefined), 0);
});

test('getTextContextLengthLimit 读配置，失败或非法时退回默认 400000', () => {
  assert.equal(A.getTextContextLengthLimit({ getConfig: () => ({ context_length_limit: 1000 }) }), 1000);
  assert.equal(A.getTextContextLengthLimit({ getConfig: () => ({ context_length_limit: '2000' }) }), 2000);
  assert.equal(A.getTextContextLengthLimit({ getConfig: () => ({ context_length_limit: 0 }) }), 400000);
  assert.equal(A.getTextContextLengthLimit({ getConfig: () => ({ context_length_limit: 'x' }) }), 400000);
  assert.equal(A.getTextContextLengthLimit({ getConfig: () => ({}) }), 400000);
  assert.equal(A.getTextContextLengthLimit({ getConfig: () => { throw new Error('x'); } }), 400000);
  assert.equal(A.getTextContextLengthLimit(null), 400000);
});

test('shouldUseAgentForMessages 以 70% 上下文阈值切换 Agent', () => {
  assert.equal(A.AGENT_CONTEXT_THRESHOLD_RATIO, 0.7);
  const service = (limit) => ({ getConfig: () => ({ context_length_limit: limit }) });
  assert.equal(A.shouldUseAgentForMessages(service(1000), [{ role: '', content: 'x'.repeat(600) }]), false);
  assert.equal(A.shouldUseAgentForMessages(service(1000), [{ role: '', content: 'x'.repeat(700) }]), false);
  assert.equal(A.shouldUseAgentForMessages(service(1000), [{ role: '', content: 'x'.repeat(701) }]), true);
  assert.equal(A.shouldUseAgentForMessages(service(1000), []), false);
});

test('normalizeContentConcurrency 归一到不小于 1 的整数', () => {
  assert.equal(A.normalizeContentConcurrency(5), 5);
  assert.equal(A.normalizeContentConcurrency(3.6), 4);
  assert.equal(A.normalizeContentConcurrency(0), 1);
  assert.equal(A.normalizeContentConcurrency(-3), 1);
  assert.equal(A.normalizeContentConcurrency('abc'), 10);
  assert.equal(A.normalizeContentConcurrency(undefined), 10);
  assert.equal(A.normalizeContentConcurrency('4'), 4);
});

test('normalizeImageConcurrency 用图片默认并发 2 兜底', () => {
  assert.equal(A.normalizeImageConcurrency(3), 3);
  assert.equal(A.normalizeImageConcurrency(1.4), 1);
  assert.equal(A.normalizeImageConcurrency(0), 1);
  assert.equal(A.normalizeImageConcurrency('abc'), 2);
  assert.equal(A.normalizeImageConcurrency(undefined), 2);
});

test('isDeveloperModeEnabled 探测失败一律当关闭', () => {
  assert.equal(A.isDeveloperModeEnabled({ isDeveloperMode: () => true }), true);
  assert.equal(A.isDeveloperModeEnabled({ isDeveloperMode: () => 1 }), true);
  assert.equal(A.isDeveloperModeEnabled({ isDeveloperMode: () => false }), false);
  assert.equal(A.isDeveloperModeEnabled({ isDeveloperMode: () => { throw new Error('x'); } }), false);
  assert.equal(A.isDeveloperModeEnabled({}), false);
  assert.equal(A.isDeveloperModeEnabled(null), false);
});

test('createContentDeveloperLogger 优先用 aiService，否则给 noop', () => {
  const custom = { enabled: true, filePath: '/tmp/a.log', logId: 'id', write() {} };
  assert.equal(A.createContentDeveloperLogger({ createTechnicalPlanDeveloperLogger: () => custom }, { x: 1 }), custom);

  const noop = A.createContentDeveloperLogger(null, {});
  assert.equal(noop.enabled, false);
  assert.equal(noop.filePath, '');
  assert.equal(noop.logId, '');
  assert.equal(typeof noop.write, 'function');

  const thrown = A.createContentDeveloperLogger({ createTechnicalPlanDeveloperLogger: () => { throw new Error('x'); } }, {});
  assert.equal(thrown.enabled, false);
});

test('countContentWords 复用可读字数口径', () => {
  assert.equal(A.countContentWords('你好世界'), 4);
  assert.equal(A.countContentWords('hello world'), 2);
  assert.equal(A.countContentWords('## 标题'), 2);
  assert.equal(A.countContentWords(null), 0);
  assert.equal(A.countContentWords(''), 0);
});