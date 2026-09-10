const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('./textEdits.cjs');

test('textHash 与 textMetrics 固定住文本指纹', () => {
  assert.equal(T.textHash(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(T.textHash('abc'), T.textHash('abc'));
  assert.notEqual(T.textHash('abc'), T.textHash('abd'));
  assert.equal(T.textHash(null), T.textHash(''));

  assert.deepEqual(T.textMetrics('abcd'), { chars: 4, hash: T.textHash('abcd') });
  assert.equal(T.textMetrics(null).chars, 0);
  assert.equal(T.textMetrics(undefined).hash, T.textHash(''));
});

test('formatContentWithLineNumbers 统一换行并按需补零', () => {
  assert.equal(T.formatContentWithLineNumbers('a\r\nb'), '[001] a\n[002] b');
  assert.equal(T.formatContentWithLineNumbers('只有一行'), '[001] 只有一行');
  assert.equal(T.formatContentWithLineNumbers(''), '[001] ');
  const many = Array.from({ length: 1000 }, (_, i) => 'x' + i).join('\n');
  assert.ok(T.formatContentWithLineNumbers(many).startsWith('[0001] x0\n[0002] x1'));
});

test('findExactOccurrences 只做不重叠的精确扫描', () => {
  assert.deepEqual(T.findExactOccurrences('aaaa', 'aa'), [0, 2]);
  assert.deepEqual(T.findExactOccurrences('abcabc', 'abc'), [0, 3]);
  assert.deepEqual(T.findExactOccurrences('abc', 'z'), []);
  assert.deepEqual(T.findExactOccurrences('abc', ''), []);
});

test('extractLineRangeText 按 1 基行号取文，越界返回 null', () => {
  const content = 'l1\nl2\nl3';
  assert.equal(T.extractLineRangeText(content, 1, 2), 'l1\nl2');
  assert.equal(T.extractLineRangeText(content, 2, 2), 'l2');
  assert.equal(T.extractLineRangeText(content, 3, 3), 'l3');
  assert.equal(T.extractLineRangeText(content, 1, 9), null);
  assert.equal(T.extractLineRangeText(content, 2, 9), null);
});

test('replaceLineRange 用替换内容顶掉整段行区间', () => {
  const content = 'l1\nl2\nl3';
  assert.equal(T.replaceLineRange(content, 2, 2, 'X'), 'l1\nX\nl3');
  assert.equal(T.replaceLineRange(content, 2, 3, 'X\nY'), 'l1\nX\nY');
  assert.equal(T.replaceLineRange(content, 1, 3, 'X'), 'X');
});

test('describeConsistencyPatchMatch 给出命中计数与行区间比对', () => {
  const content = '第一段\n第二段';
  const detail = T.describeConsistencyPatchMatch(content, {
    section_id: 's1',
    start_line: 2,
    end_line: 2,
    old_text: '第二段',
    new_text: '改过的第二段',
  });
  assert.equal(detail.section_id, 's1');
  assert.equal(detail.start_line, 2);
  assert.equal(detail.end_line, 2);
  assert.equal(detail.old_text, '第二段');
  assert.equal(detail.exact_match_count, 1);
  assert.equal(detail.line_range.exists, true);
  assert.equal(detail.line_range.matches_old_text, true);
  assert.equal(detail.old_text_metrics.chars, 3);
  assert.equal(detail.line_range.candidate_metrics.chars, 3);

  const notFound = T.describeConsistencyPatchMatch(content, { old_text: '不存在' });
  assert.equal(notFound.exact_match_count, 0);
  assert.equal(notFound.line_range, null);
});

test('applyExactConsistencyPatch 优先按行区间，其次要求全文唯一命中', () => {
  const content = '第一段\n第二段';
  assert.equal(
    T.applyExactConsistencyPatch(content, { start_line: 2, end_line: 2, old_text: '第二段', new_text: '改过的第二段' }),
    '第一段\n改过的第二段',
  );
  assert.equal(
    T.applyExactConsistencyPatch(content, { old_text: '第一段', new_text: '新的第一段' }),
    '新的第一段\n第二段',
  );
  assert.throws(() => T.applyExactConsistencyPatch('a a', { old_text: 'a', new_text: 'b' }), /出现多次/);
  assert.throws(() => T.applyExactConsistencyPatch(content, { old_text: '找不到', new_text: 'b' }), /未在当前小节正文中找到/);
  assert.throws(() => T.applyExactConsistencyPatch(content, { old_text: '第一段', new_text: '第一段' }), /old_text 与 new_text 相同/);
  assert.throws(() => T.applyExactConsistencyPatch(content, { new_text: 'b' }), /old_text 为空/);
  assert.throws(() => T.applyExactConsistencyPatch(content, { old_text: '第一段' }), /new_text 为空/);
});

test('applyExactConsistencyPatch 先剥掉提示词行号再定位', () => {
  const content = '第一段\n第二段';
  assert.equal(
    T.applyExactConsistencyPatch(content, { old_text: '[002] 第二段', new_text: '改过的第二段' }),
    '第一段\n改过的第二段',
  );
});

test('applyConsistencyRepairPatches 汇总成功数、失败原因与逐条明细', () => {
  const content = '第一段\n第二段';
  const result = T.applyConsistencyRepairPatches(content, [
    { start_line: 1, end_line: 1, old_text: '第一段', new_text: '新的第一段' },
    { old_text: '不存在', new_text: 'x' },
  ]);
  assert.equal(result.content, '新的第一段\n第二段');
  assert.equal(result.appliedCount, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^patch\[1\]/);
  assert.equal(result.patchResults.length, 2);
  assert.equal(result.patchResults[0].applied, true);
  assert.equal(result.patchResults[1].applied, false);
  assert.equal(result.patchResults[1].error.includes('未在当前小节正文中找到'), true);
  assert.equal(result.patchResults[0].after_content_metrics.chars, result.content.length);
});

test('findContentExpansionNeedleRanges 精确扫描并标注策略', () => {
  assert.deepEqual(T.findContentExpansionNeedleRanges('abcabc', 'abc'), [
    { start: 0, end: 3, strategy: 'target_text-exact' },
    { start: 3, end: 6, strategy: 'target_text-exact' },
  ]);
  assert.deepEqual(T.findContentExpansionNeedleRanges('abc', '  '), []);
});

test('findContentExpansionTargetTextMatch 区分唯一、多命中与逐行回退', () => {
  const unique = T.findContentExpansionTargetTextMatch('第一段\n第二段', '第二段');
  assert.equal(unique.found, true);
  assert.equal(unique.unique, true);
  assert.equal(unique.count, 1);
  assert.equal(unique.strategy, 'target_text-exact');

  const multiple = T.findContentExpansionTargetTextMatch('a\na', 'a');
  assert.equal(multiple.found, true);
  assert.equal(multiple.unique, false);
  assert.match(multiple.error, /精确命中 2 处/);

  const trimmed = T.findContentExpansionTargetTextMatch('第一段   \n第二段   ', '第一段\n第二段');
  assert.equal(trimmed.found, true);
  assert.equal(trimmed.unique, true);
  assert.equal(trimmed.strategy, 'target_text-line-trimmed');

  const missing = T.findContentExpansionTargetTextMatch('第一段', '完全不存在');
  assert.equal(missing.found, false);
  assert.match(missing.error, /未在当前章节正文中唯一命中/);

  const empty = T.findContentExpansionTargetTextMatch('第一段', '   ');
  assert.equal(empty.found, false);
  assert.match(empty.error, /缺少 target_text/);
});

test('applyContentExpansionPatch 处理 insert 的 start/anchor/兜底追加', () => {
  const content = '第一段\n\n第二段';
  assert.equal(T.applyContentExpansionPatch('', { operation: 'insert', content: '新段落' }), '新段落');
  assert.equal(T.applyContentExpansionPatch(content, { operation: 'insert', content: '开头', anchor: 'start' }), '开头\n\n第一段\n\n第二段');
  assert.equal(T.applyContentExpansionPatch(content, { operation: 'insert', content: '夹在中间', anchor: '第一段' }), '第一段\n\n夹在中间\n\n第二段');
  assert.equal(T.applyContentExpansionPatch(content, { operation: 'insert', content: '收尾', anchor: 'end' }), '第一段\n\n第二段\n\n收尾');
  assert.equal(T.applyContentExpansionPatch(content, { operation: 'insert', content: '找不到锚点' }), '第一段\n\n第二段\n\n找不到锚点');
});

test('applyContentExpansionPatch 处理 replace 与两类失败', () => {
  assert.equal(
    T.applyContentExpansionPatch('第一段\n第二段', { operation: 'replace', target_text: '第二段', content: '改过的第二段' }),
    '第一段\n改过的第二段',
  );
  assert.throws(
    () => T.applyContentExpansionPatch('第一段\n第二段', { operation: 'replace', target_text: '不存在', content: 'x' }),
    /未在当前章节正文中唯一命中/,
  );
  assert.throws(
    () => T.applyContentExpansionPatch('', { operation: 'replace', target_text: '任意', content: 'x' }),
    /正文为空/,
  );
});