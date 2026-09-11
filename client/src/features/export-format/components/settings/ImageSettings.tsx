// ImageSettings：导出格式页的「Image」设置面板。
//
// 从 ExportFormatPage.tsx 的 render* 函数拆出来（JSX 正文逐字保留，只是把组件内的局部名字改成同名 props）。

import { AppSwitch } from '../../../../shared/ui';
import { FontPicker } from '../FontPicker';
import { ALIGNMENT_OPTIONS, SIZE_OPTIONS } from '../../../../shared/types/exportFormat';
import type { ExportFormatConfig, ImageStyleConfig } from '../../../../shared/types/exportFormat';

export interface ImageSettingsProps {
  config: ExportFormatConfig;
  fontOptions: string[];
  updateImage: (updates: Partial<ImageStyleConfig>) => void;
}

export function ImageSettings({
  config,
  fontOptions,
  updateImage,
}: ImageSettingsProps) {
  return (
    <>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy"><strong>图片最大宽度（%）</strong></div>
          <input type="number" min={10} max={100} step={1} value={config.image.max_width_percent} onChange={(event) => updateImage({ max_width_percent: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>图片对齐方式</strong></div>
          <select value={config.image.alignment} onChange={(event) => updateImage({ alignment: event.target.value })}>
            {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>图题字体</strong></div>
          <FontPicker value={config.image.caption_font} options={fontOptions} onChange={(font) => updateImage({ caption_font: font })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>图题字号</strong></div>
          <select value={config.image.caption_size} onChange={(event) => updateImage({ caption_size: event.target.value })}>
            {SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>图题对齐方式</strong></div>
          <select value={config.image.caption_alignment} onChange={(event) => updateImage({ caption_alignment: event.target.value })}>
            {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>图题加粗</strong></div>
          <AppSwitch checked={config.image.caption_bold} onCheckedChange={(checked) => updateImage({ caption_bold: checked })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>图题斜体</strong></div>
          <AppSwitch checked={config.image.caption_italic} onCheckedChange={(checked) => updateImage({ caption_italic: checked })} />
        </label>
      </div>
    </>
  );
}
