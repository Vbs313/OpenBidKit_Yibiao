// 原方案覆盖审计：覆盖状态归一、审计结果校验，以及缺失内容的补写提示词。
// 纯函数，只做字符串与结构变换，不接触任务状态、模型或文件系统，可单独测试。

const { singleLine } = require('./agentResponse.cjs');
const { formatChapterPath, formatOriginalCoverageSources } = require('./contentMessages.cjs');

const ORIGINAL_COVERAGE_STATUSES = new Set(['covered', 'partial', 'missing', 'conflict']);

const ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS = 2;

function normalizeOriginalCoverageStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  if (ORIGINAL_COVERAGE_STATUSES.has(text)) return text;
  if (['已覆盖', '覆盖', '完整', '保留', '保留完整'].includes(text)) return 'covered';
  if (['部分', '部分覆盖', '部分保留', 'partial_covered'].includes(text)) return 'partial';
  if (['缺失', '未覆盖', '未保留', '遗漏'].includes(text)) return 'missing';
  if (['冲突', '矛盾', '不一致'].includes(text)) return 'conflict';
  return text;
}

function normalizeOriginalCoverageAuditResponse(value, context = {}) {
  const source = value?.result && typeof value.result === 'object' ? value.result : value || {};
  const rawItems = Array.isArray(source)
    ? source
    : Array.isArray(source.items)
      ? source.items
      : Array.isArray(source.results)
        ? source.results
        : Array.isArray(source.coverage)
          ? source.coverage
          : [];
  const allowedSourceIds = context.allowedSourceIds instanceof Set ? context.allowedSourceIds : new Set(context.allowedSourceIds || []);
  const expectedNodeId = String(context.expectedNodeId || '').trim();
  const issues = [];
  const items = [];
  const seenSourceIds = new Set();

  rawItems.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`items[${index}] 必须是对象`);
      return;
    }
    const sourceId = String(item.source_id || item.sourceId || item.id || '').trim();
    if (!sourceId || !allowedSourceIds.has(sourceId)) {
      issues.push(`items[${index}].source_id 无效：${sourceId || '空'}`);
      return;
    }
    if (seenSourceIds.has(sourceId)) {
      issues.push(`items[${index}].source_id 重复：${sourceId}`);
      return;
    }
    const rawNodeId = singleLine(item.node_id || item.nodeId || item.section_id || item.sectionId || '');
    const nodeId = rawNodeId && rawNodeId !== '当前小节编号' ? rawNodeId : expectedNodeId;
    if (!nodeId || (expectedNodeId && nodeId !== expectedNodeId)) {
      issues.push(`items[${index}].node_id 无效：${nodeId || '空'}`);
      return;
    }
    const status = normalizeOriginalCoverageStatus(item.status || item.coverage_status || item.coverageStatus);
    if (!ORIGINAL_COVERAGE_STATUSES.has(status)) {
      issues.push(`items[${index}].status 无效：${status || '空'}`);
      return;
    }
    const rawMissingPoints = Array.isArray(item.missing_points || item.missingPoints)
      ? item.missing_points || item.missingPoints
      : item.missing_point || item.missingPoint || item.reason
        ? [item.missing_point || item.missingPoint || item.reason]
        : [];
    seenSourceIds.add(sourceId);
    items.push({
      source_id: sourceId,
      node_id: nodeId,
      status,
      missing_points: rawMissingPoints.map((point) => String(point || '').trim()).filter(Boolean),
      repair_suggestion: String(item.repair_suggestion || item.repairSuggestion || item.suggestion || '').trim(),
    });
  });

  if (issues.length) {
    throw new Error(`原方案覆盖审计结果格式无效：${issues.join('；')}`);
  }
  return { items };
}

function validateOriginalCoverageAuditResponse(value, allowedSourceIds) {
  if (!value || !Array.isArray(value.items)) {
    throw new Error('原方案覆盖审计结果缺少 items 数组');
  }
  const allowed = allowedSourceIds instanceof Set ? allowedSourceIds : new Set(allowedSourceIds || []);
  const seen = new Set(value.items.map((item) => item.source_id).filter(Boolean));
  const missing = Array.from(allowed).filter((sourceId) => !seen.has(sourceId));
  if (missing.length) {
    throw new Error(`原方案覆盖审计缺少 source_id：${missing.join('、')}`);
  }
}

function buildOriginalCoverageRepairMessages({ target, coverageItems, currentContent, attempt, failures }) {
  const failureBlock = (failures || []).length
    ? `\n上次补写应用失败原因：\n${failures.map((failure, index) => `${index + 1}. ${failure}`).join('\n')}\n请重新返回可应用的 insert/replace patch。`
    : '';
  const sourceById = new Map((target.sources || []).map((segment) => [segment.id, segment]));
  const issueSourceIds = [...new Set((coverageItems || []).map((item) => item.source_id).filter(Boolean))];
  const issueSources = issueSourceIds.map((sourceId) => sourceById.get(sourceId)).filter(Boolean);

  return [
    {
      role: 'user',
      content: `你是投标技术方案正文原方案覆盖修复助手。请只针对当前小节返回一次局部补写 patch，用于补回原方案中缺失的实质内容。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown 代码围栏。
2. 不要返回完整正文，只返回一次 insert 或 replace 操作。
3. operation 只能是 "insert" 或 "replace"。
4. 优先使用 insert 在合适段落后补充缺失内容；如果正文已有同主题但内容不完整，可使用 replace 扩写该段。
5. insert 时 anchor 填写建议插入在哪个当前正文段落之后；适合放末尾时写 "end"。
6. replace 时 target_text 必须逐字复制当前小节正文中的完整待替换 Markdown 原文块，不得摘要、改写或只返回其中一句。
7. replace 目标块如为 Markdown 列表、表格、引用、加粗引导块或连续多行结构，target_text 必须包含完整结构。
8. content 只写新增或替换后的正文片段，不要包含章节标题。
9. 必须补回审计指出的 partial/missing 核心信息，但不要提到“原方案”“来源段”“用户原文”。
10. 不要新增图片 Markdown、Mermaid、代码块或伪目录标题，也不要选择图片 Markdown、Mermaid 或代码块作为 replace 的 target_text。
11. 保持与当前小节职责一致，不要写其他章节内容。

返回格式：
{
  "operation": "insert",
  "anchor": "end",
  "target_text": "replace 时填写逐字复制的完整待替换 Markdown 原文块，insert 时留空",
  "content": "补写后的正文片段"
}`,
    },
    { role: 'user', content: `当前小节：${target.item.id || 'unknown'} ${target.item.title || '未命名章节'}\n路径：${formatChapterPath(target)}\n描述：${target.item.description || ''}` },
    { role: 'user', content: `需要补回的原方案来源段：\n${formatOriginalCoverageSources(issueSources)}` },
    { role: 'user', content: `覆盖审计问题：\n${JSON.stringify(coverageItems || [], null, 2)}` },
    { role: 'user', content: `当前小节正文：\n${currentContent || ''}` },
    { role: 'user', content: `补写尝试次数：${attempt}/${ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS}${failureBlock}\n请只返回 JSON。` },
  ];
}

module.exports = {
  ORIGINAL_COVERAGE_REPAIR_MAX_ATTEMPTS,
  normalizeOriginalCoverageAuditResponse,
  validateOriginalCoverageAuditResponse,
  buildOriginalCoverageRepairMessages,
};
