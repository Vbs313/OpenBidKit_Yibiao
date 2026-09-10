// 全文一致性修复：把审计冲突整理成局部替换 patch 提示词，附上最大修复轮次。
// 纯函数，只做字符串与结构变换，不接触任务状态、模型或文件系统，可单独测试。

const { normalizeTableRequirement } = require('./markdownTables.cjs');
const { buildContentFactCompletenessInstruction, formatChapterPath } = require('./contentMessages.cjs');
const { formatContentWithLineNumbers } = require('./textEdits.cjs');

const CONSISTENCY_REPAIR_MAX_ATTEMPTS = 2;

function buildConsistencyRepairMessages({ context, conflicts, globalFactsText, bidAnalysisFactsText, currentContent, attempt, failures, tableRequirement, globalFactsMode }) {
  const { item } = context;
  const tableAllowed = normalizeTableRequirement(tableRequirement) !== 'none';
  const failureBlock = (failures || []).length
    ? `\n上次修复应用失败原因：\n${failures.map((failure, index) => `${index + 1}. ${failure}`).join('\n')}\n请重新返回能够在当前正文中唯一定位的 old_text。`
    : '';

  return [
    {
      role: 'user',
      content: `你是投标技术方案正文一致性修复助手。请只针对当前小节返回局部精确替换 patch。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown 代码围栏。
2. 不要返回完整正文，只返回需要局部替换的 patches。
3. 事实输入比当前小节实际需要的更多；正文没有涉及的事实必须忽略。
4. 目标只修正正文中与事实冲突的内容，不要参照事实重写或扩充正文。
5. 不要优化文风，不要新增无关事实，不要新增新的承诺。
6. old_text 必须是当前小节正文中逐字存在的原文块，建议包含足够前后上下文，确保只出现一次。
7. ${tableAllowed ? '如果修改表格，old_text 必须包含完整表格行或完整表格块，不要只返回单元格碎片。' : '本次配置为不要表格；如果冲突位于表格中，new_text 必须把相关内容改为普通文字或普通列表，不得继续返回 Markdown 表格或 HTML 表格。'}
8. new_text 是替换后的正文块，不要包含章节标题，不要包含行号。
9. ${tableAllowed ? '保留 Markdown 表格、列表、代码块、图片和 Mermaid 块结构。' : '保留普通列表、代码块、图片和 Mermaid 块结构；不得新增或保留 Markdown 表格、HTML 表格。'}
10. start_line/end_line 使用下方带行号正文中的 1-based 行号；如果不确定也必须提供可唯一匹配的 old_text。${buildContentFactCompletenessInstruction(globalFactsMode) ? `\n\n${buildContentFactCompletenessInstruction(globalFactsMode)}\n不得把【待填写】改成具体值，也不得为缺失项杜撰事实。` : ''}

返回格式：
{
  "patches": [
    {
      "section_id": "当前小节编号",
      "start_line": 2,
      "end_line": 4,
      "old_text": "当前正文中逐字存在且唯一的原文块，不包含行号",
      "new_text": "替换后的正文块，不包含行号",
      "reason": "修复了哪个事实冲突"
    }
  ]
}`,
    },
    { role: 'user', content: `Step04 全局事实变量：\n${globalFactsText || '未提供'}` },
    { role: 'user', content: `Step02 关键解析结果（项目信息、甲方信息、交货和服务要求）：\n${bidAnalysisFactsText || '未提供'}` },
    { role: 'user', content: `当前小节：${item.id || 'unknown'} ${item.title || '未命名章节'}\n路径：${formatChapterPath(context)}\n描述：${item.description || ''}` },
    { role: 'user', content: `审计发现的冲突：\n${JSON.stringify(conflicts || [], null, 2)}` },
    { role: 'user', content: `当前小节正文（带行号；patch 的 old_text/new_text 不要包含这些行号）：\n${formatContentWithLineNumbers(currentContent)}` },
    { role: 'user', content: `patches[*].section_id 必须是 ${item.id || 'unknown'}。修复尝试次数：${attempt}/${CONSISTENCY_REPAIR_MAX_ATTEMPTS}${failureBlock}\n请只返回 JSON。` },
  ];
}

module.exports = {
  CONSISTENCY_REPAIR_MAX_ATTEMPTS,
  buildConsistencyRepairMessages,
};
