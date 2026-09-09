/**
 * 合规检查项注册表。requiresModel 决定是否必须向 Sidecar 准备 model_config。
 *
 * 两个入口刻意分开：
 * - normalizeCheckIds：宽松，用于状态回放与水合。旧工程里可能残留已下线编号，不能因此打不开页面。
 * - assertKnownChecks：严格，用于发起检查前。Main 与 Sidecar 版本不一致时必须报错，
 *   否则会静默少跑检查项，让用户误以为“已经查过了”。
 */
const complianceCheckRegistry = {
  pricing_arithmetic: {
    label: '报价算术核查',
    description: '检查单价 × 数量、分项合计、总价、大小写金额、空白值与重复计费。',
    requiresModel: false,
    group: 'pricing',
  },
  validity: {
    label: '投标有效期核查',
    description: '检查投标有效期是否满足招标要求，以及有效期是否覆盖开标与定标节点。',
    requiresModel: false,
    group: 'timeline',
  },
  deposit: {
    label: '投标保证金核查',
    description: '检查保证金金额、缴纳方式与缴纳时限是否与招标要求一致。',
    requiresModel: false,
    group: 'deposit',
  },
  cross_check: {
    label: '评分项交叉对照',
    description: '逐项判断技术评分项在投标文件中的覆盖情况，需要已配置文本模型。',
    requiresModel: true,
    group: 'scoring',
  },
};

const DEFAULT_COMPLIANCE_CHECKS = Object.keys(complianceCheckRegistry);

function pickCheckIds(checks) {
  const list = Array.isArray(checks) && checks.length ? checks : DEFAULT_COMPLIANCE_CHECKS;
  const ids = [];
  const unknown = [];
  for (const raw of list) {
    const checkId = String(raw || '').trim();
    if (!checkId) continue;
    if (!complianceCheckRegistry[checkId]) {
      if (!unknown.includes(checkId)) unknown.push(checkId);
      continue;
    }
    if (!ids.includes(checkId)) ids.push(checkId);
  }
  return { ids, unknown };
}

/** 宽松解析：丢弃未知编号并回落到全部检查项，保证历史状态可回放。 */
function normalizeCheckIds(checks) {
  const { ids } = pickCheckIds(checks);
  return ids.length ? ids : DEFAULT_COMPLIANCE_CHECKS.slice();
}

/** 严格校验：发起检查前调用，未知编号或直接为空都要抛出可见错误。 */
function assertKnownChecks(checks) {
  const { ids, unknown } = pickCheckIds(checks);
  if (unknown.length) {
    const error = new Error(`未知的合规检查项：${unknown.join('、')}。请重启应用以同步检查项注册表。`);
    error.code = 'COMPLIANCE_UNKNOWN_CHECK';
    throw error;
  }
  if (!ids.length) {
    const error = new Error('没有可用的合规检查项');
    error.code = 'COMPLIANCE_NO_CHECKS';
    throw error;
  }
  return ids;
}

function requiresModel(checks) {
  return normalizeCheckIds(checks).some((checkId) => complianceCheckRegistry[checkId].requiresModel);
}

function listComplianceChecks() {
  return Object.entries(complianceCheckRegistry).map(([checkId, definition]) => ({
    check_id: checkId,
    label: definition.label,
    description: definition.description,
    group: definition.group,
    requires_model: definition.requiresModel,
  }));
}

module.exports = {
  DEFAULT_COMPLIANCE_CHECKS,
  assertKnownChecks,
  complianceCheckRegistry,
  listComplianceChecks,
  normalizeCheckIds,
  requiresModel,
};
