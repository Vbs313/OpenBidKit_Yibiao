const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildContentExpansionRepairMessages,
  buildConsistencyRepairJsonRepairMessages,
  buildOriginalRestoreRepairMessages,
  buildWordAdjustmentRepairMessages,
  formatBidAnalysisFactsForPrompt,
  formatBidAnalysisFactForPrompt,
  formatBidKeyInfoForPrompt,
  formatContentPlanForPrompt,
  formatGlobalFactsForPrompt,
  formatGlobalFactTitlesForPrompt,
  formatKnowledgeContentsForPrompt,
  formatOriginalSegmentsForPrompt,
  formatRestoreTargetsForPrompt,
  formatSelectedGlobalFactsForPrompt,
} = require('./promptBuilders.cjs');

test('formatGlobalFactsForPrompt 渲染标题和内容，跳过空项', () => {
  // 标题为空时会回落到「全局事实N」，所以只有内容为空才真正被跳过。
  assert.equal(
    formatGlobalFactsForPrompt([{ title: '甲', content: ' x ' }, { title: '', content: 'y' }, { title: '乙', content: 'z' }]),
    '## 甲\nx\n\n## 全局事实2\ny\n\n## 乙\nz',
  );
  assert.equal(formatGlobalFactsForPrompt(null), '');
});

test('formatGlobalFactTitlesForPrompt 输出去重后的 JSON 数组', () => {
  // 实现用的是 JSON.stringify(..., null, 2)，所以是带缩进的 JSON。
  assert.equal(formatGlobalFactTitlesForPrompt([{ title: 'a' }, { title: 'a' }, { title: ' b ' }]), '[\n  "a",\n  "b"\n]');
});

test('formatBidAnalysisFactForPrompt 只在成功状态时输出', () => {
  const plan = { bidAnalysisTasks: { projectInfo: { status: 'success', content: ' info ' } } };
  assert.equal(formatBidAnalysisFactForPrompt(plan, 'projectInfo', '项目信息'), '## 项目信息\ninfo');
  assert.equal(formatBidAnalysisFactForPrompt({ bidAnalysisTasks: { projectInfo: { status: 'failed', content: 'x' } } }, 'projectInfo', '项目信息'), '');
  assert.equal(formatBidAnalysisFactForPrompt(null, 'projectInfo', '项目信息'), '');
});

test('formatBidAnalysisFactsForPrompt 只拼接已有的事实块', () => {
  const out = formatBidAnalysisFactsForPrompt({ bidAnalysisTasks: { projectInfo: { status: 'success', content: 'i' } } });
  assert.equal(out, '## 项目信息\ni');
});

test('formatBidKeyInfoForPrompt 拼接项目概述与事实，全空时给占位', () => {
  assert.equal(formatBidKeyInfoForPrompt('概述', '事实'), '## 项目概述\n概述\n\n事实');
  assert.equal(formatBidKeyInfoForPrompt('', ''), '未提供');
});

test('formatSelectedGlobalFactsForPrompt 跳过缺标题或缺内容的项', () => {
  assert.equal(formatSelectedGlobalFactsForPrompt([{ title: 'a', content: 'c' }, { title: '', content: 'x' }]), '## a\nc');
});

test('formatContentPlanForPrompt 逐行渲染写作要点、事实、表格与还原情况', () => {
  const out = formatContentPlanForPrompt({
    writing_focus: '',
    facts: { titles: ['a'] },
    table: { needed: true, purpose: '' },
    original_material: { restored: true, restored_chars: 3 },
  });
  assert.equal(out, ['写作重点：围绕当前章节标题和描述展开', '事实变量：a', '表格：需要，目的：提升正文表达清晰度', '原方案还原：已还原 3 字'].join('\n'));
  const empty = formatContentPlanForPrompt({ facts: {}, table: { needed: false }, original_material: {} });
  assert.match(empty, /事实变量：无/);
  assert.match(empty, /表格：不需要/);
  assert.match(empty, /原方案还原：未还原/);
});

test('formatKnowledgeContentsForPrompt 包成 knowledge_content 块', () => {
  assert.equal(formatKnowledgeContentsForPrompt([' a ', 'b']), '<knowledge_content>\na\n</knowledge_content>\n\n<knowledge_content>\nb\n</knowledge_content>');
});

test('formatOriginalSegmentsForPrompt 渲染标题路径与原文', () => {
  const out = formatOriginalSegmentsForPrompt([{ id: 's1', title_path: ['A', 'B'], chars: 5, content: '正文' }]);
  assert.equal(out, '<original_segment id="s1">\n标题路径：A > B\n字符数：5\n原文：\n正文\n</original_segment>');
});

test('formatRestoreTargetsForPrompt 渲染目标节点并排除自身同级', () => {
  const out = formatRestoreTargetsForPrompt([{
    item: { id: 'n1', title: 'T', description: 'D' },
    parentChapters: [{ id: 'p', title: 'P' }],
    siblingChapters: [{ id: 'n1', title: 'T' }, { id: 'n2', title: 'S' }],
  }]);
  assert.equal(out, '- node_id: n1\n  标题: T\n  描述: D\n  上级章节: p P\n  同级章节: n2 S');
});

test('修复提示词构造器返回 user 消息，带上错误清单与待修复内容', () => {
  const cases = [
    buildContentExpansionRepairMessages({ invalidContent: '{"a":1}', issues: ['缺少 operations'] }, '当前正文'),
    buildConsistencyRepairJsonRepairMessages({ invalidContent: '{"b":2}', issues: ['section_id 无效'] }, 's1'),
    buildOriginalRestoreRepairMessages({ invalidContent: '{"c":3}', issues: ['编号越权'] }, [], []),
    buildWordAdjustmentRepairMessages({ invalidContent: '{"d":4}', issues: ['granularity 不支持'] }, 'expand', 'section', '正文'),
  ];
  for (const messages of cases) {
    assert.ok(Array.isArray(messages) && messages.length >= 2, '应返回多条消息');
    assert.ok(messages.every((m) => m && m.role === 'user' && typeof m.content === 'string'), '每条都是 user 文本消息');
    const joined = messages.map((m) => m.content).join('\n');
    assert.match(joined, /1\. /, '包含编号后的错误清单');
  }
});

test('renderKnowledgeItemsForPrompt 只保留 id/title/resume 齐全的条目', () => {
  const P = require('./promptBuilders.cjs');
  const rows = JSON.parse(P.renderKnowledgeItemsForPrompt([
    { id: 'd1::i1', title: 'T1', resume: 'R1', content: 'C1' },
    { id: 'd1::i2', title: 'T2' },
    { id: '', title: 'T3', resume: 'R3' },
  ]));
  assert.deepEqual(rows, [{ id: 'd1::i1', title: 'T1', resume: 'R1' }]);
  assert.deepEqual(JSON.parse(P.renderKnowledgeItemsForPrompt([])), []);
  assert.deepEqual(JSON.parse(P.renderKnowledgeItemsForPrompt()), []);
});
