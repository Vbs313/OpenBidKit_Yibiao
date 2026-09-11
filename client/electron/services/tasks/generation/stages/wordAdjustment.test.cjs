const test = require('node:test');
const assert = require('node:assert/strict');

const { createWordAdjustmentStage } = require('./wordAdjustment.cjs');
const { countContentWords } = require('./../aiCallContext.cjs');

const EXPAND = (content) => ({ mode: 'expand', granularity: 'paragraph', operations: [{ operation: 'insert', anchor: 'end', content }] });
const SHRINK = (target) => ({ mode: 'shrink', granularity: 'sentence', operations: [{ operation: 'delete', target_text: target }] });

function makeStage(overrides = {}) {
  const state = {
    leaves: [],
    sections: { a: { status: 'success', content: '第一段正文内容' } },
    logs: [],
    contentRuntime: {},
    saved: [],
    published: [],
    devLogs: [],
    pauses: [],
    touched: [],
    runtimeWrites: [],
  };
  const liveState = {
    get leaves() { return state.leaves; },
    get sections() { return state.sections; },
    set sections(value) { state.sections = value; },
    get logs() { return state.logs; },
    get contentRuntime() { return state.contentRuntime; },
    set contentRuntime(value) { state.contentRuntime = value; },
    appendLog: (message) => { state.logs.push(message); },
  };
  const deps = {
    state: liveState,
    aiService: { collectJsonResponse: async () => EXPAND('补充内容') },
    contentStats: {},
    contentConcurrency: 1,
    wordControl: { strictSectionWords: false, sectionWords: 10, sectionMinimumWords: 0, sectionMaximumWords: 0, minimumWords: 0, maximumWords: 0 },
    resume: false,
    targetItemId: '',
    runOnlyIllustrationStage: false,
    globalFacts: [],
    globalFactsMode: 'strict',
    storedPlan: {},
    publishTaskUpdate: (partial) => { state.published.push(partial); },
    statsSnapshot: () => ({ phase: 'adjusting' }),
    pauseIfRequested: (message) => { state.pauses.push(message); },
    isPauseRequested: () => false,
    setWordAdjustmentRuntime: (stage, itemId, round, completedIds, rounds, noProgress, roundStartWords) => {
      state.runtimeWrites.push({ stage, itemId, round, noProgress, roundStartWords });
    },
    getContentPlanForItem: () => ({}),
    getLeafContentForWords: (item) => state.sections[item.id]?.content || '',
    getLeafWordCount: (item) => countContentWords(state.sections[item.id]?.content || ''),
    countTotalContentWords: () => Object.values(state.sections).reduce((sum, section) => sum + countContentWords(section?.content || ''), 0),
    leafWordStats: () => Object.entries(state.sections)
      .filter(([, section]) => section?.status === 'success')
      .map(([id, section]) => ({ item: { id, title: id.toUpperCase() }, words: countContentWords(section.content || '') })),
    rememberTouchedItem: (id) => { state.touched.push(id); },
    saveSection: (item, partial, content) => {
      state.saved.push({ item, partial, content });
      // 与真实 saveSection 同形：写回后同一小节的字数真的会变，后续轮次才能收敛。
      state.sections = { ...state.sections, [item.id]: { ...(state.sections[item.id] || {}), ...partial, content } };
    },
  };
  const merged = { ...deps, ...overrides };
  return { stage: createWordAdjustmentStage(merged), state, contentStats: merged.contentStats };
}

const ITEM = { id: 'a', title: 'A' };

test('requestWordAdjustment 应用操作并落盘', async () => {
  const { stage, state } = makeStage();
  const result = await stage.requestWordAdjustment({ item: ITEM }, {
    mode: 'expand',
    granularity: 'paragraph',
    targetWords: 40,
    maximumChangeWords: 40,
    enforceTotalBounds: false,
  });
  assert.equal(result.currentWords, countContentWords('第一段正文内容'));
  assert.equal(result.nextWords, countContentWords('第一段正文内容\n\n补充内容'));
  assert.ok(result.nextWords > result.currentWords);
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].item.id, 'a');
  assert.ok(state.saved[0].content.includes('补充内容'));
  assert.deepEqual(state.touched, ['a']);
  assert.ok(state.pauses.length >= 1);
});

test('requestWordAdjustment 在扩写没有增加字数时抛错', async () => {
  const { stage, state } = makeStage({
    aiService: {
      collectJsonResponse: async () => ({
        mode: 'expand',
        granularity: 'paragraph',
        operations: [{ operation: 'replace', target_text: '第一段正文内容', content: '第二段文字内容' }],
      }),
    },
  });
  await assert.rejects(
    () => stage.requestWordAdjustment({ item: ITEM }, { mode: 'expand', granularity: 'paragraph', targetWords: 40, maximumChangeWords: 40, enforceTotalBounds: false }),
    /扩写后字数没有增加/,
  );
  assert.equal(state.saved.length, 0);
});

test('requestWordAdjustment 在缩写不达标时抛错', async () => {
  const { stage } = makeStage({
    aiService: { collectJsonResponse: async () => SHRINK('不存在的原文') },
  });
  await assert.rejects(
    () => stage.requestWordAdjustment({ item: ITEM }, { mode: 'shrink', granularity: 'sentence', targetWords: 1, maximumChangeWords: 40, enforceTotalBounds: false }),
    /精确唯一命中|缩写后字数没有减少/,
  );
});

test('requestWordAdjustment 超过本轮额度时抛错', async () => {
  const { stage } = makeStage({ aiService: { collectJsonResponse: async () => EXPAND('补充内容') } });
  await assert.rejects(
    () => stage.requestWordAdjustment({ item: ITEM }, { mode: 'expand', granularity: 'paragraph', targetWords: 40, maximumChangeWords: 1, enforceTotalBounds: false }),
    /超过允许额度/,
  );
});

test('adjustSectionToRange 已在范围内时直接返回 true', async () => {
  const { stage } = makeStage({
    wordControl: { strictSectionWords: true, sectionWords: 5, sectionMinimumWords: 3, sectionMaximumWords: 10, minimumWords: 0, maximumWords: 0 },
    aiService: { collectJsonResponse: async () => { throw new Error('不应调用模型'); } },
  });
  const result = await stage.adjustSectionToRange({ item: ITEM }, 'section', {}, []);
  assert.equal(result, true);
});

test('runSectionWordAdjustments 未开启强控小节字数时直接返回空', async () => {
  const { stage } = makeStage();
  const result = await stage.runSectionWordAdjustments([{ item: ITEM }], 'section');
  assert.deepEqual(result, []);
});

test('runSectionWordAdjustments 调整失败后把小节列入未解决', async () => {
  const { stage, state, contentStats } = makeStage({
    wordControl: { strictSectionWords: true, sectionWords: 10, sectionMinimumWords: 8, sectionMaximumWords: 12, minimumWords: 0, maximumWords: 0 },
    aiService: { collectJsonResponse: async () => { throw new Error('模型失败'); } },
  });
  const result = await stage.runSectionWordAdjustments([{ item: ITEM }], 'section');
  assert.deepEqual(result, ['a']);
  assert.equal(contentStats.phase, 'section-word-adjusting');
  assert.equal(contentStats.section_adjustment_total, 1);
  assert.ok(state.logs.some((m) => m.includes('调整小节字数：a A，第 1/3 轮')));
  assert.ok(state.logs.some((m) => m.includes('小节字数第 3 轮调整未应用')));
  assert.equal(state.runtimeWrites.length >= 1, true);
});

test('runTotalWordAdjustments 没有全文上下限时直接返回', async () => {
  const { stage, contentStats } = makeStage();
  const returned = await stage.runTotalWordAdjustments();
  assert.equal(returned, undefined);
  assert.equal(contentStats.phase, undefined);
});

test('runTotalWordAdjustments 指定目标小节时直接返回', async () => {
  const { stage, contentStats } = makeStage({ targetItemId: 'a', wordControl: { strictSectionWords: false, sectionWords: 10, sectionMinimumWords: 0, sectionMaximumWords: 0, minimumWords: 100, maximumWords: 0 } });
  await stage.runTotalWordAdjustments();
  assert.equal(contentStats.phase, undefined);
});

test('runTotalWordAdjustments 扩写一轮后达标即结束', async () => {
  const { stage, state, contentStats } = makeStage({
    wordControl: { strictSectionWords: false, sectionWords: 10, sectionMinimumWords: 0, sectionMaximumWords: 0, minimumWords: 20, maximumWords: 0 },
    // 基础正文 7 字、下限 20 字，本轮预算 13 字；补 13 字正好达标且不超额度。
    aiService: { collectJsonResponse: async () => EXPAND('补充内容一二三四五六七八九') },
  });
  await stage.runTotalWordAdjustments();
  assert.equal(contentStats.phase, 'total-word-adjusting');
  assert.equal(contentStats.total_adjustment_mode, 'expand');
  assert.equal(contentStats.total_adjustment_round, 1);
  assert.equal(state.saved.length, 1);
  assert.ok(state.logs.some((m) => m.includes('全文扩写已提交')));
  assert.ok(state.runtimeWrites.some((write) => write.stage === 'total'));
});
