const { ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function registerFileIpc({ fileService }) {
  ipcMain.handle('file:select-duplicate-check-files', (_event, options) => fileService.selectDuplicateCheckFiles(options));
  // 内置示例招标文件：返回打包在 resources 中的示例内容，供「一键体验」导入。
  ipcMain.handle('sample:get-tender', () => {
    try {
      const samplePath = path.join(__dirname, '..', 'resources', 'sample-tender.md');
      const content = fs.readFileSync(samplePath, 'utf8');
      return { success: true, content, name: '示例招标文件.md' };
    } catch (error) {
      return { success: false, message: error.message, content: '', name: '' };
    }
  });
}

module.exports = {
  registerFileIpc,
};
