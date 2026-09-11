// HeadingSettings：导出格式页的「Heading」设置面板。
//
// 从 ExportFormatPage.tsx 的 render* 函数拆出来（JSX 正文逐字保留，只是把组件内的局部名字改成同名 props）。

import { AppSwitch } from '../../../../shared/ui';
import { FontPicker } from '../FontPicker';
import { headingNumberExample } from '../../exportFormatModel';
import { ALIGNMENT_OPTIONS, DEFAULT_EXPORT_FORMAT, HEADING_LEVEL_LABELS, HEADING_NUMBERING_FORMAT_OPTIONS, SIZE_OPTIONS } from '../../../../shared/types/exportFormat';
import type { ExportFormatConfig, HeadingBorderConfig, HeadingNumberingFormat, HeadingStyleConfig } from '../../../../shared/types/exportFormat';

export interface HeadingSettingsProps {
  config: ExportFormatConfig;
  fontOptions: string[];
  expandedHeadings: Set<number>;
  updateTemplate: (updates: Partial<ExportFormatConfig>) => void;
  updateHeading: (index: number, updates: Partial<HeadingStyleConfig>) => void;
  updateHeadingBorder: (updates: Partial<HeadingBorderConfig>) => void;
  updateHeadingBorderCellColor: (index: number, value: string) => void;
  toggleHeading: (index: number) => void;
}

export function HeadingSettings({
  config,
  fontOptions,
  expandedHeadings,
  updateTemplate,
  updateHeading,
  updateHeadingBorder,
  updateHeadingBorderCellColor,
  toggleHeading,
}: HeadingSettingsProps) {
  return (
    <>
      <div className="settings-list">
        <label className="settings-row">
          <div className="settings-row-copy"><strong>一级标题另起页</strong></div>
          <AppSwitch checked={config.heading_level1_page_break_before} onCheckedChange={(checked) => updateTemplate({ heading_level1_page_break_before: checked })} />
        </label>
        <label className="settings-row">
          <div className="settings-row-copy"><strong>章节页框</strong><span>会导致导航窗格失效</span></div>
          <AppSwitch checked={config.heading_border.enabled} onCheckedChange={(checked) => updateHeadingBorder({ enabled: checked })} />
        </label>
        {config.heading_border.enabled && (
          <>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>最小标题居左</strong><span>最小标题不显示序号，固定在内容左侧</span></div>
              <AppSwitch checked={config.heading_border.min_heading_left_enabled} onCheckedChange={(checked) => updateHeadingBorder({ min_heading_left_enabled: checked })} />
            </label>
            <label className="settings-row">
              <div className="settings-row-copy"><strong>页框颜色</strong></div>
              <input type="color" value={config.heading_border.border_color} onChange={(event) => updateHeadingBorder({ border_color: event.target.value })} />
            </label>
            <div className="export-format-heading-cell-colors">
              <div className="export-format-heading-cell-colors-title">
                <strong>标题单元格颜色</strong>
                <span>仅作用于章节页框内对应级别标题所在的表格单元格。</span>
              </div>
              <div className="export-format-heading-cell-color-grid">
                {HEADING_LEVEL_LABELS.map((label, index) => (
                  <label key={label}>
                    <span>{label}</span>
                    <input
                      type="color"
                      value={config.heading_border.level_cell_colors[index] || DEFAULT_EXPORT_FORMAT.heading_border.level_cell_colors[index]}
                      onChange={(event) => updateHeadingBorderCellColor(index, event.target.value)}
                    />
                  </label>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
      <details className="export-format-heading-note">
        <summary className="export-format-heading-note-summary">
          <span className="export-format-heading-note-title">
            <strong>自定义编号说明</strong>
            <span>选择“自定义”后，可用 <code>{'{zh}'}</code>、<code>{'{num}'}</code>、<code>{'{tail2}'}</code> 等占位符组合标题编号。</span>
          </span>
          <span className="export-format-heading-note-toggle">
            <span className="is-closed">展开用法</span>
            <span className="is-open">收起说明</span>
            <span className="export-format-heading-note-chevron">▸</span>
          </span>
        </summary>
        <div className="export-format-heading-note-detail">
          <div className="export-format-heading-note-block">
            <span className="export-format-heading-note-label">怎么填写</span>
            <p>在每个标题卡片中，把“编号格式”设为“自定义”，再在“自定义格式”输入下面这些模板。</p>
          </div>
          <div className="export-format-heading-note-block">
            <span className="export-format-heading-note-label">占位符</span>
            <div className="export-format-heading-token-grid">
              <span><code>{'{zh}'}</code><small>当前级中文数字，如 一、二</small></span>
              <span><code>{'{num}'}</code><small>当前级数字，如 1、2</small></span>
              <span><code>{'{full}'}</code><small>完整编号，如 1.2.3</small></span>
              <span><code>{'{tail}'}</code><small>保留旧规则，三级起局部编号</small></span>
              <span><code>{'{tail1}'}</code><small>从一级开始，等同完整编号</small></span>
              <span><code>{'{tail2}'}</code><small>从二级开始，到当前级结束</small></span>
              <span><code>{'{tail3}'}</code><small>从三级开始，到当前级结束</small></span>
              <span><code>{'{tail4}'}</code><small>从四级开始，到当前级结束</small></span>
              <span><code>{'{tail5}'}</code><small>从五级开始，到当前级结束</small></span>
              <span><code>{'{tail6}'}</code><small>从六级开始，只保留六级编号</small></span>
              <span><code>{'{circled}'}</code><small>当前级圆圈数字，如 ①、②</small></span>
              <span><code>{'{alpha}'}</code><small>当前级小写字母，如 a、b</small></span>
              <span><code>{'{ROMAN}'}</code><small>当前级大写罗马数字，如 I、II</small></span>
            </div>
          </div>
          <div className="export-format-heading-note-block">
            <span className="export-format-heading-note-label">常见配置示例</span>
            <div className="export-format-heading-example-list">
              <span><code>（{'{zh}'}）</code><small>一级标题显示 （一）</small></span>
              <span><code>第{'{zh}'}章</code><small>一级标题显示 第一章</small></span>
              <span><code>{'{tail2}'}.</code><small>二级标题显示 1.</small></span>
              <span><code>{'{tail2}'}</code><small>三级标题显示 1.1，四级标题显示 1.1.1</small></span>
              <span><code>{'{tail3}'}</code><small>三级标题显示 1，四级标题显示 1.1</small></span>
              <span><code>{'{tail6}'}</code><small>六级标题只显示当前六级数字</small></span>
              <span><code>{'{num}'}、</code><small>当前级显示 1、</small></span>
              <span><code>（{'{num}'}）</code><small>当前级显示 （1）</small></span>
              <span><code>{'{circled}'}</code><small>当前级显示 ①</small></span>
              <span><code>{'{ALPHA}'}.</code><small>当前级显示 A.</small></span>
              <span><code>{'{roman}'}.</code><small>当前级显示 i.</small></span>
            </div>
          </div>
        </div>
      </details>
      <div className="export-format-heading-list">
        {config.headings.map((heading, index) => {
          const isExpanded = expandedHeadings.has(index);
          const numExample = headingNumberExample(index, heading);
          return (
            <div key={index} className={`export-format-heading-card${isExpanded ? ' is-expanded' : ''}`}>
              <button type="button" className="export-format-heading-header" onClick={() => toggleHeading(index)}>
                <span className="export-format-heading-label">{HEADING_LEVEL_LABELS[index]}</span>
                <span className="export-format-heading-example">{numExample || '无编号'}</span>
                <span className={`export-format-heading-chevron${isExpanded ? ' is-open' : ''}`}>▸</span>
              </button>
              {isExpanded && (
                <div className="export-format-heading-body">
                  <div className="export-format-heading-grid">
                    <label>
                      <span>编号格式</span>
                      <select value={heading.numbering_format} onChange={(event) => updateHeading(index, { numbering_format: event.target.value as HeadingNumberingFormat })}>
                        {HEADING_NUMBERING_FORMAT_OPTIONS.map((numberingFormat) => <option key={numberingFormat.value} value={numberingFormat.value}>{numberingFormat.label}</option>)}
                      </select>
                    </label>
                    {heading.numbering_format === 'custom' && (
                      <label>
                        <span>自定义格式</span>
                        <input
                          type="text"
                          value={heading.numbering_template}
                          placeholder="例如：第{zh}章、{tail2}、（{num}）"
                          onChange={(event) => updateHeading(index, { numbering_template: event.target.value })}
                        />
                      </label>
                    )}
                    <label>
                      <span>字体</span>
                      <FontPicker value={heading.font} options={fontOptions} onChange={(font) => updateHeading(index, { font })} />
                    </label>
                    <label>
                      <span>字号</span>
                      <select value={heading.size} onChange={(event) => updateHeading(index, { size: event.target.value })}>
                        {SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>对齐</span>
                      <select value={heading.alignment} onChange={(event) => updateHeading(index, { alignment: event.target.value })}>
                        {ALIGNMENT_OPTIONS.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
                      </select>
                    </label>
                    <label className="export-format-heading-switch">
                      <span>加粗</span>
                      <AppSwitch checked={heading.bold} onCheckedChange={(checked) => updateHeading(index, { bold: checked })} />
                    </label>
                    <label>
                      <span>文字颜色</span>
                      <input type="color" value={heading.text_color} onChange={(event) => updateHeading(index, { text_color: event.target.value })} />
                    </label>
                    <label>
                      <span>段前（磅）</span>
                      <input type="number" min={0} max={100} step={1} value={heading.spacing_before_pt} onChange={(event) => updateHeading(index, { spacing_before_pt: Number(event.target.value) })} />
                    </label>
                    <label>
                      <span>段后（磅）</span>
                      <input type="number" min={0} max={100} step={1} value={heading.spacing_after_pt} onChange={(event) => updateHeading(index, { spacing_after_pt: Number(event.target.value) })} />
                    </label>
                    <label>
                      <span>行距（倍）</span>
                      <input type="number" min={0.5} max={5} step={0.1} value={heading.line_spacing} onChange={(event) => updateHeading(index, { line_spacing: Number(event.target.value) })} />
                    </label>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
