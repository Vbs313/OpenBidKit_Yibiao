// Agent 原方案还原链路：切分原方案段落、准备 workspace 输入文件、解析 Agent 回包。
// 纯函数，只做字符串与结构变换，不接触任务状态、模型或文件系统，可单独测试。

const { splitUserTextByContextLimit } = require('./../../../utils/userTextSplitter.cjs');

const { buildContentFactCompletenessInstruction, buildSectionWordRequirement } = require('./contentMessages.cjs');
const {
  formatBidKeyInfoForPrompt,
  formatRestoreTargetsForPrompt,
  formatOriginalSegmentsForPrompt,
  formatContentPlanForPrompt,
  formatKnowledgeContentsForPrompt,
} = require('./promptBuilders.cjs');
const { normalizeNewlines } = require('./normalize.cjs');
const { singleLine, extractFencedAgentJsonBlocks, extractBalancedAgentJsonCandidate } = require('./agentResponse.cjs');
const { textHash } = require('./textEdits.cjs');

const ORIGINAL_PLAN_SEGMENT_MAX_CHARS = 6000;

function withFactCompletenessInstruction(text, mode) {
  const extra = buildContentFactCompletenessInstruction(mode);
  return extra ? `${text}\n\n${extra}` : text;
}

function splitLongOriginalSegment(segment) {
  const content = String(segment.content || '').trim();
  if (!content) return [];
  return splitUserTextByContextLimit(content, {}, {
    contextLengthLimit: ORIGINAL_PLAN_SEGMENT_MAX_CHARS,
    limitRatio: 1,
    maxSegmentLimitRatio: 1,
  }).map((part) => ({ ...segment, content: part.trim() })).filter((part) => part.content);
}

function splitOriginalPlanSegments(markdown) {
  const lines = normalizeNewlines(markdown).split('\n');
  const rawSegments = [];
  let titleStack = [];
  let currentTitlePath = [];
  let buffer = [];

  function flush() {
    const content = buffer.join('\n').trim();
    if (content) {
      rawSegments.push({ title_path: [...currentTitlePath], content });
    }
    buffer = [];
  }

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      const title = singleLine(heading[2]);
      titleStack = titleStack.slice(0, level - 1);
      titleStack[level - 1] = title;
      currentTitlePath = titleStack.filter(Boolean);
      buffer.push(line.trim());
      continue;
    }
    buffer.push(line);
  }
  flush();

  const sourceSegments = rawSegments.length ? rawSegments : [{ title_path: [], content: String(markdown || '').trim() }];
  const segments = sourceSegments.flatMap(splitLongOriginalSegment)
    .map((segment, index) => {
      const content = String(segment.content || '').trim();
      return {
        id: `P${String(index + 1).padStart(3, '0')}`,
        title_path: Array.isArray(segment.title_path) ? segment.title_path.map((title) => singleLine(title)).filter(Boolean) : [],
        content,
        hash: textHash(content),
        chars: content.length,
      };
    })
    .filter((segment) => segment.content);

  return segments;
}

function buildAgentOriginalMaterialRestorePrompt() {
  return `你是投标技术方案原文归属判断 Agent。用户提供的原方案是本次已有方案扩写的核心草稿，请基于 workspace 输入文件判断每个原方案段落应该还原到当前目录的哪个叶子小节。

workspace 文件：
- context.md：招标文件关键信息和全局事实变量标题清单。
- restore-targets.md：当前可还原叶子节点，包含 node_id、标题、描述、上级章节和同级章节。
- original-segments.md：原方案段落，包含 source_id、标题路径、字符数和原文。

工作要求：
1. 你可以分批读取、建立索引和创建临时草稿，但最终只写入 original-restore-result.json。
2. 只判断归属映射，严禁改写、总结或生成正文。
3. node_id 必须逐字使用 restore-targets.md 中给出的 ID。
4. source_ids 必须逐字使用 original-segments.md 中给出的编号。
5. 每个原方案段默认只分配给一个最匹配的主节点；如果完全不适合当前叶子节点，可以不分配。
6. 优先按标题语义、章节职责、技术路线和同级章节边界归属，避免把同一内容拆散到无关章节。
7. 如果某个原方案段只有章节标题、Markdown 标题或目录编号，没有实质正文内容，不要把它分配为正文来源；段落开头的标题行只用于判断归属。
8. 不要修改业务数据库、不要生成 technical-plan.md，程序会读取你的输出文件后自行写回。

最终输出文件 original-restore-result.json 必须是合法 JSON，格式如下：
{
  "assignments": [
    { "node_id": "1.1", "source_ids": ["P001", "P002"] }
  ]
}`;
}

function buildAgentOriginalMaterialRestoreFiles({ targets, originalSegments, projectOverview, bidAnalysisFactsText, globalFactTitlesText }) {
  return [
    {
      path: 'context.md',
      content: `# 招标文件关键信息
${formatBidKeyInfoForPrompt(projectOverview, bidAnalysisFactsText)}

# Step04 全局事实变量标题清单
${globalFactTitlesText || '未提供'}`,
    },
    {
      path: 'restore-targets.md',
      content: `# 当前可还原叶子节点
${formatRestoreTargetsForPrompt(targets) || '无'}`,
    },
    {
      path: 'original-segments.md',
      content: `# 原方案段落
${formatOriginalSegmentsForPrompt(originalSegments)}`,
    },
  ];
}

function buildAgentRestoredChapterContentPrompt(globalFactsMode) {
  return withFactCompletenessInstruction(`你是投标技术方案正文优化扩写 Agent。当前章节已经从用户原方案中还原出正文底稿，该底稿是用户已经写好的真实技术方案内容，必须作为本章节的基础保留。

workspace 文件：
- chapter-context.md：当前章节信息、项目概述、本章节全局事实变量、用户额外要求和正文编排决策。
- restored-content.md：已还原正文底稿。
- knowledge-contents.md：可参考的正文素材，如无则为“无”。

工作要求：
1. 首要遵从 restored-content.md，不要从零重写成另一套方案。
2. 必须保留底稿中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后和实施方法。
3. 可以调整语序、合并重复表达、提升专业性、补充细节、增加过渡和说明，让正文更完整、更适合投标文件。
4. 结合 chapter-context.md 中的项目概述、全局事实变量和正文编排决策；如存在冲突，以全局事实变量为准。
5. 可以吸收 knowledge-contents.md 中适合当前章节的技术素材，但不要提到“知识库”“历史文档”“参考资料”或素材来源。
6. 不要提到“原方案”“历史文档”“用户原文”或“底稿”。
7. 严禁输出 Mermaid、PlantUML、Graphviz、flowchart、graph、sequenceDiagram 等图表代码块、mermaid.ink 链接或图片 Markdown。
8. restored-content.md 可能包含原方案 Markdown 标题行或编号标题，例如“# 第一章...”“## 第一节...”“### 二、...”“（一）...”，这些只作为章节定位线索，不属于最终正文。
9. 不要输出章节标题、Markdown 标题、编号标题、解释、总结或过程说明；当前章节标题会由程序统一渲染。
 10. chapter-context.md 如包含小节字数目标，应尽量遵守，但保留原方案实质内容的要求优先。
11. 不要修改业务数据库，程序会读取你的输出文件后自行写回。

最终请把当前小节完整正文写入 optimized-section.md。该文件只能包含正文内容，不要包含标题或说明。`, globalFactsMode);
}

function buildAgentRestoredChapterContentFiles({ chapter, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, restoredContent, wordControl, generationTarget = 0 }) {
  return [
    {
      path: 'chapter-context.md',
      content: `# 当前章节
章节ID: ${chapter?.id || 'unknown'}
章节标题: ${chapter?.title || '未命名章节'}
章节描述: ${chapter?.description || '无'}

说明：章节编号和章节标题由程序统一渲染，optimized-section.md 只能写正文，不要重复输出章节标题、Markdown 标题或编号标题。

# 项目概述信息
${projectOverview || '未提供'}

# 本章节需要使用的全局事实变量
${String(selectedFactsText || '').trim() || '未提供'}

# 用户对本次重新生成的额外要求
${String(regenerateRequirement || '').trim() || '无'}

# 正文编排决策
${contentPlan ? formatContentPlanForPrompt(contentPlan) : '无'}

# 本小节字数目标
${buildSectionWordRequirement(wordControl, true, generationTarget) || '不控制小节字数'}`,
    },
    {
      path: 'restored-content.md',
      content: String(restoredContent || '').trim(),
    },
    {
      path: 'knowledge-contents.md',
      content: knowledgeContents?.length ? formatKnowledgeContentsForPrompt(knowledgeContents) : '无',
    },
  ];
}

function parseAgentJsonContent(content) {
  const normalized = String(content || '').replace(/^\uFEFF/, '').trim();
  const candidates = [
    normalized,
    ...extractFencedAgentJsonBlocks(normalized),
    extractBalancedAgentJsonCandidate(normalized),
  ].map((item) => String(item || '').trim()).filter(Boolean);
  const uniqueCandidates = [...new Set(candidates)];
  let lastError = null;

  for (const candidate of uniqueCandidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Agent 未返回可解析的 JSON：${lastError?.message || '内容为空'}`);
}

function escapeSectionAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseAgentSectionMarkdown(markdown) {
  const sections = new Map();
  const lines = normalizeNewlines(markdown).split('\n');
  let currentId = '';
  let buffer = [];

  for (const line of lines) {
    const startMatch = /^\s*<!--\s*yibiao-section-start\s+id="([^"]+)"[^>]*-->\s*$/.exec(line);
    if (startMatch) {
      if (currentId) {
        throw new Error(`Agent 输出的小节标记嵌套：${currentId} 内出现 ${startMatch[1]}`);
      }
      currentId = String(startMatch[1] || '').trim();
      buffer = [];
      continue;
    }

    const endMatch = /^\s*<!--\s*yibiao-section-end\s+id="([^"]+)"\s*-->\s*$/.exec(line);
    if (endMatch) {
      const endId = String(endMatch[1] || '').trim();
      if (!currentId) {
        throw new Error(`Agent 输出存在未配对的小节结束标记：${endId}`);
      }
      if (endId !== currentId) {
        throw new Error(`Agent 输出小节标记不匹配：${currentId} / ${endId}`);
      }
      if (sections.has(currentId)) {
        throw new Error(`Agent 输出重复小节：${currentId}`);
      }
      sections.set(currentId, buffer.join('\n').trim());
      currentId = '';
      buffer = [];
      continue;
    }

    if (currentId) {
      buffer.push(line);
    }
  }

  if (currentId) {
    throw new Error(`Agent 输出小节未闭合：${currentId}`);
  }
  return sections;
}

module.exports = {
  splitOriginalPlanSegments,
  buildAgentOriginalMaterialRestorePrompt,
  buildAgentOriginalMaterialRestoreFiles,
  buildAgentRestoredChapterContentPrompt,
  buildAgentRestoredChapterContentFiles,
  parseAgentJsonContent,
  escapeSectionAttribute,
  parseAgentSectionMarkdown,
};
