// 大纲与正文文本解析：目录/标题/语义三种大纲提取、正文句子切分、招标字段比对。
//
// 这些原本是 duplicateCheckService.cjs 里的模块级函数与常量；搬出来后 service 只负责调度与落库。
// 纯文本处理（只依赖 cheerio 与同目录的文本工具），不接触 Electron 或数据库，可单独测试。

const cheerio = require('cheerio');
const {
  normalizeValue,
  stripMarkdownForOutline,
  inferOutlineLevel,
  isCatalogTitleLine,
  stripLeadingContentSequence,
  cleanContentSentence,
  isInformativeContentSentence,
  stripTenderTablePrefix,
  stripTenderDirectoryPageTail,
  normalizeTenderFieldName,
} = require('./tenderText.cjs');
const {
  markdownImagePattern,
  htmlImageSrcPattern,
  htmlImagePattern,
  addContentTextBlock,
  extractMarkdownTextBlocks,
} = require('./markdownText.cjs');
const {
  intersectSize,
  charBigramsFromLooseText,
  diceSimilarityFromShared,
} = require('./similarity.cjs');

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

module.exports = {
  buildRows,
  cleanOutlineTitle,
  splitTenderSentences,
  parseOutlineMarker,
  buildOutlineItems,
  splitContentSentences,
  buildTenderSourceMatcher,
};
