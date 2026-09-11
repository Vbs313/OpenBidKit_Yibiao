const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('./markdownText.cjs');

const makeItem = (over = {}) => ({
  id: 'i1',
  title: '项目概述',
  level: 1,
  normalized_title: '项目概述',
  normalized_path: '1',
  path_titles: ['项目概述'],
  from_tender: false,
  duplicate_group_ids: [],
  similar_group_ids: [],
  ...over,
});

test('isReadableSignalSnippet 只认有实际信息量的片段', () => {
  assert.equal(M.isReadableSignalSnippet(''), false);
  assert.equal(M.isReadableSignalSnippet(null), false);
  assert.equal(typeof M.isReadableSignalSnippet('这是本项目的主要技术要求说明'), 'boolean');
});

test('cleanMarkdownInlineText 去掉图片、链接与 HTML 标签', () => {
  const text = M.cleanMarkdownInlineText('前 ![图](a.png) 中 [链接](https://x) <b>粗体</b> 后');
  assert.equal(text.includes('a.png'), false);
  assert.equal(text.includes('<b>'), false);
  assert.ok(text.includes('前'));
  assert.ok(text.includes('中'));
  assert.ok(text.includes('粗体'));
  assert.ok(text.includes('后'));
});

test('cleanMarkdownInlineText 解码常见 HTML 实体', () => {
  assert.equal(M.cleanMarkdownInlineText('A&amp;B&nbsp;C&lt;D'), 'A&B C<D');
});

test('cleanMarkdownLine 去掉标题与列表记号', () => {
  assert.equal(M.cleanMarkdownLine('# 一级标题'), '一级标题');
  assert.equal(M.cleanMarkdownLine('- 列表项'), '列表项');
  assert.equal(M.cleanMarkdownLine('   '), '');
});

test('extractMarkdownTextBlocks 拆分正文并跳过代码块', () => {
  const blocks = M.extractMarkdownTextBlocks([
    '# 标题',
    '',
    '这是第一段正文内容。',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '- 列表项一',
    '- 列表项二',
  ].join('\n'));
  assert.ok(Array.isArray(blocks));
  assert.ok(blocks.some((block) => block.includes('标题')));
  assert.ok(blocks.some((block) => block.includes('第一段正文')));
  assert.ok(blocks.some((block) => block.includes('列表项一')));
  assert.equal(blocks.some((block) => block.includes('const a = 1')), false);
});

test('extractMarkdownTextBlocks 把表格拆成单元格文本', () => {
  const blocks = M.extractMarkdownTextBlocks([
    '| 项目 | 说明 |',
    '| --- | --- |',
    '| 工期 | 90 天 |',
  ].join('\n'));
  assert.ok(blocks.includes('项目'));
  assert.ok(blocks.includes('说明'));
  assert.ok(blocks.some((block) => block.includes('工期')));
  assert.ok(blocks.some((block) => block.includes('90 天')));
});

test('addContentTextBlock 归一化文本并忽略空内容', () => {
  const blocks = [];
  M.addContentTextBlock(blocks, '第一句\n\n第二句');
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].includes('第一句'));
  assert.ok(blocks[0].includes('第二句'));
  M.addContentTextBlock(blocks, '   ');
  assert.equal(blocks.length, 1);
});

test('buildOutlineComparison 找出同名同路径的重复大纲项', () => {
  const files = [
    { status: 'success', file_id: 'F1', items: [makeItem()] },
    { status: 'success', file_id: 'F2', items: [makeItem({ id: 'i2' })] },
  ];
  const result = M.buildOutlineComparison(files);
  assert.ok(Array.isArray(result.duplicateGroups));
  assert.ok(result.duplicateGroups.length >= 1);
  const group = result.duplicateGroups[0];
  assert.equal(group.type, 'duplicate');
  assert.deepEqual(group.file_ids.sort(), ['F1', 'F2']);
  assert.equal(files[0].items[0].duplicate_group_ids.length, 1);
  assert.equal(files[1].items[0].duplicate_group_ids.length, 1);
});

test('buildOutlineComparison 忽略未成功与来自招标文件的条目', () => {
  const files = [
    { status: 'success', file_id: 'F1', items: [makeItem({ from_tender: true })] },
    { status: 'failed', file_id: 'F2', items: [makeItem({ id: 'i2' })] },
  ];
  const result = M.buildOutlineComparison(files);
  assert.equal(result.duplicateGroups.length, 0);
});
