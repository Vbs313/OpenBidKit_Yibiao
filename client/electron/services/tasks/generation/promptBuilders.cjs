// 提示词拼装：把章节/事实/知识等数据渲染成模型输入，纯函数，可单独测试。
const { singleLine } = require('./agentResponse.cjs');

function formatGlobalFactsForPrompt(globalFacts) {
  const groups = (Array.isArray(globalFacts) ? globalFacts : [])
    .map((group, index) => {
      const title = singleLine(group?.title || `全局事实${index + 1}`);
      const content = String(group?.content || '').trim();
      if (!title || !content) return '';
      return `## ${title}\n${content}`;
    })
    .filter(Boolean);
  return groups.join('\n\n');
}

function formatGlobalFactTitlesForPrompt(globalFacts) {
  const titles = (Array.isArray(globalFacts) ? globalFacts : [])
    .map((group) => singleLine(group?.title))
    .filter(Boolean);
  return JSON.stringify([...new Set(titles)], null, 2);
}

function formatBidAnalysisFactForPrompt(storedPlan, itemId, label) {
  const item = storedPlan?.bidAnalysisTasks?.[itemId];
  const content = item?.status === 'success' ? String(item.content || '').trim() : '';
  return content ? `## ${label}\n${content}` : '';
}

function formatBidAnalysisFactsForPrompt(storedPlan) {
  return [
    formatBidAnalysisFactForPrompt(storedPlan, 'projectInfo', '项目信息'),
    formatBidAnalysisFactForPrompt(storedPlan, 'partAInfo', '甲方信息'),
    formatBidAnalysisFactForPrompt(storedPlan, 'deliveryAndServiceRequirements', '交货和服务要求'),
  ].filter(Boolean).join('\n\n');
}

function formatBidKeyInfoForPrompt(projectOverview, bidAnalysisFactsText) {
  return [
    String(projectOverview || '').trim() ? `## 项目概述\n${String(projectOverview || '').trim()}` : '',
    String(bidAnalysisFactsText || '').trim(),
  ].filter(Boolean).join('\n\n') || '未提供';
}

function formatSelectedGlobalFactsForPrompt(globalFacts) {
  return (Array.isArray(globalFacts) ? globalFacts : [])
    .map((group) => {
      const title = singleLine(group?.title);
      const content = String(group?.content || '').trim();
      return title && content ? `## ${title}\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function formatContentPlanForPrompt(plan) {
  const lines = [
    `写作重点：${plan.writing_focus || '围绕当前章节标题和描述展开'}`,
    `事实变量：${plan.facts?.titles?.length ? plan.facts.titles.join('；') : '无'}`,
    `表格：${plan.table.needed ? `需要，目的：${plan.table.purpose || '提升正文表达清晰度'}` : '不需要，本小节不要输出 Markdown 表格'}`,
    `原方案还原：${plan.original_material?.restored ? `已还原 ${plan.original_material.restored_chars || 0} 字` : '未还原'}`,
  ];
  return lines.join('\n');
}

function formatKnowledgeContentsForPrompt(contents) {
  return (contents || [])
    .map((content) => `<knowledge_content>\n${String(content || '').trim()}\n</knowledge_content>`)
    .join('\n\n');
}

function formatOriginalSegmentsForPrompt(segments) {
  return (segments || []).map((segment) => `<original_segment id="${segment.id}">
标题路径：${segment.title_path?.length ? segment.title_path.join(' > ') : '未识别标题'}
字符数：${segment.chars || String(segment.content || '').length}
原文：
${segment.content}
</original_segment>`).join('\n\n');
}

function formatRestoreTargetsForPrompt(targets) {
  return (targets || []).map(({ item, parentChapters, siblingChapters }) => {
    const parentPath = (parentChapters || []).map((parent) => `${parent.id || 'unknown'} ${parent.title || '未命名章节'}`).join(' > ') || '无';
    const siblings = (siblingChapters || [])
      .filter((sibling) => sibling.id !== item.id)
      .map((sibling) => `${sibling.id || 'unknown'} ${sibling.title || '未命名章节'}`)
      .join('；') || '无';
    return `- node_id: ${item.id || 'unknown'}
  标题: ${item.title || '未命名章节'}
  描述: ${item.description || ''}
  上级章节: ${parentPath}
  同级章节: ${siblings}`;
  }).join('\n');
}

function buildOriginalRestoreRepairMessages({ invalidContent, issues }, targets, originalSegments) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“原方案段落归属映射”JSON。

必须满足：
1. 顶层只能包含 assignments 数组。
2. 每条 assignment 必须包含 node_id 和 source_ids。
3. node_id 只能使用当前可还原叶子节点中的 ID。
4. source_ids 只能使用原方案段落编号。
5. 如果某个原方案段只有章节标题、Markdown 标题或目录编号，没有实质正文内容，不要把它分配为正文来源；如果待修复内容中包含这类 source_id，请从 source_ids 中移除。
6. 严禁输出正文、总结、解释或 Markdown。`,
    },
    { role: 'user', content: `当前可还原叶子节点：\n${formatRestoreTargetsForPrompt(targets) || '无'}` },
    { role: 'user', content: `原方案段落（用于判断 source_ids 是否只有标题、编号或实质正文）：\n${formatOriginalSegmentsForPrompt(originalSegments) || '无'}` },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function buildContentExpansionRepairMessages({ invalidContent, issues }, currentContent = '') {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  const currentContentBlock = String(currentContent || '').trim()
    ? [{ role: 'user', content: `当前正文，用于 replace 时逐字复制 target_text：\n${String(currentContent || '').slice(0, 60000)}` }]
    : [];
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“正文局部扩写”JSON。

必须满足：
1. 顶层只能包含 operation、anchor、target_text、content。
2. operation 只能是 "insert" 或 "replace"。
3. 严禁使用 delete、rewrite_full、rewrite、append、update 或其他 operation。
4. insert 表示新增段落；anchor 写建议插入在哪个原段落之后，无法确定时写 "end"。
5. replace 表示重写并扩写一个完整 Markdown 原文块；target_text 必须逐字复制完整待替换块，不得摘要、改写或只返回其中一句。
6. content 只能是新增或替换后的正文片段，不要返回完整章节正文。
7. content 不得包含章节标题、Markdown 标题、图片 Markdown、Mermaid、代码块或解释文字。
8. insert 时 target_text 留空；replace 时 anchor 可留空，但 target_text 必须非空。
9. 只返回 JSON，不要输出 Markdown 代码围栏或解释。`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    ...currentContentBlock,
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function buildConsistencyAuditRepairMessages({ invalidContent, issues }, allowedSectionIds) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“全文一致性审计”JSON。

必须满足：
1. 顶层只能包含 conflicts 数组。
2. conflicts 可以为空数组。
3. 每条 conflict 必须包含 section_id、fact_title、evidence、reason、severity。
4. section_id 只能来自允许清单。
5. 禁止输出正文、修复方案、Markdown 或解释文字。

允许的 section_id：
${JSON.stringify(Array.from(allowedSectionIds || []), null, 2)}`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function buildConsistencyRepairJsonRepairMessages({ invalidContent, issues }, expectedSectionId) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“正文一致性局部修复”JSON。

必须满足：
1. 顶层只能包含 patches 数组。
2. 每条 patch 必须包含 section_id、start_line、end_line、old_text、new_text、reason。
3. section_id 必须是 ${expectedSectionId}。
4. old_text 和 new_text 都不能包含行号，不能相同，不能为空。
5. 不要返回完整正文，不要输出 Markdown 或解释文字。
6. 如果无法修复，返回 {"patches":[]}。`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function buildOriginalCoverageAuditJsonRepairMessages({ invalidContent, issues }, target) {
  const issueLines = (issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  const allowedSourceIds = (target.sources || []).map((segment) => segment.id).filter(Boolean);
  return [
    {
      role: 'user',
      content: `你是严格的 JSON 修复器。请把模型输出修复为“原方案覆盖审计”JSON。

必须满足：
1. 顶层只能包含 items 数组。
2. 必须为每个 source_id 返回一条 item，不能遗漏，不能重复。
3. 每条 item 必须包含 source_id、node_id、status、missing_points、repair_suggestion。
4. node_id 必须是 ${target.item.id || 'unknown'}。
5. status 只能是 covered、partial、missing、conflict。
6. 禁止输出正文、修复 patch、Markdown 或解释文字。

允许的 source_id：
${JSON.stringify(allowedSourceIds, null, 2)}`,
    },
    { role: 'user', content: `错误列表：\n${issueLines}` },
    { role: 'user', content: `待修复内容：\n\`\`\`json\n${String(invalidContent || '').slice(0, 60000)}\n\`\`\`` },
  ];
}

function buildWordAdjustmentRepairMessages({ invalidContent, issues }, expectedMode, expectedGranularity, currentContent) {
  const operationRule = expectedMode === 'expand'
    ? '扩写只允许 insert/replace。insert 的 anchor 必须逐字复制当前正文中的唯一完整原文块，或使用 start/end；replace 的 target_text 必须逐字复制当前正文中的唯一完整目标。'
    : '缩写只允许 replace/delete，target_text 必须逐字复制当前正文中的唯一完整目标。';
  const responseFormat = expectedMode === 'expand'
    ? `{"mode":"expand","granularity":"${expectedGranularity}","operations":[{"operation":"insert","anchor":"完整唯一原文块或 start/end","target_text":"","content":"新增正文"}]}`
    : `{"mode":"shrink","granularity":"${expectedGranularity}","operations":[{"operation":"replace","target_text":"完整唯一原文块","content":"缩写后的正文"}]}`;
  return [
    { role: 'user', content: `请把待修复内容整理为正文局部字数调整 JSON。mode 必须是 ${expectedMode}，granularity 必须是 ${expectedGranularity}，operations 至少一项。${operationRule} content 不得包含标题、图片、Mermaid、代码块或表格，不得破坏列表层级、事实参数和服务承诺。返回格式：${responseFormat}。只返回 JSON。` },
    { role: 'user', content: `错误列表：\n${(issues || []).map((item, index) => `${index + 1}. ${item}`).join('\n')}` },
    { role: 'user', content: `当前正文：\n${String(currentContent || '').slice(0, 60000)}` },
    { role: 'user', content: `待修复内容：\n${String(invalidContent || '').slice(0, 60000)}` },
  ];
}

module.exports = {
  formatGlobalFactsForPrompt,
  formatGlobalFactTitlesForPrompt,
  formatBidAnalysisFactForPrompt,
  formatBidAnalysisFactsForPrompt,
  formatBidKeyInfoForPrompt,
  formatSelectedGlobalFactsForPrompt,
  formatContentPlanForPrompt,
  formatKnowledgeContentsForPrompt,
  formatOriginalSegmentsForPrompt,
  formatRestoreTargetsForPrompt,
  buildOriginalRestoreRepairMessages,
  buildContentExpansionRepairMessages,
  buildConsistencyAuditRepairMessages,
  buildConsistencyRepairJsonRepairMessages,
  buildOriginalCoverageAuditJsonRepairMessages,
  buildWordAdjustmentRepairMessages,
};
