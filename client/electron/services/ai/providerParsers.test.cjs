const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('./providerParsers.cjs');
const FENCE = String.fromCharCode(96).repeat(3);

test('extractOpenAIUsage / extractGoogleUsage 复用同一份用量归一化', () => {
  assert.deepEqual(P.extractOpenAIUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0, reasoning_tokens: 0,
  });
  assert.deepEqual(P.extractGoogleUsage({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }), {
    prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, cached_tokens: 0, reasoning_tokens: 0,
  });
});

test('extractJsonContent 剥掉 JSON 围栏，普通文本原样返回', () => {
  assert.equal(P.extractJsonContent(FENCE + 'json\n{"a":1}\n' + FENCE), '{"a":1}');
  assert.equal(P.extractJsonContent(FENCE + '\n[1]\n' + FENCE), '[1]');
  assert.equal(P.extractJsonContent('{"a":1}'), '{"a":1}');
});

test('extractFencedJsonBlocks 取出所有非空围栏块', () => {
  const content = '前言 ' + FENCE + 'json\n{"a":1}\n' + FENCE + ' 中间 ' + FENCE + '\n[1]\n' + FENCE;
  assert.deepEqual(P.extractFencedJsonBlocks(content), ['{"a":1}', '[1]']);
  assert.deepEqual(P.extractFencedJsonBlocks('没有围栏'), []);
});

test('extractBalancedJsonCandidates 逐个取出平衡的 JSON 片段', () => {
  assert.deepEqual(P.extractBalancedJsonCandidates('前言 {"a":1} 中间 [1,2] 后记'), ['{"a":1}', '[1,2]']);
  assert.deepEqual(P.extractBalancedJsonCandidates('{"a":1'), []);
});

test('extractGoogleCandidateParts 摊平所有 candidate 的 parts', () => {
  const parts = P.extractGoogleCandidateParts({
    candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }, { content: { parts: [{ text: 'c' }] } }],
  });
  assert.deepEqual(parts, [{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  assert.deepEqual(P.extractGoogleCandidateParts({}), []);
});

test('extractComfyUIHistoryWorkflow 找到含 class_type 的工作流，否则 null', () => {
  assert.deepEqual(P.extractComfyUIHistoryWorkflow([{ a: { class_type: 'X' } }, { b: 1 }]), { a: { class_type: 'X' } });
  assert.equal(P.extractComfyUIHistoryWorkflow([{ b: 1 }]), null);
  assert.equal(P.extractComfyUIHistoryWorkflow('not-an-array'), null);
});

test('extractComfyUIImages 收集带文件名的输出图片', () => {
  const images = P.extractComfyUIImages({ outputs: { n1: { images: [{ filename: 'a.png' }, {}, { filename: 'b.png' }] } } });
  assert.deepEqual(images, [{ filename: 'a.png' }, { filename: 'b.png' }]);
  assert.deepEqual(P.extractComfyUIImages({}), []);
});
