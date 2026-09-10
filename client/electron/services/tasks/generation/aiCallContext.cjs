// 模型调用的上下文规模、并发与开发者日志辅助：判断走 Agent 还是直接补全，
// 归一并发度、探测开发者模式。除注入的 aiService 外不接触外部状态，可单独测试。

const { normalizePositiveInteger } = require('./normalize.cjs');
const { createNoopDeveloperLogger } = require('../../../utils/developerLog.cjs');
const { countReadableWords } = require('../../../utils/wordCount.cjs');

const DEFAULT_CONTEXT_LENGTH_LIMIT = 400000;

const AGENT_CONTEXT_THRESHOLD_RATIO = 0.7;

const DEFAULT_TEXT_CONCURRENCY_LIMIT = 10;

const DEFAULT_IMAGE_CONCURRENCY_LIMIT = 2;

function getMessageContentLength(content) {
  if (typeof content === 'string') {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, item) => sum + getMessageContentLength(item?.text ?? item?.content ?? item), 0);
  }
  if (content === undefined || content === null) {
    return 0;
  }
  return JSON.stringify(content).length;
}

function getMessagesContentLength(messages) {
  return (Array.isArray(messages) ? messages : []).reduce((sum, message) => (
    sum + String(message?.role || '').length + getMessageContentLength(message?.content)
  ), 0);
}

function getTextContextLengthLimit(aiService) {
  let config = {};
  try {
    config = aiService?.getConfig?.() || {};
  } catch {
    config = {};
  }
  return normalizePositiveInteger(config.context_length_limit, DEFAULT_CONTEXT_LENGTH_LIMIT);
}

function shouldUseAgentForMessages(aiService, messages) {
  const contextLengthLimit = getTextContextLengthLimit(aiService);
  return getMessagesContentLength(messages) > Math.floor(contextLengthLimit * AGENT_CONTEXT_THRESHOLD_RATIO);
}

function normalizeContentConcurrency(value) {
  const concurrency = Number(value);
  return Math.max(1, Number.isFinite(concurrency) ? Math.round(concurrency) : DEFAULT_TEXT_CONCURRENCY_LIMIT);
}

function normalizeImageConcurrency(value) {
  const concurrency = Number(value);
  return Math.max(1, Number.isFinite(concurrency) ? Math.round(concurrency) : DEFAULT_IMAGE_CONCURRENCY_LIMIT);
}

function isDeveloperModeEnabled(aiService) {
  try {
    return Boolean(aiService?.isDeveloperMode?.());
  } catch {
    return false;
  }
}

function createContentDeveloperLogger(aiService, request) {
  try {
    return aiService?.createTechnicalPlanDeveloperLogger?.(request) || createNoopDeveloperLogger();
  } catch {
    return createNoopDeveloperLogger();
  }
}

function countContentWords(content) {
  return countReadableWords(String(content || ''));
}

module.exports = {
  AGENT_CONTEXT_THRESHOLD_RATIO,
  getMessagesContentLength,
  getTextContextLengthLimit,
  shouldUseAgentForMessages,
  normalizeContentConcurrency,
  normalizeImageConcurrency,
  isDeveloperModeEnabled,
  createContentDeveloperLogger,
  countContentWords,
};
