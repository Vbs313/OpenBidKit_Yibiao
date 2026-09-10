// 已保存的正文编排决策（stored plan）：版本校验、归一化、表格需求复用判定与清理。
// 纯函数，只做对象与字符串变换，不接触任务状态、模型或文件系统，可单独测试。

const { normalizeContentPlan, now } = require('./normalize.cjs');
const { normalizeTableRequirement } = require('./markdownTables.cjs');
const { hasFactSelection } = require('./knowledgeResolution.cjs');
const { validateContentPlan } = require('./validators.cjs');

const GENERATION_WORD_TARGET_RATIO = 0.8;

const CONTENT_PLAN_VERSION = 4;

function computeGenerationWordTarget(wordControl, leafCount) {
  if (!wordControl.strictSectionWords) return 0;
  if (!(wordControl.maximumWords > 0) || !(leafCount > 0)) return 0;
  const derived = Math.floor((wordControl.maximumWords * GENERATION_WORD_TARGET_RATIO) / leafCount);
  // 不低于小节下限，避免倒推目标把 AI 引导到强控范围之外。
  return Math.max(wordControl.sectionMinimumWords, derived);
}

function createStoredContentPlan(plan, tableRequirement) {
  const normalizedTableRequirement = tableRequirement ? normalizeTableRequirement(tableRequirement) : '';
  return {
    plan_version: CONTENT_PLAN_VERSION,
    plan: normalizeContentPlan(plan),
    ...(normalizedTableRequirement ? { table_requirement: normalizedTableRequirement } : {}),
    updated_at: now(),
  };
}

function normalizeStoredContentPlan(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Number(value.plan_version ?? value.planVersion ?? 0) !== CONTENT_PLAN_VERSION) {
    return null;
  }

  if (!hasFactSelection(value)) {
    return null;
  }

  const plan = normalizeContentPlan(value.plan || value.contentPlan || value);
  if (!plan.writing_focus) {
    return null;
  }
  try {
    validateContentPlan(plan);
  } catch {
    return null;
  }
  const tableRequirement = value.table_requirement || value.tableRequirement
    ? normalizeTableRequirement(value.table_requirement || value.tableRequirement)
    : '';
  return {
    plan_version: CONTENT_PLAN_VERSION,
    plan,
    ...(tableRequirement ? { table_requirement: tableRequirement } : {}),
    updated_at: value.updated_at || value.updatedAt || now(),
  };
}

function isStoredContentPlanReusableForTableRequirement(storedContentPlan, tableRequirement) {
  const currentRequirement = normalizeTableRequirement(tableRequirement);
  const storedRequirement = storedContentPlan?.table_requirement || '';
  if (storedRequirement) {
    return storedRequirement === currentRequirement;
  }
  return currentRequirement === 'none';
}

function pruneContentGenerationPlans(plans, leaves) {
  const leafIds = new Set(leaves.map(({ item }) => item.id));
  const next = {};
  for (const [itemId, value] of Object.entries(plans || {})) {
    if (!leafIds.has(itemId)) {
      continue;
    }
    const storedPlan = normalizeStoredContentPlan(value);
    if (storedPlan) {
      next[itemId] = storedPlan;
    }
  }
  return next;
}

module.exports = {
  computeGenerationWordTarget,
  createStoredContentPlan,
  normalizeStoredContentPlan,
  isStoredContentPlanReusableForTableRequirement,
  pruneContentGenerationPlans,
};
