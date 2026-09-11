/*
 * 可研报告（feasibility-report）无头 UI 冒烟：真实 preload + 真实 IPC + 真实 SQLite + 已构建的 dist。
 *
 * 为什么需要：可研入口藏在「标书生成 → 可行性研究报告」二级入口里，pages-mount 只覆盖 8 个
 * 一级侧边栏入口，所以这个 848 行的页面此前只有构建期类型检查、没有页面级运行时覆盖；
 * 导出簇（useFeasibilityExportWord）更是零覆盖。
 *
 * 覆盖：进入可研工作台 → 六个步骤逐个真实渲染 → 真实 IPC 预置目录 →
 *       点「导出 Word」打开模板弹窗（真实 templates.list）→ 取消关闭。
 *
 * 用法：npm run smoke:feasibility-ui   （前置：npm run build）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { registerIpcHandlers } = require('../electron/ipc/index.cjs');

const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.html');
const RENDERER_ERROR_PROBE = 'console.error("__feasibility-ui-probe__")';

const SEEDED_OUTLINE_TITLE = '冒烟可研章节 A';
const STEPS = [
  { step: 'materials', markers: ['STEP 01', '项目资料'] },
  { step: 'sources', markers: ['STEP 02', '项目资料文件'] },
  { step: 'analysis', markers: ['STEP 03', '资料分析'] },
  { step: 'outline', markers: ['STEP 04', '报告目录'] },
  { step: 'parameters', markers: ['STEP 05', '关键参数'] },
  { step: 'content', markers: ['STEP 06', '正文生成'] },
];

const SEED_OUTLINE = {
  project_name: '冒烟可研项目',
  outline: [
    {
      id: 'smoke-fs-1',
      title: SEEDED_OUTLINE_TITLE,
      description: '冒烟用章节',
      attr: '技术',
      content_mode: 'ai-generate',
      children: [
        { id: 'smoke-fs-1-1', title: '冒烟可研小节 A1', description: '冒烟用小节', attr: '技术', content_mode: 'ai-generate' },
      ],
    },
  ],
};

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

// 按「第一行文本」精确匹配可点击元素：侧边栏与工作流选择页都是「标题 + 副标题」多行结构。
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
    console.error('[feasibility-ui] 缺少构建产物，请先运行 npm run build');
    app.exit(1);
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-feasibility-ui-'));
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

  const openFeasibilityReport = async () => {
    const entry = String(await click('标书生成'));
    assert(entry.startsWith('CLICKED'), '侧边栏缺少「标书生成」入口：' + entry);
    // 侧边栏进入的是工作流选择页，再点一次「可行性研究报告」才进工作台。
    const workflow = String(await click('可行性研究报告'));
    assert(workflow.startsWith('CLICKED'), '缺少「可行性研究报告」入口：' + workflow);
  };

  // 导出簇：真实打开模板弹窗（会走 templates.list），再取消关闭。
  const exerciseExportDialog = async () => {
    const opened = String(await click('导出 Word'));
    assert(opened.startsWith('CLICKED'), '找不到「导出 Word」按钮：' + opened);
    await waitFor('导出模板弹窗渲染', async () => {
      const text = String(await pageText());
      return ['选择导出模板', '可研专用封面', '编制说明', '基本情况附表'].every((marker) => text.includes(marker));
    }, { timeoutMs: 20000 });
    console.log('[feasibility-ui] 导出模板弹窗：打开且可研专用选项渲染正常');

    const closed = String(await click('取消'));
    assert(closed.startsWith('CLICKED'), '找不到模板弹窗的「取消」按钮：' + closed);
    await waitFor('导出模板弹窗关闭', async () => !(await pageText()).includes('选择导出模板'), { timeoutMs: 15000 });
    console.log('[feasibility-ui] 导出模板弹窗：取消后关闭');
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
    await openFeasibilityReport();
    await waitFor('可研工作台挂载', async () => (await pageText()).includes('STEP 01'), { timeoutMs: 20000 });

    // 错误捕获自检：先制造一条 error，确认监听器真能收到，再清掉——否则「0 个错误」不能算绿。
    await window.webContents.executeJavaScript(RENDERER_ERROR_PROBE);
    await waitFor('渲染器错误捕获自检', async () => rendererErrors.some((line) => line.includes('__feasibility-ui-probe__')));
    rendererErrors.length = 0;

    // 用真实 IPC 预置一份目录：否则最后一步「导出 Word」按钮是禁用的，导出簇进不了网。
    await window.webContents.executeJavaScript(
      `window.yibiao.feasibilityReport.saveOutline({ outlineData: ${JSON.stringify(SEED_OUTLINE)}, reason: 'replace' })`
    );
    console.log('[feasibility-ui] 已通过真实 IPC 预置可研目录');

    for (const { step, markers } of STEPS) {
      await window.webContents.executeJavaScript(`window.yibiao.feasibilityReport.updateStep(${JSON.stringify(step)})`);
      await window.webContents.reload();
      await waitDatabaseReady();
      await openFeasibilityReport();
      await waitFor(`步骤「${step}」渲染`, async () => {
        const text = String(await pageText());
        return markers.every((marker) => text.includes(marker));
      }, { timeoutMs: 30000 });
      console.log(`[feasibility-ui] ${step} 渲染正常（${markers.length} 个标记）`);
    }

    await exerciseExportDialog();

    assert(rendererErrors.length === 0, '渲染器报错：' + rendererErrors.join(' | '));
    console.log(`[feasibility-ui] ${STEPS.length} 个步骤全部真实渲染，导出弹窗可开可关，且无渲染器错误`);
    console.log('[feasibility-ui] all checks passed');
    app.exit(0);
  } catch (error) {
    console.error('[feasibility-ui] failed');
    console.error(error?.stack || error?.message || String(error));
    try {
      const dumpPath = path.join(tempDir, 'page-text.txt');
      const text = await window.webContents.executeJavaScript(PAGE_TEXT).catch(() => '');
      fs.writeFileSync(dumpPath, String(text), 'utf8');
      console.error(`[feasibility-ui] 页面文本已保存到 ${dumpPath}`);
    } catch { /* 诊断失败不影响退出码 */ }
    app.exit(1);
  } finally {
    try { await services?.closeServices?.(); } catch { /* ignore */ }
  }
}

app.whenReady().then(run, (error) => {
  console.error('[feasibility-ui] app failed to become ready');
  console.error(error?.stack || error?.message || String(error));
  app.exit(1);
});
