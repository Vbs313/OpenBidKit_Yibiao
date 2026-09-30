const { buildBidSectionContextHint } = require('./../../utils/bidSectionContext.cjs');
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

const stableSystemPrompt = `你是专业的投标资料分析助手。请严格基于用户提供的上下文完成提取和总结。

通用要求：
1. 保持信息全面、准确，优先使用用户提供上下文中的内容；除非具体任务明确要求或允许根据经验补充，否则不要自行编造
2. 已提取到相关内容但局部信息没有提及时，明确写“没有提及”
3. 只输出最终结果，不输出过程、提示语或客套话
4. 始终使用简体中文
5. 本助手兼容公开招标、竞争性谈判、竞争性磋商、询价等采购文件；“投标文件/响应文件”“招标人/采购人”“开标/递交”等同义表述按同一概念理解`;

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

// 为 Markdown 解析项统一约定整项无结果标记，避免与局部缺失混淆。
function buildTaskPrompt(task) {
  const prompt = task.prompt();
  if (task.output !== 'markdown') return prompt;
  return `${prompt}

整体无结果规则：仅当当前任务完全未提取到任何相关内容时，只返回“${MARKDOWN_MISSING_RESULT}”，不要附加标题、标点、解释或其他文字。只要提取到任何有效内容，就正常返回结果；局部字段或局部分类缺失时写“没有提及”，不要使用“${MARKDOWN_MISSING_RESULT}”。`;
}

function isMissingMarkdownResult(task, content) {
  return task.output === 'markdown' && String(content || '').trim() === MARKDOWN_MISSING_RESULT;
}

function buildTenderContextMessages(fileContent, sectionHint, procurementMessage) {
  const messages = [
    { role: 'system', content: stableSystemPrompt },
  ];
  if (procurementMessage) {
    messages.push({ role: 'system', content: procurementMessage });
  }
  if (sectionHint) {
    messages.push({ role: 'system', content: sectionHint });
  }
  messages.push({ role: 'user', content: `以下是完整采购/招标文件。后续任务需要基于这份文件完成；如后续消息提供补充上下文，请按具体任务要求综合使用：\n\n${fileContent}` });
  return messages;
}

function buildMessages(fileContent, task, sectionHint, procurementMessage) {
  const messages = buildTenderContextMessages(fileContent, sectionHint, procurementMessage);
  messages.push(
    { role: 'user', content: buildTaskPrompt(task) },
  );
  return messages;
}

async function runSingleBidAnalysisPromptTask({ aiService, fileContent, task, sectionHint, procurementMessage, logTitle }) {
  return aiService.chat({
    messages: buildMessages(fileContent, task, sectionHint, procurementMessage),
    response_format: task.output === 'json' ? { type: 'json_object' } : undefined,
    logTitle: logTitle || `招标解析-${task.label}`,
  });
}

async function runBidAnalysisPromptTaskOnce({ aiService, fileContent, fileSegments, task, sectionHint, procurementMessage }) {
  const segments = Array.isArray(fileSegments) && fileSegments.length
    ? fileSegments
    : splitUserTextByContextLimit(fileContent, typeof aiService.getConfig === 'function' ? aiService.getConfig() : {});
  if (segments.length <= 1) {
    return runSingleBidAnalysisPromptTask({ aiService, fileContent: segments[0] || fileContent, task, sectionHint, procurementMessage });
  }

  const segmentResults = await Promise.all(segments.map(async (segmentContent, index) => ({
    segmentIndex: index + 1,
    totalSegments: segments.length,
    content: await runSingleBidAnalysisPromptTask({
      aiService,
      fileContent: segmentContent,
      task,
      sectionHint,
      procurementMessage,
      logTitle: `招标解析-${task.label}-第${index + 1}段`,
    }),
  })));

  return mergeSegmentedAiResults({
    aiService,
    segmentResults,
    taskPrompt: buildTaskPrompt(task),
    output: task.output,
    systemPrompt: stableSystemPrompt,
    sectionHint,
    taskLabel: task.label,
    logTitle: `招标解析合并-${task.label}`,
  });
}

// Markdown 整项无结果时完整重跑一次，第二次结果原样交给上层保存。
async function runBidAnalysisPromptTask(options) {
  const content = await runBidAnalysisPromptTaskOnce(options);
  if (!isMissingMarkdownResult(options.task, content)) return content;
  return runBidAnalysisPromptTaskOnce(options);
}

function runInvalidBidAndRejectionItemsExtraction({ aiService, fileContent, sectionHint, procurementMessage }) {
  const task = getBidAnalysisTaskById('discardedBids');
  if (!task) {
    throw new Error('未找到无效投标与废标项解析任务');
  }

  return runBidAnalysisPromptTask({ aiService, fileContent, task, sectionHint, procurementMessage });
}

async function runBidAnalysisTask({ aiService, workspaceStore, updateTask, checkpointTask, payload }) {
  const config = normalizeBidAnalysisConfig(payload.mode, payload.selected_task_ids || payload.selectedTaskIds);
  const mode = config.mode;
  const selectedTaskIdSet = new Set(config.taskIds);
  const selectedTasks = getBidAnalysisTasks('full').filter((task) => selectedTaskIdSet.has(task.id));
  const fileContent = workspaceStore.readTenderMarkdown();
  if (!String(fileContent || '').trim()) {
    throw new Error('请先上传招标文件，再开始解析');
  }
  const storedPlanForHint = workspaceStore.loadTechnicalPlan() || {};
  if (storedPlanForHint.bidSectionMode === 'multiple') {
    if (storedPlanForHint.bidSectionExtractionStatus !== 'success' || !Array.isArray(storedPlanForHint.bidSections) || storedPlanForHint.bidSections.length < 2) {
      throw new Error('请先完成多标段识别，再开始解析招标文件');
    }
    if (!storedPlanForHint.tenderFile?.selectedSectionId || !storedPlanForHint.tenderFile?.selectedSectionTitle) {
      throw new Error('请先选择本次投标范围，再开始解析招标文件');
    }
    const selectedExists = storedPlanForHint.bidSections.some((section) => section.id === storedPlanForHint.tenderFile.selectedSectionId);
    if (!selectedExists) {
      throw new Error('当前投标范围已失效，请重新选择标段');
    }
  }
  const selectedSectionId = storedPlanForHint.tenderFile?.selectedSectionId;
  const selectedSection = selectedSectionId && Array.isArray(storedPlanForHint.bidSections)
    ? storedPlanForHint.bidSections.find((section) => section.id === selectedSectionId)
    : null;
  const sectionHint = buildBidSectionContextHint(selectedSection, {
    hasSelectedSection: storedPlanForHint.bidSectionMode === 'multiple' && Boolean(selectedSectionId),
  });
  const procurementMethod = detectProcurementMethod(fileContent);
  const procurementMessage = buildProcurementContextMessage(procurementMethod);
  const currentConfig = typeof aiService.getConfig === 'function' ? aiService.getConfig() : {};
  const fileSegments = splitUserTextByContextLimit(fileContent, currentConfig);
  const forceRerun = payload.force_rerun === true || payload.forceRerun === true;
  const requestedTaskIds = Array.isArray(payload.task_ids)
    ? new Set(payload.task_ids.filter((taskId) => typeof taskId === 'string'))
    : null;
  const scopedTasks = requestedTaskIds
    ? selectedTasks.filter((task) => requestedTaskIds.has(task.id))
    : selectedTasks;
  if (requestedTaskIds && scopedTasks.length === 0) {
    throw new Error('未找到可重新解析的招标文件解析项');
  }
  function doneProgress(nextTasks) {
    const done = selectedTasks.filter((task) => ['success', 'error'].includes(nextTasks[task.id]?.status)).length;
    return Math.round((done / selectedTasks.length) * 100);
  }

  function getMissingRequiredTasks(nextTasks) {
    return getBidAnalysisTasks('full').filter((task) => task.required && !(nextTasks[task.id]?.status === 'success' && String(nextTasks[task.id]?.content || '').trim()));
  }

  const initialMessage = requestedTaskIds
    ? '开始重新解析选中的招标文件解析项。'
    : forceRerun
      ? '开始重新解析全部招标文件解析项。'
      : '开始解析招标文件。';
  const methodLog = `采购方式识别：${procurementMethod.label}（置信度 ${procurementMethod.confidence}）。`;
  const initialLogs = [methodLog, initialMessage];
  let initialPartial = { bidAnalysisMode: mode, bidAnalysisSelectedTaskIds: config.taskIds };
  let initialEventPatch;
  let currentTasks = { ...(storedPlanForHint.bidAnalysisTasks || {}) };
  if (forceRerun && !requestedTaskIds) {
    const resetTasks = {};
    for (const task of selectedTasks) {
      const resetTask = { id: task.id, label: task.label, status: 'idle', content: '' };
      currentTasks[task.id] = resetTask;
      resetTasks[task.id] = resetTask;
    }
    initialPartial = {
      ...initialPartial,
      bidAnalysisTasks: resetTasks,
      bidAnalysisProgress: 0,
      outlineGenerationTask: undefined,
      globalFactsTask: undefined,
      globalFactsAdjustmentTask: undefined,
      globalFacts: [],
      contentGenerationTask: undefined,
      contentGenerationOptions: undefined,
      contentGenerationSections: {},
      contentGenerationPlans: {},
      contentGenerationRuntime: undefined,
      outlineData: null,
    };
    initialEventPatch = {
      technicalPlanPatch: {
        projectOverview: '',
        techRequirements: '',
      },
    };
  }
  checkpointTask(
    { status: 'running', progress: 0, logs: initialLogs },
    initialPartial,
    initialEventPatch,
  );
  const tasksToRun = requestedTaskIds || forceRerun ? scopedTasks : scopedTasks.filter((task) => currentTasks[task.id]?.status !== 'success');

  function checkpointBidItem(taskPartial, item, progress, technicalPlanPatch = {}) {
    checkpointTask(
      taskPartial,
      { bidAnalysisItem: item, bidAnalysisProgress: progress },
      { bidItem: item, technicalPlanPatch },
    );
  }

  async function runOne(task) {
    const runningItem = { id: task.id, label: task.label, status: 'running', content: '' };
    currentTasks = { ...currentTasks, [task.id]: runningItem };
    const runningProgress = doneProgress(currentTasks);
    checkpointBidItem(
      { status: 'running', progress: runningProgress },
      runningItem,
      runningProgress,
    );

    const excerpt = buildTaskExcerpt(fileContent, task.id);
    const taskFileContent = excerpt.directed ? excerpt.content : fileContent;
    const taskFileSegments = excerpt.directed
      ? splitUserTextByContextLimit(taskFileContent, currentConfig)
      : fileSegments;
    if (excerpt.directed) {
      updateTask({
        status: 'running',
        progress: doneProgress(currentTasks),
        logs: [`${task.label}：TOC 定向 ${excerpt.selectedTitles.length}/${excerpt.chapterCount} 章，约 ${excerpt.selectedChars} 字（全文 ${excerpt.fullChars} 字）。`],
      });
    }

    const content = await runBidAnalysisPromptTask({
      aiService,
      fileContent: taskFileContent,
      fileSegments: taskFileSegments,
      task,
      sectionHint,
      procurementMessage,
    });
    const trimmedContent = String(content || '').trim();
    if (!trimmedContent) {
      throw new Error(`${task.label}解析结果为空，请重新解析`);
    }

    const completedItem = { id: task.id, label: task.label, status: 'success', content: trimmedContent };
    currentTasks = { ...currentTasks, [task.id]: completedItem };
    const progress = doneProgress(currentTasks);
    const technicalPlanPatch = {};
    if (task.id === 'projectOverview') technicalPlanPatch.projectOverview = trimmedContent;
    if (task.id === 'techRequirements') technicalPlanPatch.techRequirements = trimmedContent;
    checkpointBidItem(
      { status: 'running', progress },
      completedItem,
      progress,
      technicalPlanPatch,
    );
  }

  function handleTaskError(task, error) {
    const failedItem = { id: task.id, label: task.label, status: 'error', content: currentTasks[task.id]?.content || '', error: error.message || '解析失败' };
    currentTasks = { ...currentTasks, [task.id]: failedItem };
    const progress = doneProgress(currentTasks);
    checkpointBidItem(
      { status: 'running', progress, logs: [`${task.label}解析失败：${error.message || '未知错误'}`] },
      failedItem,
      progress,
    );
  }

  async function runOneSafely(task) {
    try {
      await runOne(task);
      return true;
    } catch (error) {
      handleTaskError(task, error);
      return false;
    }
  }

  const projectOverviewTask = tasksToRun.find((task) => task.id === 'projectOverview');
  const remainingTasks = tasksToRun.filter((task) => task.id !== 'projectOverview');
  if (projectOverviewTask) {
    const warmupSucceeded = await runOneSafely(projectOverviewTask);
    if (warmupSucceeded && remainingTasks.length) {
      updateTask({
        status: 'running',
        progress: doneProgress(currentTasks),
        logs: ['提示词缓存预热完成，等待 5 秒后开始并发解析剩余项。'],
      });
      await waitForPromptCacheWarmup();
    }
  }
  await Promise.all(remainingTasks.map(runOneSafely));

  const missingRequiredTasks = getMissingRequiredTasks(currentTasks);
  if (missingRequiredTasks.length) {
    const missingLabels = missingRequiredTasks.map((task) => task.label).join('、');
    const message = `必填解析项未完成：${missingLabels}，请重新解析失败项。`;
    checkpointTask({ status: 'error', progress: 100, error: message, logs: [message] });
    return;
  }

  checkpointTask({ status: 'success', progress: 100, error: undefined, logs: ['招标文件解析完成。'] });
}

module.exports = {
  buildInvalidBidAndRejectionItemsPrompt,
  getBidAnalysisTaskById,
  getBidAnalysisTasks,
  runInvalidBidAndRejectionItemsExtraction,
  runBidAnalysisTask,
  detectProcurementMethod,
  buildProcurementContextMessage,
};
