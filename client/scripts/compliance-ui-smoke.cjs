/*
 * 合规检查页面的无头端到端冒烟：真实 preload + 真实 IPC + 真实 SQLite + 真实 Sidecar + 真实 React 页面。
 * 交互全部走用户路径：点击“选择”按钮打开文件对话框（这里替换 dialog 返回固定文件），再点“开始检查”。
 * 前提：先运行 npm run dev（Vite 监听 127.0.0.1:5173），本脚本另开一个离屏窗口驱动页面。
 * 用法：npm run smoke:compliance-ui
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const { registerIpcHandlers } = require('../electron/ipc/index.cjs');

const DEV_URL = process.env.YIBIAO_DEV_URL || 'http://127.0.0.1:5173/';
const CHECK_COUNT = 3;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(label, fn, { timeoutMs = 60000, intervalMs = 200 } = {}) {
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

function writeFixtures(dir) {
  const bid = path.join(dir, '投标文件.md');
  const tender = path.join(dir, '招标文件.md');
  fs.writeFileSync(bid, [
    '# 投标报价表',
    '| 名称 | 单价 | 数量 | 合计 |',
    '| --- | ---: | ---: | ---: |',
    '| 设备A | 100.00 | 2 | 200.00 |',
    '',
    '投标总价：200.00元',
    '投标报价（大写）：贰佰元整（200.00元）',
    '投标有效期：自投标截止之日起 90 日历天',
    '我方已缴纳投标保证金 20,000.00元，缴纳方式为银行转账。',
  ].join('\n'), 'utf8');
  fs.writeFileSync(tender, [
    '# 招标文件',
    '投标有效期自投标截止之日起计算，不少于 60 日历天。',
    '投标截止时间为 2026年3月15日。',
    '投标保证金：人民币 20,000.00元，须于 2026年3月10日前 以银行转账方式缴纳。',
  ].join('\n'), 'utf8');
  return { bid, tender };
}

function writeBadFixture(dir) {
  const bid = path.join(dir, '错误报价文件.md');
  fs.writeFileSync(bid, [
    '# 投标报价表',
    '| 名称 | 单价 | 数量 | 合计 |',
    '| --- | ---: | ---: | ---: |',
    '| 设备A | 100.00 | 3 | 200.00 |',
    '',
    '投标总价：300.00元',
    '投标报价（大写）：贰佰元整（300.00元）',
  ].join('\n'), 'utf8');
  return bid;
}

const CLICK_ROW_BUTTON = `(() => {
  const rows = Array.from(document.querySelectorAll('.upload-row'));
  const row = rows[__INDEX__];
  const button = row && row.querySelector('.upload-actions button');
  if (!button) return 'MISSING_ROW:' + __INDEX__;
  button.click();
  return 'CLICKED_ROW:' + __INDEX__;
})()`;

const CLICK_BY_LABEL = `(() => {
  const wanted = __TEXT__;
  const nodes = Array.from(document.querySelectorAll('button,[role="button"],a'));
  const target = nodes.find((node) => {
    const label = String(node.getAttribute('aria-label') || node.textContent || '').replace(/\\s+/g, '');
    return label.includes(wanted.replace(/\\s+/g, ''));
  });
  if (!target) return 'MISSING:' + wanted;
  target.click();
  return 'CLICKED:' + wanted;
})()`;

const CLICK_CHECKBOX = `(() => {
  const wanted = __TEXT__;
  const items = Array.from(document.querySelectorAll('.compliance-check-item'));
  const row = items.find((item) => String(item.textContent || '').includes(wanted));
  const box = row && row.querySelector('input[type=checkbox]');
  if (!box) return 'MISSING_CHECKBOX:' + wanted;
  box.click();
  return 'CLICKED_CHECKBOX:' + wanted;
})()`;

const PAGE_TEXT = 'document.body.innerText';

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-compliance-ui-'));
  const userData = path.join(tempDir, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);

  const { bid, tender } = writeFixtures(tempDir);
  const badBid = writeBadFixture(tempDir);
  // 替换原生文件对话框：页面点击“选择”时按队列返回固定文件，其余流程保持真实。
  const dialogQueue = [tender, bid, badBid];
  const realShowOpenDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => {
    const filePath = dialogQueue.shift();
    if (!filePath) return { canceled: true, filePaths: [] };
    return { canceled: false, filePaths: [filePath] };
  };

  let services = null;
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

  const click = (text) => window.webContents.executeJavaScript(CLICK_BY_LABEL.replace('__TEXT__', JSON.stringify(text)));
  const clickRow = (index) => window.webContents.executeJavaScript(CLICK_ROW_BUTTON.replace(/__INDEX__/g, String(index)));
  const toggle = (text) => window.webContents.executeJavaScript(CLICK_CHECKBOX.replace(/__TEXT__/g, JSON.stringify(text)));
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

    await window.loadURL(DEV_URL);
    const waitForDatabase = () => waitFor('本地数据库就绪', async () => {
      const status = await window.webContents.executeJavaScript('window.yibiao?.database?.getStatus?.()');
      return status?.ready === true;
    }, { timeoutMs: 90000 });
    const gotoCompliancePage = async () => {
      assert(String(await click('标书检查')).startsWith('CLICKED'), '侧边栏缺少“标书检查”入口');
      assert(String(await click('合规检查')).startsWith('CLICKED'), '标书检查下缺少“合规检查”入口');
      await waitFor('合规检查页面', async () => (await pageText()).includes('选择检查文件'));
    };

    await waitForDatabase();
    await gotoCompliancePage();
    console.log('[compliance-ui] 本地数据库就绪，合规检查页面已挂载');

    let text = await pageText();
    for (const label of ['报价算术核查', '投标有效期核查', '投标保证金核查']) {
      assert(text.includes(label), `页面缺少检查项：${label}`);
    }
    const checkboxCount = await window.webContents.executeJavaScript('document.querySelectorAll(".compliance-check-item input[type=checkbox]").length');
    assert(checkboxCount === CHECK_COUNT, `检查项复选框应为 ${CHECK_COUNT} 个，实际 ${checkboxCount}`);

    assert(String(await toggle('投标保证金核查')).startsWith('CLICKED_CHECKBOX'), '无法取消勾选保证金核查');
    await waitFor('取消勾选生效', async () => (await pageText()).includes(`${CHECK_COUNT - 1} / ${CHECK_COUNT}`), { timeoutMs: 5000 });
    assert(String(await toggle('投标保证金核查')).startsWith('CLICKED_CHECKBOX'), '无法重新勾选保证金核查');
    await waitFor('重新勾选生效', async () => (await pageText()).includes(`${CHECK_COUNT} / ${CHECK_COUNT}`), { timeoutMs: 5000 });
    console.log(`[compliance-ui] 检查项勾选状态可读写，复选框=${checkboxCount}`);

    assert(String(await clickRow(0)).startsWith('CLICKED_ROW'), '招标文件选择按钮不可点');
    await waitFor('招标文件出现在页面', async () => (await pageText()).includes('招标文件.md'), { timeoutMs: 10000 });
    assert(String(await clickRow(1)).startsWith('CLICKED_ROW'), '投标文件选择按钮不可点');
    await waitFor('投标文件出现在页面', async () => (await pageText()).includes('投标文件.md'), { timeoutMs: 10000 });
    console.log('[compliance-ui] 文件选择走原生对话框链路成功');

    assert(String(await click('开始检查')).startsWith('CLICKED'), '页面缺少“开始检查”按钮');
    await waitFor('检查结果', async () => (await pageText()).includes(`共 ${CHECK_COUNT} 项检查`), { timeoutMs: 60000 });
    text = await pageText();
    assert(/问题 0 · 提醒 0/.test(text), `结果汇总不符合预期：${text.slice(Math.max(0, text.indexOf('共 3 项检查')), text.indexOf('共 3 项检查') + 200)}`);
    for (const phrase of ['报价算术校验通过', '投标有效期核查通过', '投标保证金核查通过']) {
      assert(text.includes(phrase), `检查项未全部通过，缺少：${phrase}`);
    }
    console.log('[compliance-ui] 页面发起真实 Sidecar 检查，三项结果均为通过');

    // 失败路径：换成有算术错误的报价文件，页面应渲染问题明细与修改建议。
    assert(String(await clickRow(1)).startsWith('CLICKED_ROW'), '替换投标文件按钮不可点');
    await waitFor('替换后的投标文件出现在页面', async () => (await pageText()).includes('错误报价文件.md'), { timeoutMs: 10000 });
    assert(String(await click('开始检查')).startsWith('CLICKED'), '二次检查按钮不可点');
    await waitFor('问题结果', async () => {
      const current = await pageText();
      return current.includes('共 3 项检查') && /问题 [1-9]/.test(current);
    }, { timeoutMs: 60000 });
    text = await pageText();
    assert(text.includes('分项合计计算错误'), '失败路径未渲染分项算术问题');
    assert(text.includes('大小写金额不一致'), '失败路径未渲染大小写问题');
    assert(text.includes('请按单价 × 数量重新计算该分项合计'), '失败路径缺少修改建议');
    console.log('[compliance-ui] 失败路径问题明细与建议渲染正常');

    const stored = await window.webContents.executeJavaScript('window.yibiao.complianceCheck.loadState().then((state) => ({ report: state.lastReport && state.lastReport.results ? state.lastReport.results.length : 0 }))');
    assert(stored.report === CHECK_COUNT, `Main 状态应保留 ${CHECK_COUNT} 项结果，实际 ${stored.report}`);

    await window.webContents.reload();
    await waitForDatabase();
    await gotoCompliancePage();
    await waitFor('重启后回放检查结果', async () => (await pageText()).includes(`共 ${CHECK_COUNT} 项检查`), { timeoutMs: 60000 });
    console.log('[compliance-ui] 重新加载后页面从 SQLite 回放出了上一次检查结果');

    const dbBytes = fs.readFileSync(path.join(userData, 'workspace', 'yibiao.sqlite'));
    assert(!dbBytes.includes(Buffer.from('sk-', 'utf8')), 'SQLite 中出现疑似 API Key 前缀');

    // 顺带导出这一轮真实性能路径的耗时基线，供后续优化对照。
    const perf = await window.webContents.executeJavaScript('window.yibiao.perf.getSnapshot(24)');
    const keys = perf && Array.isArray(perf.keys) ? perf.keys : [];
    for (const required of ['task.run.compliance-check', 'task.emit', 'task.checkpoint_write']) {
      assert(keys.some((item) => item.key === required), `性能基线缺少 ${required}`);
    }
    console.log('[compliance-ui] 性能基线（ms）:');
    for (const item of keys) {
      console.log(`  ${item.key} count=${item.count} avg=${item.avgMs} p95=${item.p95Ms} max=${Math.round(item.maxMs)} total=${Math.round(item.totalMs)}`);
    }
    console.log('[compliance-ui] all checks passed');
    app.exit(0);
  } catch (error) {
    console.error('[compliance-ui] failed');
    console.error(error?.stack || error?.message || String(error));
    try {
      const dumpPath = path.join(tempDir, 'page-text.txt');
      const text = await window.webContents.executeJavaScript(PAGE_TEXT).catch(() => '');
      fs.writeFileSync(dumpPath, String(text), 'utf8');
      console.error(`[compliance-ui] 页面文本已保存到 ${dumpPath}`);
    } catch {
      // 诊断落盘失败不影响退出码。
    }
    app.exit(1);
  } finally {
    dialog.showOpenDialog = realShowOpenDialog;
    try { await services?.closeServices?.(); } catch { /* ignore */ }
  }
}

app.whenReady().then(run, (error) => {
  console.error('[compliance-ui] app failed to become ready');
  console.error(error?.stack || error?.message || String(error));
  app.exit(1);
});
