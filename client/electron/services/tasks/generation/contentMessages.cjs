// 章节内容/审计提示词构造：把章节、事实、知识等数据渲染成模型消息，纯函数，可单独测试。
const { formatTablesForCleanupPrompt } = require('./markdownTables.cjs');
const { formatKnowledgeContentsForPrompt, formatContentPlanForPrompt, formatBidKeyInfoForPrompt, formatRestoreTargetsForPrompt, formatOriginalSegmentsForPrompt } = require('./promptBuilders.cjs');

function buildContentFactCompletenessInstruction(mode) {
  if (mode === 'omit') {
    return `事实补全规则（别招欠模式）：
1. 严禁虚拟、杜撰任何未在本章节全局事实变量和参考材料中明确给出的具体信息。
2. 全局事实变量中已经给出的笼统口径必须沿用，不得自行补成具体工艺、人名、日期、地点、业绩、证书、规格型号或实施细节。
3. 如果有不确定的，尽量使用笼统的方式表达，不涉及不确定的时间、地点、人员、业绩、证书、规格型号等任何事实项内容。
4. 不要为了写得具体而编造人名、日期、地点、业绩、证书编号、规格型号。`;
  }
  if (mode === 'placeholder') {
    return `事实补全规则（放着我来模式）：
1. 严禁虚拟、杜撰任何未在本章节全局事实变量和参考材料中明确给出的具体信息。
2. 任何不确定项必须使用【待填写】作为占位符，不要改写成“待定”或其他说法。
3. 如果全局事实变量中已有【待填写】，正文必须原样沿用，不得改成具体值。
4. 不要杜撰不确定的时间、地点、人员、业绩、证书、规格型号等任何事实项内容。`;
  }
  return '';
}

function appendSelectedFactsMessage(messages, selectedFactsText) {
  const content = String(selectedFactsText || '').trim();
  if (!content) return;
  messages.push({
    role: 'user',
    content: `本章节需要使用的全局事实变量（正文涉及时优先使用这些变量值，保证全文一致）：\n${content}`,
  });
}

function buildSectionWordRequirement(wordControl, preserveOriginalMaterial = false, generationTarget = 0) {
  if (wordControl.sectionWords <= 0) return '';
  // 传入 generationTarget（按全文上限倒推的折后目标）时用它替代预设字数，允许范围展示保持不变，从源头压低初稿总量。
  const targetWords = generationTarget > 0 ? generationTarget : wordControl.sectionWords;
  const base = wordControl.strictSectionWords
    ? `本小节目标字数约 ${targetWords} 字，硬性上限 ${wordControl.sectionMaximumWords} 字，绝对不得超过上限；超出上限属于不合格输出。请在信息完整、专业、不重复的前提下贴近目标字数，宁可略短也不要为凑字数扩写、堆砌或重复表达。`
    : `本小节建议字数 ${wordControl.sectionMinimumWords} 至 ${wordControl.sectionMaximumWords} 字（目标约 ${targetWords} 字）。请在内容完整、专业、不重复的前提下控制篇幅，避免明显超出该范围；如确有必要可略有出入，最终由全文字数流程统一调整。`;
  return preserveOriginalMaterial
    ? `${base}\n字数要求不能覆盖保留原方案实质内容的要求；可以消除重复和冗余，但不得删除技术路线、参数、周期、人员、验收、售后和承诺。`
    : base;
}

function buildTableCleanupMessages({ chapter, tables }) {
  const allowedIds = (tables || []).map((table) => table.id).join('、') || '无';
  return [
    {
      role: 'user',
      content: `你是投标技术方案正文编辑助手。请把指定小节中的表格转换为普通文字描述。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown 代码围栏。
2. 必须逐个处理输入中的 table_id；允许按表格内容改写为普通段落或普通列表。
3. 不改变原文意思，不删除数字、参数、工期、标准、职责、流程、承诺、验收要求、频次和数量。
4. replacement_text 只写用于替换该表格块的正文片段，不返回完整小节正文。
5. replacement_text 严禁包含 Markdown 表格、HTML <table>、代码块、章节标题或伪目录标题。
6. 如表格本身为空或无法理解，也要用一句普通文字概括其表达意图，不要返回空字符串。

返回格式：
{
  "replacements": [
    { "table_id": "T001", "replacement_text": "普通文字描述" }
  ]
}

允许的 table_id：${allowedIds}`,
    },
    {
      role: 'user',
      content: `当前小节：${chapter?.id || 'unknown'} ${chapter?.title || '未命名章节'}
小节描述：${chapter?.description || '无'}`,
    },
    {
      role: 'user',
      content: `待转换表格块：
${formatTablesForCleanupPrompt(tables)}`,
    },
  ];
}

function buildChapterContentMessages({ chapter, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, preSectionInstruction, wordControl, generationTarget = 0, globalFactsMode }) {
  const chapterId = chapter.id || 'unknown';
  const chapterTitle = chapter.title || '未命名章节';
  const chapterDescription = chapter.description || '';
  const tableAllowed = Boolean(contentPlan?.table?.needed);
  const messages = [
    {
      role: 'system',
      content: `你是一个专业的标书编写专家，负责为投标文件的技术标部分生成具体内容。

要求：
1. 内容要专业、准确，与章节标题和描述保持一致。
2. 这是技术方案，不是宣传报告，注意朴实无华，不要假大空。
3. 语言要正式、规范，符合标书写作要求，但不要使用奇怪的连接词，不要让人觉得内容像是 AI 生成的。
4. 内容要详细具体，避免空泛的描述。
5. 围绕当前章节标题、描述和正文编排重点展开，保持内容聚焦。
6. ${tableAllowed ? '可以使用 Markdown 段落、列表和表格；表格必须服务于内容表达，不要为了形式硬插。' : '只能使用 Markdown 段落、普通列表和加粗引导语，严禁输出 Markdown 表格或 HTML 表格。'}
7. ${tableAllowed ? '正文只生成文字、列表、表格等内容，配图由系统另行处理。' : '正文只生成文字和普通列表，配图由系统另行处理。'}
8. 严禁输出 Mermaid、PlantUML、Graphviz、flowchart、graph、sequenceDiagram 等图表代码块、mermaid.ink 链接或图片 Markdown；配图由系统另行处理。
9. ${tableAllowed ? '表格单元格内如有多项内容，优先使用编号、顿号、分号或短句，不要使用 HTML <br> 标签。' : '如需表达多项参数、职责、流程或措施，请改用分段文字或普通列表，不要用表格模拟。'}
10. 严禁使用 Markdown 标题语法（#、##、###、####、#####、######），也不要生成与当前章节同级或下级的伪目录标题。
11. 如需在正文中分层表达，只能使用普通段落、无编号列表、表格或无编号加粗引导语，例如 **实施要点：**。
12. 加粗引导语只允许写简短主题词，禁止使用任何形式的编号。
13. 只有步骤、流程、时间顺序、操作顺序等连续性非常强的内容，才可以使用有序列表；其他分段一律使用自然段、无编号列表或无编号加粗引导语，禁止使用任何形式的编号。
14. 直接返回章节内容，不生成标题，不要任何额外说明。
15. 如果本章节需要使用的全局事实变量中包含相关内容，必须优先使用变量值，不得前后矛盾。
16. 仅使用本章节提供的全局事实变量；未提供时不要主动编造具体人员、周期、质保、品牌、型号等会影响全文一致性的承诺。${buildContentFactCompletenessInstruction(globalFactsMode) ? `\n\n${buildContentFactCompletenessInstruction(globalFactsMode)}` : ''}`,
    },
  ];

  if (String(projectOverview || '').trim()) {
    messages.push({ role: 'user', content: `项目概述信息：\n${projectOverview}` });
  }
  if (String(preSectionInstruction || '').trim()) {
    messages.push({ role: 'user', content: String(preSectionInstruction || '').trim() });
  }
  appendSelectedFactsMessage(messages, selectedFactsText);

  if (knowledgeContents?.length) {
    messages.push({
      role: 'user',
      content: '参考正文素材使用规则：以下内容只作为可吸收的技术素材。请改写为当前项目语境下的投标技术方案正文，不要照抄，不要提到“知识库”“历史文档”“参考资料”或素材来源。',
    });
    messages.push({
      role: 'user',
      content: `参考正文素材：\n${formatKnowledgeContentsForPrompt(knowledgeContents)}`,
    });
  }

  if (String(regenerateRequirement || '').trim()) {
    messages.push({
      role: 'user',
      content: `用户对本次重新生成的额外要求：\n${regenerateRequirement}`,
    });
  }

  if (contentPlan) {
    messages.push({
      role: 'user',
      content: `正文编排决策：\n${formatContentPlanForPrompt(contentPlan)}`,
    });
  }

  messages.push({
    role: 'user',
    content: `请为以下标书章节生成具体内容：

当前章节信息：
章节ID: ${chapterId}
章节标题: ${chapterTitle}
章节描述: ${chapterDescription}

请结合项目概述信息、本章节全局事实变量、参考正文素材和正文编排决策，围绕当前章节标题、描述和写作重点生成详细的专业内容。
直接返回编写的正文内容，不要输出标题、Markdown 标题、带任何形式编号的加粗引导语、伪目录标题、解释、总结等任何其他内容`,
  });
  const sectionWordRequirement = buildSectionWordRequirement(wordControl, false, generationTarget);
  if (sectionWordRequirement) messages.push({ role: 'user', content: sectionWordRequirement });

  return messages;
}

function buildRestoredChapterContentMessages({ chapter, projectOverview, selectedFactsText, regenerateRequirement, contentPlan, knowledgeContents, restoredContent, wordControl, generationTarget = 0, globalFactsMode }) {
  const messages = buildChapterContentMessages({
    chapter,
    projectOverview,
    selectedFactsText,
    regenerateRequirement,
    contentPlan,
    knowledgeContents,
    wordControl: { ...wordControl, minimumWords: 0, maximumWords: 0, sectionWords: 0, strictSectionWords: false },
    globalFactsMode,
    preSectionInstruction: `当前章节已经从用户原方案中还原出正文底稿。该底稿是用户已经写好的真实技术方案内容，必须作为本章节的基础保留。

处理要求：
1. 首要遵从正文底稿，不要从零重写成另一套方案。
2. 必须保留底稿中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后和实施方法。
3. 可以调整语序、合并重复表达、提升专业性、补充细节、增加过渡和说明，让正文更完整、更适合投标文件。
4. 正文底稿中可能包含原方案 Markdown 标题行或编号标题，例如“# 第一章...”“## 第一节...”“### 二、...”“（一）...”，这些只作为章节定位线索，不属于最终正文。
5. 输出时必须跳过底稿中的章节标题、Markdown 标题和编号标题；当前章节标题会由程序统一渲染，不要在正文中重复。
6. 不要提到“原方案”“历史文档”“用户原文”或“底稿”。
7. 加粗引导语不得使用任何形式的编号；除连续性非常强的步骤、流程、操作顺序外，不得使用有序编号分段。
8. 输出当前章节完整正文，不输出标题。`,
  });
  const finalMessage = messages.pop();
  if (finalMessage) {
    messages.push(finalMessage);
  }
  messages.push({
    role: 'user',
    content: `已还原正文底稿：
${String(restoredContent || '').trim()}`,
  });
  messages.push({
    role: 'user',
    content: '请基于已还原正文底稿输出当前章节完整正文。必须保留底稿中的实质内容，可以优化扩写，但不要从零重写；如果底稿开头或中间出现章节标题、Markdown 标题或编号标题，只把它当作定位线索，不要输出这些标题或解释。',
  });
  const sectionWordRequirement = buildSectionWordRequirement(wordControl, true, generationTarget);
  if (sectionWordRequirement) messages.push({ role: 'user', content: sectionWordRequirement });
  return messages;
}

function buildOriginalMaterialRestoreMessages({ targets, originalSegments, projectOverview, bidAnalysisFactsText, globalFactTitlesText }) {
  return [
    {
      role: 'user',
      content: `你是投标技术方案原文归属判断助手。用户提供的原方案是本次要扩写的核心草稿。请判断每个原方案段落应该还原到当前目录的哪个叶子小节。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 你只能返回原方案段编号与叶子节点 ID 的映射，严禁改写、总结或生成正文。
3. node_id 必须逐字使用“当前可还原叶子节点”中给出的 ID。
4. source_ids 必须逐字使用“原方案段落”中的编号。
5. 每个原方案段默认只分配给一个最匹配的主节点；如果完全不适合当前叶子节点，可以不分配。
6. 优先按标题语义、章节职责、技术路线和同级章节边界归属，避免把同一内容拆散到无关章节。
7. 如果某个原方案段只有章节标题、Markdown 标题或目录编号，没有实质正文内容，不要把它分配为正文来源；段落开头的标题行只用于判断归属。

返回格式：
{
  "assignments": [
    { "node_id": "1.1", "source_ids": ["P001", "P002"] }
  ]
}`,
    },
    { role: 'user', content: `招标文件关键信息：\n${formatBidKeyInfoForPrompt(projectOverview, bidAnalysisFactsText)}` },
    { role: 'user', content: `Step04 全局事实变量标题清单：\n${globalFactTitlesText || '未提供'}` },
    { role: 'user', content: `当前可还原叶子节点：\n${formatRestoreTargetsForPrompt(targets) || '无'}` },
    { role: 'user', content: `原方案段落：\n${formatOriginalSegmentsForPrompt(originalSegments)}` },
    { role: 'user', content: '请只返回 JSON，不要生成正文。' },
  ];
}

function formatChapterPath(context) {
  return [...(context.parentChapters || []), context.item]
    .map((chapter) => `${chapter.id || 'unknown'} ${chapter.title || '未命名章节'}`)
    .join(' > ');
}

function formatConsistencyAuditGroupContent(group) {
  return (group.items || []).map((entry) => `<section>
编号：${entry.item.id || 'unknown'}
标题：${entry.item.title || '未命名章节'}
路径：${formatChapterPath(entry)}
正文：
${entry.content || ''}
</section>`).join('\n\n');
}

function buildConsistencyAuditMessages({ group, globalFactsText, bidAnalysisFactsText, globalFactsMode }) {
  const allowedIds = (group.items || []).map(({ item }) => item.id).filter(Boolean);
  return [
    {
      role: 'user',
      content: `你是投标技术方案全文一致性审计助手。请审计本组正文是否与给定事实冲突。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 只找正文中已经明确写出、且与事实相违背的内容。
3. 正文没有涉及某条事实时，不要报告缺失，不要建议补充。
4. 不报告文风、质量、重复、篇幅、表达优化等问题。
5. section_id 必须来自允许的目录编号清单，禁止编造编号。
6. 只筛选冲突目录编号和冲突证据，不要重写正文。${buildContentFactCompletenessInstruction(globalFactsMode) ? `\n7. 全局事实中的【待填写】不是冲突，不要要求正文补成具体值，也不要把缺失项当成需要杜撰的内容。` : ''}

返回格式：
{
  "conflicts": [
    {
      "section_id": "1.2.3",
      "fact_title": "相关事实变量标题",
      "evidence": "正文中的冲突原文摘录",
      "reason": "为什么与事实冲突",
      "severity": "high"
    }
  ]
}`,
    },
    { role: 'user', content: `Step04 全局事实变量：\n${globalFactsText || '未提供'}` },
    { role: 'user', content: `Step02 关键解析结果（项目信息、甲方信息、交货和服务要求）：\n${bidAnalysisFactsText || '未提供'}` },
    { role: 'user', content: `允许返回的目录编号清单：\n${JSON.stringify(allowedIds, null, 2)}` },
    { role: 'user', content: `待审计正文分组：\n${formatConsistencyAuditGroupContent(group)}` },
  ];
}

function formatOriginalCoverageSources(sources) {
  return (sources || []).map((segment) => `<source id="${segment.id}">
标题路径：${segment.title_path?.length ? segment.title_path.join(' > ') : '未识别标题'}
字符数：${segment.chars || String(segment.content || '').length}
原文：
${segment.content || ''}
</source>`).join('\n\n');
}

function buildOriginalCoverageAuditMessages({ target }) {
  const allowedSourceIds = (target.sources || []).map((segment) => segment.id).filter(Boolean);
  return [
    {
      role: 'user',
      content: `你是投标技术方案原方案覆盖审计助手。请检查当前小节正文是否保留了原方案来源段中的实质内容。

要求：
1. 只返回 JSON，不要输出解释、总结或 Markdown。
2. 必须对每个 source_id 返回一条 items 记录，covered 也必须返回。
3. 可接受改写、扩写、调序、合并和专业化表达；不要因为不是逐字一致就判为缺失。
4. 重点检查原方案中的实质信息、技术路线、服务承诺、设备参数、人员安排、周期、验收、售后、实施方法是否仍然保留。
5. status 只能是 covered、partial、missing、conflict。
6. covered 表示核心内容已经保留；partial 表示部分核心信息缺失；missing 表示该来源段核心内容基本没有体现；conflict 表示正文与来源段核心事实明显相反或矛盾。
7. conflict 只报告，不要求修复；partial/missing 请给出 missing_points 和 repair_suggestion。
8. node_id 必须是当前小节编号，source_id 必须来自允许清单。

返回格式：
{
  "items": [
    {
      "source_id": "P001",
      "node_id": "当前小节编号",
      "status": "covered",
      "missing_points": [],
      "repair_suggestion": ""
    }
  ]
}`,
    },
    { role: 'user', content: `当前小节：${target.item.id || 'unknown'} ${target.item.title || '未命名章节'}\n路径：${formatChapterPath(target)}\n描述：${target.item.description || ''}` },
    { role: 'user', content: `允许的 source_id：\n${JSON.stringify(allowedSourceIds, null, 2)}` },
    { role: 'user', content: `原方案来源段：\n${formatOriginalCoverageSources(target.sources)}` },
    { role: 'user', content: `当前小节正文：\n${target.content || ''}` },
    { role: 'user', content: '请只返回覆盖审计 JSON。' },
  ];
}

function buildWordAdjustmentMessages({ context, currentContent, currentWords, targetWords, mode, granularity, selectedFactsText, maximumChangeWords, totalRemainingWords, totalWords, minimumWords, maximumWords, globalFactsMode }) {
  const { item, parentChapters, siblingChapters } = context;
  const chapterPath = [...(parentChapters || []), item].map((chapter) => `${chapter.id} ${chapter.title}`).join(' > ');
  const siblings = (siblingChapters || []).filter((chapter) => chapter.id !== item.id).map((chapter) => `${chapter.id} ${chapter.title}`).join('；') || '无';
  const adjustmentBudgetText = totalRemainingWords === undefined
    ? `当前小节本次最多允许${mode === 'expand' ? '增加' : '减少'} ${maximumChangeWords} 字。`
    : mode === 'expand'
      ? `本轮全文最多还需增加 ${totalRemainingWords} 字，当前小节本次最多允许增加 ${maximumChangeWords} 字。`
      : `本轮全文至少还需减少 ${totalRemainingWords} 字，当前小节本次最多允许减少 ${maximumChangeWords} 字。`;
  const totalWordText = totalWords === undefined
    ? ''
    : `当前全文 ${totalWords} 字，最少 ${minimumWords || '不限制'} 字，最多 ${maximumWords || '不限制'} 字。`;
  const responseFormat = mode === 'expand'
    ? `{"mode":"expand","granularity":"${granularity}","operations":[{"operation":"insert","anchor":"逐字复制当前正文中的唯一完整段落，或 start/end","target_text":"","content":"需要插入的新增正文"},{"operation":"replace","anchor":"","target_text":"逐字复制当前正文中的唯一完整原文块","content":"替换并扩写后的正文块"}]}`
    : `{"mode":"shrink","granularity":"${granularity}","operations":[{"operation":"replace","target_text":"逐字复制当前正文中的唯一完整${granularity === 'paragraph' ? '段落' : '句子'}","content":"缩写后的正文"}]}`;
  const operationRules = mode === 'expand'
    ? `2. 扩写只允许 insert、replace，优先使用 insert；可以返回多个操作，把新增内容按不同技术主题插入最相关的位置。
3. insert 的 anchor 必须逐字复制当前正文中的唯一完整原文段落或 Markdown 块；仅需插入开头或末尾时可写 start/end。锚点未命中时不会自动追加到末尾。
4. replace 的 target_text 必须逐字复制当前正文中的唯一完整原文块；多个操作的锚点和替换范围不能重复或重叠。
5. 新增正文的实际总字数应尽量接近但不得超过本次允许增加的字数；额度较大时应拆成多个 insert，禁止返回完整重写正文。`
    : `2. 缩写只允许 replace、delete。
3. target_text 必须逐字复制当前正文中的唯一完整目标，多项操作不能重叠。
4. 缩写优先删除重复、空泛、同义反复和不影响事实的修饰表达。
5. 不得返回完整重写正文。`;
  return [
    {
      role: 'user',
      content: `你是投标技术方案正文局部编辑助手。请对当前小节执行${mode === 'expand' ? '扩写' : '缩写'}，只返回 JSON，不返回完整重写正文。

JSON 格式：${responseFormat}

要求：
1. mode 和 granularity 必须与给定值一致。
${operationRules}
6. 不改变核心意思，不修改参数、数量、日期、周期和标准，不删除技术路线、职责、流程、风险措施、人员安排、验收要求、售后和服务承诺。
7. 不新增未提供的品牌、型号、人员、承诺和服务期限。
8. 不修改图片、Mermaid、代码块、表格结构、列表编号层级和资源路径，不生成 Markdown 标题或伪目录标题。
9. 不把其他目录应承载的内容移动到当前小节。${buildContentFactCompletenessInstruction(globalFactsMode) ? `\n\n${buildContentFactCompletenessInstruction(globalFactsMode)}` : ''}`,
    },
    { role: 'user', content: `当前章节路径：${chapterPath}\n章节描述：${item.description || ''}\n同级章节：${siblings}` },
    ...(String(selectedFactsText || '').trim() ? [{ role: 'user', content: `本章节全局事实变量：\n${selectedFactsText}` }] : []),
    { role: 'user', content: `当前小节正文：\n${currentContent}` },
    {
      role: 'user',
      content: `当前小节 ${currentWords} 字，目标约 ${targetWords} 字；${adjustmentBudgetText}${totalWordText}`,
    },
  ];
}

module.exports = {
  buildContentFactCompletenessInstruction,
  appendSelectedFactsMessage,
  buildSectionWordRequirement,
  buildTableCleanupMessages,
  buildChapterContentMessages,
  buildRestoredChapterContentMessages,
  buildOriginalMaterialRestoreMessages,
  formatChapterPath,
  formatConsistencyAuditGroupContent,
  buildConsistencyAuditMessages,
  formatOriginalCoverageSources,
  buildOriginalCoverageAuditMessages,
  buildWordAdjustmentMessages,
};
