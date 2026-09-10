const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./originalCoverage.cjs');

const ALLOWED = ['P001', 'P002'];
const ctx = () => ({ allowedSourceIds: ALLOWED, expectedNodeId: '2.1' });
const item = (over = {}) => ({ source_id: 'P001', node_id: '2.1', status: 'covered', ...over });

test('ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS 固定为 2', () => {
  assert.equal(C.ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS, 2);
});

test('normalizeOriginalCoverageAuditResponse 归一化完整条目', () => {
  const result = C.normalizeOriginalCoverageAuditResponse(
    {
      items: [
        { source_id: 'P001', node_id: '2.1', status: 'covered', missing_points: ['点A', ' ', '点B'], repair_suggestion: '补一句' },
        { sourceId: 'P002', sectionId: '2.1', coverageStatus: 'missing', missingPoint: '要点' },
      ],
    },
    ctx(),
  );
  assert.deepEqual(result, {
    items: [
      { source_id: 'P001', node_id: '2.1', status: 'covered', missing_points: ['点A', '点B'], repair_suggestion: '补一句' },
      { source_id: 'P002', node_id: '2.1', status: 'missing', missing_points: ['要点'], repair_suggestion: '' },
    ],
  });
});

test('normalizeOriginalCoverageAuditResponse 接受 result 包裹与 results/coverage 数组', () => {
  assert.deepEqual(
    C.normalizeOriginalCoverageAuditResponse({ result: { items: [item()] } }, ctx()).items.length,
    1,
  );
  assert.deepEqual(
    C.normalizeOriginalCoverageAuditResponse({ results: [item()] }, ctx()).items.length,
    1,
  );
  assert.deepEqual(
    C.normalizeOriginalCoverageAuditResponse({ coverage: [item()] }, ctx()).items.length,
    1,
  );
  assert.deepEqual(
    C.normalizeOriginalCoverageAuditResponse([item()], ctx()).items.length,
    1,
  );
  assert.deepEqual(C.normalizeOriginalCoverageAuditResponse({}, ctx()), { items: [] });
});

test('normalizeOriginalCoverageAuditResponse 认得中文覆盖状态别名', () => {
  const cases = [['已覆盖', 'covered'], ['部分保留', 'partial'], ['未覆盖', 'missing'], ['矛盾', 'conflict']];
  cases.forEach(([raw, expected], index) => {
    const sourceId = 'P00' + (index + 1);
    const result = C.normalizeOriginalCoverageAuditResponse(
      { items: [{ source_id: sourceId, node_id: '2.1', status: raw }] },
      { allowedSourceIds: [sourceId], expectedNodeId: '2.1' },
    );
    assert.equal(result.items[0].status, expected, raw + ' 应归一为 ' + expected);
  });
});

test('normalizeOriginalCoverageAuditResponse 缺 node_id 时回落到当前小节', () => {
  const missing = C.normalizeOriginalCoverageAuditResponse({ items: [{ source_id: 'P001', status: 'covered' }] }, ctx());
  assert.equal(missing.items[0].node_id, '2.1');
  const placeholder = C.normalizeOriginalCoverageAuditResponse({ items: [{ source_id: 'P001', node_id: '当前小节编号', status: 'covered' }] }, ctx());
  assert.equal(placeholder.items[0].node_id, '2.1');
});

test('normalizeOriginalCoverageAuditResponse 汇总格式问题并抛错', () => {
  assert.throws(() => C.normalizeOriginalCoverageAuditResponse({ items: ['x'] }, ctx()), /items\[0\] 必须是对象/);
  assert.throws(() => C.normalizeOriginalCoverageAuditResponse({ items: [{ source_id: 'P999', status: 'covered' }] }, ctx()), /source_id 无效/);
  assert.throws(
    () => C.normalizeOriginalCoverageAuditResponse({ items: [{ source_id: 'P001', status: 'covered' }, { source_id: 'P001', status: 'covered' }] }, ctx()),
    /source_id 重复/,
  );
  assert.throws(() => C.normalizeOriginalCoverageAuditResponse({ items: [{ source_id: 'P001', node_id: '9.9', status: 'covered' }] }, ctx()), /node_id 无效/);
  assert.throws(() => C.normalizeOriginalCoverageAuditResponse({ items: [{ source_id: 'P001', node_id: '2.1', status: '乱写' }] }, ctx()), /status 无效/);
  assert.throws(
    () => C.normalizeOriginalCoverageAuditResponse({ items: [{ source_id: 'P999', status: 'x' }, { source_id: 'P001', status: '乱写' }] }, ctx()),
    /items\[0\]\.source_id 无效：P999；items\[1\]\.status 无效：乱写/,
  );
});

test('validateOriginalCoverageAuditResponse 要求覆盖全部来源段', () => {
  assert.doesNotThrow(() => C.validateOriginalCoverageAuditResponse({ items: [{ source_id: 'P001' }, { source_id: 'P002' }] }, ALLOWED));
  assert.doesNotThrow(() => C.validateOriginalCoverageAuditResponse({ items: [{ source_id: 'P001' }, { source_id: 'P002' }] }, new Set(ALLOWED)));
  assert.throws(() => C.validateOriginalCoverageAuditResponse(null, ALLOWED), /缺少 items 数组/);
  assert.throws(() => C.validateOriginalCoverageAuditResponse({ items: 'x' }, ALLOWED), /缺少 items 数组/);
  assert.throws(() => C.validateOriginalCoverageAuditResponse({ items: [{ source_id: 'P001' }] }, ALLOWED), /缺少 source_id：P002/);
});

test('buildOriginalCoverageRepairMessages 组装六条 user 消息', () => {
  const target = {
    item: { id: '2.1', title: '小节', description: '描述' },
    sources: [{ id: 'P001', content: '原方案内容', title_path: ['一', '二'], chars: 6 }],
  };
  const messages = C.buildOriginalCoverageRepairMessages({
    target,
    coverageItems: [{ source_id: 'P001', node_id: '2.1', status: 'missing', missing_points: ['点1'] }],
    currentContent: '当前正文',
    attempt: 1,
    failures: ['上次失败原因'],
  });
  assert.equal(messages.length, 6);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'user', 'user', 'user', 'user', 'user']);
  assert.ok(messages[0].content.includes('原方案覆盖修复助手'));
  assert.ok(messages[1].content.includes('当前小节：2.1 小节'));
  assert.ok(messages[1].content.includes('描述：描述'));
  assert.ok(messages[2].content.includes('<source id="P001">'));
  assert.ok(messages[2].content.includes('原方案内容'));
  assert.ok(messages[3].content.includes('"status": "missing"'));
  assert.ok(messages[3].content.includes('"点1"'));
  assert.ok(messages[4].content.includes('当前正文'));
  assert.ok(messages[5].content.includes('补写尝试次数：1/2'));
  assert.ok(messages[5].content.includes('上次补写应用失败原因'));
  assert.ok(messages[5].content.includes('1. 上次失败原因'));
});

test('buildOriginalCoverageRepairMessages 无失败记录时不追加失败块', () => {
  const target = { item: { id: '2.2', title: 'T' }, sources: [] };
  const messages = C.buildOriginalCoverageRepairMessages({ target, coverageItems: [], currentContent: '', attempt: 2, failures: [] });
  const last = messages[messages.length - 1].content;
  assert.ok(last.includes('补写尝试次数：2/2'));
  assert.ok(!last.includes('上次补写应用失败原因'));
  assert.ok(messages[2].content.startsWith('需要补回的原方案来源段：'));
  assert.ok(!messages[2].content.includes('<source'));
});