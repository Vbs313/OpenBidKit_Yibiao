const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { app, dialog, nativeImage } = require('electron');
const cheerio = require('cheerio');
const { imageSize } = require('image-size');
const { compactLogError, createDeveloperLogger, textMetrics } = require('../utils/developerLog.cjs');
const perfTrace = require('../utils/perfTrace.cjs');
const { getMermaidCacheEntry, saveMermaidCacheImage } = require('../utils/mermaidCache.cjs');
const { getGeneratedImagesDir, getImportedImagesDir } = require('../utils/paths.cjs');
const { REMOTE_IMAGE_RETRY_ATTEMPTS, REMOTE_IMAGE_RETRY_DELAY_MS } = require('../utils/remoteImageRetry.cjs');
const { renderMarkdownHtml } = require('../utils/renderMarkdownHtml.cjs');
const { getLocalImageRenderService } = require('./localImageRenderService.cjs');
const {
  normalizeColumnSpan,
  isMarkdownTableRowLine,
  isMarkdownTableDelimiterLine,
  splitMarkdownTableCells,
  isMarkdownTableDelimiterCell,
  formatMarkdownTableRow,
  normalizeMarkdownListMarkersForDocx,
} = require('./export/markdownDocx.cjs');
const {
  expandCompressedMarkdownTableRows,
  formatOutlineNumber,
} = require('./export/tableAndNumbering.cjs');
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



function readFeasibilityExportContext(payload) {
  const options = payload?.feasibility_options;
  if (!options || typeof options !== 'object') return null;
  const projectInfo = options.project_info && typeof options.project_info === 'object' ? options.project_info : {};
  return {
    options,
    projectInfo,
    includeCover: options.includeCover !== false,
    includeNotes: options.includePreparationNotes !== false,
    includeAppendix: options.includeAppendixTables !== false,
  };
}

function formatFeasibilityYearMonth(date = new Date()) {
  return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, '0')}月`;
}

function displayFeasibilityAppendixValue(value) {
  const text = String(value || '').trim();
  return text || '—';
}

function buildFeasibilityTableCell(text, options = {}) {
  const colWidth = options.width || Math.floor(FEASIBILITY_TABLE_WIDTH / (options.columnCount || 4));
  return new TableCell({
    children: [paragraph(
      [textRun(text, {
        bold: options.header === true,
        size: options.header ? 20 : 19,
        color: options.header ? 'FFFFFF' : '333333',
      })],
      { alignment: AlignmentType.CENTER, after: 40 },
    )],
    shading: options.header ? { fill: FEASIBILITY_ACCENT, type: ShadingType.CLEAR } : undefined,
    width: { size: colWidth, type: WidthType.DXA },
  });
}

function buildFeasibilityTableRow(values, options = {}) {
  const columnCount = values.length;
  return new TableRow({
    cantSplit: true,
    tableHeader: options.header ? true : undefined,
    children: values.map((value) => buildFeasibilityTableCell(value, { ...options, columnCount })),
  });
}

function buildFeasibilityNativeTable(header, rows) {
  return new Table({
    width: { size: FEASIBILITY_TABLE_WIDTH, type: WidthType.DXA },
    rows: [buildFeasibilityTableRow(header, { header: true }), ...rows.map((row) => buildFeasibilityTableRow(row))],
  });
}


function buildFeasibilityCoverParagraphs(payload, feasibility) {
  const { options, projectInfo } = feasibility;
  const projectName = String(payload.project_name || projectInfo.projectName || '项目可行性研究报告').trim();
  const constructionUnit = String(projectInfo.constructionUnit || '').trim();
  const preparationUnit = String(options.preparationUnit || constructionUnit || '可行性研究报告编制中心').trim();
  const documentCode = String(options.documentCode || '').trim();
  return [
    paragraph(
      [textRun(String(options.securityLevel || '').trim() || '内部资料 / 普通', { bold: true, size: 20, color: '666666' })],
      { alignment: AlignmentType.RIGHT, after: 600 },
    ),
    paragraph(
      [textRun(projectName, { bold: true, size: 40, color: FEASIBILITY_ACCENT })],
      { alignment: AlignmentType.CENTER, after: 300 },
    ),
    paragraph(
      [textRun('可行性研究报告', { bold: true, size: 32, color: '333333' })],
      { alignment: AlignmentType.CENTER, after: 600 },
    ),
    paragraph(
      [textRun(`（所属行业：${String(projectInfo.industry || '').trim() || '国家标准大纲'}）`, { italics: true, size: 22, color: '666666' })],
      { alignment: AlignmentType.CENTER, after: 2000 },
    ),
    paragraph(
      [textRun(`项目建设单位：${constructionUnit}`, { size: 24, bold: true })],
      { alignment: AlignmentType.CENTER, after: 180 },
    ),
    paragraph(
      [textRun(`报告编制单位：${preparationUnit}`, { size: 24 })],
      { alignment: AlignmentType.CENTER, after: 180 },
    ),
    paragraph(
      [textRun(`文档识别编号：${documentCode}`, { size: 22, color: '666666' })],
      { alignment: AlignmentType.CENTER, after: 180 },
    ),
    paragraph(
      [textRun(`编制出版日期：${formatFeasibilityYearMonth()}`, { size: 22, color: '666666' })],
      { alignment: AlignmentType.CENTER, after: 400 },
    ),
    pageBreakParagraph(),
  ];
}

function buildFeasibilityNotesParagraphs(payload, feasibility) {
  const { projectInfo } = feasibility;
  const projectName = String(payload.project_name || projectInfo.projectName || '').trim();
  const signatureTable = buildFeasibilityNativeTable(
    ['编制角色', '人员姓名', '专业职称 / 职务', '签章 / 审核状态'],
    [
      ['项目总负责人', '', '', ''],
      ['技术审定人', '', '', ''],
      ['主要校核人', '', '', ''],
      ['报告主编人', '', '', ''],
    ],
  );

  return [
    paragraph([textRun('一、可行性研究报告编制说明', { bold: true, size: 28, color: FEASIBILITY_ACCENT })], { after: 200 }),
    paragraph(
      [textRun(`1. 本可行性研究报告系针对“${projectName}”项目进行全面技术、经济、社会与生态可行性论证而编制。`, { size: 22 })],
      { after: 150 },
    ),
    paragraph(
      [textRun('2. 编制依据包括国家发改委《投资项目可行性研究报告编写指南》、行业技术规范、项目单位提供的原始资料以及现场调研数据。', { size: 22 })],
      { after: 300 },
    ),
    paragraph([textRun('二、项目编制人员责任签发表', { bold: true, size: 28, color: FEASIBILITY_ACCENT })], { after: 200 }),
    signatureTable,
    paragraph([textRun('', { size: 20 })], { after: 400 }),
    pageBreakParagraph(),
  ];
}

function buildFeasibilityAppendixParagraphs(feasibility) {
  const { projectInfo } = feasibility;
  const constructionPeriod = String(projectInfo.constructionPeriodYears || '').trim();
  const operationPeriod = String(projectInfo.operationPeriodYears || '').trim();
  const table = buildFeasibilityNativeTable(
    ['指标名称', '数值 / 内容', '单位', '备注说明'],
    [
      ['项目名称', displayFeasibilityAppendixValue(projectInfo.projectName), '—', '立项全称'],
      ['建设单位', displayFeasibilityAppendixValue(projectInfo.constructionUnit), '—', '申报主体'],
      ['建设地点', displayFeasibilityAppendixValue(projectInfo.location), '—', '建设区域'],
      ['建设规模', displayFeasibilityAppendixValue(projectInfo.constructionContent), '—', '产能/建设面积'],
      ['建设工期', constructionPeriod ? `${constructionPeriod} 年` : '—', constructionPeriod ? '年' : '—', '施工与调试'],
      ['运营期限', operationPeriod ? `${operationPeriod} 年` : '—', operationPeriod ? '年' : '—', '运营评价期'],
      ['估算总投资', displayFeasibilityAppendixValue(projectInfo.totalInvestment), '万元', '含建设投资及流动资金'],
      ['资金来源', displayFeasibilityAppendixValue(projectInfo.fundingSource), '—', '资本金及融资结构'],
    ],
  );

  return [
    pageBreakParagraph(),
    paragraph([textRun('可研报告附表汇总', { bold: true, size: 30, color: FEASIBILITY_ACCENT })], { after: 300 }),
    paragraph([textRun('附表 1：项目基本情况汇总表', { bold: true, size: 24, color: '333333' })], { after: 150 }),
    table,
    paragraph([textRun('', { size: 18 })], { after: 300 }),
  ];
}

function buildOutlineHeadingParagraph(item, context, level, options = {}) {
  const style = getHeadingStyle(context.exportFormat, level);
  const nativeHeadingNumbering = usesNativeHeadingNumbering(style) && !options.manualNumbering && !options.omitNumbering;
  const displayTitle = options.omitNumbering
    ? String(item.title || '')
    : (nativeHeadingNumbering ? String(item.title || '') : formatOutlineTitle(item.id, item.title, style));

  const runOptions = { bold: false };
  if (style) {
    runOptions.font = style.font || '黑体';
    runOptions.size = chineseSizeToHalfPt(style.size || '小四');
    runOptions.bold = style.bold === true;
    runOptions.color = normalizeDocxColor(style.text_color || '#243048', '243048');
  } else {
    runOptions.bold = true;
  }

  const paraOptions = {
    heading: headingLevel(level),
    pageBreakBefore: level === 1 && isLevel1PageBreakEnabled(context.exportFormat) && !options.disablePageBreakBefore,
    alignment: style ? alignmentToWordType(style.alignment) : undefined,
    before: options.compact ? 0 : (style ? style.spacing_before_pt * 20 : (level === 1 ? 320 : 200)),
    after: options.compact ? 0 : (style ? style.spacing_after_pt * 20 : 120),
    line: style ? 240 * (style.line_spacing || 1) : undefined,
  };
  paraOptions.indent = { left: 0, right: 0, firstLine: 0, hanging: 0 };
  if (nativeHeadingNumbering) {
    context.usesHeadingNumbering = true;
    paraOptions.numbering = { reference: HEADING_NUMBERING_REFERENCE, level: Math.min(level - 1, 5) };
  }

  return paragraph([textRun(displayTitle, runOptions)], paraOptions);
}

async function addChapterFrameRows(rows, items, context, level = 1) {
  for (const item of items || []) {
    const isLeaf = !item.children?.length;
    const useLeafColumns = isLeaf && context.exportFormat?.heading_border?.min_heading_left_enabled === true;
    if (useLeafColumns) {
      const bodyChildren = [];
      if (String(item.content || '').trim()) {
        await addMarkdownContent(bodyChildren, item.content, context);
      } else {
        const pendingParagraph = buildPendingContentModeParagraph(item);
        if (pendingParagraph) bodyChildren.push(pendingParagraph);
      }
      rows.push(buildChapterLeafRow(
        context.exportFormat,
        buildOutlineHeadingParagraph(item, context, level, { compact: true, manualNumbering: true, disablePageBreakBefore: true, omitNumbering: true }),
        bodyChildren,
        level,
      ));
      context.convertedLeafCount = (context.convertedLeafCount || 0) + 1;
      reportConversionProgress(context, `已处理 ${context.convertedLeafCount}/${context.stats?.leafCount || context.convertedLeafCount} 个正文小节。`);
      continue;
    }

    rows.push(buildChapterHeadingRow(
      context.exportFormat,
      buildOutlineHeadingParagraph(item, context, level, { compact: true, disableIndent: true, manualNumbering: true, disablePageBreakBefore: true }),
      level,
    ));

    if (isLeaf) {
      if (String(item.content || '').trim()) {
        const bodyChildren = [];
        await addMarkdownContent(bodyChildren, item.content, context);
        rows.push(buildChapterContentRow(context.exportFormat, bodyChildren));
      } else {
        const pendingParagraph = buildPendingContentModeParagraph(item);
        if (pendingParagraph) rows.push(buildChapterContentRow(context.exportFormat, [pendingParagraph]));
      }
      context.convertedLeafCount = (context.convertedLeafCount || 0) + 1;
      reportConversionProgress(context, `已处理 ${context.convertedLeafCount}/${context.stats?.leafCount || context.convertedLeafCount} 个正文小节。`);
      continue;
    }

    await addChapterFrameRows(rows, item.children, context, level + 1);
  }
}

async function addOutlineItems(children, items, context, level = 1) {
  for (const item of items || []) {
    const useChapterFrame = level === 1 && getChapterFrameConfig(context.exportFormat);
    if (useChapterFrame) {
      const rows = [];
      await addChapterFrameRows(rows, [item], context, level);
      if (isLevel1PageBreakEnabled(context.exportFormat)) {
        children.push(pageBreakParagraph());
      }
      children.push(buildChapterFrameTable(context.exportFormat, rows));
      continue;
    }

    children.push(buildOutlineHeadingParagraph(item, context, level));

    if (!item.children?.length) {
      if (String(item.content || '').trim()) {
        await addMarkdownContent(children, item.content, context);
      } else {
        const pendingParagraph = buildPendingContentModeParagraph(item);
        if (pendingParagraph) children.push(pendingParagraph);
      }
      context.convertedLeafCount = (context.convertedLeafCount || 0) + 1;
      reportConversionProgress(context, `已处理 ${context.convertedLeafCount}/${context.stats?.leafCount || context.convertedLeafCount} 个正文小节。`);
      continue;
    }

    await addOutlineItems(children, item.children, context, level + 1);
  }
}

function createHeadingNumberingConfig() {
  return {
    reference: HEADING_NUMBERING_REFERENCE,
    levels: [0, 1, 2, 3, 4, 5].map((level) => ({
      level,
      format: LevelFormat.DECIMAL,
      start: 1,
      text: Array.from({ length: level + 1 }, (_, index) => `%${index + 1}`).join('.'),
      alignment: AlignmentType.START,
      suffix: LevelSuffix.TAB,
      style: {
        paragraph: {
          indent: { left: 360 + level * 360, hanging: 360 },
        },
      },
    })),
  };
}

function getOrderedListWordStyle(style) {
  return ORDERED_LIST_WORD_STYLES[style] || ORDERED_LIST_WORD_STYLES['decimal-dot'];
}


function getListLevelIndent(referenceConfig, level) {
  const baseIndent = charsToTwips(referenceConfig.listIndentChars, referenceConfig.bodyRunSize);
  const left = Math.round(baseIndent * (level + 1));
  const hanging = Math.min(left, charsToTwips(1, referenceConfig.bodyRunSize));
  return { left, hanging };
}

function createListNumberingLevel(referenceConfig, level) {
  const ordered = referenceConfig.ordered === true;
  const orderedStyle = getOrderedListWordStyle(referenceConfig.orderedListStyle);
  const marker = UNORDERED_LIST_MARKERS[referenceConfig.unorderedListStyle] || UNORDERED_LIST_MARKERS.disc;
  const markerSize = Math.max(1, Math.round((referenceConfig.bodyRunSize || 24) * (marker.sizeScale || 1)));
  return {
    level,
    format: ordered ? orderedStyle.format : LevelFormat.BULLET,
    text: ordered ? orderedStyle.text(level) : marker.text,
    alignment: AlignmentType.START,
    suffix: LevelSuffix.TAB,
    style: {
      run: {
        font: ordered ? (referenceConfig.bodyRunFont || '宋体') : marker.font,
        size: ordered ? (referenceConfig.bodyRunSize || 24) : markerSize,
      },
      paragraph: {
        indent: getListLevelIndent(referenceConfig, level),
      },
    },
  };
}

function createNumberingConfig(context) {
  const references = context.numberingReferences || [];
  if (!references.length && !context.usesHeadingNumbering) {
    return undefined;
  }

  const config = [];
  if (context.usesHeadingNumbering) {
    config.push(createHeadingNumberingConfig());
  }
  config.push(...references.map((referenceConfig) => ({
    reference: referenceConfig.reference,
    levels: [0, 1, 2].map((level) => createListNumberingLevel(referenceConfig, level)),
  })));

  return {
    config,
  };
}

function buildHeadingParagraphStyles(exportFormat) {
  const styles = [];
  const names = ['Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6'];
  const ids = ['Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6'];

  for (let i = 0; i < 6; i += 1) {
    const style = getHeadingStyle(exportFormat, i + 1);
    if (!style) {
      styles.push({
        id: ids[i],
        name: names[i],
        basedOn: 'Normal',
        run: { bold: false },
        paragraph: { spacing: { before: 200, after: 120 } },
      });
      continue;
    }

    const halfPt = chineseSizeToHalfPt(style.size);
    const lineSpacing = 240 * (style.line_spacing || 1);
    styles.push({
      id: ids[i],
      name: names[i],
      basedOn: 'Normal',
      run: {
        font: style.font || 'SimHei',
        size: halfPt,
        bold: false,
      },
      paragraph: {
        spacing: {
          before: (style.spacing_before_pt || 10) * 20,
          after: (style.spacing_after_pt || 10) * 20,
          line: lineSpacing,
        },
        alignment: alignmentToWordType(style.alignment),
        indent: { left: 0, right: 0, firstLine: 0, hanging: 0 },
      },
    });
  }

  return styles;
}

async function buildDocxResult(payload, options = {}) {
  const exportFormat = (payload && payload.export_format) || null;
  const stats = countOutlineStats(payload.outline || []);
  const context = {
    baseDir: payload.base_dir || payload.baseDir,
    onProgress: options.onProgress,
    warnings: options.warnings || [],
    stats,
    convertedLeafCount: 0,
    convertedMermaidCount: 0,
    imageCount: 0,
    imageSuccessCount: 0,
    numberingReferences: [],
    numberingIndex: 0,
    usesHeadingNumbering: false,
    unsupportedHtmlTags: new Set(),
    developerLogger: options.developerLogger,
    exportFormat,
    feasibility: readFeasibilityExportContext(payload),
  };
  writeExportLog(context, 'export.docx.build.started', {
    stats,
    content_metrics: countOutlineContentMetrics(payload.outline || []),
  });

  // 正文默认样式
  const bodyStyle = (exportFormat && exportFormat.body_text) ? exportFormat.body_text : null;
  const bodyFont = bodyStyle ? (bodyStyle.font || '宋体') : '宋体';
  const bodySizeHalfPt = bodyStyle ? chineseSizeToHalfPt(bodyStyle.size || '小四') : 24;
  const bodyLineSpacing = bodyStyle ? 240 * (bodyStyle.line_spacing_multiple || 1.2) : 360;
  const bodyAfterSpacing = bodyStyle ? (bodyStyle.spacing_after_pt || 0) * 20 : 160;

  // 注入正文样式到 context，供正文段落/文本渲染时使用
  context.bodyRunFont = bodyFont;
  context.bodyRunSize = bodySizeHalfPt;
  context.bodyLineSpacing = bodyLineSpacing;
  context.bodyAfterSpacing = bodyAfterSpacing;
  context.bodyListStyle = bodyStyle ? (bodyStyle.list_style || 'disc') : 'disc';
  context.bodyOrderedListStyle = bodyStyle ? (bodyStyle.ordered_list_style || 'decimal-dot') : 'decimal-dot';
  context.bodyListIndentChars = bodyStyle ? (bodyStyle.list_indent_chars ?? 2) : 2;
  if (bodyStyle) {
    context.bodyAlignment = alignmentToWordType(bodyStyle.alignment);
    if (bodyStyle.first_line_indent_chars > 0) {
      context.bodyIndent = { firstLine: charsToTwips(bodyStyle.first_line_indent_chars, bodySizeHalfPt) };
    }
    if (bodyStyle.spacing_before_pt > 0) {
      context.bodyBeforeSpacing = bodyStyle.spacing_before_pt * 20;
    }
  }

  const children = [];
  const feasibility = context.feasibility;
  if (feasibility?.includeCover) {
    children.push(...buildFeasibilityCoverParagraphs(payload, feasibility));
  } else {
    children.push(
      paragraph([textRun('内容由 AI 生成', { italics: true, size: 18 })], { alignment: AlignmentType.CENTER, after: 120 }),
      paragraph([textRun(payload.project_name || (feasibility ? '可行性研究报告' : '投标技术文件'), { bold: true, size: 34 })], { alignment: AlignmentType.CENTER, after: 300 }),
    );
  }
  if (feasibility?.includeNotes) {
    children.push(...buildFeasibilityNotesParagraphs(payload, feasibility));
  }

  reportProgress(context, 10, stats.mermaidCount
    ? `准备导出正文，并转换 ${stats.mermaidCount} 张 Mermaid 图。`
    : '准备导出正文。');
  await addOutlineItems(children, payload.outline || [], context);
  if (feasibility?.includeAppendix) {
    children.push(...buildFeasibilityAppendixParagraphs(feasibility));
  }
  reportProgress(context, 90, '正在生成 Word 文件。');

  // 页面设置
  const pageSetup = (exportFormat && exportFormat.page) ? exportFormat.page : null;
  const pageMargin = pageSetup ? {
    top: cmToTwips(pageSetup.margin_top_cm ?? 2),
    bottom: cmToTwips(pageSetup.margin_bottom_cm ?? 2),
    left: cmToTwips(pageSetup.margin_left_cm ?? 2),
    right: cmToTwips(pageSetup.margin_right_cm ?? 2),
    footer: cmToTwips(pageSetup.footer_distance_cm ?? 1.75),
  } : { top: 1440, right: 1440, bottom: 1440, left: 1440, footer: cmToTwips(1.75) };
  const firstPageDifferent = pageSetup ? pageSetup.first_page_different === true : false;

  // 纸张尺寸与方向
  const pageSizeConfig = {};
  if (pageSetup && pageSetup.paper_size) {
    const dims = PAPER_DIMENSIONS_MM[pageSetup.paper_size];
    if (dims) {
      const isLandscape = pageSetup.orientation === 'landscape';
      pageSizeConfig.size = {
        width: mmToTwips(dims.width),
        height: mmToTwips(dims.height),
        orientation: isLandscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
      };
    }
  }

  // 页眉 / 页脚 / 页码
  const sectionChildren = [...children];
  const pageNumberEnabled = isPageNumberEnabled(pageSetup);
  const pageNumberStart = Math.max(1, Math.floor(Number(pageSetup ? pageSetup.page_number_start : 1) || 1));
  const headers = buildWordHeaders(pageSetup);
  const footers = buildWordFooters(pageSetup);

  const numbering = createNumberingConfig(context);
  const headingStyles = buildHeadingParagraphStyles(exportFormat);
  const sectionProperties = {
    page: {
      margin: pageMargin,
      ...pageSizeConfig,
      ...(pageNumberEnabled ? { pageNumbers: { start: pageNumberStart } } : {}),
    },
    ...(firstPageDifferent ? { titlePage: true } : {}),
  };
  const doc = new Document({
    ...(numbering ? { numbering } : {}),
    styles: {
      default: {
        document: {
          run: { font: bodyFont, size: bodySizeHalfPt },
          paragraph: { spacing: { line: bodyLineSpacing, after: bodyAfterSpacing } },
        },
      },
      paragraphStyles: headingStyles,
    },
    sections: [{
      properties: sectionProperties,
      headers,
      footers,
      children: sectionChildren,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  writeExportLog(context, 'export.docx.build.completed', {
    stats,
    warning_count: context.warnings.length,
    converted_leaf_count: context.convertedLeafCount,
    converted_mermaid_count: context.convertedMermaidCount,
    image_count: context.imageCount,
    image_success_count: context.imageSuccessCount,
    image_failure_count: Math.max(0, context.imageCount - context.imageSuccessCount),
    buffer_bytes: buffer.length,
  });
  return { buffer, warnings: context.warnings, stats };
}

async function buildDocxBuffer(payload, options = {}) {
  const result = await buildDocxResult(payload, options);
  return result.buffer;
}

const {
  mmToTwips,
  reportProgress,
  reportConversionProgress,
  writeExportLog,
  addWarning,
  addUnsupportedHtmlWarning,
  compactText,
  countOutlineStats,
  buildPendingContentModeParagraph,
  countOutlineContentMetrics,
  loadDeveloperConfig,
  sanitizeFilename,
  formatExportTimestamp,
  cleanText,
  normalizeDocxColor,
  textRun,
  lineBreakRun,
  paragraph,
  pageBreakParagraph,
  isLevel1PageBreakEnabled,
  isPageNumberEnabled,
  getChapterFrameConfig,
  buildChapterHeadingRow,
  buildChapterContentRow,
  buildChapterLeafRow,
  buildChapterFrameTable,
  buildWordHeaders,
  buildWordFooters,
  getTableCellStyle,
  tableCellRunMarks,
  tableCellParagraphOptions,
  createTableCell,
  createDocxTable,
  getImageMaxWidth,
  getImageMaxHeight,
  getImageParagraphOptions,
  getCaptionRunMarks,
  getCaptionParagraphOptions,
  normalizeMarkdownTablesForDocx,
  createOrderedListReference,
  createUnorderedListReference,
  headingLevel,
  chineseSizeToHalfPt,
  charsToTwips,
  cmToTwips,
  alignmentToWordType,
  formatOutlineTitle,
  getHeadingStyle,
  usesNativeHeadingNumbering,
  describeImageSourceForLog,
  normalizeImageForDocx,
  loadImageWithRetry,
  resolveMermaidImageForExport,
  getImagePixelDensity,
  textRunsWithBreaks,
  getManualUnorderedListLevelIndent,
  getTaskListLevelIndent,
  buildDocxImageGuidanceBox,
  FEASIBILITY_ACCENT,
  FEASIBILITY_TABLE_WIDTH,
} = require('./export/docxPrimitives.cjs');

const {
  addMarkdownContent,
} = require('./export/htmlDocx.cjs');

function createExportService({ configStore } = {}) {
  return {
    async exportWord(payload = {}, onProgress) {
      const stats = countOutlineStats(Array.isArray(payload.outline) ? payload.outline : []);
      const developerLogger = createDeveloperLogger({
        app,
        config: loadDeveloperConfig(configStore),
        moduleName: 'export',
        name: 'word-export',
        meta: {
          project_name: sanitizeFilename(payload.project_name || '投标技术文件'),
          stats,
        },
      });
      developerLogger.write('export.word.started', {
        project_name: sanitizeFilename(payload.project_name || '投标技术文件'),
        stats,
        content_metrics: countOutlineContentMetrics(Array.isArray(payload.outline) ? payload.outline : []),
      });
      if (!Array.isArray(payload.outline) || !payload.outline.length) {
        const error = new Error('没有可导出的目录内容');
        developerLogger.write('export.word.error', { error: compactLogError(error) });
        throw error;
      }

      const progressContext = { onProgress, warnings: [], stats };
      reportProgress(progressContext, 2, stats.mermaidCount
        ? `检测到 ${stats.mermaidCount} 张 Mermaid 图，导出时会转换为 Word 图片。`
        : '正在准备 Word 导出。');
      const defaultFilename = `${sanitizeFilename(payload.project_name || (payload.feasibility_options ? '可行性研究报告' : '标书文档'))}_${formatExportTimestamp()}.docx`;
      const defaultDir = app?.getPath ? app.getPath('downloads') : process.env.USERPROFILE || process.cwd();
      const result = await dialog.showSaveDialog({
        title: '导出 Word 文档',
        defaultPath: path.join(defaultDir, defaultFilename),
        filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      });

      if (result.canceled || !result.filePath) {
        reportProgress(progressContext, 0, '已取消导出。', { phase: 'canceled' });
        developerLogger.write('export.word.canceled', { stats });
        return { success: false, canceled: true, message: '已取消导出' };
      }

      try {
        const warnings = [];
        // 导出是用户最直接的“卡住”感受来源，记录构建与写盘两段耗时。
        const buildResult = await perfTrace.time('export', 'build_docx', () => buildDocxResult(payload, { onProgress, warnings, developerLogger }));
        reportProgress({ onProgress, warnings: buildResult.warnings, stats: buildResult.stats }, 96, '正在写入 Word 文件。');
        developerLogger.write('export.word.write.started', {
          output_file_name: path.basename(result.filePath),
          output_extension: path.extname(result.filePath).toLowerCase(),
          buffer_bytes: buildResult.buffer.length,
        });
        perfTrace.timeSync('export', 'write_file', () => fs.writeFileSync(result.filePath, buildResult.buffer));
        const message = buildResult.warnings.length
          ? `Word 已导出，但有 ${buildResult.warnings.length} 处图片未能插入，请打开文档核对。`
          : 'Word 已导出，请打开文档核对图片、表格和版式。';
        reportProgress({ onProgress, warnings: buildResult.warnings, stats: buildResult.stats }, 100, message, { phase: 'success' });
        developerLogger.write('export.word.completed', {
          output_file_name: path.basename(result.filePath),
          output_extension: path.extname(result.filePath).toLowerCase(),
          buffer_bytes: buildResult.buffer.length,
          warning_count: buildResult.warnings.length,
          stats: buildResult.stats,
        });
        return { success: true, path: result.filePath, message, warnings: buildResult.warnings };
      } catch (error) {
        developerLogger.write('export.word.error', {
          output_file_name: path.basename(result.filePath),
          output_extension: path.extname(result.filePath).toLowerCase(),
          error: compactLogError(error),
        });
        throw error;
      }
    },
  };
}

module.exports = {
  buildDocxBuffer,
  buildDocxResult,
  createExportService,
};
