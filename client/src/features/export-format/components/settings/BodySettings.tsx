// BodySettings：导出格式页的「Body」设置面板。
//
// 从 ExportFormatPage.tsx 的 render* 函数拆出来（JSX 正文逐字保留，只是把组件内的局部名字改成同名 props）。

import { FontPicker } from '../FontPicker';
import { ALIGNMENT_OPTIONS, LIST_STYLE_OPTIONS, ORDERED_LIST_STYLE_OPTIONS, SIZE_OPTIONS } from '../../../../shared/types/exportFormat';
import type { BodyTextStyleConfig, ExportFormatConfig, ListStyle, OrderedListStyle } from '../../../../shared/types/exportFormat';

export interface BodySettingsProps {
  config: ExportFormatConfig;
  fontOptions: string[];
  updateBodyText: (updates: Partial<BodyTextStyleConfig>) => void;
}

export function BodySettings({
  config,
  fontOptions,
  updateBodyText,
}: BodySettingsProps) {
  return (
    <>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy"><strong>字体</strong><span>支持输入搜索系统字体，常用字体已置顶。</span></div>
          <FontPicker value={config.body_text.font} options={fontOptions} onChange={(font) => updateBodyText({ font })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>字号</strong></div>
          <select value={config.body_text.size} onChange={(event) => updateBodyText({ size: event.target.value })}>
            {SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>对齐</strong></div>
          <select value={config.body_text.alignment} onChange={(event) => updateBodyText({ alignment: event.target.value })}>
            {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>段前（磅）</strong></div>
          <input type="number" min={0} max={100} step={1} value={config.body_text.spacing_before_pt} onChange={(event) => updateBodyText({ spacing_before_pt: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>段后（磅）</strong></div>
          <input type="number" min={0} max={100} step={1} value={config.body_text.spacing_after_pt} onChange={(event) => updateBodyText({ spacing_after_pt: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>首行缩进（字符）</strong></div>
          <input type="number" min={0} max={10} step={0.5} value={config.body_text.first_line_indent_chars} onChange={(event) => updateBodyText({ first_line_indent_chars: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>行间距（倍）</strong></div>
          <input type="number" min={0.5} max={5} step={0.1} value={config.body_text.line_spacing_multiple} onChange={(event) => updateBodyText({ line_spacing_multiple: Number(event.target.value) })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>无序列表符号</strong><span>Markdown “- 内容”的无序列表</span></div>
          <div className="export-bullet-library" role="radiogroup" aria-label="无序列表符号">
            {LIST_STYLE_OPTIONS.map((style) => {
              const selected = config.body_text.list_style === style.value;
              return (
                <button
                  type="button"
                  className={`export-bullet-option${selected ? ' is-active' : ''}`}
                  key={style.value}
                  role="radio"
                  aria-checked={selected}
                  title={style.label}
                  onClick={() => updateBodyText({ list_style: style.value as ListStyle })}
                >
                  <span style={{ fontFamily: style.font_family }}>{style.icon}</span>
                </button>
              );
            })}
          </div>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>有序列表序号</strong><span>Markdown “1. 内容”的有序列表</span></div>
          <select value={config.body_text.ordered_list_style} onChange={(event) => updateBodyText({ ordered_list_style: event.target.value as OrderedListStyle })}>
            {ORDERED_LIST_STYLE_OPTIONS.map((style) => <option key={style.value} value={style.value}>{style.label}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>列表缩进（字符）</strong></div>
          <input type="number" min={0} max={10} step={0.5} value={config.body_text.list_indent_chars} onChange={(event) => updateBodyText({ list_indent_chars: Number(event.target.value) })} />
        </label>
      </div>
    </>
  );
}
