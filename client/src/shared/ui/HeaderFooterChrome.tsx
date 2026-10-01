import { useMemo } from 'react';
// 复用 electron/shared/chrome 的 SVG 生成器，保证缩略图与正式导出一致（所见即所得）。
// 注意：electron/shared/chrome/index.mjs 是 Electron 侧模块；此处仅在渲染预览时动态加载。
import type { HeaderFooterStyle, PageSetupConfig } from '../types/exportFormat';
import { HEADER_FOOTER_STYLE_OPTIONS } from '../types/exportFormat';

function hexLuminance(hex: string): number {
  const raw = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(raw)) return 0;
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function contrastText(background: string): string {
  return hexLuminance(background) < 160 ? '#ffffff' : '#111111';
}

function darkenHex(hex: string, amount = 0.18): string {
  const raw = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(raw)) return '#111111';
  const channel = (start: number) => Math.max(0, Math.round(Number.parseInt(raw.slice(start, start + 2), 16) * (1 - amount)));
  return `#${[0, 2, 4].map((start) => channel(start).toString(16).padStart(2, '0')).join('')}`;
}

interface ChromeColors {
  bar: string;
  accent: string;
  onBar: string;
  onAccent: string;
  badge: string;
  slot: string;
}

export function resolveChromeColors(page: Pick<PageSetupConfig, 'chrome_bar_color' | 'chrome_accent_color'>): ChromeColors {
  const bar = page.chrome_bar_color || '#e8eef5';
  const accent = page.chrome_accent_color || '#536176';
  const onAccent = contrastText(accent);
  return {
    bar,
    accent,
    onBar: contrastText(bar) === '#ffffff' ? '#ffffff' : accent,
    onAccent,
    badge: darkenHex(accent, 0.12),
    slot: onAccent,
  };
}

interface StylePickerProps {
  value: HeaderFooterStyle;
  bar: string;
  accent: string;
  onChange: (style: HeaderFooterStyle) => void;
}

/**
 * 页眉页脚样式选择器：每种样式一张卡片，按真实装饰比例缩略。
 * 装饰高度按纸张比例展示，一眼看出占多大分量。
 */
export function HeaderFooterStylePicker({ value, bar, accent, onChange }: StylePickerProps) {
  const colors = resolveChromeColors({ chrome_bar_color: bar, chrome_accent_color: accent });
  return (
    <div className="header-footer-style-picker" role="radiogroup" aria-label="页眉页脚样式">
      {HEADER_FOOTER_STYLE_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`header-footer-style-card${selected ? ' is-selected' : ''}`}
            onClick={() => onChange(option.value)}
            role="radio"
            aria-checked={selected}
            title={option.description}
          >
            <span className="header-footer-style-thumb" aria-hidden="true">
              {option.value !== 'plain' ? (
                <span
                  className="header-footer-style-thumb-chrome is-header"
                  style={{ backgroundColor: colors.bar }}
                />
              ) : null}
              <span className="header-footer-style-thumb-body">
                <i /><i /><i /><i />
              </span>
              {option.value !== 'plain' ? (
                <span
                  className={`header-footer-style-thumb-chrome is-footer${option.value === 'footer-badge' ? ' has-badge' : ''}`}
                  style={{ backgroundColor: option.value === 'frame' ? 'transparent' : colors.accent }}
                />
              ) : null}
            </span>
            <span className="header-footer-style-label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
