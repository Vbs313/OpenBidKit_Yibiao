const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '../electron/services/tasks/bidAnalysisTask.cjs');
let text = fs.readFileSync(file, 'utf8');
const marker = '// 为 Markdown 解析项统一约定整项无结果标记，避免与局部缺失混淆。';
const idx = text.indexOf(marker);
if (idx < 0) throw new Error('marker not found');

const header = `const { buildBidSectionContextHint } = require('./../../utils/bidSectionContext.cjs');
const { mergeSegmentedAiResults } = require('./../../utils/segmentedAiResultMerger.cjs');
const { splitUserTextByContextLimit } = require('./../../utils/userTextSplitter.cjs');
const { buildTaskExcerpt } = require('./bidAnalysisToc.cjs');
const { detectProcurementMethod, buildProcurementContextMessage } = require('./procurementMethod.cjs');
const {
  getBidAnalysisTasks,
  getBidAnalysisTaskById,
  getCatalogTaskPrompt,
} = require('./bidAnalysisCatalog.cjs');

const PROMPT_CACHE_WARMUP_DELAY_MS = 5000;
const MARKDOWN_MISSING_RESULT = '未提取到';

function waitForPromptCacheWarmup() {
  return new Promise((resolve) => setTimeout(resolve, PROMPT_CACHE_WARMUP_DELAY_MS));
}

const stableSystemPrompt = \`你是专业的投标资料分析助手。请严格基于用户提供的上下文完成提取和总结。

通用要求：
1. 保持信息全面、准确，优先使用用户提供上下文中的内容；除非具体任务明确要求或允许根据经验补充，否则不要自行编造
2. 已提取到相关内容但局部信息没有提及时，明确写“没有提及”
3. 只输出最终结果，不输出过程、提示语或客套话
4. 始终使用简体中文
5. 本助手兼容公开招标、竞争性谈判、竞争性磋商、询价等采购文件；“投标文件/响应文件”“招标人/采购人”“开标/递交”等同义表述按同一概念理解\`;

/** 提示词单源：与 src/shared/prompts/bidAnalysisTasks.json 一致 */
function buildInvalidBidAndRejectionItemsPrompt() {
  return getCatalogTaskPrompt('discardedBids');
}

function normalizeBidAnalysisTaskIds(taskIds) {
  const requestedIds = new Set((Array.isArray(taskIds) ? taskIds : [])
    .map((taskId) => String(taskId || '').trim())
    .filter(Boolean));
  return getBidAnalysisTasks('full').filter((task) => requestedIds.has(task.id)).map((task) => task.id);
}

function normalizeBidAnalysisConfig(mode, selectedTaskIds) {
  const allTasks = getBidAnalysisTasks('full');
  const requiredTaskIds = getBidAnalysisTasks('key').map((task) => task.id);
  const requiredSet = new Set(requiredTaskIds);
  const selectedSet = new Set([...requiredTaskIds, ...normalizeBidAnalysisTaskIds(selectedTaskIds)]);
  const selectedIds = allTasks.filter((task) => selectedSet.has(task.id)).map((task) => task.id);
  const hasOptional = selectedIds.some((taskId) => !requiredSet.has(taskId));
  const hasAll = selectedIds.length === allTasks.length;

  if (mode === 'full' || hasAll) {
    return { mode: 'full', taskIds: allTasks.map((task) => task.id) };
  }
  if (mode === 'custom' || hasOptional) {
    return { mode: 'custom', taskIds: selectedIds };
  }
  return { mode: 'key', taskIds: requiredTaskIds };
}

`;

text = header + text.slice(idx);
fs.writeFileSync(file, text, 'utf8');
console.log('updated', file, 'bytes', text.length);
