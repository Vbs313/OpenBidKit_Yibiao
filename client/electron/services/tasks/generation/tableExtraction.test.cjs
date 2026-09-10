const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('./tableExtraction.cjs');

test('isMarkdownTableSeparator 只认全为短横线的分隔行', () => {
  assert.equal(T.isMarkdownTableSeparator('| --- | --- |'), true);
  assert.equal(T.isMarkdownTableSeparator('| :--- | ---: |'), true);
  assert.equal(T.isMarkdownTableSeparator('--- | ---'), true);
  assert.equal(T.isMarkdownTableSeparator('| --- |'), true);
  assert.equal(T.isMarkdownTableSeparator('| abc | def |'), false);
  assert.equal(T.isMarkdownTableSeparator('abc'), false);
  assert.equal(T.isMarkdownTableSeparator(''), false);
  assert.equal(T.isMarkdownTableSeparator(null), false);
});

test('collectFencedCodeRanges 圈出成对围栏，未闭合时圈到文末', () => {
  const closed = '前\n```\ncode\n```\n后';
  const ranges = T.collectFencedCodeRanges(closed);
  assert.equal(ranges.length, 1);
  assert.ok(closed.slice(ranges[0].start, ranges[0].end).includes('code'));
  assert.ok(!closed.slice(ranges[0].start, ranges[0].end).includes('后'));

  const tilde = '前\n~~~js\ncode\n~~~';
  assert.equal(T.collectFencedCodeRanges(tilde).length, 1);

  const unclosed = '前\n```\n未闭合';
  const open = T.collectFencedCodeRanges(unclosed);
  assert.equal(open.length, 1);
  assert.equal(open[0].end, unclosed.length);

  assert.deepEqual(T.collectFencedCodeRanges('没有围栏'), []);
});

test('extractMarkdownTableBlocks 抽出表头+分隔+数据行', () => {
  const md = '段落\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n结尾';
  const tables = T.extractMarkdownTableBlocks(md, []);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].type, 'markdown');
  assert.equal(tables[0].text, '| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.equal(md.slice(tables[0].start, tables[0].end), tables[0].text);

  const withoutSeparator = '| A | B |\n| 1 | 2 |';
  assert.deepEqual(T.extractMarkdownTableBlocks(withoutSeparator, []), []);
});

test('extractHtmlTableBlocks 抽出 HTML 表格', () => {
  const html = '前<table><tr><td>1</td></tr></table>后';
  const tables = T.extractHtmlTableBlocks(html, []);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].type, 'html');
  assert.equal(tables[0].text, '<table><tr><td>1</td></tr></table>');
  assert.equal(html.slice(tables[0].start, tables[0].end), tables[0].text);
  assert.deepEqual(T.extractHtmlTableBlocks('没有表格', []), []);
});

test('extractContentTableBlocks 跳过围栏代码里的表格', () => {
  const fenced = '```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```';
  assert.deepEqual(T.extractContentTableBlocks(fenced), []);
  const fencedHtml = '```\n<table><tr><td>1</td></tr></table>\n```';
  assert.deepEqual(T.extractContentTableBlocks(fencedHtml), []);
});

test('extractContentTableBlocks 编号并附上前后文', () => {
  const content = '前面说明\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n后面说明';
  const tables = T.extractContentTableBlocks(content);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].id, 'T001');
  assert.equal(tables[0].type, 'markdown');
  assert.equal(tables[0].before, '前面说明');
  assert.equal(tables[0].after, '后面说明');
});

test('extractContentTableBlocks 按位置排序并保证不重叠', () => {
  const content = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<table><tr><td>x</td></tr></table>';
  const tables = T.extractContentTableBlocks(content);
  assert.equal(tables.length, 2);
  assert.deepEqual(tables.map((t) => t.id), ['T001', 'T002']);
  assert.ok(tables[0].start < tables[1].start);
  assert.ok(tables[0].end <= tables[1].start);
});

test('containsContentTable 判定正文里有没有表格', () => {
  assert.equal(T.containsContentTable('| A | B |\n| --- | --- |\n| 1 | 2 |'), true);
  assert.equal(T.containsContentTable('<table><tr><td>1</td></tr></table>'), true);
  assert.equal(T.containsContentTable('纯文字段落'), false);
  assert.equal(T.containsContentTable(''), false);
});

test('createTableCleanupBatches 按 30000 字上限分批', () => {
  const tables = [
    { text: 'x'.repeat(20000), before: '', after: '' },
    { text: 'x'.repeat(20000), before: '', after: '' },
    { text: 'x'.repeat(5000), before: '', after: '' },
  ];
  const batches = T.createTableCleanupBatches(tables);
  assert.deepEqual(batches.map((b) => b.length), [1, 2]);
  assert.deepEqual(T.createTableCleanupBatches([]), []);
  assert.deepEqual(T.createTableCleanupBatches(null), []);
});

test('createTableCleanupBatches 把前后文也算进批次体积', () => {
  const tables = [
    { text: 'x'.repeat(1000), before: 'y'.repeat(20000), after: '' },
    { text: 'x'.repeat(1000), before: 'y'.repeat(20000), after: '' },
  ];
  const batches = T.createTableCleanupBatches(tables);
  assert.deepEqual(batches.map((b) => b.length), [1, 1]);
});