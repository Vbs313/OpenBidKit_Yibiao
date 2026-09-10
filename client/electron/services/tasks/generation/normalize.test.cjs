const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeRegExp,
  normalizeConsistencyRepairResponse,
  normalizeContentPlan,
  normalizeFactTitles,
  normalizeGlobalFactsMode,
  normalizeKnowledgeItemIds,
  normalizeNewlines,
  normalizeOriginalMaterial,
  normalizeParagraphs,
  normalizePositiveInteger,
  normalizeStringArray,
  normalizeTableCleanupResponse,
  stripPromptLineNumbers,
} = require('./normalize.cjs');

test('normalizeNewlines 统一为 LF', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc'), 'a\nb\nc');
});

test('normalizeStringArray 去空白、去空值、去重且保留首次出现顺序', () => {
  assert.deepEqual(normalizeStringArray(['a', ' a ', '', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(normalizeStringArray(null), []);
});

test('normalizeParagraphs 按空行切段并去空白', () => {
  assert.deepEqual(normalizeParagraphs('a\n\n b \n\n\nc'), ['a', 'b', 'c']);
});

test('normalizePositiveInteger 只接受正数，否则回退', () => {
  assert.equal(normalizePositiveInteger('3.7', 5), 3);
  assert.equal(normalizePositiveInteger('0', 5), 5);
  assert.equal(normalizePositiveInteger('-2', 5), 5);
  assert.equal(normalizePositiveInteger('abc', 5), 5);
});

test('escapeRegExp 转义正则元字符', () => {
  assert.equal(escapeRegExp('a.b*c'), 'a\\.b\\*c');
});

test('stripPromptLineNumbers 去掉行首编号', () => {
  assert.equal(stripPromptLineNumbers('[001] a\n[12] b'), 'a\nb');
});

test('normalizeFactTitles / normalizeKnowledgeItemIds 按白名单过滤并去重', () => {
  assert.deepEqual(normalizeFactTitles(['a', ' a ', 'b'], new Set(['a'])), ['a']);
  assert.deepEqual(normalizeKnowledgeItemIds(['k1', 'k1', 'k2'], new Set(['k1'])), ['k1']);
  assert.deepEqual(normalizeFactTitles(['a', 'b'], null), ['a', 'b']);
});

test('normalizeTableCleanupResponse 过滤越权与空替换，并按 table_id 去重', () => {
  const out = normalizeTableCleanupResponse({
    result: { replacements: [
      { table_id: 't1', replacement_text: '| a |' },
      { table_id: 't1', replacement_text: '重复' },
      { table_id: 't9', replacement_text: '越权' },
      { table_id: 't2', replacement_text: '   ' },
    ] },
  }, new Set(['t1', 't2']));
  assert.deepEqual(out, { replacements: [{ table_id: 't1', replacement_text: '| a |' }] });
});

test('normalizeOriginalMaterial 归一字段并夹紧字符数', () => {
  const out = normalizeOriginalMaterial({ restored: 1, source_ids: ['s1', 's1'], source_titles: [' a '], source_hashes: ['h', 'h'], restored_chars: '12.6', restoredAt: 'T' });
  assert.deepEqual(out, { restored: true, optimized: false, source_ids: ['s1'], source_titles: ['a'], source_hashes: ['h'], restored_chars: 13, restored_at: 'T' });
});

test('normalizeContentPlan 归一写法差异并过滤白名单', () => {
  const out = normalizeContentPlan({
    plan: { writing_focus: ' 重点 ', knowledge: { item_ids: ['k1', 'x'] }, facts: { titles: ['f1', 'y'] }, table: { needed: true, purpose: ' 目的 ' }, original_material: { restored: true, restored_chars: 5 } },
  }, new Set(['k1']), new Set(['f1']));
  assert.equal(out.writing_focus, '重点');
  assert.deepEqual(out.knowledge.item_ids, ['k1']);
  assert.deepEqual(out.facts.titles, ['f1']);
  assert.deepEqual(out.table, { needed: true, purpose: '目的' });
  assert.equal(out.original_material.restored, true);
  assert.equal(out.original_material.restored_chars, 5);
});

test('normalizeConsistencyRepairResponse 补默认 section_id、去行号，并拒绝越权编号', () => {
  const out = normalizeConsistencyRepairResponse({ patches: [{ old_text: '[001] a', new_text: 'b' }] }, 's1');
  assert.equal(out.patches.length, 1);
  assert.equal(out.patches[0].section_id, 's1');
  assert.equal(out.patches[0].old_text, 'a');
  assert.equal(out.patches[0].new_text, 'b');
  assert.throws(() => normalizeConsistencyRepairResponse({ patches: [{ section_id: 's2', old_text: 'a', new_text: 'b' }] }, 's1'), /section_id 无效/);
});

test('normalizeGlobalFactsMode 只认三种模式', () => {
  assert.equal(normalizeGlobalFactsMode('omit'), 'omit');
  assert.equal(normalizeGlobalFactsMode('placeholder'), 'placeholder');
  assert.equal(normalizeGlobalFactsMode('其它'), 'fabricate');
});
