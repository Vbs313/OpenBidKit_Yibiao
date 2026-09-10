// 模型返回结构的校验器：与 generation/normalize.cjs 配对使用（先归一、后校验）。

function validateContentPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('正文编排决策必须是对象');
  }
  if (!plan.knowledge || !Array.isArray(plan.knowledge.item_ids)) {
    throw new Error('正文编排决策缺少 knowledge.item_ids');
  }
  if (!plan.facts || !Array.isArray(plan.facts.titles)) {
    throw new Error('正文编排决策缺少 facts.titles');
  }
  if (typeof plan.writing_focus !== 'string' || !plan.writing_focus.trim()) {
    throw new Error('正文编排决策缺少 writing_focus');
  }
  if (!plan.table || typeof plan.table.needed !== 'boolean') {
    throw new Error('正文编排决策缺少 table.needed');
  }
}

function validateOriginalRestoreAssignments(value) {
  if (!value || !Array.isArray(value.assignments)) {
    throw new Error('原方案还原映射缺少 assignments 数组');
  }
  for (const assignment of value.assignments) {
    if (!assignment.node_id || !Array.isArray(assignment.source_ids)) {
      throw new Error('原方案还原映射项缺少 node_id 或 source_ids');
    }
  }
}

function validateContentExpansionPatch(patch) {
  if (!patch || !['insert', 'replace'].includes(patch.operation)) {
    throw new Error(`扩写结果 operation 无效：${patch?.operation || '空'}，只能是 insert 或 replace`);
  }
  if (patch.operation === 'replace' && !String(patch.target_text || '').trim()) {
    throw new Error('扩写 replace 结果缺少 target_text');
  }
  if (!String(patch.content || '').trim()) {
    throw new Error('扩写结果缺少 content');
  }
}

function validateConsistencyAuditResponse(value) {
  if (!value || !Array.isArray(value.conflicts)) {
    throw new Error('一致性审计结果缺少 conflicts 数组');
  }
}

module.exports = {
  validateContentPlan,
  validateOriginalRestoreAssignments,
  validateContentExpansionPatch,
  validateConsistencyAuditResponse,
};
