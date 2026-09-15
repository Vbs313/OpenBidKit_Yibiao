// 工作区招标/资料 Markdown 统一归一：把三种解析出口收敛到同一方言。
//
// 目标方言：
// 1. 表格为 GFM 管道表，不残留 <table> HTML；
// 2. 无控制字符（保留 \t \n \r）；
// 3. 无「第 N 页 / 共 M 页」干扰行；
// 4. 连续空行压到最多 2 个；无 BOM。
//
// 本地 DOCX 转换会把 HTML 表原样塞回 Markdown；MinerU 多数已是 GFM。
// 本模块对两者都跑一遍，保证后续解析/检查/生成只认一种结构。

const cheerio = require('cheerio');

// 与合规侧 document_text.py 对齐：U+0001 是单元格换行哨兵，一并压成空格。
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const PAGE_MARKER = /^[ \t]{0,3}#{0,6}[ \t]*第[ \t]*\d+[ \t]*页(?:[ \t]*\/[ \t]*共[ \t]*\d+[ \t]*页)?[ \t]*$/;
const HTML_TABLE = /<table\b[\s\S]*?<\/table>/gi;

function stripBom(text) {
  return String(text || '').replace(/^﻿/, '');
}

function normalizeControlChars(text) {
  return stripBom(text).replace(CONTROL_CHARS, ' ');
}

function dropPageMarkerLines(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !PAGE_MARKER.test(line))
    .join('\n');
}

function collapseBlankLines(text) {
  return String(text || '').replace(/\n{3,}/g, '\n\n');
}

function decodeBasicEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
}

function cellText(html) {
  // cheerio 会丢掉文档根上的 <td>/<th>，用 <div> 包一层再取文本。
  const $ = cheerio.load(`<div>${html || ''}</div>`, { decodeEntities: false });
  const root = $('div').first();
  root.find('br').replaceWith(' ');
  root.find('script, style').remove();
  return decodeBasicEntities(root.text())
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSpan(value) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(number) && number > 1 ? number : 1;
}

function extractRows(tableHtml) {
  const $ = cheerio.load(tableHtml, { decodeEntities: false });
  const table = $('table').first();
  if (!table.length) return [];

  const rows = [];
  table.find('tr').each((_, tr) => {
    const cells = [];
    $(tr).children('th, td').each((__, cell) => {
      const node = $(cell);
      const colspan = parseSpan(node.attr('colspan'));
      const value = cellText(node.html() || '');
      cells.push(value);
      for (let extra = 1; extra < colspan; extra += 1) {
        cells.push('');
      }
    });
    if (cells.some((cell) => cell)) {
      rows.push(cells);
    }
  });
  return rows;
}

function renderGfmTable(rows) {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => {
    const next = row.slice();
    while (next.length < width) next.push('');
    return next;
  });
  const header = normalized[0];
  const body = normalized.slice(1);
  const lines = [
    `|${header.join('|')}|`,
    `|${Array.from({ length: width }, () => '---').join('|')}|`,
  ];
  for (const row of body) {
    lines.push(`|${row.join('|')}|`);
  }
  return lines.join('\n');
}

function htmlTableToGfm(tableHtml) {
  const rows = extractRows(tableHtml);
  return renderGfmTable(rows);
}

function convertHtmlTablesToGfm(text) {
  return String(text || '').replace(HTML_TABLE, (match) => {
    const table = htmlTableToGfm(match);
    return table ? `\n\n${table}\n\n` : '';
  });
}

function countGfmTableRows(text) {
  const lines = String(text || '').split('\n');
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1) {
      count += 1;
    }
  }
  return count;
}

function countHtmlTableMarkers(text) {
  const matches = String(text || '').match(/<\/?(?:table|tr|td|th)\b/gi);
  return matches ? matches.length : 0;
}

/**
 * 把任意解析出口收敛成工作区 Markdown 方言。
 * @returns {{ markdown: string, metrics: { chars: number, lines: number, gfmTableRows: number, htmlTableMarkers: number, pageMarkersRemoved: number, controlCharsReplaced: number } }}
 */
function normalizeWorkspaceMarkdown(input) {
  const original = String(input ?? '');
  const withoutBom = stripBom(original);
  const controlCharsReplaced = (withoutBom.match(CONTROL_CHARS) || []).length;

  const lines = withoutBom.split('\n');
  const pageMarkersRemoved = lines.filter((line) => PAGE_MARKER.test(line)).length;

  let markdown = withoutBom.replace(CONTROL_CHARS, ' ');
  markdown = dropPageMarkerLines(markdown);
  markdown = convertHtmlTablesToGfm(markdown);
  markdown = collapseBlankLines(markdown).trim();
  if (markdown && !markdown.endsWith('\n')) {
    markdown = `${markdown}\n`;
  }

  return {
    markdown,
    metrics: {
      chars: markdown.length,
      lines: markdown ? markdown.split('\n').length : 0,
      gfmTableRows: countGfmTableRows(markdown),
      htmlTableMarkers: countHtmlTableMarkers(markdown),
      pageMarkersRemoved,
      controlCharsReplaced,
    },
  };
}

module.exports = {
  normalizeWorkspaceMarkdown,
  convertHtmlTablesToGfm,
  normalizeControlChars,
  dropPageMarkerLines,
  countGfmTableRows,
  countHtmlTableMarkers,
};
