const test = require('node:test');
const assert = require('node:assert/strict');

const D = require('./metadataDecoders.cjs');

test('align4 补齐到 4 字节边界', () => {
  assert.equal(D.align4(0), 0);
  assert.equal(D.align4(4), 4);
  assert.equal(D.align4(5), 8);
  assert.equal(D.align4(7), 8);
});

test('readUInt/Int16/32LE 越界返回 0', () => {
  assert.equal(D.readUInt16LE(Buffer.from([0x01, 0x02]), 0), 513);
  assert.equal(D.readUInt16LE(Buffer.from([0x01]), 0), 0);
  assert.equal(D.readInt16LE(Buffer.from([0xff, 0xff]), 0), -1);
  assert.equal(D.readUInt32LE(Buffer.from([1, 0, 0, 0]), 0), 1);
  assert.equal(D.readInt32LE(Buffer.from([0xff, 0xff, 0xff, 0xff]), 0), -1);
  assert.equal(D.readUInt32LE(Buffer.from([1, 0]), 0), 0);
});

test('codePageToEncoding 覆盖常见代码页，未知回退 latin1', () => {
  assert.equal(D.codePageToEncoding(936), 'gb18030');
  assert.equal(D.codePageToEncoding(950), 'big5');
  assert.equal(D.codePageToEncoding(932), 'shift_jis');
  assert.equal(D.codePageToEncoding(949), 'euc-kr');
  assert.equal(D.codePageToEncoding(65001), 'utf8');
  assert.equal(D.codePageToEncoding(1200), 'utf16le');
  assert.equal(D.codePageToEncoding(1252), 'windows1252');
  assert.equal(D.codePageToEncoding(9999), 'latin1');
});

test('cleanOleString 去掉 NUL 与首尾空白', () => {
  assert.equal(D.cleanOleString(' a\u0000b\u0000\u0000 '), 'ab');
  assert.equal(D.cleanOleString(null), '');
});

test('isOlePropertySetStreamName 识别属性集流名（含前缀与路径）', () => {
  assert.equal(D.isOlePropertySetStreamName('\u0005SummaryInformation'), true);
  assert.equal(D.isOlePropertySetStreamName('!DocumentSummaryInformation'), true);
  assert.equal(D.isOlePropertySetStreamName('C:\\x\\SummaryInformation'), true);
  assert.equal(D.isOlePropertySetStreamName('WordDocument'), false);
});

test('canonicalPdfXmpKey 把 XMP 键归一为内部字段名', () => {
  assert.equal(D.canonicalPdfXmpKey('dc:title'), 'title');
  assert.equal(D.canonicalPdfXmpKey('xmp:Creator'), 'author');
  assert.equal(D.canonicalPdfXmpKey('CreatorTool'), 'creator');
  assert.equal(D.canonicalPdfXmpKey('Producer'), 'producer');
  assert.equal(D.canonicalPdfXmpKey('dc:subject'), 'subject');
  assert.equal(D.canonicalPdfXmpKey('pdf:Keywords'), 'keywords');
  assert.equal(D.canonicalPdfXmpKey('xmp:CreateDate'), 'created');
  assert.equal(D.canonicalPdfXmpKey('xmp:MetadataDate'), 'modified');
  assert.equal(D.canonicalPdfXmpKey('unknown'), '');
});

test('decodeUtf16Be 按大端逐字符解码并跳过 NUL 码位', () => {
  assert.equal(D.decodeUtf16Be(Buffer.from([0x00, 0x41, 0x00, 0x42])), 'AB');
  assert.equal(D.decodeUtf16Be(Buffer.from([0x00, 0x00, 0x00, 0x43])), 'C');
});

test('decodePdfName 还原 #xx 转义', () => {
  assert.equal(D.decodePdfName('A#20B'), 'A B');
  assert.equal(D.decodePdfName('#41'), 'A');
  assert.equal(D.decodePdfName('plain'), 'plain');
});

test('decodeXml 去 CDATA 并还原实体', () => {
  assert.equal(D.decodeXml('<![CDATA[x<y]]>'), 'x<y');
  assert.equal(D.decodeXml(' <a>&lt;b&gt;&amp;&quot;&apos;</a> '), '<a><b>&"\'</a>');
});

test('readZipText 取出指定条目文本，缺失返回空串', () => {
  const zip = { getEntry: (name) => (name === 'a.txt' ? { getData: () => Buffer.from('hello') } : null) };
  assert.equal(D.readZipText(zip, 'a.txt'), 'hello');
  assert.equal(D.readZipText(zip, 'missing.txt'), '');
});
