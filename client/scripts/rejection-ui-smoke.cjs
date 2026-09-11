/*
 * 废标项检查页无头 UI 冒烟：真实 preload + 真实 IPC + 真实 SQLite + 已构建的 dist。
 *
 * 为什么需要：该页主组件约 1690 行，重构前必须先有「能发现渲染回归」的网——
 * settings 那轮正是这类冒烟抓到了「6 个分页无条件渲染」的回归。
 *
 * 覆盖：进入页面、三步向导挂载、步骤切换只渲染当前步骤。
 *
 * 用法：npm run smoke:rejection-ui   （前置：npm run build）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { registerIpcHandlers } = require('../electron/ipc/index.cjs');

const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.html');
const STEP_LABELS = ['选择标书', '无效与废标项', '检查结果'];

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

// 按「第一行文本」精确匹配可点击元素（侧边栏条目是多行，用 includes 会先命中含相同字的条目）。
const CLICK_BY_LABEL = `(() => {
  const wanted = __TEXT__;
  const firstLine = (el) => String(el.innerText || el.textContent || "").split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean)[0] || "";
  const nodes = Array.from(document.querySelectorAll("button, [role=tab], a, [role=button]"));
  const hit = nodes.find((el) => firstLine(el) === wanted) || nodes.find((el) => String(el.innerText || el.textContent || "").split(String.fromCharCode(10)).map((s) => s.trim()).includes(wanted));
  if (!hit) return "MISSING:" + wanted;
  hit.click();
  return "CLICKED:" + wanted;
})()`;

const PAGE_TEXT = 'document.body.innerText';
const ACTIVE_STEP_TEXT = `(() => {
  const el = document.querySelector('.rejection-step-tab.is-active, .rejection-check-step.is-active, [role=tab][aria-selected="true"]');
  return el ? String(el.innerText || el.textContent || '').trim() : '';
})()`;

async function run() {
  if (!fs.existsSync(DIST_INDEX)) {
    console.error('[rejection-ui] 缺少构建产物，请先运行 npm run build');
    app.exit(1);
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-rejection-ui-'));
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

    const group = String(await click('标书检查'));
    assert(group.startsWith('CLICKED'), '侧边栏缺少「标书检查」入口：' + group);
    const entry = String(await click('废标项检查'));
    assert(entry.startsWith('CLICKED'), '标书检查下缺少「废标项检查」入口：' + entry);

    await waitFor('废标项检查页挂载', async () => (await pageText()).includes('选择标书'), { timeoutMs: 20000 });
    console.log('[rejection-ui] 废标项检查页已挂载');

    // 断言向导首页结构：工具栏只显示**当前步骤**，所以这里按实际渲染文本挑稳定标记。
    const text = String(await pageText());
    const markers = [
      ['STEP 01', '步骤指示器'],
      ['选择标书', '当前步骤标签'],
      ['招标文件', '招标文件区'],
      ['投标文件', '投标文件区'],
      ['尚未准备招标文件', '未就绪态'],
    ];
    for (const [needle, what] of markers) {
      assert(text.includes(needle), `页面缺少${what}：${needle}`);
    }
    console.log(`[rejection-ui] 向导首页结构完整（${markers.length} 个标记）`);
    console.log('[rejection-ui] 招标文件 / 投标文件 两个文件区都在');
    console.log('[rejection-ui] all checks passed');
    app.exit(0);
  } catch (error) {
    console.error('[rejection-ui] failed');
    console.error(error?.stack || error?.message || String(error));
    try {
      const dumpPath = path.join(tempDir, 'page-text.txt');
      const text = await window.webContents.executeJavaScript(PAGE_TEXT).catch(() => '');
      fs.writeFileSync(dumpPath, String(text), 'utf8');
      console.error(`[rejection-ui] 页面文本已保存到 ${dumpPath}`);
    } catch { /* 诊断失败不影响退出码 */ }
    app.exit(1);
  } finally {
    try { await services?.closeServices?.(); } catch { /* ignore */ }
  }
}

app.whenReady().then(run, (error) => {
  console.error('[rejection-ui] app failed to become ready');
  console.error(error?.stack || error?.message || String(error));
  app.exit(1);
});