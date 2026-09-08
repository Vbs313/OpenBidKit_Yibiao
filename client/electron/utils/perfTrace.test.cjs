const assert = require('node:assert/strict');
const test = require('node:test');
const perfTrace = require('./perfTrace.cjs');

test('perfTrace aggregates counts, totals and percentiles without unbounded growth', async () => {
  perfTrace.reset();
  assert.equal(perfTrace.setEnabled(true), true);

  for (let i = 1; i <= 200; i += 1) perfTrace.record('demo', 'op', i);
  let snap = perfTrace.snapshot();
  let bucket = snap.keys.find((item) => item.key === 'demo.op');
  assert.equal(bucket.count, 200);
  assert.equal(bucket.maxMs, 200);
  // 快照只导出最近 20 条样本，避免 IPC 体积随运行时长增长；环形缓冲上限仍为 SAMPLE_LIMIT。
  assert.equal(bucket.samples.length, 20, '快照样本数必须封顶在最近 20 条');
  assert.ok(perfTrace.SAMPLE_LIMIT >= 20);

  perfTrace.record('demo', 'op', 5, { error: true });
  snap = perfTrace.snapshot();
  bucket = snap.keys.find((item) => item.key === 'demo.op');
  assert.equal(bucket.errors, 1);

  assert.equal(await perfTrace.time('demo', 'async_ok', async () => 42), 42);
  assert.equal(perfTrace.snapshot().keys.find((item) => item.key === 'demo.async_ok').count, 1);
  await assert.rejects(() => perfTrace.time('demo', 'async_fail', async () => { throw new Error('boom'); }), /boom/);
  const failed = perfTrace.snapshot().keys.find((item) => item.key === 'demo.async_fail');
  assert.equal(failed.count, 1);
  assert.equal(failed.errors, 1);

  assert.equal(perfTrace.timeSync('demo', 'sync_ok', () => 'v'), 'v');
  assert.throws(() => perfTrace.timeSync('demo', 'sync_fail', () => { throw new Error('sync boom'); }), /sync boom/);
  assert.equal(perfTrace.snapshot().keys.find((item) => item.key === 'demo.sync_fail').errors, 0, '同步计时不标错，只记录耗时');

  const top = perfTrace.summarize(2);
  assert.equal(top.keys.length, 2);
  assert.ok(top.keys[0].totalMs >= top.keys[1].totalMs, 'summarize 需按总耗时降序');

  perfTrace.setEnabled(false);
  perfTrace.record('demo', 'after_off', 12);
  snap = perfTrace.snapshot();
  bucket = snap.keys.find((item) => item.key === 'demo.after_off');
  assert.equal(bucket.count, 1);
  assert.deepEqual(bucket.samples, [], '关闭采样后不应保留样本明细');
  assert.equal(perfTrace.snapshot().enabled, false);
});
