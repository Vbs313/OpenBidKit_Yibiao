const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeGeneratedMarkdown,
  isMarkdownTableRow,
  normalizeTableRequirement,
  maxTablesForRequirement,
  clearContentPlanTable,
  formatTablesForCleanupPrompt,
  validateTableCleanupResponse,
  unwrapMarkdownTitle,
  stripMarkdownHeadingsFromLeafContent,
  pickDistributedTableTargets,
} = require('./markdownTables.cjs');

test('normalizeGeneratedMarkdown 把行内 <br> 变成行尾硬换行，表格行除外', () => {
  assert.equal(normalizeGeneratedMarkdown('a<br>b'), 'a  \nb');
  assert.equal(normalizeGeneratedMarkdown('| a<br />b |'), '| a<br />b |');
  assert.equal(normalizeGeneratedMarkdown(''), '');
});

test('isMarkdownTableRow 认表格行，忽略转义竖线', () => {
  assert.equal(isMarkdownTableRow('| a | b |'), true);
  assert.equal(isMarkdownTableRow('a \\| b'), false);
  assert.equal(isMarkdownTableRow('普通段落'), false);
});

test('normalizeTableRequirement 中英文档位归一，未知回落到 heavy', () => {
  assert.equal(normalizeTableRequirement('不要'), 'none');
  assert.equal(normalizeTableRequirement('少量'), 'light');
  assert.equal(normalizeTableRequirement('适中'), 'moderate');
  assert.equal(normalizeTableRequirement('大量'), 'heavy');
  assert.equal(normalizeTableRequirement('moderate'), 'moderate');
  assert.equal(normalizeTableRequirement(''), 'heavy');
});

test('maxTablesForRequirement 按叶子数量给上限', () => {
  assert.equal(maxTablesForRequirement('none', 10), 0);
  assert.equal(maxTablesForRequirement('light', 10), 2);
  assert.equal(maxTablesForRequirement('moderate', 10), 4);
  assert.equal(maxTablesForRequirement('heavy', 10), null);
  assert.equal(maxTablesForRequirement('moderate', -5), 0);
});

test('clearContentPlanTable 只清掉表格需求，保留其余字段', () => {
  const cleared = clearContentPlanTable({ title: 'a', table: { needed: true, purpose: 'x' } });
  assert.deepEqual(cleared, { title: 'a', table: { needed: false, purpose: '' } });
});

test('formatTablesForCleanupPrompt 渲染 table_block，空输入给空串', () => {
  assert.equal(formatTablesForCleanupPrompt([]), '');
  const text = formatTablesForCleanupPrompt([{ id: 't1', type: 'merged', before: '上', after: '下', text: '| a |' }]);
  assert.match(text, /<table_block id="t1" type="merged">/);
  assert.match(text, /上文片段：\n上/);
  assert.match(text, /待转换表格：\n\| a \|/);
  assert.match(text, /下文片段：\n下/);
});

test('validateTableCleanupResponse 缺 replacements 直接抛错', () => {
  assert.throws(() => validateTableCleanupResponse({}), /replacements/);
  assert.doesNotThrow(() => validateTableCleanupResponse({ replacements: [] }));
});

test('unwrapMarkdownTitle 去掉标题标记与收尾标点', () => {
  assert.equal(unwrapMarkdownTitle('### 小标题'), '小标题');
  assert.equal(unwrapMarkdownTitle('**加粗标题**'), '加粗标题');
  // 已知顺序问题：加粗剥离用了 $ 锚点，后面跟标点时不会生效，
  // 于是 "## **标题**：" 会保留星号。这里如实记录现状，是否修正另行决策，
  // 本次提交只做搬运，不夹带行为变更。
  assert.equal(unwrapMarkdownTitle('## **标题**：'), '**标题**');
  assert.equal(unwrapMarkdownTitle('__加粗标题__。'), '__加粗标题__');
});

test('stripMarkdownHeadingsFromLeafContent 把标题降级为加粗，代码块内不动', () => {
  assert.equal(stripMarkdownHeadingsFromLeafContent('## 标题\ntext'), '**标题**\ntext');
  const fence = String.fromCharCode(96).repeat(3);
  const fenced = [fence, '## 标题', fence].join('\n');
  assert.equal(stripMarkdownHeadingsFromLeafContent(fenced), fenced);
});

test('pickDistributedTableTargets 均摊选取，边界安全', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ item: { id: 'i' + i } }));
  assert.equal(pickDistributedTableTargets(items, 0).size, 0);
  assert.equal(pickDistributedTableTargets(items, 20).size, 10);
  assert.equal(pickDistributedTableTargets(items, 3).size, 3);
  assert.equal(pickDistributedTableTargets([], 3).size, 0);
});
