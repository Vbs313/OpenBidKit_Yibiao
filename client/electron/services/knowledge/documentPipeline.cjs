// 知识库文档流水线：文档解析（prepareDocument）与条目匹配（matchDocument）两大阶段。
//
// 这些原本是 createKnowledgeBaseService 工厂里的闭包函数；这里把 db 句柄、目录与少量内部助手显式注入，
// 纯文本工具直接复用 knowledge/kbPipelineUtils.cjs，不复制。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const {
  fromRelative,
  ensureDir,
  stripMarkdownFence,
  buildUnifiedBlockSegments,
  TASK_AND_ITEMS_RESERVE_RATIO,
  buildInitialItemMessages,
  getPromptSummary,
  normalizeCandidateItems,
  validateCandidateItems,
  getItemSample,
  PROMPT_CACHE_WARMUP_DELAY_MS,
  waitForPromptCacheWarmup,
  runParallelAndThrowAfterSettled,
  mergeTitleSummaryItems,
  buildSupplementItemMessages,
  mergeCandidateItems,
  getBlockOrder,
  getMessagesContentLength,
  buildDocumentBlocksPrefixMessage,
  normalizeMatchResult,
  validateMatchResult,
  getItemSplitBudget,
  buildMatchTaskMessage,
  buildMatchMessages,
  mergeMatchResults,
  getMatchSummary,
  buildRecoveryTaskMessage,
  getRequestBudget,
  buildRecoveryMessages,
  buildMissingBlocksPrefixMessage,
  validateRecoveryResult,
  nextKnowledgeItemId,
  createReport,
  getMissingBlocks,
} = require('./kbPipelineUtils.cjs');
const {
  normalizeRecoveryResult,
  mergeRecoverySegmentResults,
  createRawBlocks,
  mergeSemanticBlocks,
  filterBlocks,
  renderBlocksForPrompt,
  packItemsIntoSegments,
  packBlocksIntoSegments,
  normalizeRanges,
  expandRanges,
  compressBlockIdsToRanges,
  createFinalItems,
} = require('./blockPipeline.cjs');
const {
  parseDocumentWithConfig,
} = require('../fileService.cjs');

function createDocumentPipeline(deps) {
  const {
    baseDir,
    activePreparations,
    activeMatches,
    isDeveloperMode,
    debugLog,
    updateDocument,
    getDocument,
    isSamePath,
    getStep,
    stepCanReuse,
    getStepItems,
    isSameStringList,
    isRecoveryStepResult,
    runDocumentStep,
    configStore,
    aiService,
    app,
    knowledgeBaseStore,
    recoveryMaxAttempts,
  } = deps;

  async function prepareDocument(documentId, sourceFilePath, webContents) {
    if (activePreparations.has(documentId)) {
      debugLog(documentId, 'prepare:skip-active');
      return;
    }
    activePreparations.add(documentId);
    debugLog(documentId, 'prepare:start', { source_file_path: sourceFilePath });

    try {
      const document = getDocument(documentId);
      const config = configStore ? configStore.load() : { components: { file_parser: { provider: 'local' } } };
      const documentDir = fromRelative(baseDir, document.document_dir);
      const sourcePath = fromRelative(baseDir, document.source_path);
      const markdownPath = fromRelative(baseDir, document.markdown_path);
      let markdown = fs.existsSync(markdownPath) ? fs.readFileSync(markdownPath, 'utf-8').trim() : '';
      let blocks = knowledgeBaseStore.readBlocks(documentId);
      let filteredBlocks = knowledgeBaseStore.readFilteredBlocks(documentId);
      let firstItems = getStepItems(documentId, 'extract_first_items');
      let supplementItems = getStepItems(documentId, 'extract_supplement_items');
      let candidateItems = knowledgeBaseStore.readCandidateItems(documentId);

      const copyStep = getStep(documentId, 'copy_source');
      if (stepCanReuse(copyStep, fs.existsSync(sourcePath))) {
        if (!copyStep) knowledgeBaseStore.saveDocumentStep(documentId, 'copy_source', { status: 'success', result: { source_path: document.source_path } });
        debugLog(documentId, 'prepare:reuse-source', { source_path: sourcePath });
      } else {
        if (!fs.existsSync(sourceFilePath)) {
          throw new Error('原始文件不存在，请重新上传');
        }
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'copy_source');
        updateDocument(documentId, { status: 'copying', progress: 5, message: '正在复制原始文件', error: null }, webContents);
        await runDocumentStep(documentId, 'copy_source', async () => {
          ensureDir(documentDir);
          if (!isSamePath(sourceFilePath, sourcePath)) {
            await fsp.copyFile(sourceFilePath, sourcePath);
          }
          debugLog(documentId, 'prepare:copied-source', { source_path: sourcePath });
          return { source_path: document.source_path };
        });
      }

      const convertStep = getStep(documentId, 'convert_markdown');
      if (stepCanReuse(convertStep, Boolean(markdown))) {
        if (!convertStep) knowledgeBaseStore.saveDocumentStep(documentId, 'convert_markdown', { status: 'success', result: { markdown_chars: markdown.length } });
        debugLog(documentId, 'prepare:reuse-markdown', { markdown_chars: markdown.length });
      } else {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'convert_markdown');
        blocks = [];
        filteredBlocks = [];
        firstItems = null;
        supplementItems = null;
        candidateItems = [];
        updateDocument(documentId, { status: 'converting', progress: 15, message: '正在转换为 Markdown', error: null }, webContents);
        const result = await runDocumentStep(documentId, 'convert_markdown', async () => {
          const parsedMarkdown = stripMarkdownFence((await parseDocumentWithConfig(app, sourcePath, config, { assetScope: `knowledge-${documentId}`, preserveImages: false })).trim());
          if (!parsedMarkdown) throw new Error('文档未解析出有效 Markdown 内容');
          await fsp.writeFile(markdownPath, `${parsedMarkdown}\n`, 'utf-8');
          knowledgeBaseStore.updateMarkdownMetadata(documentId, parsedMarkdown);
          debugLog(documentId, 'prepare:converted-markdown', { markdown_path: markdownPath, markdown_chars: parsedMarkdown.length });
          return { markdown_chars: parsedMarkdown.length };
        });
        markdown = fs.readFileSync(markdownPath, 'utf-8').trim();
        if (!result?.markdown_chars || !markdown) throw new Error('文档未解析出有效 Markdown 内容');
      }

      const blockStep = getStep(documentId, 'build_blocks');
      if (stepCanReuse(blockStep, blocks.length > 0)) {
        if (!blockStep) knowledgeBaseStore.saveDocumentStep(documentId, 'build_blocks', { status: 'success', result: { block_count: blocks.length, filtered_block_count: filteredBlocks.length } });
        debugLog(documentId, 'prepare:reuse-blocks', { block_count: blocks.length, filtered_block_count: filteredBlocks.length });
      } else {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'build_blocks');
        firstItems = null;
        supplementItems = null;
        candidateItems = [];
        const result = await runDocumentStep(documentId, 'build_blocks', async () => {
          const rawBlocks = createRawBlocks(markdown);
          const semanticBlocks = mergeSemanticBlocks(rawBlocks);
          const filtered = filterBlocks(semanticBlocks);
          if (!filtered.blocks.length) throw new Error('筛选后没有可分析的正文内容');
          knowledgeBaseStore.saveBlocks(documentId, filtered.blocks, filtered.filtered_blocks);
          debugLog(documentId, 'prepare:blocks-ready', {
            raw_block_count: rawBlocks.length,
            semantic_block_count: semanticBlocks.length,
            block_count: filtered.blocks.length,
            filtered_block_count: filtered.filtered_blocks.length,
            block_text_chars: renderBlocksForPrompt(filtered.blocks).length,
            filtered_reasons: filtered.filtered_blocks.reduce((acc, block) => {
              acc[block.reason] = (acc[block.reason] || 0) + 1;
              return acc;
            }, {}),
          });
          return { block_count: filtered.blocks.length, filtered_block_count: filtered.filtered_blocks.length };
        });
        blocks = knowledgeBaseStore.readBlocks(documentId);
        filteredBlocks = knowledgeBaseStore.readFilteredBlocks(documentId);
        updateDocument(documentId, { block_count: result.block_count, filtered_block_count: result.filtered_block_count }, webContents);
      }

      // 统一 block 分段：提取/补充/匹配共用同一段表，L1 block 前缀跨任务字节级一致
      const unifiedPack = buildUnifiedBlockSegments(blocks, aiService);
      const unifiedSegments = unifiedPack.segments;
      if (!unifiedSegments.length) {
        throw new Error('筛选后没有可分析的正文内容');
      }
      debugLog(documentId, 'prepare:unified-segments', {
        segment_total: unifiedSegments.length,
        block_segment_limit: unifiedPack.blockSegmentLimit,
        request_budget: unifiedPack.requestBudget,
        reserve: unifiedPack.reserve,
        reserve_ratio: TASK_AND_ITEMS_RESERVE_RATIO,
      });

      if (candidateItems.length > 0
        && !getStep(documentId, 'extract_first_items')
        && !getStep(documentId, 'extract_supplement_items')
        && !getStep(documentId, 'merge_candidates')) {
        const legacyItems = candidateItems.map(({ title, summary }) => ({ title, summary }));
        firstItems = legacyItems;
        supplementItems = [];
        knowledgeBaseStore.saveDocumentStep(documentId, 'extract_first_items', { status: 'success', result: { items: firstItems } });
        knowledgeBaseStore.saveDocumentStep(documentId, 'extract_supplement_items', { status: 'success', result: { items: supplementItems } });
        knowledgeBaseStore.saveDocumentStep(documentId, 'merge_candidates', { status: 'success', result: { candidate_item_count: candidateItems.length } });
        debugLog(documentId, 'prepare:reuse-legacy-candidates', { candidate_item_count: candidateItems.length });
      }
      const firstStep = getStep(documentId, 'extract_first_items');
      if (stepCanReuse(firstStep, Array.isArray(firstItems))) {
        if (!firstStep) knowledgeBaseStore.saveDocumentStep(documentId, 'extract_first_items', { status: 'success', result: { items: firstItems } });
        debugLog(documentId, 'prepare:reuse-first-items', { item_count: firstItems.length });
      } else {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'extract_first_items');
        supplementItems = null;
        candidateItems = [];
        updateDocument(documentId, {
          status: 'extracting',
          progress: 35,
          message: 'AI 正在首次提取知识条目',
          block_count: blocks.length,
          filtered_block_count: filteredBlocks.length,
          error: null,
        }, webContents);
        const result = await runDocumentStep(documentId, 'extract_first_items', async () => {
          const segments = unifiedSegments;
          debugLog(documentId, 'ai:first-items:plan', {
            segment_total: segments.length,
            segment_limit: unifiedPack.blockSegmentLimit,
            block_count: blocks.length,
            execution_mode: segments.length > 1 ? 'warmup_parallel' : 'serial',
            layout: 'block_prefix',
          });

          let completedSegments = 0;
          const runSegment = async (segment) => {
            const firstMessages = buildInitialItemMessages(document.file_name, segment.text, segment);
            const prefixMessage = firstMessages[0];
            const taskMessage = firstMessages[1];
            debugLog(documentId, 'ai:first-items:start', {
              segment_index: segment.index,
              segment_total: segment.total,
              segment_chars: segment.chars,
              block_ids: segment.blockIds,
              prefix_chars: String(prefixMessage?.content || '').length,
              suffix_chars: String(taskMessage?.content || '').length,
              prompt: getPromptSummary(firstMessages),
            });
            const first = await aiService.collectJsonResponse({
              messages: firstMessages,
              response_format: { type: 'json_object' },
              logTitle: segments.length > 1
                ? `知识库条目提取-${document.file_name}-第${segment.index}段`
                : `知识库条目提取-${document.file_name}`,
              normalizer: (value) => ({ items: normalizeCandidateItems(value) }),
              validator: validateCandidateItems,
              failureMessage: '知识库条目提取失败，AI 未返回有效 JSON',
              progressLabel: '知识库条目提取',
            });
            const items = Array.isArray(first?.items) ? first.items : [];
            completedSegments += 1;
            updateDocument(documentId, {
              status: 'extracting',
              progress: Math.min(54, 35 + Math.round((completedSegments / segments.length) * 18)),
              message: segments.length > 1
                ? `AI 正在首次提取知识条目，已完成 ${completedSegments}/${segments.length} 段`
                : 'AI 正在首次提取知识条目',
            }, webContents);
            debugLog(documentId, 'ai:first-items:segment-done', {
              segment_index: segment.index,
              item_count: items.length,
              sample: getItemSample(items),
            });
            return items;
          };

          const firstSegmentItems = await runSegment(segments[0]);
          if (segments.length > 1) {
            debugLog(documentId, 'ai:first-items:warmup-wait', { delay_ms: PROMPT_CACHE_WARMUP_DELAY_MS });
            updateDocument(documentId, {
              status: 'extracting',
              progress: Math.min(54, 35 + Math.round((1 / segments.length) * 18)),
              message: `提示词缓存预热完成，等待后并发提取剩余 ${segments.length - 1} 段`,
            }, webContents);
            await waitForPromptCacheWarmup();
          }
          const remainingItems = segments.length > 1
            ? await runParallelAndThrowAfterSettled(segments.slice(1).map((segment) => () => runSegment(segment)))
            : [];
          const items = mergeTitleSummaryItems([firstSegmentItems, ...remainingItems]);
          debugLog(documentId, 'ai:first-items:done', {
            item_count: items.length,
            segment_total: segments.length,
            sample: getItemSample(items),
          });
          return { items, segment_count: segments.length };
        });
        firstItems = result.items;
      }

      const supplementStep = getStep(documentId, 'extract_supplement_items');
      if (stepCanReuse(supplementStep, Array.isArray(supplementItems))) {
        if (!supplementStep) knowledgeBaseStore.saveDocumentStep(documentId, 'extract_supplement_items', { status: 'success', result: { items: supplementItems } });
        debugLog(documentId, 'prepare:reuse-supplement-items', { item_count: supplementItems.length });
      } else {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'extract_supplement_items');
        candidateItems = [];
        updateDocument(documentId, { status: 'extracting', progress: 55, message: 'AI 正在补充遗漏知识条目', error: null }, webContents);
        const result = await runDocumentStep(documentId, 'extract_supplement_items', async () => {
          // 与提取共用 unifiedSegments，保证 L1 block 前缀跨任务一致
          const segments = unifiedSegments;
          debugLog(documentId, 'ai:supplement-items:plan', {
            first_item_count: firstItems.length,
            segment_total: segments.length,
            segment_limit: unifiedPack.blockSegmentLimit,
            execution_mode: segments.length > 1 ? 'warmup_parallel' : 'serial',
            layout: 'block_prefix',
          });

          let completedSegments = 0;
          const runSegment = async (segment) => {
            const supplementMessages = buildSupplementItemMessages(document.file_name, segment.text, firstItems, segment);
            debugLog(documentId, 'ai:supplement-items:start', {
              segment_index: segment.index,
              segment_total: segment.total,
              segment_chars: segment.chars,
              first_item_count: firstItems.length,
              block_ids: segment.blockIds,
              prefix_chars: String(supplementMessages[0]?.content || '').length,
              suffix_chars: String(supplementMessages[1]?.content || '').length,
              prompt: getPromptSummary(supplementMessages),
            });
            const supplement = await aiService.collectJsonResponse({
              messages: supplementMessages,
              response_format: { type: 'json_object' },
              logTitle: segments.length > 1
                ? `知识库条目补充-${document.file_name}-第${segment.index}段`
                : `知识库条目补充-${document.file_name}`,
              normalizer: (value) => ({ items: normalizeCandidateItems(value) }),
              validator: validateCandidateItems,
              failureMessage: '知识库条目补充失败，AI 未返回有效 JSON',
              progressLabel: '知识库条目补充',
            });
            const items = Array.isArray(supplement?.items) ? supplement.items : [];
            completedSegments += 1;
            updateDocument(documentId, {
              status: 'extracting',
              progress: Math.min(64, 55 + Math.round((completedSegments / segments.length) * 8)),
              message: segments.length > 1
                ? `AI 正在补充遗漏知识条目，已完成 ${completedSegments}/${segments.length} 段`
                : 'AI 正在补充遗漏知识条目',
            }, webContents);
            debugLog(documentId, 'ai:supplement-items:segment-done', {
              segment_index: segment.index,
              item_count: items.length,
              sample: getItemSample(items),
            });
            return items;
          };

          const firstSegmentItems = await runSegment(segments[0]);
          if (segments.length > 1) {
            debugLog(documentId, 'ai:supplement-items:warmup-wait', { delay_ms: PROMPT_CACHE_WARMUP_DELAY_MS });
            updateDocument(documentId, {
              status: 'extracting',
              progress: Math.min(64, 55 + Math.round((1 / segments.length) * 8)),
              message: `提示词缓存预热完成，等待后并发补充剩余 ${segments.length - 1} 段`,
            }, webContents);
            await waitForPromptCacheWarmup();
          }
          const remainingItems = segments.length > 1
            ? await runParallelAndThrowAfterSettled(segments.slice(1).map((segment) => () => runSegment(segment)))
            : [];
          const items = mergeTitleSummaryItems([firstSegmentItems, ...remainingItems]);
          debugLog(documentId, 'ai:supplement-items:done', {
            item_count: items.length,
            segment_total: segments.length,
            sample: getItemSample(items),
          });
          return { items, segment_count: segments.length };
        });
        supplementItems = result.items;
      }

      const mergeStep = getStep(documentId, 'merge_candidates');
      if (stepCanReuse(mergeStep, candidateItems.length > 0)) {
        if (!mergeStep) knowledgeBaseStore.saveDocumentStep(documentId, 'merge_candidates', { status: 'success', result: { candidate_item_count: candidateItems.length } });
        debugLog(documentId, 'prepare:reuse-candidates', { candidate_item_count: candidateItems.length });
      } else {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'merge_candidates');
        const result = await runDocumentStep(documentId, 'merge_candidates', async () => {
          const mergedItems = mergeCandidateItems(firstItems, supplementItems);
          if (!mergedItems.length) throw new Error('AI 未提取出可用知识条目');
          knowledgeBaseStore.saveCandidateItems(documentId, mergedItems);
          debugLog(documentId, 'prepare:candidates-saved', { candidate_item_count: mergedItems.length, sample: getItemSample(mergedItems) });
          return { candidate_item_count: mergedItems.length };
        });
        candidateItems = knowledgeBaseStore.readCandidateItems(documentId);
        if (!result?.candidate_item_count || !candidateItems.length) throw new Error('AI 未提取出可用知识条目');
      }

      updateDocument(documentId, {
        status: 'ready_for_matching',
        progress: 65,
        message: isDeveloperMode()
          ? `已提取 ${candidateItems.length} 条候选知识，可开始自动分段匹配`
          : `已提取 ${candidateItems.length} 条候选知识，正在自动匹配段落`,
        candidate_item_count: candidateItems.length,
        item_count: 0,
      }, webContents);

      if (!isDeveloperMode()) {
        debugLog(documentId, 'prepare:auto-match');
        await matchDocument(documentId, webContents);
      }
    } catch (error) {
      debugLog(documentId, 'prepare:error', {
        message: error.message || String(error),
        stack: error.stack,
      });
      updateDocument(documentId, { status: 'error', progress: 100, message: error.message || '处理失败', error: error.message || '处理失败' }, webContents);
    } finally {
      activePreparations.delete(documentId);
      debugLog(documentId, 'prepare:finish');
    }
  }

  async function matchDocument(documentId, webContents, options = {}) {
    if (activeMatches.has(documentId)) {
      debugLog(documentId, 'match:skip-active');
      return;
    }
    activeMatches.add(documentId);
    const force = Boolean(options.force);
    debugLog(documentId, 'match:start', { force });

    try {
      const document = getDocument(documentId);
      if (force) {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'match_batches');
      }
      const blocks = knowledgeBaseStore.readBlocks(documentId);
      const filteredBlocks = knowledgeBaseStore.readFilteredBlocks(documentId);
      const initialItems = knowledgeBaseStore.readCandidateItems(documentId);
      if (!blocks.length) throw new Error('缺少正文 block，请重新上传文档');
      if (!initialItems.length) throw new Error('缺少候选知识条目，请等待条目提取完成');

      const blockOrder = getBlockOrder(blocks);
      const candidateItemIds = new Set(initialItems.map((item) => item.id));
      const allItemIds = initialItems.map((item) => item.id);
      // 与 prepare 相同的统一 pack，保证匹配 L1 与提取/补充一致
      const unifiedPack = buildUnifiedBlockSegments(blocks, aiService);
      const blockSegments = unifiedPack.segments;
      const requestBudget = unifiedPack.requestBudget;

      debugLog(documentId, 'match:inputs-ready', {
        block_count: blocks.length,
        filtered_block_count: filteredBlocks.length,
        initial_item_count: initialItems.length,
        segment_total: blockSegments.length,
        segment_limit: unifiedPack.blockSegmentLimit,
        reserve: unifiedPack.reserve,
        execution_mode: 'serial',
        layout: 'block_prefix',
      });

      // 指纹：本段 block_ids + 全部候选条目 id；任一已存段不一致则清空整步重跑
      const buildMatchFingerprint = (blockIds, itemIds) => ({
        block_ids: [...(blockIds || [])],
        item_ids: [...(itemIds || [])],
      });
      const readMatchFingerprint = (raw) => {
        if (!raw || Array.isArray(raw) || !Array.isArray(raw.block_ids) || !Array.isArray(raw.item_ids)) {
          return null;
        }
        return { block_ids: raw.block_ids.map(String), item_ids: raw.item_ids.map(String) };
      };
      const isSameFingerprint = (left, right) => (
        left
        && right
        && isSameStringList(left.block_ids, right.block_ids)
        && isSameStringList(left.item_ids, right.item_ids)
      );

      const existingBatches = force ? [] : knowledgeBaseStore.readMatchBatches(documentId);
      const plannedFingerprints = new Map(
        blockSegments.map((segment) => [
          segment.index,
          buildMatchFingerprint(segment.blockIds, allItemIds),
        ]),
      );
      const fingerprintMismatch = existingBatches.some((batch) => {
        const planned = plannedFingerprints.get(batch.batch_index);
        const saved = readMatchFingerprint(batch.item_ids);
        if (!planned || !saved) return true;
        return !isSameFingerprint(saved, planned);
      });
      if (fingerprintMismatch && existingBatches.length) {
        knowledgeBaseStore.clearMatchBatches(documentId);
        debugLog(documentId, 'match:clear-batches', {
          reason: 'fingerprint_mismatch',
          previous_batch_count: existingBatches.length,
          planned_segment_total: blockSegments.length,
        });
      }

      const matches = [];
      const matchBatches = [];
      knowledgeBaseStore.saveDocumentStep(documentId, 'match_batches', { status: 'running' });
      updateDocument(documentId, {
        status: 'matching',
        progress: 66,
        message: blockSegments.length > 1
          ? `开始按上下文自动分段匹配，共 ${blockSegments.length} 段`
          : '开始匹配段落',
        last_batch_size: blockSegments.length,
      }, webContents);

      for (const segment of blockSegments) {
        const segmentIndex = segment.index;
        const segmentBlockIds = segment.blockIds;
        const segmentBlocks = segment.blocks;
        const segmentBlockOrder = getBlockOrder(segmentBlocks);
        const fingerprint = buildMatchFingerprint(segmentBlockIds, allItemIds);
        const savedBatch = knowledgeBaseStore.getMatchBatch(documentId, segmentIndex);
        const canReuse = savedBatch?.status === 'success'
          && isSameFingerprint(readMatchFingerprint(savedBatch.item_ids), fingerprint)
          && Array.isArray(savedBatch.matches);

        if (canReuse) {
          debugLog(documentId, 'match:reuse-segment', {
            segment_index: segmentIndex,
            match_count: savedBatch.matches.length,
            block_ids: segmentBlockIds,
          });
          const batchResult = {
            batch_index: segmentIndex,
            item_ids: allItemIds,
            block_ids: segmentBlockIds,
            matches: savedBatch.matches,
          };
          matchBatches.push(batchResult);
          matches.push(...savedBatch.matches);
          continue;
        }

        const progress = Math.min(88, 66 + Math.round((segmentIndex / blockSegments.length) * 22));
        updateDocument(documentId, {
          status: 'matching',
          progress,
          message: blockSegments.length > 1
            ? `AI 正在匹配段落 第 ${segmentIndex}/${blockSegments.length} 段`
            : 'AI 正在匹配段落',
        }, webContents);
        knowledgeBaseStore.saveMatchBatch(documentId, segmentIndex, {
          status: 'running',
          itemIds: fingerprint,
          matches: [],
        });

        try {
          // L1=block 前缀，L2=任务+条目；超预算只拆 L2 条目，不重切 L1
          const fullItemMessages = buildMatchMessages(document.file_name, segment.text, initialItems, segment);
          const fullItemLength = getMessagesContentLength(fullItemMessages);
          const blockPrefixMessage = buildDocumentBlocksPrefixMessage(segment.text, segment);
          let segmentMatches = [];

          if (fullItemLength <= requestBudget) {
            debugLog(documentId, 'ai:match-segment:start', {
              segment_index: segmentIndex,
              segment_total: segment.total,
              segment_chars: segment.chars,
              item_count: initialItems.length,
              item_mode: 'full',
              prefix_chars: String(blockPrefixMessage.content || '').length,
              suffix_chars: String(fullItemMessages[1]?.content || '').length,
              prompt: getPromptSummary(fullItemMessages),
            });
            const parsed = await aiService.collectJsonResponse({
              messages: fullItemMessages,
              response_format: { type: 'json_object' },
              logTitle: blockSegments.length > 1
                ? `知识库段落匹配-${document.file_name}-第${segmentIndex}段`
                : `知识库段落匹配-${document.file_name}`,
              normalizer: (value) => normalizeMatchResult(value, candidateItemIds, segmentBlocks, segmentBlockOrder),
              validator: validateMatchResult,
              failureMessage: '知识库段落匹配失败，AI 未返回有效 JSON',
              progressLabel: '知识库段落匹配',
            });
            segmentMatches = parsed.matches;
          } else {
            // 条目子批：L1 固定为 block，仅拆分任务中的条目列表
            const itemSegmentLimit = getItemSplitBudget(aiService, [
              blockPrefixMessage,
              buildMatchTaskMessage(document.file_name, []),
            ]);
            const itemSegments = packItemsIntoSegments(initialItems, itemSegmentLimit);
            debugLog(documentId, 'ai:match-segment:item-split', {
              segment_index: segmentIndex,
              item_segment_total: itemSegments.length,
              item_segment_limit: itemSegmentLimit,
            });
            const subMatchLists = [];
            for (const itemSegment of itemSegments) {
              const itemIds = new Set(itemSegment.itemIds);
              const matchMessages = buildMatchMessages(
                document.file_name,
                segment.text,
                itemSegment.items,
                segment,
              );
              debugLog(documentId, 'ai:match-segment:start', {
                segment_index: segmentIndex,
                segment_total: segment.total,
                segment_chars: segment.chars,
                item_count: itemSegment.items.length,
                item_mode: 'sub_batch',
                item_segment_index: itemSegment.index,
                item_segment_total: itemSegment.total,
                prefix_chars: String(blockPrefixMessage.content || '').length,
                prompt: getPromptSummary(matchMessages),
              });
              const parsed = await aiService.collectJsonResponse({
                messages: matchMessages,
                response_format: { type: 'json_object' },
                logTitle: `知识库段落匹配-${document.file_name}-第${segmentIndex}段-条目${itemSegment.index}`,
                normalizer: (value) => normalizeMatchResult(value, itemIds, segmentBlocks, segmentBlockOrder),
                validator: validateMatchResult,
                failureMessage: '知识库段落匹配失败，AI 未返回有效 JSON',
                progressLabel: '知识库段落匹配',
              });
              subMatchLists.push(parsed.matches);
            }
            segmentMatches = mergeMatchResults(subMatchLists).map((match) => {
              const blockIds = [...new Set(match.block_ids || [])].filter((id) => segmentBlockOrder.has(id));
              const ranges = compressBlockIdsToRanges(blockIds, segmentBlockOrder);
              return ranges.length ? { id: match.id, ranges, block_ids: blockIds } : null;
            }).filter(Boolean);
          }

          knowledgeBaseStore.saveMatchBatch(documentId, segmentIndex, {
            status: 'success',
            itemIds: fingerprint,
            matches: segmentMatches,
          });
          debugLog(documentId, 'ai:match-segment:done', {
            segment_index: segmentIndex,
            match_count: segmentMatches.length,
            matches: getMatchSummary(segmentMatches),
          });
          const batchResult = {
            batch_index: segmentIndex,
            item_ids: allItemIds,
            block_ids: segmentBlockIds,
            matches: segmentMatches,
          };
          matchBatches.push(batchResult);
          matches.push(...segmentMatches);
        } catch (error) {
          knowledgeBaseStore.saveMatchBatch(documentId, segmentIndex, {
            status: 'error',
            itemIds: fingerprint,
            error: error.message || String(error),
          });
          knowledgeBaseStore.saveDocumentStep(documentId, 'match_batches', {
            status: 'error',
            error: error.message || String(error),
          });
          throw error;
        }
      }

      const mergedMatches = mergeMatchResults(matches).map((match) => {
        const ranges = normalizeRanges(match.ranges, blockOrder);
        return {
          id: match.id,
          ranges,
          block_ids: expandRanges(ranges, blocks, blockOrder),
        };
      }).filter((match) => match.ranges.length);

      knowledgeBaseStore.saveDocumentStep(documentId, 'match_batches', {
        status: 'success',
        result: {
          batch_size: blockSegments.length,
          batch_count: blockSegments.length,
          segment_count: blockSegments.length,
        },
      });

      const recoveryStep = getStep(documentId, 'recover_missing');
      let recoveryResult = recoveryStep?.result;
      if (!force && recoveryStep?.status === 'success' && isRecoveryStepResult(recoveryResult)) {
        debugLog(documentId, 'recovery:reuse', {
          item_count: recoveryResult.items.length,
          match_count: recoveryResult.matches.length,
          recovery_attempt_count: recoveryResult.recovery_attempts.length,
        });
      } else {
        knowledgeBaseStore.clearDocumentProcessingFromStep(documentId, 'recover_missing');
        recoveryResult = await runDocumentStep(documentId, 'recover_missing', async () => {
          const items = [...initialItems];
          const recoveredMatches = [...mergedMatches];
          const discarded = [];
          const systemDiscarded = [];
          const recoveryAttempts = [];

          for (let attempt = 0; attempt < recoveryMaxAttempts; attempt += 1) {
            const missingBlocks = getMissingBlocks(blocks, recoveredMatches, discarded, systemDiscarded);
            debugLog(documentId, 'recovery:missing-check', {
              attempt: attempt + 1,
              missing_block_count: missingBlocks.length,
            });
            if (!missingBlocks.length) break;

            updateDocument(documentId, {
              status: 'recovering',
              progress: Math.min(96, 90 + attempt * 3),
              message: `AI 正在补漏遗漏段落 ${attempt + 1}/${recoveryMaxAttempts}，剩余 ${missingBlocks.length} 个 block`,
            }, webContents);

            const currentItemIds = new Set(items.map((item) => item.id));
            // missing 在前：用 L2 任务+条目壳扣预算后切 missing 段
            const recoveryTaskShell = [buildRecoveryTaskMessage(document.file_name, items)];
            const recoveryRequestBudget = getRequestBudget(aiService);
            const missingSegmentLimit = Math.max(1, recoveryRequestBudget - getMessagesContentLength(recoveryTaskShell));
            const missingSegments = packBlocksIntoSegments(missingBlocks, missingSegmentLimit);
            if (!missingSegments.length) break;

            debugLog(documentId, 'ai:recovery:plan', {
              attempt: attempt + 1,
              missing_block_count: missingBlocks.length,
              segment_total: missingSegments.length,
              segment_limit: missingSegmentLimit,
              item_count: items.length,
              execution_mode: missingSegments.length > 1 ? 'warmup_parallel' : 'serial',
              layout: 'missing_prefix',
            });

            const runMissingSegment = async (missingSegment) => {
              const segmentBlocks = missingSegment.blocks;
              const segmentBlockOrder = getBlockOrder(segmentBlocks);
              const fullMessages = buildRecoveryMessages(document.file_name, items, segmentBlocks, missingSegment);
              const fullLength = getMessagesContentLength(fullMessages);
              const missingPrefixMessage = buildMissingBlocksPrefixMessage(segmentBlocks, missingSegment);
              let segmentParsed;

              if (fullLength <= recoveryRequestBudget) {
                debugLog(documentId, 'ai:recovery:start', {
                  attempt: attempt + 1,
                  segment_index: missingSegment.index,
                  segment_total: missingSegment.total,
                  segment_chars: missingSegment.chars,
                  missing_block_count: segmentBlocks.length,
                  item_count: items.length,
                  item_mode: 'full',
                  prefix_chars: String(missingPrefixMessage.content || '').length,
                  prompt: getPromptSummary(fullMessages),
                });
                segmentParsed = await aiService.collectJsonResponse({
                  messages: fullMessages,
                  response_format: { type: 'json_object' },
                  logTitle: missingSegments.length > 1
                    ? `知识库遗漏补漏-${document.file_name}-第${attempt + 1}轮-第${missingSegment.index}段`
                    : `知识库遗漏补漏-${document.file_name}-第${attempt + 1}轮`,
                  normalizer: (value) => normalizeRecoveryResult(value, currentItemIds, segmentBlocks, segmentBlockOrder),
                  validator: validateRecoveryResult,
                  failureMessage: '知识库遗漏段落补漏失败，AI 未返回有效 JSON',
                  progressLabel: '知识库遗漏补漏',
                });
              } else {
                const itemSegmentLimit = getItemSplitBudget(aiService, [
                  missingPrefixMessage,
                  buildRecoveryTaskMessage(document.file_name, []),
                ]);
                const itemSegments = packItemsIntoSegments(items, itemSegmentLimit);
                const subParsedList = [];
                debugLog(documentId, 'ai:recovery:item-split', {
                  attempt: attempt + 1,
                  segment_index: missingSegment.index,
                  item_segment_total: itemSegments.length,
                  item_segment_limit: itemSegmentLimit,
                });
                for (const itemSegment of itemSegments) {
                  const itemIds = new Set(itemSegment.itemIds);
                  const recoveryMessages = buildRecoveryMessages(
                    document.file_name,
                    itemSegment.items,
                    segmentBlocks,
                    missingSegment,
                  );
                  debugLog(documentId, 'ai:recovery:start', {
                    attempt: attempt + 1,
                    segment_index: missingSegment.index,
                    segment_total: missingSegment.total,
                    item_segment_index: itemSegment.index,
                    item_segment_total: itemSegment.total,
                    item_count: itemSegment.items.length,
                    item_mode: 'sub_batch',
                    prefix_chars: String(missingPrefixMessage.content || '').length,
                    prompt: getPromptSummary(recoveryMessages),
                  });
                  const subParsed = await aiService.collectJsonResponse({
                    messages: recoveryMessages,
                    response_format: { type: 'json_object' },
                    logTitle: `知识库遗漏补漏-${document.file_name}-第${attempt + 1}轮-第${missingSegment.index}段-条目${itemSegment.index}`,
                    normalizer: (value) => normalizeRecoveryResult(value, itemIds, segmentBlocks, segmentBlockOrder),
                    validator: validateRecoveryResult,
                    failureMessage: '知识库遗漏段落补漏失败，AI 未返回有效 JSON',
                    progressLabel: '知识库遗漏补漏',
                  });
                  subParsedList.push(subParsed);
                }
                segmentParsed = mergeRecoverySegmentResults(subParsedList, currentItemIds, segmentBlocks, segmentBlockOrder);
              }

              debugLog(documentId, 'ai:recovery:segment-done', {
                attempt: attempt + 1,
                segment_index: missingSegment.index,
                match_count: segmentParsed.matches.length,
                new_item_count: segmentParsed.new_items.length,
                discarded_group_count: segmentParsed.discarded.length,
              });
              return segmentParsed;
            };

            const firstSegmentParsed = await runMissingSegment(missingSegments[0]);
            if (missingSegments.length > 1) {
              debugLog(documentId, 'ai:recovery:warmup-wait', {
                attempt: attempt + 1,
                delay_ms: PROMPT_CACHE_WARMUP_DELAY_MS,
              });
              updateDocument(documentId, {
                status: 'recovering',
                progress: Math.min(96, 90 + attempt * 3),
                message: `补漏预热完成，等待后并发处理剩余 ${missingSegments.length - 1} 段遗漏 block`,
              }, webContents);
              await waitForPromptCacheWarmup();
            }
            const remainingParsed = missingSegments.length > 1
              ? await runParallelAndThrowAfterSettled(
                missingSegments.slice(1).map((segment) => () => runMissingSegment(segment)),
              )
              : [];
            const attemptMatchLists = [];
            const attemptNewItems = [];
            const attemptDiscarded = [];
            for (const segmentParsed of [firstSegmentParsed, ...remainingParsed]) {
              attemptMatchLists.push(segmentParsed.matches);
              attemptNewItems.push(...segmentParsed.new_items);
              attemptDiscarded.push(...segmentParsed.discarded);
            }

            // 以上游过滤后的 block_ids 为准，再压 ranges；禁止用脏 ranges 再展开
            const parsedMatches = mergeMatchResults(attemptMatchLists).map((match) => {
              if (!currentItemIds.has(match.id)) return null;
              const blockIds = [...new Set(match.block_ids || [])].filter((id) => blockOrder.has(id));
              const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
              return ranges.length ? { id: match.id, ranges, block_ids: blockIds } : null;
            }).filter(Boolean);

            const newItemsWithIds = attemptNewItems.map((item) => {
              const blockIds = [...new Set(item.block_ids || [])].filter((id) => blockOrder.has(id));
              const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
              if (!ranges.length) return null;
              const id = nextKnowledgeItemId(items);
              const next = { id, title: item.title, summary: item.summary };
              items.push(next);
              recoveredMatches.push({ id, ranges, block_ids: blockIds });
              return { ...next, ranges, block_ids: blockIds };
            }).filter(Boolean);

            const parsedDiscarded = attemptDiscarded.map((item) => {
              const blockIds = [...new Set(item.block_ids || [])].filter((id) => blockOrder.has(id));
              const ranges = compressBlockIdsToRanges(blockIds, blockOrder);
              return ranges.length ? {
                ranges,
                block_ids: blockIds,
                reason: item.reason || 'AI 建议舍弃',
                source: `recovery_${attempt + 1}`,
              } : null;
            }).filter(Boolean);

            recoveredMatches.push(...parsedMatches);
            discarded.push(...parsedDiscarded);
            recoveryAttempts.push({
              attempt: attempt + 1,
              missing_before_count: missingBlocks.length,
              segment_count: missingSegments.length,
              matches: parsedMatches,
              new_items: newItemsWithIds,
              discarded: parsedDiscarded,
            });
            debugLog(documentId, 'ai:recovery:done', {
              attempt: attempt + 1,
              match_count: parsedMatches.length,
              new_item_count: newItemsWithIds.length,
              discarded_group_count: parsedDiscarded.length,
              matches: getMatchSummary(parsedMatches),
            });
          }

          const remaining = getMissingBlocks(blocks, recoveredMatches, discarded, systemDiscarded);
          debugLog(documentId, 'match:remaining-after-recovery', { remaining_block_count: remaining.length });
          if (remaining.length) {
            systemDiscarded.push({
              block_ids: remaining.map((block) => block.id),
              reason: 'system_discarded_after_retry',
            });
          }

          return {
            items,
            matches: recoveredMatches,
            discarded,
            system_discarded: systemDiscarded,
            recovery_attempts: recoveryAttempts,
          };
        });
      }

      const savedItems = knowledgeBaseStore.readItems(documentId);
      const saveStep = getStep(documentId, 'save_result');
      if (!force && saveStep?.status === 'success' && savedItems.length) {
        debugLog(documentId, 'save:reuse', { item_count: savedItems.length });
        updateDocument(documentId, {
          status: 'success',
          progress: 100,
          message: `整理完成，共 ${savedItems.length} 条`,
          item_count: savedItems.length,
        }, webContents);
        return;
      }

      updateDocument(documentId, { status: 'saving', progress: 98, message: '正在回填正文并保存知识条目' }, webContents);
      const saveResult = await runDocumentStep(documentId, 'save_result', async () => {
        const finalItems = createFinalItems(recoveryResult.items, recoveryResult.matches, blocks, document.file_name);
        const report = createReport({
          blocks,
          filteredBlocks,
          candidateItems: recoveryResult.items,
          finalItems,
          matches: recoveryResult.matches,
          discarded: recoveryResult.discarded,
          systemDiscarded: recoveryResult.system_discarded,
          recoveryAttempts: recoveryResult.recovery_attempts,
          batchSize: blockSegments.length,
        });
        const matchResult = {
          candidate_items: recoveryResult.items,
          match_batches: matchBatches,
          recovery_attempts: recoveryResult.recovery_attempts,
          final_matches: recoveryResult.matches,
          discarded: recoveryResult.discarded,
          system_discarded_after_retry: recoveryResult.system_discarded,
          report,
        };

        knowledgeBaseStore.saveMatchResult(documentId, {
          candidateItems: recoveryResult.items,
          matchResult,
          report,
          finalItems,
        });
        debugLog(documentId, 'match:saved', {
          final_item_count: finalItems.length,
          report,
        });
        return { final_item_count: finalItems.length, report };
      });
      updateDocument(documentId, {
        status: 'success',
        progress: 100,
        message: `整理完成，共 ${saveResult.final_item_count} 条，覆盖率 ${Math.round(saveResult.report.coverage_rate * 100)}%`,
        item_count: saveResult.final_item_count,
        candidate_item_count: recoveryResult.items.length,
        discarded_block_count: saveResult.report.discarded_blocks_count,
        system_discarded_after_retry_count: saveResult.report.system_discarded_after_retry_count,
      }, webContents);
    } catch (error) {
      debugLog(documentId, 'match:error', {
        message: error.message || String(error),
        stack: error.stack,
      });
      updateDocument(documentId, {
        status: 'error',
        progress: 100,
        message: error.message || '匹配失败',
        error: error.message || '匹配失败',
      }, webContents);
    } finally {
      activeMatches.delete(documentId);
      debugLog(documentId, 'match:finish');
    }
  }

  return { prepareDocument, matchDocument };
}

module.exports = { createDocumentPipeline };
