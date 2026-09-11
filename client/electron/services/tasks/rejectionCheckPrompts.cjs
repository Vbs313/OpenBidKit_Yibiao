// 废标项检查的提示词构造：把输入/分段/滚动状态拼成 messages。
//
// 分三档：单次全量（common / analysis / inspection / final）、按段滚动（rolling*）、按批收口（*FinalBatch / *GlobalMerge）。
// 全是纯函数：给定输入就得到确定的 messages，便于单测与回归。
//
// 依赖方向：core ← findings ← rolling ← prompts ← 编排（主文件）。

const {
  formatBidDocumentIdList,
  formatBidDocumentsForPrompt,
  truncatePromptText,
} = require('./rejectionCheckCore.cjs');
const {
  chunkItems,
  createFinalRejectionStateSummary,
  createFinalLogicStateSummary,
  createRollingRejectionStateSummary,
  createRollingLogicStateSummary,
  takeRecentItems,
} = require('./rejectionCheckRolling.cjs');

function buildCommonRejectionCheckMessages(input) {
  const messages = [
    {
      role: 'user',
      content: `【废标项检查输入 v1｜检查项】
以下内容来自招标文件“无效投标”和“废标项”解析结果。后续任务必须优先基于这些检查口径，不要自行扩大到无法从电子投标文件判断的事项。

${input.invalidBidAndRejectionItems}`,
    },
  ];

  if (input.customCheckItems?.trim()) {
    messages.push({
      role: 'user',
      content: `【废标项检查输入 v1｜自定义检查项】
以下是用户补充的电子投标文件检查关注点。仅在能从电子投标文件正文、目录、附件文本或材料内容中判断时使用；如果涉及签字、盖章、密封、现场递交、纸质正副本等纸质或线下事项，必须忽略。

${input.customCheckItems.trim()}`,
    });
  }

  messages.push({
    role: 'user',
    content: `【废标项检查输入 v2｜投标文件原文】
以下是本次需要一起检查的多份投标文件 Markdown 原文。每份文件都有唯一 bidDocumentId。后续每条风险必须明确返回所属 bidDocumentId，只能引用对应投标文件中可见的内容作为证据。

重要限制：当前原文由文本解析得到，图片、扫描件、截图、附件页等非文本内容可能已被过滤或无法完整呈现。检查材料缺失时，不得要求必须看到图片内容、扫描件正文或附件正文；如果投标文件中已经出现某项材料的章节标题、目录项、附件标题、材料清单项、表格条目、页码线索、图片占位线索或其他可表明该材料已插入/已提交的结构性文本线索，应视为该材料至少存在提交线索。

${formatBidDocumentsForPrompt(input)}`,
  });

  return messages;
}

function buildRejectionCheckAnalysisMessages(input) {
  return [
    ...buildCommonRejectionCheckMessages(input),
    {
      role: 'user',
      content: `【废标项检查任务 v1｜第一轮：分析】
请先分析检查范围，不要输出最终风险列表。

分析要求：
1. 梳理“无效投标”和“废标项”中哪些能通过电子投标文件内容判断。
2. 明确排除签字、盖章、密封、纸质正副本、现场递交、开标现场授权到场、纸质文件封装等纸质或线下事项。
3. 结合各投标文件目录和正文结构，指出重点核查章节、附件、报价、资格材料、技术/商务响应位置，并说明是否存在不同文件需要分别关注的风险。
4. 判断材料是否缺失时，先识别章节标题、目录项、附件标题、材料清单项、表格条目、页码线索、图片占位线索等结构性文本线索；只要存在这类线索，就不能因为图片或扫描件正文不可见而判定缺失。
5. 如果某项检查需要外部事实、现场行为或纸质原件才能判断，标记为“不纳入电子文件检查”。
6. 仅输出分析结论，使用简体中文。`,
    },
  ];
}

function buildRejectionCheckInspectionMessages(input, analysis) {
  return [
    ...buildCommonRejectionCheckMessages(input),
    { role: 'user', content: `【废标项检查任务 v1｜第一轮分析结果】
${analysis}` },
    {
      role: 'user',
      content: `【废标项检查任务 v1｜第二轮：检查】
请基于第一轮分析逐项检查所有电子投标文件，输出初步风险列表。

检查要求：
1. 每条风险必须有某一份投标文件中的明确证据，并写明 bidDocumentId；证据不足不要输出。
2. 不检查签字、盖章、密封、纸质正副本、现场递交、纸质原件等事项。
3. 重点关注实质性条款未响应、必要章节或附件缺失、资格材料明显缺失/过期、报价或关键承诺前后矛盾、技术/商务偏离未说明等电子正文可判断风险。
4. 判断“材料缺失”时，只有在目录、章节标题、附件标题、材料清单、正文、表格和其他结构性线索中均找不到对应材料痕迹，才可以输出疑似缺失；不得仅因图片内容、扫描件正文或附件正文不可见而输出缺失风险。
5. 如果投标文件中已有对应材料的结构性文本线索，应视为至少有提交线索，可提示人工复核内容完整性，但不要判定为缺失。
6. 区分风险类型：无效标使用 invalidBid，废标项使用 rejectionItem。
7. 暂不要求 JSON，可用结构化 Markdown 输出初步结果。`,
    },
  ];
}

function buildRejectionCheckFinalMessages(input, analysis, draftFindings) {
  return [
    ...buildCommonRejectionCheckMessages(input),
    { role: 'user', content: `【废标项检查任务 v1｜第一轮分析结果】
${analysis}` },
    { role: 'user', content: `【废标项检查任务 v1｜第二轮初步检查结果】
${draftFindings}` },
    {
      role: 'user',
      content: `【废标项检查任务 v1｜第三轮：补充与定稿】
请对第二轮结果去重、合并、补漏，并删除不符合要求的条目，最终只输出 JSON。

定稿规则：
1. 只保留能从电子投标文件原文判断且有明确证据的风险。
2. 删除签字、盖章、密封、纸质正副本、现场递交、纸质原件、开标现场行为等纸质或线下事项。
3. 删除只有猜测、没有投标文件证据、或仅凭常识无法确认的条目。
4. 删除仅因图片内容、扫描件正文或附件正文不可见而产生的材料缺失条目；如果投标文件中存在对应材料的章节标题、目录项、附件标题、材料清单项、表格条目、页码线索、图片占位线索或其他结构性文本线索，不得将该材料定稿为缺失。
5. 同一问题合并为一条，标题简短明确。
6. severity 只能是 high、medium、low；type 只能是 invalidBid 或 rejectionItem。
7. 如果没有符合条件的风险，返回 {"findings":[]}。

JSON 格式：
{
  "findings": [
    {
      "bidDocumentId": "对应投标文件的 bidDocumentId，例如 bid-xxxx",
      "type": "invalidBid",
      "severity": "high",
      "title": "不超过 28 个中文字符的风险标题",
      "summary": "一句话概括风险",
      "requirement": "对应检查依据或招标要求，尽量引用原检查项",
      "bidEvidence": "投标文件中的明确证据、章节、原文摘录或缺失位置说明",
      "riskReason": "为什么该证据可能构成无效标或废标项风险",
      "suggestion": "建议用户如何处理或复核"
    }
  ]
}

仅输出 JSON，不要输出 Markdown、代码块或解释。`,
    },
  ];
}

function buildTypoCheckMessages(input) {
  return [
    { role: 'user', content: `【错别字检查输入 v2｜投标文件原文】
以下是本次需要一起检查的多份投标文件 Markdown 原文。每份文件都有唯一 bidDocumentId。后续只能检查这些原文中真实存在的文字，每条结果必须返回所属 bidDocumentId。

${formatBidDocumentsForPrompt(input)}` },
    { role: 'user', content: `【错别字检查任务 v1】
请检查投标文件中的错别字、明显别字、同音错字、形近错字和明显录入错误，并输出 JSON。

检查要求：
1. 只输出你高度确信的错别字，不输出风格建议、标点偏好、表达优化或术语争议。
2. 每条必须来自某一份投标文件原文，wrongText 必须是原文中出现的原始错字或短词，bidDocumentId 必须是输入中提供的真实 ID。
3. correctText 是建议改成的正确字词。
4. originalExcerpt 尽量摘录包含 wrongText 的原文短片段，便于程序校验；不要改写原文。
5. 如果没有明确错别字，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"对应投标文件的 bidDocumentId","wrongText":"原文中的错别字或短词","correctText":"建议正确字词","originalExcerpt":"包含错别字的原文短片段","reason":"为什么判断为错别字"}]}

仅输出 JSON，不要输出 Markdown、代码块或解释。` },
  ];
}

function buildLogicCheckMessages(input) {
  return [
    { role: 'user', content: `【逻辑谬误检查输入 v2｜投标文件原文】
以下是本次需要一起检查的多份投标文件 Markdown 原文。每份文件都有唯一 bidDocumentId。后续只能基于这些投标文件内容进行逻辑一致性检查，每条结果必须返回所属 bidDocumentId。

${formatBidDocumentsForPrompt(input)}` },
    { role: 'user', content: `【逻辑谬误检查任务 v1】
请检查投标文件中的逻辑谬误和前后不一致问题，并输出 JSON。

检查范围：
1. 句子本身存在逻辑漏洞、因果不成立、条件互相矛盾或结论无法由前文推出。
2. 全文前后不一致，包括但不限于处理相同工作的人员名单、设备型号、工期、金额、数量、服务期限、项目名称、技术参数等应高度一致的内容前后不一致。

输出要求：
1. 只保留有明确文本依据的问题，避免泛泛而谈。
2. 问题可能涉及同一份投标文件内的多处原文，originalText 可摘录关键原文，locationHint 写明大概位置、章节、表格或上下文线索，bidDocumentId 必须是输入中提供的真实 ID。
3. title 必须简短明确，便于作为折叠列表标题。
4. 如果没有明确逻辑谬误，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"对应投标文件的 bidDocumentId","title":"不超过 28 个中文字符的简短标题","originalText":"关键原文摘录，可包含同一份文件内多处摘录","locationHint":"大概位置、章节、表格或上下文线索","fallacyReason":"谬误原因或前后不一致原因","suggestion":"修改建议"}]}

仅输出 JSON，不要输出 Markdown、代码块或解释。` },
  ];
}

function buildRollingRejectionBaseMessages(input) {
  const messages = [
    {
      role: 'user',
      content: `【废标项滚动检查输入｜检查依据】
以下内容来自招标文件“无效投标”和“废标项”解析结果。必须优先基于这些检查口径，不要自行扩大到无法从电子投标文件判断的事项。

${input.invalidBidAndRejectionItems}`,
    },
  ];

  if (input.customCheckItems?.trim()) {
    messages.push({
      role: 'user',
      content: `【废标项滚动检查输入｜自定义检查项】
以下是用户补充的电子投标文件检查关注点。仅在能从电子投标文件正文、目录、附件文本或材料内容中判断时使用；如果涉及签字、盖章、密封、现场递交、纸质正副本等纸质或线下事项，必须忽略。

${input.customCheckItems.trim()}`,
    });
  }

  return messages;
}

function buildRollingRejectionSegmentMessages(input, segment, stateSummary) {
  const bidDocumentIdList = formatBidDocumentIdList(input.bidDocuments);
  return [
    ...buildRollingRejectionBaseMessages(input),
    {
      role: 'user',
      content: `【废标项滚动检查｜当前状态摘要】
你正在按顺序审阅同一个投标包。完整权威状态由程序维护，你只能基于当前片段返回增量 patch。
下面是前序片段累计状态的精简摘要；如需更新或排除 pendingRisks，只能引用摘要中已有的 id。

${JSON.stringify(stateSummary, null, 2)}`,
    },
    {
      role: 'user',
      content: `【废标项滚动检查｜当前投标包片段】
投标包片段：第 ${segment.segmentIndex}/${segment.totalSegments} 段
当前片段所属文件：${segment.documentLabel}
当前片段默认 bidDocumentId：${segment.documentId}

本投标包有效 bidDocumentId：
${bidDocumentIdList}

重要限制：当前内容只是整个投标包的一段，不是全部投标文件。不得因为当前段或当前文件没有出现某项材料、附件、承诺或响应，就确认该材料缺失；这类问题只能先放入 pendingRisks，后续片段或其他投标文件可能会补充或推翻。

${segment.content}`,
    },
    {
      role: 'user',
      content: `【废标项滚动检查任务】
请基于当前片段输出增量 patch，只输出 JSON。不要返回完整累计状态，程序会负责合并和保留历史状态。

Patch 要求：
1. evidenceAdds 只放当前片段新增的章节标题、目录项、附件标题、材料清单项、表格条目、页码线索、图片占位线索、承诺或响应线索。
2. pendingRiskAdds 只放当前片段发现、但需要后续片段或其他文件继续确认的问题。
3. pendingRiskUpdates 只能引用状态摘要中 pendingRisks 的 id，用于补充或修正该待确认项。
4. pendingRiskResolves 只能引用状态摘要中 pendingRisks 的 id；如果当前片段证明某个“缺失/未响应”不成立，就在这里给出排除原因。
5. confirmedRiskAdds 只放当前片段或累计摘要已经提供明确投标文件证据，且不依赖纸质、线下或外部事实的风险。
6. 不检查签字、盖章、密封、纸质正副本、现场递交、纸质原件等事项。
7. 每条风险、证据和事实必须保留 bidDocumentId，且只能使用上方有效 bidDocumentId；如果当前片段没有明确切换文件，默认使用 ${segment.documentId}。

JSON 格式：
{
  "evidenceAdds": [{"bidDocumentId":"有效 bidDocumentId","name":"材料或响应线索名称","evidence":"原文线索或摘要","locationHint":"章节/表格/位置线索","source":"对应检查项或说明"}],
  "pendingRiskAdds": [{"bidDocumentId":"有效 bidDocumentId","type":"invalidBid","severity":"medium","title":"待确认问题","summary":"摘要","requirement":"检查依据","bidEvidence":"当前证据或缺口","riskReason":"为什么需要继续确认","suggestion":"建议","statusReason":"仍需后续片段确认的原因"}],
  "pendingRiskUpdates": [{"id":"pendingRisks 中已有 id","bidEvidence":"补充证据或缺口","riskReason":"更新原因","statusReason":"当前仍需确认的原因"}],
  "pendingRiskResolves": [{"id":"pendingRisks 中已有 id","reason":"被当前片段或累计线索排除的原因","locationHint":"位置线索"}],
  "confirmedRiskAdds": [{"bidDocumentId":"有效 bidDocumentId","type":"invalidBid","severity":"high","title":"风险标题","summary":"摘要","requirement":"检查依据","bidEvidence":"明确投标文件证据","riskReason":"风险原因","suggestion":"建议"}]
}`,
    },
  ];
}

function buildRejectionFinalBatchMessages(input, candidates, stateSummary, batchIndex, totalBatches) {
  const bidDocumentIdList = formatBidDocumentIdList(input.bidDocuments);
  return [
    ...buildRollingRejectionBaseMessages(input),
    {
      role: 'user',
      content: `【废标项最终定稿｜状态摘要】
本投标包有效 bidDocumentId：
${bidDocumentIdList}

${JSON.stringify(stateSummary, null, 2)}`,
    },
    {
      role: 'user',
      content: `【废标项最终定稿｜候选批次 ${batchIndex}/${totalBatches}】
请只基于下面这一批候选输出最终废标项检查结果，只输出 JSON。

候选风险：
${JSON.stringify(candidates, null, 2)}

定稿规则：
1. 只保留能从电子投标文件原文或累计状态判断且有明确证据的风险。
2. candidateStatus 为 pending 且仍未形成完整证据闭环的问题不得输出为最终风险。
3. 如果某项“缺失/未响应”已经在 submittedEvidenceIndex 中出现章节、目录、附件标题、材料清单、表格条目、页码线索、图片占位线索或其他提交线索，不能定稿为缺失。
4. 删除签字、盖章、密封、纸质正副本、现场递交、纸质原件、开标现场行为等纸质或线下事项。
5. 同一问题合并为一条，bidDocumentId 必须来自上方有效 bidDocumentId。
6. 如果没有符合条件的风险，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"有效 bidDocumentId","type":"invalidBid","severity":"high","title":"不超过 28 个中文字符的风险标题","summary":"一句话概括风险","requirement":"对应检查依据或招标要求","bidEvidence":"投标文件中的明确证据、章节、原文摘录或缺失位置说明","riskReason":"为什么该证据可能构成无效标或废标项风险","suggestion":"建议用户如何处理或复核"}]}`,
    },
  ];
}

function buildRejectionGlobalMergeMessages(input, findings, finalSummary) {
  const bidDocumentIdList = formatBidDocumentIdList(input.bidDocuments);
  return [
    ...buildRollingRejectionBaseMessages(input),
    {
      role: 'user',
      content: `【废标项全局合稿｜证据索引】
本投标包有效 bidDocumentId：
${bidDocumentIdList}

以下是 Main 侧维护的全量精简状态索引，用于跨批次去重、排除误判和避免早期证据丢失：
${JSON.stringify(finalSummary, null, 2)}`,
    },
    {
      role: 'user',
      content: `【废标项全局合稿任务】
以下 findings 来自多个候选批次的初步定稿结果。请进行全局合稿，只输出最终 JSON。

待合稿 findings：
${JSON.stringify({ findings }, null, 2)}

合稿规则：
1. 合并跨批次重复或高度相似的风险，保留证据更明确、表述更完整的一条。
2. 如果 submittedEvidenceIndex 已经出现对应材料、章节、附件标题、目录、表格、页码线索、图片占位线索或其他提交线索，不得把该材料定稿为缺失。
3. 删除 resolvedRisks 已排除或证据不足的风险。
4. 删除签字、盖章、密封、纸质正副本、现场递交、纸质原件、开标现场行为等纸质或线下事项。
5. bidDocumentId 必须来自上方有效 bidDocumentId。
6. 如果没有符合条件的风险，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"有效 bidDocumentId","type":"invalidBid","severity":"high","title":"不超过 28 个中文字符的风险标题","summary":"一句话概括风险","requirement":"对应检查依据或招标要求","bidEvidence":"投标文件中的明确证据、章节、原文摘录或缺失位置说明","riskReason":"为什么该证据可能构成无效标或废标项风险","suggestion":"建议用户如何处理或复核"}]}`,
    },
  ];
}

function buildRollingLogicSegmentMessages(input, segment, stateSummary) {
  const bidDocumentIdList = formatBidDocumentIdList(input.bidDocuments);
  return [
    {
      role: 'user',
      content: `【逻辑谬误滚动检查｜当前累计状态】
你正在按顺序审阅同一个投标包。完整权威状态由程序维护，你只能基于当前片段返回增量 patch。
下面是前序片段累计状态的精简摘要；如需更新或排除 pendingIssues，只能引用摘要中已有的 id。

${JSON.stringify(stateSummary, null, 2)}`,
    },
    {
      role: 'user',
      content: `【逻辑谬误滚动检查｜当前投标包片段】
投标包片段：第 ${segment.segmentIndex}/${segment.totalSegments} 段
当前片段所属文件：${segment.documentLabel}
当前片段默认 bidDocumentId：${segment.documentId}

本投标包有效 bidDocumentId：
${bidDocumentIdList}

重要限制：当前内容只是整个投标包的一段，不是全部投标文件。前文或其他文件中的疑似矛盾可能会被后续片段解释，当前段也可能修正前文状态。不得仅凭当前段缺少解释就直接定稿为逻辑谬误。

${segment.content}`,
    },
    {
      role: 'user',
      content: `【逻辑谬误滚动检查任务】
请基于当前片段输出增量 patch，只输出 JSON。不要返回完整累计状态，程序会负责合并和保留历史状态。

Patch 要求：
1. factAdds 只放当前片段新增的关键事实，包括人员、设备型号、工期、金额、数量、服务期限、项目名称、技术参数、承诺、资质有效期等。
2. pendingIssueAdds 只放当前片段与状态摘要比对后发现、但仍需后续确认的疑似前后不一致问题。
3. pendingIssueUpdates 只能引用状态摘要中 pendingIssues 的 id，用于补充或修正该待确认问题。
4. pendingIssueResolves 只能引用状态摘要中 pendingIssues 的 id；如果当前片段解释或修正了某个疑似问题，就在这里给出排除原因。
5. confirmedIssueAdds 只放证据明确、无法由上下文解释或修正的问题。
6. 每条事实和问题必须保留 bidDocumentId，且只能使用上方有效 bidDocumentId；如果当前片段没有明确切换文件，默认使用 ${segment.documentId}。

JSON 格式：
{
  "factAdds": [{"bidDocumentId":"有效 bidDocumentId","category":"事实类型","name":"事实名称","value":"事实值","evidence":"原文摘录或摘要","locationHint":"章节/表格/位置线索"}],
  "pendingIssueAdds": [{"bidDocumentId":"有效 bidDocumentId","title":"待确认问题","originalText":"相关原文摘录","locationHint":"位置线索","fallacyReason":"疑似矛盾原因","suggestion":"建议","statusReason":"仍需后续片段确认的原因"}],
  "pendingIssueUpdates": [{"id":"pendingIssues 中已有 id","originalText":"补充原文","fallacyReason":"更新原因","statusReason":"当前仍需确认的原因"}],
  "pendingIssueResolves": [{"id":"pendingIssues 中已有 id","reason":"被当前片段或累计线索排除的原因","locationHint":"位置线索"}],
  "confirmedIssueAdds": [{"bidDocumentId":"有效 bidDocumentId","title":"问题标题","originalText":"关键原文摘录","locationHint":"位置线索","fallacyReason":"谬误原因或前后不一致原因","suggestion":"修改建议"}]
}`,
    },
  ];
}

function buildLogicFinalBatchMessages(input, candidates, stateSummary, batchIndex, totalBatches) {
  const bidDocumentIdList = formatBidDocumentIdList(input.bidDocuments);
  return [
    {
      role: 'user',
      content: `【逻辑谬误最终定稿｜状态摘要】
本投标包有效 bidDocumentId：
${bidDocumentIdList}

${JSON.stringify(stateSummary, null, 2)}`,
    },
    {
      role: 'user',
      content: `【逻辑谬误最终定稿｜候选批次 ${batchIndex}/${totalBatches}】
请只基于下面这一批候选输出最终逻辑谬误检查结果，只输出 JSON。

候选问题：
${JSON.stringify(candidates, null, 2)}

定稿规则：
1. 只保留有明确投标文件证据、无法由上下文解释或修正的问题。
2. candidateStatus 为 pending 且仍未形成完整证据闭环的问题不得输出为最终问题。
3. 如果 resolvedIssues 或 factRegisterIndex 已经说明疑似矛盾不成立，必须删除。
4. 同一问题合并为一条，bidDocumentId 必须来自上方有效 bidDocumentId。
5. 如果没有明确逻辑谬误，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"有效 bidDocumentId","title":"不超过 28 个中文字符的简短标题","originalText":"关键原文摘录，可包含同一份文件内多处摘录","locationHint":"大概位置、章节、表格或上下文线索","fallacyReason":"谬误原因或前后不一致原因","suggestion":"修改建议"}]}`,
    },
  ];
}

function buildLogicGlobalMergeMessages(input, findings, finalSummary) {
  const bidDocumentIdList = formatBidDocumentIdList(input.bidDocuments);
  return [
    {
      role: 'user',
      content: `【逻辑谬误全局合稿｜事实索引】
本投标包有效 bidDocumentId：
${bidDocumentIdList}

以下是 Main 侧维护的全量精简状态索引，用于跨批次去重、排除误判和避免早期事实丢失：
${JSON.stringify(finalSummary, null, 2)}`,
    },
    {
      role: 'user',
      content: `【逻辑谬误全局合稿任务】
以下 findings 来自多个候选批次的初步定稿结果。请进行全局合稿，只输出最终 JSON。

待合稿 findings：
${JSON.stringify({ findings }, null, 2)}

合稿规则：
1. 合并跨批次重复或高度相似的逻辑问题，保留证据更明确、表述更完整的一条。
2. 如果 factRegisterIndex 或 resolvedIssues 已经解释、修正或排除了疑似矛盾，不得保留。
3. 只保留有明确投标文件证据、无法由上下文解释或修正的问题。
4. bidDocumentId 必须来自上方有效 bidDocumentId。
5. 如果没有明确逻辑谬误，返回 {"findings":[]}。

JSON 格式：{"findings":[{"bidDocumentId":"有效 bidDocumentId","title":"不超过 28 个中文字符的简短标题","originalText":"关键原文摘录，可包含同一份文件内多处摘录","locationHint":"大概位置、章节、表格或上下文线索","fallacyReason":"谬误原因或前后不一致原因","suggestion":"修改建议"}]}`,
    },
  ];
}

module.exports = {
  buildCommonRejectionCheckMessages,
  buildRejectionCheckAnalysisMessages,
  buildRejectionCheckInspectionMessages,
  buildRejectionCheckFinalMessages,
  buildTypoCheckMessages,
  buildLogicCheckMessages,
  buildRollingRejectionBaseMessages,
  buildRollingRejectionSegmentMessages,
  buildRejectionFinalBatchMessages,
  buildRejectionGlobalMergeMessages,
  buildRollingLogicSegmentMessages,
  buildLogicFinalBatchMessages,
  buildLogicGlobalMergeMessages,
};
