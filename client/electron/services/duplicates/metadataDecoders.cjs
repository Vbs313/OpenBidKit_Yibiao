// OLE 复合文档与 PDF XMP 元数据解码：字节级解析，纯函数，可单独测试。

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function readZipText(zip, entryName) {
  const entry = zip.getEntry(entryName);
  return entry ? entry.getData().toString('utf8') : '';
}

function align4(value) {
  return value + ((4 - (value % 4)) % 4);
}

function readUInt16LE(buffer, offset) {
  return offset + 2 <= buffer.length ? buffer.readUInt16LE(offset) : 0;
}

function readInt16LE(buffer, offset) {
  return offset + 2 <= buffer.length ? buffer.readInt16LE(offset) : 0;
}

function readUInt32LE(buffer, offset) {
  return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : 0;
}

function readInt32LE(buffer, offset) {
  return offset + 4 <= buffer.length ? buffer.readInt32LE(offset) : 0;
}

function codePageToEncoding(codePage) {
  const value = Number(codePage) || 1252;
  if (value === 936 || value === 54936) return 'gb18030';
  if (value === 950) return 'big5';
  if (value === 932) return 'shift_jis';
  if (value === 949) return 'euc-kr';
  if (value === 65001) return 'utf8';
  if (value === 1200 || value === 1201) return 'utf16le';
  if (value >= 1250 && value <= 1258) return `windows${value}`;
  return 'latin1';
}

function cleanOleString(value) {
  return String(value || '').replace(/\u0000+$/g, '').replace(/\u0000/g, '').trim();
}

function isOlePropertySetStreamName(value) {
  return /(?:summaryinformation|documentsummaryinformation)$/i.test(String(value || '').replace(/^.*[\\/]/, '').replace(/^\u0005|^!/, ''));
}

function canonicalPdfXmpKey(rawKey) {
  const key = String(rawKey || '').toLowerCase();
  if (/(^|:)title$/.test(key)) return 'title';
  if (/(^|:)creator$/.test(key)) return 'author';
  if (/creatortool$/.test(key)) return 'creator';
  if (/producer$/.test(key)) return 'producer';
  if (/(^|:)subject$/.test(key)) return 'subject';
  if (/keywords$/.test(key)) return 'keywords';
  if (/description$/.test(key)) return 'description';
  if (/createdate$/.test(key)) return 'created';
  if (/(modifydate|metadatadate)$/.test(key)) return 'modified';
  return '';
}

function decodeUtf16Be(buffer) {
  const chars = [];
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const code = buffer.readUInt16BE(offset);
    if (code) chars.push(String.fromCharCode(code));
  }
  return chars.join('');
}

function decodePdfName(value) {
  return String(value || '').replace(/#([0-9a-fA-F]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

module.exports = {
  decodeXml,
  readZipText,
  align4,
  readUInt16LE,
  readInt16LE,
  readUInt32LE,
  readInt32LE,
  codePageToEncoding,
  cleanOleString,
  isOlePropertySetStreamName,
  canonicalPdfXmpKey,
  decodeUtf16Be,
  decodePdfName,
};
