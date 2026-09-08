const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createComplianceCheckerService } = require('./complianceCheckerService.cjs');

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-compliance-'));
  const bidFile = path.join(dir, '投标文件.md');
  fs.writeFileSync(bidFile, [
    '# 投标报价表',
    '| 名称 | 单价 | 数量 | 合计 |',
    '| --- | ---: | ---: | ---: |',
    '| 设备A | 100.00 | 2 | 200.00 |',
    '投标总价：200.00元',
    '投标报价（大写）：贰佰元整（200.00元）',
  ].join('\n'), 'utf8');
  return { dir, bidFile };
}

test('compliance checker sidecar ping and pricing arithmetic', async (t) => {
  const fixture = createFixture();
  const service = createComplianceCheckerService({ app: { isPackaged: false }, configStore: { load: () => ({}) } });
  t.after(async () => {
    await service.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  const ping = await service.ping(2000);
  assert.equal(ping.ok, true);

  const response = await service.runChecks({
    jobId: 'test-pricing-arithmetic',
    input: { bid_file: fixture.bidFile, project_metadata: {} },
    checks: ['pricing_arithmetic'],
    timeoutMs: 10000,
  });
  assert.equal(response.status, 'success');
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].check_id, 'pricing_arithmetic');
  assert.equal(response.results[0].status, 'pass');
  assert.equal(response.results[0].metrics.failed, 0);

  const unknown = await service.runChecks({
    jobId: 'test-unknown-check',
    input: { bid_file: fixture.bidFile, project_metadata: {} },
    checks: ['unknown_check'],
    timeoutMs: 10000,
  });
  assert.equal(unknown.results[0].status, 'error');

  const afterFailure = await service.runChecks({
    jobId: 'test-after-failure',
    input: { bid_file: fixture.bidFile, project_metadata: {} },
    checks: ['pricing_arithmetic'],
    timeoutMs: 10000,
  });
  assert.equal(afterFailure.results[0].status, 'pass');

  await service.terminateChild();
  const restartedPing = await service.ping(2000);
  assert.equal(restartedPing.ok, true);

  const capabilities = await service.listChecks();
  assert.ok(capabilities.some((item) => item.check_id === 'validity' && item.requires_model === false));
  assert.ok(capabilities.some((item) => item.check_id === 'deposit' && item.requires_model === false));

  const withModelConfig = await service.runChecks({
    jobId: 'test-model-config',
    input: { bid_file: fixture.bidFile, project_metadata: {} },
    checks: ['validity'],
    modelConfig: { base_url: 'http://127.0.0.1:4891/v1', model: 'deepseek-chat' },
    timeoutMs: 10000,
  });
  assert.equal(withModelConfig.results[0].check_id, 'validity');

  await assert.rejects(
    () => service.runChecks({
      jobId: 'test-credential-rejected',
      input: { bid_file: fixture.bidFile, project_metadata: {} },
      checks: ['validity'],
      modelConfig: { base_url: 'http://127.0.0.1:4891/v1', api_key: 'sk-should-never-travel' },
      timeoutMs: 10000,
    }),
    (error) => {
      assert.equal(error.code, 'COMPLIANCE_MODEL_CONFIG_INVALID');
      assert.ok(!String(error.message).includes('sk-should-never-travel'));
      return true;
    },
  );
});


