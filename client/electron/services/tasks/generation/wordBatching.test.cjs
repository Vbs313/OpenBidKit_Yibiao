const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('./wordBatching.cjs');

const wc = (over = {}) => ({
  minimumWords: 1000,
  maximumWords: 2000,
  sectionWords: 100,
  strictSectionWords: false,
  sectionMinimumWords: 80,
  sectionMaximumWords: 120,
  ...over,
});

test('isSectionWordsOutsideRange 只在强控小节字数时判定越界', () => {
  const strict = wc({ strictSectionWords: true });
  assert.equal(W.isSectionWordsOutsideRange(strict, 79), true);
  assert.equal(W.isSectionWordsOutsideRange(strict, 80), false);
  assert.equal(W.isSectionWordsOutsideRange(strict, 120), false);
  assert.equal(W.isSectionWordsOutsideRange(strict, 121), true);

  const loose = wc({ strictSectionWords: false });
  assert.equal(W.isSectionWordsOutsideRange(loose, 0), false);
  assert.equal(W.isSectionWordsOutsideRange(loose, 99999), false);
});

test('getTotalWordDirection 只在设置了全文上下限时给出方向', () => {
  assert.equal(W.getTotalWordDirection(wc({ minimumWords: 0, maximumWords: 0 }), 900), null);
  assert.deepEqual(W.getTotalWordDirection(wc(), 900), { mode: 'expand', currentWords: 900, targetWords: 1000 });
  assert.deepEqual(W.getTotalWordDirection(wc(), 2100), { mode: 'shrink', currentWords: 2100, targetWords: 2000 });
  assert.equal(W.getTotalWordDirection(wc(), 1500), null);
  assert.deepEqual(W.getTotalWordDirection(wc({ minimumWords: 0 }), 2100), { mode: 'shrink', currentWords: 2100, targetWords: 2000 });
});

test('buildTotalWordAdjustmentBatch 扩写按小节指导缺口分配预算', () => {
  const expandWc = wc({ sectionWords: 100, strictSectionWords: false });
  const batch = W.buildTotalWordAdjustmentBatch(
    expandWc,
    [{ words: 0 }, { words: 0 }],
    { mode: 'expand', currentWords: 0, targetWords: 200 },
    2,
  );
  assert.deepEqual(batch, [
    { context: { words: 0 }, budget: 100, guidanceWords: 100 },
    { context: { words: 0 }, budget: 100, guidanceWords: 100 },
  ]);
});

test('buildTotalWordAdjustmentBatch 扩写受 slotCount 限制', () => {
  const expandWc = wc({ sectionWords: 100, strictSectionWords: false });
  const batch = W.buildTotalWordAdjustmentBatch(
    expandWc,
    [{ words: 0 }, { words: 0 }, { words: 0 }],
    { mode: 'expand', currentWords: 0, targetWords: 100 },
    2,
  );
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map((entry) => entry.budget), [50, 50]);
});

test('buildTotalWordAdjustmentBatch 扩写在强控时受小节上限约束', () => {
  const strict = wc({ sectionWords: 500, strictSectionWords: true, sectionMaximumWords: 120 });
  const batch = W.buildTotalWordAdjustmentBatch(
    strict,
    [{ words: 100, id: 'a' }, { words: 100, id: 'b' }],
    { mode: 'expand', currentWords: 200, targetWords: 1400 },
    2,
  );
  // 每节最多补到 sectionMaximumWords：capacity = 20
  assert.deepEqual(batch.map((entry) => entry.budget), [20, 20]);
});

test('buildTotalWordAdjustmentBatch 缩写：强控单节最多减 25%', () => {
  const strict = wc({ strictSectionWords: true, sectionMinimumWords: 0 });
  const batch = W.buildTotalWordAdjustmentBatch(
    strict,
    [{ words: 100, id: 'a' }],
    { mode: 'shrink', currentWords: 100, targetWords: 0 },
    1,
  );
  assert.equal(batch.length, 1);
  assert.equal(batch[0].budget, 25);
  assert.equal(batch[0].guidanceWords, 0);
});

test('buildTotalWordAdjustmentBatch 缩写：非强控只受可读空间限制', () => {
  const loose = wc({ strictSectionWords: false });
  const batch = W.buildTotalWordAdjustmentBatch(
    loose,
    [{ words: 100, id: 'a' }],
    { mode: 'shrink', currentWords: 100, targetWords: 0 },
    1,
  );
  assert.equal(batch.length, 1);
  assert.equal(batch[0].budget, 99);
});

test('buildTotalWordAdjustmentBatch 缩写受 slotCount 限制', () => {
  const strict = wc({ strictSectionWords: true, sectionMinimumWords: 0 });
  const batch = W.buildTotalWordAdjustmentBatch(
    strict,
    [{ words: 100 }, { words: 100 }, { words: 100 }],
    { mode: 'shrink', currentWords: 300, targetWords: 0 },
    2,
  );
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map((entry) => entry.budget), [25, 25]);
});

test('buildTotalWordAdjustmentBatch 没有预算需求时返回空数组', () => {
  const expandWc = wc({ sectionWords: 100 });
  assert.deepEqual(
    W.buildTotalWordAdjustmentBatch(expandWc, [{ words: 0 }], { mode: 'expand', currentWords: 0, targetWords: 0 }, 1),
    [],
  );
  assert.deepEqual(
    W.buildTotalWordAdjustmentBatch(wc(), [{ words: 0 }], { mode: 'shrink', currentWords: 0, targetWords: 0 }, 1),
    [],
  );
});