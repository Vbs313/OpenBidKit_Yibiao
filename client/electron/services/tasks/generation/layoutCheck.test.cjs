const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeLayout } = require('./layoutCheck.cjs');

test('analyzeLayout 无 destinations 时不产出补写任务', () => {
  const gaps = analyzeLayout({
    pages: [{
      index: 0,
      contentBox: { height: 700, width: 500 },
      fragments: [{ box: { x: 0, y: 0, width: 500, height: 100 }, kind: 'paragraph', lines: [] }],
    }],
    destinations: [],
  }, [], new Set());
  assert.deepEqual(gaps, []);
});

test('analyzeLayout 空页列表返回空', () => {
  assert.deepEqual(analyzeLayout({ pages: [], destinations: [] }, [], new Set()), []);
});

