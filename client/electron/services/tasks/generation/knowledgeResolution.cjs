// 章节树、知识库与全局事实的解析：把大纲/知识库/事实数据整理成生成流程可用的形状。
// 纯函数；知识库读取只走注入的 service，不直接触碰文件系统，可单独测试。

const { normalizeFactTitles, normalizeKnowledgeItemIds, normalizeChildren } = require('./normalize.cjs');
const { singleLine } = require('./agentResponse.cjs');
const { formatSelectedGlobalFactsForPrompt } = require('./promptBuilders.cjs');

function resolveGlobalFactsByTitles(titles, globalFacts) {
  const selected = new Set(normalizeFactTitles(titles));
  if (!selected.size) return [];
  return (Array.isArray(globalFacts) ? globalFacts : [])
    .filter((group) => selected.has(singleLine(group?.title)) && String(group?.content || '').trim())
    .map((group) => ({ title: singleLine(group.title), content: String(group.content || '').trim() }));
}

function hasFactSelection(value) {
  const source = value?.plan && typeof value.plan === 'object' ? value.plan : value || {};
  return Object.prototype.hasOwnProperty.call(source || {}, 'facts')
    || Object.prototype.hasOwnProperty.call(source || {}, 'fact_titles')
    || Object.prototype.hasOwnProperty.call(source || {}, 'factTitles')
    || Object.prototype.hasOwnProperty.call(source || {}, 'global_fact_titles')
    || Object.prototype.hasOwnProperty.call(source || {}, 'globalFactTitles');
}

function collectLeafContexts(items, parents = []) {
  const results = [];
  for (const item of items || []) {
    const children = normalizeChildren(item);
    if (!children.length) {
      results.push({ item, parentChapters: parents, siblingChapters: items || [] });
      continue;
    }
    results.push(...collectLeafContexts(children, [...parents, item]));
  }
  return results;
}

function loadContentKnowledgeReferences(knowledgeBaseService, documentIds, log) {
  if (!documentIds.length) {
    log('本次正文编排未选择参考知识库。');
    return { items: [], contentMap: new Map() };
  }
  if (!knowledgeBaseService?.readReferences) {
    log('未找到知识库读取服务，正文编排不使用知识库。');
    return { items: [], contentMap: new Map() };
  }

  try {
    const references = knowledgeBaseService.readReferences(documentIds);
    const items = [];
    const contentMap = new Map();
    for (const reference of Array.isArray(references) ? references : []) {
      const documentId = String(reference?.document?.id || '').trim();
      for (const item of Array.isArray(reference?.items) ? reference.items : []) {
        const itemId = String(item?.id || '').trim();
        const content = String(item?.content || '').trim();
        if (documentId && itemId && content) contentMap.set(`${documentId}::${itemId}`, { content });
        const title = String(item?.title || '').trim();
        const resume = String(item?.resume || '').trim();
        if (reference?.document?.status === 'success' && documentId && itemId && title && resume) {
          items.push({ id: `${documentId}::${itemId}`, title, resume });
        }
      }
    }
    log(items.length ? `正文编排已读取 ${items.length} 条知识库轻量条目。` : '未读取到可用知识库轻量条目，正文编排不使用知识库。');
    if (contentMap.size) log(`正文生成可用知识库正文素材 ${contentMap.size} 条。`);
    return { items, contentMap };
  } catch (error) {
    log(`读取正文编排参考知识库失败，已跳过：${error.message || String(error)}`);
    return { items: [], contentMap: new Map() };
  }
}

function resolveKnowledgeContents(itemIds, knowledgeContentMap) {
  const selected = new Set(normalizeKnowledgeItemIds(itemIds));
  if (!selected.size || !(knowledgeContentMap instanceof Map) || !knowledgeContentMap.size) {
    return [];
  }

  const contents = [];
  for (const [id, item] of knowledgeContentMap.entries()) {
    if (selected.has(id) && item?.content) {
      contents.push(item.content);
    }
  }
  return contents;
}

function resolveSelectedFactsText(contentPlan, globalFacts) {
  const selectedFacts = resolveGlobalFactsByTitles(contentPlan?.facts?.titles, globalFacts);
  return formatSelectedGlobalFactsForPrompt(selectedFacts);
}

function updateOutlineItemContent(items, targetId, content) {
  return (items || []).map((item) => {
    if (item.id === targetId) {
      return { ...item, content };
    }

    const children = normalizeChildren(item);
    if (!children.length) {
      return item;
    }

    return { ...item, children: updateOutlineItemContent(children, targetId, content) };
  });
}

function clearOutlineContent(items) {
  return (items || []).map((item) => {
    const { content, children, ...rest } = item;
    const normalizedChildren = normalizeChildren(item);
    return normalizedChildren.length
      ? { ...rest, children: clearOutlineContent(normalizedChildren) }
      : rest;
  });
}

module.exports = {
  resolveGlobalFactsByTitles,
  hasFactSelection,
  collectLeafContexts,
  loadContentKnowledgeReferences,
  resolveKnowledgeContents,
  resolveSelectedFactsText,
  updateOutlineItemContent,
  clearOutlineContent,
};
