// QuickSettings：导出格式页的「Quick」设置面板。
//
// 从 ExportFormatPage.tsx 的 render* 函数拆出来（JSX 正文逐字保留，只是把组件内的局部名字改成同名 props）。

import { EXPORT_LAYOUT_PRESETS, EXPORT_THEME_PRESETS } from '../../exportFormatPresets';
import type { ExportFormatConfig } from '../../../../shared/types/exportFormat';

export interface QuickSettingsProps {
  mode: 'create' | 'edit';
  config: ExportFormatConfig;
  selectedLayoutPresetId: string;
  selectedThemePresetId: string;
  updateTemplate: (updates: Partial<ExportFormatConfig>) => void;
  handleApplyLayoutPreset: (presetId: string) => void;
  handleApplyThemePreset: (presetId: string) => void;
  handleConfirmTemplateName: () => void;
}

export function QuickSettings({
  mode,
  config,
  selectedLayoutPresetId,
  selectedThemePresetId,
  updateTemplate,
  handleApplyLayoutPreset,
  handleApplyThemePreset,
  handleConfirmTemplateName,
}: QuickSettingsProps) {
  return (
    <>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy">
            <strong>版面预设</strong>
            <span>快捷设置所有版面包括纸张、边距、标题、正文等</span>
          </div>
          <select value={selectedLayoutPresetId} onChange={(event) => handleApplyLayoutPreset(event.target.value)}>
            <option value="" disabled>选择版面预设</option>
            {EXPORT_LAYOUT_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy">
            <strong>主题预设</strong>
            <span>未开启章节页框时只应用表格颜色；开启章节页框后同步应用标题、页框、页眉页脚和表格颜色。</span>
          </div>
          <select value={selectedThemePresetId} onChange={(event) => handleApplyThemePreset(event.target.value)}>
            <option value="" disabled>选择主题预设</option>
            {EXPORT_THEME_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
        </label>
        {mode === 'create' ? (
          <form
            className="settings-row export-template-name-row"
            onSubmit={(event) => {
              event.preventDefault();
              handleConfirmTemplateName();
            }}
          >
            <div className="settings-row-copy">
              <strong>设置模板名称</strong>
              <span>默认按 yibiao-YYYY-MM-DD-HHmmss 格式生成，保存后显示在“我的模板”中。</span>
            </div>
            <div className="input-with-action export-template-name-control">
              <input
                type="text"
                value={config.template_name}
                onChange={(event) => updateTemplate({ template_name: event.target.value })}
                placeholder="请输入模板名称"
                aria-label="模板名称"
                spellCheck={false}
              />
              <button type="submit" className="input-with-action-button">确定</button>
            </div>
          </form>
        ) : null}
      </div>
      <div className="export-format-preset-panel">
        <div className="export-format-preset-panel-head">
          <strong>主题色展示</strong>
          <span>主题只覆盖颜色；章节页框关闭时仅表格使用主题色。</span>
        </div>
        <div className="export-format-preset-list is-theme is-static">
          {EXPORT_THEME_PRESETS.map((preset) => (
            <div key={preset.id} className="export-format-preset-card export-format-theme-card is-static">
              <strong>{preset.label}</strong>
              <span className="export-format-preset-hint">{preset.description}</span>
              <div className="export-format-theme-swatches" aria-hidden="true">
                {preset.swatches.map((color) => <span key={color} style={{ background: color }} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
