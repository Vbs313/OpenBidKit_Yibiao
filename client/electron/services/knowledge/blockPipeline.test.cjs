const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('./blockPipeline.cjs');

const LONG = '本段用于测试块流水线，内容必须足够长以免被当作过短块过滤掉。'.repeat(6);

test('createRawBlocks 按标题切块并记录 heading_path', () => {
  const blocks = P.createRawBlocks('# 一级标题\n\n' + LONG + '\n\n## 二级标题\n\n' + LONG);
  assert.match(blocks[0].id, /^R\d{6}$/);
  const paragraphs = blocks.filter((block) => block.content === LONG);
  assert.equal(paragraphs.length, 2);
  assert.deepEqual(paragraphs[0].heading_path, ['一级标题']);
  assert.deepEqual(paragraphs[1].heading_path, ['一级标题', '二级标题']);
  assert.equal(paragraphs[0].type, 'paragraph');
});

test('createRawBlocks 空输入返回空数组', () => {
  assert.deepEqual(P.createRawBlocks(''), []);
  assert.deepEqual(P.createRawBlocks(null), []);
});

test('filterBlocks 过滤过短块并给保留块重新编号', () => {
  const result = P.filterBlocks([
    { id: 'R000001', type: 'paragraph', heading_path: ['A'], content: '太短' },
    { id: 'R000002', type: 'paragraph', heading_path: ['A'], content: LONG },
  ]);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].id, 'P000001');
  assert.equal(result.blocks[0].content, LONG);
  assert.equal(result.filtered_blocks.length, 1);
  assert.equal(result.filtered_blocks[0].reason, 'too_short');
});

test('filterBlocks 过滤页码与重复页眉页脚', () => {
  const headerContent = '-'.repeat(120) + '某某公司技术标';
  const header = () => ({ id: 'RH', type: 'paragraph', heading_path: [], content: headerContent });
  const result = P.filterBlocks([
    { id: 'R0', type: 'paragraph', heading_path: [], content: LONG },
    { id: 'R1', type: 'paragraph', heading_path: [], content: '- 12 -' },
    header(), header(), header(),
  ]);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].content, LONG);
  const reasons = result.filtered_blocks.map((block) => block.reason);
  assert.ok(reasons.includes('page_number'));
  assert.ok(reasons.includes('repeated_header_footer'));
});

test('renderBlocksForPrompt 渲染 id、type、heading_path 与正文', () => {
  const text = P.renderBlocksForPrompt([{ id: 'P000001', type: 'list', heading_path: ['一', '二'], content: '正文内容' }]);
  assert.match(text, /\[P000001\]/);
  assert.match(text, /type: list/);
  assert.match(text, /heading_path: 一 > 二/);
  assert.match(text, /正文内容/);
  assert.match(P.renderBlocksForPrompt([{ id: 'P1', type: 'paragraph', heading_path: [], content: 'x' }]), /heading_path: 无/);
});

test('normalizeRanges 交换倒序区间并丢弃未知块', () => {
  const order = new Map([['A', 0], ['B', 1], ['C', 2]]);
  assert.deepEqual(P.normalizeRanges([['C', 'A'], ['A', 'Z'], 'B'], order), [['A', 'C'], ['B', 'B']]);
  assert.deepEqual(P.normalizeRanges(null, order), []);
});

test('expandRanges 展开为按顺序去重的块 id', () => {
  const order = new Map([['A', 0], ['B', 1], ['C', 2]]);
  const blocks = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  assert.deepEqual(P.expandRanges([['A', 'B']], blocks, order), ['A', 'B']);
  assert.deepEqual(P.expandRanges([['B', 'C'], ['A', 'B']], blocks, order), ['B', 'C', 'A']);
});

test('compressBlockIdsToRanges 把连续 id 压成闭区间', () => {
  const order = new Map([['A', 0], ['B', 1], ['C', 2], ['D', 3], ['E', 4]]);
  assert.deepEqual(P.compressBlockIdsToRanges(['A', 'B', 'C', 'E'], order), [['A', 'C'], ['E', 'E']]);
  assert.deepEqual(P.compressBlockIdsToRanges(['C', 'A', 'B', 'Z'], order), [['A', 'C']]);
  assert.deepEqual(P.compressBlockIdsToRanges([], order), []);
});

test('splitOversizedText 按上限切分且保留全部文本', () => {
  const text = '段落一。'.repeat(20) + '\n\n' + '段落二。'.repeat(20);
  const chunks = P.splitOversizedText(text, 60);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 60, 'chunk too long: ' + chunk.length);
  assert.equal(chunks.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
});

test('mergeSemanticBlocks 保留所有块内容', () => {
  const merged = P.mergeSemanticBlocks([
    { id: 'R1', type: 'paragraph', heading_path: ['A'], content: '短一' },
    { id: 'R2', type: 'paragraph', heading_path: ['A'], content: '短二' },
    { id: 'R3', type: 'paragraph', heading_path: ['A'], content: LONG },
  ]);
  assert.ok(merged.length >= 1);
  const combined = merged.map((block) => block.content).join('\n');
  assert.ok(combined.includes('短一'));
  assert.ok(combined.includes('短二'));
  assert.ok(combined.includes(LONG));
});
