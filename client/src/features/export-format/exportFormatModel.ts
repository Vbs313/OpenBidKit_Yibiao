// 导出格式（ExportFormatConfig）的纯模型：字体清单合并、默认模板构造、缺省值补齐、正文进度度量。
//
// 原本是 ExportFormatPage.tsx 顶部的 8 个模块级函数（约 130 行），只依赖类型与 DEFAULT_EXPORT_FORMAT，
// 抽出来后可单测；页面只负责把表单状态接起来。

import type { ExportFormatConfig, HeadingStyleConfig } from '../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../shared/types/exportFormat';
import type { OutlineItem } from '../../shared/types';
import { formatOutlineNumber } from '../../shared/utils/outlineNumbering';
import { collectLeafItems } from '../../shared/utils/outlineMetrics';

export function mergeFontOptions(...groups: Array<readonly string[]>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  groups.forEach((group) => {
    group.forEach((font) => {
      const name = String(font || '').trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      merged.push(name);
    });
  });

  return merged;
}

export function collectConfigFonts(config: ExportFormatConfig): string[] {
  return [
    config.page.header_font,
    config.page.footer_font,
    ...config.headings.map((heading) => heading.font),
    config.body_text.font,
    config.table.header_row.font,
    config.table.first_column.font,
    config.table.body_cell.font,
    config.image.caption_font,
  ].filter(Boolean);
}

export function headingNumberExample(index: number, heading: HeadingStyleConfig): string {
  const sampleIds = ['1', '1.1', '1.1.1', '1.1.1.1', '1.1.1.1.1', '1.1.1.1.1.1'];
  return formatOutlineNumber(sampleIds[index] || '1', heading);
}

export function createDefaultTemplateName(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');

  return `yibiao-${year}-${month}-${day}-${hour}${minute}${second}`;
}

export function createDefaultExportFormat(): ExportFormatConfig {
  return {
    template_name: DEFAULT_EXPORT_FORMAT.template_name,
    page: { ...DEFAULT_EXPORT_FORMAT.page },
    heading_level1_page_break_before: DEFAULT_EXPORT_FORMAT.heading_level1_page_break_before,
    heading_border: { ...DEFAULT_EXPORT_FORMAT.heading_border, level_cell_colors: [...DEFAULT_EXPORT_FORMAT.heading_border.level_cell_colors] },
    headings: DEFAULT_EXPORT_FORMAT.headings.map((heading) => ({ ...heading })),
    body_text: { ...DEFAULT_EXPORT_FORMAT.body_text },
    table: {
      border_width: DEFAULT_EXPORT_FORMAT.table.border_width,
      border_color: DEFAULT_EXPORT_FORMAT.table.border_color,
      cell_padding_pt: DEFAULT_EXPORT_FORMAT.table.cell_padding_pt,
      full_width: DEFAULT_EXPORT_FORMAT.table.full_width,
      header_row: { ...DEFAULT_EXPORT_FORMAT.table.header_row },
      first_column: { ...DEFAULT_EXPORT_FORMAT.table.first_column },
      body_cell: { ...DEFAULT_EXPORT_FORMAT.table.body_cell },
    },
    image: { ...DEFAULT_EXPORT_FORMAT.image },
  };
}

export function createNewTemplateExportFormat(): ExportFormatConfig {
  return {
    ...createDefaultExportFormat(),
    template_name: createDefaultTemplateName(),
  };
}

export function withExportFormatDefaults(source: ExportFormatConfig): ExportFormatConfig {
  const defaults = createDefaultExportFormat();
  return {
    ...defaults,
    ...source,
    page: { ...defaults.page, ...source.page },
    heading_border: {
      ...defaults.heading_border,
      ...source.heading_border,
      level_cell_colors: defaults.heading_border.level_cell_colors.map((color, index) => source.heading_border?.level_cell_colors?.[index] || color),
    },
    headings: defaults.headings.map((heading, index) => ({ ...heading, ...(source.headings?.[index] || {}) })),
    body_text: { ...defaults.body_text, ...source.body_text },
    table: {
      ...defaults.table,
      ...source.table,
      header_row: { ...defaults.table.header_row, ...source.table?.header_row },
      first_column: { ...defaults.table.first_column, ...source.table?.first_column },
      body_cell: { ...defaults.table.body_cell, ...source.table?.body_cell },
    },
    image: { ...defaults.image, ...source.image },
  };
}

export function hasGeneratedContent(items: OutlineItem[]) {
  return collectLeafItems(items).some((item) => String(item.content || '').trim());
}
