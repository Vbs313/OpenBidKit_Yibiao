// CoverSettings：导出格式页的「Cover」设置面板。
//
// 从 ExportFormatPage.tsx 的 render* 函数拆出来（JSX 正文逐字保留，只是把组件内的局部名字改成同名 props）。

import { AppSwitch } from '../../../../shared/ui';
import type { ExportFormatConfig, PageSetupConfig } from '../../../../shared/types/exportFormat';

export interface CoverSettingsProps {
  config: ExportFormatConfig;
  updatePage: (updates: Partial<PageSetupConfig>) => void;
}

export function CoverSettings({
  config,
  updatePage,
}: CoverSettingsProps) {
  return (
    <>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy"><strong>首页不同</strong><span>勾选后首页使用独立页眉页脚，适合封皮不显示页码。</span></div>
          <AppSwitch checked={config.page.first_page_different} onCheckedChange={(checked) => updatePage({ first_page_different: checked })} />
        </label>
      </div>
    </>
  );
}
