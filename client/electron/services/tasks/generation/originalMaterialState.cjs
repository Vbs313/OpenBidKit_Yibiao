// 原方案还原状态的派生：由小节内容、原方案段索引和编排结果算出“是否已还原/能否重建/待优化”。
//
// 该逻辑原本是 runContentGenerationTask 内部的闭包；这里把只读索引与状态门面显式注入。
// 该模块装配得非常早（tasksToRun 计算时就要求值），因此只依赖当时已就绪的数据。
//
// deps 约定：
//   contentPlans / originalPlanSegmentById / allowedFactTitles          编排函数建好的只读索引
//   getStoredContentPlan(id)                                           读取历史编排结果
//   state.leaves / state.sections / state.allowedKnowledgeItemIds        读取会被重新赋值的闭包变量

const { normalizeOriginalMaterial, normalizeContentPlan, now } = require('./normalize.cjs');

function createOriginalMaterialState(deps) {
  const {
    contentPlans,
    originalPlanSegmentById,
    allowedFactTitles,
    getStoredContentPlan,
  } = deps;
  const { state } = deps;

  function getOriginalMaterialRuntimeState(itemOrId) {
    const itemId = typeof itemOrId === 'string' ? itemOrId : String(itemOrId?.id || '').trim();
    const item = typeof itemOrId === 'string' ? state.leaves.find((context) => context.item.id === itemId)?.item : itemOrId;
    const plan = contentPlans.get(itemId) || getStoredContentPlan(itemId)?.plan || normalizeContentPlan({}, state.allowedKnowledgeItemIds, allowedFactTitles);
    const originalMaterial = normalizeOriginalMaterial(plan.original_material);
    const sourceSegments = originalMaterial.source_ids.map((sourceId) => originalPlanSegmentById.get(sourceId)).filter(Boolean);
    const allSourcesValid = Boolean(originalMaterial.source_ids.length) && sourceSegments.length === originalMaterial.source_ids.length;
    const content = state.sections[itemId]?.content || item?.content || '';
    const hasContent = Boolean(String(content || '').trim());
    const validRestored = Boolean(originalMaterial.restored && allSourcesValid && hasContent);
    const needsRestoreRepair = Boolean(originalMaterial.restored && !validRestored);
    return {
      plan,
      originalMaterial,
      sourceSegments,
      allSourcesValid,
      content,
      hasContent,
      validRestored,
      needsRestoreRepair,
      canRebuildRestoredContent: Boolean(originalMaterial.restored && allSourcesValid && !hasContent),
      needsOptimization: Boolean(validRestored && !originalMaterial.optimized),
    };
  }

  function buildOriginalMaterialFromSegments(segments, previous = {}) {
    const restoredContent = segments.map((segment) => segment.content).join('\n\n').trim();
    return normalizeOriginalMaterial({
      restored: true,
      optimized: false,
      source_ids: segments.map((segment) => segment.id),
      source_titles: segments.map((segment) => segment.title_path?.join(' > ') || segment.id),
      source_hashes: segments.map((segment) => segment.hash),
      restored_chars: restoredContent.length,
      restored_at: previous.restored_at || now(),
    });
  }

  return { getOriginalMaterialRuntimeState, buildOriginalMaterialFromSegments };
}

module.exports = { createOriginalMaterialState };
