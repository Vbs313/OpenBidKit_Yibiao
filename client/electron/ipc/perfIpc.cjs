const { ipcMain } = require('electron');
const path = require('node:path');
const perfTrace = require('../utils/perfTrace.cjs');
const { detectRegressions, loadBaseline, saveBaseline } = require('../utils/perfRegression.cjs');

function registerPerfIpc({ app } = {}) {
  const baselinePath = () => path.join(app?.getPath?.('userData') || '.', 'perf-baseline.json');

  ipcMain.handle('perf:get-snapshot', (_event, limit) => perfTrace.summarize(Number(limit) || 20));
  ipcMain.handle('perf:reset', () => {
    perfTrace.reset();
    return { success: true };
  });
  ipcMain.handle('perf:save-baseline', () => {
    const snapshot = perfTrace.summarize(100);
    saveBaseline(baselinePath(), snapshot);
    return { success: true, count: Object.keys(snapshot).length };
  });
  ipcMain.handle('perf:check-regression', (_event, threshold) => {
    const baseline = loadBaseline(baselinePath());
    if (!baseline) return { success: false, message: '尚未保存性能基线' };
    const current = perfTrace.summarize(100);
    const result = detectRegressions(baseline, current, { threshold });
    return { success: true, ...result };
  });
}

module.exports = {
  registerPerfIpc,
};
