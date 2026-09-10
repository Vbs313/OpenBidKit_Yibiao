const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('./contentMessages.cjs');

const chapter = { id: 'c1', title: '章节一', description: '描述' };
const entry = { item: chapter, parentChapters: [{ id: 'p', title: '父' }], siblingChapters: [{ id: 's', title: '兄' }], content: '正文' };
const plan = { writing_focus: '重点', knowledge: { item_ids: [] }, facts: { titles: [] }, table: { needed: false, purpose: '' }, original_material: {} };
const wordControl = { sectionWords: 100, strictSectionWords: false, sectionMinimumWords: 80, sectionMaximumWords: 120 };

const assertMessages = (messages, expectedRoles, phrase) => {
  assert.ok(Array.isArray(messages) && messages.length > 0, '应返回消息数组');
  for (const message of messages) {
    assert.ok(message && expectedRoles.includes(message.role), '角色应在预期集合内');
    assert.equal(typeof message.content, 'string');
  }
  assert.match(messages.map((m) => m.content).join('\n'), phrase);
};

test('appendSelectedFactsMessage 仅在事实非空时追加一条 user 消息', () => {
  const messages = [];
  M.appendSelectedFactsMessage(messages, '   ');
  assert.equal(messages.length, 0);
  M.appendSelectedFactsMessage(messages, ' 事实A ');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.match(messages[0].content, /事实A/);
});

test('formatChapterPath 拼接上级与当前节点', () => {
  assert.equal(M.formatChapterPath(entry), 'p 父 > c1 章节一');
  assert.equal(M.formatChapterPath({ item: {} }), 'unknown 未命名章节');
});

test('formatConsistencyAuditGroupContent 渲染 section 块', () => {
  const out = M.formatConsistencyAuditGroupContent({ items: [entry] });
  assert.match(out, /<section>/);
  assert.match(out, /编号：c1/);
  assert.match(out, /路径：p 父 > c1 章节一/);
  assert.match(out, /正文：\n正文/);
});

test('formatOriginalCoverageSources 渲染 source 块并在缺标题时给占位', () => {
  const out = M.formatOriginalCoverageSources([{ id: 's1', content: '原文', title_path: [], chars: 2 }]);
  assert.match(out, /<source id="s1">/);
  assert.match(out, /标题路径：未识别标题/);
  assert.match(out, /字符数：2/);
  assert.match(out, /原文：\n原文/);
});

test('buildSectionWordRequirement 区分硬上限与建议区间，零字数返回空串', () => {
  assert.equal(M.buildSectionWordRequirement({ sectionWords: 0 }), '');
  assert.match(M.buildSectionWordRequirement(wordControl), /建议字数 80 至 120 字/);
  assert.match(M.buildSectionWordRequirement({ ...wordControl, strictSectionWords: true }), /硬性上限/);
  assert.match(M.buildSectionWordRequirement(wordControl, true), /不能覆盖保留原方案实质内容/);
});

test('buildContentFactCompletenessInstruction 按模式给出不同规则', () => {
  assert.match(M.buildContentFactCompletenessInstruction('omit'), /严禁虚拟/);
  assert.match(M.buildContentFactCompletenessInstruction('placeholder'), /占位/);
  assert.notEqual(M.buildContentFactCompletenessInstruction('fabricate'), M.buildContentFactCompletenessInstruction('omit'));
});

test('章节正文消息带上章节标识与事实', () => {
  const messages = M.buildChapterContentMessages({ chapter, projectOverview: '项目概述', selectedFactsText: '事实A', regenerateRequirement: '', contentPlan: plan, knowledgeContents: [], preSectionInstruction: '', wordControl, generationTarget: 0, globalFactsMode: 'fabricate' });
  assertMessages(messages, ['system', 'user'], /章节一/);
  assert.match(messages.map((m) => m.content).join('\n'), /事实A/);
});

test('还原章节内容消息复用章节正文构造器', () => {
  const messages = M.buildRestoredChapterContentMessages({ chapter, projectOverview: 'o', selectedFactsText: 'f', regenerateRequirement: '', contentPlan: plan, knowledgeContents: [], restoredContent: '已还原正文', wordControl, generationTarget: 0, globalFactsMode: 'fabricate' });
  assertMessages(messages, ['system', 'user'], /章节一/);
  assert.match(messages.map((m) => m.content).join('\n'), /已还原正文/);
});

test('表格转换 / 一致性审计 / 覆盖审计 / 字数调整消息结构正确', () => {
  const cleanup = M.buildTableCleanupMessages({ chapter, tables: [{ id: 't1', type: 'x', before: 'b', after: 'a', text: '| a |' }] });
  assertMessages(cleanup, ['user'], /t1/);
  const audit = M.buildConsistencyAuditMessages({ group: { items: [entry] }, globalFactsText: 'g', bidAnalysisFactsText: 'b', globalFactsMode: 'fabricate' });
  assertMessages(audit, ['user'], /c1/);
  const coverage = M.buildOriginalCoverageAuditMessages({ target: { item: chapter, sources: [{ id: 's1', content: '原文', title_path: [], chars: 2 }] } });
  assertMessages(coverage, ['user'], /s1/);
  const adjust = M.buildWordAdjustmentMessages({ context: entry, currentContent: '正文', currentWords: 10, targetWords: 100, mode: 'expand', granularity: 'section', selectedFactsText: 'f', maximumChangeWords: 50, totalRemainingWords: 100, totalWords: 200, minimumWords: 100, maximumWords: 300, globalFactsMode: 'fabricate' });
  assertMessages(adjust, ['user'], /扩写/);
});

test('buildChapterContentPlanMessages 组装编排提示词', () => {
  const messages = M.buildChapterContentPlanMessages({
    chapter: { id: '1.1', title: '小节', description: '描述' },
    parentChapters: [{ id: '1', title: '父章', description: '父描述' }],
    siblingChapters: [{ id: '1.1', title: '小节' }, { id: '1.2', title: '同级' }],
    projectOverview: '项目概述',
    bidAnalysisFactsText: '事实',
    globalFactTitlesText: '标题清单',
    regenerateRequirement: '',
    tableRequirement: 'moderate',
    maxTables: 5,
    tableTotalSections: 10,
    knowledgeItems: [{ id: 'd1::i1', title: 'T1', resume: 'R1' }],
  });
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('正文编排助手'));
  const joined = messages.map((m) => m.content).join('\n');
  assert.ok(joined.includes('全文表格上限为 5 个，共 10 个叶子小节'));
  assert.ok(joined.includes('d1::i1'));
  assert.ok(joined.includes('标题清单'));
  assert.ok(joined.includes('同级'));
  assert.ok(joined.includes('章节ID: 1.1'));
});

test('buildChapterContentPlanMessages 在 tableTotalSections 缺失时不再引用未定义变量', () => {
  // 旧代码写成 tableTotalSections || totalSections || 0，而 totalSections 从未定义；
  // 这里的 0 会走到那个分支，修复前必然抛 ReferenceError。
  const build = (tableTotalSections) => M.buildChapterContentPlanMessages({
    chapter: { id: '1.1', title: '小节' },
    projectOverview: '',
    bidAnalysisFactsText: '',
    tableRequirement: 'moderate',
    maxTables: 3,
    tableTotalSections,
    knowledgeItems: [],
  });
  assert.doesNotThrow(() => build(0));
  assert.ok(build(0).map((m) => m.content).join('\n').includes('共 0 个叶子小节'));
  assert.doesNotThrow(() => build(undefined));
  assert.ok(build(undefined).map((m) => m.content).join('\n').includes('共 0 个叶子小节'));
});

test('buildChapterContentPlanMessages 大量/不要两种需求给出不同指令', () => {
  const base = { chapter: { id: '1.1', title: '小节' }, projectOverview: '', bidAnalysisFactsText: '', knowledgeItems: [] };
  const heavy = M.buildChapterContentPlanMessages({ ...base, tableRequirement: 'heavy', maxTables: 3, tableTotalSections: 3 });
  assert.ok(heavy[0].content.includes('表格需求为“大量”'));
  const none = M.buildChapterContentPlanMessages({ ...base, tableRequirement: 'none', maxTables: 0, tableTotalSections: 3 });
  assert.ok(none[0].content.includes('表格需求为“不要”'));
  assert.ok(none[0].content.includes('table.needed 必须为 false'));
});
