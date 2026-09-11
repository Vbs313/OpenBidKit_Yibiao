/*
 * 标书生成（technical-plan）无头 UI 冒烟：真实 preload + 真实 IPC + 真实 SQLite + 已构建的 dist。
 *
 * 为什么需要：TechnicalPlanHome / OutlineEditPage / ContentEditPage 合计 4200+ 行，
 * 其中 OutlineEditPage 有过 5 次自动化提取全部回退的记录 —— 重构前必须先有能发现渲染回归的网。
 *
 * 覆盖：用真实 IPC 预置一份大纲，再把 5 个子页面（STEP 01~05）逐个真实渲染一遍；
 *       全程监听渲染器错误，并用探针自检「监听器真的能收到」。
 *
 * 用法：npm run smoke:technical-plan-ui   （前置：npm run build）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { registerIpcHandlers } = require('../electron/ipc/index.cjs');

const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.html');
const RENDERER_ERROR_PROBE = 'console.error("__technical-plan-ui-probe__")';

const SEEDED_OUTLINE_TITLE = '冒烟章节 A';
const STEPS = [
  { step: 'document-analysis', markers: ['STEP 01', '选择标书', '招标文件'] },
  { step: 'bid-analysis', markers: ['STEP 02', '解析结果'] },
  { step: 'outline-generation', markers: ['STEP 03', SEEDED_OUTLINE_TITLE] },
  { step: 'global-facts', markers: ['STEP 04', '事实内容'] },
  { step: 'content-edit', markers: ['STEP 05', '正文内容'] },
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

// 按「第一行文本」精确匹配可点击元素：侧边栏条目是多行（标题 + 副标题）。
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

const SEED_OUTLINE = {
  project_name: '冒烟项目',
  outline: [
    {
      id: 'smoke-node-1',
      title: '冒烟章节 A',
      description: '冒烟用章节',
      attr: '技术',
      content_mode: 'ai-generate',
      children: [
        { id: 'smoke-node-1-1', title: '冒烟小节 A1', description: '冒烟用小节', attr: '技术', content_mode: 'ai-generate' },
      ],
    },
    {
      id: 'smoke-node-2',
      title: '冒烟章节 B',
      description: '冒烟用章节',
      attr: '技术',
      content_mode: 'ai-generate',
    },
  ],
};

async function run() {
  if (!fs.existsSync(DIST_INDEX)) {
    console.error('[technical-plan-ui] 缺少构建产物，请先运行 npm run build');
    app.exit(1);
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-technical-plan-ui-'));
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
  // 本冒烟会对同一个 renderer 反复 reload（每步一次），默认 10 个 listener 上限会刷警告。
  window.webContents.setMaxListeners(30);
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

  const waitDatabaseReady = () => waitFor('本地数据库就绪', async () => {
    const status = await window.webContents.executeJavaScript('window.yibiao?.database?.getStatus?.()');
    return status?.ready === true;
  }, { timeoutMs: 90000 });

  const openTechnicalPlan = async () => {
    const entry = String(await click('标书生成'));
    assert(entry.startsWith('CLICKED'), '侧边栏缺少「标书生成」入口：' + entry);
    // 侧边栏进入的是工作流选择页，再点一次「生成技术方案」才进工作台。
    const workflow = String(await click('生成技术方案'));
    assert(workflow.startsWith('CLICKED'), '缺少「生成技术方案」入口：' + workflow);
  };

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
    await waitDatabaseReady();
    await openTechnicalPlan();
    await waitFor('标书生成页挂载', async () => (await pageText()).includes('STEP'), { timeoutMs: 20000 });

    // 错误捕获自检：先制造一条 error，确认监听器真能收到，再清掉——否则「0 个错误」不能算绿。
    await window.webContents.executeJavaScript(RENDERER_ERROR_PROBE);
    await waitFor('渲染器错误捕获自检', async () => rendererErrors.some((line) => line.includes('__technical-plan-ui-probe__')));
    rendererErrors.length = 0;

    // 用真实 IPC 预置一份大纲：否则 STEP 03 之后的分支只能看到空态，等于没进网。
    await window.webContents.executeJavaScript(
      `window.yibiao.technicalPlan.saveOutline(${JSON.stringify(SEED_OUTLINE)})`
    );
    console.log('[technical-plan-ui] 已通过真实 IPC 预置大纲');

    for (const { step, markers } of STEPS) {
      await window.webContents.executeJavaScript(`window.yibiao.technicalPlan.updateStep(${JSON.stringify(step)})`);
      await window.webContents.reload();
      await waitDatabaseReady();
      await openTechnicalPlan();
      await waitFor(`步骤「${step}」渲染`, async () => {
        const text = String(await pageText());
        return markers.every((marker) => text.includes(marker));
      }, { timeoutMs: 30000 });
      console.log(`[technical-plan-ui] ${step} 渲染正常（${markers.length} 个标记）`);
    }

    assert(rendererErrors.length === 0, '渲染器报错：' + rendererErrors.join(' | '));
    console.log(`[technical-plan-ui] ${STEPS.length} 个子页面全部真实渲染，且无渲染器错误`);
    console.log('[technical-plan-ui] all checks passed');
    app.exit(0);
  } catch (error) {
    console.error('[technical-plan-ui] failed');
    console.error(error?.stack || error?.message || String(error));
    try {
      const dumpPath = path.join(tempDir, 'page-text.txt');
      const text = await window.webContents.executeJavaScript(PAGE_TEXT).catch(() => '');
      fs.writeFileSync(dumpPath, String(text), 'utf8');
      console.error(`[technical-plan-ui] 页面文本已保存到 ${dumpPath}`);
    } catch { /* 诊断失败不影响退出码 */ }
    app.exit(1);
  } finally {
    try { await services?.closeServices?.(); } catch { /* ignore */ }
  }
}

app.whenReady().then(run, (error) => {
  console.error('[technical-plan-ui] app failed to become ready');
  console.error(error?.stack || error?.message || String(error));
  app.exit(1);
});
