const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const AdmZip = require('adm-zip');
const CFB = require('cfb');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { PDFParse } = require('pdf-parse');
const { getDuplicateCheckContentDir, getGeneratedImagesDir, getImportedImagesDir } = require('../utils/paths.cjs');
const { compactLogError, createDeveloperLogger, textMetrics } = require('../utils/developerLog.cjs');
const { normalizeDocumentParseError } = require('./documentParseErrors.cjs');
const { parseDocumentWithConfig } = require('./fileService.cjs');
const {
  intersectSize,
  lcsSimilarity,
  riskFromScore,
  charBigramsFromLooseText,
  diceSimilarityFromShared,
} = require('./duplicates/similarity.cjs');
const {
  normalizeValue,
  stripMarkdownForOutline,
  inferOutlineLevel,
  isCatalogTitleLine,
  normalizeContentLineBreaks,
  splitMarkdownTableRow,
  stripLeadingContentSequence,
  cleanContentSentence,
  isInformativeContentSentence,
  stripTenderTablePrefix,
  stripTenderDirectoryPageTail,
  normalizeTenderFieldName,
} = require('./duplicates/tenderText.cjs');
const {
  now,
  stableFileId,
  getTenderFilesFromPayload,
  createSignature,
  hashText,
} = require('./duplicates/fileSignature.cjs');
const { extractMetadata } = require('./duplicates/documentMetadata.cjs');
const {
  isReadableSignalSnippet,
  extractMarkdownTextBlocks,
  buildOutlineComparison,
  addContentTextBlock,
  cleanMarkdownInlineText,
  cleanMarkdownLine,
} = require('./duplicates/markdownText.cjs');
const { markdownImagePattern, htmlImageSrcPattern, htmlImagePattern } = require('./duplicates/markdownText.cjs');
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
} = require('./duplicates/metadataDecoders.cjs');


const htmlTablePattern = /<table\b[\s\S]*?<\/table>/gi;
const contentTableTokenPrefix = 'YIBIAO_CONTENT_TABLE_';


function buildRows(files) {
  const keyOrder = [];
  const rowsByKey = new Map();
  for (const file of files) {
    for (const item of file.metadata || []) {
      if (!rowsByKey.has(item.key)) {
        keyOrder.push(item.key);
        rowsByKey.set(item.key, { key: item.key, label: item.label, values: {}, duplicate_file_ids: [], same_day_file_ids: [] });
      }
      rowsByKey.get(item.key).values[file.file_id] = item.value;
    }
  }

  for (const key of keyOrder) {
    const row = rowsByKey.get(key);
    const normalizedToFiles = new Map();
    const dayToFiles = new Map();
    for (const file of files) {
      const item = (file.metadata || []).find((entry) => entry.key === key);
      if (!item?.comparable || !item.normalized) continue;
      if (item.date_comparable) {
        if (!item.date_day) continue;
        const list = dayToFiles.get(item.date_day) || [];
        list.push(file.file_id);
        dayToFiles.set(item.date_day, list);
        continue;
      }
      const list = normalizedToFiles.get(item.normalized) || [];
      list.push(file.file_id);
      normalizedToFiles.set(item.normalized, list);
    }
    row.duplicate_file_ids = Array.from(new Set(Array.from(normalizedToFiles.values()).filter((ids) => ids.length > 1).flat()));
    row.same_day_file_ids = Array.from(new Set(Array.from(dayToFiles.values()).filter((ids) => ids.length > 1).flat()));
  }

  return keyOrder.map((key) => rowsByKey.get(key));
}


function normalizeOutlineTitle(value) {
  return normalizeValue(stripMarkdownForOutline(value))
    .replace(/^(?:#{1,6}\s*)/, '')
    .replace(/^[-*+>]\s*/, '')
    .replace(/^(?:第[一二三四五六七八九十百千万\d]+[章节篇部分]|\d+(?:\.\d+)*[.)、．]?|[一二三四五六七八九十]+[、.．]|（[一二三四五六七八九十\d]+）|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])[\s、.．-]*/, '')
    .replace(/[\s　]+/g, '')
    .replace(/[，。！？；：、“”‘’'"《》〈〉（）()\[\]【】{}.,!?;:|/\\_-]+/g, '')
    .toLowerCase();
}

function cleanOutlineTitle(value) {
  return normalizeValue(stripMarkdownForOutline(value))
    .replace(/^(?:#{1,6}\s*)/, '')
    .replace(/^[-*+>]\s*/, '')
    .replace(/(?:\.{2,}|…{2,}|·{2,}|\s{3,})\s*\d+\s*$/g, '')
    .replace(/\s+\d{1,4}\s*$/g, '')
    .trim();
}

function splitTenderSentences(markdown) {
  const text = stripMarkdownForOutline(markdown)
    .replace(/\|/g, '\n')
    .replace(/\r?\n/g, '\n')
    .replace(/[\t ]+/g, ' ');
  const parts = text
    .split(/[。！？!?；;\n]+/)
    .map((item) => cleanOutlineTitle(item))
    .filter(Boolean);
  const seen = new Set();
  const sentences = [];
  for (const part of parts) {
    const normalized = normalizeOutlineTitle(part);
    if (normalized.length < 6 || normalized.length > 160 || seen.has(normalized)) continue;
    seen.add(normalized);
    sentences.push({ text: part, normalized });
  }
  return sentences;
}

function matchTenderSentence(title, tenderSentences) {
  const normalized = normalizeOutlineTitle(title);
  if (normalized.length < 6) return null;
  for (const sentence of tenderSentences) {
    if (sentence.normalized === normalized) return sentence;
    if (normalized.length >= 10 && sentence.normalized.includes(normalized)) return sentence;
    if (sentence.normalized.length >= 10 && normalized.includes(sentence.normalized) && sentence.normalized.length / normalized.length >= 0.8) return sentence;
  }
  return null;
}

function parseOutlineMarker(line) {
  const text = cleanOutlineTitle(line);
  const patterns = [
    { pattern: /^(?<number>\d+(?:\.\d+)*)(?:[.)、．])?\s*(?<title>.+)$/u },
    { pattern: /^(?<number>第[一二三四五六七八九十百千万\d]+[章节篇部分])\s*(?<title>.*)$/u },
    { pattern: /^(?<number>[一二三四五六七八九十]+[、.．])\s*(?<title>.+)$/u },
    { pattern: /^(?<number>（[一二三四五六七八九十\d]+）)\s*(?<title>.+)$/u },
    { pattern: /^(?<number>[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*(?<title>.+)$/u },
  ];
  for (const { pattern } of patterns) {
    const match = text.match(pattern);
    if (!match?.groups) continue;
    const number = match.groups.number.trim();
    const title = cleanOutlineTitle(match.groups.title || number);
    if (!title || normalizeOutlineTitle(title).length < 2) continue;
    return { number, title, level: inferOutlineLevel(number) };
  }
  return null;
}


function parseCatalogLine(line) {
  const raw = cleanOutlineTitle(String(line || '').replace(/^\|+|\|+$/g, '').replace(/\|/g, ' '));
  if (!raw || /^[-:|\s]+$/.test(raw) || isCatalogTitleLine(raw)) return null;
  const hasPageTrail = /(?:\.{2,}|…{2,}|·{2,}|\s{3,})\s*\d+\s*$/.test(raw) || /\s\d{1,4}$/.test(raw);
  const marker = parseOutlineMarker(raw);
  if (marker) return marker;
  if (!hasPageTrail) return null;
  const title = cleanOutlineTitle(raw.replace(/(?:\.{2,}|…{2,}|·{2,}|\s{3,})\s*\d+\s*$/g, '').replace(/\s+\d{1,4}\s*$/g, ''));
  return title && normalizeOutlineTitle(title).length >= 2 ? { title, level: 1 } : null;
}

function extractCatalogOutline(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex(isCatalogTitleLine);
  if (start < 0) return [];
  const items = [];
  let misses = 0;
  for (let index = start + 1; index < Math.min(lines.length, start + 180); index += 1) {
    const parsed = parseCatalogLine(lines[index]);
    if (!parsed) {
      if (items.length) misses += 1;
      if (misses >= 10) break;
      continue;
    }
    misses = 0;
    items.push({ ...parsed, source: 'catalog', confidence: 0.92 });
  }
  return items;
}

function extractHeadingOutline(markdown) {
  const items = [];
  const lines = String(markdown || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;
    const title = cleanOutlineTitle(match[2]);
    if (!title || isCatalogTitleLine(title)) continue;
    const marker = parseOutlineMarker(title);
    items.push({ number: marker?.number, title: marker?.title || title, level: Math.min(match[1].length, 6), source: 'heading', confidence: 0.82 });
  }
  return items;
}

function extractSemanticOutline(markdown) {
  const items = [];
  const lines = String(markdown || '').split(/\r?\n/);
  for (const line of lines) {
    const text = cleanOutlineTitle(line);
    if (!text || text.length > 90 || /[。！？；;]$/.test(text) || /^\|/.test(text) || isCatalogTitleLine(text)) continue;
    const marker = parseOutlineMarker(text);
    const bold = /^\s*\*\*.+\*\*\s*$/.test(line);
    if (!marker && !bold) continue;
    items.push({ number: marker?.number, title: marker?.title || text, level: marker?.level || 2, source: 'semantic', confidence: marker ? 0.68 : 0.55 });
  }
  return items.slice(0, 260);
}

function buildOutlineItems(markdown, tenderSentences = []) {
  const candidates = [extractCatalogOutline(markdown), extractHeadingOutline(markdown), extractSemanticOutline(markdown)];
  const selected = candidates.find((items) => items.length >= 3) || candidates.find((items) => items.length) || [];
  const stack = [];
  const items = [];
  const seen = new Set();
  for (const candidate of selected) {
    let level = Math.max(1, Math.min(Number(candidate.level) || 1, 6));
    if (level > stack.length + 1) level = stack.length + 1;
    const title = cleanOutlineTitle(candidate.title);
    const normalized = normalizeOutlineTitle(title);
    if (!title || normalized.length < 2) continue;
    const key = `${level}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stack.splice(level - 1);
    const parent = stack[level - 2] || null;
    const pathTitles = [...(parent?.path_titles || []), title];
    const matched = matchTenderSentence(title, tenderSentences);
    const item = {
      id: `O${String(items.length + 1).padStart(5, '0')}`,
      level,
      number: candidate.number,
      title,
      normalized_title: normalized,
      path_titles: pathTitles,
      normalized_path: pathTitles.map(normalizeOutlineTitle).filter(Boolean).join('>'),
      source: candidate.source,
      confidence: candidate.confidence,
      order: items.length,
      parent_id: parent?.id,
      from_tender: Boolean(matched),
      matched_tender_sentence: matched?.text,
      duplicate_group_ids: [],
      similar_group_ids: [],
    };
    items.push(item);
    stack[level - 1] = item;
  }
  return { items, source: selected[0]?.source, confidence: selected.length ? Number((selected.reduce((sum, item) => sum + item.confidence, 0) / selected.length).toFixed(2)) : 0 };
}


function stripImagesFromMarkdown(markdown) {
  return String(markdown || '')
    .replace(markdownImagePattern, ' ')
    .replace(htmlImageSrcPattern, ' ')
    .replace(htmlImagePattern, ' ');
}


function extractHtmlCellTextBlocks($, cell) {
  const blocks = [];
  const node = $(cell).clone();
  node.find('img').remove();
  node.find('br').replaceWith('\n');

  node.find('p, li, h1, h2, h3, h4, h5, h6, blockquote, div').each((_, element) => {
    const block = $(element).clone();
    block.find('img').remove();
    block.find('br').replaceWith('\n');
    addContentTextBlock(blocks, block.text());
    $(element).remove();
  });

  addContentTextBlock(blocks, node.text());
  return blocks;
}

function extractHtmlTableTextBlocks(tableHtml) {
  const $ = cheerio.load(tableHtml, { decodeEntities: false });
  const blocks = [];
  $('tr').each((_, row) => {
    $(row).children('th, td').each((__, cell) => {
      for (const block of extractHtmlCellTextBlocks($, cell)) {
        addContentTextBlock(blocks, block);
      }
    });
  });
  if (!blocks.length) addContentTextBlock(blocks, $.root().text());
  return blocks;
}


function extractContentTextBlocks(markdown) {
  const source = stripImagesFromMarkdown(markdown);
  const tableBlocks = [];
  const withMarkers = source.replace(htmlTablePattern, (tableHtml) => {
    const index = tableBlocks.length;
    tableBlocks.push(extractHtmlTableTextBlocks(tableHtml));
    return `\n\n${contentTableTokenPrefix}${index}\n\n`;
  });
  const tokenPattern = new RegExp(`(${contentTableTokenPrefix}\\d+)`, 'g');
  const blocks = [];
  for (const chunk of withMarkers.split(tokenPattern)) {
    const tokenMatch = chunk.match(new RegExp(`^${contentTableTokenPrefix}(\\d+)$`));
    if (tokenMatch) {
      blocks.push(...(tableBlocks[Number(tokenMatch[1])] || []));
    } else {
      blocks.push(...extractMarkdownTextBlocks(chunk));
    }
  }
  return blocks;
}

function normalizeContentSentence(value) {
  return stripLeadingContentSequence(String(value || ''))
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/[\s　]+/g, ' ')
    .trim();
}


function splitContentBlockSentences(block) {
  const text = cleanContentSentence(block);
  if (!text) return [];

  const parts = [];
  let start = 0;
  let currentLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!/\s/.test(char)) currentLength += 1;
    const strongBoundary = /[。！？!?]/.test(char);
    const clauseBoundary = /[；;]/.test(char) && currentLength >= 20;
    if (strongBoundary || clauseBoundary) {
      parts.push(text.slice(start, index + 1));
      start = index + 1;
      currentLength = 0;
    }
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}


function splitContentSentences(markdown) {
  const sentences = [];
  for (const block of extractContentTextBlocks(markdown)) {
    for (const part of splitContentBlockSentences(block)) {
      const sentence = cleanContentSentence(part);
      const normalized = normalizeContentSentence(sentence);
      if (!normalized) continue;
      if (!isInformativeContentSentence(normalized)) continue;
      sentences.push({ sentence: sentence.length > 600 ? `${sentence.slice(0, 600)}...` : sentence, normalized });
    }
  }
  return sentences;
}

function normalizeTenderComparableText(value) {
  let text = normalizeContentSentence(value)
    .normalize('NFKC')
    .replace(/\\([\[\]().{}<>#+=\-])/g, '$1')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/，/g, ',')
    .replace(/。/g, '.')
    .replace(/；/g, ';')
    .replace(/：/g, ':')
    .replace(/≥|大于等于|不低于|不少于/g, '>=')
    .replace(/≤|小于等于|不高于|不超过/g, '<=')
    .replace(/(\d)\s*[xX×]\s*(\d)/g, '$1×$2')
    .replace(/(\d{4})\s*年\s*0?(\d{1,2})\s*月\s*0?(\d{1,2})\s*日/g, (_match, year, month, day) => `${year}年${Number(month)}月${Number(day)}日`)
    .replace(/\b(\d{4})[-/.](0?\d{1,2})[-/.](0?\d{1,2})\b/g, (_match, year, month, day) => `${year}年${Number(month)}月${Number(day)}日`)
    .replace(/\s+/g, ' ')
    .trim();

  text = stripTenderTablePrefix(text);
  text = stripTenderDirectoryPageTail(text);
  return text.trim();
}


function buildTenderStrictKey(value) {
  return normalizeTenderComparableText(value)
    .replace(/[\s　]+/g, '')
    .replace(/[.,，。;；:：、!！?？"'“”‘’《》<>〈〉()[\]【】{}]/g, '')
    .toLowerCase();
}

function buildTenderLooseText(value) {
  return normalizeTenderComparableText(value)
    .replace(/[\s　]+/g, '')
    .replace(/[.,，。;；:：、!！?？"'“”‘’《》<>〈〉()[\]【】{}]/g, '')
    .toLowerCase();
}

function buildTenderSkeletonKey(value) {
  let text = normalizeTenderComparableText(value)
    .replace(/\b\d{4}年\d{1,2}月\d{1,2}日\b/g, '{date}')
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, '{date}')
    .replace(/\b[A-Z]{2,}[-A-Z0-9]{4,}\b/gi, '{code}')
    .replace(/\d+(?:\.\d+)?\s*万元/g, '{money}')
    .replace(/\d+(?:\.\d+)?\s*元/g, '{money}')
    .replace(/\d+(?:\.\d+)?\s*%/g, '{percent}')
    .replace(/\d+(?:\.\d+)?\s*分/g, '{score}')
    .replace(/P\s*\d+(?:\s*[-~至]\s*P?\s*\d+)?/gi, '{page}')
    .replace(/\b\d+(?:\.\d+)?\b/g, '{num}');
  text = text
    .replace(/[\s　]+/g, '')
    .replace(/[.,，。;；:：、!！?？"'“”‘’《》<>〈〉()[\]【】{}]/g, '')
    .toLowerCase();
  return text;
}

function isTenderSkeletonAllowed(value, skeletonKey) {
  const text = normalizeTenderComparableText(value);
  const compactLength = buildTenderLooseText(text).length;
  if (!skeletonKey || skeletonKey.length < 8 || !/[{}]/.test(skeletonKey)) return false;
  if (compactLength >= 18) return true;
  return /(评分|评标|分值|计分|内容无瑕疵|内容存在|页码检索|合同复印件|技术要求|招标要求)/.test(text);
}

const tenderFieldDenyPattern = /(供应商名称|供应商地址|法定代表人|供应商代表|授权代表|被授权人|委托代理人|联系人|联系电话|电话|手机|邮政编码|邮箱|电子邮箱|开户|账号|银行|报价|投标报价|投标总价|合同金额|金额|总价)/;
const tenderFieldAllowPattern = /^(投标日期|日期|项目名称|项目编号|采购人|采购代理机构|评分因素及评标标准页码检索|投标文件总目录|目录|附件\d*|投标书|开标一览表|报价分项一览表|投标产品配置清单|商务要求点对点应答表|技术要求点对点应答表|主要相关业绩一览表|政府采购政策情况表|中小微企业声明函|非残疾人福利性单位声明函)$/;


function parseTenderFormatField(value) {
  const text = normalizeTenderComparableText(value);
  if (!text) return null;
  if (/^评分因素及评标标准页码检索(?:\s+\d{1,4}|\s+P?\d{1,4}(?:[-~至]P?\d{1,4})?)?$/i.test(text)) {
    return { field: '评分因素及评标标准页码检索', tail: text.replace(/^评分因素及评标标准页码检索/i, '').trim() };
  }

  const colonIndex = text.indexOf(':');
  if (colonIndex > 0 && colonIndex <= 24) {
    const field = normalizeTenderFieldName(text.slice(0, colonIndex));
    const tail = text.slice(colonIndex + 1).trim();
    return field ? { field, tail } : null;
  }

  const title = normalizeTenderFieldName(stripTenderDirectoryPageTail(text));
  return tenderFieldAllowPattern.test(title) ? { field: title, tail: text.slice(title.length).trim() } : null;
}

function isTenderFieldAllowed(field) {
  if (!field || tenderFieldDenyPattern.test(field)) return false;
  return tenderFieldAllowPattern.test(field);
}

function isSafeTenderFieldTail(value) {
  const tail = normalizeTenderComparableText(value).trim();
  if (!tail) return true;
  if (/^(?:\d{4}年\d{1,2}月\d{1,2}日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})$/.test(tail)) return true;
  if (/^(?:第\s*)?\d{1,4}\s*页?$/.test(tail)) return true;
  if (/^P\s*\d{1,4}(?:\s*[-~至]\s*P?\s*\d{1,4})?$/i.test(tail)) return true;
  if (/^[A-Z0-9-]{4,}$/i.test(tail)) return true;
  return tail.length <= 36 && /(天津港保税区消防救援支队|消防装备管理系统项目|天津众信招标咨询有限公司)/.test(tail);
}


function shouldApplyNearTenderMatch(value, looseText) {
  if (looseText.length >= 12) return true;
  return /(评分|评标|页码|投标日期|日期|技术要求|招标要求)/.test(normalizeTenderComparableText(value));
}

function buildTenderSourceMatcher(tenderSentences) {
  const exactSet = new Set();
  const strictSet = new Set();
  const skeletonSet = new Set();
  const fieldSet = new Set();
  const entries = [];
  const gramIndex = new Map();

  for (const sentence of tenderSentences) {
    const source = sentence?.sentence || sentence?.normalized || '';
    const normalized = sentence?.normalized || normalizeContentSentence(source);
    const strictKey = buildTenderStrictKey(normalized);
    const skeletonKey = buildTenderSkeletonKey(normalized);
    const looseText = buildTenderLooseText(normalized);
    const grams = charBigramsFromLooseText(looseText);
    if (normalized) exactSet.add(normalized);
    if (strictKey && strictKey.length >= 3) strictSet.add(strictKey);
    if (isTenderSkeletonAllowed(normalized, skeletonKey)) skeletonSet.add(skeletonKey);
    const parsedField = parseTenderFormatField(normalized);
    if (parsedField && isTenderFieldAllowed(parsedField.field)) fieldSet.add(parsedField.field);
    const entry = { normalized, strictKey, skeletonKey, looseText, grams };
    const entryIndex = entries.length;
    entries.push(entry);
    for (const gram of grams) {
      const list = gramIndex.get(gram) || [];
      list.push(entryIndex);
      gramIndex.set(gram, list);
    }
  }

  const candidateCounts = new Uint32Array(entries.length);

  function matchNear(sentence) {
    const looseText = buildTenderLooseText(sentence.normalized);
    if (!shouldApplyNearTenderMatch(sentence.normalized, looseText)) return null;
    const grams = charBigramsFromLooseText(looseText);
    if (grams.size < 4) return null;
    const candidates = [];
    for (const gram of grams) {
      for (const index of gramIndex.get(gram) || []) {
        if (candidateCounts[index] === 0) candidates.push(index);
        candidateCounts[index] += 1;
      }
    }

    let best = null;
    const compactLength = looseText.length;
    for (const index of candidates) {
      const shared = candidateCounts[index];
      candidateCounts[index] = 0;
      const entry = entries[index];
      if (!entry?.grams?.size) continue;
      const shorter = Math.min(grams.size, entry.grams.size);
      const longer = Math.max(grams.size, entry.grams.size);
      const containment = shared / Math.max(shorter, 1);
      const dice = diceSimilarityFromShared(shared, grams.size, entry.grams.size);
      const lengthRatio = shorter / Math.max(longer, 1);
      const allowed = compactLength >= 30
        ? containment >= 0.9 && dice >= 0.82 && lengthRatio >= 0.5
        : containment >= 0.95 && dice >= 0.88 && lengthRatio >= 0.55;
      if (!allowed) continue;
      if (!best || dice > best.dice) best = { reason: 'near', dice, containment, tender: entry.normalized };
    }
    return best;
  }

  return {
    tenderSentenceCount: exactSet.size,
    match(sentence) {
      const normalized = sentence?.normalized || '';
      if (!normalized) return null;
      if (exactSet.has(normalized)) return { reason: 'exact' };
      const strictKey = buildTenderStrictKey(normalized);
      if (strictKey && strictSet.has(strictKey)) return { reason: 'strict' };
      const parsedField = parseTenderFormatField(normalized);
      if (parsedField && isTenderFieldAllowed(parsedField.field) && fieldSet.has(parsedField.field) && isSafeTenderFieldTail(parsedField.tail)) {
        return { reason: 'field' };
      }
      const skeletonKey = buildTenderSkeletonKey(normalized);
      if (isTenderSkeletonAllowed(normalized, skeletonKey) && skeletonSet.has(skeletonKey)) return { reason: 'skeleton' };
      return matchNear(sentence);
    },
  };
}

function buildDuplicateSentences(globalSentences) {
  return Array.from(globalSentences.values())
    .filter((item) => item.file_ids.length > 1)
    .sort((a, b) => b.file_ids.length - a.file_ids.length || b.sentence.length - a.sentence.length || a.first_order - b.first_order)
    .map((item, index) => ({ ...item, id: `S${String(index + 1).padStart(6, '0')}` }));
}

function extractLineImageTargets(line) {
  const targets = [];
  for (const match of String(line || '').matchAll(markdownImagePattern)) {
    const target = String(match.groups?.target || '').trim().replace(/^<|>$/g, '');
    if (target) targets.push({ target, index: match.index || 0 });
  }
  for (const match of String(line || '').matchAll(htmlImageSrcPattern)) {
    const target = String(match.groups?.src || '').trim();
    if (target) targets.push({ target, index: match.index || 0 });
  }
  return targets.sort((a, b) => a.index - b.index);
}

function parseImageContextHeading(line) {
  const hashMatch = String(line || '').match(/^\s{0,3}(#{1,6})\s+(.+)$/);
  if (hashMatch) {
    const title = cleanOutlineTitle(hashMatch[2]);
    return title ? { level: Math.min(hashMatch[1].length, 6), title } : null;
  }

  const text = cleanOutlineTitle(line);
  if (!text || text.length > 90 || /[。！？；;]$/.test(text) || /^\|/.test(text) || isCatalogTitleLine(text)) return null;
  const marker = parseOutlineMarker(text);
  const bold = /^\s*\*\*.+\*\*\s*$/.test(line);
  if (!marker && !bold) return null;
  return { level: marker?.level || 2, title: marker?.title || text };
}

function updateImageContextHeadings(headings, heading) {
  while (headings.length && headings[headings.length - 1].level >= heading.level) headings.pop();
  headings.push(heading);
}

function getPreviousImageSentence(value) {
  const text = cleanMarkdownInlineText(value)
    .replace(/\|/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim();
  const parts = text.split(/[。！？!?；;\n]+/).map((item) => cleanContentSentence(item)).filter(Boolean);
  return (parts[parts.length - 1] || '').slice(0, 500);
}

function extractImageOccurrences(markdown) {
  const lines = normalizeContentLineBreaks(String(markdown || '').replace(/```[\s\S]*?```/g, '\n')).split('\n');
  const occurrences = [];
  const headings = [];
  let previousText = '';
  let imageIndex = 0;

  for (const line of lines) {
    const heading = parseImageContextHeading(line);
    if (heading) updateImageContextHeadings(headings, heading);

    const targets = extractLineImageTargets(line);
    for (const item of targets) {
      const beforeImage = line.slice(0, item.index);
      imageIndex += 1;
      occurrences.push({
        target: item.target,
        index: imageIndex,
        directory: headings.map((entry) => entry.title).join(' > '),
        previous_sentence: getPreviousImageSentence(`${previousText}\n${beforeImage}`),
      });
    }

    const cleanedLine = cleanMarkdownLine(line);
    if (cleanedLine) {
      previousText = `${previousText}\n${cleanedLine}`.slice(-4000);
    }
  }

  return occurrences;
}

function isPathInsideDirectory(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAssetPath(app, value) {
  const url = new URL(value);
  const roots = {
    'generated-images': getGeneratedImagesDir(app),
    'imported-images': getImportedImagesDir(app),
  };
  const rootDir = roots[url.hostname];
  if (!rootDir) return '';
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!relativePath) return '';
  const baseDir = path.resolve(rootDir);
  const filePath = path.resolve(baseDir, relativePath);
  return isPathInsideDirectory(baseDir, filePath) && filePath !== baseDir ? filePath : '';
}

async function readImageTargetBuffer(app, target) {
  const value = String(target || '').trim();
  if (!value) return null;
  const dataMatch = value.match(/^data:image\/[^;]+;base64,(?<data>[A-Za-z0-9+/=\s]+)$/i);
  if (dataMatch?.groups?.data) return Buffer.from(dataMatch.groups.data.replace(/\s+/g, ''), 'base64');
  if (/^yibiao-asset:\/\//i.test(value)) {
    const filePath = resolveAssetPath(app, value);
    return filePath ? fs.readFile(filePath) : null;
  }
  if (/^file:\/\//i.test(value)) {
    return fs.readFile(new URL(value));
  }
  return null;
}

function buildDuplicateImages(globalImages) {
  return Array.from(globalImages.values())
    .filter((item) => item.file_ids.length > 1)
    .sort((a, b) => b.file_ids.length - a.file_ids.length || Object.values(b.occurrences).reduce((sum, count) => sum + count, 0) - Object.values(a.occurrences).reduce((sum, count) => sum + count, 0))
    .map((item, index) => ({ ...item, id: `I${String(index + 1).padStart(6, '0')}` }));
}

function createInitialAnalysis(signature, bidFiles) {
  const total = bidFiles.length;
  return {
    status: 'running',
    progress: 0,
    message: '正在启动元数据分析',
    signature,
    started_at: now(),
    updated_at: now(),
    contentExtraction: { status: 'running', completed: 0, total: 0 },
    metadataExtraction: { status: total ? 'running' : 'success', completed: 0, total },
    files: [],
    rows: [],
    contentFiles: [],
    logs: [],
  };
}

function createInitialOutlineAnalysis(signature, bidFiles) {
  return {
    status: 'pending',
    progress: 0,
    message: '等待元数据提取完成后开始目录分析',
    signature,
    started_at: now(),
    updated_at: now(),
    tenderSentenceCount: 0,
    tenderMatchedItemCount: 0,
    extraction: { status: bidFiles.length ? 'pending' : 'success', completed: 0, total: bidFiles.length },
    files: [],
    duplicateGroups: [],
    pairwiseSimilarities: [],
  };
}

function createInitialContentAnalysis(signature, bidFiles) {
  return {
    status: 'pending',
    progress: 0,
    message: '等待正文内容提取完成后开始正文比对',
    signature,
    started_at: now(),
    updated_at: now(),
    tenderSentenceCount: 0,
    tenderMatchedSentenceCount: 0,
    totalSentenceCount: 0,
    extraction: { status: bidFiles.length ? 'pending' : 'success', completed: 0, total: bidFiles.length },
    duplicateSentences: [],
  };
}

function createInitialImageAnalysis(signature, bidFiles) {
  return {
    status: 'pending',
    progress: 0,
    message: '等待正文内容提取完成后开始图片比对',
    signature,
    started_at: now(),
    updated_at: now(),
    extraction: { status: bidFiles.length ? 'pending' : 'success', completed: 0, total: bidFiles.length },
    totalImageCount: 0,
    files: [],
    duplicateImages: [],
  };
}

function summarizeDuplicateFileForLog(file, role) {
  if (!file) return null;
  return {
    role,
    file_id: stableFileId(file),
    file_name: file.file_name || path.basename(file.file_path || ''),
    extension: file.extension || path.extname(file.file_name || file.file_path || '').toLowerCase(),
    size: file.size ?? null,
    modified_at: file.modified_at || '',
  };
}

function summarizeResultStatus(results = []) {
  const total = results.length;
  const errorCount = results.filter((item) => item.status === 'error').length;
  return {
    total,
    success_count: total - errorCount,
    error_count: errorCount,
  };
}

function summarizeContentExtractionResults(results = []) {
  const base = summarizeResultStatus(results);
  const lengths = results.map((item) => Number(item.content_length) || 0);
  return {
    ...base,
    total_content_chars: lengths.reduce((sum, value) => sum + value, 0),
    max_content_chars: Math.max(0, ...lengths),
  };
}

function loadDeveloperConfig(configStore) {
  try {
    return configStore?.load?.() || {};
  } catch {
    return {};
  }
}

function createDuplicateCheckService({ app, configStore, workspaceStore } = {}) {
  function analysisProgress(value) {
    if (!value) return 0;
    if (value.status === 'success' || value.status === 'error') return 100;
    return Math.max(0, Math.min(Number(value.progress) || 0, 99));
  }

  function overallProgress(state) {
    const values = [
      analysisProgress(state?.metadataAnalysis),
      analysisProgress(state?.outlineAnalysis),
      analysisProgress(state?.contentAnalysis),
      analysisProgress(state?.imageAnalysis),
    ];
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }

  function latestAnalysisMessage(state) {
    return state?.imageAnalysis?.message
      || state?.contentAnalysis?.message
      || state?.outlineAnalysis?.message
      || state?.metadataAnalysis?.message
      || '标书查重分析运行中。';
  }

  function isCurrentDuplicateCheckSignature(signature) {
    if (!signature) return true;
    const current = workspaceStore.loadDuplicateCheck() || {};
    const currentSignature = createSignature({
      tenderFile: current.tenderFile || null,
      tenderFiles: Array.isArray(current.tenderFiles) ? current.tenderFiles : [],
      bidFiles: Array.isArray(current.bidFiles) ? current.bidFiles : [],
    });
    return currentSignature === signature;
  }

  function updateAnalysisField(field, partial, persist, signature) {
    const analysisPartial = {
      ...partial,
      ...(signature ? { signature } : {}),
      updated_at: now(),
    };
    if (typeof persist === 'function') {
      return persist(field, analysisPartial);
    }
    const prev = workspaceStore.loadDuplicateCheck() || {};
    if (signature) {
      const currentSignature = createSignature({
        tenderFile: prev.tenderFile || null,
        tenderFiles: Array.isArray(prev.tenderFiles) ? prev.tenderFiles : [],
        bidFiles: Array.isArray(prev.bidFiles) ? prev.bidFiles : [],
      });
      if (currentSignature !== signature) return null;
    }
    workspaceStore.updateDuplicateCheckWithoutReload({ [field]: analysisPartial });
    return undefined;
  }

  function updateAnalysis(partial, persist, signature) {
    return updateAnalysisField('metadataAnalysis', partial, persist, signature);
  }

  function updateOutlineAnalysis(partial, persist, signature) {
    return updateAnalysisField('outlineAnalysis', partial, persist, signature);
  }

  function updateContentAnalysis(partial, persist, signature) {
    return updateAnalysisField('contentAnalysis', partial, persist, signature);
  }

  function updateImageAnalysis(partial, persist, signature) {
    return updateAnalysisField('imageAnalysis', partial, persist, signature);
  }

  async function runContentExtraction(allFiles, webContents, signature, developerLogger, tenderFiles) {
    const config = configStore ? configStore.load() : { components: { file_parser: { provider: 'local' } } };
    const dir = getDuplicateCheckContentDir(app);
    await fs.mkdir(dir, { recursive: true });
    const results = [];
    const tenderFileIds = new Set((Array.isArray(tenderFiles) ? tenderFiles : []).map(stableFileId));
    developerLogger?.write('duplicate.content_extraction.started', {
      signature,
      file_count: allFiles.length,
      files: allFiles.map((file) => summarizeDuplicateFileForLog(file, tenderFileIds.has(stableFileId(file)) ? 'tender' : 'bid')),
    });
    updateAnalysis({ contentExtraction: { status: 'running', completed: 0, total: allFiles.length }, message: '正在提取正文内容' }, webContents, signature);

    for (const file of allFiles) {
      const fileId = stableFileId(file);
      try {
        const markdown = (await parseDocumentWithConfig(app, file.file_path, config, {
          assetScope: `duplicate-check-content-${fileId}`,
          preserveImages: true,
        })).trim();
        const contentPath = path.join(dir, `${fileId}.md`);
        await fs.writeFile(contentPath, markdown, 'utf-8');
        results.push({
          file_id: fileId,
          file_name: file.file_name,
          status: 'success',
          content_path: contentPath,
          content_length: markdown.length,
          content_hash: hashText(markdown),
        });
        developerLogger?.write('duplicate.content_extraction.file.completed', {
          file: summarizeDuplicateFileForLog(file, tenderFileIds.has(fileId) ? 'tender' : 'bid'),
          markdown_metrics: textMetrics(markdown),
        });
      } catch (error) {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'error', error: error.message || '正文提取失败' });
        developerLogger?.write('duplicate.content_extraction.file.error', {
          file: summarizeDuplicateFileForLog(file, tenderFileIds.has(fileId) ? 'tender' : 'bid'),
          error: compactLogError(error),
        });
      }
      updateAnalysis({ contentExtraction: { status: 'running', completed: results.length, total: allFiles.length }, contentFiles: results, message: `正文内容提取 ${results.length}/${allFiles.length}` }, webContents, signature);
    }

    const status = results.some((item) => item.status === 'error') ? 'error' : 'success';
    updateAnalysis({ contentExtraction: { status, completed: results.length, total: allFiles.length }, contentFiles: results }, webContents, signature);
    developerLogger?.write('duplicate.content_extraction.completed', {
      signature,
      status,
      result: summarizeContentExtractionResults(results),
    });
    return results;
  }

  async function readCombinedTenderMarkdown(contentFiles, tenderFiles) {
    const parts = [];
    for (const file of Array.isArray(tenderFiles) ? tenderFiles : []) {
      const markdown = await readContentMarkdown(contentFiles, file);
      if (String(markdown || '').trim()) parts.push(String(markdown).trim());
    }
    return parts.join('\n\n');
  }

  async function runMetadataExtraction(bidFiles, webContents, signature, developerLogger) {
    const results = [];
    developerLogger?.write('duplicate.metadata_extraction.started', {
      signature,
      bid_file_count: bidFiles.length,
    });
    updateAnalysis({ metadataExtraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在提取投标文件元数据' }, webContents, signature);

    for (const file of bidFiles) {
      const fileId = stableFileId(file);
      try {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'success', metadata: await extractMetadata(file) });
        developerLogger?.write('duplicate.metadata_extraction.file.completed', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          metadata_count: results[results.length - 1].metadata.length,
        });
      } catch (error) {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'error', error: error.message || '元数据提取失败', metadata: [] });
        developerLogger?.write('duplicate.metadata_extraction.file.error', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          error: compactLogError(error),
        });
      }
      const rows = buildRows(results);
      updateAnalysis({ metadataExtraction: { status: 'running', completed: results.length, total: bidFiles.length }, files: results, rows, message: `元数据提取 ${results.length}/${bidFiles.length}` }, webContents, signature);
    }

    const rows = buildRows(results);
    const status = results.some((item) => item.status === 'error') ? 'error' : 'success';
    updateAnalysis({ metadataExtraction: { status, completed: results.length, total: bidFiles.length }, files: results, rows }, webContents, signature);
    developerLogger?.write('duplicate.metadata_extraction.completed', {
      signature,
      status,
      result: summarizeResultStatus(results),
      row_count: rows.length,
      repeated_row_count: rows.filter((row) => row.repeated).length,
    });
    return results;
  }

  async function readContentMarkdown(contentFiles, file) {
    const fileId = stableFileId(file);
    const item = contentFiles.find((entry) => entry.file_id === fileId && entry.status === 'success' && entry.content_path);
    if (!item) throw new Error('正文内容尚未成功提取，无法进行目录分析');
    return fs.readFile(item.content_path, 'utf-8');
  }

  async function runOutlineAnalysis(tenderFiles, bidFiles, contentFiles, signature, webContents, developerLogger) {
    developerLogger?.write('duplicate.outline_analysis.started', {
      signature,
      bid_file_count: bidFiles.length,
      tender_files: (Array.isArray(tenderFiles) ? tenderFiles : []).map((file) => summarizeDuplicateFileForLog(file, 'tender')),
    });
    updateOutlineAnalysis({ status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在准备目录分析' }, webContents, signature);
    const results = [];
    let tenderSentences = [];
    if (Array.isArray(tenderFiles) && tenderFiles.length) {
      try {
        const tenderMarkdown = await readCombinedTenderMarkdown(contentFiles, tenderFiles);
        tenderSentences = splitTenderSentences(tenderMarkdown);
      } catch (error) {
        updateOutlineAnalysis({ message: `招标文件句子白名单生成失败，继续对比投标文件目录：${error.message || error}` }, webContents, signature);
        developerLogger?.write('duplicate.outline_analysis.tender_whitelist.error', {
          error: compactLogError(error),
        });
      }
    }
    developerLogger?.write('duplicate.outline_analysis.tender_whitelist.completed', {
      tender_sentence_count: tenderSentences.length,
    });

    updateOutlineAnalysis({ tenderSentenceCount: tenderSentences.length, message: '正在提取投标文件目录' }, webContents, signature);
    for (const file of bidFiles) {
      const fileId = stableFileId(file);
      try {
        const markdown = await readContentMarkdown(contentFiles, file);
        const extracted = buildOutlineItems(markdown, tenderSentences);
        const tenderMatchedCount = extracted.items.filter((item) => item.from_tender).length;
        results.push({
          file_id: fileId,
          file_name: file.file_name,
          status: 'success',
          source: extracted.source,
          confidence: extracted.confidence,
          item_count: extracted.items.length,
          tender_matched_count: tenderMatchedCount,
          items: extracted.items,
        });
        developerLogger?.write('duplicate.outline_analysis.file.completed', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          source: extracted.source,
          confidence: extracted.confidence,
          item_count: extracted.items.length,
          tender_matched_count: tenderMatchedCount,
        });
      } catch (error) {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'error', item_count: 0, tender_matched_count: 0, items: [], error: error.message || '目录提取失败' });
        developerLogger?.write('duplicate.outline_analysis.file.error', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          error: compactLogError(error),
        });
      }
      updateOutlineAnalysis({
        status: 'running',
        progress: bidFiles.length ? Math.round((results.length / bidFiles.length) * 80) : 80,
        extraction: { status: 'running', completed: results.length, total: bidFiles.length },
        files: results,
        tenderSentenceCount: tenderSentences.length,
        tenderMatchedItemCount: results.reduce((sum, item) => sum + (item.tender_matched_count || 0), 0),
        message: `目录提取 ${results.length}/${bidFiles.length}`,
      }, webContents, signature);
    }

    const comparison = buildOutlineComparison(results);
    const failed = results.some((item) => item.status === 'error');
    updateOutlineAnalysis({
      status: failed ? 'error' : 'success',
      progress: 100,
      message: failed ? '部分文件目录分析失败' : '目录分析完成',
      signature,
      extraction: { status: failed ? 'error' : 'success', completed: results.length, total: bidFiles.length },
      files: results,
      tenderSentenceCount: tenderSentences.length,
      tenderMatchedItemCount: results.reduce((sum, item) => sum + (item.tender_matched_count || 0), 0),
      duplicateGroups: comparison.duplicateGroups,
      pairwiseSimilarities: comparison.pairwiseSimilarities,
    }, webContents, signature);
    developerLogger?.write('duplicate.outline_analysis.completed', {
      signature,
      status: failed ? 'error' : 'success',
      result: summarizeResultStatus(results),
      tender_sentence_count: tenderSentences.length,
      tender_matched_item_count: results.reduce((sum, item) => sum + (item.tender_matched_count || 0), 0),
      duplicate_group_count: comparison.duplicateGroups.length,
      pairwise_similarity_count: comparison.pairwiseSimilarities.length,
    });
    return results;
  }

  async function runContentDuplicateAnalysis(tenderFiles, bidFiles, contentFiles, signature, webContents, developerLogger) {
    const contentStartedAt = Date.now();
    developerLogger?.write('duplicate.content_analysis.started', {
      signature,
      bid_file_count: bidFiles.length,
      tender_files: (Array.isArray(tenderFiles) ? tenderFiles : []).map((file) => summarizeDuplicateFileForLog(file, 'tender')),
    });
    updateContentAnalysis({ status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在准备正文比对' }, webContents, signature);
    let tenderMatcher = buildTenderSourceMatcher([]);
    const tenderMatchReasonCounts = {};
    if (Array.isArray(tenderFiles) && tenderFiles.length) {
      try {
        const tenderMarkdown = await readCombinedTenderMarkdown(contentFiles, tenderFiles);
        tenderMatcher = buildTenderSourceMatcher(splitContentSentences(tenderMarkdown));
      } catch (error) {
        updateContentAnalysis({ message: `招标文件句子白名单生成失败，继续比对投标正文：${error.message || error}` }, webContents, signature);
        developerLogger?.write('duplicate.content_analysis.tender_whitelist.error', {
          error: compactLogError(error),
        });
      }
    }
    developerLogger?.write('duplicate.content_analysis.tender_whitelist.completed', {
      tender_sentence_count: tenderMatcher.tenderSentenceCount,
    });

    const globalSentences = new Map();
    let totalSentenceCount = 0;
    let tenderMatchedSentenceCount = 0;
    let firstOrder = 0;

    for (let fileIndex = 0; fileIndex < bidFiles.length; fileIndex += 1) {
      const file = bidFiles[fileIndex];
      const fileId = stableFileId(file);
      const fileStartedAt = Date.now();
      try {
        const markdown = await readContentMarkdown(contentFiles, file);
        const sentences = splitContentSentences(markdown);
        totalSentenceCount += sentences.length;
        const local = new Map();
        let fileTenderMatchedCount = 0;
        for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
          const sentence = sentences[sentenceIndex];
          const tenderMatch = tenderMatcher.match(sentence);
          if (tenderMatch) {
            tenderMatchedSentenceCount += 1;
            fileTenderMatchedCount += 1;
            const reason = tenderMatch.reason || 'unknown';
            tenderMatchReasonCounts[reason] = (tenderMatchReasonCounts[reason] || 0) + 1;
          } else {
            const current = local.get(sentence.normalized) || { sentence: sentence.sentence, count: 0, order: firstOrder++ };
            current.count += 1;
            local.set(sentence.normalized, current);
          }

          const processed = sentenceIndex + 1;
          if (processed % 500 === 0 && processed < sentences.length) {
            updateContentAnalysis({
              status: 'running',
              progress: bidFiles.length ? Math.min(89, Math.round(5 + ((fileIndex + processed / sentences.length) / bidFiles.length) * 80)) : 85,
              tenderSentenceCount: tenderMatcher.tenderSentenceCount,
              tenderMatchedSentenceCount,
              totalSentenceCount,
              extraction: { status: 'running', completed: fileIndex, total: bidFiles.length },
              message: `正文比对 ${fileIndex + 1}/${bidFiles.length}（${processed}/${sentences.length} 句）`,
            }, webContents, signature);
            // 大批句子分块让出事件循环，避免单份标书长时间阻塞 Electron 主进程。
            await new Promise((resolve) => setImmediate(resolve));
          }
        }

        for (const [normalized, item] of local.entries()) {
          const global = globalSentences.get(normalized) || { sentence: item.sentence, normalized, file_ids: [], occurrences: {}, first_order: item.order };
          if (!global.file_ids.includes(fileId)) global.file_ids.push(fileId);
          global.occurrences[fileId] = item.count;
          globalSentences.set(normalized, global);
        }
        developerLogger?.write('duplicate.content_analysis.file.completed', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          duration_ms: Date.now() - fileStartedAt,
          sentence_count: sentences.length,
          tender_matched_sentence_count: fileTenderMatchedCount,
          compared_sentence_count: sentences.length - fileTenderMatchedCount,
        });
      } catch (error) {
        updateContentAnalysis({ message: `${file.file_name} 正文比对失败：${error.message || error}` }, webContents, signature);
        developerLogger?.write('duplicate.content_analysis.file.error', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          duration_ms: Date.now() - fileStartedAt,
          error: compactLogError(error),
        });
      }

      updateContentAnalysis({
        status: 'running',
        progress: bidFiles.length ? Math.round((globalSentences.size ? 10 : 5) + (fileIndex + 1) / bidFiles.length * 80) : 85,
        tenderSentenceCount: tenderMatcher.tenderSentenceCount,
        tenderMatchedSentenceCount,
        totalSentenceCount,
        extraction: { status: 'running', completed: fileIndex + 1, total: bidFiles.length },
        message: `正文比对 ${fileIndex + 1}/${bidFiles.length}`,
      }, webContents, signature);
    }

    const duplicateSentences = buildDuplicateSentences(globalSentences);
    updateContentAnalysis({
      status: 'success',
      progress: 100,
      message: '正文比对完成',
      signature,
      tenderSentenceCount: tenderMatcher.tenderSentenceCount,
      tenderMatchedSentenceCount,
      totalSentenceCount,
      extraction: { status: 'success', completed: bidFiles.length, total: bidFiles.length },
      duplicateSentences,
    }, webContents, signature);
    developerLogger?.write('duplicate.content_analysis.completed', {
      signature,
      status: 'success',
      duration_ms: Date.now() - contentStartedAt,
      tender_sentence_count: tenderMatcher.tenderSentenceCount,
      tender_matched_sentence_count: tenderMatchedSentenceCount,
      tender_match_reason_counts: tenderMatchReasonCounts,
      total_sentence_count: totalSentenceCount,
      duplicate_sentence_count: duplicateSentences.length,
    });
    return { status: 'success', duplicateSentences };
  }

  async function runImageDuplicateAnalysis(bidFiles, contentFiles, signature, webContents, developerLogger) {
    developerLogger?.write('duplicate.image_analysis.started', {
      signature,
      bid_file_count: bidFiles.length,
    });
    updateImageAnalysis({ status: 'running', progress: 5, extraction: { status: 'running', completed: 0, total: bidFiles.length }, message: '正在准备图片比对' }, webContents, signature);
    const results = [];
    const globalImages = new Map();
    let totalImageCount = 0;

    for (const file of bidFiles) {
      const fileId = stableFileId(file);
      try {
        const markdown = await readContentMarkdown(contentFiles, file);
        const imageOccurrences = extractImageOccurrences(markdown);
        totalImageCount += imageOccurrences.length;
        const local = new Map();
        for (const occurrence of imageOccurrences) {
          try {
            const buffer = await readImageTargetBuffer(app, occurrence.target);
            if (!buffer?.length) continue;
            const hash = crypto.createHash('sha256').update(buffer).digest('hex');
            const current = local.get(hash) || { count: 0, preview_url: occurrence.target, locations: [] };
            current.count += 1;
            current.locations.push({
              image_index: occurrence.index,
              directory: occurrence.directory,
              previous_sentence: occurrence.previous_sentence,
            });
            local.set(hash, current);
          } catch {
            // Ignore individual unreadable images; other images in the same file can still be compared.
          }
        }

        for (const [hash, item] of local.entries()) {
          const global = globalImages.get(hash) || { hash, preview_url: item.preview_url, file_ids: [], occurrences: {}, locations: {} };
          if (!global.file_ids.includes(fileId)) global.file_ids.push(fileId);
          global.occurrences[fileId] = item.count;
          global.locations[fileId] = item.locations;
          globalImages.set(hash, global);
        }
        results.push({ file_id: fileId, file_name: file.file_name, status: 'success', image_count: imageOccurrences.length, unique_image_count: local.size });
        developerLogger?.write('duplicate.image_analysis.file.completed', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          image_count: imageOccurrences.length,
          unique_image_count: local.size,
        });
      } catch (error) {
        results.push({ file_id: fileId, file_name: file.file_name, status: 'error', image_count: 0, unique_image_count: 0, error: error.message || '图片比对失败' });
        developerLogger?.write('duplicate.image_analysis.file.error', {
          file: summarizeDuplicateFileForLog(file, 'bid'),
          error: compactLogError(error),
        });
      }

      updateImageAnalysis({
        status: 'running',
        progress: bidFiles.length ? Math.round((results.length / bidFiles.length) * 85) : 85,
        extraction: { status: 'running', completed: results.length, total: bidFiles.length },
        files: results,
        totalImageCount,
        message: `图片比对 ${results.length}/${bidFiles.length}`,
      }, webContents, signature);
    }

    const duplicateImages = buildDuplicateImages(globalImages);
    const failed = results.some((item) => item.status === 'error');
    updateImageAnalysis({
      status: failed ? 'error' : 'success',
      progress: 100,
      message: failed ? '部分文件图片比对失败' : '图片比对完成',
      signature,
      extraction: { status: failed ? 'error' : 'success', completed: results.length, total: bidFiles.length },
      files: results,
      totalImageCount,
      duplicateImages,
    }, webContents, signature);
    developerLogger?.write('duplicate.image_analysis.completed', {
      signature,
      status: failed ? 'error' : 'success',
      result: summarizeResultStatus(results),
      total_image_count: totalImageCount,
      duplicate_image_count: duplicateImages.length,
    });
    return { status: failed ? 'error' : 'success', duplicateImages };
  }

  async function run(signature, payload, target, developerLogger) {
    const tenderFiles = getTenderFilesFromPayload(payload);
    const tenderFile = tenderFiles[0] || null;
    const bidFiles = Array.isArray(payload.bidFiles) ? payload.bidFiles : [];
    const allFiles = [...tenderFiles, ...bidFiles].filter(Boolean);
    developerLogger?.write('duplicate.pipeline.started', {
      signature,
      tender_files: tenderFiles.map((file) => summarizeDuplicateFileForLog(file, 'tender')),
      bid_file_count: bidFiles.length,
      file_count: allFiles.length,
    });

    try {
      const contentPromise = runContentExtraction(allFiles, target, signature, developerLogger, tenderFiles);
      const metadataFiles = await runMetadataExtraction(bidFiles, target, signature, developerLogger);
      updateOutlineAnalysis({ status: 'running', progress: 1, message: '元数据提取完成，等待正文内容用于目录分析', extraction: { status: 'running', completed: 0, total: bidFiles.length } }, target, signature);
      updateContentAnalysis({ status: 'running', progress: 1, message: '元数据提取完成，等待正文内容用于正文比对', extraction: { status: 'running', completed: 0, total: bidFiles.length } }, target, signature);
      updateImageAnalysis({ status: 'running', progress: 1, message: '元数据提取完成，等待正文内容用于图片比对', extraction: { status: 'running', completed: 0, total: bidFiles.length } }, target, signature);
      const contentFiles = await contentPromise;
      const metadataFailed = contentFiles.some((item) => item.status === 'error') || metadataFiles.some((item) => item.status === 'error');
      updateAnalysis({
        status: metadataFailed ? 'error' : 'success',
        progress: 100,
        message: metadataFailed ? '部分文件提取失败' : '元数据分析完成',
      }, target, signature);
      const [outlineFiles, contentResult, imageResult] = await Promise.all([
        runOutlineAnalysis(tenderFiles, bidFiles, contentFiles, signature, target, developerLogger),
        runContentDuplicateAnalysis(tenderFiles, bidFiles, contentFiles, signature, target, developerLogger),
        runImageDuplicateAnalysis(bidFiles, contentFiles, signature, target, developerLogger),
      ]);
      const failed = metadataFailed
        || outlineFiles.some((item) => item.status === 'error')
        || contentResult.status === 'error'
        || imageResult.status === 'error';
      developerLogger?.write('duplicate.pipeline.completed', {
        signature,
        status: failed ? 'error' : 'success',
        content_extraction: summarizeResultStatus(contentFiles),
        metadata_extraction: summarizeResultStatus(metadataFiles),
        outline_analysis: summarizeResultStatus(outlineFiles),
        content_duplicate_status: contentResult.status,
        image_duplicate_status: imageResult.status,
      });
      return failed ? 'error' : 'success';
    } catch (error) {
      updateAnalysis({ status: 'error', progress: 100, message: error.message || '元数据分析失败' }, target, signature);
      developerLogger?.write('duplicate.pipeline.error', {
        signature,
        error: compactLogError(error),
      });
      return 'error';
    }
  }

  return {
    async runAnalysisTask({ workspaceStore: taskWorkspaceStore, updateTask, checkpointTask, payload }) {
      const signature = createSignature(payload);
      const force = payload.force === true;
      const bidFiles = Array.isArray(payload.bidFiles) ? payload.bidFiles : [];
      const tenderFiles = getTenderFilesFromPayload(payload);
      const developerLogger = createDeveloperLogger({
        app,
        config: loadDeveloperConfig(configStore),
        moduleName: 'duplicate-check',
        name: 'duplicate-analysis',
        meta: {
          signature,
          force,
          tender_files: tenderFiles.map((file) => summarizeDuplicateFileForLog(file, 'tender')),
          bid_file_count: bidFiles.length,
        },
      });
      developerLogger.write('duplicate.task.started', {
        signature,
        force,
        tender_files: tenderFiles.map((file) => summarizeDuplicateFileForLog(file, 'tender')),
        bid_files: bidFiles.map((file) => summarizeDuplicateFileForLog(file, 'bid')),
      });
      const current = taskWorkspaceStore.loadDuplicateCheck() || {};
      if (!force
        && current.metadataAnalysis?.signature === signature && current.metadataAnalysis?.status === 'success'
        && current.outlineAnalysis?.signature === signature && current.outlineAnalysis?.status === 'success'
        && current.contentAnalysis?.signature === signature && current.contentAnalysis?.status === 'success'
        && current.imageAnalysis?.signature === signature && current.imageAnalysis?.status === 'success') {
        checkpointTask({ status: 'success', progress: 100, logs: ['标书查重分析已完成，无需重复分析。'] });
        developerLogger.write('duplicate.task.skipped', { signature, reason: 'already_success' });
        return;
      }

      const metadataAnalysis = createInitialAnalysis(signature, bidFiles);
      const outlineAnalysis = createInitialOutlineAnalysis(signature, bidFiles);
      const contentAnalysis = createInitialContentAnalysis(signature, bidFiles);
      const imageAnalysis = createInitialImageAnalysis(signature, bidFiles);
      let analysisState = {
        metadataAnalysis,
        outlineAnalysis,
        contentAnalysis,
        imageAnalysis,
      };
      const initialLogs = [force ? '开始重新执行标书查重分析。' : '开始执行标书查重分析。'];
      let latestLog = initialLogs[0];
      checkpointTask({ status: 'running', progress: 0, logs: initialLogs }, {
        tenderFile: tenderFiles[0] || null,
        tenderFiles,
        bidFiles,
        metadataAnalysis,
        outlineAnalysis,
        contentAnalysis,
        imageAnalysis,
      });

      const notifyTask = (field, analysisPartial) => {
        analysisState = {
          ...analysisState,
          [field]: { ...(analysisState[field] || {}), ...analysisPartial },
        };
        const message = latestAnalysisMessage(analysisState);
        const partial = { status: 'running', progress: overallProgress(analysisState) };
        if (message && message !== latestLog) {
          latestLog = message;
          partial.logs = [message];
        }
        const detailFields = field === 'metadataAnalysis'
          ? ['contentFiles', 'files']
          : field === 'outlineAnalysis'
            ? ['files', 'duplicateGroups', 'pairwiseSimilarities']
            : field === 'contentAnalysis'
              ? ['duplicateSentences']
              : ['files', 'duplicateImages'];
        const hasResultChange = detailFields.some((key) => Object.prototype.hasOwnProperty.call(analysisPartial, key));
        const hasTerminalTransition = ['success', 'error'].includes(analysisPartial.status);
        (hasResultChange || hasTerminalTransition ? checkpointTask : updateTask)(partial, { [field]: analysisPartial });
      };

      const finalStatus = await run(signature, payload, notifyTask, developerLogger);
      const doneLog = finalStatus === 'success' ? '标书查重分析完成。' : '标书查重分析完成，部分结果失败。';
      if (!isCurrentDuplicateCheckSignature(signature)) {
        developerLogger.write('duplicate.task.stale_signature', { signature });
        return;
      }
      checkpointTask({ status: finalStatus, progress: 100, logs: [doneLog] });
      developerLogger.write('duplicate.task.completed', {
        signature,
        status: finalStatus,
        progress: 100,
      });
    },
  };
}

module.exports = { createDuplicateCheckService };
