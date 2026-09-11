/*
 * 知识库页无头 UI 冒烟：真实 preload + 真实 IPC + 真实 SQLite + 已构建的 dist。
 *
 * 为什么需要：KnowledgeBasePage 约 950 行，此前只有 pages-mount 的「白屏兜底」。
 * 这里补一条真正走交互的网：进入页面 → 新建文件夹 → 断言文件夹出现在列表里。
 * 文档上传/解析依赖真实 docx 与 LibreOffice，不在本冒烟范围内。
 *
 * 用法：npm run smoke:knowledge-base-ui   （前置：npm run build）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { registerIpcHandlers } = require('../electron/ipc/index.cjs');

const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.html');
const RENDERER_ERROR_PROBE = 'console.error("__knowledge-base-ui-probe__")';
const FOLDER_NAME = '冒烟文件夹';

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
  const firstLine = (el) => String(el.innerText || el.textContent || "").split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean)[0] || "";
  const nodes = Array.from(document.querySelectorAll("button, [role=tab], a, [role=button]"));
  const hit = nodes.find((el) => firstLine(el) === wanted);
  if (!hit) return "MISSING:" + wanted;
  hit.click();
  return "CLICKED:" + wanted;
})()`;
const PAGE_TEXT = 'document.body.innerText';

// React 受控 input：必须用原生 setter + input 事件，直接改 value 不会触发 onChange。
const FILL_FOLDER_NAME = `(() => {
  const input = document.querySelector('input[placeholder="输入文件夹名称"]');
  if (!input) return "MISSING_INPUT";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, ${JSON.stringify(FOLDER_NAME)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return "FILLED";
})()`;

async function run() {
  if (!fs.existsSync(DIST_INDEX)) {
    console.error('[knowledge-base-ui] 缺少构建产物，请先运行 npm run build');
    app.exit(1);
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-knowledge-base-ui-'));
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

    const entry = String(await click('知识库'));
    assert(entry.startsWith('CLICKED'), '侧边栏缺少「知识库」入口：' + entry);
    // 侧边栏进入的是知识库选择页，再点一次「文档知识库」才进文档库。
    const docLibrary = String(await click('文档知识库'));
    assert(docLibrary.startsWith('CLICKED'), '缺少「文档知识库」入口：' + docLibrary);
    await waitFor('知识库页挂载', async () => {
      const text = String(await pageText());
      return text.includes('知识库') && text.includes('全库检索') && text.includes('新建文件夹');
    }, { timeoutMs: 20000 });
    console.log('[knowledge-base-ui] 知识库页已挂载');

    // 错误捕获自检
    await window.webContents.executeJavaScript(RENDERER_ERROR_PROBE);
    await waitFor('渲染器错误捕获自检', async () => rendererErrors.some((line) => line.includes('__knowledge-base-ui-probe__')));
    rendererErrors.length = 0;

    // 「新建文件夹」在列表加载完成前是 disabled，disabled 按钮点不动——先等它可用。
    await waitFor('「新建文件夹」按钮可用', async () => window.webContents.executeJavaScript(
      '(() => { const btn = Array.from(document.querySelectorAll("button")).find((el) => String(el.innerText||"").trim() === "新建文件夹"); return Boolean(btn) && !btn.disabled; })()'
    ), { timeoutMs: 20000 });
    const opened = String(await click('新建文件夹'));
    assert(opened.startsWith('CLICKED'), '找不到「新建文件夹」按钮：' + opened);
    await waitFor('新建文件夹表单出现', async () => window.webContents.executeJavaScript(
      'Boolean(document.querySelector(\'input[placeholder="输入文件夹名称"]\'))'
    ), { timeoutMs: 10000 });

    const filled = String(await window.webContents.executeJavaScript(FILL_FOLDER_NAME));
    assert(filled === 'FILLED', '填充文件夹名失败：' + filled);
    await waitFor('「创建」按钮可用', async () => window.webContents.executeJavaScript(
      '(() => { const btn = Array.from(document.querySelectorAll("button")).find((el) => String(el.innerText||"").trim() === "创建"); return Boolean(btn) && !btn.disabled; })()'
    ), { timeoutMs: 10000 });

    const created = String(await click('创建'));
    assert(created.startsWith('CLICKED'), '找不到「创建」按钮：' + created);
    await waitFor('文件夹出现在列表', async () => (await pageText()).includes(FOLDER_NAME), { timeoutMs: 20000 });
    console.log(`[knowledge-base-ui] 新建文件夹闭环通过（${FOLDER_NAME} 已出现在列表）`);

    assert(rendererErrors.length === 0, '渲染器报错：' + rendererErrors.join(' | '));
    console.log('[knowledge-base-ui] all checks passed');
    app.exit(0);
  } catch (error) {
    console.error('[knowledge-base-ui] failed');
    console.error(error?.stack || error?.message || String(error));
    try {
      const dumpPath = path.join(tempDir, 'page-text.txt');
      const text = await window.webContents.executeJavaScript(PAGE_TEXT).catch(() => '');
      fs.writeFileSync(dumpPath, String(text), 'utf8');
      console.error(`[knowledge-base-ui] 页面文本已保存到 ${dumpPath}`);
    } catch { /* 诊断失败不影响退出码 */ }
    app.exit(1);
  } finally {
    try { await services?.closeServices?.(); } catch { /* ignore */ }
  }
}

app.whenReady().then(run, (error) => {
  console.error('[knowledge-base-ui] app failed to become ready');
  console.error(error?.stack || error?.message || String(error));
  app.exit(1);
});
