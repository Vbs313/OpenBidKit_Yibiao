// 合规检查项注册表。requiresModel 决定是否必须向 Sidecar 传 model_config。
// LLM 检查必须通过 B 的本地模型代理，Sidecar 协议本身不接受任何凭据字段。
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
};

const DEFAULT_COMPLIANCE_CHECKS = Object.keys(complianceCheckRegistry);

function normalizeCheckIds(checks) {
  const list = Array.isArray(checks) && checks.length ? checks : DEFAULT_COMPLIANCE_CHECKS;
  const unique = [];
  for (const raw of list) {
    const checkId = String(raw || '').trim();
    if (!checkId || !complianceCheckRegistry[checkId]) continue;
    if (!unique.includes(checkId)) unique.push(checkId);
  }
  return unique;
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
  complianceCheckRegistry,
  listComplianceChecks,
  normalizeCheckIds,
  requiresModel,
};
