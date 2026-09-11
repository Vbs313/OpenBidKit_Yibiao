const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('./agentWorkspace.cjs');
const { textHash } = require('./textEdits.cjs');

test('buildAgentConsistencySectionIndex 建立 id -> 原文与哈希 的索引', () => {
  const index = W.buildAgentConsistencySectionIndex([
    { item: { id: '1.1', title: 'A' }, content: '  正文一  ' },
    { item: { id: '', title: 'B' }, content: '正文二' },
    { item: { id: '1.2', title: 'C' }, content: '   ' },
    { item: { id: '1.3', title: 'D' }, content: '正文三' },
  ]);
  assert.deepEqual([...index.keys()], ['1.1', '1.3']);
  assert.equal(index.get('1.1').originalContent, '正文一');
  assert.equal(index.get('1.1').originalHash, textHash('正文一'));
  assert.equal(index.get('1.1').item.title, 'A');
  assert.equal(W.buildAgentConsistencySectionIndex(null).size, 0);
});

test('buildAgentTechnicalPlanMarkdown 递归渲染目录与 section 标记', () => {
  const sectionIndex = W.buildAgentConsistencySectionIndex([
    { item: { id: '1.1', title: '节' }, content: '正文内容' },
  ]);
  const markdown = W.buildAgentTechnicalPlanMarkdown(
    { outline: [{ id: '1', title: '章', children: [{ id: '1.1', title: '节' }] }] },
    sectionIndex,
  );
  assert.equal(markdown, [
    '# 技术方案正文',
    '',
    '## 1 章',
    '### 1.1 节',
    '<!-- yibiao-section-start id="1.1" title="节" -->',
    '正文内容',
    '<!-- yibiao-section-end id="1.1" -->',
  ].join('\n'));
});

test('buildAgentTechnicalPlanMarkdown 跳过不在索引里的叶子并保留空目录', () => {
  const markdown = W.buildAgentTechnicalPlanMarkdown(
    { outline: [{ id: '1', title: '章', children: [{ id: '1.1', title: '节' }] }] },
    new Map(),
  );
  assert.equal(markdown, ['# 技术方案正文', '', '## 1 章', '### 1.1 节'].join('\n'));
  assert.ok(!markdown.includes('yibiao-section-start'));
});

test('buildAgentTechnicalPlanMarkdown 转义标题与 id 属性', () => {
  const sectionIndex = W.buildAgentConsistencySectionIndex([
    { item: { id: 'a"b', title: '标题"引号' }, content: 'X' },
  ]);
  const markdown = W.buildAgentTechnicalPlanMarkdown(
    { outline: [{ id: 'a"b', title: '标题"引号' }] },
    sectionIndex,
  );
  assert.ok(markdown.includes('id="a&quot;b"'));
  assert.ok(markdown.includes('title="标题&quot;引号"'));
});

test('buildAgentGlobalFactsMarkdown 拼接事实与关键解析结果', () => {
  assert.equal(
    W.buildAgentGlobalFactsMarkdown('事实内容', '解析内容'),
    '# 全局事实变量\n\n事实内容\n\n# Step02 关键解析结果\n\n解析内容',
  );
  assert.equal(
    W.buildAgentGlobalFactsMarkdown('', null),
    '# 全局事实变量\n\n未提供\n\n# Step02 关键解析结果\n\n未提供',
  );
});

test('buildAgentConsistencyRepairPrompt 按全局事实模式追加补全规则', () => {
  const base = W.buildAgentConsistencyRepairPrompt();
  assert.ok(base.includes('technical-plan.md'));
  assert.ok(base.includes('global-facts.md'));
  assert.ok(base.includes('yibiao-section-start'));
  assert.ok(!base.includes('事实补全规则'));

  const omit = W.buildAgentConsistencyRepairPrompt('omit');
  assert.ok(omit.includes('事实补全规则（别招欠模式）'));
  assert.ok(omit.includes('不得把【待填写】改成具体值'));

  const placeholder = W.buildAgentConsistencyRepairPrompt('placeholder');
  assert.ok(placeholder.includes('事实补全规则（放着我来模式）'));
});

test('validateAgentConsistencySections 校验未知、缺失与被清空的小节', () => {
  const sectionIndex = W.buildAgentConsistencySectionIndex([
    { item: { id: 'a' }, content: 'A 正文' },
    { item: { id: 'b' }, content: 'B 正文' },
  ]);
  assert.doesNotThrow(() => W.validateAgentConsistencySections(new Map([['a', 'A 正文'], ['b', 'B 正文']]), sectionIndex));

  assert.throws(() => W.validateAgentConsistencySections(new Map([['a', 'x'], ['b', 'y'], ['c', 'z']]), sectionIndex), /未知小节：c/);
  assert.throws(() => W.validateAgentConsistencySections(new Map([['a', 'x']]), sectionIndex), /缺少小节：b/);
  assert.throws(() => W.validateAgentConsistencySections(new Map([['a', '   '], ['b', 'y']]), sectionIndex), /把非空小节改为空：a/);
});

test('validateAgentConsistencySections 允许原本就为空的小节保持为空', () => {
  const sectionIndex = W.buildAgentConsistencySectionIndex([{ item: { id: 'a' }, content: 'A' }]);
  sectionIndex.set('empty', { item: { id: 'empty' }, originalContent: '' });
  assert.doesNotThrow(() => W.validateAgentConsistencySections(new Map([['a', 'A'], ['empty', '']]), sectionIndex));
});
function makeWriter(overrides = {}) {
  const state = { logs: [], saved: [], touched: [] };
  const deps = {
    state,
    rememberTouchedItem: (id) => { state.touched.push(id); },
    saveSection: (item, partial, content) => { state.saved.push({ item, partial, content }); },
    ...overrides,
  };
  return { writer: W.createAgentSectionWriter(deps), state };
}

test('applyAgentConsistencySections 只回写内容真正变化的小节', () => {
  const { writer, state } = makeWriter();
  const sectionIndex = W.buildAgentConsistencySectionIndex([
    { item: { id: 'a', title: 'A' }, content: '原文 A' },
    { item: { id: 'b', title: 'B' }, content: '原文 B' },
    { item: { id: 'c', title: 'C' }, content: '原文 C' },
  ]);
  const result = writer.applyAgentConsistencySections(
    new Map([['a', '改后的 A'], ['b', '原文 B'], ['c', '原文 C']]),
    sectionIndex,
    new Set(['a', 'b']),
  );
  assert.deepEqual(result, { changedCount: 1, skippedCount: 2, changedIds: ['a'] });
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].item.id, 'a');
  assert.equal(state.saved[0].content, '改后的 A');
  assert.equal(state.saved[0].partial.status, 'success');
  assert.equal(state.saved[0].partial.error, undefined);
  assert.deepEqual(state.touched, ['a']);
});

test('applyAgentConsistencySections 忽略空差异与换行差异', () => {
  const { writer, state } = makeWriter();
  const sectionIndex = W.buildAgentConsistencySectionIndex([{ item: { id: 'a', title: 'A' }, content: '原文 A' }]);
  const result = writer.applyAgentConsistencySections(new Map([['a', '原文 A\r\n']]), sectionIndex, new Set(sectionIndex.keys()));
  assert.deepEqual(result, { changedCount: 0, skippedCount: 1, changedIds: [] });
  assert.equal(state.saved.length, 0);
  assert.deepEqual(state.touched, []);
});

test('applyAgentConsistencySections 把界外小节计入跳过', () => {
  const { writer, state } = makeWriter();
  const sectionIndex = W.buildAgentConsistencySectionIndex([
    { item: { id: 'a', title: 'A' }, content: '原文 A' },
    { item: { id: 'b', title: 'B' }, content: '原文 B' },
  ]);
  const result = writer.applyAgentConsistencySections(
    new Map([['a', '改后的 A'], ['b', '改后的 B']]),
    sectionIndex,
    new Set(['a']),
  );
  assert.deepEqual(result, { changedCount: 1, skippedCount: 1, changedIds: ['a'] });
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].item.id, 'a');
});

test('applyAgentConsistencySections 把落盘前的日志数组传给 saveSection', () => {
  const captured = [];
  const { writer } = makeWriter({ saveSection: (item, partial, content, extra) => captured.push(extra) });
  const sectionIndex = W.buildAgentConsistencySectionIndex([{ item: { id: 'a', title: 'A' }, content: '原文 A' }]);
  writer.applyAgentConsistencySections(new Map([['a', '改后的 A']]), sectionIndex, new Set(['a']));
  assert.equal(captured.length, 1);
  assert.ok(Array.isArray(captured[0].logs));
});
