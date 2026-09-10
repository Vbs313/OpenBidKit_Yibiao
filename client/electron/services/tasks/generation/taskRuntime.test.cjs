const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('./taskRuntime.cjs');

test('暂停错误判定区分队列暂停与正文暂停', () => {
  const queue = Object.assign(new Error('q'), { code: 'AI_QUEUE_SCOPE_PAUSED' });
  const paused = T.createContentGenerationPausedError();
  assert.equal(T.isAiQueueScopePausedError(queue), true);
  assert.equal(T.isAiQueueScopePausedError(paused), false);
  assert.equal(T.isContentGenerationPausedError(paused), true);
  assert.equal(T.isContentGenerationPausedError(queue), false);
  assert.equal(T.isPauseLikeError(queue), true);
  assert.equal(T.isPauseLikeError(paused), true);
  assert.equal(T.isPauseLikeError(new Error('x')), false);
  assert.equal(T.isPauseLikeError(null), false);
  assert.equal(T.isPauseLikeError(undefined), false);
});

test('createContentGenerationPausedError 带上稳定 code', () => {
  const error = T.createContentGenerationPausedError();
  assert.equal(error.message, 'CONTENT_GENERATION_PAUSED');
  assert.equal(error.code, 'CONTENT_GENERATION_PAUSED');
  assert.equal(T.isContentGenerationPausedError(error), true);
});

test('selectRandomItemIds 无放回抽样', () => {
  const picked = T.selectRandomItemIds(['a', 'b', 'c', 'd'], 2);
  assert.equal(picked.length, 2);
  assert.equal(new Set(picked).size, 2);
  for (const id of picked) assert.ok(['a', 'b', 'c', 'd'].includes(id));
  assert.deepEqual([...T.selectRandomItemIds(['a'], 5)], ['a']);
  assert.deepEqual(T.selectRandomItemIds(['a', 'b'], 0), []);
  assert.deepEqual(T.selectRandomItemIds([], 3), []);
});

test('runItemsWithWorkerPool 跑完全部条目且不超并发上限', async () => {
  const seen = [];
  await T.runItemsWithWorkerPool([1, 2, 3, 4], 2, async (n) => { seen.push(n); });
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4]);

  let active = 0;
  let peak = 0;
  await T.runItemsWithWorkerPool([1, 2, 3, 4, 5, 6], 2, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  assert.equal(peak, 2);

  await T.runItemsWithWorkerPool([], 3, async () => { throw new Error('不该被执行'); });
});

test('runItemsWithWorkerPool 传播错误并在 shouldStop 后停手', async () => {
  await assert.rejects(
    () => T.runItemsWithWorkerPool([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); }),
    /boom/,
  );

  const done = [];
  let stop = false;
  await T.runItemsWithWorkerPool([1, 2, 3, 4], 1, async (n) => { done.push(n); if (n === 1) stop = true; }, () => stop);
  assert.deepEqual(done, [1]);
});

test('runItemsWithWorkerPool 把非法 limit 兜底成 1', async () => {
  const seen = [];
  await T.runItemsWithWorkerPool([1, 2], 0, async (n) => { seen.push(n); });
  assert.deepEqual([...seen].sort(), [1, 2]);
});

test('createInitialSections 复用已有小节、补齐缺失、丢掉非叶子', () => {
  const leaves = [{ item: { id: 'a', title: 'A' } }, { item: { id: 'b', title: 'B' } }, { item: { id: 'c' } }];
  const existing = {
    a: { status: 'success', content: '已有' },
    b: { status: 'running', content: '半截' },
    z: { status: 'idle' },
  };
  const sections = T.createInitialSections(leaves, existing);
  assert.deepEqual(Object.keys(sections).sort(), ['a', 'b', 'c']);

  assert.equal(sections.a.status, 'success');
  assert.equal(sections.a.content, '已有');
  assert.equal(sections.a.title, 'A');

  assert.equal(sections.b.status, 'error');
  assert.equal(sections.b.content, '');
  assert.equal(sections.b.error, '上次生成被中断，请继续生成。');

  assert.equal(sections.c.status, 'idle');
  assert.equal(sections.c.content, '');
  assert.equal(sections.c.title, '未命名章节');

  assert.deepEqual(Object.keys(T.createInitialSections([], { a: {} })), []);
});

test('createInitialSections 依据已有正文推断 success', () => {
  const sections = T.createInitialSections([{ item: { id: 'a', content: ' 已有正文 ' } }], {});
  assert.equal(sections.a.status, 'success');
  assert.equal(sections.a.content, ' 已有正文 ');
});

test('withSection 合并小节并刷新时间戳', () => {
  const before = { a: { status: 'success', content: 'x' } };
  const result = T.withSection(before, { id: 'b', title: 'B' }, { status: 'running' });
  assert.deepEqual(Object.keys(result).sort(), ['a', 'b']);
  assert.equal(result.a.status, 'success');
  assert.equal(result.b.id, 'b');
  assert.equal(result.b.title, 'B');
  assert.equal(result.b.status, 'running');
  assert.equal(result.b.content, '');
  assert.equal(typeof result.b.updated_at, 'string');

  const merged = T.withSection({ b: { content: '旧内容', custom: 1 } }, { id: 'b', title: 'B' }, { status: 'success' });
  assert.equal(merged.b.content, '旧内容');
  assert.equal(merged.b.custom, 1);
  assert.equal(merged.b.status, 'success');
  assert.deepEqual(Object.keys(T.withSection(null, { id: 'x' }, {})), ['x']);
});