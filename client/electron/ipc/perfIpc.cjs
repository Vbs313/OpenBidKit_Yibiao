const { ipcMain } = require('electron');
const perfTrace = require('../utils/perfTrace.cjs');

function registerPerfIpc() {
  ipcMain.handle('perf:get-snapshot', (_event, limit) => perfTrace.summarize(Number(limit) || 20));
  ipcMain.handle('perf:reset', () => {
    perfTrace.reset();
    return { success: true };
  });
}

module.exports = {
  registerPerfIpc,
};
