const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('./consistencyRepair.cjs');

test('CONSISTENCY_REPAIR_MAX_ATTEMPTS 固定为 2', () => {
  assert.equal(C.CONSISTENCY_REPAIR_MAX_ATTEMPTS, 2);
});

test('buildConsistencyRepairMessages 组装修复提示词与尝试次数', () => {
  const context = { item: { id: '1.1', title: '小节', description: '描述' }, parentChapters: [{ id: '1', title: '父章' }] };
  const messages = C.buildConsistencyRepairMessages({
    context,
    conflicts: [{ type: 'fact', detail: '冲突点' }],
    globalFactsText: '全局事实',
    bidAnalysisFactsText: '关键解析',
    currentContent: '正文第一行',
    attempt: 1,
    failures: ['上次失败原因'],
    tableRequirement: 'none',
    globalFactsMode: 'omit',
  });
  assert.equal(messages.length, 7);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'user', 'user', 'user', 'user', 'user', 'user']);
  const all = messages.map((m) => m.content).join('\n');
  assert.ok(all.includes('一致性修复助手'));
  assert.ok(all.includes('本次配置为不要表格'));
  assert.ok(all.includes('事实补全规则（别招欠模式）'));
  assert.ok(all.includes('全局事实'));
  assert.ok(all.includes('关键解析'));
  assert.ok(all.includes('当前小节：1.1 小节'));
  assert.ok(all.includes('冲突点'));
  assert.ok(all.includes('[001] 正文第一行'));
  assert.ok(all.includes('修复尝试次数：1/2'));
  assert.ok(all.includes('1. 上次失败原因'));
});

test('buildConsistencyRepairMessages 允许表格时换用保留表格口径', () => {
  const messages = C.buildConsistencyRepairMessages({
    context: { item: { id: '2.1' } },
    conflicts: [],
    currentContent: '',
    attempt: 2,
    failures: [],
    tableRequirement: 'heavy',
  });
  const all = messages.map((m) => m.content).join('\n');
  assert.ok(all.includes('如果修改表格，old_text 必须包含完整表格行或完整表格块'));
  assert.ok(all.includes('保留 Markdown 表格、列表、代码块、图片和 Mermaid 块结构'));
  assert.ok(all.includes('修复尝试次数：2/2'));
  assert.ok(!all.includes('上次修复应用失败原因'));
});
