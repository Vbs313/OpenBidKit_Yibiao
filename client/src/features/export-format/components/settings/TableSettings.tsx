// TableSettings：导出格式页的「Table」设置面板。
//
// 从 ExportFormatPage.tsx 的 render* 函数拆出来（JSX 正文逐字保留，只是把组件内的局部名字改成同名 props）。

import { AppSwitch } from '../../../../shared/ui';
import { TableCellSettings } from './TableCellSettings';
import type { ExportFormatConfig, TableCellStyleConfig, TableStyleConfig } from '../../../../shared/types/exportFormat';
import type { TableCellStyleKey } from './TableCellSettings';

export interface TableSettingsProps {
  config: ExportFormatConfig;
  fontOptions: string[];
  updateTable: (updates: Partial<TableStyleConfig>) => void;
  updateTableCell: (cellKey: TableCellStyleKey, updates: Partial<TableCellStyleConfig>) => void;
}

export function TableSettings({
  config,
  fontOptions,
  updateTable,
  updateTableCell,
}: TableSettingsProps) {
  return (
    <>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy"><strong>线框宽度</strong></div>
          <input type="number" min={0} max={10} step={0.5} value={config.table.border_width} onChange={(event) => updateTable({ border_width: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>线框颜色</strong></div>
          <input type="color" value={config.table.border_color} onChange={(event) => updateTable({ border_color: event.target.value })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>单元格内边距</strong></div>
          <input type="number" min={0} max={50} step={1} value={config.table.cell_padding_pt} onChange={(event) => updateTable({ cell_padding_pt: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>表格铺满页面</strong></div>
          <AppSwitch checked={config.table.full_width} onCheckedChange={(checked) => updateTable({ full_width: checked })} />
        </label>
      </div>
      <TableCellSettings title="首行" cellKey="header_row" config={config} fontOptions={fontOptions} updateTableCell={updateTableCell} />
      <TableCellSettings title="首列" cellKey="first_column" config={config} fontOptions={fontOptions} updateTableCell={updateTableCell} />
      <TableCellSettings title="其余单元格" cellKey="body_cell" config={config} fontOptions={fontOptions} updateTableCell={updateTableCell} />
    </>
  );
}
