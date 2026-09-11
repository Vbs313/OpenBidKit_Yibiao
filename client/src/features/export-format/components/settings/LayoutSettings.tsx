// LayoutSettings：导出格式页的「Layout」设置面板。
//
// 从 ExportFormatPage.tsx 的 render* 函数拆出来（JSX 正文逐字保留，只是把组件内的局部名字改成同名 props）。

import { AppSwitch } from '../../../../shared/ui';
import { FontPicker } from '../FontPicker';
import { ALIGNMENT_OPTIONS, PAPER_SIZES, SIZE_OPTIONS } from '../../../../shared/types/exportFormat';
import type { ExportFormatConfig, PageSetupConfig, PaperSize } from '../../../../shared/types/exportFormat';

export interface LayoutSettingsProps {
  config: ExportFormatConfig;
  fontOptions: string[];
  updateTemplate: (updates: Partial<ExportFormatConfig>) => void;
  updatePage: (updates: Partial<PageSetupConfig>) => void;
}

export function LayoutSettings({
  config,
  fontOptions,
  updateTemplate,
  updatePage,
}: LayoutSettingsProps) {
  return (
    <>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy"><strong>模板名称</strong></div>
          <input type="text" value={config.template_name} onChange={(event) => updateTemplate({ template_name: event.target.value })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>纸张</strong></div>
          <select value={config.page.paper_size} onChange={(event) => updatePage({ paper_size: event.target.value as PaperSize })}>
            {PAPER_SIZES.map((paper) => <option key={paper.value} value={paper.value}>{paper.label} - {paper.detail}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>方向</strong></div>
          <select value={config.page.orientation} onChange={(event) => updatePage({ orientation: event.target.value as 'portrait' | 'landscape' })}>
            <option value="portrait">纵向</option>
            <option value="landscape">横向</option>
          </select>
        </label>
        <div className="settings-row">
          <div className="settings-row-copy"><strong>页边距</strong><span>上 / 右 / 下 / 左（厘米）</span></div>
          <div className="export-format-margin-grid">
            <input type="number" min={0} max={10} step={0.1} value={config.page.margin_top_cm} onChange={(event) => updatePage({ margin_top_cm: Number(event.target.value) })} placeholder="上" />
            <input type="number" min={0} max={10} step={0.1} value={config.page.margin_right_cm} onChange={(event) => updatePage({ margin_right_cm: Number(event.target.value) })} placeholder="右" />
            <input type="number" min={0} max={10} step={0.1} value={config.page.margin_bottom_cm} onChange={(event) => updatePage({ margin_bottom_cm: Number(event.target.value) })} placeholder="下" />
            <input type="number" min={0} max={10} step={0.1} value={config.page.margin_left_cm} onChange={(event) => updatePage({ margin_left_cm: Number(event.target.value) })} placeholder="左" />
          </div>
        </div>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>页眉</strong></div>
          <AppSwitch checked={config.page.header_enabled} onCheckedChange={(checked) => updatePage({ header_enabled: checked })} />
        </label>
        {config.page.header_enabled && (
          <>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页眉文本</strong></div>
              <input type="text" value={config.page.header_text} onChange={(event) => updatePage({ header_text: event.target.value })} />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页眉字体</strong></div>
              <FontPicker value={config.page.header_font} options={fontOptions} onChange={(font) => updatePage({ header_font: font })} />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页眉字号</strong></div>
              <select value={config.page.header_size} onChange={(event) => updatePage({ header_size: event.target.value })}>
                {SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页眉对齐方式</strong></div>
              <select value={config.page.header_alignment} onChange={(event) => updatePage({ header_alignment: event.target.value })}>
                {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页眉颜色</strong></div>
              <input type="color" value={config.page.header_color} onChange={(event) => updatePage({ header_color: event.target.value })} />
            </label>
          </>
        )}
        <label className="settings-row">
          <div className="settings-row-copy"><strong>页脚</strong></div>
          <AppSwitch checked={config.page.footer_enabled} onCheckedChange={(checked) => updatePage({ footer_enabled: checked })} />
        </label>
        {config.page.footer_enabled && (
          <>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页脚文本</strong></div>
              <input type="text" value={config.page.footer_text} onChange={(event) => updatePage({ footer_text: event.target.value })} />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页脚字体</strong></div>
              <FontPicker value={config.page.footer_font} options={fontOptions} onChange={(font) => updatePage({ footer_font: font })} />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页脚字号</strong></div>
              <select value={config.page.footer_size} onChange={(event) => updatePage({ footer_size: event.target.value })}>
                {SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页脚对齐方式</strong></div>
              <select value={config.page.footer_alignment} onChange={(event) => updatePage({ footer_alignment: event.target.value })}>
                {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
              </select>
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页脚颜色</strong></div>
              <input type="color" value={config.page.footer_color} onChange={(event) => updatePage({ footer_color: event.target.value })} />
            </label>
          </>
        )}
        {(config.page.footer_enabled || config.page.page_number_enabled) && (
          <label className="settings-row">
            <div className="settings-row-copy"><strong>距底边距离</strong><span>页脚或页码距页面底边，单位：厘米</span></div>
            <input type="number" min={0} max={5} step={0.1} value={config.page.footer_distance_cm} onChange={(event) => updatePage({ footer_distance_cm: Number(event.target.value) })} />
          </label>
        )}
        <label className="settings-row">
          <div className="settings-row-copy"><strong>页码</strong><span>是否启用页码显示</span></div>
          <AppSwitch checked={config.page.page_number_enabled} onCheckedChange={(checked) => updatePage({ page_number_enabled: checked })} />
        </label>
        {config.page.page_number_enabled && (
          <>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页码格式</strong><span>使用 {'{page}'} 表示当前页码</span></div>
              <input type="text" value={config.page.page_number_format} onChange={(event) => updatePage({ page_number_format: event.target.value })} />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页码起始值</strong></div>
              <input type="number" min={1} max={9999} step={1} value={config.page.page_number_start} onChange={(event) => updatePage({ page_number_start: Number(event.target.value) })} />
            </label>
          </>
        )}
      </div>
    </>
  );
}
