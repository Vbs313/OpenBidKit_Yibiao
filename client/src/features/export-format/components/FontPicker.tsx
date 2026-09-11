// 字体选择器：输入框 + 可搜索下拉，导出格式页里被标题/正文/表格/图片等多处复用。
//
// 原本是 ExportFormatPage.tsx 内的一个模块级组件（66 行），与页面状态无关，独立成文件。

import { useMemo, useState } from 'react';

export interface FontPickerProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}


export function FontPicker({ value, options, onChange }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [searchDirty, setSearchDirty] = useState(false);
  const filteredOptions = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!searchDirty || !query) return options;
    return options.filter((font) => font.toLowerCase().includes(query));
  }, [options, searchDirty, value]);

  const pickFont = (font: string) => {
    onChange(font);
    setSearchDirty(false);
    setOpen(false);
  };

  return (
    <div className="font-picker" onBlur={(event) => {
      const nextFocus = event.relatedTarget;
      if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
        setOpen(false);
        setSearchDirty(false);
      }
    }}>
      <input
        className="font-picker-input"
        type="text"
        value={value}
        onFocus={() => {
          setOpen(true);
          setSearchDirty(false);
        }}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setSearchDirty(true);
        }}
        placeholder="输入或选择字体"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
      />
      {open && (
        <div className="font-picker-menu" role="listbox">
          <div className="font-picker-summary">
            {searchDirty ? `匹配 ${filteredOptions.length} 个字体` : `共 ${options.length} 个字体，输入可搜索`}
          </div>
          {filteredOptions.length > 0 ? filteredOptions.map((font) => (
            <button
              key={font}
              type="button"
              className={`font-picker-option${font === value ? ' is-selected' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                pickFont(font);
              }}
              role="option"
              aria-selected={font === value}
            >
              {font}
            </button>
          )) : <div className="font-picker-empty">没有匹配字体</div>}
        </div>
      )}
    </div>
  );
}