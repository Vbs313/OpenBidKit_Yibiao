/*
 * 设置页无头 UI 冒烟：真实 preload + 真实 IPC + 真实 SQLite + **已构建的 dist 渲染产物**。
 *
 * 为什么不加载 dev server：加载 dist 让这条冒烟不依赖 `npm run dev`，可以直接进 CI/收尾流程。
 * 前提：先跑 `npm run build`（脚本会检查 dist/index.html 是否存在）。
 *
 * 覆盖：设置页被拆成 6 个分页组件后，6 个分页是否都能正常挂载、切换时只渲染一个分页。
 *
 * 用法：npm run smoke:settings-ui
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { registerIpcHandlers } = require('../electron/ipc/index.cjs');

const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.html');
const TABS = ['通用', '文本模型', '生图模型', '组件设置', '智能体配置', '关于'];

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

// 按可见文本找可点击元素并点击（优先 button，其次任意含该文本的可点击祖先）。
// 按「第一行文本」精确匹配可点击元素：侧边栏条目是多行（标题 + 副标题），
// 用 includes 会先命中「模版设置」这种含相同字的条目。
const CLICK_BY_LABEL = `(() => {
  const wanted = __TEXT__;
  const firstLine = (el) => String(el.innerText || el.textContent || "").split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean)[0] || "";
  const nodes = Array.from(document.querySelectorAll("button, [role=tab], a, [role=button]"));
  const hit = nodes.find((el) => firstLine(el) === wanted);
  if (!hit) return "MISSING:" + wanted;
  hit.click();
  return "CLICKED:" + wanted;
})()`;

const TAB_SECTION_COUNT = "document.querySelectorAll('.settings-page-section').length";
const TAB_SECTION_CHARS = "Array.from(document.querySelectorAll('.settings-page-section')).map((el) => String(el.textContent || '').length)";
const ACTIVE_TAB_TEXT = "(() => { const el = document.querySelector('.settings-tab-shell .is-active'); return el ? String(el.textContent || '').trim() : ''; })()";

// 「弄脏 -> 保存」闭环用的探针：切一次「GPU 硬件加速」开关，再读工具条保存按钮的可用态。
// 说明：自动更新渠道已被移除（定制版不做自动更新），所以这里换成一个仍然存在且可持久化的开关。
const TOGGLE_GPU_SWITCH = `(() => {
  const row = Array.from(document.querySelectorAll("label")).find((el) => String(el.textContent || "").includes("GPU 硬件加速"));
  if (!row) return "MISSING";
  const sw = row.querySelector('[role="switch"]');
  if (!sw) return "NO_SWITCH";
  const before = String(sw.getAttribute("aria-checked"));
  sw.click();
  return before;
})()`;
const SAVE_BUTTON_ENABLED = `(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((el) => String(el.innerText || "").trim() === "保存");
  return btn ? !btn.disabled : null;
})()`;
const SAVE_LABEL = `(() => {
  const el = Array.from(document.querySelectorAll("button")).find((node) => ["未保存", "已保存"].includes(String(node.innerText || "").trim()));
  return el ? String(el.innerText || "").trim() : "";
})()`;
const CLICK_SAVE_DIRECT = `(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((el) => String(el.innerText || "").trim() === "保存");
  if (!btn) return "MISSING";
  btn.click();
  return "CLICKED";
})()`;

async function run() {
  if (!fs.existsSync(DIST_INDEX)) {
    console.error('[settings-ui] 缺少构建产物，请先运行 npm run build');
    app.exit(1);
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-settings-ui-'));
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
  try {
    services = registerIpcHandlers({
      app,
      mainWindow: window,
    });

    await window.loadFile(DIST_INDEX);
    await waitFor('本地数据库就绪', async () => {
      const status = await window.webContents.executeJavaScript('window.yibiao?.database?.getStatus?.()');
      return status?.ready === true;
    }, { timeoutMs: 90000 });

    const entered = String(await click('设置'));
    assert(entered.startsWith('CLICKED'), '侧边栏缺少「设置」入口：' + entered);
    await waitFor('设置页挂载', async () => (await window.webContents.executeJavaScript(TAB_SECTION_COUNT)) === 1, { timeoutMs: 15000 });
    console.log('[settings-ui] 设置页已挂载');

    for (const label of TABS) {
      const result = String(await click(label));
      assert(result.startsWith('CLICKED'), `找不到分页：${label}（${result}）`);
      await waitFor(`分页「${label}」渲染`, async () => {
        const count = await window.webContents.executeJavaScript(TAB_SECTION_COUNT);
        if (count !== 1) return false;
        const active = String(await window.webContents.executeJavaScript(ACTIVE_TAB_TEXT));
        if (!active.includes(label)) return false;
        const chars = await window.webContents.executeJavaScript(TAB_SECTION_CHARS);
        return Array.isArray(chars) && chars[0] > 30;
      }, { timeoutMs: 10000 });
      console.log(`[settings-ui] 分页「${label}」渲染正常`);
    }

    console.log(`[settings-ui] ${TABS.length} 个分页全部可切换且各自独立渲染`);
    // 保存链路：草稿 / 脏检查 / 保存已搬进 useSettingsConfig，所以这里真的改一次配置再保存。
    const back = String(await click('通用'));
    assert(back.startsWith('CLICKED'), '切回「通用」分页失败：' + back);
    const beforeSwitch = String(await window.webContents.executeJavaScript(TOGGLE_GPU_SWITCH));
    assert(beforeSwitch === 'true' || beforeSwitch === 'false', '找不到可切换的 GPU 硬件加速开关：' + beforeSwitch);
    const expectedGpuEnabled = beforeSwitch !== 'true';
    await waitFor('保存按钮变为可用（脏检查生效）', async () => {
      const enabled = await window.webContents.executeJavaScript(SAVE_BUTTON_ENABLED);
      const label = await window.webContents.executeJavaScript(SAVE_LABEL);
      return enabled === true && label === '未保存';
    }, { timeoutMs: 10000 });
    const saving = String(await window.webContents.executeJavaScript(CLICK_SAVE_DIRECT));
    assert(saving.startsWith('CLICKED'), '找不到「保存」按钮：' + saving);
    await waitFor('保存完成（脏检查复位）', async () => {
      const enabled = await window.webContents.executeJavaScript(SAVE_BUTTON_ENABLED);
      const label = await window.webContents.executeJavaScript(SAVE_LABEL);
      return enabled === false && label === '已保存';
    }, { timeoutMs: 15000 });
    const persisted = await window.webContents.executeJavaScript('window.yibiao?.config?.load()');
    assert(persisted && persisted.gpu_hardware_acceleration_enabled === expectedGpuEnabled,
      `保存未落库：期望 gpu_hardware_acceleration_enabled=${expectedGpuEnabled}，实际 ${persisted && persisted.gpu_hardware_acceleration_enabled}`);
    assert(!Object.prototype.hasOwnProperty.call(persisted, 'update_channel'),
      '自动更新渠道已移除，配置里不应再出现 update_channel：' + JSON.stringify(persisted?.update_channel));
    console.log(`[settings-ui] 配置保存闭环通过（GPU 硬件加速 ${beforeSwitch} -> ${expectedGpuEnabled} 已持久化，脏状态已复位；update_channel 已不存在）`);

    console.log('[settings-ui] all checks passed');
    app.exit(0);
  } catch (error) {
    console.error('[settings-ui] failed');
    console.error(error?.stack || error?.message || String(error));
    try {
      const dumpPath = path.join(tempDir, 'page-text.txt');
      const text = await window.webContents.executeJavaScript('document.body.innerText').catch(() => '');
      fs.writeFileSync(dumpPath, String(text), 'utf8');
      console.error(`[settings-ui] 页面文本已保存到 ${dumpPath}`);
    } catch { /* 诊断失败不影响退出码 */ }
    app.exit(1);
  } finally {
    try { await services?.closeServices?.(); } catch { /* ignore */ }
  }
}

app.whenReady().then(run, (error) => {
  console.error('[settings-ui] app failed to become ready');
  console.error(error?.stack || error?.message || String(error));
  app.exit(1);
});
