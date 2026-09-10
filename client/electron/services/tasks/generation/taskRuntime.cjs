// 正文生成任务的运行时支撑：暂停错误、随机抽样、worker 池与小节状态初始化。
// worker 池只依赖注入的回调，不接触任务状态、模型或文件系统，可单独测试。

const crypto = require('node:crypto');

const { AI_QUEUE_SCOPE_PAUSED } = require('./../../../utils/aiRequestQueue.cjs');
const { now } = require('./normalize.cjs');

const CONTENT_GENERATION_PAUSED = 'CONTENT_GENERATION_PAUSED';

const INTERRUPTED_SECTION_ERROR = '上次生成被中断，请继续生成。';

function isAiQueueScopePausedError(error) {
  return error?.code === AI_QUEUE_SCOPE_PAUSED;
}

function isContentGenerationPausedError(error) {
  return error?.code === CONTENT_GENERATION_PAUSED;
}

function isPauseLikeError(error) {
  return isContentGenerationPausedError(error) || isAiQueueScopePausedError(error);
}

function createContentGenerationPausedError() {
  const error = new Error(CONTENT_GENERATION_PAUSED);
  error.code = CONTENT_GENERATION_PAUSED;
  return error;
}

function selectRandomItemIds(itemIds, count) {
  const candidates = [...itemIds];
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const targetIndex = crypto.randomInt(index + 1);
    [candidates[index], candidates[targetIndex]] = [candidates[targetIndex], candidates[index]];
  }
  return candidates.slice(0, count);
}

async function runWorkerPool({ limit, getNextItem, worker, shouldStop, onItemStart, onItemComplete }) {
  const workerCount = Math.max(1, Math.floor(Number(limit) || 1));
  let activeCount = 0;
  let firstError = null;

  async function runWorker() {
    while (true) {
      if (firstError || shouldStop?.()) {
        return;
      }
      const item = getNextItem();
      if (!item) {
        return;
      }

      activeCount += 1;
      onItemStart?.(item, activeCount);
      try {
        const result = await worker(item);
        activeCount -= 1;
        await onItemComplete?.(item, result, activeCount);
      } catch (error) {
        activeCount -= 1;
        if (!firstError) {
          firstError = error;
        }
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  if (firstError) {
    throw firstError;
  }
}

async function runItemsWithWorkerPool(items, limit, worker, shouldStop) {
  const workerCount = Math.min(Math.max(1, Math.floor(Number(limit) || 1)), Math.max(1, items.length));
  let nextIndex = 0;

  await runWorkerPool({
    limit: workerCount,
    shouldStop,
    getNextItem() {
      if (nextIndex >= items.length) {
        return null;
      }
      const item = items[nextIndex];
      nextIndex += 1;
      return item;
    },
    worker,
  });
}

function createInitialSections(leaves, existingSections) {
  const next = { ...(existingSections || {}) };
  const leafIds = new Set(leaves.map(({ item }) => item.id));

  for (const key of Object.keys(next)) {
    if (!leafIds.has(key)) {
      delete next[key];
    }
  }

  for (const { item } of leaves) {
    const existing = next[item.id];
    const interrupted = existing?.status === 'running';
    const content = interrupted ? '' : existing?.content || item.content || '';
    const existingStatus = interrupted ? 'error' : existing?.status;
    next[item.id] = {
      id: item.id,
      title: item.title || '未命名章节',
      status: existingStatus || (content.trim() ? 'success' : 'idle'),
      content,
      error: interrupted ? INTERRUPTED_SECTION_ERROR : existing?.error,
      updated_at: existing?.updated_at,
    };
  }

  return next;
}

function withSection(sections, item, partial) {
  return {
    ...(sections || {}),
    [item.id]: {
      id: item.id,
      title: item.title || '未命名章节',
      status: 'idle',
      content: '',
      ...(sections || {})[item.id],
      ...partial,
      updated_at: now(),
    },
  };
}

module.exports = {
  isAiQueueScopePausedError,
  isContentGenerationPausedError,
  isPauseLikeError,
  createContentGenerationPausedError,
  selectRandomItemIds,
  runItemsWithWorkerPool,
  createInitialSections,
  withSection,
};
