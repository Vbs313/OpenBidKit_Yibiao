/*
 * 合规检查模块的 Electron 侧集成冒烟：真实 SQLite migration、真实 Sidecar 子进程、真实 Store 读写。
 * 需要 Electron ABI 运行（better-sqlite3 按 Electron 重建），因此不能用普通 node 执行。
 * 用法：npm run smoke:compliance-checker
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { createSqliteDatabase } = require('../electron/services/sqliteDatabase.cjs');
const { createComplianceCheckStore } = require('../electron/services/compliance/complianceCheckStore.cjs');
const { createComplianceCheckerService } = require('../electron/services/compliance/complianceCheckerService.cjs');
const registry = require('../electron/services/compliance/complianceCheckRegistry.cjs');

function exitWithCode(code) {
  if (app?.isReady?.()) {
    app.exit(code);
    return;
  }
  process.exit(code);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeFixture(dir, name, lines) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  return target;
}

async function runSmoke() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-compliance-smoke-'));
  const service = createComplianceCheckerService({ app, configStore: { load: () => ({}) } });
  let database = null;
  try {
    const userData = path.join(tempDir, 'userData');
    fs.mkdirSync(userData, { recursive: true });
    app.setPath('userData', userData);

    database = createSqliteDatabase(app, {});
    const schemaVersion = Number(database.db.pragma('user_version', { simple: true }));
    assert(schemaVersion >= 24, `数据库未升级到 v24，当前 v${schemaVersion}`);
    for (const table of ['compliance_check_jobs', 'compliance_check_results', 'compliance_check_findings']) {
      const row = database.db.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE type = ? AND name = ?').get('table', table);
      assert(row.n === 1, `缺少表 ${table}`);
    }
    console.log(`[compliance-smoke] schema=v${schemaVersion}，合规检查三张表就绪`);

    const store = createComplianceCheckStore({ db: database.db });
    const capabilities = await service.listChecks();
    const status = service.getStatus();
    const expectedKind = process.env.YIBIAO_COMPLIANCE_CHECKER_DIR ? 'python' : 'bundled';
    assert(status.spawn_kind === expectedKind, `Sidecar 启动方式应为 ${expectedKind}，实际 ${status.spawn_kind}`);
    console.log(`[compliance-smoke] spawn_kind=${status.spawn_kind} command=${status.spawn_command}`);
    assert(capabilities.some((item) => item.check_id === 'validity'), 'Sidecar 未上报 validity 检查项');
    assert(capabilities.some((item) => item.check_id === 'deposit'), 'Sidecar 未上报 deposit 检查项');
    // 上报的 requires_model 必须与 B 侧注册表一致，否则页面会选错是否需要 model_config。
    for (const item of capabilities) {
      const definition = registry.complianceCheckRegistry[item.check_id];
      assert(definition, `Sidecar 上报了未登记检查项: ${item.check_id}`);
      assert(item.requires_model === definition.requiresModel,
        `检查项 ${item.check_id} 的 requires_model 应为 ${definition.requiresModel}，实际 ${item.requires_model}`);
    }
    assert(capabilities.some((item) => item.requires_model === true), '注册表应包含需要模型的检查项');

    const bidPath = writeFixture(tempDir, '投标文件.md', [
      '# 投标报价表',
      '| 名称 | 单价 | 数量 | 合计 |',
      '| --- | ---: | ---: | ---: |',
      '| 设备A | 100.00 | 2 | 200.00 |',
      '',
      '投标总价：200.00元',
      '投标报价（大写）：贰佰元整（200.00元）',
      '投标有效期：自投标截止之日起 90 日历天',
    ]);
    const tenderPath = writeFixture(tempDir, '招标文件.md', [
      '# 招标文件',
      '投标有效期自投标截止之日起计算，不少于 60 日历天。',
      '投标截止时间为 2026年3月15日。',
    ]);

    // 确定性检查：报价算术 + 投标有效期，同一次任务返回两项结果。
    const pricingRun = await service.runChecks({
      jobId: 'smoke-pricing',
      input: {
        bid_file: bidPath,
        tender_file: tenderPath,
        project_metadata: { total_amount: '200.00', bid_amount: '200.00', bid_amount_cn: '贰佰元整' },
      },
      checks: ['pricing_arithmetic', 'validity'],
      timeoutMs: 20000,
    });
    assert(pricingRun.status === 'success', `Sidecar 执行失败：${JSON.stringify(pricingRun.error)}`);
    assert(pricingRun.results.length === 2, `期望 2 项结果，实际 ${pricingRun.results.length}`);
    const byId = Object.fromEntries(pricingRun.results.map((item) => [item.check_id, item]));
    assert(byId.pricing_arithmetic.status === 'pass', `报价算术应为 pass：${JSON.stringify(byId.pricing_arithmetic.findings)}`);
    assert(byId.validity.status === 'pass', `投标有效期应为 pass：${JSON.stringify(byId.validity.findings)}`);
    console.log('[compliance-smoke] Sidecar 两项确定性检查均 pass');

    // Store 层：createJob → saveReport → 重启回放，全程真实 SQLite。
    const pollutedMetadata = {
      total_amount: '200.00',
      api_key: 'sk-leak-check',
      nested: { apiKey: 'sk-deep-leak', keep: 1 },
    };
    store.createJob({
      jobId: 'smoke-job',
      input: { bid_file: bidPath, tender_file: tenderPath, project_metadata: pollutedMetadata, checks: ['pricing_arithmetic', 'validity'] },
      task: {
        task_id: 'smoke-job',
        type: 'compliance-check',
        status: 'running',
        progress: 0,
        logs: [],
        stats: { job_id: 'smoke-job', checks: ['pricing_arithmetic', 'validity'] },
      },
    });
    const savedJob = database.db.prepare('SELECT input_json FROM compliance_check_jobs WHERE job_id = ?').get('smoke-job');
    assert(savedJob, 'createJob 未写入 compliance_check_jobs');
    assert(!savedJob.input_json.includes('sk-leak-check') && !savedJob.input_json.includes('sk-deep-leak'),
      '凭据字段未被剔除，仍留在 input_json');

    store.saveReport('smoke-job', pricingRun);
    const report = store.getReport('smoke-job');
    assert(report?.results?.length === 2, `getReport 应返回 2 项，实际 ${report?.results?.length}`);
    const reopened = createComplianceCheckStore({ db: database.db });
    assert(reopened.loadComplianceCheck().lastReport?.results?.length === 2, '重启回放读不到最近报告');
    const findingCount = database.db.prepare('SELECT COUNT(*) AS n FROM compliance_check_findings').get().n;
    assert(Number.isFinite(findingCount), 'findings 表不可读');
    console.log(`[compliance-smoke] SQLite 持久化与重启回放通过，findings=${findingCount}`);

    // 协议层：model_config 只允许路由信息，凭据字段必须在写出 stdin 前被拒绝。
    const rejected = await service.runChecks({
      jobId: 'smoke-reject',
      input: { bid_file: bidPath, project_metadata: {} },
      checks: ['validity'],
      modelConfig: { base_url: 'http://127.0.0.1:4891/v1', api_key: 'sk-should-never-travel' },
      timeoutMs: 20000,
    }).catch((error) => error);
    assert(rejected instanceof Error, '含 api_key 的 model_config 应被拒绝');
    assert(rejected.code === 'COMPLIANCE_MODEL_CONFIG_INVALID', `拒绝码不符合预期：${rejected.code}`);
    assert(!String(rejected.message).includes('sk-should-never-travel'), '密钥不应出现在错误信息中');

    const dbBytes = fs.readFileSync(path.join(userData, 'workspace', 'yibiao.sqlite'));
    assert(!dbBytes.includes(Buffer.from('sk-leak-check', 'utf8')), 'SQLite 文件中检测到凭据');
    console.log('[compliance-smoke] model_config 凭据拦截与 SQLite 无密钥校验通过');
    console.log('[compliance-smoke] all checks passed');
    exitWithCode(0);
  } catch (error) {
    console.error('[compliance-smoke] failed');
    console.error(error?.stack || error?.message || String(error));
    exitWithCode(1);
  } finally {
    await service.close().catch(() => {});
    try { database?.db?.close?.(); } catch { /* ignore */ }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

app.whenReady().then(runSmoke, (error) => {
  console.error('[compliance-smoke] app failed to become ready');
  console.error(error?.stack || error?.message || String(error));
  exitWithCode(1);
});
