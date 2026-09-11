const test = require('node:test');
const assert = require('node:assert/strict');

const K = require('./kbPipelineUtils.cjs');

test('normalizeCandidateItems 归一化并丢掉缺字段的条目', () => {
  const items = K.normalizeCandidateItems({ items: [
    { title: ' 标题 ', summary: ' 摘要 ' },
    { title: '只有标题' },
    { resume: '别名摘要', title: '别名' },
  ] });
  assert.deepEqual(items, [
    { title: '标题', summary: '摘要' },
    { title: '别名', summary: '别名摘要' },
  ]);
  assert.deepEqual(K.normalizeCandidateItems(null), []);
});

test('validateCandidateItems 缺少 items 时抛错', () => {
  assert.doesNotThrow(() => K.validateCandidateItems({ items: [] }));
  assert.throws(() => K.validateCandidateItems({}), /缺少 items 数组/);
  assert.throws(() => K.validateCandidateItems(null), /缺少 items 数组/);
});

test('nextKnowledgeItemId 在最大编号上加一', () => {
  assert.equal(K.nextKnowledgeItemId([]), 'K000001');
  assert.equal(K.nextKnowledgeItemId([{ id: 'K000007' }, { id: 'K000002' }]), 'K000008');
  assert.equal(K.nextKnowledgeItemId([{ id: 'other' }]), 'K000001');
});

test('getBlockOrder 建立 id 到序号的映射', () => {
  const order = K.getBlockOrder([{ id: 'a' }, { id: 'b' }]);
  assert.equal(order.get('a'), 0);
  assert.equal(order.get('b'), 1);
  assert.equal(order.size, 2);
});

test('stripMarkdownFence 去掉代码围栏', () => {
  assert.equal(K.stripMarkdownFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(K.stripMarkdownFence('{"a":1}'), '{"a":1}');
  assert.equal(K.stripMarkdownFence(''), '');
});
