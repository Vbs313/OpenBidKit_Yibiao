// 全文字数调整的批次计算：判断小节是否越界、决定扩写/缩写方向，并按预算切批。
// 纯函数，只做数值与结构运算，不接触任务状态、模型或文件系统，可单独测试。

// 小节字数调整的最大轮次。
const MAX_WORD_ADJUSTMENT_ROUNDS = 3;
// 全文扩写不限制有效轮数，仅在连续多轮没有增加字数时退出。
const MAX_EXPANSION_NO_PROGRESS_ROUNDS = 3;
// 每轮全文调整最多选择的小节数。
const TOTAL_WORD_ADJUSTMENT_BATCH_SIZE = 10;
// 全文缩写阶段筛选候选小节时，可缩空间至少要达到本轮单节平均预算的比例，
// 低于此值的小节直接跳过以免空占批次名额。
const TOTAL_WORD_SHRINK_MIN_CAPACITY_RATIO = 0.3;

const DEFAULT_SECTION_WORD_GUIDANCE = 3000;
const TOTAL_WORD_SHRINK_SECTION_RATIO = 0.25;

  function isSectionWordsOutsideRange(wordControl, words) {
    return wordControl.strictSectionWords
      && (words < wordControl.sectionMinimumWords || words > wordControl.sectionMaximumWords);
  }
  function getTotalWordDirection(wordControl, currentWords) {
    if (!wordControl.minimumWords && !wordControl.maximumWords) return null;
        if (wordControl.minimumWords > 0 && currentWords < wordControl.minimumWords) {
      return { mode: 'expand', currentWords, targetWords: wordControl.minimumWords };
    }
    if (wordControl.maximumWords > 0 && currentWords > wordControl.maximumWords) {
      return { mode: 'shrink', currentWords, targetWords: wordControl.maximumWords };
    }
    return null;
  }
  function buildTotalWordExpansionBatch(wordControl, selected, direction) {
    const guidanceWords = wordControl.sectionWords > 0 ? wordControl.sectionWords : DEFAULT_SECTION_WORD_GUIDANCE;
    const entries = selected.map((candidate, index) => {
      const capacity = wordControl.strictSectionWords
        ? Math.max(0, wordControl.sectionMaximumWords - candidate.words)
        : Number.POSITIVE_INFINITY;
      return {
        context: candidate,
        index,
        guidanceWords,
        guidanceGap: Math.min(Math.max(0, guidanceWords - candidate.words), capacity),
        capacity,
        budget: 0,
      };
    });
    let unallocatedWords = Math.abs(direction.currentWords - direction.targetWords);
    const totalGuidanceGap = entries.reduce((sum, entry) => sum + entry.guidanceGap, 0);
    const guidanceBudget = Math.min(unallocatedWords, totalGuidanceGap);

    if (guidanceBudget > 0 && totalGuidanceGap > 0) {
      const allocations = entries.map((entry) => {
        const rawBudget = (guidanceBudget * entry.guidanceGap) / totalGuidanceGap;
        return {
          entry,
          budget: Math.floor(rawBudget),
          remainder: rawBudget - Math.floor(rawBudget),
        };
      });
      let remainderWords = guidanceBudget - allocations.reduce((sum, allocation) => sum + allocation.budget, 0);
      const remainderOrder = [...allocations]
        .filter((allocation) => allocation.budget < allocation.entry.guidanceGap)
        .sort((left, right) => right.remainder - left.remainder || left.entry.index - right.entry.index);
      for (const allocation of remainderOrder) {
        if (remainderWords <= 0) break;
        allocation.budget += 1;
        remainderWords -= 1;
      }
      for (const allocation of allocations) {
        allocation.entry.budget = allocation.budget;
      }
      unallocatedWords -= guidanceBudget;
    }

    while (unallocatedWords > 0) {
      const available = entries.filter((entry) => entry.budget < entry.capacity);
      if (!available.length) break;
      const fairShare = Math.ceil(unallocatedWords / available.length);
      let allocatedThisPass = 0;
      for (const entry of available) {
        const capacity = entry.capacity - entry.budget;
        const addition = Math.max(0, Math.min(unallocatedWords, fairShare, capacity));
        if (addition <= 0) continue;
        entry.budget += addition;
        unallocatedWords -= addition;
        allocatedThisPass += addition;
      }
      if (!allocatedThisPass) break;
    }

    return entries
      .filter((entry) => entry.budget > 0)
      .map(({ context, budget, guidanceWords: itemGuidanceWords }) => ({
        context,
        budget,
        guidanceWords: itemGuidanceWords,
      }));
  }
  function buildTotalWordShrinkBatch(wordControl, selected, direction) {
    let unallocatedWords = Math.abs(direction.currentWords - direction.targetWords);
    const batch = [];
    for (let index = 0; index < selected.length && unallocatedWords > 0; index += 1) {
      const candidate = selected[index];
      const remainingSlots = selected.length - index;
      const fairShare = Math.ceil(unallocatedWords / remainingSlots);
      const ratioCapacity = Math.max(1, Math.floor(candidate.words * TOTAL_WORD_SHRINK_SECTION_RATIO));
      const readableCapacity = Math.max(0, candidate.words - 1);
      const sectionCapacity = wordControl.strictSectionWords
        ? Math.min(ratioCapacity, candidate.words - wordControl.sectionMinimumWords, readableCapacity)
        : readableCapacity;
      const budget = Math.max(0, Math.min(unallocatedWords, fairShare, sectionCapacity));
      if (budget <= 0) continue;
      batch.push({ context: candidate, budget, guidanceWords: 0 });
      unallocatedWords -= budget;
    }
    return batch;
  }
  function buildTotalWordAdjustmentBatch(wordControl, candidates, direction, slotCount) {
    const selected = candidates.slice(0, slotCount);
    return direction.mode === 'expand'
      ? buildTotalWordExpansionBatch(wordControl, selected, direction)
      : buildTotalWordShrinkBatch(wordControl, selected, direction);
  }

module.exports = {
  MAX_WORD_ADJUSTMENT_ROUNDS,
  MAX_EXPANSION_NO_PROGRESS_ROUNDS,
  TOTAL_WORD_ADJUSTMENT_BATCH_SIZE,
  TOTAL_WORD_SHRINK_MIN_CAPACITY_RATIO,
  isSectionWordsOutsideRange,
  getTotalWordDirection,
  buildTotalWordAdjustmentBatch,
};
