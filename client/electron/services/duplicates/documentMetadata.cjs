// 文档元数据抽取：从 docx / doc / pdf 里读出作者、时间、修订、签名、WPS/OLE 痕迹等可比对字段。
//
// 这些原本是 duplicateCheckService.cjs 里的模块级函数与常量表；搬出来后 service 只负责调度。
// 只做文件解析与字段归一，不接触 Electron 或数据库，可单独测试。

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const AdmZip = require('adm-zip');
const CFB = require('cfb');
const iconv = require('iconv-lite');
const { PDFParse } = require('pdf-parse');
const { normalizeDocumentParseError } = require('../documentParseErrors.cjs');
const { now, stableFileId, getTenderFilesFromPayload, createSignature, hashFileSha256, hashText } = require('./fileSignature.cjs');
const { normalizeValue } = require('./tenderText.cjs');
const { isReadableSignalSnippet } = require('./markdownText.cjs');
const {
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
} = require('./metadataDecoders.cjs');

const metadataLabels = {
  file_name: '文件名',
  extension: '扩展名',
  size: '文件大小',
  file_sha256: '原始文件 SHA256',
  created_at: '文件创建时间',
  modified_at: '文件修改时间',
  accessed_at: '文件访问时间',
  title: '标题',
  subject: '主题',
  author: '作者',
  last_modified_by: '最后修改人',
  revision: '修订号',
  created: '创建时间',
  modified: '修改时间',
  last_printed: '最后打印时间',
  keywords: '关键词',
  category: '类别',
  description: '描述',
  content_status: '内容状态',
  content_type: '内容类型',
  identifier: '标识符',
  language: '语言',
  application: '应用程序',
  app_version: '应用程序版本',
  company: '公司',
  manager: '管理者',
  template: '模板',
  presentation_format: '演示格式',
  pages: '页数',
  words: '字数',
  characters: '字符数',
  characters_with_spaces: '含空格字符数',
  bytes: '字节数',
  lines: '行数',
  paragraphs: '段落数',
  slides: '幻灯片数',
  notes: '备注数',
  hidden_slides: '隐藏幻灯片数',
  multimedia_clips: '多媒体剪辑数',
  total_time: '编辑时长',
  code_page: '代码页',
  document_version: '文档版本',
  doc_security: '文档安全状态',
  shared_doc: '共享文档',
  links_dirty: '链接已变更',
  hlinks_changed: '超链接已变更',
  creator: '创建工具',
  producer: '生成工具',
  pdf_version: 'PDF 版本',
  pdf_permissions: 'PDF 权限',
  fingerprints: 'PDF 指纹',
  word_rsid_root: 'Word 编辑会话根 ID',
  word_rsid_count: 'Word 编辑会话 ID 数量',
  word_rsid_values: 'Word 编辑会话 ID 列表',
  word_rsid_fingerprint: 'Word 编辑会话指纹',
  ole_storage_count: 'OLE 存储数量',
  ole_stream_count: 'OLE Stream 数量',
  ole_stream_paths: 'OLE Stream 路径摘要',
  ole_stream_paths_fingerprint: 'OLE Stream 路径指纹',
  ole_stream_sizes_fingerprint: 'OLE Stream 大小指纹',
  ole_has_macro_storage: 'OLE 宏存储',
  ole_macro_paths: 'OLE 宏存储路径',
  pdf_header_version: 'PDF 头版本',
  pdf_object_count: 'PDF 对象数量',
  pdf_startxref_count: 'PDF startxref 数量',
  pdf_incremental_update_count: 'PDF 增量保存次数',
  pdf_linearized: 'PDF 线性化',
  pdf_xref_type: 'PDF XRef 类型',
  pdf_trailer_id: 'PDF Trailer ID',
  pdf_has_acroform: 'PDF 表单',
  pdf_has_xfa: 'PDF XFA 表单',
  pdf_signature_count: 'PDF 签名字段数量',
  pdf_byterange_signature_count: 'PDF ByteRange 签名数量',
  pdf_embedded_file_count: 'PDF 附件数量',
  pdf_embedded_file_names: 'PDF 附件文件名',
};

const comparableKeys = new Set([
  'title', 'subject', 'author', 'last_modified_by', 'revision', 'created', 'modified', 'last_printed', 'keywords',
  'category', 'description', 'content_status', 'content_type', 'identifier', 'language', 'application', 'app_version',
  'company', 'manager', 'template', 'presentation_format', 'pages', 'words', 'characters', 'characters_with_spaces',
  'bytes', 'lines', 'paragraphs', 'slides', 'notes', 'hidden_slides', 'multimedia_clips', 'total_time', 'creator',
  'producer', 'pdf_version', 'pdf_permissions', 'fingerprints', 'document_version', 'doc_security', 'shared_doc',
  'links_dirty', 'hlinks_changed',
  'file_sha256', 'word_rsid_root', 'word_rsid_count', 'word_rsid_values', 'word_rsid_fingerprint',
  'ole_storage_count', 'ole_stream_count', 'ole_stream_paths', 'ole_stream_paths_fingerprint', 'ole_stream_sizes_fingerprint',
  'ole_has_macro_storage', 'ole_macro_paths', 'pdf_header_version', 'pdf_object_count', 'pdf_startxref_count',
  'pdf_incremental_update_count', 'pdf_linearized', 'pdf_xref_type', 'pdf_trailer_id', 'pdf_has_acroform',
  'pdf_has_xfa', 'pdf_signature_count', 'pdf_byterange_signature_count', 'pdf_embedded_file_count', 'pdf_embedded_file_names',
]);

const dateComparableKeys = new Set(['created_at', 'modified_at', 'accessed_at', 'created', 'modified', 'last_printed']);

function normalizeComparable(value) {
  const text = normalizeValue(value).toLowerCase();
  if (!text || ['没有提及', '原文未提及', '-', '无', 'null', 'undefined'].includes(text)) return '';
  const date = new Date(text.replace(/^d:/i, '').replace(/([+-]\d{2})'(\d{2})'$/, '$1:$2'));
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return text.replace(/[\s　\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]+/g, '');
}

function normalizeDateDay(value) {
  const text = normalizeValue(value);
  if (!text) return '';
  const date = new Date(text.replace(/^d:/i, '').replace(/([+-]\d{2})'(\d{2})'$/, '$1:$2'));
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  const match = text.match(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/);
  return match ? match[0].replace(/[年月/.]/g, '-').replace(/日/g, '') : '';
}

function addField(fields, key, value) {
  const text = normalizeValue(value);
  if (!text) return;
  fields.set(key, text);
}

function addFieldIfAbsent(fields, key, value) {
  if (fields.has(key)) return;
  addField(fields, key, value);
}

function addListField(fields, key, value) {
  const text = normalizeValue(value);
  if (!text) return;
  const current = fields.get(key);
  if (!current) {
    fields.set(key, text);
    return;
  }
  const parts = current.split('；').map((item) => item.trim()).filter(Boolean);
  if (!parts.includes(text)) fields.set(key, `${current}；${text}`);
}

function safeMetadataKey(value) {
  return normalizeValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'field';
}

function formatMetadataKey(key) {
  return String(key || '').replace(/[_:]+/g, ' ').trim() || String(key || '');
}

function getMetadataLabel(key) {
  if (metadataLabels[key]) return metadataLabels[key];
  if (key.startsWith('converted_docx:')) return `转换 DOCX：${getMetadataLabel(key.slice('converted_docx:'.length))}`;
  if (key.startsWith('custom:') && key.endsWith(':base64_decoded')) return `自定义：${key.slice('custom:'.length, -':base64_decoded'.length)}（Base64 解码）`;
  if (key.startsWith('custom:')) return `自定义：${key.slice('custom:'.length)}`;
  if (key.endsWith(':base64_decoded')) return `${getMetadataLabel(key.slice(0, -':base64_decoded'.length))}（Base64 解码）`;
  if (key.startsWith('pdf_info:')) return `PDF Info：${formatMetadataKey(key.slice('pdf_info:'.length))}`;
  if (key.startsWith('pdf_xmp:')) return `PDF XMP：${formatMetadataKey(key.slice('pdf_xmp:'.length))}`;
  if (key.startsWith('pdf_raw:')) return `PDF 原始记录：${formatMetadataKey(key.slice('pdf_raw:'.length))}`;
  if (key.startsWith('ole_signal:')) return `OLE 疑似痕迹：${formatMetadataKey(key.slice('ole_signal:'.length))}`;
  if (key.startsWith('wps:')) return `疑似 WPS 用户/账号：${formatMetadataKey(key.slice('wps:'.length))}`;
  return formatMetadataKey(key);
}

function isDateComparableKey(key) {
  if (dateComparableKeys.has(key)) return true;
  const normalized = String(key || '').toLowerCase();
  if (/last[_-]?modified[_-]?by|lastmodifiedby/.test(normalized)) return false;
  return /(^|[:_])(created|modified|last_printed|creationdate|moddate|createdate|modifydate|metadatadate|lastsaved|lastprinted)([:_]|$)/.test(normalized);
}

function isComparableKey(key) {
  return comparableKeys.has(key)
    || isDateComparableKey(key)
    || key.startsWith('custom:')
    || key.startsWith('converted_docx:')
    || key.startsWith('pdf_info:')
    || key.startsWith('pdf_xmp:')
    || key.startsWith('pdf_raw:')
    || key.startsWith('ole_signal:')
    || key.startsWith('wps:');
}

function tryDecodeBase64Text(value) {
  const text = normalizeValue(value);
  if (!text || text.length < 12 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return '';
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!decoded || decoded === text || decoded.includes('\uFFFD') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded)) return '';
    try {
      return JSON.stringify(JSON.parse(decoded));
    } catch {
      return decoded;
    }
  } catch {
    return '';
  }
}

function shouldSkipBase64Decode(key, value) {
  const normalizedKey = String(key || '').toLowerCase();
  if (/(^|[:_])(sha256|sha1|md5|hash|fingerprint)([:_]|$)/.test(normalizedKey)) return true;
  return /^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$|^[0-9a-f]{128}$/i.test(normalizeValue(value));
}

function addDecodedBase64Fields(fields) {
  for (const [key, value] of Array.from(fields.entries())) {
    if (key.endsWith(':base64_decoded')) continue;
    if (shouldSkipBase64Decode(key, value)) continue;
    const decoded = tryDecodeBase64Text(value);
    if (decoded) addField(fields, `${key}:base64_decoded`, decoded);
  }
}

function yesNo(value) {
  return value ? '是' : '否';
}

function countMatches(value, pattern) {
  const text = String(value || '');
  const regexp = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  while (regexp.exec(text)) count += 1;
  return count;
}

function uniqueSortedValues(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((item) => normalizeValue(item))
    .filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
}

function summarizeValues(values, limit = 80) {
  const sorted = uniqueSortedValues(values);
  if (!sorted.length) return '';
  const visible = sorted.slice(0, limit).join('；');
  return sorted.length > limit ? `${visible}；...共${sorted.length}项` : visible;
}

function xmlText(xml, tagName) {
  const pattern = new RegExp(`<[^:>]*:?${tagName}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tagName}>`, 'i');
  const match = String(xml || '').match(pattern);
  return match ? decodeXml(match[1]) : '';
}

function formatDocxTotalTime(value) {
  const text = normalizeValue(value);
  if (!text) return '';
  return /^\d+$/.test(text) ? `${text} 分钟` : text;
}

function addDocxRsidFields(fields, zip) {
  const values = new Set();
  let root = '';
  const entries = zip.getEntries().filter((entry) => /^word\/.*\.xml$/i.test(entry.entryName || ''));
  const rsidPattern = /\b(?:[A-Za-z0-9_]+:)?(rsid[A-Za-z0-9]*)=["']([0-9A-Fa-f]{1,16})["']/g;

  for (const entry of entries) {
    const xml = entry.getData().toString('utf8');
    let match;
    while ((match = rsidPattern.exec(xml))) {
      const attr = String(match[1] || '').toLowerCase();
      const value = String(match[2] || '').toUpperCase();
      if (!value) continue;
      values.add(value);
      if (attr === 'rsidroot' && !root) root = value;
    }
  }

  const sorted = uniqueSortedValues(Array.from(values));
  addField(fields, 'word_rsid_root', root);
  addField(fields, 'word_rsid_count', sorted.length);
  addField(fields, 'word_rsid_values', summarizeValues(sorted));
  if (sorted.length) addField(fields, 'word_rsid_fingerprint', hashText(sorted.join('\n')));
}

const SUMMARY_PROPERTY_MAP = {
  0x01: { key: 'code_page' },
  0x02: { key: 'title' },
  0x03: { key: 'subject' },
  0x04: { key: 'author' },
  0x05: { key: 'keywords' },
  0x06: { key: 'description' },
  0x07: { key: 'template' },
  0x08: { key: 'last_modified_by' },
  0x09: { key: 'revision' },
  0x0a: { key: 'total_time', kind: 'duration_filetime' },
  0x0b: { key: 'last_printed' },
  0x0c: { key: 'created' },
  0x0d: { key: 'modified' },
  0x0e: { key: 'pages' },
  0x0f: { key: 'words' },
  0x10: { key: 'characters' },
  0x12: { key: 'application' },
  0x13: { key: 'doc_security' },
};

const DOC_SUMMARY_PROPERTY_MAP = {
  0x01: { key: 'code_page' },
  0x02: { key: 'category' },
  0x03: { key: 'presentation_format' },
  0x04: { key: 'bytes' },
  0x05: { key: 'lines' },
  0x06: { key: 'paragraphs' },
  0x07: { key: 'slides' },
  0x08: { key: 'notes' },
  0x09: { key: 'hidden_slides' },
  0x0a: { key: 'multimedia_clips' },
  0x0b: { key: 'scale_crop' },
  0x0c: { key: 'heading_pairs' },
  0x0d: { key: 'titles_of_parts' },
  0x0e: { key: 'manager' },
  0x0f: { key: 'company' },
  0x10: { key: 'links_dirty' },
  0x11: { key: 'characters_with_spaces' },
  0x13: { key: 'shared_doc' },
  0x16: { key: 'hlinks_changed' },
  0x17: { key: 'app_version', kind: 'version' },
  0x1a: { key: 'content_type' },
  0x1b: { key: 'content_status' },
  0x1c: { key: 'language' },
  0x1d: { key: 'document_version' },
};

function decodeCodePageBuffer(buffer, codePage) {
  const encoding = codePageToEncoding(codePage);
  try {
    return iconv.decode(buffer, encoding);
  } catch {
    return buffer.toString('latin1');
  }
}

function parseFileTimeValue(buffer, offset) {
  const low = readUInt32LE(buffer, offset);
  const high = readUInt32LE(buffer, offset + 4);
  if (!low && !high) return '';
  const ticks = (BigInt(high) << 32n) + BigInt(low);
  const unixMs = ticks / 10000n - 11644473600000n;
  const date = new Date(Number(unixMs));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function parseFileTimeDuration(buffer, offset) {
  const low = readUInt32LE(buffer, offset);
  const high = readUInt32LE(buffer, offset + 4);
  const ticks = (BigInt(high) << 32n) + BigInt(low);
  if (!ticks) return '';
  const seconds = Number(ticks / 10000000n);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
}

function parseLpstr(buffer, offset, codePage, padded = true) {
  const length = readUInt32LE(buffer, offset);
  const start = offset + 4;
  const byteLength = Math.max(0, Math.min(length, buffer.length - start));
  const raw = buffer.subarray(start, start + byteLength);
  return {
    value: cleanOleString(decodeCodePageBuffer(raw, codePage)),
    nextOffset: padded ? align4(start + byteLength) : start + byteLength,
  };
}

function parseLpwstr(buffer, offset, padded = true) {
  const charLength = readUInt32LE(buffer, offset);
  const start = offset + 4;
  const byteLength = Math.max(0, Math.min(charLength * 2, buffer.length - start));
  const raw = buffer.subarray(start, start + byteLength);
  return {
    value: cleanOleString(raw.toString('utf16le')),
    nextOffset: padded ? align4(start + byteLength) : start + byteLength,
  };
}

function parseVectorStringValue(buffer, offset, type, codePage) {
  const count = readUInt32LE(buffer, offset);
  let cursor = offset + 4;
  const values = [];
  for (let index = 0; index < count && cursor < buffer.length; index += 1) {
    const parsed = type === 0x101f ? parseLpwstr(buffer, cursor, true) : parseLpstr(buffer, cursor, codePage, false);
    if (parsed.value) values.push(parsed.value);
    cursor = parsed.nextOffset;
  }
  return { value: values, nextOffset: cursor };
}

function parseVectorVariantValue(buffer, offset, codePage) {
  const count = readUInt32LE(buffer, offset);
  let cursor = offset + 4;
  const values = [];
  for (let index = 0; index < count && cursor < buffer.length; index += 1) {
    const parsed = parseTypedPropertyValue(buffer, cursor, codePage);
    if (parsed.value !== '') values.push(parsed.value);
    cursor = parsed.nextOffset;
  }
  return { value: values, nextOffset: cursor };
}

function parseTypedPropertyValue(buffer, offset, codePage = 1252) {
  const type = readUInt16LE(buffer, offset);
  const valueOffset = offset + 4;
  if (!type || valueOffset > buffer.length) return { type, value: '', nextOffset: valueOffset };

  if (type === 0x02) return { type, value: readInt16LE(buffer, valueOffset), nextOffset: align4(valueOffset + 2) };
  if (type === 0x03) return { type, value: readInt32LE(buffer, valueOffset), nextOffset: valueOffset + 4 };
  if (type === 0x05) return { type, value: buffer.readDoubleLE(valueOffset), nextOffset: valueOffset + 8 };
  if (type === 0x0b) return { type, value: readUInt32LE(buffer, valueOffset) !== 0, nextOffset: valueOffset + 4 };
  if (type === 0x13) return { type, value: readUInt32LE(buffer, valueOffset), nextOffset: valueOffset + 4 };
  if (type === 0x1e) return { type, ...parseLpstr(buffer, valueOffset, codePage, true) };
  if (type === 0x1f) return { type, ...parseLpwstr(buffer, valueOffset, true) };
  if (type === 0x40) return { type, value: parseFileTimeValue(buffer, valueOffset), nextOffset: valueOffset + 8 };
  if (type === 0x50) return { type, ...parseLpwstr(buffer, valueOffset, true) };
  if (type === 0x51) return { type, ...parseLpwstr(buffer, valueOffset, false) };
  if (type === 0x101e || type === 0x101f) return { type, ...parseVectorStringValue(buffer, valueOffset, type, codePage) };
  if (type === 0x100c) return { type, ...parseVectorVariantValue(buffer, valueOffset, codePage) };
  if (type === 0x41) {
    const size = readUInt32LE(buffer, valueOffset);
    return { type, value: size ? `BLOB ${size} bytes` : '', nextOffset: align4(valueOffset + 4 + size) };
  }
  return { type, value: '', nextOffset: valueOffset + 4 };
}

function parsePropertyDictionary(buffer, offset, codePage) {
  const count = readUInt32LE(buffer, offset);
  const dictionary = new Map();
  let cursor = offset + 4;
  for (let index = 0; index < count && cursor + 8 <= buffer.length; index += 1) {
    const propertyId = readUInt32LE(buffer, cursor);
    const length = readUInt32LE(buffer, cursor + 4);
    cursor += 8;
    let byteLength = codePage === 1200 ? length * 2 : length;
    if (cursor + byteLength > buffer.length) byteLength = Math.max(0, Math.min(length, buffer.length - cursor));
    const raw = buffer.subarray(cursor, cursor + byteLength);
    const value = codePage === 1200 ? cleanOleString(raw.toString('utf16le')) : cleanOleString(decodeCodePageBuffer(raw, codePage));
    if (value) dictionary.set(propertyId, value.replace(/^\u0005/, '!'));
    cursor = align4(cursor + byteLength);
  }
  return dictionary;
}

function formatVersionNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return `${number >>> 16}.${String(number & 0xffff).padStart(4, '0')}`;
}

function parsePropertySet(buffer, offset, propertyMap = {}) {
  const size = readUInt32LE(buffer, offset);
  const count = readUInt32LE(buffer, offset + 4);
  const entries = [];
  for (let index = 0; index < count && offset + 8 + index * 8 + 8 <= buffer.length; index += 1) {
    entries.push({ id: readUInt32LE(buffer, offset + 8 + index * 8), offset: offset + readUInt32LE(buffer, offset + 12 + index * 8) });
  }

  let codePage = 1252;
  const codePageEntry = entries.find((entry) => entry.id === 0x01);
  if (codePageEntry) {
    const parsedCodePage = parseTypedPropertyValue(buffer, codePageEntry.offset, codePage).value;
    if (parsedCodePage) codePage = Number(parsedCodePage) || codePage;
  }

  const dictionaryEntry = entries.find((entry) => entry.id === 0x00);
  const dictionary = dictionaryEntry ? parsePropertyDictionary(buffer, dictionaryEntry.offset, codePage) : new Map();
  const fields = new Map();
  const endOffset = size ? offset + size : buffer.length;

  for (const entry of entries) {
    if (entry.id === 0x00 || entry.offset >= endOffset || entry.offset >= buffer.length) continue;
    const propertyInfo = propertyMap[entry.id];
    const parsed = parseTypedPropertyValue(buffer, entry.offset, codePage);
    let value = propertyInfo?.kind === 'duration_filetime' && parsed.type === 0x40
      ? parseFileTimeDuration(buffer, entry.offset + 4)
      : parsed.value;
    if (propertyInfo?.kind === 'version') value = formatVersionNumber(value);
    const name = propertyInfo?.key || (dictionary.get(entry.id) ? `custom:${dictionary.get(entry.id)}` : `ole_prop_${entry.id}`);
    addField(fields, name, value);
  }
  return fields;
}

function parsePropertySetStream(content, propertyMap) {
  const buffer = Buffer.from(content || []);
  const fields = new Map();
  if (buffer.length < 48 || readUInt16LE(buffer, 0) !== 0xfffe) return fields;
  const setCount = readUInt32LE(buffer, 24);
  for (let index = 0; index < setCount && 28 + index * 20 + 20 <= buffer.length; index += 1) {
    const setOffset = readUInt32LE(buffer, 28 + index * 20 + 16);
    if (!setOffset || setOffset >= buffer.length) continue;
    const parsed = parsePropertySet(buffer, setOffset, index === 0 ? propertyMap : {});
    for (const [key, value] of parsed.entries()) addField(fields, key, value);
  }
  return fields;
}

function findCfbEntry(cfb, streamName) {
  const bangName = streamName.replace(/^\u0005/, '!');
  const candidates = [streamName, `/${streamName}`, bangName, `/${bangName}`];
  for (const candidate of candidates) {
    const entry = CFB.find(cfb, candidate);
    if (entry?.content) return entry;
  }
  return null;
}

const rawSignalPattern = /(kingsoft|wps office|\bwps\b|\bkso\b|account|e-mail|email|mail|userid|user id|user_id|uid|账号|金山)/ig;

function collectSignalSnippets(value, limit = 5) {
  const text = String(value || '').replace(/\u0000/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]+/g, ' ');
  const snippets = [];
  rawSignalPattern.lastIndex = 0;
  let match;
  while ((match = rawSignalPattern.exec(text)) && snippets.length < limit) {
    const start = Math.max(0, (match.index || 0) - 40);
    const end = Math.min(text.length, (match.index || 0) + match[0].length + 80);
    const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (isReadableSignalSnippet(snippet) && !snippets.includes(snippet)) snippets.push(snippet);
  }
  return snippets;
}

function collectBinarySignalSnippets(content) {
  const buffer = Buffer.from(content || []).subarray(0, 1024 * 1024);
  const candidates = [buffer.toString('utf16le'), decodeCodePageBuffer(buffer, 936), buffer.toString('utf8')];
  const snippets = [];
  for (const text of candidates) {
    for (const snippet of collectSignalSnippets(text, 3)) {
      if (!snippets.includes(snippet)) snippets.push(snippet);
      if (snippets.length >= 5) return snippets;
    }
  }
  return snippets;
}

function addOleSignalFields(fields, cfb) {
  for (let index = 0; index < cfb.FileIndex.length; index += 1) {
    const entry = cfb.FileIndex[index];
    const fullPath = cfb.FullPaths[index] || entry.name || `stream_${index}`;
    const signalKey = `ole_signal:${safeMetadataKey(fullPath)}`;
    for (const snippet of collectSignalSnippets(fullPath, 2)) addListField(fields, signalKey, snippet);
    if (entry?.content?.length && !isOlePropertySetStreamName(fullPath)) {
      for (const snippet of collectBinarySignalSnippets(entry.content)) addListField(fields, signalKey, snippet);
    }
  }
}

function addOleStructureFields(fields, cfb) {
  const entries = cfb.FileIndex.map((entry, index) => ({
    entry,
    path: normalizeValue(cfb.FullPaths[index] || entry.name || `stream_${index}`),
  })).filter((item) => item.path);
  const streamEntries = entries.filter((item) => item.entry?.type === 2 || item.entry?.content);
  const storageEntries = entries.filter((item) => item.entry?.type === 1);
  const streamPaths = streamEntries.map((item) => item.path.replace(/^\/Root Entry\/?/i, ''));
  const streamSizes = streamEntries.map((item) => `${item.path}:${item.entry?.content?.length || item.entry?.size || 0}`);
  const macroPaths = streamPaths.filter((item) => /(^|[\/\\])(?:vba|macros?|vbaProject\.bin|dir)([\/\\]|$)/i.test(item));

  addField(fields, 'ole_storage_count', storageEntries.length);
  addField(fields, 'ole_stream_count', streamEntries.length);
  addField(fields, 'ole_stream_paths', summarizeValues(streamPaths, 120));
  if (streamPaths.length) addField(fields, 'ole_stream_paths_fingerprint', hashText(uniqueSortedValues(streamPaths).join('\n')));
  if (streamSizes.length) addField(fields, 'ole_stream_sizes_fingerprint', hashText(uniqueSortedValues(streamSizes).join('\n')));
  addField(fields, 'ole_has_macro_storage', yesNo(macroPaths.length > 0));
  addField(fields, 'ole_macro_paths', summarizeValues(macroPaths, 40));
}

function addWpsSignalFields(fields) {
  const entries = Array.from(fields.entries());
  for (const [key, value] of entries) {
    if (key.startsWith('wps:')) continue;
    const haystack = `${key} ${value}`;
    if (!collectSignalSnippets(haystack, 1).length) continue;
    addListField(fields, `wps:${safeMetadataKey(key)}`, value);
  }
}

async function extractDocxMetadata(filePath) {
  const zip = new AdmZip(filePath);
  const fields = new Map();
  const core = readZipText(zip, 'docProps/core.xml');
  const app = readZipText(zip, 'docProps/app.xml');
  const custom = readZipText(zip, 'docProps/custom.xml');

  addField(fields, 'title', xmlText(core, 'title'));
  addField(fields, 'subject', xmlText(core, 'subject'));
  addField(fields, 'author', xmlText(core, 'creator'));
  addField(fields, 'last_modified_by', xmlText(core, 'lastModifiedBy'));
  addField(fields, 'revision', xmlText(core, 'revision'));
  addField(fields, 'created', xmlText(core, 'created'));
  addField(fields, 'modified', xmlText(core, 'modified'));
  addField(fields, 'keywords', xmlText(core, 'keywords'));
  addField(fields, 'category', xmlText(core, 'category'));
  addField(fields, 'description', xmlText(core, 'description'));
  addField(fields, 'application', xmlText(app, 'Application'));
  addField(fields, 'app_version', xmlText(app, 'AppVersion'));
  addField(fields, 'company', xmlText(app, 'Company'));
  addField(fields, 'manager', xmlText(app, 'Manager'));
  addField(fields, 'template', xmlText(app, 'Template'));
  addField(fields, 'pages', xmlText(app, 'Pages'));
  addField(fields, 'words', xmlText(app, 'Words'));
  addField(fields, 'characters', xmlText(app, 'Characters'));
  addField(fields, 'lines', xmlText(app, 'Lines'));
  addField(fields, 'paragraphs', xmlText(app, 'Paragraphs'));
  addField(fields, 'total_time', formatDocxTotalTime(xmlText(app, 'TotalTime')));

  for (const match of custom.matchAll(/<property\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/property>/gi)) {
    const key = `custom:${decodeXml(match[1])}`;
    const valueMatch = match[2].match(/<[^>]+>([\s\S]*?)<\/[^>]+>/);
    addField(fields, key, valueMatch ? decodeXml(valueMatch[1]) : decodeXml(match[2]));
  }

  addDocxRsidFields(fields, zip);
  addWpsSignalFields(fields);
  return fields;
}

async function extractOleMetadata(filePath) {
  const buffer = await fs.readFile(filePath);
  const cfb = CFB.read(buffer, { type: 'buffer' });
  const fields = new Map();
  const summary = findCfbEntry(cfb, '\u0005SummaryInformation');
  const documentSummary = findCfbEntry(cfb, '\u0005DocumentSummaryInformation');

  if (summary) {
    for (const [key, value] of parsePropertySetStream(summary.content, SUMMARY_PROPERTY_MAP).entries()) addField(fields, key, value);
  }
  if (documentSummary) {
    for (const [key, value] of parsePropertySetStream(documentSummary.content, DOC_SUMMARY_PROPERTY_MAP).entries()) addField(fields, key, value);
  }
  addOleStructureFields(fields, cfb);
  addOleSignalFields(fields, cfb);
  addWpsSignalFields(fields);
  return fields;
}

async function extractConvertedDocxMetadata(filePath) {
  const converterUrl = pathToFileURL(path.join(__dirname, 'doc2markdown', 'convert.mjs')).href;
  const { withLegacyWordDocxFile } = await import(converterUrl);
  try {
    return await withLegacyWordDocxFile(filePath, (docxPath) => extractDocxMetadata(docxPath));
  } catch (error) {
    throw normalizeDocumentParseError(error, filePath);
  }
}

function mergeMetadataFields(target, source, options = {}) {
  for (const [key, value] of source.entries()) {
    if (options.fillOnlyIfAbsent) addFieldIfAbsent(target, key, value);
    else addField(target, key, value);
    if (options.prefix) addField(target, `${options.prefix}:${key}`, value);
  }
}

async function hasZipHeader(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4);
    const result = await handle.read(buffer, 0, 4, 0);
    return result.bytesRead >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  } finally {
    await handle.close();
  }
}

async function extractLegacyWordMetadata(filePath) {
  const fields = new Map();
  const errors = [];
  try {
    mergeMetadataFields(fields, await extractOleMetadata(filePath));
  } catch (error) {
    errors.push(`OLE 元数据读取失败：${error.message || error}`);
  }

  try {
    mergeMetadataFields(fields, await extractConvertedDocxMetadata(filePath), {
      fillOnlyIfAbsent: true,
      prefix: 'converted_docx',
    });
  } catch (error) {
    errors.push(`转换 DOCX 元数据读取失败：${error.message || error}`);
  }

  if (errors.length) addListField(fields, 'metadata_error', errors.join('；'));
  addWpsSignalFields(fields);
  return fields;
}

const PDF_INFO_KEY_MAP = {
  Title: 'title',
  Author: 'author',
  Subject: 'subject',
  Keywords: 'keywords',
  Creator: 'creator',
  Producer: 'producer',
  CreationDate: 'created',
  ModDate: 'modified',
  PDFFormatVersion: 'pdf_version',
};

function getPdfMetadataValue(metadata, ...names) {
  if (!metadata) return '';
  for (const name of names) {
    if (typeof metadata.get === 'function') {
      const value = metadata.get(name);
      if (normalizeValue(value)) return value;
    }
    if (Object.prototype.hasOwnProperty.call(metadata, name) && normalizeValue(metadata[name])) return metadata[name];
  }
  return '';
}

function getPdfMetadataEntries(metadata) {
  if (!metadata) return [];
  if (typeof metadata[Symbol.iterator] === 'function') return Array.from(metadata);
  return Object.entries(metadata).filter(([, value]) => normalizeValue(value));
}

function addPdfInfoFields(fields, info) {
  for (const [rawKey, value] of Object.entries(info || {})) {
    const text = normalizeValue(value);
    if (!text) continue;
    if (PDF_INFO_KEY_MAP[rawKey]) addField(fields, PDF_INFO_KEY_MAP[rawKey], text);
    addField(fields, `pdf_info:${safeMetadataKey(rawKey)}`, text);
  }
}

function addPdfXmpFields(fields, metadata) {
  for (const [rawKey, value] of getPdfMetadataEntries(metadata)) {
    const text = normalizeValue(value);
    if (!text) continue;
    const canonical = canonicalPdfXmpKey(rawKey);
    if (canonical) addFieldIfAbsent(fields, canonical, text);
    addField(fields, `pdf_xmp:${safeMetadataKey(rawKey)}`, text);
  }

  const raw = typeof metadata?.getRaw === 'function' ? metadata.getRaw() : '';
  for (const snippet of collectSignalSnippets(raw, 5)) addListField(fields, 'pdf_xmp:raw_signals', snippet);
}

function decodePdfStringBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return decodeUtf16Be(buffer.subarray(2));
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  const utf8 = buffer.toString('utf8').trim();
  return utf8 || buffer.toString('latin1').trim();
}

function decodePdfLiteralString(value) {
  let text = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      text += char;
      continue;
    }
    const next = value[index + 1];
    if (!next) continue;
    index += 1;
    if (next === 'n') text += '\n';
    else if (next === 'r') text += '\r';
    else if (next === 't') text += '\t';
    else if (next === 'b') text += '\b';
    else if (next === 'f') text += '\f';
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let count = 0; count < 2 && /[0-7]/.test(value[index + 1] || ''); count += 1) octal += value[++index];
      text += String.fromCharCode(parseInt(octal, 8));
    } else {
      text += next;
    }
  }
  return decodePdfStringBuffer(Buffer.from(text, 'latin1'));
}

function decodePdfHexString(value) {
  const hex = value.replace(/\s+/g, '');
  if (!hex || hex.length % 2 !== 0) return '';
  try {
    return decodePdfStringBuffer(Buffer.from(hex, 'hex'));
  } catch {
    return '';
  }
}

function addPdfRawFields(fields, buffer) {
  const text = buffer.toString('latin1');
  const pattern = /\/(Title|Author|Subject|Keywords|Creator|Producer|CreationDate|ModDate)\s*(\((?:\\.|[^\\)]){0,1000}\)|<([0-9a-fA-F\s]{2,2000})>)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const rawKey = match[1];
    const rawValue = match[3] ? decodePdfHexString(match[3]) : decodePdfLiteralString(match[2].slice(1, -1));
    addListField(fields, `pdf_raw:${safeMetadataKey(rawKey)}`, rawValue);
  }
  for (const snippet of collectBinarySignalSnippets(buffer)) addListField(fields, 'pdf_raw:signals', snippet);
}

function decodePdfTokenString(token) {
  const value = String(token || '').trim();
  if (!value) return '';
  if (value.startsWith('(') && value.endsWith(')')) return decodePdfLiteralString(value.slice(1, -1));
  if (value.startsWith('<') && value.endsWith('>')) return decodePdfHexString(value.slice(1, -1));
  if (value.startsWith('/')) return decodePdfName(value.slice(1));
  return value;
}

function normalizePdfIdToken(token) {
  const value = String(token || '').trim();
  if (value.startsWith('<') && value.endsWith('>')) return `<${value.slice(1, -1).replace(/\s+/g, '').toLowerCase()}>`;
  return decodePdfTokenString(value);
}

function extractPdfTrailerIds(text) {
  const ids = [];
  const pattern = /\/ID\s*\[\s*(<[^>\r\n]{1,512}>|\((?:\\.|[^\\)]){0,512}\))\s*(<[^>\r\n]{1,512}>|\((?:\\.|[^\\)]){0,512}\))/g;
  let match;
  while ((match = pattern.exec(text))) {
    const first = normalizePdfIdToken(match[1]);
    const second = normalizePdfIdToken(match[2]);
    if (first || second) ids.push([first, second].filter(Boolean).join(' / '));
  }
  return uniqueSortedValues(ids);
}

function extractPdfAttachmentNames(text) {
  const names = [];
  const filespecPattern = /\/Type\s*\/Filespec\b/g;
  const stringToken = '(\\((?:\\\\.|[^\\\\)]){0,500}\\)|<[0-9a-fA-F\\s]{2,1000}>|\/[^\\s<>\\[\\]()/]{1,300})';
  const ufPattern = new RegExp(`/UF\\s*${stringToken}`);
  const fPattern = new RegExp(`/F\\s*${stringToken}`);
  let match;
  while ((match = filespecPattern.exec(text))) {
    const chunk = text.slice(match.index, Math.min(text.length, match.index + 2200));
    const nameMatch = chunk.match(ufPattern) || chunk.match(fPattern);
    const name = decodePdfTokenString(nameMatch?.[1] || '');
    if (name) names.push(name);
  }
  return uniqueSortedValues(names);
}

function addPdfStructureFields(fields, buffer) {
  const text = buffer.toString('latin1');
  const headerVersion = text.slice(0, 1024).match(/%PDF-(\d\.\d)/)?.[1] || '';
  const objectCount = countMatches(text, /(?:^|[\r\n])\s*\d+\s+\d+\s+obj\b/g);
  const startxrefCount = countMatches(text, /(?:^|[\r\n])startxref\b/g);
  const hasClassicXref = /(?:^|[\r\n])xref(?:\s|[\r\n])/.test(text);
  const xrefStreamCount = countMatches(text, /\/Type\s*\/XRef\b/g);
  const xrefTypes = [];
  if (hasClassicXref) xrefTypes.push('传统 xref 表');
  if (xrefStreamCount) xrefTypes.push('XRef 对象流');

  addField(fields, 'pdf_header_version', headerVersion);
  addField(fields, 'pdf_object_count', objectCount);
  addField(fields, 'pdf_startxref_count', startxrefCount);
  addField(fields, 'pdf_incremental_update_count', Math.max(0, startxrefCount - 1));
  addField(fields, 'pdf_linearized', yesNo(/\/Linearized\s+\d/.test(text.slice(0, 4096))));
  addField(fields, 'pdf_xref_type', xrefTypes.join('；') || '未识别');
  addField(fields, 'pdf_trailer_id', summarizeValues(extractPdfTrailerIds(text), 8));
}

function addPdfFormSignatureAttachmentFields(fields, buffer) {
  const text = buffer.toString('latin1');
  const byteRangeSignatureCount = countMatches(text, /\/ByteRange\s*\[/g);
  const signatureFieldCount = countMatches(text, /\/FT\s*\/Sig\b/g);
  const signatureObjectCount = countMatches(text, /\/Type\s*\/Sig\b/g);
  const embeddedFileCount = countMatches(text, /\/Type\s*\/EmbeddedFile\b/g);
  const attachmentNames = extractPdfAttachmentNames(text);

  addField(fields, 'pdf_has_acroform', yesNo(/\/AcroForm\b/.test(text)));
  addField(fields, 'pdf_has_xfa', yesNo(/\/XFA\b/.test(text)));
  addField(fields, 'pdf_signature_count', Math.max(signatureFieldCount, signatureObjectCount, byteRangeSignatureCount));
  addField(fields, 'pdf_byterange_signature_count', byteRangeSignatureCount);
  addField(fields, 'pdf_embedded_file_count', Math.max(embeddedFileCount, attachmentNames.length));
  addField(fields, 'pdf_embedded_file_names', summarizeValues(attachmentNames, 40));
}

async function extractPdfMetadata(filePath) {
  const buffer = await fs.readFile(filePath);
  const parser = new PDFParse({ data: buffer });
  const fields = new Map();
  try {
    const result = await parser.getInfo();
    const info = result.info || {};
    const metadata = result.metadata || null;
    addPdfInfoFields(fields, info);
    addPdfXmpFields(fields, metadata);
    addFieldIfAbsent(fields, 'title', getPdfMetadataValue(metadata, 'dc:title', 'Title'));
    addFieldIfAbsent(fields, 'author', getPdfMetadataValue(metadata, 'dc:creator', 'Author'));
    addFieldIfAbsent(fields, 'subject', getPdfMetadataValue(metadata, 'dc:subject', 'Subject'));
    addFieldIfAbsent(fields, 'keywords', getPdfMetadataValue(metadata, 'pdf:Keywords', 'Keywords'));
    addFieldIfAbsent(fields, 'creator', getPdfMetadataValue(metadata, 'xmp:CreatorTool', 'Creator'));
    addFieldIfAbsent(fields, 'producer', getPdfMetadataValue(metadata, 'pdf:Producer', 'Producer'));
    addFieldIfAbsent(fields, 'created', getPdfMetadataValue(metadata, 'xmp:CreateDate', 'CreationDate'));
    addFieldIfAbsent(fields, 'modified', getPdfMetadataValue(metadata, 'xmp:ModifyDate', 'xmp:MetadataDate', 'ModDate'));
    addField(fields, 'pages', result.total || result.pages || result.numpages);
    addField(fields, 'pdf_version', result.version || info.PDFFormatVersion);
    addField(fields, 'fingerprints', result.fingerprints);
    addField(fields, 'pdf_permissions', result.permission);
    addPdfRawFields(fields, buffer);
    addPdfStructureFields(fields, buffer);
    addPdfFormSignatureAttachmentFields(fields, buffer);
    addWpsSignalFields(fields);
  } finally {
    await parser.destroy();
  }
  return fields;
}

async function extractMetadata(file) {
  const fields = new Map();
  const stats = await fs.stat(file.file_path);
  addField(fields, 'file_name', file.file_name);
  addField(fields, 'extension', file.extension);
  addField(fields, 'size', file.size || stats.size);
  addField(fields, 'created_at', stats.birthtime.toISOString());
  addField(fields, 'modified_at', stats.mtime.toISOString());
  addField(fields, 'accessed_at', stats.atime.toISOString());
  addField(fields, 'file_sha256', await hashFileSha256(file.file_path));

  try {
    const extension = String(file.extension || '').toLowerCase();
    if (extension === '.docx' || ((extension === '.doc' || extension === '.wps') && await hasZipHeader(file.file_path))) {
      mergeMetadataFields(fields, await extractDocxMetadata(file.file_path));
    } else if (extension === '.doc' || extension === '.wps') {
      mergeMetadataFields(fields, await extractLegacyWordMetadata(file.file_path));
    } else if (extension === '.pdf') {
      mergeMetadataFields(fields, await extractPdfMetadata(file.file_path));
    }
  } catch (error) {
    addField(fields, 'metadata_error', error.message || '元数据读取失败');
  }

  addDecodedBase64Fields(fields);
  return Array.from(fields.entries()).map(([key, value]) => ({
    key,
    label: getMetadataLabel(key),
    value,
    normalized: normalizeComparable(value),
    date_day: normalizeDateDay(value),
    comparable: isComparableKey(key),
    date_comparable: isDateComparableKey(key),
  }));
}

module.exports = { extractMetadata };
