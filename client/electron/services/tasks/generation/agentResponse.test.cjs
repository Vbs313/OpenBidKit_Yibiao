const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compactError,
  extractBalancedAgentJsonCandidate,
  extractFencedAgentJsonBlocks,
  normalizeOriginalRestoreAssignments,
  rangeOverlaps,
  singleLine,
  splitLinesWithRanges,
  validateConsistencyRepairResponse,
} = require('./agentResponse.cjs');

const FENCE = String.fromCharCode(96).repeat(3);

test('singleLine 折叠空白', () => {
  assert.equal(singleLine('  a\n  b '), 'a b');
  assert.equal(singleLine(null), '');
});

test('splitLinesWithRanges 保留每行原文与换行区间', () => {
  assert.deepEqual(splitLinesWithRanges('a\nb'), [
    { text: 'a', start: 0, end: 1, newlineEnd: 2 },
    { text: 'b', start: 2, end: 3, newlineEnd: 3 },
  ]);
  assert.deepEqual(splitLinesWithRanges('a\r\nb')[0], { text: 'a', start: 0, end: 1, newlineEnd: 3 });
  assert.deepEqual(splitLinesWithRanges(''), [{ text: '', start: 0, end: 0, newlineEnd: 0 }]);
});

test('rangeOverlaps 判断区间相交', () => {
  assert.equal(rangeOverlaps(1, 5, [{ start: 4, end: 6 }]), true);
  assert.equal(rangeOverlaps(1, 3, [{ start: 4, end: 6 }]), false);
  assert.equal(rangeOverlaps(1, 3, null), false);
});

test('compactError 折叠空白并按上限截断', () => {
  assert.equal(compactError('a   b'), 'a b');
  assert.equal(compactError('abcdef', 3), 'abc...');
  assert.equal(compactError(null), '');
});

test('normalizeOriginalRestoreAssignments 过滤越权编号并去重', () => {
  const allowedNodeIds = new Set(['n1', 'n2']);
  const allowedSourceIds = new Set(['s1', 's2']);
  const out = normalizeOriginalRestoreAssignments({
    result: { assignments: [
      { node_id: 'n1', source_ids: ['s1', 's1', 'unknown'] },
      { node_id: 'n1', source_ids: ['s2'] },
      { node_id: 'n9', source_ids: ['s1'] },
    ] },
  }, { allowedNodeIds, allowedSourceIds });
  assert.deepEqual(out.assignments, [{ node_id: 'n1', source_ids: ['s1', 's2'] }]);
});

test('extractFencedAgentJsonBlocks 取出围栏内容', () => {
  const content = [FENCE + 'json', '{"a":1}', FENCE, '中间文本', FENCE, '[1]', FENCE].join('\n');
  const blocks = extractFencedAgentJsonBlocks(content);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].trim(), '{"a":1}');
  assert.equal(blocks[1].trim(), '[1]');
  assert.deepEqual(extractFencedAgentJsonBlocks('没有围栏'), []);
});

test('extractBalancedAgentJsonCandidate 取第一个完整 JSON，字符串内括号不误判', () => {
  assert.equal(extractBalancedAgentJsonCandidate('前言 {"a":1} 后记'), '{"a":1}');
  assert.equal(extractBalancedAgentJsonCandidate('{ "a": { "b": [1, 2] } } tail'), '{ "a": { "b": [1, 2] } }');
  assert.equal(extractBalancedAgentJsonCandidate('{"a":"}"}'), '{"a":"}"}');
  assert.equal(extractBalancedAgentJsonCandidate('{"a":1'), '');
  assert.equal(extractBalancedAgentJsonCandidate('没有 JSON'), '');
});

test('validateConsistencyRepairResponse 逐项校验 patches', () => {
  assert.throws(() => validateConsistencyRepairResponse({}), /patches/);
  assert.throws(() => validateConsistencyRepairResponse({ patches: [{}] }), /section_id/);
  assert.throws(() => validateConsistencyRepairResponse({ patches: [{ section_id: 's', old_text: '' }] }), /old_text/);
  assert.throws(
    () => validateConsistencyRepairResponse({ patches: [{ section_id: 's', old_text: 'a', new_text: 'a' }] }),
    /相同/,
  );
  assert.doesNotThrow(() => validateConsistencyRepairResponse({ patches: [{ section_id: 's', old_text: 'a', new_text: 'b' }] }));
});
