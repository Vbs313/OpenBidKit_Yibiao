const { dialog, ipcMain } = require('electron');
const { listComplianceChecks } = require('../services/compliance/complianceCheckRegistry.cjs');

const FILE_FILTERS = [
  { name: '报价文件', extensions: ['md', 'markdown', 'json', 'txt'] },
  { name: '所有文件', extensions: ['*'] },
];

function registerComplianceCheckIpc({ complianceCheckStore, complianceCheckerService, taskService }) {
  ipcMain.handle('compliance-check:load-state', () => complianceCheckStore.loadComplianceCheck());
  ipcMain.handle('compliance-check:list-checks', () => listComplianceChecks());
  ipcMain.handle('compliance-check:select-file', async (_event, role) => {
    const label = role === 'tender' ? '招标文件' : '投标文件';
    const result = await dialog.showOpenDialog({
      title: `选择${label}`,
      properties: ['openFile'],
      filters: FILE_FILTERS,
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, filePath: '' };
    }
    return { canceled: false, filePath: result.filePaths[0] };
  });
  ipcMain.handle('compliance-check:save-input', (_event, input) => complianceCheckStore.saveInput(input));
  ipcMain.handle('compliance-check:run', (event, payload) => {
    taskService.subscribe(event.sender);
    return taskService.startComplianceCheck(payload);
  });
  ipcMain.handle('compliance-check:get-status', () => complianceCheckStore.loadComplianceCheck());
  ipcMain.handle('compliance-check:get-report', (_event, jobId) => complianceCheckStore.getReport(jobId));
  ipcMain.handle('compliance-check:cancel', () => taskService.cancelComplianceCheck());
  ipcMain.handle('compliance-check:clear', () => taskService.resetComplianceCheck());
  ipcMain.handle('compliance-check:ping', () => complianceCheckerService.ping());
}

module.exports = {
  registerComplianceCheckIpc,
};
