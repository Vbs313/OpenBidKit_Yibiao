/*
 * 全页面挂载冒烟：把侧边栏每个入口点一遍，断言「页面能挂载」且「渲染器不报错」。
 *
 * 为什么值得单独一条：逐页写冒烟成本高，而「import 坏了 / 渲染崩了 / Provider 少了」
 * 这类问题会让某个页面直接白屏——这条网一次覆盖全部入口，单位收益最高。
 *
 * 判定口径：点击后 body 文本长度 > 200（排除白屏/空页），且这段时间没有新的
 * console error / 未捕获异常 / 渲染进程崩溃。
 *
 * 用法：npm run smoke:pages-mount   （前置：npm run build）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { registerIpcHandlers } = require('../electron/ipc/index.cjs');

const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.html');
// 侧边栏的一级入口（顺序无关）。
const PAGES = ['标书生成', '模版设置', '知识库', '标书检查', '投标机会', '插件管理', '资源下载', '设置'];

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

const CLICK_BY_LABEL = `(() => {
  const wanted = __TEXT__;
  const lines = (el) => String(el.innerText || el.textContent || '').split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean);
  const nodes = Array.from(document.querySelectorAll('button, [role=button], a, [role=tab]'));
  const hit = nodes.find((el) => lines(el)[0] === wanted) || nodes.find((el) => lines(el).includes(wanted));
  if (!hit) return 'MISSING:' + wanted;
  hit.click();
  return 'CLICKED:' + wanted;
})()`;

const BODY_LENGTH = 'document.body.innerText.length';

async function run() {
  if (!fs.existsSync(DIST_INDEX)) {
    console.error('[pages-mount] 缺少构建产物，请先运行 npm run build');
    app.exit(1);
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-pages-mount-'));
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

  // 收集渲染器错误：console error（level>=3）/ 未捕获异常 / 渲染进程崩溃。
  const rendererErrors = [];
  window.webContents.on('console-message', (event) => {
    const level = typeof event === 'object' && event !== null ? event.level : arguments[1];
    const message = typeof event === 'object' && event !== null ? event.message : arguments[2];
    if (String(level) === 'error' || Number(level) >= 3) rendererErrors.push(String(message || ''));
  });
  window.webContents.on('render-process-gone', (event, details) => {
    rendererErrors.push('render-process-gone: ' + JSON.stringify(details));
  });

  let services = null;
  const click = (text) => window.webContents.executeJavaScript(CLICK_BY_LABEL.replace('__TEXT__', JSON.stringify(text)));
  const bodyLength = () => window.webContents.executeJavaScript(BODY_LENGTH);

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
    console.log('[pages-mount] 本地数据库就绪');

    // 自检：先证明「渲染器错误捕获」真的有效，否则「0 个错误」可能只是监听器没生效。
    {
      const probeIndex = rendererErrors.length;
      await window.webContents.executeJavaScript('console.error("__pages-mount-probe__")');
      await waitFor('错误捕获自检', async () => rendererErrors.slice(probeIndex).some((line) => line.includes('__pages-mount-probe__')), { timeoutMs: 5000 });
      rendererErrors.length = probeIndex;
      console.log('[pages-mount] 渲染器错误捕获自检有效');
    }

    for (const label of PAGES) {
      const before = rendererErrors.length;
      const result = String(await click(label));
      assert(result.startsWith('CLICKED'), `侧边栏缺少入口：${label}（${result}）`);
      await waitFor(`「${label}」页面挂载`, async () => (await bodyLength()) > 200, { timeoutMs: 20000 });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const fresh = rendererErrors.slice(before);
      assert(fresh.length === 0, `「${label}」渲染报错：${fresh.slice(0, 3).join(' | ')}`);
      assert((await bodyLength()) > 200, `「${label}」渲染成了空页`);
      console.log(`[pages-mount] 「${label}」挂载正常`);
    }

    console.log(`[pages-mount] ${PAGES.length} 个侧边栏入口全部可挂载且无渲染错误`);
    console.log('[pages-mount] all checks passed');
    app.exit(0);
  } catch (error) {
    console.error('[pages-mount] failed');
    console.error(error?.stack || error?.message || String(error));
    if (rendererErrors.length) {
      console.error('[pages-mount] 渲染器错误：');
      for (const line of rendererErrors.slice(0, 10)) console.error('  ' + line);
    }
    try {
      const dumpPath = path.join(tempDir, 'page-text.txt');
      const text = await window.webContents.executeJavaScript('document.body.innerText').catch(() => '');
      fs.writeFileSync(dumpPath, String(text), 'utf8');
      console.error(`[pages-mount] 页面文本已保存到 ${dumpPath}`);
    } catch { /* 诊断失败不影响退出码 */ }
    app.exit(1);
  } finally {
    try { await services?.closeServices?.(); } catch { /* ignore */ }
  }
}

app.whenReady().then(run, (error) => {
  console.error('[pages-mount] app failed to become ready');
  console.error(error?.stack || error?.message || String(error));
  app.exit(1);
});