// 导出用的 docx 基础构件：进度/日志回调、文本与段落构造、表格与图片段落、列表与编号引用等。
//
// 这些原本散落在 exportService.cjs 顶部；搬出来后 exportService 只保留文档组装与导出编排。

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { app, dialog, nativeImage } = require('electron');
const cheerio = require('cheerio');
const { imageSize } = require('image-size');
const { compactLogError, createDeveloperLogger, textMetrics } = require('../../utils/developerLog.cjs');
const perfTrace = require('../../utils/perfTrace.cjs');
const { getMermaidCacheEntry, saveMermaidCacheImage } = require('../../utils/mermaidCache.cjs');
const { getGeneratedImagesDir, getImportedImagesDir } = require('../../utils/paths.cjs');
const { REMOTE_IMAGE_RETRY_ATTEMPTS, REMOTE_IMAGE_RETRY_DELAY_MS } = require('../../utils/remoteImageRetry.cjs');
const { renderMarkdownHtml } = require('../../utils/renderMarkdownHtml.cjs');
const { getLocalImageRenderService } = require('../localImageRenderService.cjs');
const {
  normalizeColumnSpan,
  isMarkdownTableRowLine,
  isMarkdownTableDelimiterLine,
  splitMarkdownTableCells,
  isMarkdownTableDelimiterCell,
  formatMarkdownTableRow,
  normalizeMarkdownListMarkersForDocx,
} = require('./markdownDocx.cjs');
const {
  expandCompressedMarkdownTableRows,
  formatOutlineNumber,
} = require('./tableAndNumbering.cjs');
const {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeightRule,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  LevelSuffix,
  Packer,
  PageNumber,
  PageBreak,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalAlignTable,
  WidthType,
} = require('docx');

const MAX_IMAGE_WIDTH = 520;
const MAX_IMAGE_HEIGHT_PERCENT = 90;
const NUMBERING_REFERENCE_PREFIX = 'technical-plan-numbering';
const HEADING_NUMBERING_REFERENCE = 'technical-plan-heading-numbering';
const DOCX_TABLE_WIDTH_TWIPS = 9000;
const CHAPTER_LEAF_TITLE_WIDTH_TWIPS = 1800;
const CHAPTER_LEAF_CONTENT_WIDTH_TWIPS = DOCX_TABLE_WIDTH_TWIPS - CHAPTER_LEAF_TITLE_WIDTH_TWIPS;
const DEFAULT_HEADING_BORDER_CELL_COLORS = ['#e0ecff', '#e9f1ff', '#f2f7ff', '#f8fbff', '#ffffff', '#ffffff'];
const DEFAULT_TABLE_STYLE = {
  border_width: 1,
  border_color: '#dcdff6',
  cell_padding_pt: 6,
  full_width: true,
  header_row: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#243048', background_color: '#eef5ff' },
  first_column: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
  body_cell: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
};
const DEFAULT_IMAGE_STYLE = {
  max_width_percent: 90,
  alignment: '居中对齐',
  caption_font: '宋体',
  caption_size: '小五',
  caption_alignment: '居中对齐',
  caption_bold: false,
  caption_italic: false,
};
const UNORDERED_LIST_MARKERS = {
  disc: { text: '•', font: 'Arial', sizeScale: 0.75 },
  circle: { text: '○', font: 'Arial', sizeScale: 0.82 },
  square: { text: '■', font: 'Arial', sizeScale: 0.72 },
  diamond: { text: '◆', font: 'Arial', sizeScale: 0.72 },
  dash: { text: '–', font: 'Arial', sizeScale: 0.9 },
  check: { text: '✓', font: 'Segoe UI Symbol', sizeScale: 0.85 },
  arrow: { text: '➢', font: 'Segoe UI Symbol', sizeScale: 0.88 },
  sparkle: { text: '✧', font: 'Segoe UI Symbol', sizeScale: 0.9 },
};
const ORDERED_LIST_WORD_STYLES = {
  'decimal-dot': { format: LevelFormat.DECIMAL, text: (level) => `%${level + 1}.` },
  'decimal-paren': { format: LevelFormat.DECIMAL, text: (level) => `%${level + 1}）` },
  'decimal-full-paren': { format: LevelFormat.DECIMAL, text: (level) => `（%${level + 1}）` },
  'chinese-dot': { format: LevelFormat.CHINESE_COUNTING, text: (level) => `%${level + 1}、` },
  'chinese-paren': { format: LevelFormat.CHINESE_COUNTING, text: (level) => `（%${level + 1}）` },
  'lower-alpha': { format: LevelFormat.LOWER_LETTER, text: (level) => `%${level + 1}.` },
  'upper-alpha': { format: LevelFormat.UPPER_LETTER, text: (level) => `%${level + 1}.` },
  'lower-roman': { format: LevelFormat.LOWER_ROMAN, text: (level) => `%${level + 1}.` },
  'upper-roman': { format: LevelFormat.UPPER_ROMAN, text: (level) => `%${level + 1}.` },
};

// 纸张尺寸 mm（portrait 模式 width × height），与 Renderer exportFormat.ts 保持一致
const PAPER_DIMENSIONS_MM = {
  a4: { width: 210, height: 297 },
  a3: { width: 297, height: 420 },
  a5: { width: 148, height: 210 },
  b4: { width: 250, height: 353 },
  b5: { width: 176, height: 250 },
  letter: { width: 215.9, height: 279.4 },
  legal: { width: 215.9, height: 355.6 },
  '16k': { width: 184, height: 260 },
};

function mmToTwips(mm) {
  return Math.round(mm * 56.6929); // 1mm = 1440 twips ÷ 25.4 mm/inch
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPercent(value) {
  return Math.max(0, Math.min(Math.round(Number(value) || 0), 100));
}

function reportProgress(context, progress, message, extra = {}) {
  if (!context?.onProgress) return;
  try {
    context.onProgress({
      phase: extra.phase || 'running',
      progress: clampPercent(progress),
      message,
      warnings: [...(context.warnings || [])],
      ...extra,
    });
  } catch (error) {
    console.warn('[export-word] progress callback failed', error);
  }
}

function reportConversionProgress(context, message) {
  const stats = context?.stats || {};
  const total = Math.max(1, (stats.leafCount || 0) + (stats.mermaidCount || 0));
  const done = Math.min(total, (context.convertedLeafCount || 0) + (context.convertedMermaidCount || 0));
  reportProgress(context, 10 + (done / total) * 78, message);
}

function writeExportLog(context, event, payload = {}) {
  if (!context?.developerLogger?.enabled) return;
  context.developerLogger.write(event, payload);
}

function addWarning(context, message) {
  if (context?.warnings) {
    context.warnings.push(message);
  }
  writeExportLog(context, 'export.warning', { message });
  console.warn(`[export-word] ${message}`);
}

function addUnsupportedHtmlWarning(context, tagName) {
  const tag = String(tagName || '').toLowerCase();
  if (!tag) return;
  if (!context.unsupportedHtmlTags) {
    context.unsupportedHtmlTags = new Set();
  }
  if (context.unsupportedHtmlTags.has(tag)) {
    return;
  }
  context.unsupportedHtmlTags.add(tag);
  addWarning(context, `HTML 标签 <${tag}> 导出时已降级，请核对 Word 内容。`);
}

function compactText(value, maxLength = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function countMermaidBlocks(content) {
  return (String(content || '').match(/```mermaid[\s\S]*?```/gi) || []).length;
}

function countOutlineStats(items = []) {
  let leafCount = 0;
  let mermaidCount = 0;

  for (const item of items || []) {
    if (item.children?.length) {
      const childStats = countOutlineStats(item.children);
      leafCount += childStats.leafCount;
      mermaidCount += childStats.mermaidCount;
    } else {
      leafCount += 1;
      mermaidCount += countMermaidBlocks(item.content);
    }
  }

  return { leafCount, mermaidCount };
}

function buildPendingContentModeParagraph(item) {
  if (String(item?.content || '').trim()) return null;
  let message = '';
  if (item?.content_mode === 'template-fill') {
    message = '待模板填写：后续将从招标文件提取并填充内容。';
  } else if (item?.content_mode === 'point-to-point') {
    message = '待点对点应答表回填：将在正文完成并确定 Word 页码后处理。';
  } else if (item?.content_mode === 'other') {
    message = `待处理：${String(item?.content_mode_note || '').trim() || '该小节采用其他特殊处理模式。'}`;
  }
  return message
    ? paragraph([textRun(`[${message}]`, { color: '8A650B', italics: true })], { after: 120 })
    : null;
}

function collectOutlineContents(items = []) {
  const contents = [];
  for (const item of items || []) {
    if (item.children?.length) {
      contents.push(...collectOutlineContents(item.children));
    } else {
      contents.push(String(item.content || ''));
    }
  }
  return contents;
}

function countOutlineContentMetrics(items = []) {
  const contents = collectOutlineContents(items);
  return {
    ...textMetrics(contents.join('\n\n')),
    leaf_content_count: contents.filter((content) => content.trim()).length,
  };
}

function loadDeveloperConfig(configStore) {
  try {
    return configStore?.load?.() || {};
  } catch {
    return {};
  }
}

function sanitizeFilename(value) {
  return String(value || '标书文档')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '标书文档';
}

function formatExportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function cleanText(value) {
  return String(value || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function normalizeDocxColor(value, fallback = '536176') {
  const raw = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(raw)) return raw.toUpperCase();
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return raw.split('').map((char) => `${char}${char}`).join('').toUpperCase();
  }
  return fallback;
}

function textRun(text, options = {}) {
  return new TextRun({
    text: cleanText(text),
    font: options.font || '宋体',
    size: options.size || 24,
    bold: options.bold,
    italics: options.italics,
    strike: options.strike,
    color: options.color,
    underline: options.underline ? { type: UnderlineType.SINGLE } : undefined,
  });
}

function lineBreakRun() {
  return new TextRun({ break: 1 });
}

function textRunsWithBreaks(value, options = {}) {
  const parts = String(value || '').split(/<br\s*\/?\s*>/gi);
  const runs = [];

  parts.forEach((part, index) => {
    if (index > 0) {
      runs.push(lineBreakRun());
    }
    if (part) {
      runs.push(textRun(part, options));
    }
  });

  return runs;
}

function paragraph(children, options = {}) {
  return new Paragraph({
    children: children?.length ? children : [textRun('')],
    heading: options.heading,
    pageBreakBefore: options.pageBreakBefore,
    alignment: options.alignment,
    bullet: options.bullet,
    numbering: options.numbering,
    spacing: { before: options.before || 0, after: options.after ?? 160, line: options.line || 360 },
    indent: options.indent,
    border: options.border,
    shading: options.shading,
  });
}

function pageBreakParagraph() {
  return paragraph([new PageBreak()], { after: 0, line: 0 });
}

function isLevel1PageBreakEnabled(exportFormat) {
  return exportFormat?.heading_level1_page_break_before === true;
}

function isFooterEnabled(pageSetup) {
  return pageSetup ? pageSetup.footer_enabled !== false : true;
}

function isPageNumberEnabled(pageSetup) {
  return pageSetup ? pageSetup.page_number_enabled !== false : true;
}

function getChapterFrameConfig(exportFormat) {
  const frame = exportFormat?.heading_border;
  if (!frame?.enabled) return null;
  const color = normalizeDocxColor(frame.border_color || '#2174fd', '2174FD');
  const levelCellColors = Array.isArray(frame.level_cell_colors) ? frame.level_cell_colors : [];
  return {
    color,
    minHeadingLeftEnabled: frame.min_heading_left_enabled === true,
    fills: DEFAULT_HEADING_BORDER_CELL_COLORS.map((fill, index) => {
      const fallback = normalizeDocxColor(fill, 'FFFFFF');
      return normalizeDocxColor(levelCellColors[index] || fill, fallback);
    }),
  };
}

function chapterHeadingRowStyle(level) {
  const horizontal = 0;
  const table = [
    { height: 520, top: 120, bottom: 120, left: horizontal, right: horizontal },
    { height: 430, top: 100, bottom: 100, left: horizontal, right: horizontal },
    { height: 360, top: 80, bottom: 80, left: horizontal, right: horizontal },
    { height: 320, top: 70, bottom: 70, left: horizontal, right: horizontal },
    { height: 290, top: 60, bottom: 60, left: horizontal, right: horizontal },
    { height: 270, top: 55, bottom: 55, left: horizontal, right: horizontal },
  ];
  return table[Math.max(0, Math.min(level - 1, table.length - 1))];
}

function buildChapterHeadingRow(exportFormat, headingParagraph, level) {
  const frame = getChapterFrameConfig(exportFormat);
  if (!frame) return undefined;
  const border = { style: BorderStyle.SINGLE, size: 6, color: frame.color };
  const none = { style: BorderStyle.NIL, size: 0, color: 'FFFFFF' };
  const rowStyle = chapterHeadingRowStyle(level);
  const columnSpan = frame.minHeadingLeftEnabled ? 2 : undefined;

  return new TableRow({
    cantSplit: true,
    height: { value: rowStyle.height, rule: HeightRule.ATLEAST },
    children: [new TableCell({
      children: [headingParagraph],
      shading: { type: ShadingType.CLEAR, fill: frame.fills[Math.max(0, Math.min(level - 1, 5))] || 'FFFFFF' },
      margins: { top: rowStyle.top, bottom: rowStyle.bottom, left: rowStyle.left, right: rowStyle.right },
      columnSpan,
      width: { size: DOCX_TABLE_WIDTH_TWIPS, type: WidthType.DXA },
      borders: { top: border, left: border, right: border, bottom: border },
    })],
  });
}

function buildChapterContentRow(exportFormat, bodyChildren) {
  const frame = getChapterFrameConfig(exportFormat);
  if (!frame) return undefined;
  const border = { style: BorderStyle.SINGLE, size: 6, color: frame.color };
  const none = { style: BorderStyle.NIL, size: 0, color: 'FFFFFF' };
  const body = bodyChildren?.length ? bodyChildren : [paragraph([textRun('')], { after: 0 })];
  const columnSpan = frame.minHeadingLeftEnabled ? 2 : undefined;

  return new TableRow({
    children: [new TableCell({
      children: body,
      margins: { top: 200, bottom: 220, left: 260, right: 260 },
      columnSpan,
      width: { size: DOCX_TABLE_WIDTH_TWIPS, type: WidthType.DXA },
      borders: { top: none, left: border, right: border, bottom: border },
    })],
  });
}

function buildChapterLeafRow(exportFormat, titleParagraph, bodyChildren, level) {
  const frame = getChapterFrameConfig(exportFormat);
  if (!frame) return undefined;
  const border = { style: BorderStyle.SINGLE, size: 6, color: frame.color };
  const body = bodyChildren?.length ? bodyChildren : [paragraph([textRun('')], { after: 0 })];
  const fill = frame.fills[Math.max(0, Math.min(level - 1, 5))] || 'FFFFFF';

  return new TableRow({
    children: [
      new TableCell({
        children: [titleParagraph],
        shading: { type: ShadingType.CLEAR, fill },
        margins: { top: 160, bottom: 160, left: 160, right: 160 },
        verticalAlign: VerticalAlignTable.CENTER,
        width: { size: CHAPTER_LEAF_TITLE_WIDTH_TWIPS, type: WidthType.DXA },
        borders: { top: border, left: border, right: border, bottom: border },
      }),
      new TableCell({
        children: body,
        margins: { top: 200, bottom: 220, left: 260, right: 260 },
        width: { size: CHAPTER_LEAF_CONTENT_WIDTH_TWIPS, type: WidthType.DXA },
        borders: { top: border, left: border, right: border, bottom: border },
      }),
    ],
  });
}

function buildChapterFrameTable(exportFormat, rows) {
  const frame = getChapterFrameConfig(exportFormat);
  if (!frame) return undefined;
  const border = { style: BorderStyle.SINGLE, size: 6, color: frame.color };
  const none = { style: BorderStyle.NIL, size: 0, color: 'FFFFFF' };

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: frame.minHeadingLeftEnabled ? [CHAPTER_LEAF_TITLE_WIDTH_TWIPS, CHAPTER_LEAF_CONTENT_WIDTH_TWIPS] : [DOCX_TABLE_WIDTH_TWIPS],
    layout: TableLayoutType.FIXED,
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: none,
    },
  });
}

function createPageNumberRuns(format, runOptions) {
  const parts = String(format || '第{page}页').split('{page}');
  const runs = [];

  if (parts[0]) {
    runs.push(new TextRun({ ...runOptions, text: cleanText(parts[0]) }));
  }
  runs.push(new TextRun({ ...runOptions, children: [PageNumber.CURRENT] }));
  if (parts[1]) {
    runs.push(new TextRun({ ...runOptions, text: cleanText(parts[1]) }));
  }

  return runs;
}

function buildWordHeaders(pageSetup) {
  const enabled = pageSetup ? pageSetup.header_enabled === true : false;
  const headerText = cleanText(pageSetup?.header_text || '').trim();
  if (!enabled || !headerText) return undefined;

  const runOptions = {
    font: pageSetup?.header_font || '宋体',
    size: chineseSizeToHalfPt(pageSetup?.header_size || '小五'),
    color: normalizeDocxColor(pageSetup?.header_color || '#536176'),
  };

  return {
    default: new Header({
      children: [
        new Paragraph({
          alignment: alignmentToWordType(pageSetup?.header_alignment || '居中对齐'),
          children: [new TextRun({ ...runOptions, text: headerText })],
        }),
      ],
    }),
  };
}

function buildWordFooters(pageSetup) {
  const footerEnabled = isFooterEnabled(pageSetup);
  const footerText = footerEnabled ? cleanText(pageSetup?.footer_text || '').trim() : '';
  const pageNumberEnabled = isPageNumberEnabled(pageSetup);
  if (!footerText && !pageNumberEnabled) return undefined;

  const runOptions = {
    font: pageSetup?.footer_font || '宋体',
    size: chineseSizeToHalfPt(pageSetup?.footer_size || '小五'),
    color: normalizeDocxColor(pageSetup?.footer_color || '#536176'),
  };
  const footerChildren = [];

  if (footerText) {
    footerChildren.push(new TextRun({ ...runOptions, text: footerText }));
  }
  if (footerText && pageNumberEnabled) {
    footerChildren.push(new TextRun({ ...runOptions, text: '    ' }));
  }
  if (pageNumberEnabled) {
    footerChildren.push(...createPageNumberRuns(pageSetup?.page_number_format || '第{page}页', runOptions));
  }

  return {
    default: new Footer({
      children: [
        new Paragraph({
          alignment: alignmentToWordType(footerEnabled ? (pageSetup?.footer_alignment || '居中对齐') : '居中对齐'),
          children: footerChildren,
        }),
      ],
    }),
  };
}

function getTableStyle(context) {
  return context?.exportFormat?.table || DEFAULT_TABLE_STYLE;
}

function getTableCellStyle(context, { isHeader = false, isFirstColumn = false } = {}) {
  const table = getTableStyle(context);
  if (isHeader) return table.header_row;
  if (isFirstColumn) return table.first_column;
  return table.body_cell;
}

function tableBorderSize(context) {
  const width = Number(getTableStyle(context).border_width) || 0;
  if (width <= 0) return 0;
  return Math.max(1, Math.round(width * 6));
}

function tableBorders(context) {
  const size = tableBorderSize(context);
  if (size <= 0) {
    const none = { style: BorderStyle.NIL, size: 0, color: 'FFFFFF' };
    return {
      top: none,
      bottom: none,
      left: none,
      right: none,
      insideHorizontal: none,
      insideVertical: none,
    };
  }

  const border = {
    style: BorderStyle.SINGLE,
    size,
    color: normalizeDocxColor(getTableStyle(context).border_color, 'DCDFF6'),
  };
  return {
    top: border,
    bottom: border,
    left: border,
    right: border,
    insideHorizontal: border,
    insideVertical: border,
  };
}

function tableCellMargins(context) {
  const padding = Math.max(0, Number(getTableStyle(context).cell_padding_pt) || 0);
  const twips = Math.round(padding * 20);
  return { top: twips, bottom: twips, left: twips, right: twips };
}

function tableCellRunMarks(style) {
  return {
    font: style?.font || DEFAULT_TABLE_STYLE.body_cell.font,
    size: chineseSizeToHalfPt(style?.size || DEFAULT_TABLE_STYLE.body_cell.size),
    color: normalizeDocxColor(style?.text_color || DEFAULT_TABLE_STYLE.body_cell.text_color, '243048'),
  };
}

function tableCellParagraphOptions(style) {
  return {
    after: 80,
    alignment: alignmentToWordType(style?.alignment || DEFAULT_TABLE_STYLE.body_cell.alignment),
  };
}

function tableColumnWidths(columnCount) {
  const safeCount = Math.max(1, columnCount || 1);
  const base = Math.floor(DOCX_TABLE_WIDTH_TWIPS / safeCount);
  const widths = Array.from({ length: safeCount }, () => base);
  widths[widths.length - 1] += DOCX_TABLE_WIDTH_TWIPS - (base * safeCount);
  return widths;
}

function tableCellWidth(columnSpan, totalColumns) {
  const safeTotal = Math.max(1, totalColumns || 1);
  const safeSpan = Math.max(1, columnSpan || 1);
  return Math.round((DOCX_TABLE_WIDTH_TWIPS * safeSpan) / safeTotal);
}

function createTableCell({ children, context, isHeader = false, isFirstColumn = false, columnSpan = 1, totalColumns = 1 }) {
  const safeSpan = Math.max(1, columnSpan || 1);
  const table = getTableStyle(context);
  const cellStyle = getTableCellStyle(context, { isHeader, isFirstColumn });
  const fullWidth = table.full_width !== false;
  return new TableCell({
    children,
    shading: { type: ShadingType.CLEAR, fill: normalizeDocxColor(cellStyle?.background_color, 'FFFFFF') },
    margins: tableCellMargins(context),
    columnSpan: safeSpan > 1 ? safeSpan : undefined,
    width: fullWidth ? { size: tableCellWidth(safeSpan, totalColumns), type: WidthType.DXA } : undefined,
  });
}

function createDocxTable(rows, columnCount, context) {
  const table = getTableStyle(context);
  const fullWidth = table.full_width !== false;
  const options = {
    rows,
    width: fullWidth ? { size: 100, type: WidthType.PERCENTAGE } : { size: 0, type: WidthType.AUTO },
    layout: fullWidth ? TableLayoutType.FIXED : TableLayoutType.AUTOFIT,
    borders: tableBorders(context),
  };
  if (fullWidth) {
    options.columnWidths = tableColumnWidths(columnCount);
  }
  return new Table(options);
}

function getImageStyle(context) {
  return context?.exportFormat?.image || DEFAULT_IMAGE_STYLE;
}

function getPageContentWidthPx(context) {
  const pageSetup = context?.exportFormat?.page || {};
  const dims = PAPER_DIMENSIONS_MM[pageSetup.paper_size] || PAPER_DIMENSIONS_MM.a4;
  const pageWidthMm = pageSetup.orientation === 'landscape' ? dims.height : dims.width;
  const pageWidthTwips = mmToTwips(pageWidthMm);
  const marginLeftTwips = cmToTwips(pageSetup.margin_left_cm ?? 2);
  const marginRightTwips = cmToTwips(pageSetup.margin_right_cm ?? 2);
  const contentWidthTwips = Math.max(1, pageWidthTwips - marginLeftTwips - marginRightTwips);
  return Math.round(contentWidthTwips / 15);
}

// 按当前纸张、方向和页边距计算 Word 正文区域可用高度。
function getPageContentHeightPx(context) {
  const pageSetup = context?.exportFormat?.page || {};
  const dims = PAPER_DIMENSIONS_MM[pageSetup.paper_size] || PAPER_DIMENSIONS_MM.a4;
  const pageHeightMm = pageSetup.orientation === 'landscape' ? dims.width : dims.height;
  const pageHeightTwips = mmToTwips(pageHeightMm);
  const marginTopTwips = cmToTwips(pageSetup.margin_top_cm ?? 2);
  const marginBottomTwips = cmToTwips(pageSetup.margin_bottom_cm ?? 2);
  const contentHeightTwips = Math.max(1, pageHeightTwips - marginTopTwips - marginBottomTwips);
  return Math.round(contentHeightTwips / 15);
}

function getImageMaxWidth(context) {
  const image = getImageStyle(context);
  const percent = Math.max(1, Math.min(100, Number(image.max_width_percent) || DEFAULT_IMAGE_STYLE.max_width_percent));
  return Math.max(1, Math.round(getPageContentWidthPx(context) * percent / 100));
}

function getImageMaxHeight(context) {
  return Math.max(1, Math.round(getPageContentHeightPx(context) * MAX_IMAGE_HEIGHT_PERCENT / 100));
}

function getImageParagraphOptions(context) {
  const image = getImageStyle(context);
  return { alignment: alignmentToWordType(image.alignment || DEFAULT_IMAGE_STYLE.alignment) };
}

function getCaptionRunMarks(context) {
  const image = getImageStyle(context);
  const marks = {
    font: image.caption_font || DEFAULT_IMAGE_STYLE.caption_font,
    size: chineseSizeToHalfPt(image.caption_size || DEFAULT_IMAGE_STYLE.caption_size),
  };
  if (image.caption_bold === true) {
    marks.bold = true;
  }
  if (image.caption_italic === true) {
    marks.italics = true;
  }
  return marks;
}

function getCaptionParagraphOptions(context) {
  const image = getImageStyle(context);
  return {
    alignment: alignmentToWordType(image.caption_alignment || DEFAULT_IMAGE_STYLE.caption_alignment),
    after: context?.bodyAfterSpacing ?? 160,
    line: context?.bodyLineSpacing,
    indent: { left: 0, right: 0, firstLine: 0, hanging: 0 },
  };
}

function expandInlineMarkdownTableRows(line) {
  const source = String(line || '');
  if (!/\|\s*:?-{3,}:?\s*\|/.test(source)) {
    return [source];
  }

  const firstPipeIndex = source.indexOf('|');
  if (firstPipeIndex < 0) {
    return [source];
  }

  const prefix = source.slice(0, firstPipeIndex);
  const isIndentedTableLine = /^\s*$/.test(prefix);
  const tableText = source.slice(firstPipeIndex).trim();
  const tableRows = tableText
    .replace(/\|\s+\|/g, '|\n|')
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);

  if (isIndentedTableLine) {
    return tableRows.map((row) => `${prefix}${row}`);
  }

  return [prefix.trimEnd(), ...tableRows];
}

function normalizeMarkdownTablesForDocx(content) {
  const expandedLines = String(content || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap(expandInlineMarkdownTableRows);
  const lines = [];

  for (let index = 0; index < expandedLines.length; index += 1) {
    const line = expandedLines[index];
    const nextLine = expandedLines[index + 1] || '';
    const compressedTableRows = expandCompressedMarkdownTableRows(line, nextLine);
    const startsCompressedTable = Boolean(compressedTableRows);
    const startsTable = isMarkdownTableRowLine(line) && isMarkdownTableDelimiterLine(nextLine);
    const previousLine = lines[lines.length - 1] || '';

    if ((startsTable || startsCompressedTable) && previousLine.trim() && !isMarkdownTableRowLine(previousLine)) {
      lines.push('');
    }
    if (compressedTableRows) {
      lines.push(...compressedTableRows);
      index += 1;
      continue;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

function createListReference(context, ordered) {
  const bodyStyle = context.exportFormat?.body_text || {};
  if (!ordered && bodyStyle.list_style === 'none') {
    return null;
  }
  if (!context.numberingReferences) {
    context.numberingReferences = [];
  }
  context.numberingIndex = (context.numberingIndex || 0) + 1;
  const reference = `${NUMBERING_REFERENCE_PREFIX}-${context.numberingIndex}`;
  context.numberingReferences.push({
    reference,
    ordered,
    unorderedListStyle: bodyStyle.list_style || 'disc',
    orderedListStyle: bodyStyle.ordered_list_style || 'decimal-dot',
    listIndentChars: typeof bodyStyle.list_indent_chars === 'number' ? bodyStyle.list_indent_chars : 2,
    bodyRunFont: context.bodyRunFont || '宋体',
    bodyRunSize: context.bodyRunSize || 24,
  });
  return reference;
}

function createOrderedListReference(context) {
  return createListReference(context, true);
}

function createUnorderedListReference(context) {
  return createListReference(context, false);
}

function headingLevel(level) {
  if (level <= 1) return HeadingLevel.HEADING_1;
  if (level === 2) return HeadingLevel.HEADING_2;
  if (level === 3) return HeadingLevel.HEADING_3;
  if (level === 4) return HeadingLevel.HEADING_4;
  if (level === 5) return HeadingLevel.HEADING_5;
  return HeadingLevel.HEADING_6;
}

// ── 导出格式工具函数 ────────────────────────────

const SIZE_TO_HALF_PT = {
  '初号': 84, '小初': 72, '一号': 52, '小一': 48, '二号': 44, '小二': 36,
  '三号': 32, '小三': 30, '四号': 28, '小四': 24, '五号': 21, '小五': 18,
  '六号': 15, '小六': 13,
};

function chineseSizeToHalfPt(sizeName) {
  return SIZE_TO_HALF_PT[sizeName] || 24;
}

function charsToTwips(chars, bodySizeHalfPt = 24) {
  const safeChars = Math.max(0, Number(chars) || 0);
  const safeHalfPt = Math.max(1, Number(bodySizeHalfPt) || 24);
  return Math.round(safeChars * safeHalfPt * 10);
}

function cmToTwips(cm) {
  return Math.round((cm || 0) * 567);
}

function alignmentToWordType(align) {
  const map = {
    '居中对齐': AlignmentType.CENTER,
    '两端对齐': AlignmentType.JUSTIFIED,
    '左对齐': AlignmentType.LEFT,
    '右对齐': AlignmentType.RIGHT,
  };
  return map[align] || AlignmentType.JUSTIFIED;
}

function shouldInsertSpaceAfterNumber(prefix) {
  return !/[、，。；：）)】\]》〉]$/.test(prefix);
}

function formatOutlineTitle(id, title, headingStyle) {
  const prefix = formatOutlineNumber(id, headingStyle);
  if (!prefix) return String(title || '');
  return `${prefix}${shouldInsertSpaceAfterNumber(prefix) ? ' ' : ''}${title || ''}`;
}

function getHeadingStyle(exportFormat, level) {
  const headings = (exportFormat && Array.isArray(exportFormat.headings)) ? exportFormat.headings : [];
  const idx = Math.min(level - 1, 5);
  return headings[idx] || null;
}

function usesNativeHeadingNumbering(headingStyle) {
  return false;
}

function imageTypeFromMime(mime) {
  if (!mime) return null;
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  if (mime.includes('webp')) return 'webp';
  return null;
}

function imageTypeFromPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase().replace('.', '');
  if (ext === 'jpeg') return 'jpg';
  return ['png', 'jpg', 'gif', 'bmp', 'webp'].includes(ext) ? ext : null;
}

function describeImageSourceForLog(source) {
  const value = String(source || '').trim();
  if (!value) return { kind: 'empty' };
  if (/^data:/i.test(value)) return { kind: 'data-url' };
  try {
    const url = new URL(value);
    if (url.protocol === 'yibiao-asset:') {
      return { kind: 'asset', host: url.hostname, extension: path.extname(url.pathname || '').toLowerCase() };
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { kind: 'remote', protocol: url.protocol.replace(':', ''), host: url.hostname, extension: path.extname(url.pathname || '').toLowerCase() };
    }
    if (url.protocol === 'file:') {
      return { kind: 'local-file-url', extension: path.extname(url.pathname || '').toLowerCase() };
    }
    return { kind: 'url', protocol: url.protocol.replace(':', '') };
  } catch {
    return { kind: path.isAbsolute(value) ? 'local-path' : 'relative-path', extension: path.extname(value).toLowerCase() };
  }
}

function normalizeImageForDocx(loaded) {
  if (!loaded?.buffer || !loaded.type) {
    return loaded;
  }

  if (loaded.type !== 'webp') {
    return loaded;
  }

  const image = nativeImage?.createFromBuffer ? nativeImage.createFromBuffer(loaded.buffer) : null;
  if (!image || image.isEmpty()) {
    throw new Error('WebP 图片转换失败');
  }

  return { buffer: image.toPNG(), type: 'png' };
}

function resolveAssetImagePath(url) {
  if (!app?.getPath) return null;

  const assetUrl = new URL(url);
  const assetRoots = {
    'generated-images': getGeneratedImagesDir(app),
    'imported-images': getImportedImagesDir(app),
  };
  const rootDir = assetRoots[assetUrl.hostname];
  if (!rootDir) return null;

  const relativePath = decodeURIComponent(assetUrl.pathname.replace(/^\/+/, ''));
  if (!relativePath) return null;

  const baseDir = path.resolve(rootDir);
  const resolvedPath = path.resolve(baseDir, relativePath);
  if (resolvedPath !== baseDir && !resolvedPath.startsWith(`${baseDir}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}

async function loadImage(source, context = {}) {
  const url = String(source || '').trim();
  if (!url) return null;

  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  if (dataUrlMatch) {
    return {
      buffer: Buffer.from(dataUrlMatch[2], 'base64'),
      type: imageTypeFromMime(dataUrlMatch[1]),
    };
  }

  if (/^yibiao-asset:\/\//i.test(url)) {
    const assetPath = resolveAssetImagePath(url);
    if (!assetPath || !fs.existsSync(assetPath)) {
      return null;
    }

    return {
      buffer: fs.readFileSync(assetPath),
      type: imageTypeFromPath(assetPath),
    };
  }

  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`图片下载失败：${url}`);
    }
    const type = imageTypeFromMime(response.headers.get('content-type')) || imageTypeFromPath(new URL(url).pathname);
    return { buffer: Buffer.from(await response.arrayBuffer()), type };
  }

  const fileUrlPrefix = 'file://';
  const rawPath = url.startsWith(fileUrlPrefix) ? fileURLToPath(url) : url;
  const resolvedPath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(context.baseDir || process.cwd(), rawPath);

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  return {
    buffer: fs.readFileSync(resolvedPath),
    type: imageTypeFromPath(resolvedPath),
  };
}

async function loadImageWithRetry(source, context = {}, options = {}) {
  const retryAttempts = Math.max(0, Number(options.retryAttempts) || 0);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 0);
  let attempt = 0;

  while (attempt <= retryAttempts) {
    try {
      return await loadImage(source, context);
    } catch (error) {
      if (attempt >= retryAttempts) {
        throw error;
      }

      attempt += 1;
      if (typeof options.onRetry === 'function') {
        options.onRetry(attempt, error);
      }
      if (retryDelayMs > 0) {
        await delay(retryDelayMs);
      }
    }
  }

  return null;
}

async function resolveMermaidImageForExport(code, context = {}, options = {}) {
  const cacheEntry = options.cacheEntry || getMermaidCacheEntry(app, code);
  if (cacheEntry.exists) {
    return {
      source: cacheEntry.assetUrl,
      cacheHit: true,
      cacheHash: cacheEntry.hash,
    };
  }

  const retryAttempts = Math.max(0, Number(options.loadRetry?.retryAttempts ?? REMOTE_IMAGE_RETRY_ATTEMPTS) || 0);
  const retryDelayMs = Math.max(0, Number(options.loadRetry?.retryDelayMs ?? REMOTE_IMAGE_RETRY_DELAY_MS) || 0);
  let attempt = 0;
  let lastError = null;
  let loaded = null;

  while (attempt <= retryAttempts) {
    try {
      const rendered = await getLocalImageRenderService().renderMermaidToPng(cacheEntry.code);
      if (!rendered?.buffer?.length) {
        throw new Error('Mermaid 本地转换未生成有效图片');
      }
      loaded = {
        buffer: rendered.buffer,
        type: 'png',
        width: rendered.width,
        height: rendered.height,
      };
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt > retryAttempts) break;
      if (typeof options.loadRetry?.onRetry === 'function') {
        options.loadRetry.onRetry(attempt, error);
      }
      if (retryDelayMs > 0) await delay(retryDelayMs);
    }
  }

  if (!loaded?.buffer?.length) {
    throw lastError || new Error('Mermaid 本地转换失败');
  }

  try {
    saveMermaidCacheImage(app, cacheEntry.hash, loaded.buffer);
  } catch (error) {
    writeExportLog(context, 'export.mermaid.cache_write_failed', {
      cache_hash: cacheEntry.hash,
      error: compactLogError(error),
    });
  }

  return {
    source: cacheEntry.assetUrl,
    loaded,
    cacheHit: false,
    cacheHash: cacheEntry.hash,
  };
}

// 读取高分辨率截图携带的像素密度，版面尺寸仍按设计像素计算。
function getImagePixelDensity(source) {
  try {
    const url = new URL(String(source || ''));
    const isInternalRenderAsset = url.protocol === 'yibiao-asset:'
      && url.hostname === 'generated-images'
      && (url.pathname.startsWith('/mermaid-cache/')
        || url.pathname.startsWith('/technical-plan/illustrations/'));
    if (!isInternalRenderAsset) return 1;
    const value = Number(url.searchParams.get('pixel-density'));
    return Number.isFinite(value) && value >= 1 ? value : 1;
  } catch {
    return 1;
  }
}

module.exports = {
  mmToTwips,
  delay,
  clampPercent,
  reportProgress,
  reportConversionProgress,
  writeExportLog,
  addWarning,
  addUnsupportedHtmlWarning,
  compactText,
  countMermaidBlocks,
  countOutlineStats,
  buildPendingContentModeParagraph,
  collectOutlineContents,
  countOutlineContentMetrics,
  loadDeveloperConfig,
  sanitizeFilename,
  formatExportTimestamp,
  cleanText,
  normalizeDocxColor,
  textRun,
  lineBreakRun,
  textRunsWithBreaks,
  paragraph,
  pageBreakParagraph,
  isLevel1PageBreakEnabled,
  isFooterEnabled,
  isPageNumberEnabled,
  getChapterFrameConfig,
  chapterHeadingRowStyle,
  buildChapterHeadingRow,
  buildChapterContentRow,
  buildChapterLeafRow,
  buildChapterFrameTable,
  createPageNumberRuns,
  buildWordHeaders,
  buildWordFooters,
  getTableStyle,
  getTableCellStyle,
  tableBorderSize,
  tableBorders,
  tableCellMargins,
  tableCellRunMarks,
  tableCellParagraphOptions,
  tableColumnWidths,
  tableCellWidth,
  createTableCell,
  createDocxTable,
  getImageStyle,
  getPageContentWidthPx,
  getPageContentHeightPx,
  getImageMaxWidth,
  getImageMaxHeight,
  getImageParagraphOptions,
  getCaptionRunMarks,
  getCaptionParagraphOptions,
  expandInlineMarkdownTableRows,
  normalizeMarkdownTablesForDocx,
  createListReference,
  createOrderedListReference,
  createUnorderedListReference,
  headingLevel,
  SIZE_TO_HALF_PT,
  chineseSizeToHalfPt,
  charsToTwips,
  cmToTwips,
  alignmentToWordType,
  shouldInsertSpaceAfterNumber,
  formatOutlineTitle,
  getHeadingStyle,
  usesNativeHeadingNumbering,
  imageTypeFromMime,
  imageTypeFromPath,
  describeImageSourceForLog,
  normalizeImageForDocx,
  resolveAssetImagePath,
  loadImage,
  loadImageWithRetry,
  resolveMermaidImageForExport,
  getImagePixelDensity,
};
