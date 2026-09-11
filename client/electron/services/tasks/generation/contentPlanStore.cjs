// 内容编排读取层：把历史编排、当前编排和当前表格要求归一成「本小节要用的编排计划」。
//
// 这层在 tasksToRun 计算前就要用到（原方案还原状态依赖历史编排），所以只做读取、不做落盘；
// 落盘仍由编排函数自己的 persistContentPlans 负责。
//
// deps 约定：
//   contentPlans                 本次任务的编排缓存（Map，原地复用）
//   allowedFactTitles            允许的事实标题集合（只读）
//   tableRequirement             本次表格要求
//   state.storedContentPlans / state.allowedKnowledgeItemIds   会被重新赋值的闭包变量

const { normalizeContentPlan } = require('./normalize.cjs');
const { clearContentPlanTable } = require('./markdownTables.cjs');
const {
  normalizeStoredContentPlan,
  isStoredContentPlanReusableForTableRequirement,
} = require('./storedPlan.cjs');

function createContentPlanStore(deps) {
  const { contentPlans, allowedFactTitles, tableRequirement } = deps;
  const { state } = deps;

  function getStoredContentPlan(itemId) {
    return normalizeStoredContentPlan(state.storedContentPlans[itemId]);
  }

  function applyCurrentTableRequirementToPlan(plan) {
    const normalizedPlan = normalizeContentPlan(plan, state.allowedKnowledgeItemIds, allowedFactTitles);
    return tableRequirement === 'none' ? clearContentPlanTable(normalizedPlan) : normalizedPlan;
  }

  function getReusableStoredContentPlan(itemId) {
    const storedContentPlan = getStoredContentPlan(itemId);
    if (!storedContentPlan || !isStoredContentPlanReusableForTableRequirement(storedContentPlan, tableRequirement)) {
      return null;
    }
    return {
      ...storedContentPlan,
      plan: applyCurrentTableRequirementToPlan(storedContentPlan.plan),
    };
  }

  function getContentPlanForItem(itemId) {
    const plan = contentPlans.get(itemId) || getReusableStoredContentPlan(itemId)?.plan || normalizeContentPlan({}, state.allowedKnowledgeItemIds, allowedFactTitles);
    contentPlans.set(itemId, plan);
    return plan;
  }

  return {
    getStoredContentPlan,
    getReusableStoredContentPlan,
    getContentPlanForItem,
    applyCurrentTableRequirementToPlan,
  };
}

module.exports = { createContentPlanStore };
