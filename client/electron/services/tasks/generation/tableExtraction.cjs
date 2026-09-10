// 正文里的表格检测与清理分批：绕过代码围栏，抽出 Markdown/HTML 表格并切成批次。
// 纯函数，只做字符串与区间运算，不接触任务状态、模型或文件系统，可单独测试。

const { splitLinesWithRanges, rangeOverlaps } = require('./agentResponse.cjs');
const { isMarkdownTableRow } = require('./markdownTables.cjs');

const TABLE_CLEANUP_CONTEXT_CHARS = 600;

const TABLE_CLEANUP_BATCH_CHAR_LIMIT = 30000;

function collectFencedCodeRanges(content) {
  const ranges = [];
  const lines = splitLinesWithRanges(content);
  let fence = null;
  let start = 0;
  for (const line of lines) {
    const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (!match) {
      continue;
    }
    const marker = match[1][0];
    const length = match[1].length;
    const rest = match[2] || '';
    if (!fence) {
      if (marker === '`' && rest.includes('`')) {
        continue;
      }
      fence = { marker, length };
      start = line.start;
      continue;
    }
    if (marker === fence.marker && length >= fence.length && /^[ \t]*$/.test(rest)) {
      ranges.push({ start, end: line.newlineEnd });
      fence = null;
    }
  }
  if (fence) {
    ranges.push({ start, end: String(content || '').length });
  }
  return ranges;
}

function isMarkdownTableSeparator(line) {
  const trimmed = String(line || '').trim();
  if (!isMarkdownTableRow(trimmed)) return false;
  const rawCells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  const cells = rawCells.map((cell) => cell.trim()).filter(Boolean);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function extractMarkdownTableBlocks(content, fencedRanges) {
  const lines = splitLinesWithRanges(content);
  const tables = [];
  let index = 0;
  while (index < lines.length - 1) {
    const header = lines[index];
    const separator = lines[index + 1];
    if (rangeOverlaps(header.start, separator.end, fencedRanges) || !isMarkdownTableRow(header.text) || !isMarkdownTableSeparator(separator.text)) {
      index += 1;
      continue;
    }

    let endLine = index + 1;
    while (endLine + 1 < lines.length && !rangeOverlaps(lines[endLine + 1].start, lines[endLine + 1].end, fencedRanges) && isMarkdownTableRow(lines[endLine + 1].text)) {
      endLine += 1;
    }
    const start = header.start;
    const end = lines[endLine].end;
    tables.push({ type: 'markdown', start, end, text: String(content || '').slice(start, end) });
    index = endLine + 1;
  }
  return tables;
}

function extractHtmlTableBlocks(content, fencedRanges) {
  const text = String(content || '');
  const tables = [];
  const pattern = /<table\b[\s\S]*?<\/table>/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (rangeOverlaps(start, end, fencedRanges)) {
      continue;
    }
    tables.push({ type: 'html', start, end, text: match[0] });
  }
  return tables;
}

function addTableContext(content, tables) {
  const text = String(content || '');
  return (tables || []).map((table, index) => ({
    id: `T${String(index + 1).padStart(3, '0')}`,
    ...table,
    before: text.slice(Math.max(0, table.start - TABLE_CLEANUP_CONTEXT_CHARS), table.start).trim(),
    after: text.slice(table.end, Math.min(text.length, table.end + TABLE_CLEANUP_CONTEXT_CHARS)).trim(),
  }));
}

function extractContentTableBlocks(content) {
  const fencedRanges = collectFencedCodeRanges(content);
  const tables = [
    ...extractMarkdownTableBlocks(content, fencedRanges),
    ...extractHtmlTableBlocks(content, fencedRanges),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const nonOverlapping = [];
  for (const table of tables) {
    if (nonOverlapping.some((existing) => table.start < existing.end && table.end > existing.start)) {
      continue;
    }
    nonOverlapping.push(table);
  }
  return addTableContext(content, nonOverlapping);
}

function containsContentTable(content) {
  return extractContentTableBlocks(content).length > 0;
}

function createTableCleanupBatches(tables) {
  const batches = [];
  let current = [];
  let currentSize = 0;
  for (const table of tables || []) {
    const size = String(table.text || '').length + String(table.before || '').length + String(table.after || '').length;
    if (current.length && currentSize + size > TABLE_CLEANUP_BATCH_CHAR_LIMIT) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(table);
    currentSize += size;
  }
  if (current.length) {
    batches.push(current);
  }
  return batches;
}

module.exports = {
  collectFencedCodeRanges,
  isMarkdownTableSeparator,
  extractMarkdownTableBlocks,
  extractHtmlTableBlocks,
  extractContentTableBlocks,
  containsContentTable,
  createTableCleanupBatches,
};
