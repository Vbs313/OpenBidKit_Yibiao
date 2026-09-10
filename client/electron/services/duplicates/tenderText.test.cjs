const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('./tenderText.cjs');

test('normalizeValue 归一标量/数组/对象/日期', () => {
  assert.equal(T.normalizeValue(null), '');
  assert.equal(T.normalizeValue('  ａ\u200b b '), 'a b');
  assert.equal(T.normalizeValue(['a', '', null, 'b']), 'a；b');
  assert.equal(T.normalizeValue({ a: 1 }), '{"a":1}');
  assert.equal(T.normalizeValue(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z');
});

test('stripMarkdownForOutline 去掉图片/标签/行内标记，保留链接文字', () => {
  assert.equal(T.stripMarkdownForOutline('![alt](x.png) [link](y) <b>t</b> `code` *b*'), '  link  t  code b');
});

test('inferOutlineLevel 按编号形态推断层级', () => {
  assert.equal(T.inferOutlineLevel('1.2.3'), 3);
  assert.equal(T.inferOutlineLevel('1'), 1);
  assert.equal(T.inferOutlineLevel('（一）'), 2);
  assert.equal(T.inferOutlineLevel('①'), 2);
  assert.equal(T.inferOutlineLevel('无法识别'), 1);
});

test('isCatalogTitleLine 识别目录标题', () => {
  assert.equal(T.isCatalogTitleLine('## 目录'), true);
  assert.equal(T.isCatalogTitleLine('目 录'), true);
  assert.equal(T.isCatalogTitleLine('Contents'), true);
  assert.equal(T.isCatalogTitleLine('目录页'), false);
});

test('normalizeContentLineBreaks 统一为 LF', () => {
  assert.equal(T.normalizeContentLineBreaks('a\r\nb\rc'), 'a\nb\nc');
});

test('splitMarkdownTableRow 切分表格行并保留转义竖线', () => {
  assert.deepEqual(T.splitMarkdownTableRow('| a | b |'), ['a', 'b']);
  assert.deepEqual(T.splitMarkdownTableRow('a \\| b | c'), ['a | b', 'c']);
});

test('stripLeadingContentSequence 连续剥离多级编号', () => {
  assert.equal(T.stripLeadingContentSequence('1.2.3 标题'), '标题');
  assert.equal(T.stripLeadingContentSequence('（一）内容'), '内容');
  assert.equal(T.stripLeadingContentSequence('第一章 总则'), '总则');
  assert.equal(T.stripLeadingContentSequence('①注'), '注');
  assert.equal(T.stripLeadingContentSequence('普通正文'), '普通正文');
});

test('cleanContentSentence 去控制字符与全角空格', () => {
  assert.equal(T.cleanContentSentence('\uFEFFa\t b\u3000c'), 'a b c');
});

test('isInformativeContentSentence 过滤纯编号与过短内容', () => {
  assert.equal(T.isInformativeContentSentence('123'), false);
  assert.equal(T.isInformativeContentSentence('abc'), false);
  assert.equal(T.isInformativeContentSentence('abcde'), false);
  assert.equal(T.isInformativeContentSentence('这是一句足够长的正文内容'), true);
  assert.equal(T.isInformativeContentSentence('工期：30天'), true);
});

test('stripTenderTablePrefix 去掉表头列名前缀与序号', () => {
  assert.equal(T.stripTenderTablePrefix('技术要求：1. 高性能'), '高性能');
  assert.equal(T.stripTenderTablePrefix('高性能'), '高性能');
});

test('stripTenderDirectoryPageTail 只在目录/页码语境下裁尾', () => {
  assert.equal(T.stripTenderDirectoryPageTail('目录 设备清单 ....... 12'), '目录 设备清单');
  assert.equal(T.stripTenderDirectoryPageTail('普通正文 12'), '普通正文 12');
});

test('normalizeTenderFieldName 去空白与包裹符号', () => {
  assert.equal(T.normalizeTenderFieldName(' 投标 人：  '), '投标人');
  assert.equal(T.normalizeTenderFieldName('【投标人】'), '投标人');
});
