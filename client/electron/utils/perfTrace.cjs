/**
 * 生产路径耗时基线。目标是“先量准再改”：只记录聚合指标，不记录正文、Prompt、文件名或任何凭据。
 *
 * 设计约束：
 * - 记录开销必须是微秒级：只做 performance.now 差值与定长数组写入。
 * - 每个 key 保留固定样本上限，超出后丢最旧样本，内存不会随运行时长增长。
 * - 默认关闭，开发者模式打开时才写环形样本；聚合计数（count/total/max）始终保留，便于随时导出。
 */
const SAMPLE_LIMIT = 60;

const counters = new Map();
const samples = new Map();
let enabled = false;
let startedAt = new Date().toISOString();

function ensureBucket(key) {
  let bucket = counters.get(key);
  if (!bucket) {
    bucket = { key, count: 0, totalMs: 0, maxMs: 0, lastMs: 0, errors: 0, updatedAt: '' };
    counters.set(key, bucket);
    samples.set(key, []);
  }
  return bucket;
}

/** 记录一次耗时。labels 只用于聚合分组，不参与样本存储。 */
function record(scope, name, durationMs, options = {}) {
  const key = `${scope}.${name}`;
  const bucket = ensureBucket(key);
  const value = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  bucket.count += 1;
  bucket.totalMs += value;
  if (value > bucket.maxMs) bucket.maxMs = value;
  bucket.lastMs = value;
  bucket.updatedAt = new Date().toISOString();
  if (options.error) bucket.errors += 1;
  if (!enabled) return value;
  const list = samples.get(key);
  list.push(Math.round(value * 10) / 10);
  if (list.length > SAMPLE_LIMIT) list.shift();
  return value;
}

/** 异步计时：成功与失败各记一次，失败额外累加 errors。 */
async function time(scope, name, runner) {
  const beganAt = performance.now();
  try {
    const value = await runner();
    record(scope, name, performance.now() - beganAt);
    return value;
  } catch (error) {
    record(scope, name, performance.now() - beganAt, { error: true });
    throw error;
  }
}

/** 同步计时：用于 SQLite 写入等会阻塞主进程的路径。 */
function timeSync(scope, name, runner) {
  const beganAt = performance.now();
  try {
    return runner();
  } finally {
    record(scope, name, performance.now() - beganAt);
  }
}

function percentile(list, ratio) {
  if (!list.length) return 0;
  const sorted = list.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

function snapshot() {
  return {
    enabled,
    started_at: startedAt,
    keys: Array.from(counters.values()).map((bucket) => {
      const list = samples.get(bucket.key) || [];
      return {
        ...bucket,
        avgMs: bucket.count ? Math.round((bucket.totalMs / bucket.count) * 10) / 10 : 0,
        p50Ms: percentile(list, 0.5),
        p95Ms: percentile(list, 0.95),
        samples: enabled ? list.slice(-20) : [],
      };
    }).sort((a, b) => b.totalMs - a.totalMs),
  };
}

/** 只保留关心的前 N 项，避免日志和 IPC 被长尾噪声撑大。 */
function summarize(limit = 12) {
  const snap = snapshot();
  return { ...snap, keys: snap.keys.slice(0, limit) };
}

function setEnabled(next) {
  enabled = Boolean(next);
  if (!enabled) samples.forEach((list) => { list.length = 0; });
  return enabled;
}

function reset() {
  counters.clear();
  samples.clear();
  startedAt = new Date().toISOString();
}

module.exports = {
  SAMPLE_LIMIT,
  record,
  reset,
  setEnabled,
  snapshot,
  summarize,
  time,
  timeSync,
};
