// 字数调整子阶段：小节级逐轮调整 + 全文级扩写/缩写批次，二者共用一次模型改写请求。
//
// 该阶段原本是 runContentGenerationTask 内部的闭包；这里把状态与副作用显式注入，
// 自身不持有模块级状态，可单独测试。
//
// deps 约定：
//   aiService / wordControl / resume / targetItemId / runOnlyIllustrationStage / globalFacts /
//   globalFactsMode / storedPlan                                        直接读的参数与方案
//   contentStats / contentConcurrency                                    进度与并发上限
//   state.leaves / state.sections / state.logs / state.contentRuntime    读取会被重新赋值的闭包变量
//   state.appendLog(message)                                             追加一行任务日志
//   setWordAdjustmentRuntime / getContentPlanForItem / leafWordStats 等  编排函数与字数统计的既有入口
//   其余为任务运行时回调（进度、暂停、落盘）

const { progressFor } = require('./../progress.cjs');
const { isPauseLikeError, runItemsWithWorkerPool } = require('./../taskRuntime.cjs');
const { countContentWords } = require('./../aiCallContext.cjs');
const { buildWordAdjustmentMessages } = require('./../contentMessages.cjs');
const { buildWordAdjustmentRepairMessages } = require('./../promptBuilders.cjs');
const { resolveSelectedFactsText } = require('./../knowledgeResolution.cjs');
const { normalizeWordAdjustmentResponse, normalizeLeafContentForSave } = require('./../normalize.cjs');
const { validateWordAdjustmentResponse, applyWordAdjustmentOperations } = require('./../wordAdjustment.cjs');
const {
  MAX_WORD_ADJUSTMENT_ROUNDS,
  MAX_EXPANSION_NO_PROGRESS_ROUNDS,
  TOTAL_WORD_ADJUSTMENT_BATCH_SIZE,
  TOTAL_WORD_SHRINK_MIN_CAPACITY_RATIO,
  isSectionWordsOutsideRange,
  getTotalWordDirection,
  buildTotalWordAdjustmentBatch,
} = require('./../wordBatching.cjs');

function createWordAdjustmentStage(deps) {
  const {
    aiService,
    contentStats,
    contentConcurrency,
    wordControl,
    resume,
    targetItemId,
    runOnlyIllustrationStage,
    globalFacts,
    globalFactsMode,
    storedPlan,

    publishTaskUpdate,
    statsSnapshot,
    pauseIfRequested,
    isPauseRequested,

    setWordAdjustmentRuntime,
    getContentPlanForItem,
    getLeafContentForWords,
    getLeafWordCount,
    countTotalContentWords,
    leafWordStats,
    rememberTouchedItem,
    saveSection,
  } = deps;
  const { state } = deps;

  async function requestWordAdjustment(context, options) {
    const { item } = context;
    const currentContent = getLeafContentForWords(item);
    const currentWords = getLeafWordCount(item);
    const selectedFactsText = resolveSelectedFactsText(getContentPlanForItem(item.id), globalFacts);
    pauseIfRequested('正文生成已在字数调整请求前暂停，继续后将重新执行本轮。');
    const adjustment = await aiService.collectJsonResponse({
      messages: buildWordAdjustmentMessages({
        context,
        currentContent,
        currentWords,
        targetWords: options.targetWords,
        mode: options.mode,
        granularity: options.granularity,
        selectedFactsText,
        maximumChangeWords: options.maximumChangeWords,
        totalRemainingWords: options.totalRemainingWords,
        totalWords: targetItemId ? undefined : countTotalContentWords(),
        minimumWords: targetItemId ? 0 : wordControl.minimumWords,
        maximumWords: targetItemId ? 0 : wordControl.maximumWords,
        globalFactsMode,
      }),
      logTitle: `正文${options.mode === 'expand' ? '扩写' : '缩写'}-${item.id}-${item.title || '未命名章节'}`,
      progressLabel: '正文字数调整',
      failureMessage: '模型返回的正文字数调整结果格式无效',
      max_retries: 0,
      normalizer: normalizeWordAdjustmentResponse,
      validator: (value) => {
        validateWordAdjustmentResponse(value);
        if (value.mode !== options.mode || value.granularity !== options.granularity) {
          throw new Error('模型返回的调整方向或粒度与当前要求不一致');
        }
      },
      repairMessagesBuilder: (repairContext) => buildWordAdjustmentRepairMessages(repairContext, options.mode, options.granularity, currentContent),
    });
    pauseIfRequested('正文生成已在字数调整结果应用前暂停，继续后将重新执行本轮。');
    const nextContent = normalizeLeafContentForSave(applyWordAdjustmentOperations(currentContent, adjustment), item);
    const nextWords = countContentWords(nextContent);
    if (nextWords <= 0) throw new Error('字数调整后正文没有有效可读内容');
    if (options.mode === 'expand' && nextWords <= currentWords) throw new Error('扩写后字数没有增加');
    if (options.mode === 'shrink' && nextWords >= currentWords) throw new Error('缩写后字数没有减少');
    if (Math.abs(nextWords - currentWords) > options.maximumChangeWords) {
      throw new Error('本轮实际调整字数超过允许额度');
    }
    if (Math.abs(nextWords - options.targetWords) >= Math.abs(currentWords - options.targetWords)) {
      throw new Error('字数调整后与目标的差距没有缩小');
    }
    if (options.enforceSectionBounds && wordControl.strictSectionWords) {
      if (nextWords < wordControl.sectionMinimumWords || nextWords > wordControl.sectionMaximumWords) {
        throw new Error('本轮调整会使小节超出强控范围');
      }
    }
    if (options.enforceTotalBounds !== false) {
      const nextTotalWords = countTotalContentWords() - currentWords + nextWords;
      if (wordControl.maximumWords > 0 && options.mode === 'expand' && nextTotalWords > wordControl.maximumWords) {
        throw new Error('本轮扩写会使全文超过最多字数');
      }
      if (wordControl.minimumWords > 0 && options.mode === 'shrink' && nextTotalWords < wordControl.minimumWords) {
        throw new Error('本轮缩写会使全文低于最少字数');
      }
    }
    rememberTouchedItem(item.id);
    saveSection(item, { status: 'success', content: nextContent, error: undefined }, nextContent, { logs: state.logs });
    return { currentWords, nextWords };
  }

  async function adjustSectionToRange(context, stage, itemRounds, completedItemIds) {
    const { item } = context;
    let rounds = Math.min(MAX_WORD_ADJUSTMENT_ROUNDS, Math.max(0, Number(itemRounds[item.id]) || 0));
    while (rounds < MAX_WORD_ADJUSTMENT_ROUNDS) {
      const currentWords = getLeafWordCount(item);
      if (!isSectionWordsOutsideRange(wordControl, currentWords)) return true;
      rounds += 1;
      const mode = currentWords < wordControl.sectionMinimumWords ? 'expand' : 'shrink';
      const differenceRatio = Math.abs(currentWords - wordControl.sectionWords) / wordControl.sectionWords;
      const granularity = differenceRatio > 0.2 ? 'paragraph' : 'sentence';
      contentStats.section_adjustment_item_id = item.id;
      contentStats.section_adjustment_round = rounds;
      itemRounds[item.id] = rounds - 1;
      setWordAdjustmentRuntime(stage, item.id, rounds - 1, completedItemIds, itemRounds);
      state.appendLog(`调整小节字数：${item.id} ${item.title || '未命名章节'}，第 ${rounds}/${MAX_WORD_ADJUSTMENT_ROUNDS} 轮，当前 ${currentWords} 字。`);
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
      try {
        await requestWordAdjustment(context, {
          mode,
          granularity,
          targetWords: wordControl.sectionWords,
          maximumChangeWords: Math.abs(currentWords - wordControl.sectionWords),
          enforceSectionBounds: false,
          enforceTotalBounds: !targetItemId,
        });
      } catch (error) {
        if (isPauseLikeError(error)) throw error;
        state.appendLog(`小节字数第 ${rounds} 轮调整未应用：${item.id}，${error.message || String(error)}。`);
      }
      itemRounds[item.id] = rounds;
      setWordAdjustmentRuntime(stage, item.id, rounds, completedItemIds, itemRounds);
      pauseIfRequested('正文生成已在字数调整结果处理后暂停，可稍后继续。');
    }
    return !isSectionWordsOutsideRange(wordControl, getLeafWordCount(item));
  }

  async function runSectionWordAdjustments(targets, stage) {
    if (!wordControl.strictSectionWords) return [];
    const candidates = (targets || []).filter(({ item }) => state.sections[item.id]?.status === 'success' && getLeafWordCount(item) > 0);
    const violations = candidates.filter(({ item }) => isSectionWordsOutsideRange(wordControl, getLeafWordCount(item)));
    const resumingStage = resume && state.contentRuntime.word_adjustment_stage === stage;
    const completedItemIds = resumingStage ? [...state.contentRuntime.word_adjustment_completed_item_ids] : [];
    const completedItemIdSet = new Set(completedItemIds);
    const itemRounds = resumingStage ? { ...state.contentRuntime.word_adjustment_item_rounds } : {};
    const activeItemIds = new Set();
    const pendingViolations = violations.filter(({ item }) => !completedItemIdSet.has(item.id));
    contentStats.phase = stage === 'final-section' ? 'final-section-word-adjusting' : 'section-word-adjusting';
    contentStats.section_adjustment_total = completedItemIds.length + pendingViolations.length;
    contentStats.section_adjustment_completed = completedItemIds.length;
    contentStats.section_adjustment_active_count = 0;
    if (!resumingStage) setWordAdjustmentRuntime(stage, '', 0, completedItemIds, itemRounds);
    const unresolved = new Set(violations.filter(({ item }) => completedItemIdSet.has(item.id)).map(({ item }) => item.id));
    await runItemsWithWorkerPool(pendingViolations, contentConcurrency, async (context) => {
      activeItemIds.add(context.item.id);
      contentStats.section_adjustment_active_count = activeItemIds.size;
      contentStats.section_adjustment_item_id = context.item.id;
      contentStats.section_adjustment_round = Number(itemRounds[context.item.id]) || 0;
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });

      if (!await adjustSectionToRange(context, stage, itemRounds, completedItemIds)) unresolved.add(context.item.id);
      completedItemIds.push(context.item.id);
      completedItemIdSet.add(context.item.id);
      activeItemIds.delete(context.item.id);
      const nextActiveItemId = activeItemIds.values().next().value || '';
      contentStats.section_adjustment_active_count = activeItemIds.size;
      contentStats.section_adjustment_completed = completedItemIds.length;
      contentStats.section_adjustment_item_id = nextActiveItemId;
      contentStats.section_adjustment_round = nextActiveItemId ? Number(itemRounds[nextActiveItemId]) || 0 : 0;
      setWordAdjustmentRuntime(stage, nextActiveItemId, contentStats.section_adjustment_round, completedItemIds, itemRounds);
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
    }, isPauseRequested);
    contentStats.section_adjustment_item_id = '';
    contentStats.section_adjustment_round = 0;
    contentStats.section_adjustment_active_count = 0;
    return [...unresolved];
  }

  async function runTotalWordAdjustments() {
    if (!wordControl.minimumWords && !wordControl.maximumWords || targetItemId || runOnlyIllustrationStage) return;
    contentStats.phase = 'total-word-adjusting';
    const resumingStage = resume && state.contentRuntime.word_adjustment_stage === 'total';
    const initialRound = resumingStage
      ? Math.max(1, Number(state.contentRuntime.word_adjustment_round) || 1)
      : 1;
    if (!resumingStage) setWordAdjustmentRuntime('total', '', 0, [], {}, 0, 0);
    let lastItemId = resumingStage ? state.contentRuntime.word_adjustment_item_id : '';
    let noProgressRounds = resumingStage
      ? Math.max(0, Number(state.contentRuntime.word_adjustment_no_progress_rounds) || 0)
      : 0;
    let round = initialRound;
    while (true) {
      let direction = getTotalWordDirection(wordControl, countTotalContentWords());
      if (!direction) return;
      const isExpansion = direction.mode === 'expand';
      if (!isExpansion && round > MAX_WORD_ADJUSTMENT_ROUNDS) return;
      const resumingRound = resumingStage && round === initialRound;
      const persistedRoundStartWords = Math.max(0, Number(state.contentRuntime.word_adjustment_round_start_words) || 0);
      const roundStartWords = resumingRound && persistedRoundStartWords > 0
        ? persistedRoundStartWords
        : direction.currentWords;
      contentStats.total_adjustment_mode = direction.mode;
      contentStats.total_adjustment_round = round;
      contentStats.total_adjustment_round_total = isExpansion ? 0 : MAX_WORD_ADJUSTMENT_ROUNDS;
      const completedItemIds = resumingRound
        ? [...state.contentRuntime.word_adjustment_completed_item_ids]
        : [];
      const completedItemIdSet = new Set(completedItemIds);
      setWordAdjustmentRuntime('total', lastItemId, round, completedItemIds, {}, noProgressRounds, roundStartWords);
      const differenceRatio = Math.abs(direction.currentWords - direction.targetWords) / direction.targetWords;
      const granularity = differenceRatio > 0.2 ? 'paragraph' : 'sentence';
      // 本轮单节平均预算，用于缩写时过滤可缩空间过小的小节，避免它们占用批次名额却几乎缩不动。
      const averageBudget = Math.abs(direction.currentWords - direction.targetWords) / TOTAL_WORD_ADJUSTMENT_BATCH_SIZE;
      let candidates = leafWordStats().filter(({ item, words }) => {
        if (state.sections[item.id]?.status !== 'success' || words <= 0) return false;
        if (completedItemIdSet.has(item.id)) return false;
        if (!wordControl.strictSectionWords) return true;
        if (direction.mode === 'expand') return words < wordControl.sectionMaximumWords;
        // 缩写：仅保留可缩空间不小于平均预算 30% 的小节，集中资源到真正缩得动的小节上。
        const shrinkableWords = words - wordControl.sectionMinimumWords;
        return shrinkableWords >= averageBudget * TOTAL_WORD_SHRINK_MIN_CAPACITY_RATIO;
      }).sort((left, right) => direction.mode === 'expand' ? left.words - right.words : right.words - left.words);
      if (candidates.length > 1 && candidates[0].item.id === lastItemId) candidates = [...candidates.slice(1), candidates[0]];
      const remainingSlots = Math.max(0, TOTAL_WORD_ADJUSTMENT_BATCH_SIZE - completedItemIds.length);
      const batch = buildTotalWordAdjustmentBatch(wordControl, candidates, direction, remainingSlots);
      const previousContentStats = storedPlan.contentGenerationTask?.stats?.content;
      contentStats.total_adjustment_batch_total = completedItemIds.length + batch.length;
      contentStats.total_adjustment_batch_completed = completedItemIds.length;
      contentStats.total_adjustment_batch_failed = resumingRound
        ? Number(previousContentStats?.total_adjustment_batch_failed) || 0
        : 0;
      contentStats.total_adjustment_active_count = 0;
      contentStats.total_adjustment_item_id = '';
      contentStats.total_adjustment_remaining_words = Math.abs(direction.currentWords - direction.targetWords);
      if (!batch.length && !completedItemIds.length) {
        if (isExpansion) {
          state.appendLog('全文扩写没有可继续调整的小节，停止自动扩写。');
          publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
          return;
        }
        round += 1;
        setWordAdjustmentRuntime('total', '', round, [], {}, noProgressRounds, 0);
        continue;
      }

      if (batch.length) {
        const roundLabel = isExpansion ? `第 ${round} 轮` : `第 ${round}/${MAX_WORD_ADJUSTMENT_ROUNDS} 轮`;
        state.appendLog(`全文字数调整${roundLabel}：提交 ${batch.length} 个小节，当前还需${direction.mode === 'expand' ? '增加' : '减少'} ${contentStats.total_adjustment_remaining_words} 字。`);
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
        const activeItemIds = new Set();
        const batchResults = await Promise.allSettled(batch.map(async ({ context: candidate, budget, guidanceWords }) => {
          activeItemIds.add(candidate.item.id);
          contentStats.total_adjustment_active_count = activeItemIds.size;
          contentStats.total_adjustment_item_id = candidate.item.id;
          state.appendLog(direction.mode === 'expand'
            ? `全文扩写已提交：${candidate.item.id} ${candidate.item.title || '未命名章节'}，当前 ${candidate.words} 字，内部指导 ${guidanceWords} 字，本次预算 ${budget} 字。`
            : `全文缩写已提交：${candidate.item.id} ${candidate.item.title || '未命名章节'}，本次预算 ${budget} 字。`);
          publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
          let failed = false;
          try {
            await requestWordAdjustment(candidate, {
              mode: direction.mode,
              granularity,
              targetWords: direction.mode === 'expand' ? candidate.words + budget : Math.max(1, candidate.words - budget),
              maximumChangeWords: budget,
              totalRemainingWords: contentStats.total_adjustment_remaining_words,
              enforceSectionBounds: wordControl.strictSectionWords,
            });
            lastItemId = candidate.item.id;
          } catch (error) {
            if (isPauseLikeError(error)) throw error;
            failed = true;
            state.appendLog(`全文字数调整未应用：${candidate.item.id}，${error.message || String(error)}。`);
          }
          completedItemIds.push(candidate.item.id);
          completedItemIdSet.add(candidate.item.id);
          activeItemIds.delete(candidate.item.id);
          const nextActiveItemId = activeItemIds.values().next().value || '';
          const nextDirection = getTotalWordDirection(wordControl, countTotalContentWords());
          contentStats.total_adjustment_batch_completed = completedItemIds.length;
          if (failed) contentStats.total_adjustment_batch_failed += 1;
          contentStats.total_adjustment_active_count = activeItemIds.size;
          contentStats.total_adjustment_item_id = nextActiveItemId;
          contentStats.total_adjustment_remaining_words = nextDirection
            ? Math.abs(nextDirection.currentWords - nextDirection.targetWords)
            : 0;
          setWordAdjustmentRuntime('total', candidate.item.id, round, completedItemIds, {}, noProgressRounds, roundStartWords);
          publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
          pauseIfRequested('正文生成已在全文字数调整后暂停，可稍后继续。');
        }));
        const rejected = batchResults.find((result) => result.status === 'rejected');
        if (rejected) throw rejected.reason;
      }

      const currentWords = countTotalContentWords();
      if (isExpansion) {
        if (currentWords > roundStartWords) {
          noProgressRounds = 0;
        } else {
          noProgressRounds += 1;
          state.appendLog(`全文扩写第 ${round} 轮未增加有效字数，连续无进展 ${noProgressRounds}/${MAX_EXPANSION_NO_PROGRESS_ROUNDS} 轮。`);
        }
      }
      const nextDirection = getTotalWordDirection(wordControl, countTotalContentWords());
      contentStats.total_adjustment_remaining_words = nextDirection
        ? Math.abs(nextDirection.currentWords - nextDirection.targetWords)
        : 0;
      round += 1;
      setWordAdjustmentRuntime('total', '', round, [], {}, noProgressRounds, 0);
      if (isExpansion && noProgressRounds >= MAX_EXPANSION_NO_PROGRESS_ROUNDS) {
        state.appendLog(`全文扩写连续 ${MAX_EXPANSION_NO_PROGRESS_ROUNDS} 轮没有增加有效字数，停止自动扩写。`);
        publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
        return;
      }
    }
  }

  return {
    requestWordAdjustment,
    adjustSectionToRange,
    runSectionWordAdjustments,
    runTotalWordAdjustments,
  };
}

module.exports = { createWordAdjustmentStage };
