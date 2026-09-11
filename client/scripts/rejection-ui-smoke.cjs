/*
 * 废标项检查页无头 UI 冒烟：真实 preload + 真实 IPC + 真实 SQLite + 已构建的 dist。
 *
 * 为什么需要：该页主组件约 1690 行，重构前必须先有「能发现渲染回归」的网——
 * settings 那轮正是这类冒烟抓到了「6 个分页无条件渲染」的回归。
 *
 * 覆盖：进入页面、三步向导挂载、步骤切换只渲染当前步骤。
 *       第二轮起还会用真实 IPC 预置一份工作区，把第 2、3 步也真实渲染出来。
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
const RENDERER_ERROR_PROBE = 'console.error("__rejection-ui-probe__")';
const ACTIVE_STEP_TEXT = `(() => {
  const el = document.querySelector('.rejection-step-tab.is-active, .rejection-check-step.is-active, [role=tab][aria-selected="true"]');
  return el ? String(el.innerText || el.textContent || '').trim() : '';
})()`;

// 预置工作区用的最小文档（真实 IPC 走 SQLite + markdown 落盘，不依赖 docx 解析）。
function seedDocument(role, id, fileName, content) {
  return { id, role, fileName, content, source: 'upload', importedAt: new Date().toISOString() };
}

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

    const group = String(await click('标书检查'));
    assert(group.startsWith('CLICKED'), '侧边栏缺少「标书检查」入口：' + group);
    const entry = String(await click('废标项检查'));
    assert(entry.startsWith('CLICKED'), '标书检查下缺少「废标项检查」入口：' + entry);

    await waitFor('废标项检查页挂载', async () => (await pageText()).includes('选择标书'), { timeoutMs: 20000 });
    console.log('[rejection-ui] 废标项检查页已挂载');

    // 错误捕获自检：先制造一条 error，确认监听器真的能收到，再清掉——否则「0 个错误」不能算绿。
    await window.webContents.executeJavaScript(RENDERER_ERROR_PROBE);
    await waitFor('渲染器错误捕获自检', async () => rendererErrors.some((line) => line.includes('__rejection-ui-probe__')));
    rendererErrors.length = 0;

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

    // 用真实 IPC 预置一份工作区再重载：让第 2、3 步的 JSX 也进网（否则文档区之外的渲染没有覆盖）。
    const tenderDoc = seedDocument('tender', 'smoke-tender-1', '示例招标文件.md', '# 示例招标文件\n\n1. 投标人须具备独立法人资格，并提供营业执照。');
    const bidDoc = seedDocument('bid', 'smoke-bid-1', '示例投标文件.md', '# 示例投标文件\n\n本公司具备独立法人资格。');
    await window.webContents.executeJavaScript(
      `window.yibiao.rejectionCheck.updateState(${JSON.stringify({ tenderDocument: tenderDoc, tenderDocuments: [tenderDoc], bidDocuments: [bidDoc] })})`
    );
    await window.webContents.reload();
    await waitFor('重载后数据库就绪', async () => {
      const status = await window.webContents.executeJavaScript('window.yibiao?.database?.getStatus?.()');
      return status?.ready === true;
    }, { timeoutMs: 90000 });
    const groupAgain = String(await click('标书检查'));
    assert(groupAgain.startsWith('CLICKED'), '重载后侧边栏缺少「标书检查」入口：' + groupAgain);
    const entryAgain = String(await click('废标项检查'));
    assert(entryAgain.startsWith('CLICKED'), '重载后缺少「废标项检查」入口：' + entryAgain);
    await waitFor('重载后恢复工作区文档', async () => {
      const text = String(await pageText());
      return text.includes('示例招标文件.md') && text.includes('示例投标文件.md');
    }, { timeoutMs: 30000 });
    console.log('[rejection-ui] 工作区恢复：招标 / 投标文件都已从 SQLite 回到页面');

    const toItems = String(await click('下一步'));
    assert(toItems.startsWith('CLICKED'), '找不到「下一步」按钮：' + toItems);
    await waitFor('进入「无效与废标项」步骤', async () => (await pageText()).includes('STEP 02'), { timeoutMs: 20000 });
    const itemsText = String(await pageText());
    for (const needle of ['STEP 02', '无效与废标项', '解析结果', '自定义检查项']) {
      assert(itemsText.includes(needle), `第 2 步缺少标记：${needle}`);
    }
    console.log('[rejection-ui] 第 2 步（无效与废标项）渲染正常');

    const toResults = String(await click('下一步'));
    assert(toResults.startsWith('CLICKED'), '第 2 步找不到「下一步」按钮：' + toResults);
    await waitFor('进入「检查结果」步骤', async () => (await pageText()).includes('STEP 03'), { timeoutMs: 20000 });
    const resultsText = String(await pageText());
    for (const needle of ['STEP 03', '废标项检查', '错别字检查', '逻辑谬误检查']) {
      assert(resultsText.includes(needle), `第 3 步缺少标记：${needle}`);
    }
    console.log('[rejection-ui] 第 3 步（检查结果）渲染正常');

    assert(rendererErrors.length === 0, '渲染器报错：' + rendererErrors.join(' | '));
    console.log('[rejection-ui] 三步向导全部真实渲染，且无渲染器错误');
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
