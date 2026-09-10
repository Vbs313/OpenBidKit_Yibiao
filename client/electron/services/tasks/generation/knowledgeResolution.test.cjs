const test = require('node:test');
const assert = require('node:assert/strict');

const K = require('./knowledgeResolution.cjs');

test('resolveGlobalFactsByTitles 只取选中且有内容的事实', () => {
  const globalFacts = [
    { title: 'A', content: 'ca' },
    { title: 'B', content: '   ' },
    { title: 'C', content: 'cc' },
  ];
  assert.deepEqual(K.resolveGlobalFactsByTitles(['A', 'B'], globalFacts), [{ title: 'A', content: 'ca' }]);
  assert.deepEqual(K.resolveGlobalFactsByTitles([], globalFacts), []);
  assert.deepEqual(K.resolveGlobalFactsByTitles(['A', 'A'], globalFacts), [{ title: 'A', content: 'ca' }]);
  assert.deepEqual(K.resolveGlobalFactsByTitles(['  A  '], globalFacts), [{ title: 'A', content: 'ca' }]);
});

test('hasFactSelection 认得五种事实字段写法与 plan 包裹', () => {
  for (const key of ['facts', 'fact_titles', 'factTitles', 'global_fact_titles', 'globalFactTitles']) {
    assert.equal(K.hasFactSelection({ [key]: [] }), true, key + ' 应被识别');
    assert.equal(K.hasFactSelection({ plan: { [key]: [] } }), true, 'plan.' + key + ' 应被识别');
  }
  assert.equal(K.hasFactSelection({}), false);
  assert.equal(K.hasFactSelection(null), false);
  assert.equal(K.hasFactSelection({ other: 1 }), false);
});

test('collectLeafContexts 收集叶子节点并带上父级与同级', () => {
  const items = [
    { id: '1', title: 'A', children: [{ id: '1.1', title: 'A1' }] },
    { id: '2', title: 'B' },
  ];
  const contexts = K.collectLeafContexts(items);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].item.id, '1.1');
  assert.deepEqual(contexts[0].parentChapters.map((c) => c.id), ['1']);
  assert.deepEqual(contexts[0].siblingChapters.map((c) => c.id), ['1.1']);
  assert.equal(contexts[1].item.id, '2');
  assert.deepEqual(contexts[1].parentChapters, []);
  assert.deepEqual(contexts[1].siblingChapters.map((c) => c.id), ['1', '2']);
  assert.deepEqual(K.collectLeafContexts(), []);
});

test('loadContentKnowledgeReferences 在未选文档或缺少服务时给空结果', () => {
  const logs = [];
  const log = (msg) => logs.push(msg);
  const empty = K.loadContentKnowledgeReferences({}, [], log);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.contentMap.size, 0);
  assert.ok(logs[0].includes('未选择参考知识库'));

  const noService = K.loadContentKnowledgeReferences(null, ['d1'], log);
  assert.deepEqual(noService.items, []);
  assert.ok(logs[1].includes('未找到知识库读取服务'));
});

test('loadContentKnowledgeReferences 轻量条目要 title+resume，正文素材要 content', () => {
  const logs = [];
  const service = {
    readReferences: () => [
      {
        document: { id: 'd1', status: 'success' },
        items: [
          { id: 'i1', title: 'T1', resume: 'R1', content: 'C1' },
          { id: 'i2', title: 'T2', resume: 'R2', content: '' },
          { id: 'i4', title: 'T4', content: 'C4' },
        ],
      },
      {
        document: { id: 'd2', status: 'failed' },
        items: [{ id: 'i3', title: 'T3', resume: 'R3', content: 'C3' }],
      },
    ],
  };
  const result = K.loadContentKnowledgeReferences(service, ['d1', 'd2'], (msg) => logs.push(msg));
  assert.deepEqual(result.items, [
    { id: 'd1::i1', title: 'T1', resume: 'R1' },
    { id: 'd1::i2', title: 'T2', resume: 'R2' },
  ]);
  assert.equal(result.contentMap.get('d1::i1').content, 'C1');
  assert.equal(result.contentMap.has('d1::i2'), false);
  assert.equal(result.contentMap.get('d2::i3').content, 'C3');
  assert.equal(result.contentMap.get('d1::i4').content, 'C4');
  assert.equal(result.contentMap.size, 3);
  assert.ok(logs.some((m) => m.includes('已读取 2 条知识库轻量条目')));
  assert.ok(logs.some((m) => m.includes('可用知识库正文素材 3 条')));
});

test('loadContentKnowledgeReferences 读取失败只记日志不抛错', () => {
  const logs = [];
  const service = { readReferences: () => { throw new Error('boom'); } };
  const result = K.loadContentKnowledgeReferences(service, ['d1'], (msg) => logs.push(msg));
  assert.deepEqual(result.items, []);
  assert.equal(result.contentMap.size, 0);
  assert.ok(logs[0].includes('已跳过'));
  assert.ok(logs[0].includes('boom'));
});

test('resolveKnowledgeContents 按选中的 id 取正文', () => {
  const map = new Map([
    ['d1::i1', { content: 'C1' }],
    ['d1::i2', { content: 'C2' }],
    ['d1::i3', {}],
  ]);
  assert.deepEqual(K.resolveKnowledgeContents(['d1::i1', 'd1::i3'], map), ['C1']);
  assert.deepEqual(K.resolveKnowledgeContents(['d1::i1', 'd1::i2'], map), ['C1', 'C2']);
  assert.deepEqual(K.resolveKnowledgeContents([], map), []);
  assert.deepEqual(K.resolveKnowledgeContents(['d1::i1'], null), []);
  assert.deepEqual(K.resolveKnowledgeContents(['d1::i1'], new Map()), []);
});

test('resolveSelectedFactsText 拼出选中事实的提示词文本', () => {
  const plan = { facts: { titles: ['A', 'C'] } };
  const globalFacts = [{ title: 'A', content: 'ca' }, { title: 'C', content: 'cc' }];
  assert.equal(K.resolveSelectedFactsText(plan, globalFacts), '## A\nca\n\n## C\ncc');
  assert.equal(K.resolveSelectedFactsText(null, globalFacts), '');
  assert.equal(K.resolveSelectedFactsText({ facts: { titles: ['Z'] } }, globalFacts), '');
});

test('updateOutlineItemContent 递归写入目标节点的正文', () => {
  const items = [
    { id: '1', title: 'A', children: [{ id: '1.1', title: 'A1', content: '旧' }] },
    { id: '2', title: 'B' },
  ];
  const next = K.updateOutlineItemContent(items, '1.1', '新');
  assert.equal(next[0].children[0].content, '新');
  assert.equal(next[1].content, undefined);
  assert.equal(items[0].children[0].content, '旧');
  const untouched = K.updateOutlineItemContent(items, 'nope', 'x');
  assert.deepEqual(untouched, items);
  assert.deepEqual(K.updateOutlineItemContent(undefined, 'a', 'x'), []);
});

test('clearOutlineContent 递归清空正文但保留结构', () => {
  const items = [
    { id: '1', title: 'A', content: 'c1', children: [{ id: '1.1', title: 'A1', content: 'c2' }] },
    { id: '2', title: 'B', content: 'c3' },
  ];
  const cleared = K.clearOutlineContent(items);
  assert.deepEqual(cleared, [
    { id: '1', title: 'A', children: [{ id: '1.1', title: 'A1' }] },
    { id: '2', title: 'B' },
  ]);
  assert.equal(items[0].content, 'c1');
  assert.deepEqual(K.clearOutlineContent(undefined), []);
});