const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function transpile(fileName) {
  const source = fs.readFileSync(path.join(__dirname, fileName), 'utf-8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function evaluate(code, localRequire) {
  const module = { exports: {} };
  Function('module', 'exports', 'require', code)(module, module.exports, localRequire);
  return module.exports;
}

const exportFormatTypes = evaluate(transpile('../../shared/types/exportFormat.ts'), require);
const outlineNumbering = evaluate(transpile('../../shared/utils/outlineNumbering.ts'), require);
const outlineMetrics = evaluate(transpile('../../shared/utils/outlineMetrics.ts'), require);
const model = evaluate(transpile('exportFormatModel.ts'), (id) => {
  if (id.includes('types/exportFormat')) return exportFormatTypes;
  if (id.includes('outlineNumbering')) return outlineNumbering;
  if (id.includes('outlineMetrics')) return outlineMetrics;
  return require(id);
});

const {
  collectConfigFonts,
  createDefaultExportFormat,
  createDefaultTemplateName,
  createNewTemplateExportFormat,
  hasGeneratedContent,
  headingNumberExample,
  mergeFontOptions,
  withExportFormatDefaults,
} = model;

const { DEFAULT_EXPORT_FORMAT } = exportFormatTypes;
const item = (id, overrides = {}) => ({ id, title: id, description: '', ...overrides });

test('mergeFontOptions 去空、去重、保序', () => {
  assert.deepEqual(mergeFontOptions([' A ', 'B'], ['A', '', '  ', ' C ']), ['A', 'B', 'C']);
  assert.deepEqual(mergeFontOptions([], []), []);
});

test('collectConfigFonts 收集 8 处字体并过滤空值', () => {
  const fonts = collectConfigFonts({
    ...DEFAULT_EXPORT_FORMAT,
    page: { ...DEFAULT_EXPORT_FORMAT.page, header_font: '页眉字体', footer_font: '' },
    headings: DEFAULT_EXPORT_FORMAT.headings.map((heading, index) => ({ ...heading, font: index === 0 ? '一级标题字体' : '' })),
    body_text: { ...DEFAULT_EXPORT_FORMAT.body_text, font: '正文字体' },
    table: {
      ...DEFAULT_EXPORT_FORMAT.table,
      header_row: { ...DEFAULT_EXPORT_FORMAT.table.header_row, font: '' },
      first_column: { ...DEFAULT_EXPORT_FORMAT.table.first_column, font: '' },
      body_cell: { ...DEFAULT_EXPORT_FORMAT.table.body_cell, font: '' },
    },
    image: { ...DEFAULT_EXPORT_FORMAT.image, caption_font: '' },
  });

  assert.equal(fonts[0], '页眉字体');
  assert.equal(fonts[1], '一级标题字体');
  assert.equal(fonts[2], '正文字体');
  assert.equal(fonts.includes(''), false);
});

test('createDefaultTemplateName 用注入的日期生成固定格式名字', () => {
  assert.equal(createDefaultTemplateName(new Date(2026, 8, 11, 9, 5, 7)), 'yibiao-2026-09-11-090507');
});

test('createDefaultExportFormat 是深拷贝，改副本不影响默认值', () => {
  const copy = createDefaultExportFormat();
  assert.deepEqual(copy, DEFAULT_EXPORT_FORMAT);
  copy.page.margin_top_pt += 1;
  copy.headings[0].font = '改过的字体';
  copy.heading_border.level_cell_colors[0] = '改过的颜色';
  copy.table.header_row.font = '改过的表格字体';

  assert.notEqual(DEFAULT_EXPORT_FORMAT.page.margin_top_pt, copy.page.margin_top_pt);
  assert.notEqual(DEFAULT_EXPORT_FORMAT.headings[0].font, '改过的字体');
  assert.notEqual(DEFAULT_EXPORT_FORMAT.heading_border.level_cell_colors[0], '改过的颜色');
  assert.notEqual(DEFAULT_EXPORT_FORMAT.table.header_row.font, '改过的表格字体');
});

test('createNewTemplateExportFormat 带上自动模板名', () => {
  const created = createNewTemplateExportFormat();
  assert.match(created.template_name, /^yibiao-\d{4}-\d{2}-\d{2}-\d{6}$/);
  assert.equal(created.page.margin_top_pt, DEFAULT_EXPORT_FORMAT.page.margin_top_pt);
});

test('withExportFormatDefaults 只补缺省项，不覆盖已有值与嵌套结构', () => {
  const merged = withExportFormatDefaults({
    ...DEFAULT_EXPORT_FORMAT,
    page: { ...DEFAULT_EXPORT_FORMAT.page, margin_top_pt: 99 },
    headings: [{ ...DEFAULT_EXPORT_FORMAT.headings[0], font: '自定义一级字体' }],
    table: {
      ...DEFAULT_EXPORT_FORMAT.table,
      header_row: { ...DEFAULT_EXPORT_FORMAT.table.header_row, font: '自定义表头字体' },
    },
  });

  assert.equal(merged.page.margin_top_pt, 99);
  assert.equal(merged.headings[0].font, '自定义一级字体');
  assert.equal(merged.headings[1].font, DEFAULT_EXPORT_FORMAT.headings[1].font, '未提供的高级标题回落到默认');
  assert.equal(merged.table.header_row.font, '自定义表头字体');
  assert.equal(merged.table.first_column.font, DEFAULT_EXPORT_FORMAT.table.first_column.font);
});

test('headingNumberExample 用编号样例渲染', () => {
  const heading = DEFAULT_EXPORT_FORMAT.headings[1];
  assert.equal(headingNumberExample(1, heading), outlineNumbering.formatOutlineNumber('1.1', heading));
});

test('hasGeneratedContent 只看叶子正文', () => {
  assert.equal(hasGeneratedContent([{ ...item('1'), children: [item('1.1', { content: ' 有内容 ' })] }]), true);
  assert.equal(hasGeneratedContent([item('1', { content: '   ' })]), false);
  assert.equal(hasGeneratedContent([]), false);
});
