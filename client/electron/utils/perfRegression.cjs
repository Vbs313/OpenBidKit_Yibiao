// 性能基线回归检测：对比当前 perfTrace 快照与保存的基线，标记回归项。
//
// 用途：CI/发布前跑一遍典型流程，检测性能是否退化。
// 设计：
// 1. 基线保存在 userData/perf-baseline.json（每次「保存基线」覆盖）。
// 2. 对比维度：p50/p95/count，阈值可配（默认 p95 退化 >30% 视为回归）。
// 3. 纯函数对比逻辑，可单测；文件 IO 与阈值由调用方注入。

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REGRESSION_THRESHOLD = 0.3; // p95 退化 30%

/**
 * 对比两份 perf 快照，输出回归项。
 *
 * @param {Record<string, {p50: number, p95: number, count: number}>} baseline
 * @param {Record<string, {p50: number, p95: number, count: number}>} current
 * @param {{threshold?: number}} options
 * @returns {{regressions: Array<{name: string, baseline_p95: number, current_p95: number, delta_ratio: number}>, improvements: string[], unchanged: string[]}}
 */
function detectRegressions(baseline, current, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_REGRESSION_THRESHOLD;
  const regressions = [];
  const improvements = [];
  const unchanged = [];

  for (const [name, base] of Object.entries(baseline || {})) {
    const now = current?.[name];
    if (!now) continue; // 当前未触发该指标，跳过。
    const baseP95 = Number(base?.p95) || 0;
    const nowP95 = Number(now?.p95) || 0;
    if (baseP95 <= 0) continue;
    const deltaRatio = (nowP95 - baseP95) / baseP95;
    if (deltaRatio > threshold) {
      regressions.push({ name, baseline_p95: baseP95, current_p95: nowP95, delta_ratio: deltaRatio });
    } else if (deltaRatio < -threshold) {
      improvements.push(name);
    } else {
      unchanged.push(name);
    }
  }

  return { regressions, improvements, unchanged };
}

function loadBaseline(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveBaseline(filePath, snapshot) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
}

module.exports = {
  DEFAULT_REGRESSION_THRESHOLD,
  detectRegressions,
  loadBaseline,
  saveBaseline,
};
