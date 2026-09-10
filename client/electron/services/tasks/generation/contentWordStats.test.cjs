const test = require('node:test');
const assert = require('node:assert/strict');

const { createContentWordStats } = require('./contentWordStats.cjs');

function makeStats({ leaves = [], sections = {}, wordControl = {}, contentStats = {} } = {}) {
  const state = { leaves, sections, totalContentWords: 0 };
  const contentWordCounts = new Map();
  const generationCompletedItemIds = new Set();
  const stats = createContentWordStats({
    contentStats,
    wordControl,
    contentWordCounts,
    generationCompletedItemIds,
    getLeaves: () => state.leaves,
    getSections: () => state.sections,
    getTotalContentWords: () => state.totalContentWords,
    setTotalContentWords: (value) => { state.totalContentWords = value; },
  });
  return { stats, state, contentWordCounts, generationCompletedItemIds, contentStats, wordControl };
}

test('工厂创建时即按现有小节重建字数索引', () => {
  const { stats, contentWordCounts } = makeStats({
    leaves: [{ item: { id: 'a' } }, { item: { id: 'b' } }],
    sections: { a: { status: 'success', content: '你好世界' }, b: { status: 'success', content: 'hello world' } },
  });
  assert.equal(stats.getLeafWordCount({ id: 'a' }), 4);
  assert.equal(stats.getLeafWordCount({ id: 'b' }), 2);
  assert.equal(stats.countTotalContentWords(), 6);
  assert.equal(contentWordCounts.size, 2);
});

test('getLeafContentForWords 优先小节正文，忽略小节返回空串', () => {
  const { stats } = makeStats({
    leaves: [{ item: { id: 'a', content: '来自大纲' } }, { item: { id: 'b', content: '来自大纲' } }, { item: { id: 'c', content: '来自大纲' } }],
    sections: {
      a: { status: 'success', content: '小节正文' },
      b: { status: 'ignored', content: '被忽略的正文' },
      c: { status: 'idle' },
      d: { status: 'idle', content: '' },
    },
  });
  assert.equal(stats.getLeafContentForWords({ id: 'a', content: '来自大纲' }), '小节正文');
  assert.equal(stats.getLeafContentForWords({ id: 'b', content: '来自大纲' }), '');
  assert.equal(stats.getLeafContentForWords({ id: 'c', content: '来自大纲' }), '来自大纲');
  assert.equal(stats.getLeafContentForWords({ id: 'd', content: '来自大纲' }), '');
  assert.equal(stats.getLeafContentForWords({ id: 'nope', content: '来自大纲' }), '来自大纲');
});

test('updateContentWordCount 增量维护单节与全文累计字数', () => {
  const { stats, contentWordCounts } = makeStats();
  assert.equal(stats.updateContentWordCount('a', '你好'), 2);
  assert.equal(stats.countTotalContentWords(), 2);
  assert.equal(contentWordCounts.get('a'), 2);

  assert.equal(stats.updateContentWordCount('b', 'hello'), 1);
  assert.equal(stats.countTotalContentWords(), 3);

  // 同一小节改写只补差额
  assert.equal(stats.updateContentWordCount('a', '你好世界'), 4);
  assert.equal(stats.countTotalContentWords(), 5);
});

test('rebuildContentWordCounts 丢弃旧索引并按当前小节重建', () => {
  const { stats, state } = makeStats();
  stats.updateContentWordCount('stale', '旧内容');
  assert.equal(stats.countTotalContentWords(), 3);

  state.leaves = [{ item: { id: 'a' } }];
  state.sections = { a: { status: 'success', content: '一二三' } };
  stats.rebuildContentWordCounts();

  assert.equal(stats.getLeafWordCount({ id: 'a' }), 3);
  assert.equal(stats.getLeafWordCount({ id: 'stale' }), 0);
  assert.equal(stats.countTotalContentWords(), 3);
});

test('leafWordStats 把正文与字数合并进上下文', () => {
  const { stats } = makeStats({
    leaves: [{ item: { id: 'a', title: 'A' }, parentChapters: [] }],
    sections: { a: { status: 'success', content: '你好世界' } },
  });
  const rows = stats.leafWordStats();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item.title, 'A');
  assert.equal(rows[0].content, '你好世界');
  assert.equal(rows[0].words, 4);
});

test('statsSnapshot 写入 contentStats 并返回 content 快照', () => {
  const { stats, contentStats, generationCompletedItemIds } = makeStats({
    leaves: [{ item: { id: 'a' } }, { item: { id: 'b' } }, { item: { id: 'c' } }],
    sections: {
      a: { status: 'success', content: '你好' },
      b: { status: 'ignored', content: '' },
      c: { status: 'success', content: 'hello world' },
    },
    wordControl: { minimumWords: 1000, maximumWords: 2000, sectionWords: 300, strictSectionWords: true },
  });
  generationCompletedItemIds.add('a');
  generationCompletedItemIds.add('c');

  const snapshot = stats.statsSnapshot();
  assert.equal(contentStats.generation_completed, 2);
  assert.equal(contentStats.current_words, 4);
  assert.equal(contentStats.minimum_words, 1000);
  assert.equal(contentStats.maximum_words, 2000);
  assert.equal(contentStats.section_words, 300);
  assert.equal(contentStats.strict_section_words, true);
  assert.equal(contentStats.ignored_section_count, 1);

  assert.deepEqual(snapshot, { content: { ...contentStats } });
  // 返回的是快照，后续统计变更不影响已返回对象
  const before = snapshot.content.current_words;
  stats.updateContentWordCount('a', '你好世界你好世界');
  assert.equal(snapshot.content.current_words, before);
});

test('空小节集合下统计归零', () => {
  const { stats } = makeStats();
  assert.equal(stats.countTotalContentWords(), 0);
  assert.deepEqual(stats.leafWordStats(), []);
  assert.equal(stats.statsSnapshot().content.current_words, 0);
});