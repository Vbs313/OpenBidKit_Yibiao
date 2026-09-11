const DEFAULT_CONTEXT_LENGTH_LIMIT = 400000;
const KNOWLEDGE_CONTEXT_LIMIT_RATIO = 0.62;
const TASK_AND_ITEMS_RESERVE_RATIO = 0.34;
const PROMPT_CACHE_WARMUP_DELAY_MS = 1500;

// 知识库流水线的纯文本工具：提示词消息构造、候选/条目合并、匹配结果归一、报告生成等。
//
// 这些原本散落在 knowledgeBaseService.cjs 顶部；搬出来后 service 只保留文件与模型编排。

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  renderBlocksForPrompt,
  packBlocksIntoSegments,
  normalizeRanges,
  expandRanges,
} = require('./blockPipeline.cjs');

function now() {
  return new Date().toISOString();
}

/** 等待服务商写入提示词前缀缓存后再 fan-out */
function waitForPromptCacheWarmup() {
  return new Promise((resolve) => setTimeout(resolve, PROMPT_CACHE_WARMUP_DELAY_MS));
}

/** 并发执行任务，全部结束后若有失败则抛出首个错误 */
async function runParallelAndThrowAfterSettled(taskFns) {
  const results = await Promise.allSettled((taskFns || []).map((fn) => fn()));
  const rejected = results.find((item) => item.status === 'rejected');
  if (rejected) {
    throw rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason || '并发分段失败'));
  }
  return results.map((item) => item.value);
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function safeName(name) {
  return String(name || '未命名').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').trim() || '未命名';
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function getDebugLogsDir(app) {
  return path.join(app.getPath('userData'), 'logs', 'knowledge-base');
}

function getDebugLogPath(app, documentId) {
  return path.join(getDebugLogsDir(app), `${safeName(documentId)}.jsonl`);
}

function fromRelative(baseDir, relativePath) {
  return path.join(baseDir, relativePath || '');
}

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function rebaseDocumentRelativePath(value, oldDocumentDir, newDocumentDir) {
  const normalized = normalizeRelativePath(value);
  const oldPrefix = normalizeRelativePath(oldDocumentDir).replace(/\/+$/, '');
  const nextPrefix = normalizeRelativePath(newDocumentDir).replace(/\/+$/, '');
  if (normalized === oldPrefix) return nextPrefix;
  if (normalized.startsWith(`${oldPrefix}/`)) return `${nextPrefix}${normalized.slice(oldPrefix.length)}`;
  return normalizeRelativePath(path.join(nextPrefix, path.basename(normalized)));
}

function getPromptSummary(messages) {
  return (messages || []).map((message, index) => ({
    index: index + 1,
    role: message.role,
    chars: String(message.content || '').length,
  }));
}

function getItemSample(items) {
  return (items || []).slice(0, 8).map((item) => ({
    id: item.id,
    title: item.title,
    summary_chars: String(item.summary || item.resume || '').length,
  }));
}

function getMatchSummary(matches) {
  return (matches || []).map((match) => ({
    id: match.id,
    range_count: match.ranges?.length || 0,
    block_count: match.block_ids?.length || 0,
  }));
}

function stripMarkdownFence(content) {
  return String(content || '').replace(/^```[\s\S]*?\n/, '').replace(/```$/g, '').trim();
}

/** 估算 messages 总字符（role + content + 少量开销） */
function getMessagesContentLength(messages) {
  return (messages || []).reduce((sum, message) => (
    sum + String(message?.role || 'user').length + String(message?.content || '').length + 64
  ), 0);
}

/** 计算本段可塞入的用户不可控正文上限 */
function getKnowledgeBaseSegmentLimit(aiService, fixedMessages) {
  const config = typeof aiService?.getConfig === 'function' ? aiService.getConfig() : {};
  const rawLimit = Number(config?.context_length_limit);
  const contextLengthLimit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.floor(rawLimit)
    : DEFAULT_CONTEXT_LENGTH_LIMIT;
  const requestBudget = Math.floor(contextLengthLimit * KNOWLEDGE_CONTEXT_LIMIT_RATIO);
  return Math.max(1, requestBudget - getMessagesContentLength(fixedMessages));
}

/** 将 block 按渲染长度连续打包成段（不拆单 block） */

/** 将条目按 JSON 渲染长度打包成段（仅条目超预算时兜底） */

/** 合并同 id 的匹配 ranges / block_ids */
function mergeMatchResults(matchLists) {
  const byId = new Map();
  for (const match of (matchLists || []).flat()) {
    if (!match?.id) continue;
    const current = byId.get(match.id) || { id: match.id, ranges: [], block_ids: [] };
    if (Array.isArray(match.ranges)) current.ranges.push(...match.ranges);
    if (Array.isArray(match.block_ids)) current.block_ids.push(...match.block_ids);
    byId.set(match.id, current);
  }
  return [...byId.values()].map((match) => ({
    id: match.id,
    ranges: match.ranges,
    block_ids: [...new Set(match.block_ids)],
  }));
}

/** 补漏多子批时，每个 block 只保留一种归属：matches > new_items > discarded */

function renderCandidateItemsJson(items) {
  return JSON.stringify(
    (items || []).map(({ title, summary }) => ({ title, summary })),
    null,
    2,
  );
}

function renderKnowledgeItemsJson(items) {
  return JSON.stringify(
    (items || []).map(({ id, title, summary }) => ({ id, title, summary })),
    null,
    2,
  );
}

function normalizeCandidateItems(parsed) {
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    title: String(item?.title || '').trim(),
    summary: String(item?.summary || item?.resume || '').trim(),
  })).filter((item) => item.title && item.summary);
}

function validateCandidateItems(value) {
  if (!Array.isArray(value?.items)) {
    throw new Error('AI 返回结果缺少 items 数组');
  }
}

/** 分段提取结果按标题去重合并（仅 title/summary，不含 id） */
function mergeTitleSummaryItems(itemLists) {
  const merged = [];
  const seen = new Set();
  for (const item of (itemLists || []).flat()) {
    const title = String(item?.title || '').trim();
    const summary = String(item?.summary || item?.resume || '').trim();
    const key = title.replace(/\s+/g, '').toLowerCase();
    if (!key || !summary || seen.has(key)) continue;
    seen.add(key);
    merged.push({ title, summary });
  }
  return merged;
}

function mergeCandidateItems(firstItems, supplementItems) {
  const merged = [];
  const seen = new Set();
  for (const item of [...firstItems, ...supplementItems]) {
    const key = item.title.replace(/\s+/g, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({
      id: `K${String(merged.length + 1).padStart(6, '0')}`,
      title: item.title,
      summary: item.summary,
    });
  }
  return merged;
}

/**
 * L1：本段 block 前缀（跨提取/补充/匹配必须字节级一致，才能吃到 block 缓存）
 * 引导句固定，段号写入 L1 时三步共用同一 segmentMeta
 */
function buildDocumentBlocksPrefixMessage(blockText, segmentMeta = null) {
  const segmentLine = segmentMeta?.total > 1
    ? `当前是第 ${segmentMeta.index}/${segmentMeta.total} 段。`
    : '当前文档仅此一段。';
  return {
    role: 'user',
    content: [
      '以下是接下来要处理的主要内容 block 列表，请先完整阅读理解。',
      '只能使用本段出现的 block id；不要假设未见过的其它段内容。',
      segmentLine,
      '<document_blocks>',
      blockText,
      '</document_blocks>',
    ].join('\n'),
  };
}

/** L1'：遗漏 block 前缀（补漏独立 pack，不与全文段混用） */
function buildMissingBlocksPrefixMessage(missingBlocks, segmentMeta = null) {
  const segmentLine = segmentMeta?.total > 1
    ? `当前是第 ${segmentMeta.index}/${segmentMeta.total} 段遗漏 block。`
    : '以下是当前需要处理的遗漏 block。';
  return {
    role: 'user',
    content: [
      '以下是接下来要处理的遗漏 block 列表，请先完整阅读理解。',
      '必须覆盖本段收到的全部遗漏 block；只能使用本段出现的 block id。',
      segmentLine,
      '<missing_blocks>',
      renderBlocksForPrompt(missingBlocks),
      '</missing_blocks>',
    ].join('\n'),
  };
}

/** L2：首次提取任务 */
function buildInitialItemTaskMessage(documentName) {
  return {
    role: 'user',
    content: [
      `文档名：${documentName}`,
      '你是投标资料知识库分析助手。你只负责从历史投标资料中提取对后续编写标书有复用价值的知识条目。',
      '任务：基于上文已给出的本段 block，提取有意义的知识条目数组。条目应覆盖技术方案、项目管理、质量、安全、进度、服务、应急、人员设备、类似业绩等可复用内容。',
      '本段没有可复用知识时必须返回 {"items":[]}。',
      '只返回 JSON：{"items":[{"title":"","summary":""}]}',
      '要求：title 简洁明确；summary 说明该条目可如何用于编写投标文件；不要输出 id、content、段落编号、Markdown 或解释文字。',
    ].join('\n'),
  };
}

function buildInitialItemMessages(documentName, blockText, segmentMeta = null) {
  return [
    buildDocumentBlocksPrefixMessage(blockText, segmentMeta),
    buildInitialItemTaskMessage(documentName),
  ];
}

/** L2：补充遗漏任务 + 完整首轮条目 */
function buildSupplementItemTaskMessage(documentName, firstItems) {
  return {
    role: 'user',
    content: [
      `文档名：${documentName}`,
      '你是投标资料知识库补漏助手。你只判断已有知识条目是否遗漏了重要主题，并补充缺失条目。',
      'first_round_items 是全文已有结果，不要重复首轮已有条目。',
      '任务：基于上文本段 block，只输出本段可见且首轮未覆盖的新增条目；如果没有遗漏，返回空 items 数组。',
      '只返回 JSON：{"items":[{"title":"","summary":""}]}',
      '如果没有新增条目，必须返回 {"items":[]}，这属于正常结果。',
      '不要重复已有条目，不要输出 id、content、段落编号、Markdown 或解释文字。',
      '',
      '<first_round_items>',
      renderCandidateItemsJson(firstItems),
      '</first_round_items>',
    ].join('\n'),
  };
}

function buildSupplementItemMessages(documentName, blockText, firstItems, segmentMeta = null) {
  return [
    buildDocumentBlocksPrefixMessage(blockText, segmentMeta),
    buildSupplementItemTaskMessage(documentName, firstItems),
  ];
}

/** L2：匹配任务 + 条目 */
function buildMatchTaskMessage(documentName, batchItems) {
  return {
    role: 'user',
    content: [
      `文档名：${documentName}`,
      '你是投标知识库段落匹配助手。你只根据知识条目的标题和摘要，为其匹配强相关 block 范围。',
      '规则：',
      '1. 只处理本次给出的知识条目。',
      '2. 只匹配与条目强相关、可直接支撑该条目的 block（基于上文本段 block）。',
      '3. 如果某些 block 更可能属于其他主题或条目，不要强行匹配。',
      '4. 只返回 id 和 ranges，不要输出正文，不要解释。',
      '5. ranges 使用闭区间：["P000001","P000003"] 表示连续 block；单个 block 写成 ["P000001","P000001"]。',
      '6. 只允许使用本段存在的 block 编号和本次条目 id。',
      '输出 JSON：{"matches":[{"id":"K000001","ranges":[["P000001","P000003"]]}]}',
      '',
      '以下是本次需要匹配的知识条目。只处理这些条目：',
      renderKnowledgeItemsJson(batchItems),
    ].join('\n'),
  };
}

/** 匹配：block 前缀在前，任务+条目在后（item-split 仅改 L2 条目，L1 不变） */
function buildMatchMessages(documentName, blockText, batchItems, segmentMeta = null) {
  return [
    buildDocumentBlocksPrefixMessage(blockText, segmentMeta),
    buildMatchTaskMessage(documentName, batchItems),
  ];
}

/** L2：补漏任务 + 条目 */
function buildRecoveryTaskMessage(documentName, items) {
  return {
    role: 'user',
    content: [
      `文档名：${documentName}`,
      '你是投标知识库遗漏段落补漏助手。必须把上文收到的遗漏 block 明确归入已有条目、新增条目或舍弃段落。',
      '任务：必须覆盖所有遗漏 block。每个遗漏 block 只能进入以下三类之一：',
      '1. matches：归入已有知识条目，只返回已有 id 和 ranges。',
      '2. new_items：如果没有合适的已有条目但内容有复用价值，则新增知识条目，并给出 title、summary、ranges。',
      '3. discarded：如果内容质量低、重复、格式残留或无投标复用价值，则推荐舍弃，并给出 reason。',
      '输出 JSON：{"matches":[{"id":"K000001","ranges":[["P000001","P000003"]]}],"new_items":[{"title":"","summary":"","ranges":[["P000004","P000005"]]}],"discarded":[{"ranges":[["P000006","P000006"]],"reason":""}]}',
      '不要输出正文、Markdown 或解释文字。',
      '只能使用本段存在的 block 编号和本次给出的条目 id。',
      '',
      '<knowledge_items>',
      renderKnowledgeItemsJson(items),
      '</knowledge_items>',
    ].join('\n'),
  };
}

/** 补漏：missing 前缀在前，任务+条目在后 */
function buildRecoveryMessages(documentName, items, missingBlocks, segmentMeta = null) {
  return [
    buildMissingBlocksPrefixMessage(missingBlocks, segmentMeta),
    buildRecoveryTaskMessage(documentName, items),
  ];
}

function getRequestBudget(aiService) {
  const config = typeof aiService?.getConfig === 'function' ? aiService.getConfig() : {};
  const rawLimit = Number(config?.context_length_limit);
  const contextLengthLimit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.floor(rawLimit)
    : DEFAULT_CONTEXT_LENGTH_LIMIT;
  return Math.floor(contextLengthLimit * KNOWLEDGE_CONTEXT_LIMIT_RATIO);
}

/**
 * 统一 block 分段（策略 B）：提取前按保守预留切一次，提取/补充/匹配共用同一段表
 * blockBudget = requestBudget * (1 - TASK_AND_ITEMS_RESERVE_RATIO)
 */
function buildUnifiedBlockSegments(blocks, aiService) {
  const requestBudget = getRequestBudget(aiService);
  const reserve = Math.max(1, Math.floor(requestBudget * TASK_AND_ITEMS_RESERVE_RATIO));
  const blockSegmentLimit = Math.max(1, requestBudget - reserve);
  const segments = packBlocksIntoSegments(blocks, blockSegmentLimit);
  return {
    segments,
    blockSegmentLimit,
    requestBudget,
    reserve,
  };
}

/** 用真实 L2 任务消息估算条目侧可用预算（L1 已定，不重切 block） */
function getItemSplitBudget(aiService, prefixMessages) {
  const requestBudget = getRequestBudget(aiService);
  return Math.max(1, requestBudget - getMessagesContentLength(prefixMessages));
}

function getBlockOrder(blocks) {
  return new Map(blocks.map((block, index) => [block.id, index]));
}

function normalizeMatchResult(parsed, itemIds, blocks, blockOrder) {
  const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
  return {
    matches: matches.map((match) => {
      const id = String(match?.id || '').trim();
      const ranges = normalizeRanges(match?.ranges || match?.paragraph_ranges || match?.block_ranges || [], blockOrder);
      return itemIds.has(id) && ranges.length ? { id, ranges, block_ids: expandRanges(ranges, blocks, blockOrder) } : null;
    }).filter(Boolean),
  };
}

function validateMatchResult(value) {
  if (!Array.isArray(value?.matches)) {
    throw new Error('AI 返回结果缺少 matches 数组');
  }
}

function validateRecoveryResult(value) {
  if (!Array.isArray(value?.matches) || !Array.isArray(value?.new_items) || !Array.isArray(value?.discarded)) {
    throw new Error('AI 返回结果缺少 matches/new_items/discarded 数组');
  }
}

function collectHandledBlockIds(matches, discarded, systemDiscarded) {
  const handled = new Set();
  matches.forEach((match) => match.block_ids.forEach((id) => handled.add(id)));
  discarded.forEach((item) => item.block_ids.forEach((id) => handled.add(id)));
  systemDiscarded.forEach((item) => item.block_ids.forEach((id) => handled.add(id)));
  return handled;
}

function getMissingBlocks(blocks, matches, discarded, systemDiscarded) {
  const handled = collectHandledBlockIds(matches, discarded, systemDiscarded);
  return blocks.filter((block) => !handled.has(block.id));
}

function nextKnowledgeItemId(items) {
  let max = 0;
  items.forEach((item) => {
    const match = /^K(\d+)$/.exec(item.id || '');
    if (match) max = Math.max(max, Number(match[1]));
  });
  return `K${String(max + 1).padStart(6, '0')}`;
}

function createReport({ blocks, filteredBlocks, candidateItems, finalItems, matches, discarded, systemDiscarded, recoveryAttempts, batchSize }) {
  const matched = new Set();
  matches.forEach((match) => match.block_ids.forEach((id) => matched.add(id)));
  const discardedSet = new Set();
  discarded.forEach((item) => item.block_ids.forEach((id) => discardedSet.add(id)));
  const systemSet = new Set();
  systemDiscarded.forEach((item) => item.block_ids.forEach((id) => systemSet.add(id)));
  const handled = new Set([...matched, ...discardedSet, ...systemSet]);
  const total = blocks.length || 1;

  return {
    total_blocks: blocks.length,
    filtered_blocks_count: filteredBlocks.length,
    candidate_items_count: candidateItems.length,
    final_items_count: finalItems.length,
    matched_blocks_count: matched.size,
    discarded_blocks_count: discardedSet.size,
    system_discarded_after_retry_count: systemSet.size,
    new_items_from_recovery_count: recoveryAttempts.reduce((sum, attempt) => sum + attempt.new_items.length, 0),
    recovery_attempt_count: recoveryAttempts.length,
    batch_size: batchSize,
    coverage_rate: Number((handled.size / total).toFixed(4)),
    matched_rate: Number((matched.size / total).toFixed(4)),
    created_at: now(),
  };
}

module.exports = {
  DEFAULT_CONTEXT_LENGTH_LIMIT,
  KNOWLEDGE_CONTEXT_LIMIT_RATIO,
  TASK_AND_ITEMS_RESERVE_RATIO,
  PROMPT_CACHE_WARMUP_DELAY_MS,
  now,
  waitForPromptCacheWarmup,
  runParallelAndThrowAfterSettled,
  createId,
  safeName,
  ensureDir,
  getDebugLogsDir,
  getDebugLogPath,
  fromRelative,
  normalizeRelativePath,
  rebaseDocumentRelativePath,
  getPromptSummary,
  getItemSample,
  getMatchSummary,
  stripMarkdownFence,
  getMessagesContentLength,
  getKnowledgeBaseSegmentLimit,
  mergeMatchResults,
  renderCandidateItemsJson,
  renderKnowledgeItemsJson,
  normalizeCandidateItems,
  validateCandidateItems,
  mergeTitleSummaryItems,
  mergeCandidateItems,
  buildDocumentBlocksPrefixMessage,
  buildMissingBlocksPrefixMessage,
  buildInitialItemTaskMessage,
  buildInitialItemMessages,
  buildSupplementItemTaskMessage,
  buildSupplementItemMessages,
  buildMatchTaskMessage,
  buildMatchMessages,
  buildRecoveryTaskMessage,
  buildRecoveryMessages,
  getRequestBudget,
  buildUnifiedBlockSegments,
  getItemSplitBudget,
  getBlockOrder,
  normalizeMatchResult,
  validateMatchResult,
  validateRecoveryResult,
  collectHandledBlockIds,
  getMissingBlocks,
  nextKnowledgeItemId,
  createReport,
};
