const { ipcMain, shell, dialog } = require('electron');
const { batchExportBidSections } = require('./../services/batchExportService.cjs');

function registerExportIpc({ exportService, technicalPlanStore, app }) {
  // 批量导出：一次性导出全部标段 Word。
  ipcMain.handle('export:batch-word', async (event) => {
    // 让用户选输出目录。
    const outputDir = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (outputDir.canceled || !outputDir.filePaths[0]) return { success: false, message: '已取消' };
    return batchExportBidSections({
      exportService,
      technicalPlanStore,
      outputDir: outputDir.filePaths[0],
      onProgress: (done, total, sectionName) => {
        event.sender.send('export:batch-progress', { done, total, sectionName });
      },
    });
  });

  ipcMain.handle('export:word', async (event, payload = {}) => {
    const requestId = payload.requestId || payload.request_id;
    const sendProgress = (progress) => {
      event.sender.send('export:word-progress', { requestId, ...progress });
    };

    try {
      return await exportService.exportWord(payload, sendProgress);
    } catch (error) {
      sendProgress({
        phase: 'error',
        progress: 100,
        message: error.message || '导出 Word 失败',
      });
      throw error;
    }
  });

  ipcMain.handle('export:open-file', async (_event, filePath) => {
    const targetPath = String(filePath || '').trim();
    if (!targetPath) {
      throw new Error('缺少要打开的文件路径');
    }

    const errorMessage = await shell.openPath(targetPath);
    if (errorMessage) {
      throw new Error(`打开文件失败：${errorMessage}`);
    }

    return { success: true };
  });
}

module.exports = {
  registerExportIpc,
};
