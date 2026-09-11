// 导出用的 HTML / Markdown 转换层：把正文里的 HTML、表格、列表、标题与 Mermaid 块转成 docx 块。
//
// 这些原本散落在 exportService.cjs 顶部；搬出来后 exportService 只保留文档组装与导出编排。

const fs = require('node:fs');
const path = require('node:path');
const {
  compactText,
  writeExportLog,
  describeImageSourceForLog,
  loadImageWithRetry,
  addWarning,
  textRun,
  normalizeImageForDocx,
  getImagePixelDensity,
  getImageMaxWidth,
  getImageMaxHeight,
  cleanText,
  paragraph,
  getImageParagraphOptions,
  textRunsWithBreaks,
  lineBreakRun,
  addUnsupportedHtmlWarning,
  getTableCellStyle,
  createTableCell,
  tableCellRunMarks,
  tableCellParagraphOptions,
  createDocxTable,
  createOrderedListReference,
  createUnorderedListReference,
  reportConversionProgress,
  resolveMermaidImageForExport,
  getHeadingStyle,
  headingLevel,
  alignmentToWordType,
  chineseSizeToHalfPt,
  getCaptionRunMarks,
  getCaptionParagraphOptions,
  normalizeMarkdownTablesForDocx,
  getManualUnorderedListLevelIndent,
  getTaskListLevelIndent,
  buildDocxImageGuidanceBox,
} = require('./docxPrimitives.cjs');
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

async function imageRunFromNode(node, context, options = {}) {
  let loaded = null;
  const imageLabel = compactText(node.alt || node.url || '未知图片');
  const imageIndex = (context.imageCount || 0) + 1;
  context.imageCount = imageIndex;
  writeExportLog(context, 'export.image.started', {
    image_index: imageIndex,
    label: imageLabel,
    source: describeImageSourceForLog(node.url),
  });
  try {
    loaded = Object.prototype.hasOwnProperty.call(options, 'loadedImage')
      ? options.loadedImage
      : await loadImageWithRetry(node.url, context, options.loadRetry);
  } catch (error) {
    const message = `图片无法导出：${imageLabel}，${compactText(error.message || '下载失败', 120)}`;
    addWarning(context, message);
    writeExportLog(context, 'export.image.error', {
      image_index: imageIndex,
      label: imageLabel,
      phase: 'load',
      error: compactLogError(error),
    });
    return textRun(`[${message}]`, { color: 'C83220' });
  }
  if (!loaded?.buffer || !loaded.type) {
    const message = `图片无法导出：${imageLabel}，未找到可用图片数据`;
    addWarning(context, message);
    writeExportLog(context, 'export.image.error', {
      image_index: imageIndex,
      label: imageLabel,
      phase: 'load',
      reason: 'missing_image_data',
    });
    return textRun(`[${message}]`, { color: 'C83220' });
  }

  try {
    loaded = normalizeImageForDocx(loaded);
  } catch (error) {
    const message = `图片无法导出：${imageLabel}，${error.message || '图片格式转换失败'}`;
    addWarning(context, message);
    writeExportLog(context, 'export.image.error', {
      image_index: imageIndex,
      label: imageLabel,
      phase: 'normalize',
      source_type: loaded.type,
      error: compactLogError(error),
    });
    return textRun(`[${message}]`, { color: 'C83220' });
  }

  let size;
  try {
    size = imageSize(loaded.buffer);
  } catch (error) {
    const message = `图片无法导出：${imageLabel}，图片尺寸识别失败`;
    addWarning(context, message);
    writeExportLog(context, 'export.image.error', {
      image_index: imageIndex,
      label: imageLabel,
      phase: 'size',
      type: loaded.type,
      bytes: loaded.buffer.length,
      error: compactLogError(error),
    });
    return textRun(`[${message}]`, { color: 'C83220' });
  }
  const pixelDensity = getImagePixelDensity(node.url);
  const sourceWidth = (size.width || MAX_IMAGE_WIDTH) / pixelDensity;
  const sourceHeight = (size.height || Math.round(MAX_IMAGE_WIDTH * 0.62)) / pixelDensity;
  const maxWidth = getImageMaxWidth(context);
  const maxHeight = getImageMaxHeight(context);
  const ratio = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * ratio));
  const height = Math.max(1, Math.round(sourceHeight * ratio));
  context.imageSuccessCount = (context.imageSuccessCount || 0) + 1;
  writeExportLog(context, 'export.image.completed', {
    image_index: imageIndex,
    label: imageLabel,
    type: loaded.type,
    bytes: loaded.buffer.length,
    source_width: sourceWidth,
    source_height: sourceHeight,
    pixel_density: pixelDensity,
    max_width: maxWidth,
    max_height: maxHeight,
    scale_ratio: ratio,
    output_width: width,
    output_height: height,
  });

  return new ImageRun({
    type: loaded.type,
    data: loaded.buffer,
    transformation: { width, height },
    altText: {
      title: cleanText(node.alt || '图片'),
      description: cleanText(node.alt || node.url || 'Markdown 图片'),
      name: cleanText(node.alt || 'image'),
    },
  });
}

async function imageParagraphFromSource(source, alt, context, options = {}) {
  return paragraph([await imageRunFromNode({ url: source, alt }, context, options)], getImageParagraphOptions(context));
}

async function imageParagraphFromLoadedImage(source, alt, loadedImage, context, options = {}) {
  return paragraph([
    await imageRunFromNode({ url: source, alt }, context, { ...options, loadedImage }),
  ], getImageParagraphOptions(context));
}

function isHtmlBrNode(node) {
  return node?.type === 'tag' && htmlTagName(node) === 'br';
}

function htmlInlineGroupHasContent($, nodes = []) {
  return nodes.some((node) => {
    if (!node) return false;
    if (node.type === 'text') return Boolean(String(node.data || '').trim());
    if (node.type === 'tag') return htmlTagName(node) !== 'br' || Boolean($(node).text().trim());
    return false;
  });
}

function splitHtmlInlineNodesByBreaks($, nodes = []) {
  const groups = [];
  let current = [];
  let hasBreak = false;

  for (const node of nodes) {
    if (isHtmlBrNode(node)) {
      hasBreak = true;
      groups.push(current);
      current = [];
      continue;
    }
    current.push(node);
  }
  groups.push(current);

  if (!hasBreak) return [nodes];
  return groups.filter((group) => htmlInlineGroupHasContent($, group));
}

function htmlTagName(node) {
  return String(node?.name || '').toLowerCase();
}

function hasBlockHtmlChildren($, node) {
  return $(node).contents().toArray().some((child) => ['table', 'ul', 'ol', 'blockquote', 'pre', 'div', 'section', 'article', 'img', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(htmlTagName(child)));
}

async function htmlInlineRuns($, nodes = [], context = {}, marks = {}) {
  // 正文样式作为基础，调用方显式传入的 font/size 覆盖
  if (context.bodyRunFont && !('font' in marks)) {
    marks = { font: context.bodyRunFont, ...marks };
  }
  if (context.bodyRunSize && !('size' in marks)) {
    marks = { size: context.bodyRunSize, ...marks };
  }
  const runs = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      runs.push(...textRunsWithBreaks(node.data || '', marks));
      continue;
    }

    if (node.type !== 'tag') {
      continue;
    }

    const tag = htmlTagName(node);
    if (tag === 'br') {
      runs.push(lineBreakRun());
    } else if (tag === 'strong' || tag === 'b') {
      runs.push(...await htmlInlineRuns($, $(node).contents().toArray(), context, { ...marks, bold: true }));
    } else if (tag === 'em' || tag === 'i') {
      runs.push(...await htmlInlineRuns($, $(node).contents().toArray(), context, { ...marks, italics: true }));
    } else if (tag === 'del' || tag === 's' || tag === 'strike') {
      runs.push(...await htmlInlineRuns($, $(node).contents().toArray(), context, { ...marks, strike: true }));
    } else if (tag === 'code') {
      runs.push(new TextRun({ text: cleanText($(node).text()), font: 'Consolas', size: 22, color: '155BD7' }));
    } else if (tag === 'a') {
      const href = $(node).attr('href') || '';
      const children = await htmlInlineRuns($, $(node).contents().toArray(), context, { ...marks, color: '2174FD', underline: true });
      if (href) {
        runs.push(new ExternalHyperlink({ link: href, children }));
      } else {
        runs.push(...children);
      }
    } else if (tag === 'img') {
      runs.push(await imageRunFromNode({ url: $(node).attr('src'), alt: $(node).attr('alt') || 'HTML 图片' }, context));
    } else if (tag === 'input' && String($(node).attr('type') || '').toLowerCase() === 'checkbox') {
      runs.push(textRun($(node).attr('checked') == null ? '☐ ' : '☑ ', { ...marks, font: 'Segoe UI Symbol' }));
    } else {
      if (!['p', 'span', 'label', 'small', 'sub', 'sup', 'mark'].includes(tag)) {
        addUnsupportedHtmlWarning(context, tag);
      }
      runs.push(...await htmlInlineRuns($, $(node).contents().toArray(), context, marks));
    }
  }

  return runs;
}

async function htmlTableToDocx($, tableNode, context) {
  const rows = [];
  const rowDescriptors = $(tableNode).find('tr').toArray().map((rowNode) => {
    const cells = $(rowNode).children('th,td').toArray().map((cellNode) => ({
      node: cellNode,
      columnSpan: normalizeColumnSpan($(cellNode).attr('colspan')),
    }));
    return {
      cells,
      columnCount: cells.reduce((sum, cell) => sum + cell.columnSpan, 0),
    };
  }).filter((row) => row.cells.length);
  const maxColumns = Math.max(1, ...rowDescriptors.map((row) => row.columnCount));

  for (const [rowIndex, row] of rowDescriptors.entries()) {
    const cells = [];
    for (const [cellIndex, cell] of row.cells.entries()) {
      const cellNode = cell.node;
      const isHeader = rowIndex === 0 || htmlTagName(cellNode) === 'th';
      const isFirstColumn = !isHeader && cellIndex === 0;
      const cellStyle = getTableCellStyle(context, { isHeader, isFirstColumn });
      const remainingSpan = cellIndex === row.cells.length - 1 ? maxColumns - row.columnCount : 0;
      cells.push(createTableCell({
        children: [paragraph(
          await htmlInlineRuns($, $(cellNode).contents().toArray(), context, tableCellRunMarks(cellStyle)),
          tableCellParagraphOptions(cellStyle),
        )],
        context,
        isHeader,
        isFirstColumn,
        columnSpan: cell.columnSpan + Math.max(0, remainingSpan),
        totalColumns: maxColumns,
      }));
    }
    rows.push(new TableRow({ children: cells }));
  }

  if (!rows.length) {
    return [];
  }

  return [createDocxTable(rows, maxColumns, context)];
}

function buildListParagraphOptions(context, reference, level, itemIndex, totalItems, options = {}) {
  const paragraphOptions = reference ? { numbering: { reference, level } } : {};
  if (!reference && options.manualListIndent) {
    const indent = getManualUnorderedListLevelIndent(context, level);
    if (indent) paragraphOptions.indent = indent;
  } else if (!reference && options.manualIndent) {
    const indent = getTaskListLevelIndent(context, level);
    if (indent) paragraphOptions.indent = indent;
  }
  if (context.bodyLineSpacing) paragraphOptions.line = context.bodyLineSpacing;
  if (context.bodyAlignment) paragraphOptions.alignment = context.bodyAlignment;
  if (itemIndex === 0 && context.bodyBeforeSpacing) paragraphOptions.before = context.bodyBeforeSpacing;
  paragraphOptions.after = itemIndex === totalItems - 1 ? (context.bodyAfterSpacing ?? 0) : 0;
  return paragraphOptions;
}

function isWhitespaceHtmlTextNode(node) {
  return node?.type === 'text' && !String(node.data || '').trim();
}

function isCheckboxInputNode($, node) {
  return htmlTagName(node) === 'input' && String($(node).attr('type') || '').toLowerCase() === 'checkbox';
}

function hasClassName($, node, className) {
  return String($(node).attr('class') || '').split(/\s+/).includes(className);
}

function isTaskListItem($, itemNode, inlineNodes = []) {
  if (hasClassName($, itemNode, 'task-list-item')) return true;
  return inlineNodes.some((node) => {
    if (isCheckboxInputNode($, node)) return true;
    return htmlTagName(node) === 'p' && $(node).children('input[type="checkbox"]').length > 0;
  });
}

async function htmlListToDocx($, listNode, context, options = {}) {
  const blocks = [];
  const ordered = htmlTagName(listNode) === 'ol';
  const unorderedListWithoutMarker = !ordered && context.bodyListStyle === 'none';
  let numberingReference = null;
  const listItems = $(listNode).children('li').toArray();

  for (const [itemIndex, itemNode] of listItems.entries()) {
    const inlineNodes = $(itemNode).contents().toArray()
      .filter((child) => !['ul', 'ol'].includes(htmlTagName(child)))
      .filter((child) => !isWhitespaceHtmlTextNode(child));
    const isTaskItem = isTaskListItem($, itemNode, inlineNodes);
    if (!isTaskItem && numberingReference == null && !unorderedListWithoutMarker) {
      numberingReference = ordered ? createOrderedListReference(context) : createUnorderedListReference(context);
    }
    const listOptions = buildListParagraphOptions(
      context,
      isTaskItem ? null : numberingReference,
      Math.min(options.listLevel || 0, 2),
      itemIndex,
      listItems.length,
      { manualIndent: isTaskItem, manualListIndent: !isTaskItem && unorderedListWithoutMarker },
    );
    blocks.push(paragraph(await htmlInlineRuns($, inlineNodes, context), listOptions));

    for (const childList of $(itemNode).children('ul,ol').toArray()) {
      blocks.push(...await htmlListToDocx($, childList, context, { ...options, listLevel: (options.listLevel || 0) + 1 }));
    }
  }

  return blocks;
}

/** 从 context 提取正文段落选项，供 HTML 正文段落使用 */
function buildHtmlBodyParaOpts(context) {
  const opts = {};
  if (context.bodyAfterSpacing != null) opts.after = context.bodyAfterSpacing;
  if (context.bodyLineSpacing) opts.line = context.bodyLineSpacing;
  if (context.bodyAlignment) opts.alignment = context.bodyAlignment;
  if (context.bodyIndent) opts.indent = context.bodyIndent;
  if (context.bodyBeforeSpacing) opts.before = context.bodyBeforeSpacing;
  return opts;
}

async function mermaidCodeToDocxBlocks(code, context) {
  const value = String(code || '').trim();
  if (!value) return [];

  const nextIndex = (context.convertedMermaidCount || 0) + 1;
  const total = context.stats?.mermaidCount || nextIndex;
  let cacheEntry = null;

  try {
    // 导出阶段不拦截语法：正文已有代码块则直接尝试本地渲染。
    cacheEntry = getMermaidCacheEntry(app, value);
    writeExportLog(context, 'export.mermaid.started', {
      mermaid_index: nextIndex,
      total,
      cache_hash: cacheEntry.hash,
      cache_hit: cacheEntry.exists,
      code_metrics: textMetrics(value),
    });
    reportConversionProgress(context, cacheEntry.exists
      ? `Mermaid 图 ${nextIndex}/${total} 已命中本地缓存。`
      : `正在本地转换 Mermaid 图 ${nextIndex}/${total}。`);
    const loadRetry = {
      retryAttempts: REMOTE_IMAGE_RETRY_ATTEMPTS,
      retryDelayMs: REMOTE_IMAGE_RETRY_DELAY_MS,
      onRetry: (attempt) => {
        reportConversionProgress(context, `Mermaid 图 ${nextIndex}/${total} 转换失败，3 秒后第 ${attempt} 次重试。`);
      },
    };
    const mermaidImage = await resolveMermaidImageForExport(value, context, { cacheEntry, loadRetry });
    const block = mermaidImage.loaded === undefined
      ? await imageParagraphFromSource(mermaidImage.source, 'Mermaid 图', context)
      : await imageParagraphFromLoadedImage(mermaidImage.source, 'Mermaid 图', mermaidImage.loaded, context);
    writeExportLog(context, 'export.mermaid.completed', {
      mermaid_index: nextIndex,
      total,
      cache_hash: mermaidImage.cacheHash,
      cache_hit: mermaidImage.cacheHit,
    });
    reportConversionProgress(context, mermaidImage.cacheHit
      ? `Mermaid 图 ${nextIndex}/${total} 已使用本地缓存。`
      : `Mermaid 图 ${nextIndex}/${total} 已转换并缓存。`);
    return [block];
  } catch (error) {
    const message = `Mermaid 图无法导出：${compactText(error.message || '转换失败', 120)}`;
    addWarning(context, message);
    writeExportLog(context, 'export.mermaid.error', {
      mermaid_index: nextIndex,
      total,
      cache_hash: cacheEntry?.hash || '',
      error: compactLogError(error),
    });
    reportConversionProgress(context, `Mermaid 图 ${nextIndex}/${total} 转换失败。`);
    return [paragraph([textRun(`[${message}]`, { color: 'C83220' })], { alignment: AlignmentType.CENTER })];
  } finally {
    context.convertedMermaidCount = nextIndex;
  }
}

function isMermaidCodeElement($, codeNode) {
  const className = String($(codeNode).attr('class') || '').toLowerCase();
  return /\blanguage-mermaid\b/.test(className) || /\bmermaid\b/.test(className);
}

async function htmlHeadingToDocxBlocks($, node, context) {
  const mdLevel = Math.min(Math.max(parseInt(htmlTagName(node).slice(1), 10) || 1, 1), 6);
  const style = getHeadingStyle(context.exportFormat, mdLevel);
  const headingOpts = {
    heading: headingLevel(mdLevel),
    before: style ? style.spacing_before_pt * 20 : (mdLevel === 1 ? 280 : 180),
    after: style ? style.spacing_after_pt * 20 : 120,
    indent: { left: 0, right: 0, firstLine: 0, hanging: 0 },
  };
  if (style) {
    headingOpts.alignment = alignmentToWordType(style.alignment);
    if (style.line_spacing) {
      headingOpts.line = 240 * style.line_spacing;
    }
  }
  const runMarks = {};
  if (style) {
    runMarks.font = style.font || '黑体';
    runMarks.size = chineseSizeToHalfPt(style.size || '小四');
    runMarks.bold = false;
  } else {
    runMarks.bold = true;
  }
  return [paragraph(await htmlInlineRuns($, $(node).contents().toArray(), context, runMarks), headingOpts)];
}

async function htmlNodeToDocxBlocks($, node, context, options = {}) {
  if (node.type === 'text') {
    const text = String(node.data || '').trim();
    if (!text) return [];
    const runOpts = {};
    if (context.bodyRunFont) runOpts.font = context.bodyRunFont;
    if (context.bodyRunSize) runOpts.size = context.bodyRunSize;
    const paraOpts = buildHtmlBodyParaOpts(context);
    return [paragraph([textRun(text, runOpts)], paraOpts)];
  }

  if (node.type !== 'tag') {
    return [];
  }

  const tag = htmlTagName(node);
  if (/^h[1-6]$/.test(tag)) {
    return htmlHeadingToDocxBlocks($, node, context);
  }
  if (tag === 'table') {
    return htmlTableToDocx($, node, context);
  }
  if (tag === 'img') {
    return [await imageParagraphFromSource($(node).attr('src'), $(node).attr('alt') || 'HTML 图片', context)];
  }
  if (tag === 'ul' || tag === 'ol') {
    return htmlListToDocx($, node, context, options);
  }
  if (tag === 'blockquote') {
    const text = String($(node).text() || '').trim();
    if (context.feasibility && text.includes('📸') && text.includes('【插图指引】')) {
      return buildDocxImageGuidanceBox($, node);
    }
    return [paragraph(await htmlInlineRuns($, $(node).contents().toArray(), context, { color: '536176' }), {
      indent: { left: 360 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: '2174FD' } },
      shading: { type: ShadingType.CLEAR, fill: 'F6F9FF' },
    })];
  }
  if (tag === 'pre') {
    const codeNode = $(node).children('code').first();
    if (codeNode.length && isMermaidCodeElement($, codeNode[0])) {
      return mermaidCodeToDocxBlocks(codeNode.text(), context);
    }
    return [paragraph([new TextRun({ text: cleanText($(node).text()), font: 'Consolas', size: 21, color: '243048' })], {
      shading: { type: ShadingType.CLEAR, fill: 'F6F9FF' },
      indent: { left: 260, right: 260 },
    })];
  }
  if (tag === 'br') {
    return [paragraph([lineBreakRun()])];
  }
  if (tag === 'hr') {
    return [paragraph([textRun('────────────────────────', { color: 'DCDFF6' })], { alignment: AlignmentType.CENTER })];
  }
  if (['div', 'section', 'article'].includes(tag) && hasBlockHtmlChildren($, node)) {
    return htmlNodesToDocxBlocks($, $(node).contents().toArray(), context, options);
  }
  if (tag === 'p' && hasBlockHtmlChildren($, node)) {
    return htmlNodesToDocxBlocks($, $(node).contents().toArray(), context, options);
  }
  if (['p', 'div', 'section', 'article', 'span', 'strong', 'b', 'em', 'i', 'del', 's', 'strike', 'a', 'code', 'label', 'small', 'sub', 'sup', 'mark'].includes(tag)) {
    const isFigureCaption = /^图[:：]/.test($(node).text().trim());
    if (isFigureCaption) {
      return [paragraph([textRun($(node).text().trim(), getCaptionRunMarks(context))], getCaptionParagraphOptions(context))];
    }
    const htmlParaOpts = buildHtmlBodyParaOpts(context);
    const groups = splitHtmlInlineNodesByBreaks($, $(node).contents().toArray());
    const paragraphs = [];
    for (const [index, group] of groups.entries()) {
      const paraOpts = { ...htmlParaOpts };
      if (groups.length > 1 && index < groups.length - 1) {
        paraOpts.after = 0;
      }
      if (index > 0) {
        delete paraOpts.before;
      }
      paragraphs.push(paragraph(await htmlInlineRuns($, group, context), paraOpts));
    }
    return paragraphs;
  }

  addUnsupportedHtmlWarning(context, tag);
  return htmlNodesToDocxBlocks($, $(node).contents().toArray(), context, options);
}

async function htmlNodesToDocxBlocks($, nodes = [], context = {}, options = {}) {
  const blocks = [];
  for (const node of nodes) {
    blocks.push(...await htmlNodeToDocxBlocks($, node, context, options));
  }
  return blocks;
}

async function htmlToDocxBlocks(html, context = {}, options = {}) {
  const source = String(html || '').trim();
  if (!source) {
    return [];
  }

  const $ = cheerio.load(source, null, false);
  const blocks = await htmlNodesToDocxBlocks($, $.root().contents().toArray(), context, options);
  if (!blocks.length) {
    addWarning(context, '部分 HTML 内容未能导出，请核对 Word 内容。');
  }
  return blocks;
}

async function markdownToDocxBlocks(content, context = {}) {
  const markdown = normalizeMarkdownTablesForDocx(normalizeMarkdownListMarkersForDocx(content));
  const html = await renderMarkdownHtml(markdown, { allowRawHtml: true, enableGfm: true });
  return htmlToDocxBlocks(html, context);
}

async function addMarkdownContent(children, content, context) {
  children.push(...await markdownToDocxBlocks(content, context));
}

module.exports = {
  imageRunFromNode,
  imageParagraphFromSource,
  imageParagraphFromLoadedImage,
  isHtmlBrNode,
  htmlInlineGroupHasContent,
  splitHtmlInlineNodesByBreaks,
  htmlTagName,
  hasBlockHtmlChildren,
  htmlInlineRuns,
  htmlTableToDocx,
  buildListParagraphOptions,
  isWhitespaceHtmlTextNode,
  isCheckboxInputNode,
  hasClassName,
  isTaskListItem,
  htmlListToDocx,
  buildHtmlBodyParaOpts,
  mermaidCodeToDocxBlocks,
  isMermaidCodeElement,
  htmlHeadingToDocxBlocks,
  htmlNodeToDocxBlocks,
  htmlNodesToDocxBlocks,
  htmlToDocxBlocks,
  markdownToDocxBlocks,
  addMarkdownContent,
};
