/*
 * 主进程服务图启动冒烟：真实 SQLite + 真实 store + 真实 service 接线。
 *
 * 覆盖范围：registerIpcHandlers 完整跑一遍——包含 createTaskService 的构造，
 * 以及它在构造期执行的中断恢复驱动（taskRecovery）。这条路径此前没有任何自动化覆盖，
 * 而它一旦抛错就是「应用起不来」，属于最高危的回归面。
 *
 * 用法：npm run smoke:ipc-boot
 */
const { app } = require('electron');
const { registerIpcHandlers } = require('../electron/ipc/index.cjs');

// 只需要一个「不会崩」的窗口替身：注册期会读 isLoading / isDestroyed / 发事件。
function makeStubWindow() {
  const webContents = {
    id: -1,
    send() {},
    isDestroyed: () => true,
    isLoading: () => false,
    isDevToolsOpened: () => false,
    once() {},
    on() {},
    off() {},
    removeListener() {},
    setWindowOpenHandler() {},
    executeJavaScript: async () => undefined,
    getURL: () => '',
    reload() {},
    openDevTools() {},
    closeDevTools() {},
    setZoomFactor() {},
    getZoomFactor: () => 1,
    setBackgroundThrottling() {},
    session: { webRequest: { onBeforeRequest() {}, onHeadersReceived() {} }, protocol: {} },
  };
  return {
    webContents,
    isDestroyed: () => true,
    isMinimized: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    restore() {},
    focus() {},
    on() {},
    once() {},
    off() {},
    removeListener() {},
    show() {},
    hide() {},
    setTitle() {},
    maximize() {},
    unmaximize() {},
    getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
  };
}

app.whenReady().then(() => {
  try {
    const services = registerIpcHandlers({
      app,
      mainWindow: makeStubWindow(),
      checkAndDownloadUpdate: async () => ({ success: false }),
      triggerUpdateDownload: async () => ({ success: false }),
      quitAndInstall: async () => ({ success: false }),
      getLatestVersion: async () => '0.0.0',
      getUpdateDownloadUrl: async () => '',
    });
    console.log('[ipc-boot-smoke] 服务图构造成功，导出:', Object.keys(services).join(', '));
    try {
      services.closeServices?.();
    } catch (error) {
      console.log('[ipc-boot-smoke] closeServices 忽略:', error?.message);
    }
    console.log('[ipc-boot-smoke] all checks passed');
    app.exit(0);
  } catch (error) {
    console.error('[ipc-boot-smoke] failed');
    console.error(error?.stack || error?.message || String(error));
    app.exit(1);
  }
});