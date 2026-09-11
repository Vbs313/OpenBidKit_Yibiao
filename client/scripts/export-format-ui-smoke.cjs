/*
 * 导出格式（模版设置）编辑页无头 UI 冒烟：真实 preload + 真实 IPC + 真实 SQLite + 已构建的 dist。
 *
 * 为什么需要：ExportFormatPage 的 7 个设置面板刚被拆成 components/settings/*，
 * 而这页此前只有 pages-mount 级别的兜底（且落在「我的模板」列表页，编辑器本身没进网）。
 *
 * 覆盖：进入「模版设置 → 新建模板」编辑器，逐个点开 7 个页签并断言该面板渲染；
 *       全程监听渲染器错误，并用探针自检「监听器真的能收到」。
 *
 * 用法：npm run smoke:export-format-ui   （前置：npm run build）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { registerIpcHandlers } = require('../electron/ipc/index.cjs');

const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.html');
const RENDERER_ERROR_PROBE = 'console.error("__export-format-ui-probe__")';

const TABS = [
  { label: '快捷设置', marker: '版面预设' },
  { label: '布局设置', marker: '页边距' },
  { label: '封皮', marker: '首页不同' },
  { label: '标题样式', marker: '章节页框' },
  { label: '正文样式', marker: '段前（磅）' },
  { label: '表格样式', marker: '线框宽度' },
  { label: '图片设置', marker: '图片最大宽度（%）' },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(label, fn, { timeoutMs = 60000, intervalMs = 150 } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待${label}超时：${lastError?.message || '条件未满足'}`);
}

// 按「第一行文本」精确匹配可点击元素（侧边栏条目是多行）。
const CLICK_BY_LABEL = `(() => {
  const wanted = __TEXT__;
  const firstLine = (el) => String(el.innerText || el.textContent || "").split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean)[0] || "";
  const nodes = Array.from(document.querySelectorAll("button, [role=tab], a, [role=button]"));
  const hit = nodes.find((el) => firstLine(el) === wanted);
  if (!hit) return "MISSING:" + wanted;
  hit.click();
  return "CLICKED:" + wanted;
})()`;
const PAGE_TEXT = 'document.body.innerText';

async function run() {
  if (!fs.existsSync(DIST_INDEX)) {
    console.error('[export-format-ui] 缺少构建产物，请先运行 npm run build');
    app.exit(1);
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-export-format-ui-'));
  const userData = path.join(tempDir, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);

  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  });

  let services = null;
  const click = (text) => window.webContents.executeJavaScript(CLICK_BY_LABEL.replace('__TEXT__', JSON.stringify(text)));
  const pageText = () => window.webContents.executeJavaScript(PAGE_TEXT);
  const rendererErrors = [];
  window.webContents.on('console-message', (event) => {
    const level = event && typeof event === 'object' ? event.level : undefined;
    const message = event && typeof event === 'object' ? event.message : String(event || '');
    if (String(level) === 'error' || Number(level) >= 3) rendererErrors.push(String(message || ''));
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    rendererErrors.push('render-process-gone: ' + JSON.stringify(details));
  });

  try {
    services = registerIpcHandlers({
      app,
      mainWindow: window,
      checkAndDownloadUpdate: async () => ({ success: false }),
      triggerUpdateDownload: async () => ({ success: false }),
      quitAndInstall: async () => ({ success: false }),
      getLatestVersion: async () => '0.0.0',
      getUpdateDownloadUrl: async () => '',
    });

    await window.loadFile(DIST_INDEX);
    await waitFor('本地数据库就绪', async () => {
      const status = await window.webContents.executeJavaScript('window.yibiao?.database?.getStatus?.()');
      return status?.ready === true;
    }, { timeoutMs: 90000 });

    const entry = String(await click('模版设置'));
    assert(entry.startsWith('CLICKED'), '侧边栏缺少「模版设置」入口：' + entry);
    const create = String(await click('新建模板'));
    assert(create.startsWith('CLICKED'), '「我的模板」里缺少「新建模板」入口：' + create);
    await waitFor('导出格式编辑器挂载', async () => (await pageText()).includes('版面预设'), { timeoutMs: 20000 });
    console.log('[export-format-ui] 导出格式编辑器已挂载');

    // 错误捕获自检：先制造一条 error，确认监听器真能收到，再清掉。
    await window.webContents.executeJavaScript(RENDERER_ERROR_PROBE);
    await waitFor('渲染器错误捕获自检', async () => rendererErrors.some((line) => line.includes('__export-format-ui-probe__')));
    rendererErrors.length = 0;

    for (const { label, marker } of TABS) {
      const result = String(await click(label));
      assert(result.startsWith('CLICKED'), `找不到页签「${label}」：${result}`);
      await waitFor(`页签「${label}」面板渲染`, async () => (await pageText()).includes(marker), { timeoutMs: 10000 });
      console.log(`[export-format-ui] 页签「${label}」渲染正常（标记：${marker}）`);
    }

    assert(rendererErrors.length === 0, '渲染器报错：' + rendererErrors.join(' | '));
    console.log(`[export-format-ui] ${TABS.length} 个设置面板全部渲染，且无渲染器错误`);
    console.log('[export-format-ui] all checks passed');
    app.exit(0);
  } catch (error) {
    console.error('[export-format-ui] failed');
    console.error(error?.stack || error?.message || String(error));
    try {
      const dumpPath = path.join(tempDir, 'page-text.txt');
      const text = await window.webContents.executeJavaScript(PAGE_TEXT).catch(() => '');
      fs.writeFileSync(dumpPath, String(text), 'utf8');
      console.error(`[export-format-ui] 页面文本已保存到 ${dumpPath}`);
    } catch { /* 诊断失败不影响退出码 */ }
    app.exit(1);
  } finally {
    try { await services?.closeServices?.(); } catch { /* ignore */ }
  }
}

app.whenReady().then(run, (error) => {
  console.error('[export-format-ui] app failed to become ready');
  console.error(error?.stack || error?.message || String(error));
  app.exit(1);
});
