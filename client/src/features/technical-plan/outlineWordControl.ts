// 大纲字数控制的纯逻辑：草稿解析 / 格式化、归一化与校验、页数估算、相等比较。
//
// 原本是 OutlineEditPage.tsx 里的 5 个模块级函数 + 1 个常量；抽出来后可单测，
// 页面只负责把草稿与已保存配置接起来。

import type { OutlineWordControlOptions } from '../../shared/types';

export const WORD_COUNT_INPUT_UNIT = 10000;

export function parseWordCountDraft(value: string) {
  if (!value) return 0;
  if (!/^\d*(?:\.\d{0,4})?$/.test(value)) return null;
  const number = Number(value);
  const words = Math.round(number * WORD_COUNT_INPUT_UNIT);
  return Number.isSafeInteger(words) && words >= 0 ? words : null;
}

export function formatWordCountDraft(words: number) {
  return String(Math.max(0, Math.round(Number(words) || 0)) / WORD_COUNT_INPUT_UNIT);
}

export function normalizeWordControlDraft(values: {
  minimumWords: string;
  maximumWords: string;
  sectionWords: string;
  strictSectionWords: boolean;
}) {
  const minimumWords = parseWordCountDraft(values.minimumWords);
  const maximumWords = parseWordCountDraft(values.maximumWords);
  const sectionWords = parseWordCountDraft(values.sectionWords);
  if (minimumWords === null || maximumWords === null || sectionWords === null) {
    throw new Error('字数设置只允许填写非负整数');
  }
  const options: OutlineWordControlOptions = {
    minimumWords,
    maximumWords,
    sectionWords,
    strictSectionWords: sectionWords > 0 && values.strictSectionWords,
  };
  if (minimumWords > 0 && maximumWords > 0 && maximumWords < minimumWords) {
    throw new Error('最多字数不能低于最少字数');
  }
  const effectiveSectionWords = sectionWords > 0 ? sectionWords : 3000;
  const minimumLeafCount = minimumWords > 0 ? Math.ceil(minimumWords / effectiveSectionWords) : null;
  const maximumLeafCount = maximumWords > 0 ? Math.floor(maximumWords / effectiveSectionWords) : null;
  if (maximumLeafCount !== null && maximumLeafCount < 1) {
    throw new Error('当前最多字数无法形成有效叶子节点范围，请调整最多字数或每小节字数');
  }
  if (minimumLeafCount !== null && maximumLeafCount !== null && minimumLeafCount > maximumLeafCount) {
    throw new Error('当前设置无法形成有效叶子节点范围，请调整最少字数、最多字数或每小节字数');
  }
  return options;
}

export function getEstimatedPages(minimumWords: number, maximumWords: number) {
  const baseWords = minimumWords > 0 && maximumWords > 0
    ? (minimumWords + maximumWords) / 2
    : minimumWords || maximumWords;
  return baseWords > 0 ? Math.ceil(baseWords / 650) : null;
}

export function areWordControlOptionsEqual(left?: OutlineWordControlOptions, right?: OutlineWordControlOptions) {
  return Boolean(left && right
    && left.minimumWords === right.minimumWords
    && left.maximumWords === right.maximumWords
    && left.sectionWords === right.sectionWords
    && left.strictSectionWords === right.strictSectionWords);
}
