// 系统预设导出模板的真源（数据集团工具箱企业版）。
//
// 这里的定义每次启动都会幂等同步进 export_templates 表（见 templateStore.syncSystemTemplates），
// 所以改预设样式只要改这个文件，不需要写数据库迁移。
//
// template_id 一经发布不可再改：technical_plan_generation_config.export_template_id 会引用它，
// 改 id 等于让老用户已选的模板失效。数组顺序即"我的模板"里系统分组的展示顺序。

const crypto = require('node:crypto');

/** 六级标题的通用构造，省得每套重复写十二个字段。 */
function heading(font, size, alignment, bold, textColor, spacingBefore, spacingAfter, numberingTemplate, lineSpacing = 1) {
  return {
    font,
    size,
    alignment,
    bold,
    text_color: textColor,
    spacing_before_pt: spacingBefore,
    spacing_after_pt: spacingAfter,
    first_line_indent_chars: 0,
    line_spacing: lineSpacing,
    numbering_format: 'custom',
    numbering_template: numberingTemplate,
  };
}

/** 投标文件的常规编号：一级"第X章"、二级"第X节"，往下只留末段序号。 */
const BID_NUMBERING = ['第{zh}章', '第{zh}节', '{tail}', '{tail}', '{tail}', '{tail}'];

/** 系统预设模板：data-集团标准（黑白简版），评审最不容易挑刺的一套。 */
const SYSTEM_EXPORT_TEMPLATES = [
  {
    template_id: 'tpl-system-standard-bid',
    config: buildConfig({
      template_name: '数据集团标准投标简版',
      page: {
        paper_size: 'a4',
        orientation: 'portrait',
        first_page_different: false,
        margin_top_cm: 2,
        margin_bottom_cm: 2,
        margin_left_cm: 2,
        margin_right_cm: 2,
        header_enabled: false,
        footer_enabled: false,
        page_number_enabled: true,
        page_number_format: '第{page}页',
      },
      heading_level1_page_break_before: false,
      heading_border: {
        enabled: false,
        border_color: '#000000',
        level_cell_colors: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
      },
      headings: [
        heading('黑体', '小二', '居中对齐', false, '#000000', 12, 12, BID_NUMBERING[0]),
        heading('黑体', '四号', '两端对齐', false, '#000000', 10, 10, BID_NUMBERING[1]),
        heading('黑体', '小四', '两端对齐', false, '#000000', 8, 8, BID_NUMBERING[2]),
        heading('楷体', '小四', '两端对齐', false, '#000000', 6, 6, BID_NUMBERING[3]),
        heading('黑体', '小四', '两端对齐', false, '#000000', 6, 6, BID_NUMBERING[4]),
        heading('宋体', '小四', '两端对齐', false, '#000000', 0, 0, BID_NUMBERING[5]),
      ],
      body_text: {
        font: '宋体',
        size: '小四',
        alignment: '两端对齐',
        first_line_indent_chars: 2,
        line_spacing_multiple: 1.5,
        list_style: 'disc',
        ordered_list_style: 'decimal-dot',
        list_indent_chars: 2,
      },
      table: {
        border_width: 1,
        border_color: '#000000',
        cell_padding_pt: 6,
        full_width: true,
        caption_font: '宋体',
        caption_size: '小四',
        caption_bold: true,
        header_row: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#000000', background_color: '#ffffff' },
        first_column: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#000000', background_color: '#ffffff' },
        body_cell: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#000000', background_color: '#ffffff' },
      },
      image: {
        max_width_percent: 90,
        caption_font: '宋体',
        caption_size: '小五',
      },
    }),
  },
  {
    template_id: 'tpl-system-formal-binding',
    config: buildConfig({
      template_name: '数据集团正式装订版',
      page: {
        paper_size: 'a4',
        orientation: 'portrait',
        first_page_different: false,
        margin_top_cm: 2.5,
        margin_bottom_cm: 2.5,
        margin_left_cm: 2.8,
        margin_right_cm: 2.5,
        header_enabled: true,
        header_text: '数据集团投标文件',
        header_font: '宋体',
        header_size: '小五',
        header_alignment: '居中对齐',
        header_color: '#243048',
        footer_enabled: true,
        footer_text: '',
        footer_distance_cm: 1.75,
        footer_font: '宋体',
        footer_size: '小五',
        footer_alignment: '居中对齐',
        footer_color: '#243048',
        page_number_enabled: true,
        page_number_format: '第{page}页',
      },
      heading_level1_page_break_before: true,
      heading_border: {
        enabled: true,
        border_color: '#243048',
        level_cell_colors: ['#f2f5fb', '#f2f5fb', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
      },
      headings: [
        heading('黑体', '小二', '居中对齐', true, '#243048', 18, 18, BID_NUMBERING[0]),
        heading('黑体', '三号', '两端对齐', true, '#243048', 14, 14, BID_NUMBERING[1]),
        heading('黑体', '小四', '两端对齐', true, '#243048', 10, 10, BID_NUMBERING[2]),
        heading('楷体', '小四', '两端对齐', false, '#243048', 8, 8, BID_NUMBERING[3]),
        heading('黑体', '小四', '两端对齐', false, '#243048', 8, 8, BID_NUMBERING[4]),
        heading('宋体', '小四', '两端对齐', false, '#243048', 0, 0, BID_NUMBERING[5]),
      ],
      body_text: {
        font: '宋体',
        size: '小四',
        alignment: '两端对齐',
        first_line_indent_chars: 2,
        line_spacing_multiple: 1.5,
        list_style: 'disc',
        ordered_list_style: 'decimal-dot',
        list_indent_chars: 2,
      },
      table: {
        border_width: 1,
        border_color: '#243048',
        cell_padding_pt: 6,
        full_width: true,
        caption_font: '黑体',
        caption_size: '小四',
        caption_bold: true,
        header_row: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#ffffff', background_color: '#243048' },
        first_column: { font: '黑体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#f2f5fb' },
        body_cell: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
      },
      image: {
        max_width_percent: 90,
        caption_font: '宋体',
        caption_size: '小五',
      },
    }),
  },
];

/** 以 sjjt 默认导出格式为基线逐段浅合并，只写与默认不同的字段。 */
function buildConfig(overrides) {
  // 与 configStore.cjs 的 defaultExportFormat 同构；此处内联以避免 store 间反向依赖。
  const base = {
    template_name: '默认模版',
    page: {
      paper_size: 'a4', orientation: 'portrait', first_page_different: false,
      margin_top_cm: 2, margin_bottom_cm: 2, margin_left_cm: 2, margin_right_cm: 2,
      header_enabled: false, header_text: '', header_font: '宋体', header_size: '小五',
      header_alignment: '居中对齐', header_color: '#536176',
      footer_enabled: false, footer_text: '', footer_distance_cm: 1.75, footer_font: '宋体',
      footer_size: '小五', footer_alignment: '居中对齐', footer_color: '#536176',
      page_number_enabled: false, page_number_format: '第{page}页', page_number_start: 1,
    },
    heading_level1_page_break_before: false,
    heading_border: {
      enabled: false, min_heading_left_enabled: false, border_color: '#cfd8ee',
      level_cell_colors: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
      structure: '上下结构',
    },
    body_text: {
      font: '宋体', size: '小四', alignment: '左对齐', spacing_before_pt: 0, spacing_after_pt: 0,
      first_line_indent_chars: 2, line_spacing_multiple: 1.2,
      list_style: 'disc', ordered_list_style: 'decimal-dot', list_indent_chars: 2,
    },
    table: {
      border_width: 1, border_color: '#dcdff6', cell_padding_pt: 6, full_width: true,
      caption_font: '宋体', caption_size: '小四', caption_bold: true,
      header_row: { font: '黑体', size: '小四', alignment: '居中对齐', text_color: '#243048', background_color: '#f2f5fb' },
      first_column: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
      body_cell: { font: '宋体', size: '小四', alignment: '左对齐', text_color: '#243048', background_color: '#ffffff' },
    },
    image: { max_width_percent: 90, caption_font: '宋体', caption_size: '小五' },
  };
  return {
    ...base,
    ...overrides,
    page: { ...base.page, ...(overrides.page || {}) },
    heading_border: { ...base.heading_border, ...(overrides.heading_border || {}) },
    headings: overrides.headings || base.headings,
    body_text: { ...base.body_text, ...(overrides.body_text || {}) },
    table: {
      ...base.table,
      ...(overrides.table || {}),
      header_row: { ...base.table.header_row, ...(overrides.table?.header_row || {}) },
      first_column: { ...base.table.first_column, ...(overrides.table?.first_column || {}) },
      body_cell: { ...base.table.body_cell, ...(overrides.table?.body_cell || {}) },
    },
    image: { ...base.image, ...(overrides.image || {}) },
  };
}

module.exports = { SYSTEM_EXPORT_TEMPLATES };
