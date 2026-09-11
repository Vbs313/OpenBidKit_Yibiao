// TableCellSettings：导出格式页的「TableCell」设置面板。
//
// 从 ExportFormatPage.tsx 的 render* 函数拆出来（JSX 正文逐字保留，只是把组件内的局部名字改成同名 props）。

import { FontPicker } from '../FontPicker';
import { ALIGNMENT_OPTIONS, SIZE_OPTIONS } from '../../../../shared/types/exportFormat';
import type { ExportFormatConfig, TableCellStyleConfig } from '../../../../shared/types/exportFormat';

// 与页面里的同名类型一致：表格三种单元格位置。
export type TableCellStyleKey = 'header_row' | 'first_column' | 'body_cell';

export interface TableCellSettingsProps {
  title: string;
  cellKey: TableCellStyleKey;
  config: ExportFormatConfig;
  fontOptions: string[];
  updateTableCell: (cellKey: TableCellStyleKey, updates: Partial<TableCellStyleConfig>) => void;
}

export function TableCellSettings({
  title,
  cellKey,
  config,
  fontOptions,
  updateTableCell,
}: TableCellSettingsProps) {
  const cell = config.table[cellKey];
  return (
      <div className="export-template-subsection">
        <strong>{title}</strong>
        <div className="export-format-heading-grid">
          <label>
            <span>字体</span>
            <FontPicker value={cell.font} options={fontOptions} onChange={(font) => updateTableCell(cellKey, { font })} />
          </label>
          <label>
            <span>字号</span>
            <select value={cell.size} onChange={(event) => updateTableCell(cellKey, { size: event.target.value })}>
              {SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <label>
            <span>对齐方式</span>
            <select value={cell.alignment} onChange={(event) => updateTableCell(cellKey, { alignment: event.target.value })}>
              {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
            </select>
          </label>
          <label>
            <span>文字颜色</span>
            <input type="color" value={cell.text_color} onChange={(event) => updateTableCell(cellKey, { text_color: event.target.value })} />
          </label>
          <label>
            <span>背景色</span>
            <input type="color" value={cell.background_color} onChange={(event) => updateTableCell(cellKey, { background_color: event.target.value })} />
          </label>
        </div>
      </div>
  );
}
