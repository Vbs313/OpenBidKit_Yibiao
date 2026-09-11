// 查重用的文本提取与大纲比对：把正文 Markdown 拆成可比较的文本块，并给出大纲层面的相似度结论。
//
// 这些原本是 duplicateCheckService.cjs 里的模块级函数；搬出来后 service 只负责解析文档与跑分析。
// 纯字符串/数组处理，不接触文件系统与 Electron API，可单独测试。

const { intersectSize, lcsSimilarity, riskFromScore } = require('./similarity.cjs');

const markdownImagePattern = /!\[(?<alt>[^\]]*)\]\((?<target><[^>]+>|[^)\s]+)(?<title>\s+"[^"]*")?\)/gi;
const htmlImageSrcPattern = /<img\b[^>]*?\bsrc=["'](?<src>[^"']+)["'][^>]*>/gi;
const htmlImagePattern = /<img\b[^>]*>/gi;
const { normalizeContentLineBreaks, splitMarkdownTableRow, cleanContentSentence } = require('./tenderText.cjs');

function isReadableSignalSnippet(value) {
  const text = String(value || '').trim();
  if (!text || text.includes('�')) return false;
  const chars = Array.from(text);
  const readable = chars.filter((char) => /[\p{Script=Han}A-Za-z0-9\s.,:;_@/\\\-()[\]{}"'，。：；（）【】《》、]/u.test(char)).length;
  return readable / Math.max(chars.length, 1) >= 0.75;
}

function bigramSimilarity(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return 0;
  if (left === right) return 1;
  const toBigrams = (value) => {
    const chars = Array.from(value);
    if (chars.length <= 1) return new Set(chars);
    return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`));
  };
  const leftSet = toBigrams(left);
  const rightSet = toBigrams(right);
  const shared = intersectSize(leftSet, rightSet);
  return (2 * shared) / (leftSet.size + rightSet.size || 1);
}

function buildOutlineComparison(files) {
  const groups = [];
  const byTitle = new Map();
  const byPath = new Map();
  const successful = files.filter((file) => file.status === 'success');
  for (const file of successful) {
    for (const item of file.items || []) {
      if (item.from_tender) continue;
      const titleList = byTitle.get(item.normalized_title) || [];
      titleList.push({ file, item });
      byTitle.set(item.normalized_title, titleList);
      const pathList = byPath.get(item.normalized_path) || [];
      pathList.push({ file, item });
      byPath.set(item.normalized_path, pathList);
    }
  }

  function addGroup(type, entries, title, score) {
    const fileIds = Array.from(new Set(entries.map((entry) => entry.file.file_id)));
    if (fileIds.length < 2) return null;
    const id = `G${String(groups.length + 1).padStart(4, '0')}`;
    const group = { id, type, title, score, file_ids: fileIds, item_ids: {}, paths: {} };
    for (const entry of entries) {
      group.item_ids[entry.file.file_id] = [...(group.item_ids[entry.file.file_id] || []), entry.item.id];
      group.paths[entry.file.file_id] = [...(group.paths[entry.file.file_id] || []), entry.item.path_titles.join(' > ')];
      if (type === 'duplicate') entry.item.duplicate_group_ids.push(id);
      else entry.item.similar_group_ids.push(id);
    }
    groups.push(group);
    return group;
  }

  for (const entries of byPath.values()) addGroup('duplicate', entries, entries[0]?.item.path_titles.join(' > ') || entries[0]?.item.title || '', 1);
  for (const entries of byTitle.values()) {
    const alreadyGrouped = entries.every((entry) => entry.item.duplicate_group_ids.length);
    if (!alreadyGrouped) addGroup('duplicate', entries, entries[0]?.item.title || '', 0.95);
  }

  const seenSimilar = new Set();
  for (let i = 0; i < successful.length; i += 1) {
    for (let j = i + 1; j < successful.length; j += 1) {
      for (const left of successful[i].items.filter((item) => !item.from_tender && !item.duplicate_group_ids.length)) {
        for (const right of successful[j].items.filter((item) => !item.from_tender && !item.duplicate_group_ids.length && Math.abs(item.level - left.level) <= 1)) {
          const score = bigramSimilarity(left.normalized_title, right.normalized_title);
          if (score < 0.86) continue;
          const key = [successful[i].file_id, left.id, successful[j].file_id, right.id].join(':');
          if (seenSimilar.has(key)) continue;
          seenSimilar.add(key);
          addGroup('similar', [{ file: successful[i], item: left }, { file: successful[j], item: right }], left.title, Number(score.toFixed(2)));
        }
      }
    }
  }

  const pairwiseSimilarities = [];
  for (let i = 0; i < successful.length; i += 1) {
    for (let j = i + 1; j < successful.length; j += 1) {
      const leftItems = successful[i].items.filter((item) => !item.from_tender);
      const rightItems = successful[j].items.filter((item) => !item.from_tender);
      const leftTitles = new Set(leftItems.map((item) => item.normalized_title));
      const rightTitles = new Set(rightItems.map((item) => item.normalized_title));
      const leftPaths = new Set(leftItems.map((item) => item.normalized_path));
      const rightPaths = new Set(rightItems.map((item) => item.normalized_path));
      const titleShared = intersectSize(leftTitles, rightTitles);
      const pathShared = intersectSize(leftPaths, rightPaths);
      const titleOverlap = titleShared / Math.max(Math.min(leftTitles.size, rightTitles.size), 1);
      const pathOverlap = pathShared / Math.max(Math.min(leftPaths.size, rightPaths.size), 1);
      const orderSimilarity = lcsSimilarity(leftItems.map((item) => item.normalized_title), rightItems.map((item) => item.normalized_title));
      const score = Number((pathOverlap * 0.45 + titleOverlap * 0.35 + orderSimilarity * 0.2).toFixed(2));
      pairwiseSimilarities.push({
        file_a_id: successful[i].file_id,
        file_b_id: successful[j].file_id,
        score,
        title_overlap: Number(titleOverlap.toFixed(2)),
        path_overlap: Number(pathOverlap.toFixed(2)),
        order_similarity: Number(orderSimilarity.toFixed(2)),
        shared_count: Math.max(titleShared, pathShared),
        risk: riskFromScore(score),
      });
    }
  }

  return { duplicateGroups: groups.sort((a, b) => b.score - a.score || b.file_ids.length - a.file_ids.length), pairwiseSimilarities };
}

function addContentTextBlock(blocks, value) {
  const text = cleanContentSentence(decodeBasicHtmlEntities(value));
  for (const line of normalizeContentLineBreaks(text).split(/\n+/)) {
    const cleaned = cleanContentSentence(line);
    if (cleaned) blocks.push(cleaned);
  }
}

function isMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, '')));
}

function isMarkdownTableRow(line) {
  return splitMarkdownTableRow(line).length > 1;
}

function cleanMarkdownInlineText(value) {
  return decodeBasicHtmlEntities(String(value || '')
    .replace(markdownImagePattern, ' ')
    .replace(htmlImageSrcPattern, ' ')
    .replace(htmlImagePattern, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1'));
}

function cleanMarkdownLine(value) {
  return cleanMarkdownInlineText(value)
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|>)\s+/, '')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

function extractMarkdownTextBlocks(markdown) {
  const lines = normalizeContentLineBreaks(String(markdown || '').replace(/```[\s\S]*?```/g, '\n')).split('\n');
  const blocks = [];
  const paragraph = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    addContentTextBlock(blocks, paragraph.join(' '));
    paragraph.length = 0;
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (index + 1 < lines.length && isMarkdownTableRow(lines[index]) && isMarkdownTableSeparator(lines[index + 1])) {
      flushParagraph();
      const tableRows = [splitMarkdownTableRow(lines[index])];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        if (!isMarkdownTableSeparator(lines[index])) tableRows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      for (const row of tableRows) {
        for (const cell of row) {
          addContentTextBlock(blocks, cleanMarkdownInlineText(cell));
        }
      }
      continue;
    }

    const rawLine = lines[index];
    const cleaned = cleanMarkdownLine(rawLine);
    if (!cleaned) {
      flushParagraph();
      continue;
    }

    const standalone = /^\s{0,3}#{1,6}\s+/.test(rawLine)
      || /^\s*(?:[-*+]|>)\s+/.test(rawLine)
      || /^\s*(?:\d+(?:\.\d+)*[.)、．]|[一二三四五六七八九十]+[、.．]|（[一二三四五六七八九十\d]+）|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s+/.test(rawLine);
    const fieldLine = /^[^：:\s]{1,18}[：:]/.test(cleaned);
    const sentenceLine = /[。！？!?；;]$/.test(cleaned);
    if (standalone || fieldLine || sentenceLine) {
      flushParagraph();
      addContentTextBlock(blocks, cleaned);
    } else {
      paragraph.push(cleaned);
    }
  }
  flushParagraph();
  return blocks;
}

function codePointToString(value, fallback) {
  try {
    const codePoint = Number.parseInt(value, 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : fallback;
  } catch {
    return fallback;
  }
}


function hexCodePointToString(value, fallback) {
  try {
    const codePoint = Number.parseInt(value, 16);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : fallback;
  } catch {
    return fallback;
  }
}

function decodeBasicHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => hexCodePointToString(hex, match))
    .replace(/&#(\d+);/g, (match, code) => codePointToString(code, match));
}

module.exports = {
  markdownImagePattern,
  htmlImageSrcPattern,
  htmlImagePattern,
  isReadableSignalSnippet,
  extractMarkdownTextBlocks,
  buildOutlineComparison,
  addContentTextBlock,
  cleanMarkdownInlineText,
  cleanMarkdownLine,
};
