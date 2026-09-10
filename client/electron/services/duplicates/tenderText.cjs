// 招标文件/目录文本清洗：把解析出来的正文规整成可比较的行，纯函数，可单独测试。

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue).filter(Boolean).join('；');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripMarkdownForOutline(markdown) {
  return String(markdown || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~]/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function inferOutlineLevel(number) {
  const marker = String(number || '').trim();
  if (/^\d+(?:\.\d+)+/.test(marker)) return marker.split('.').filter(Boolean).length;
  if (/^\d+/.test(marker) || /^第.+[章节篇部分]$/.test(marker) || /^[一二三四五六七八九十]+[、.．]$/.test(marker)) return 1;
  if (/^（.+）$/.test(marker) || /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]$/.test(marker)) return 2;
  return 1;
}

function isCatalogTitleLine(line) {
  return /^(?:#{1,6}\s*)?(目录|目次|contents)$/i.test(String(line || '').replace(/\s+/g, ''));
}

function normalizeContentLineBreaks(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitMarkdownTableRow(line) {
  let text = String(line || '').trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);

  const cells = [];
  let current = '';
  let escaped = false;
  for (const char of text) {
    if (char === '\\' && !escaped) {
      escaped = true;
      current += char;
      continue;
    }
    if (char === '|' && !escaped) {
      cells.push(current.replace(/\\\|/g, '|').trim());
      current = '';
      continue;
    }
    current += char;
    escaped = false;
  }
  cells.push(current.replace(/\\\|/g, '|').trim());
  return cells;
}

function stripLeadingContentSequence(value) {
  let text = String(value || '').trim();
  const patterns = [
    /^\s*[\d０-９]+(?:\\?[.．][\d０-９]+)*\s*(?:\\?[.．]|[)）、])\s*/u,
    /^\s*[\d０-９]+(?:\\?[.．][\d０-９]+)*\s+(?=[A-Za-z\u4e00-\u9fff（(])/u,
    /^\s*\((?:[\d０-９]+(?:\\?[.．][\d０-９]+)*|[一二三四五六七八九十百千万]+)\)\s*(?:\\?[.．]|[、])?\s*/u,
    /^\s*[一二三四五六七八九十百千万]+\s*(?:\\?[.．]|[、)）])\s*/u,
    /^\s*（(?:[一二三四五六七八九十百千万]+|[\d０-９]+(?:\\?[.．][\d０-９]+)*)）\s*(?:\\?[.．]|[、])?\s*/u,
    /^\s*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*(?:\\?[.．]|[、])?\s*/u,
    /^\s*第(?:[\d０-９]+|[一二三四五六七八九十百千万]+)[章节篇部分卷]\s*/u,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = text.replace(pattern, '');
      if (next !== text) {
        text = next.trimStart();
        changed = true;
        break;
      }
    }
  }
  return text;
}

function cleanContentSentence(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/[　]+/g, ' ')
    .trim();
}

function isInformativeContentSentence(sentence) {
  const compact = String(sentence || '').replace(/\s+/g, '');
  if (!compact || /^\d+$/.test(compact)) return false;
  const contentChars = compact.match(/[A-Za-z0-9\u4e00-\u9fff]/g) || [];
  if (contentChars.length < 4) return false;
  if (compact.length >= 12) return true;
  if (compact.length >= 6 && /[：:]/.test(compact) && /[A-Za-z\u4e00-\u9fff]{2,}/.test(compact)) return true;
  return compact.length >= 6
    && /[\u4e00-\u9fff]/.test(compact)
    && /(?:日历天|个月|万元|GHz|MHz|GB|MB|kg|mm|cm|天|年|元|%|％)/i.test(compact);
}

function stripTenderTablePrefix(value) {
  let text = String(value || '').trim();
  const prefixes = ['技术要求', '招标要求', '评分标准', '评标标准', '投标应答', '偏离说明'];
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      const pattern = new RegExp(`^${prefix}\\s*[:：]?\\s*(?:\\d+(?:\\.\\d+)*\\s*[.)、．]?\\s*)?`, 'i');
      const next = text.replace(pattern, '').trim();
      if (next !== text && next) {
        text = next;
        changed = true;
        break;
      }
    }
  }
  return text;
}

function stripTenderDirectoryPageTail(value) {
  let text = String(value || '').trim();
  if (!/(目录|页码|检索|评分因素|评标标准|评分标准)/.test(text)) return text;
  text = text
    .replace(/\s*(?:第\s*)?\d{1,4}\s*页\s*$/i, '')
    .replace(/\s*P\s*\d{1,4}(?:\s*[-~至]\s*P?\s*\d{1,4})?\s*$/i, '')
    .replace(/(?:\.{2,}|…{2,}|·{2,}|\s{2,})\s*\d{1,4}\s*$/g, '')
    .replace(/\s+\d{1,4}\s*$/g, '');
  return text.trim();
}

function normalizeTenderFieldName(value) {
  return String(value || '')
    .replace(/[\s　]+/g, '')
    .replace(/[：:]+$/g, '')
    .replace(/[()（）【】\[\]《》]/g, '')
    .trim();
}

module.exports = {
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
};
