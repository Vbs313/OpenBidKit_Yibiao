const test = require('node:test');
const assert = require('node:assert/strict');
const { detectProcurementMethod, buildProcurementContextMessage, METHOD_RULES } = require('./procurementMethod.cjs');

test('detects competitive negotiation from part title', () => {
  const md = [
    '第一部分竞争性谈判公告',
    '项目名称：某医院信息化项目',
    '第二部分谈判须知',
    '供应商应按谈判文件要求编制谈判响应文件。',
    '谈判小组由采购人代表组成。',
  ].join('\n');
  const method = detectProcurementMethod(md);
  assert.equal(method.id, 'competitive_negotiation');
  assert.ok(['medium', 'high'].includes(method.confidence));
  assert.match(method.fileLabel, /谈判/);
});

test('detects competitive consultation', () => {
  const md = '竞争性磋商公告\n本项目采用竞争性磋商方式采购，供应商须按磋商文件编制磋商响应文件。磋商小组进行综合评分。';
  assert.equal(detectProcurementMethod(md).id, 'competitive_consultation');
});

test('detects open tender', () => {
  const md = '招标公告\n第一章 投标人须知\n第二章 评标办法\n投标人应按招标文件编制投标文件。';
  assert.equal(detectProcurementMethod(md).id, 'open_tender');
});

test('empty falls back open_tender low confidence', () => {
  const method = detectProcurementMethod('');
  assert.equal(method.id, 'open_tender');
  assert.equal(method.confidence, 'low');
});

test('context message mentions negotiation semantics', () => {
  const msg = buildProcurementContextMessage({
    id: 'competitive_negotiation',
    label: '竞争性谈判',
    fileLabel: '竞争性谈判文件',
  });
  assert.match(msg, /竞争性谈判/);
  assert.match(msg, /响应文件/);
});

test('detects invited tender (邀请招标)', () => {
  const md = '投标邀请书\n我方就邀请招标项目邀请贵单位参与投标。请按邀请招标文件要求编制投标文件。';
  const method = detectProcurementMethod(md);
  assert.equal(method.id, 'invited_tender');
  assert.equal(method.label, '邀请招标');
  assert.match(method.fileLabel, /邀请招标/);
});

test('invited tender context uses tender wording (not negotiation)', () => {
  const msg = buildProcurementContextMessage({
    id: 'invited_tender',
    label: '邀请招标',
    fileLabel: '邀请招标文件',
  });
  assert.match(msg, /邀请招标/);
  assert.match(msg, /投标文件\/响应文件/);
  assert.doesNotMatch(msg, /谈判\/磋商\/评审/);
});

test('all 6 government procurement methods are supported (政府采购法)', () => {
  const ids = METHOD_RULES.map((rule) => rule.id).sort();
  assert.deepEqual(ids, [
    'competitive_consultation',
    'competitive_negotiation',
    'inquiry',
    'invited_tender',
    'open_tender',
    'single_source',
  ]);
  assert.equal(METHOD_RULES.length, 6);
});
