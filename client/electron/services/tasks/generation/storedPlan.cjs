// 已保存的正文编排决策（stored plan）：版本校验、归一化、表格需求复用判定与清理。
// 纯函数，只做对象与字符串变换，不接触任务状态、模型或文件系统，可单独测试。

const { normalizeContentPlan, now } = require('./normalize.cjs');
const { normalizeTableRequirement } = require('./markdownTables.cjs');
const { hasFactSelection } = require('./knowledgeResolution.cjs');
const { validateContentPlan } = require('./validators.cjs');

const GENERATION_WORD_TARGET_RATIO = 0.8;

const CONTENT_PLAN_VERSION = 4;

// 按全文上限倒推每小节生成目标：留出折扣缓冲，避免所有小节都顶着预设字数生成导致初稿总量系统性超上限。
// 仅在启用强控小节字数且设置了全文上限时生效，其余情况返回 0 表示沿用预设字数。
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

function countRetainedTablePlans(plans, excludedItemIds) {
  let count = 0;
  for (const [itemId, value] of Object.entries(plans || {})) {
    if (excludedItemIds?.has(itemId)) {
      continue;
    }
    const storedPlan = normalizeStoredContentPlan(value);
    if (storedPlan?.plan?.table?.needed) {
      count += 1;
    }
  }
  return count;
}

module.exports = {
  countRetainedTablePlans,
  computeGenerationWordTarget,
  createStoredContentPlan,
  normalizeStoredContentPlan,
  isStoredContentPlanReusableForTableRequirement,
  pruneContentGenerationPlans,
};
