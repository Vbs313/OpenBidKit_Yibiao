const {
  now,
  createId,
  stripTripleQuoteWrapper,
  normalizeText,
  truncatePromptText,
  getBidDocumentIdFromItem,
  formatBidDocumentsForPrompt,
  getArrayPayload,
  normalizeFindingType,
  normalizeSeverity,
  getBidDocumentDisplayName,
  formatBidDocumentIdList,
  getPackageBidDocumentId,
  limitDedupeItems,
  dedupeItems,
} = require('./rejectionCheckCore.cjs');
const {
  normalizeRejectionCheckFindings,
  findVerifiedTypoPosition,
  createVerifiedTypoExcerpt,
  createLineLocationHint,
  normalizeTypoCheckFindings,
  normalizeLogicCheckFindings,
} = require('./rejectionCheckFindings.cjs');
const {
  normalizeRollingEvidenceItem,
  normalizeRollingRejectionRiskItem,
  normalizeResolvedSummaryItem,
  normalizePatchReferenceId,
  createSequentialStateId,
  assignRejectionEvidenceId,
  assignRejectionRiskId,
  assignLogicFactId,
  assignLogicIssueId,
  normalizeRollingRejectionRiskUpdate,
  normalizeRollingRejectionResolve,
  normalizeRollingRejectionPatch,
  mergeDefinedFields,
  applyRollingRejectionPatch,
  createEmptyRollingRejectionState,
  normalizeLogicFactItem,
  normalizeRollingLogicIssueItem,
  normalizeRollingLogicIssueUpdate,
  normalizeRollingLogicResolve,
  normalizeRollingLogicPatch,
  applyRollingLogicPatch,
  createEmptyRollingLogicState,
  dedupeRejectionFindings,
  dedupeTypoFindings,
  dedupeLogicFindings,
  takeRecentItems,
  createRollingRejectionStateSummary,
  createRollingLogicStateSummary,
  createFinalRejectionStateSummary,
  createFinalLogicStateSummary,
  chunkItems,
  createRejectionFinalCandidates,
  createLogicFinalCandidates,
} = require('./rejectionCheckRolling.cjs');
const {
  buildCommonRejectionCheckMessages,
  buildRejectionCheckAnalysisMessages,
  buildRejectionCheckInspectionMessages,
  buildRejectionCheckFinalMessages,
  buildTypoCheckMessages,
  buildLogicCheckMessages,
  buildRollingRejectionBaseMessages,
  buildRollingRejectionSegmentMessages,
  buildRejectionFinalBatchMessages,
  buildRejectionGlobalMergeMessages,
  buildRollingLogicSegmentMessages,
  buildLogicFinalBatchMessages,
  buildLogicGlobalMergeMessages,
} = require('./rejectionCheckPrompts.cjs');
const { compactLogError, createNoopDeveloperLogger, textMetrics } = require('./../../utils/developerLog.cjs');
const { splitUserTextByContextLimit } = require('./../../utils/userTextSplitter.cjs');
const { runInvalidBidAndRejectionItemsExtraction } = require('./bidAnalysisTask.cjs');

const checkRunStatus = ['idle', 'running', 'success', 'error'];
const fullPromptLimitRatio = 0.6;
const rollingSegmentLimitRatio = 0.55;
const typoSegmentLimitRatio = 0.7;
const rollingSummaryEvidenceLimit = 60;
const rollingSummaryResolvedLimit = 40;
const rollingSummaryConfirmedLimit = 60;
const finalCandidateBatchSize = 20;























function getCurrentAiConfig(aiService) {
  try {
    return typeof aiService?.getConfig === 'function' ? aiService.getConfig() : {};
  } catch {
    return {};
  }
}

function shouldUseSegmentedPrompt(aiService, promptText, limitRatio = fullPromptLimitRatio) {
  const config = getCurrentAiConfig(aiService);
  return splitUserTextByContextLimit(promptText, config, { limitRatio }).length > 1;
}

function shouldUseSegmentedRejectionFlow(aiService, input) {
  return shouldUseSegmentedPrompt(
    aiService,
    [input.invalidBidAndRejectionItems, input.customCheckItems, formatBidDocumentsForPrompt(input)].join('\n\n'),
  );
}

function shouldUseSegmentedBidDocuments(aiService, bidDocuments) {
  return shouldUseSegmentedPrompt(aiService, formatBidDocumentsForPrompt({ bidDocuments }));
}

function createBidDocumentSegments(document, config, limitRatio) {
  const segments = splitUserTextByContextLimit(document.content, config, { limitRatio });
  let startOffset = 0;
  return segments.map((content, index) => {
    const endOffset = startOffset + content.length;
    const segment = {
      content,
      startOffset,
      endOffset,
      segmentIndex: index + 1,
      totalSegments: segments.length,
    };
    startOffset = endOffset;
    return segment;
  });
}

function createBidPackageSegments(bidDocuments, config, limitRatio) {
  const localSegments = [];
  for (const [documentIndex, document] of bidDocuments.entries()) {
    const documentLabel = getBidDocumentDisplayName(document, documentIndex);
    const segments = createBidDocumentSegments(document, config, limitRatio);
    for (const segment of segments) {
      localSegments.push({
        documentId: document.id,
        documentLabel,
        content: `【${documentLabel}｜bidDocumentId：${document.id}｜文件名：${document.fileName || document.id}】\n【当前文件片段：第 ${segment.segmentIndex}/${segment.totalSegments} 段】\n${segment.content}`,
      });
    }
  }

  return localSegments.map((segment, index) => ({
    ...segment,
    segmentIndex: index + 1,
    totalSegments: localSegments.length,
  }));
}

function createSegmentPromptDocument(document, segment) {
  return { ...document, content: segment.content };
}














































function createRejectionDeveloperLogger(aiService, name, meta = {}) {
  try {
    return aiService?.createDeveloperLogger?.('rejection-check', { name, meta }) || createNoopDeveloperLogger();
  } catch {
    return createNoopDeveloperLogger();
  }
}

function summarizeFindingsForLog(kind, findings = []) {
  const result = {
    kind,
    count: findings.length,
  };
  if (kind === 'rejection') {
    result.by_type = findings.reduce((counts, item) => {
      const type = item.type || 'unknown';
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    }, {});
    result.by_severity = findings.reduce((counts, item) => {
      const severity = item.severity || 'unknown';
      counts[severity] = (counts[severity] || 0) + 1;
      return counts;
    }, {});
  }
  return result;
}

async function runText(aiService, request, _onProgress, label) {
  const content = await aiService.chat({
    ...request,
    logTitle: request.logTitle || request.log_title || label,
  });
  if (!content.trim()) {
    throw new Error(`${label}未返回内容`);
  }
  return content;
}

async function runJson(aiService, request, onProgress, _label) {
  const jsonRequest = {
    ...request,
    response_format: request.response_format || { type: 'json_object' },
    progressCallback: request.progressCallback || onProgress,
    logTitle: request.logTitle || request.log_title || request.progressLabel || _label,
  };
  return aiService.collectJsonResponse ? aiService.collectJsonResponse(jsonRequest) : aiService.requestJson(jsonRequest);
}

async function runRollingRejectionItemCheck(aiService, input, onProgress) {
  const config = getCurrentAiConfig(aiService);
  const segments = createBidPackageSegments(input.bidDocuments, config, rollingSegmentLimitRatio);
  let state = createEmptyRollingRejectionState();
  onProgress('正在按上下文长度滚动审阅投标包。');

  for (const segment of segments) {
    onProgress(`${segment.documentLabel}：正在滚动审阅投标包第 ${segment.segmentIndex}/${segment.totalSegments} 段。`);
    const stateSummary = createRollingRejectionStateSummary(state);
    const payload = await runJson(aiService, {
      messages: buildRollingRejectionSegmentMessages(input, segment, stateSummary),
      schemaName: 'RollingRejectionCheckPatch',
      progressLabel: '投标包废标项滚动审阅',
      failureMessage: '废标项滚动审阅状态格式无效，请重新检查',
    }, onProgress, '投标包废标项滚动审阅');
    state = applyRollingRejectionPatch(state, normalizeRollingRejectionPatch(payload, input.bidDocuments, segment.documentId));
  }

  onProgress('正在基于全投标包状态定稿废标项风险。');
  const candidates = createRejectionFinalCandidates(state);
  if (!candidates.length) return [];
  const batches = chunkItems(candidates, finalCandidateBatchSize);
  const findings = [];
  const finalSummary = createFinalRejectionStateSummary(state);
  for (const [batchIndex, batch] of batches.entries()) {
    onProgress(`正在定稿废标项风险第 ${batchIndex + 1}/${batches.length} 批。`);
    const finalPayload = await runJson(aiService, {
      messages: buildRejectionFinalBatchMessages(input, batch, finalSummary, batchIndex + 1, batches.length),
      schemaName: 'RejectionCheckFindings',
      progressLabel: '投标包废标项检查定稿',
      failureMessage: '废标项检查结果格式无效，请重新检查',
    }, onProgress, '投标包废标项检查定稿');
    findings.push(...normalizeRejectionCheckFindings(finalPayload, input.bidDocuments));
  }
  const mergedFindings = dedupeRejectionFindings(findings);
  if (!mergedFindings.length) return [];
  onProgress('正在全局合并废标项风险。');
  const mergedPayload = await runJson(aiService, {
    messages: buildRejectionGlobalMergeMessages(input, mergedFindings, finalSummary),
    schemaName: 'RejectionCheckGlobalMergeFindings',
    progressLabel: '废标项风险全局合稿',
    failureMessage: '废标项风险全局合稿结果格式无效，请重新检查',
  }, onProgress, '废标项风险全局合稿');
  return dedupeRejectionFindings(normalizeRejectionCheckFindings(mergedPayload, input.bidDocuments));
}

async function runSegmentedTypoCheck(aiService, input, onProgress) {
  const config = getCurrentAiConfig(aiService);
  const findings = [];
  onProgress('正在按上下文长度分段识别错别字。');

  for (const [documentIndex, document] of input.bidDocuments.entries()) {
    const documentLabel = getBidDocumentDisplayName(document, documentIndex);
    const segments = createBidDocumentSegments(document, config, typoSegmentLimitRatio);
    for (const segment of segments) {
      onProgress(`${documentLabel}：正在识别第 ${segment.segmentIndex}/${segment.totalSegments} 段错别字。`);
      const payload = await runJson(aiService, {
        messages: buildTypoCheckMessages({ bidDocuments: [createSegmentPromptDocument(document, segment)] }),
        schemaName: 'TypoCheckFindings',
        progressLabel: `${documentLabel}错别字检查`,
        failureMessage: '错别字检查结果格式无效，请重新检查',
      }, onProgress, `${documentLabel}错别字检查`);
      findings.push(...normalizeTypoCheckFindings(payload, [document], {
        segmentStartOffset: segment.startOffset,
        segmentEndOffset: segment.endOffset,
      }));
    }
  }

  onProgress('正在合并并校验错别字原文位置。');
  return dedupeTypoFindings(findings);
}

async function runRollingLogicCheck(aiService, input, onProgress) {
  const config = getCurrentAiConfig(aiService);
  const segments = createBidPackageSegments(input.bidDocuments, config, rollingSegmentLimitRatio);
  let state = createEmptyRollingLogicState();
  onProgress('正在按上下文长度滚动检查投标包逻辑谬误。');

  for (const segment of segments) {
    onProgress(`${segment.documentLabel}：正在滚动检查投标包第 ${segment.segmentIndex}/${segment.totalSegments} 段逻辑。`);
    const stateSummary = createRollingLogicStateSummary(state);
    const payload = await runJson(aiService, {
      messages: buildRollingLogicSegmentMessages(input, segment, stateSummary),
      schemaName: 'RollingLogicCheckPatch',
      progressLabel: '投标包逻辑滚动检查',
      failureMessage: '逻辑谬误滚动检查状态格式无效，请重新检查',
    }, onProgress, '投标包逻辑滚动检查');
    state = applyRollingLogicPatch(state, normalizeRollingLogicPatch(payload, input.bidDocuments, segment.documentId));
  }

  onProgress('正在基于全投标包状态定稿逻辑问题。');
  const candidates = createLogicFinalCandidates(state);
  if (!candidates.length) return [];
  const batches = chunkItems(candidates, finalCandidateBatchSize);
  const findings = [];
  const finalSummary = createFinalLogicStateSummary(state);
  for (const [batchIndex, batch] of batches.entries()) {
    onProgress(`正在定稿逻辑问题第 ${batchIndex + 1}/${batches.length} 批。`);
    const finalPayload = await runJson(aiService, {
      messages: buildLogicFinalBatchMessages(input, batch, finalSummary, batchIndex + 1, batches.length),
      schemaName: 'LogicCheckFindings',
      progressLabel: '投标包逻辑谬误检查定稿',
      failureMessage: '逻辑谬误检查结果格式无效，请重新检查',
    }, onProgress, '投标包逻辑谬误检查定稿');
    findings.push(...normalizeLogicCheckFindings(finalPayload, input.bidDocuments));
  }
  const mergedFindings = dedupeLogicFindings(findings);
  if (!mergedFindings.length) return [];
  onProgress('正在全局合并逻辑问题。');
  const mergedPayload = await runJson(aiService, {
    messages: buildLogicGlobalMergeMessages(input, mergedFindings, finalSummary),
    schemaName: 'LogicCheckGlobalMergeFindings',
    progressLabel: '逻辑问题全局合稿',
    failureMessage: '逻辑问题全局合稿结果格式无效，请重新检查',
  }, onProgress, '逻辑问题全局合稿');
  return dedupeLogicFindings(normalizeLogicCheckFindings(mergedPayload, input.bidDocuments));
}

async function runRejectionItemCheck(aiService, input, onProgress) {
  if (shouldUseSegmentedRejectionFlow(aiService, input)) {
    return runRollingRejectionItemCheck(aiService, input, onProgress);
  }

  onProgress('第一轮：正在分析检查范围。');
  const analysis = await runText(
    aiService,
    { messages: buildRejectionCheckAnalysisMessages(input) },
    onProgress,
    '第一轮分析',
  );
  onProgress('第二轮：正在逐项检查投标文件。');
  const draftFindings = await runText(
    aiService,
    { messages: buildRejectionCheckInspectionMessages(input, analysis) },
    onProgress,
    '第二轮检查',
  );
  onProgress('第三轮：正在补充、去重并生成结果。');
  const payload = await runJson(aiService, {
    messages: buildRejectionCheckFinalMessages(input, analysis, draftFindings),
    schemaName: 'RejectionCheckFindings',
    progressLabel: '废标项检查结果',
    failureMessage: '废标项检查结果格式无效，请重新检查',
  }, onProgress, '第三轮定稿');
  return normalizeRejectionCheckFindings(payload, input.bidDocuments);
}

async function runTypoCheck(aiService, input, onProgress) {
  if (shouldUseSegmentedBidDocuments(aiService, input.bidDocuments)) {
    return runSegmentedTypoCheck(aiService, input, onProgress);
  }

  onProgress('正在识别错别字候选。');
  const payload = await runJson(aiService, {
    messages: buildTypoCheckMessages({ bidDocuments: input.bidDocuments }),
    schemaName: 'TypoCheckFindings',
    progressLabel: '错别字检查结果',
    failureMessage: '错别字检查结果格式无效，请重新检查',
  }, onProgress, '错别字检查');
  onProgress('正在校验错别字原文位置。');
  return normalizeTypoCheckFindings(payload, input.bidDocuments);
}

async function runLogicCheck(aiService, input, onProgress) {
  if (shouldUseSegmentedBidDocuments(aiService, input.bidDocuments)) {
    return runRollingLogicCheck(aiService, input, onProgress);
  }

  onProgress('正在检查逻辑谬误。');
  const payload = await runJson(aiService, {
    messages: buildLogicCheckMessages({ bidDocuments: input.bidDocuments }),
    schemaName: 'LogicCheckFindings',
    progressLabel: '逻辑谬误检查结果',
    failureMessage: '逻辑谬误检查结果格式无效，请重新检查',
  }, onProgress, '逻辑谬误检查');
  return normalizeLogicCheckFindings(payload, input.bidDocuments);
}

function updateExtractionState(checkpointTask, currentExtraction, taskPartial, extractionPartial) {
  const nextExtraction = { ...(currentExtraction || {}), ...extractionPartial };
  checkpointTask(taskPartial, {
    invalidBidAndRejectionItems: nextExtraction,
  });
  return nextExtraction;
}

async function runRejectionItemsExtractionTask({ aiService, workspaceStore, checkpointTask, payload, previousState }) {
  const state = {
    ...(previousState || {}),
    ...(payload?.workspaceState || {}),
  };
  const tenderDocument = state.tenderDocument || null;
  if (typeof workspaceStore.readDocumentMarkdown !== 'function' || typeof workspaceStore.createDocumentSignature !== 'function') {
    throw new Error('废标项检查存储接口尚未初始化');
  }
  const tenderContent = String(tenderDocument?.content || '');
  const tenderSignature = String(workspaceStore.createDocumentSignature({ ...tenderDocument, content: tenderContent }) || '');
  if (!tenderContent.trim() || !tenderSignature) throw new Error('缺少招标文件内容，无法解析无效与废标项');
  const developerLogger = createRejectionDeveloperLogger(aiService, 'rejection-items-extraction', {
    tender_signature: tenderSignature,
  });
  developerLogger.write('rejection.extraction.started', {
    tender_signature: tenderSignature,
    tender_content_metrics: textMetrics(tenderContent),
  });

  const logs = ['开始解析无效与废标项。'];
  let extractionState = updateExtractionState(checkpointTask, state.invalidBidAndRejectionItems, { status: 'running', progress: 5, logs }, {
    status: 'running',
    content: '',
    source: 'ai',
    tenderSignature,
    error: undefined,
    updatedAt: now(),
  });

  let content = '';
  try {
    content = await runInvalidBidAndRejectionItemsExtraction({
      aiService,
      fileContent: tenderContent,
    });
  } catch (error) {
    const message = error?.message || '无效与废标项解析失败';
    developerLogger.write('rejection.extraction.error', {
      tender_signature: tenderSignature,
      error: compactLogError(error),
    });
    extractionState = updateExtractionState(checkpointTask, extractionState, {
      status: 'error',
      progress: 100,
      logs: [`无效与废标项解析失败：${message}`],
      error: message,
    }, {
      status: 'error',
      content: '',
      source: 'ai',
      tenderSignature,
      error: message,
      updatedAt: now(),
    });
    return;
  }

  const finalContent = stripTripleQuoteWrapper(content);
  const success = Boolean(finalContent.trim());
  developerLogger.write('rejection.extraction.completed', {
    tender_signature: tenderSignature,
    status: success ? 'success' : 'error',
    output_metrics: textMetrics(finalContent),
    error: success ? undefined : '模型未返回解析内容',
  });
  extractionState = updateExtractionState(checkpointTask, extractionState, {
    status: success ? 'success' : 'error',
    progress: 100,
    logs: success ? ['无效与废标项解析完成。'] : ['无效与废标项解析失败：模型未返回解析内容。'],
    error: success ? undefined : '模型未返回解析内容',
  }, {
    status: success ? 'success' : 'error',
    content: finalContent,
    source: 'ai',
    tenderSignature,
    error: success ? undefined : '模型未返回解析内容',
    updatedAt: now(),
  });
}

function createRunningResult(inputSignature, progressMessage) {
  return { status: 'running', inputSignature, progressMessage, error: undefined, updatedAt: now() };
}

function updateCheckWorkspace(updateTask, checkpointTask, taskPartial, partial, persist = false) {
  (persist ? checkpointTask : updateTask)(taskPartial, partial);
}

async function runRejectionCheckTask({ aiService, workspaceStore, updateTask, checkpointTask, payload, previousState }) {
  const state = {
    ...(previousState || {}),
    ...(payload?.workspaceState || {}),
  };
  const options = state.checkOptions || {};
  const runOptions = payload?.runOptions || options;
  const bidDocuments = Array.isArray(state.bidDocuments) ? state.bidDocuments : [];
  if (typeof workspaceStore.readDocumentMarkdown !== 'function'
    || typeof workspaceStore.createDocumentSignature !== 'function'
    || typeof workspaceStore.createRejectionCheckInputSignature !== 'function') {
    throw new Error('废标项检查存储接口尚未初始化');
  }
  const currentBidDocuments = bidDocuments
    .map((document) => ({ ...document, content: String(document.content || '') }))
    .filter((document) => document.id && document.content.trim());
  const invalidBidAndRejectionItems = String(state.invalidBidAndRejectionItems?.content || '');
  const customCheckItems = String(state.customCheckItems ?? '');
  const rejectionInputSignature = String(workspaceStore.createRejectionCheckInputSignature(currentBidDocuments, invalidBidAndRejectionItems, customCheckItems) || '');
  const bidSignature = currentBidDocuments.map((document) => workspaceStore.createDocumentSignature(document)).filter(Boolean).join('\n---yibiao-rejection-bid-signature---\n');
  if (!currentBidDocuments.length || !bidSignature) throw new Error('缺少投标文件内容，无法开始检查');

  const enabledTasks = [
    runOptions.rejectionCheck ? 'rejection' : '',
    runOptions.typoCheck ? 'typo' : '',
    runOptions.logicCheck ? 'logic' : '',
  ].filter(Boolean);
  if (!enabledTasks.length) throw new Error('请至少启用一种检查');
  if (runOptions.rejectionCheck && (!invalidBidAndRejectionItems.trim() || !rejectionInputSignature)) {
    throw new Error('请先完成无效与废标项解析');
  }

  const developerLogger = createRejectionDeveloperLogger(aiService, 'rejection-check-run', {
    bid_signature: bidSignature,
    rejection_input_signature: rejectionInputSignature,
    enabled_tasks: enabledTasks,
  });
  developerLogger.write('rejection.check.started', {
    bid_signature: bidSignature,
    rejection_input_signature: rejectionInputSignature,
    enabled_tasks: enabledTasks,
    bid_document_count: currentBidDocuments.length,
    bid_content_metrics: currentBidDocuments.map((document) => ({ id: document.id, file_name: document.fileName, ...textMetrics(document.content) })),
    invalid_items_metrics: textMetrics(invalidBidAndRejectionItems),
    custom_items_metrics: textMetrics(customCheckItems),
  });

  let completed = 0;
  const logs = ['开始检查投标文件。'];
  const initialPartial = { checkOptions: options };
  if (runOptions.rejectionCheck) initialPartial.rejectionCheckResult = { ...createRunningResult(rejectionInputSignature, '第一轮：正在分析检查范围。'), findings: [], activeFindingId: undefined };
  if (runOptions.typoCheck) initialPartial.typoCheckResult = { ...createRunningResult(bidSignature, '正在识别错别字候选。'), findings: [], activeFindingId: undefined };
  if (runOptions.logicCheck) initialPartial.logicCheckResult = { ...createRunningResult(bidSignature, '正在检查逻辑谬误。'), findings: [], activeFindingId: undefined };
  updateCheckWorkspace(updateTask, checkpointTask, { status: 'running', progress: 5, logs }, initialPartial, true);

  function updateOverall(label, partial, persist = false) {
    const progress = Math.min(95, Math.round(5 + (completed / enabledTasks.length) * 90));
    updateCheckWorkspace(updateTask, checkpointTask, { status: 'running', progress, logs: [...logs, label] }, partial, persist);
  }

  async function runOne(kind, label, runner, resultKey, inputSignature) {
    developerLogger.write('rejection.check.stage.started', {
      kind,
      label,
      input_signature: inputSignature,
    });
    try {
      const findings = await runner((message) => {
        updateOverall(`${label}：${message}`, { [resultKey]: createRunningResult(inputSignature, message) });
      });
      completed += 1;
      developerLogger.write('rejection.check.stage.completed', {
        kind,
        label,
        input_signature: inputSignature,
        result: summarizeFindingsForLog(kind, findings),
      });
      updateOverall(`${label}完成。`, {
        [resultKey]: {
          status: 'success',
          findings,
          inputSignature,
          activeFindingId: findings[0]?.id,
          progressMessage: findings.length ? `${label}发现 ${findings.length} 项` : `${label}未发现问题`,
          updatedAt: now(),
        },
      }, true);
      return { kind, status: 'success' };
    } catch (error) {
      completed += 1;
      const message = error.message || `${label}失败`;
      developerLogger.write('rejection.check.stage.error', {
        kind,
        label,
        input_signature: inputSignature,
        error: compactLogError(error),
      });
      updateOverall(`${label}失败：${message}`, {
        [resultKey]: { status: 'error', findings: [], inputSignature, activeFindingId: undefined, error: message, progressMessage: message, updatedAt: now() },
      }, true);
      return { kind, status: 'error', error: message };
    }
  }

  const tasks = [];
  if (runOptions.rejectionCheck) {
    tasks.push(runOne('rejection', '废标项检查', (onProgress) => runRejectionItemCheck(aiService, { invalidBidAndRejectionItems, customCheckItems, bidDocuments: currentBidDocuments }, onProgress), 'rejectionCheckResult', rejectionInputSignature));
  }
  if (runOptions.typoCheck) {
    tasks.push(runOne('typo', '错别字检查', (onProgress) => runTypoCheck(aiService, { bidDocuments: currentBidDocuments }, onProgress), 'typoCheckResult', bidSignature));
  }
  if (runOptions.logicCheck) {
    tasks.push(runOne('logic', '逻辑谬误检查', (onProgress) => runLogicCheck(aiService, { bidDocuments: currentBidDocuments }, onProgress), 'logicCheckResult', bidSignature));
  }

  const results = await Promise.all(tasks);
  const failed = results.filter((item) => item.status === 'error');
  updateCheckWorkspace(updateTask, checkpointTask, {
    status: failed.length ? 'error' : 'success',
    progress: 100,
    logs: failed.length ? [`检查完成，${failed.length} 个任务失败。`] : ['检查完成。'],
    error: failed.length ? `${failed.length} 个检查任务失败` : undefined,
  }, {}, true);
  developerLogger.write('rejection.check.completed', {
    status: failed.length ? 'error' : 'success',
    enabled_tasks: enabledTasks,
    failed_count: failed.length,
    results: results.map((item) => ({ kind: item.kind, status: item.status, error: item.error || undefined })),
  });
}

module.exports = {
  runRejectionItemsExtractionTask,
  runRejectionCheckTask,
  // 纯函数出口：仅供单测（见 rejectionCheckTask.test.cjs）。
  // 这个文件此前没有任何测试，先用 __test__ 把归一化 / 签名 / 滚动状态的纯逻辑钉住，
  // 再考虑按「提示词 / 归一化 / 滚动状态」拆模块。
  __test__: {
    applyRollingRejectionPatch,
    buildCommonRejectionCheckMessages,
    buildRejectionGlobalMergeMessages,
    buildTypoCheckMessages,
    createEmptyRollingRejectionState,
    createVerifiedTypoExcerpt,
    dedupeItems,
    findVerifiedTypoPosition,
    formatBidDocumentIdList,
    formatBidDocumentsForPrompt,
    getArrayPayload,
    getBidDocumentDisplayName,
    getBidDocumentIdFromItem,
    getPackageBidDocumentId,
    limitDedupeItems,
    normalizeFindingType,
    normalizeLogicCheckFindings,
    normalizeRejectionCheckFindings,
    normalizeRollingRejectionPatch,
    normalizeSeverity,
    normalizeText,
    normalizeTypoCheckFindings,
    shouldUseSegmentedRejectionFlow,
    stripTripleQuoteWrapper,
  },
};
