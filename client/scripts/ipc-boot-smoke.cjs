/*
 * 主进程服务图启动冒烟：真实 SQLite + 真实 store + 真实 service 接线。
 *
 * 覆盖两段此前没有任何自动化覆盖、一旦出错就是「应用起不来 / 功能静默失效」的路径：
 *   1) registerIpcHandlers 完整跑一遍（含 createTaskService 构造与其中断恢复驱动）；
 *   2) createPiRuntimeService 构造（它是懒创建的，注册期不会走到，自检模块的接线就在这里验证）。
 *
 * 用法：npm run smoke:ipc-boot
 */
const { app } = require('electron');
const { registerIpcHandlers } = require('../electron/ipc/index.cjs');
const { createConfigStore } = require('../electron/services/stores/configStore.cjs');
const { createAiService } = require('../electron/services/aiService.cjs');
const { createPiRuntimeService } = require('../electron/services/pi/piRuntimeService.cjs');

const PI_RUNTIME_PUBLIC_API = ['warmup', 'runTask', 'deleteTaskArchive', 'runSelfCheck', 'getStatus', 'restart', 'handleConfigChanged', 'onStatus', 'close'];

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

function bootServiceGraph() {
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
  return services;
}

function bootPiRuntime() {
  const configStore = createConfigStore(app);
  const aiService = createAiService({ app, configStore });
  const runtime = createPiRuntimeService({
    app,
    configStore,
    aiService,
    isMonitorActive: () => false,
    onMonitorEvent: () => {},
    requestUserQuestion: async () => ({ answers: [] }),
  });
  const missing = PI_RUNTIME_PUBLIC_API.filter((name) => typeof runtime[name] !== 'function');
  if (missing.length) throw new Error('Pi runtime 公开 API 缺方法: ' + missing.join(', '));
  console.log('[ipc-boot-smoke] Pi runtime 构造成功，status.phase =', runtime.getStatus()?.phase);
  return runtime;
}

// 数据库初始化是「加载完成后再 setTimeout(120ms)」触发的；失败走 console.error。
// 这里捕获这段时间的错误日志，否则「应用起不来」这类缺陷会被静默放过。
function captureConsoleErrors() {
  const captured = [];
  const original = console.error;
  console.error = (...args) => { captured.push(args.map((a) => (a && a.message) || String(a)).join(' ')); original.apply(console, args); };
  return { captured, restore: () => { console.error = original; } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  try {
    const spy = captureConsoleErrors();
    const services = bootServiceGraph();
    await sleep(2500);
    spy.restore();
    const dbFailure = spy.captured.find((line) => line.includes('工作区数据库初始化失败'));
    if (dbFailure) throw new Error('工作区数据库初始化失败：' + dbFailure);
    console.log('[ipc-boot-smoke] 工作区数据库初始化未报错（已等待延迟初始化完成）');

    const piRuntime = bootPiRuntime();
    try {
      services.closeServices?.();
    } catch (error) {
      console.log('[ipc-boot-smoke] closeServices 忽略:', error?.message);
    }
    try {
      piRuntime.close?.();
    } catch (error) {
      console.log('[ipc-boot-smoke] piRuntime.close 忽略:', error?.message);
    }
    console.log('[ipc-boot-smoke] all checks passed');
    app.exit(0);
  } catch (error) {
    console.error('[ipc-boot-smoke] failed');
    console.error(error?.stack || error?.message || String(error));
    app.exit(1);
  }
});