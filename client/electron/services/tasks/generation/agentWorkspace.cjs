// Agent 文件模式下的 workspace 文档：渲染 technical-plan.md / global-facts.md，
// 解析回包后的小节校验，以及小节索引构建。
// 纯函数，只做字符串与结构变换，不接触任务状态、模型或文件系统，可单独测试。

const { singleLine } = require('./agentResponse.cjs');
const { escapeSectionAttribute } = require('./agentRestore.cjs');
const { textHash } = require('./textEdits.cjs');
const { normalizeNewlines } = require('./normalize.cjs');
const { buildContentFactCompletenessInstruction } = require('./contentMessages.cjs');

function buildAgentConsistencySectionIndex(targets) {
  const index = new Map();
  for (const context of targets || []) {
    const id = String(context.item?.id || '').trim();
    const content = String(context.content || '').trim();
    if (!id || !content) {
      continue;
    }
    index.set(id, {
      ...context,
      originalContent: content,
      originalHash: textHash(content),
    });
  }
  return index;
}

function renderAgentTechnicalPlanOutline(items, sectionIndex, level = 1, lines = []) {
  for (const item of items || []) {
    const id = String(item?.id || '').trim();
    const title = singleLine(item?.title || '未命名章节');
    const headingLevel = Math.min(level + 1, 6);
    lines.push(`${'#'.repeat(headingLevel)} ${id ? `${id} ` : ''}${title}`.trim());

    if (item?.children?.length) {
      renderAgentTechnicalPlanOutline(item.children, sectionIndex, level + 1, lines);
      continue;
    }

    const section = sectionIndex.get(id);
    if (!section) {
      continue;
    }
    lines.push(`<!-- yibiao-section-start id="${escapeSectionAttribute(id)}" title="${escapeSectionAttribute(title)}" -->`);
    lines.push(section.originalContent);
    lines.push(`<!-- yibiao-section-end id="${escapeSectionAttribute(id)}" -->`);
  }
  return lines;
}

function buildAgentTechnicalPlanMarkdown(outlineData, sectionIndex) {
  const lines = ['# 技术方案正文', ''];
  renderAgentTechnicalPlanOutline(outlineData?.outline || [], sectionIndex, 1, lines);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function buildAgentGlobalFactsMarkdown(globalFactsText, bidAnalysisFactsText) {
  return [
    '# 全局事实变量',
    globalFactsText || '未提供',
    '# Step02 关键解析结果',
    bidAnalysisFactsText || '未提供',
  ].join('\n\n');
}

function buildAgentConsistencyRepairPrompt(globalFactsMode) {
  return `请在当前工作目录中完成全文一致性修复，让 technical-plan.md 成为程序可继续解析和回写的最终正文文件。

workspace 文件说明：
- global-facts.md：全局事实变量、Step02 关键解析结果和需要保持一致的项目信息。
- technical-plan.md：当前技术方案正文全文，包含章节标题、section id 和 yibiao-section-start / yibiao-section-end 标记。

任务目标：
审计并修复 technical-plan.md，使正文不与 global-facts.md 中的全局事实变量冲突，并尽量消除正文前后矛盾。

工作方式由你自行决定。可以搜索、分段读取、建立索引、创建草稿或中间文件，并多轮编辑 technical-plan.md；不需要按固定顺序读取文件，也不需要在单次模型输出中完成全部修复。

最终 technical-plan.md 需要满足：
- 保留所有章节编号、章节标题、HTML 注释标记和 section id。
- 保留原章节结构，不新增、删除或重排章节。
- 正文修改范围限定在 yibiao-section-start 和 yibiao-section-end 标记之间。
- 修复事实冲突、前后矛盾、同一信息多处表达不一致等问题。
- 优先以 global-facts.md 中的事实变量和关键项目信息为准。${buildContentFactCompletenessInstruction(globalFactsMode) ? `\n\n${buildContentFactCompletenessInstruction(globalFactsMode)}\n不得把【待填写】改成具体值，也不得为缺失项杜撰事实。` : ''}`;
}

function validateAgentConsistencySections(parsedSections, sectionIndex) {
  for (const id of parsedSections.keys()) {
    if (!sectionIndex.has(id)) {
      throw new Error(`Agent 输出包含未知小节：${id}`);
    }
  }
  for (const [id, section] of sectionIndex.entries()) {
    if (!parsedSections.has(id)) {
      throw new Error(`Agent 输出缺少小节：${id}`);
    }
    const nextContent = String(parsedSections.get(id) || '').trim();
    if (String(section.originalContent || '').trim() && !nextContent) {
      throw new Error(`Agent 输出把非空小节改为空：${id}`);
    }
  }
}

// 把 Agent 回包解析出的小节写回任务状态：内容没变化或不在可写范围内的小节会被跳过。
// 状态与落盘回调由 createAgentSectionWriter(deps) 注入，可单独测试。
function createAgentSectionWriter(deps) {
  const { state, rememberTouchedItem, saveSection } = deps;

  function applyAgentConsistencySections(parsedSections, sectionIndex, writableIds) {
    let changedCount = 0;
    let skippedCount = 0;
    const changedIds = [];
    for (const [id, section] of sectionIndex.entries()) {
      if (writableIds instanceof Set && !writableIds.has(id)) {
        skippedCount += 1;
        continue;
      }
      const nextContent = String(parsedSections.get(id) || '').trim();
      const currentContent = String(section.originalContent || '').trim();
      if (normalizeNewlines(nextContent).trim() === normalizeNewlines(currentContent).trim()) {
        skippedCount += 1;
        continue;
      }
      changedCount += 1;
      changedIds.push(id);
      rememberTouchedItem(id);
      saveSection(section.item, { status: 'success', content: nextContent, error: undefined }, nextContent, { logs: state.logs });
    }
    return { changedCount, skippedCount, changedIds };
  }

  return { applyAgentConsistencySections };
}

module.exports = {
  buildAgentConsistencySectionIndex,
  buildAgentTechnicalPlanMarkdown,
  buildAgentGlobalFactsMarkdown,
  buildAgentConsistencyRepairPrompt,
  validateAgentConsistencySections,
  createAgentSectionWriter,
};