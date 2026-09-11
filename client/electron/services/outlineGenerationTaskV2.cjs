const {
  OUTLINE_AGENT_TASK_KEY,
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
} = require('./agentTaskKeys.cjs');
const { runTemplateExtractionTask } = require('./tasks/templateExtractionTask.cjs');
const {
  OUTLINE_OUTPUT_FILE,
  TECHNICAL_SCORE_GROUPS_FILE,
  SCORE_DIRECTORY_PLAN_FILE,
  LEAF_ALLOCATION_FILE,
  OUTLINE_REVIEW_FILE,
  OUTLINE_REVIEW_CONTEXT_FILE,
  AI_CONTENT_MODE,
  CONTENT_MODES,
  createDirectoryNodeSchema,
  createLeafAllocationSchema,
  collectOutlineStructure,
  collectScoreMappingCoverage,
  buildOutlineReviewContext,
  createInitialPrompt,
  createChildrenPrompt,
  createOutlineReviewPrompt,
  collectNodesAtLevel,
  countLeavesByMode,
} = require('./tasks/outline/outlineBlueprint.cjs');

const DEFAULT_ESTIMATED_SECTION_WORDS = 3000;
const LEAF_ALLOCATION_CONTEXT_FILE = 'leaf-allocation-context.json';
const ROOT_NODE_SCHEMA = createDirectoryNodeSchema(1, true);

const OUTLINE_JSON_SCHEMA = {
  type: 'object',
  required: ['outline'],
  additionalProperties: false,
  properties: {
    outline: {
      type: 'array',
      minItems: 1,
      items: ROOT_NODE_SCHEMA,
    },
  },
};

const TECHNICAL_SCORE_GROUPS_SCHEMA = {
  type: 'object',
  required: ['groups'],
  additionalProperties: false,
  properties: {
    groups: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['requirement_id', 'title', 'description', 'detail_points'],
        additionalProperties: false,
        properties: {
          requirement_id: { type: 'string', pattern: '^R[1-9]\\d*$' },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          detail_points: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
};

const SCORE_DIRECTORY_PLAN_SCHEMA = {
  type: 'object',
  required: ['allow_root_changes', 'branches', 'extra_titles'],
  additionalProperties: false,
  properties: {
    allow_root_changes: { type: 'boolean' },
    branches: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['branch_id', 'root_id', 'root_title', 'score_item_level', 'mappings'],
        additionalProperties: false,
        properties: {
          branch_id: { type: 'string', minLength: 1 },
          root_id: { type: 'string', pattern: '^[1-9]\\d*(?:\\.[1-9]\\d*)*$' },
          root_title: { type: 'string', minLength: 1 },
          score_item_level: { type: 'integer', minimum: 1, maximum: 6 },
          mappings: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['requirement_id', 'target_title'],
              additionalProperties: false,
              properties: {
                requirement_id: { type: 'string', pattern: '^R[1-9]\\d*$' },
                target_title: { type: 'string', minLength: 1 },
                additional_titles: {
                  type: 'array',
                  minItems: 1,
                  items: { type: 'string', minLength: 1 },
                },
                adjustment_note: { type: 'string' },
              },
            },
          },
        },
      },
    },
    extra_titles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['branch_id', 'title', 'reason'],
        additionalProperties: false,
        properties: {
          branch_id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

const OUTLINE_REVIEW_SCHEMA = {
  type: 'object',
  required: ['status', 'issues', 'user_feedback', 'summary'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['passed', 'simple_fix', 'user_feedback', 'user_refuse'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['category', 'problem', 'repair', 'confirmation_required'],
        additionalProperties: false,
        properties: {
          category: {
            type: 'string',
            enum: ['leaf-count', 'score-coverage', 'duplicate-directory', 'professional-structure'],
          },
          problem: { type: 'string', minLength: 1 },
          repair: { type: 'string', minLength: 1 },
          confirmation_required: { type: 'boolean' },
        },
      },
    },
    user_feedback: { type: 'string' },
    summary: { type: 'string', minLength: 1 },
  },
};

function formatProgressTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return Array.from(title).slice(0, 20).join('');
}

function normalizeWordControlOptions(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const integer = (input) => {
    const number = Number(input);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  };
  return {
    minimumWords: integer(raw.minimumWords),
    maximumWords: integer(raw.maximumWords),
    sectionWords: integer(raw.sectionWords),
    strictSectionWords: Boolean(raw.strictSectionWords) && integer(raw.sectionWords) > 0,
  };
}

function deriveTargetLeafCount(options) {
  const sectionWords = options.sectionWords > 0 ? options.sectionWords : DEFAULT_ESTIMATED_SECTION_WORDS;
  if (options.minimumWords > 0 && options.maximumWords > 0) {
    return Math.ceil(((options.minimumWords + options.maximumWords) / 2) / sectionWords);
  }
  if (options.maximumWords > 0) {
    return Math.floor(options.maximumWords / sectionWords) - 2;
  }
  if (options.minimumWords > 0) {
    return Math.ceil(options.minimumWords / sectionWords) + 2;
  }
  return null;
}

// 独立成册时每个技术分支至少保留根节点作为正文叶子；字数允许时再推荐向下展开。
function enforceMinimumLeafTarget(targetLeafCount, fixedAiLeafCount, technicalBranchCount, wordControlOptions = {}) {
  if (targetLeafCount === null) return null;
  const minimumLeafCount = fixedAiLeafCount + technicalBranchCount;
  const adjustedTarget = Math.max(targetLeafCount, minimumLeafCount);
  if (wordControlOptions.strictSectionWords && wordControlOptions.maximumWords > 0) {
    const sectionMinimumWords = Math.ceil(wordControlOptions.sectionWords * 0.8);
    const maximumLeafCount = Math.floor(wordControlOptions.maximumWords / sectionMinimumWords);
    if (maximumLeafCount < minimumLeafCount) {
      throw new Error(
        `当前严格字数配置最多容纳 ${maximumLeafCount} 个 AI 生成小节，但独立成册目录至少需要 ${minimumLeafCount} 个。请提高全文最大字数、降低单节字数或减少技术评分分支后重新生成目录。`,
      );
    }
    return Math.min(adjustedTarget, maximumLeafCount);
  }
  return adjustedTarget;
}

// 统一目录层级编号，并按父子节点形态整理目录字段。
function renumberOutline(items, prefix = '') {
  return (items || []).map((item, index) => {
    const id = prefix ? `${prefix}.${index + 1}` : String(index + 1);
    const hasChildren = Array.isArray(item?.children) && item.children.length;
    const next = {
      id,
      title: String(item?.title || '').trim(),
      description: String(item?.description || '').trim(),
      ...(prefix ? {} : { attr: item?.attr }),
      ...(!prefix && String(item?.branch_id || '').trim() ? { branch_id: String(item.branch_id).trim() } : {}),
      ...(!hasChildren ? {
        content_mode: item?.content_mode,
        ...(item?.content_mode === 'other' && String(item?.content_mode_note || '').trim()
          ? { content_mode_note: String(item.content_mode_note).trim() }
          : {}),
      } : {}),
    };
    if (hasChildren) {
      next.children = renumberOutline(item.children, id);
    }
    return next;
  });
}

// 接受 Agent 的完整目录结果，并统一整理层级编号和节点字段。
function buildFinalOutline(candidate) {
  return { outline: renumberOutline(candidate?.outline || []) };
}

// 移除仅供 Agent 工作流关联分支的内部字段，再写入正式业务目录。
function stripOutlineInternalFields(candidate) {
  const strip = (items) => (items || []).map((item) => {
    const { branch_id: _branchId, children, ...rest } = item || {};
    return Array.isArray(children) && children.length
      ? { ...rest, children: strip(children) }
      : rest;
  });
  return { outline: strip(candidate?.outline || []) };
}

// 在子目录生成前，把规划分支标识附加到当前可对应的一级目录。
function attachBranchIdsToRoots(items, scoreDirectoryPlan) {
  const branchesByRootId = new Map();
  (scoreDirectoryPlan?.branches || []).forEach((branch) => {
    const rootId = String(branch.root_id || '').split('.')[0];
    if (!branchesByRootId.has(rootId)) branchesByRootId.set(rootId, branch);
  });
  return (items || []).map((item) => {
    const branch = branchesByRootId.get(item.id);
    return branch?.root_title === item.title ? { ...item, branch_id: branch.branch_id } : item;
  });
}

// 按最终目录中的稳定分支标识同步规划所记录的当前编号和标题。
function synchronizeScoreDirectoryPlan(scoreDirectoryPlan, items) {
  const rootsByBranchId = new Map(
    (items || [])
      .filter((item) => String(item?.branch_id || '').trim())
      .map((item) => [String(item.branch_id).trim(), item]),
  );
  return {
    ...scoreDirectoryPlan,
    branches: (scoreDirectoryPlan?.branches || []).map((branch) => {
      const root = rootsByBranchId.get(branch.branch_id);
      return root ? { ...branch, root_id: root.id, root_title: root.title } : branch;
    }),
  };
}

function countAiLeaves(items) {
  return (items || []).reduce((total, item) => (
    Array.isArray(item?.children) && item.children.length
      ? total + countAiLeaves(item.children)
      : total + (item?.content_mode === AI_CONTENT_MODE ? 1 : 0)
  ), 0);
}

// 汇总目录层级、父节点和内容模式等确定性结构信息。
// 对照用户确认的评分规划，机械检查目标标题是否位于指定分支和层级。
// 生成供最终 Agent 审核直接采用的宿主程序确定性检查结果。
function readJson(content, label) {
  try {
    return JSON.parse(String(content || '').trim());
  } catch (error) {
    throw new Error(`${label}不是合法 JSON：${error?.message || String(error)}`);
  }
}

function normalizeReferenceDocumentIds(storedPlan) {
  const ids = storedPlan?.referenceKnowledgeDocumentIds || [];
  return Array.isArray(ids) ? [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))] : [];
}

function buildKnowledgeFiles(knowledgeBaseService, documentIds) {
  if (!knowledgeBaseService?.readReferences) return [];
  return knowledgeBaseService.readReferences(documentIds, { includeMarkdown: true, includeItems: false })
    .map((reference, index) => ({
      path: `参考知识库/参考资料-${index + 1}.md`,
      content: String(reference?.markdown || '').trim(),
    }))
    .filter((file) => file.content);
}

function createLeafAllocationPrompt({ standaloneTechnical = false } = {}) {
  const allocationInstruction = standaloneTechnical
    ? '优先为每个目录分配至少 2 个；总目标不足时允许部分目录分配 1 个，表示保留一级目录本身作为叶子且不生成 children。除 1 以外不得分配少于 2 个，禁止形成只有一个子节点的冗余层级。'
    : '每个目录至少分配 2 个。';
  return `请继续使用当前 Pi Session 已读取的技术评分信息、知识库、原方案和目录规划，为多个技术一级目录分配“AI生成”叶子数量。

要求：
1. 阅读 ${OUTLINE_OUTPUT_FILE}、${TECHNICAL_SCORE_GROUPS_FILE}、${SCORE_DIRECTORY_PLAN_FILE} 和 ${LEAF_ALLOCATION_CONTEXT_FILE}。
2. 综合各一级目录负责的评分项数量、评分细项数量、内容复杂度以及已读取的参考资料，合理分配 allocatable_ai_leaf_count。
3. allocations 必须恰好覆盖 context 中 technical_branches 的全部 branch_id，每个 branch_id 只出现一次。${allocationInstruction}branch_id 是不会因目录重新编号而变化的内部稳定标识。
4. 所有 leaf_count 之和必须等于 allocatable_ai_leaf_count。
5. 将结果写入 ${LEAF_ALLOCATION_FILE}，保留 context 中的 mode、target_ai_leaf_count、fixed_ai_leaf_count 和 allocatable_ai_leaf_count。
6. 不要修改 ${OUTLINE_OUTPUT_FILE}、${TECHNICAL_SCORE_GROUPS_FILE} 或 ${SCORE_DIRECTORY_PLAN_FILE}。
7. 输出格式为 {"mode":"allocated","target_ai_leaf_count":20,"fixed_ai_leaf_count":1,"allocatable_ai_leaf_count":19,"allocations":[{"branch_id":"B1","leaf_count":10},{"branch_id":"B2","leaf_count":9}]}。
8. 程序已为 ${LEAF_ALLOCATION_FILE} 预置 Schema。完成后调用 json-validation 校验，只传 file_path；校验失败后必须先修改文件，再重新校验。`;
}



function createScorePlanningPrompt({ standaloneTechnical = false } = {}) {
  const placementInstruction = standaloneTechnical
    ? `4. 当前采用“技术文件独立成册”：${OUTLINE_OUTPUT_FILE} 中每个一级根节点本身就应对应一个技术评分大项。每个根节点建立一个 branch，score_item_level 固定为 1，mappings 只填写与该根标题对应的评分大项，target_title 必须与 root_title 完全一致；不得再创建“技术方案”“项目管理方案”“监理大纲”“监理大纲（暗标）”“施工组织设计”“技术标”等外层分支。
5. 一级根节点与评分大项默认严格一一对应；发现缺失、重复、合并或顺序不一致时，必须作为一级目录调整向用户说明并取得批准。detail_points 只用于后续生成根节点以下的目录。`
    : `4. 判断技术方案位于哪些目录分支，以及每个分支内评分项对应节点应统一处于哪个层级。不同分支可以使用不同层级，不预设必须是二级目录。优先选择 attr=技术且 content_mode=ai-generate 的一级目录；template-fill、point-to-point 和 other 是特殊处理叶子，不得作为普通技术方案分支展开，除非先向用户说明并取得调整批准。
5. 默认每个评分项对应一个独立同层级节点，节点标题与评分大项基本一一对应；detail_points 用于后续生成更下级目录。`;
  const planExample = standaloneTechnical
    ? `{"branches":[{"branch_id":"B1","root_id":"1","root_title":"评分大项一","score_item_level":1,"mappings":[{"requirement_id":"R1","target_title":"评分大项一"}]}],"extra_titles":[],"allow_root_changes":false}`
    : `{"branches":[{"branch_id":"B1","root_id":"2","root_title":"技术方案","score_item_level":2,"mappings":[{"requirement_id":"R1","target_title":"评分大项目录标题","additional_titles":["经批准拆分出的同级标题"],"adjustment_note":"用户批准的调整说明"}]}],"extra_titles":[{"branch_id":"B1","title":"经批准增加的同层级标题","reason":"增加原因"}],"allow_root_changes":false}`;
  return `用户已经确认最终保留的一级目录，${OUTLINE_OUTPUT_FILE} 已由程序重新整理并编号。工作区也已加入技术评分信息和用户选择的参考资料。

请完成技术评分项结构化和目录规划：
1. 阅读 ${OUTLINE_OUTPUT_FILE}、技术评分信息.md，以及存在的原方案.md 和参考知识库目录。
2. 只从技术评分信息.md 的“技术评分项”中提取适合在技术方案中一一响应、展开编写的评分大项。“技术评分要求”只能作为评分标准、扣分规则和编写约束，不得提取为评分项。
如果技术评分信息中没有任何可用于技术方案目录规划的评分项，立即调用 report-failure，说明需要补充或重新解析技术评分信息；不要调用 ask-user 让用户接受空结果，不要生成空结构、编造评分项或删除、清空文件。
3. 将评分大项写入 ${TECHNICAL_SCORE_GROUPS_FILE}，完整结构为 {"groups":[{"requirement_id":"R1","title":"评分大项","description":"关注内容","detail_points":["关键评分细项"]}]}。根对象只能包含 groups；保持原顺序、专业术语和关键评分细项，requirement_id 使用连续的 R1、R2 格式。
${placementInstruction}
6. 只有以下偏离需要用户批准：合并或拆分评分项、遗漏评分项对应节点、增加评分项中不存在的同层级大项、改变分支评分项目标层级，以及新增、删除、合并或调整用户已确认的一级目录。普通标题规范化和评分项下级目录扩展不需要询问。
7. 存在至少一个有效评分项时，无论是否存在偏离，都必须调用一次 ask-user 让用户确认。没有偏离时，question 只说明你分析得出的技术方案所在目录和评分项所在层级，最多使用两句话且不要使用列表；存在偏离时，只补充实际需要用户批准的偏离及影响，存在多个实际确认事项时才使用简单 Markdown 分行列出。question、选项名称和选项说明不得复述、概括或改写本任务 Prompt 中的要求，只呈现你分析后确实需要用户确认的结论或不确定事项。第一项给出推荐方案；另提供一个名为“调整目录安排”等明确业务名称的选项并设置 custom=true，让用户说明希望调整的位置或层级，其他选项均设置 custom=false。
8. 根据用户回答写入 ${SCORE_DIRECTORY_PLAN_FILE}。完整字段层级示例：${planExample}。branches 中每个分支填写唯一且后续保持不变的 branch_id，并用当前 ${OUTLINE_OUTPUT_FILE} 中尚未调整的一级目录编号和标题填写 root_id、root_title；统一填写 score_item_level，并让每个 requirement_id 在 mappings 中恰好出现一次。后续新增、重排或改名一级目录时，branch_id 仍用于稳定关联同一技术分支，不能随 root_id 改变；程序会在完整目录重新编号后同步 root_id 和 root_title。默认一一对应；经用户批准合并时，多个 mapping 可以使用相同 target_title；经用户批准拆分时才填写 mapping.additional_titles；合并或拆分时才填写 adjustment_note。extra_titles 必须位于根对象，经批准增加同层级大项时才写入条目，否则使用空数组。
9. 默认锁定一级目录，allow_root_changes=false；只有用户明确批准一级目录调整时才设为 true。
10. 程序已为 ${TECHNICAL_SCORE_GROUPS_FILE} 和 ${SCORE_DIRECTORY_PLAN_FILE} 预置 Schema。分别调用 json-validation 校验，调用时只传 file_path；校验失败后必须先修改对应文件，再重新校验；如果现有材料无法在不编造评分项的情况下通过校验，调用 report-failure。
11. 此阶段不要修改 ${OUTLINE_OUTPUT_FILE}，也不要删除、清空或重命名任何任务文件。`;
}

function createLeafAdjustmentPrompt(targetLeafCount, actualLeafCount) {
  return `程序计算当前完整目录共有 ${actualLeafCount} 个“AI生成”叶子节点，目标是 ${targetLeafCount} 个。

请先调用一次 ask-user，说明目标数、当前数、差距及目录质量影响，只能按以下顺序提供三个固定选项，不得改名、增删或调整顺序：
1. “接受当前结果”，custom=false：保持当前目录并进入最终审核。
2. “允许 Agent 自行调整”，custom=false：由你在不破坏目录质量的前提下合理调整一次。
3. “自定义需求”，custom=true：按用户填写的具体要求调整。

根据本轮 ask-user 回答处理：
1. 用户选择“接受当前结果”时，不要修改 ${OUTLINE_OUTPUT_FILE}。
2. 用户选择“允许 Agent 自行调整”或“自定义需求”时，必须继续遵循 ${SCORE_DIRECTORY_PLAN_FILE}：不得删除、移动或改变评分项对应节点的目标层级，不得新增未经批准的同层级大项；优先调整评分项节点下面的更深层目录。
3. 只通过合理调整 ai-generate 叶子的目录结构满足数量目标，不得为了凑数把 template-fill、point-to-point 或 other 改成 ai-generate，也不得改变非 AI 叶子的处理模式。
4. 调整后仍须保持完整根结构 {"outline":[一级目录节点]}，id 必须使用与父子位置一致的层级点号编号；技术一级目录必须保留 ${SCORE_DIRECTORY_PLAN_FILE} 中对应的 branch_id，不能因增删、移动或重新编号而改变；父节点只含 children，不含 content_mode，叶子节点只含 content_mode，不含 children。
5. 不要机械增加重复、空泛或近义目录。程序已为 ${OUTLINE_OUTPUT_FILE} 预置 Schema；完成调整后覆盖写回该文件，并调用 json-validation 校验，只传 file_path；校验失败后必须先修改文件，再重新校验。`;
}

// 运行 V2 目录业务任务；开发者模式下一级目录确认后并行调度目录任务和独立模版提取任务。
async function runOutlineGenerationTaskV2({ aiService, agentService, ordinaryAgentService, workspaceStore, knowledgeBaseService, openXmlHelperService, updateTask, checkpointTask, taskControl, payload }) {
  const storedPlan = workspaceStore.loadTechnicalPlan() || {};
  const restoringOutlineSelection = payload?.agent_resume?.phase === 'outline-selection';
  const standaloneTechnical = storedPlan.outlineMode === 'standalone-technical';
  const hasOriginalPlan = Boolean(storedPlan.originalPlanFile);
  const originalOnly = hasOriginalPlan && storedPlan.outlineExpansionMode === 'original-only';
  const originalPlan = hasOriginalPlan ? workspaceStore.readOriginalPlanMarkdown() : '';
  const responseFileRequirements = storedPlan.bidAnalysisTasks?.responseFileRequirements?.content || '';
  const wordControlOptions = normalizeWordControlOptions(payload?.word_control_options || storedPlan.outlineWordControlOptions);
  let targetLeafCount = deriveTargetLeafCount(wordControlOptions);
  const referenceDocumentIds = normalizeReferenceDocumentIds(storedPlan);
  const knowledgeFiles = buildKnowledgeFiles(knowledgeBaseService, referenceDocumentIds);
  const jsonValidationSchemas = {
    [OUTLINE_OUTPUT_FILE]: OUTLINE_JSON_SCHEMA,
    [TECHNICAL_SCORE_GROUPS_FILE]: TECHNICAL_SCORE_GROUPS_SCHEMA,
    [SCORE_DIRECTORY_PLAN_FILE]: SCORE_DIRECTORY_PLAN_SCHEMA,
    [LEAF_ALLOCATION_FILE]: createLeafAllocationSchema(standaloneTechnical ? 1 : 2),
    [OUTLINE_REVIEW_FILE]: OUTLINE_REVIEW_SCHEMA,
  };

  let initialFiles;
  let taskInstruction;
  if (originalOnly) {
    initialFiles = [{ path: '原方案.md', content: originalPlan }];
    taskInstruction = '只根据原方案材料提取一级目录。';
  } else {
    initialFiles = [
      { path: '响应文件要求.md', content: responseFileRequirements },
      ...(standaloneTechnical ? [{ path: '技术评分信息.md', content: storedPlan.techRequirements || '' }] : []),
      { path: '项目概述.md', content: storedPlan.projectOverview || '' },
      ...(hasOriginalPlan ? [{ path: '原方案.md', content: originalPlan }] : []),
    ];
    taskInstruction = standaloneTechnical
      ? '严格按照技术评分信息.md 中适合技术方案响应的评分大项组织一级目录，只生成技术方案独立分册。评分大项原文、顺序和数量是一级目录的权威依据；响应文件要求.md 只提供装订和响应约束，项目概述.md 仅用于理解背景和术语，原方案.md 仅用于参考下级标题表达。'
      : hasOriginalPlan
        ? '严格按照响应文件要求.md 组织一级目录，它是目录结构和标题来源的唯一依据。项目概述.md 仅用于理解背景和术语，不得据此新增一级目录；原方案.md 仅用于参考标题表达。'
        : '严格按照响应文件要求.md 组织一级目录，它是目录结构和标题来源的唯一依据。项目概述.md 仅用于理解背景和术语，不得据此新增一级目录。';
  }

  let logs = restoringOutlineSelection
    ? [...(Array.isArray(storedPlan.outlineGenerationTask?.logs) ? storedPlan.outlineGenerationTask.logs : []), '已恢复一级目录确认状态']
    : ['开始生成一级目录'];
  let currentProgress = restoringOutlineSelection ? Number(storedPlan.outlineGenerationTask?.progress || 30) : 10;
  const initialCheckpoint = checkpointTask({ status: 'running', progress: currentProgress, logs });
  let task = initialCheckpoint.task;
  const templateTaskId = `${task.task_id}-template`;
  let lockedRoots = [];
  let technicalBranches = [];
  let scoreDirectoryPlan = null;
  let allowRootChanges = false;
  let fixedAiLeafCount = 0;
  let allocatedAiLeafCount = null;
  let finalOutline = null;
  let actualLeafCount = 0;
  let leafWarning = '';
  let wordAdjustmentAttempts = 0;
  let outlineReview = null;

  function updateAgentState(partial = {}, taskPatch = {}) {
    const checkpoint = checkpointTask({
      ...taskPatch,
      stats: {
        ...(task.stats || {}),
        ...(taskPatch.stats || {}),
        agent: {
          ...(task.stats?.agent || {}),
          task_key: OUTLINE_AGENT_TASK_KEY,
          run_id: task.task_id,
          resume_payload: {
            reference_knowledge_document_ids: referenceDocumentIds,
            outline_mode: storedPlan.outlineMode,
            outline_expansion_mode: storedPlan.outlineExpansionMode,
            word_control_options: wordControlOptions,
          },
          ...partial,
        },
      },
    });
    task = checkpoint.task;
  }

  function publish(message, progress, statsPatch = {}) {
    const text = String(message || '').trim();
    if (text && text !== logs[logs.length - 1]) logs = [...logs, text];
    currentProgress = Math.max(currentProgress, progress || currentProgress);
    task = updateTask({
      status: 'running',
      progress: currentProgress,
      logs,
      stats: { ...(task.stats || {}), ...statsPatch },
    });
  }

  function publishAgentActivity(event = {}) {
    const title = formatProgressTitle(event.message);
    if (!title || event.visible === false) return;
    publish(title, Math.max(currentProgress, 20));
  }

  function syncAgentCheckpoint(checkpoint) {
    updateAgentState({
      status: checkpoint.status,
      phase: checkpoint.phase,
      agent_connection: checkpoint.agent_connection,
      session_file: checkpoint.session_file,
    });
  }

  function publishTemplateAgentActivity(event = {}) {
    const title = formatProgressTitle(event.message);
    if (!title || event.visible === false) return;
    publish(`投标模版：${title}`, Math.max(currentProgress, 35));
  }

  function syncTemplateAgentCheckpoint(checkpoint) {
    const next = checkpointTask({
      stats: {
        ...(task.stats || {}),
        template_agent: {
          ...(task.stats?.template_agent || {}),
          task_key: TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
          run_id: templateTaskId,
          status: checkpoint.status,
          phase: checkpoint.phase,
          agent_connection: checkpoint.agent_connection,
          session_file: checkpoint.session_file,
        },
      },
    });
    task = next.task;
  }

  function applyConfirmedSelection(confirmed) {
    const selectedIdSet = new Set(confirmed.selectedIds);
    lockedRoots = renumberOutline(confirmed.items.filter((item) => selectedIdSet.has(item.id)));
    const checkpoint = checkpointTask({
      stats: {
        ...(task.stats || {}),
        outline_selection: {
          items: confirmed.items,
          selected_ids: confirmed.selectedIds,
          confirmed: true,
        },
      },
    });
    task = checkpoint.task;
  }

  function continueWithChildrenGeneration(allocations) {
    publish('技术方案目录已确认，开始生成子目录', 55, {
      outline: {
        phase: 'generating',
        current_leaf_count: 0,
        target_leaf_count: targetLeafCount,
        word_adjustment_attempts: 0,
      },
    });
    return {
      stage: 'children_generation',
      message: 'Agent 正在生成子目录',
      prompt: createChildrenPrompt({ hasOriginalPlan, originalOnly, targetLeafCount, allowRootChanges, standaloneTechnical }),
      files: [
        { path: OUTLINE_OUTPUT_FILE, content: JSON.stringify({ outline: lockedRoots }, null, 2) },
        {
          path: LEAF_ALLOCATION_FILE,
          content: JSON.stringify({
            mode: targetLeafCount === null ? 'agent-decides' : 'allocated',
            target_ai_leaf_count: targetLeafCount,
            fixed_ai_leaf_count: fixedAiLeafCount,
            allocatable_ai_leaf_count: allocatedAiLeafCount,
            allocations,
          }, null, 2),
        },
      ],
    };
  }

  function continueWithOutlineReview() {
    const reviewContext = buildOutlineReviewContext({
      outline: finalOutline,
      scoreDirectoryPlan,
      targetLeafCount,
    });
    publish('子目录生成完成，正在准备最终审核', 88, {
      outline: {
        phase: 'reviewing',
        current_leaf_count: actualLeafCount,
        target_leaf_count: targetLeafCount,
        word_adjustment_attempts: wordAdjustmentAttempts,
      },
    });
    return {
      stage: 'outline_review',
      message: 'Agent 正在审核并修复目录',
      prompt: createOutlineReviewPrompt({ targetLeafCount, actualLeafCount, allowRootChanges }),
      files: [
        { path: OUTLINE_OUTPUT_FILE, content: JSON.stringify(finalOutline, null, 2) },
        { path: SCORE_DIRECTORY_PLAN_FILE, content: JSON.stringify(scoreDirectoryPlan, null, 2) },
        { path: OUTLINE_REVIEW_CONTEXT_FILE, content: JSON.stringify(reviewContext, null, 2) },
      ],
    };
  }

  if (!restoringOutlineSelection) {
    updateAgentState({ status: 'running', phase: 'initial-outline', agent_connection: 'running', session_file: '' });
    const initialResult = await agentService.runTask({
      task_id: task.task_id,
      title: '技术方案一级目录生成',
      prompt: createInitialPrompt(taskInstruction, { standaloneTechnical }),
      output_file: OUTLINE_OUTPUT_FILE,
      files: initialFiles,
      signal: taskControl.signal,
      persistent_task: {
        task_key: OUTLINE_AGENT_TASK_KEY,
        mode: 'create',
      },
      initial_stage: 'initial-outline',
      initial_stage_index: 0,
      json_validation_schemas: jsonValidationSchemas,
      max_retries: 0,
      onActivity: publishAgentActivity,
      onCheckpoint: syncAgentCheckpoint,
    });
    const generated = readJson(initialResult.output_content, OUTLINE_OUTPUT_FILE);
    const items = generated.outline || [];
    const defaultSelectedIds = items.filter((item) => item.attr === '技术').map((item) => item.id);
    const selection = { items, selected_ids: defaultSelectedIds, confirmed: false };
    const waitingMessage = '一级目录已生成，等待用户确认';
    if (waitingMessage !== logs[logs.length - 1]) logs = [...logs, waitingMessage];
    currentProgress = Math.max(currentProgress, 30);
    agentService.updatePersistentTask(OUTLINE_AGENT_TASK_KEY, {
      status: 'waiting-outline-selection',
      phase: 'outline-selection',
      agent_connection: 'idle',
      error: null,
    });
    updateAgentState(
      { status: 'waiting-outline-selection', phase: 'outline-selection', agent_connection: 'idle' },
      {
        status: 'running',
        progress: currentProgress,
        logs,
        stats: { outline_selection: selection },
      },
    );
  }

  const confirmed = await taskControl.waitForOutlineSelection();
  applyConfirmedSelection(confirmed);
  const extractTemplate =
    !standaloneTechnical && Boolean(aiService?.isDeveloperMode?.());

  publish(
    extractTemplate
      ? '一级目录已确认，目录生成与投标模版提取并行开始'
      : standaloneTechnical
        ? '一级目录已确认，已跳过投标模版提取，开始生成技术文件目录'
        : '一级目录已确认，开始生成完整目录',
    35,
  );

  try {
  updateAgentState({ status: 'running', phase: 'score-planning', agent_connection: 'idle' });
  agentService.updatePersistentTask(OUTLINE_AGENT_TASK_KEY, {
    status: 'running',
    phase: 'score-planning',
    agent_connection: 'idle',
  });

  if (extractTemplate && workspaceStore.listTenderSourceDocxRelativePaths().length) {
    await ordinaryAgentService.forkPersistentTask(
      OUTLINE_AGENT_TASK_KEY,
      TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
      {
        run_id: templateTaskId,
        title: '投标模版提取',
        status: 'created',
        phase: 'template-extraction',
        agent_connection: 'idle',
      },
    );
  }

  const parallelController = new AbortController();
  const parallelSignal = AbortSignal.any([taskControl.signal, parallelController.signal]);
  let firstParallelFailure = null;
  const observeParallelBranch = (label, promise) => promise.catch((error) => {
    if (!firstParallelFailure && !taskControl.signal.aborted) {
      firstParallelFailure = { label, error };
      const reason = new Error(`${label}失败，已取消同级任务`);
      reason.code = 'TASK_CANCELLED';
      parallelController.abort(reason);
    }
    throw error;
  });

  const templatePromise = extractTemplate
    ? runTemplateExtractionTask({
        agentService: ordinaryAgentService,
        workspaceStore,
        openXmlHelperService,
        taskId: templateTaskId,
        outline: lockedRoots,
        signal: parallelSignal,
        onActivity: publishTemplateAgentActivity,
        onCheckpoint: syncTemplateAgentCheckpoint,
      })
    : null;

  const directoryPromise = agentService.runTask({
    task_id: task.task_id,
    title: '技术方案目录生成 V2',
    prompt: createScorePlanningPrompt({ standaloneTechnical }),
    output_file: OUTLINE_OUTPUT_FILE,
    files: [
      { path: OUTLINE_OUTPUT_FILE, content: JSON.stringify({ outline: lockedRoots }, null, 2) },
      { path: '技术评分信息.md', content: storedPlan.techRequirements || '' },
      ...knowledgeFiles,
    ],
    signal: parallelSignal,
    persistent_task: {
      task_key: OUTLINE_AGENT_TASK_KEY,
      mode: 'resume',
    },
    initial_stage: 'score-planning',
    initial_stage_index: 2,
    json_validation_schemas: jsonValidationSchemas,
    max_retries: 0,
    onActivity: publishAgentActivity,
    onCheckpoint: syncAgentCheckpoint,
    continueTask: async (candidate, meta) => {
      if (meta.workflow_stage === 'outline_review') {
        const reviewedOutline = readJson(candidate.output_content, OUTLINE_OUTPUT_FILE);
        const normalizedReviewedOutline = buildFinalOutline(reviewedOutline);
        outlineReview = readJson(await meta.readFile(OUTLINE_REVIEW_FILE), OUTLINE_REVIEW_FILE);
        finalOutline = normalizedReviewedOutline;
        scoreDirectoryPlan = synchronizeScoreDirectoryPlan(scoreDirectoryPlan, finalOutline.outline);
        actualLeafCount = countAiLeaves(finalOutline.outline);
        await meta.writeFiles([
          { path: OUTLINE_OUTPUT_FILE, content: JSON.stringify(finalOutline, null, 2) },
          { path: SCORE_DIRECTORY_PLAN_FILE, content: JSON.stringify(scoreDirectoryPlan, null, 2) },
        ]);
        if (targetLeafCount !== null) {
          if (actualLeafCount === targetLeafCount) {
            leafWarning = '';
          } else if (leafWarning) {
            leafWarning = `AI 生成小节目标为 ${targetLeafCount}，用户已确认最终保留当前 ${actualLeafCount} 个。`;
          }
        }
        const reviewMessage = outlineReview.status === 'passed'
          ? '目录审核通过'
          : outlineReview.status === 'simple_fix'
            ? '目录审核完成，Agent 已自动微调简单问题'
            : outlineReview.status === 'user_feedback'
              ? '目录审核完成，已按用户反馈修复'
              : '目录审核完成，用户选择保留当前目录';
        publish(reviewMessage, 95, {
          outline: {
            phase: 'reviewing',
            current_leaf_count: actualLeafCount,
            target_leaf_count: targetLeafCount,
            word_adjustment_attempts: wordAdjustmentAttempts,
          },
        });
        return { complete: true };
      }

      if (meta.workflow_stage === 'score-planning') {
        scoreDirectoryPlan = readJson(await meta.readFile(SCORE_DIRECTORY_PLAN_FILE), SCORE_DIRECTORY_PLAN_FILE);
        lockedRoots = attachBranchIdsToRoots(lockedRoots, scoreDirectoryPlan);
        technicalBranches = scoreDirectoryPlan.branches.map((branch) => ({
          branch_id: branch.branch_id,
          root_id: branch.root_id.split('.')[0],
          root_title: branch.root_title,
        }));
        allowRootChanges = scoreDirectoryPlan.allow_root_changes === true;
        fixedAiLeafCount = lockedRoots
          .filter((root) => !root.branch_id && root.content_mode === AI_CONTENT_MODE).length;
        if (standaloneTechnical) {
          const requestedLeafTarget = targetLeafCount;
          targetLeafCount = enforceMinimumLeafTarget(
            targetLeafCount,
            fixedAiLeafCount,
            technicalBranches.length,
            wordControlOptions,
          );
          if (requestedLeafTarget !== null && targetLeafCount !== requestedLeafTarget) {
            publish(`已按技术分支结构与严格字数上限将 AI 生成叶子目标从 ${requestedLeafTarget} 调整为 ${targetLeafCount}`, 50);
          }
        }
        allocatedAiLeafCount = targetLeafCount === null ? null : targetLeafCount - fixedAiLeafCount;
        if (allocatedAiLeafCount !== null && technicalBranches.length > 1) {
          publish('技术方案目录已确认，Agent 正在分配 AI 生成小节', 50);
          return {
            stage: 'leaf_allocation',
            message: 'Agent 正在分配 AI 生成小节',
            prompt: createLeafAllocationPrompt({ standaloneTechnical }),
            files: [{
              path: LEAF_ALLOCATION_CONTEXT_FILE,
              content: JSON.stringify({
                mode: 'allocated',
                target_ai_leaf_count: targetLeafCount,
                fixed_ai_leaf_count: fixedAiLeafCount,
                allocatable_ai_leaf_count: allocatedAiLeafCount,
                technical_branches: technicalBranches,
              }, null, 2),
            }],
          };
        }
        const allocations = allocatedAiLeafCount === null
          ? technicalBranches.map((branch) => ({ branch_id: branch.branch_id }))
          : [{ branch_id: technicalBranches[0].branch_id, leaf_count: allocatedAiLeafCount }];
        return continueWithChildrenGeneration(allocations);
      }

      if (meta.workflow_stage === 'leaf_allocation') {
        const allocationPayload = readJson(await meta.readFile(LEAF_ALLOCATION_FILE), LEAF_ALLOCATION_FILE);
        return continueWithChildrenGeneration(allocationPayload.allocations);
      }

      const candidateOutline = readJson(candidate.output_content, OUTLINE_OUTPUT_FILE);
      finalOutline = buildFinalOutline(candidateOutline);
      scoreDirectoryPlan = synchronizeScoreDirectoryPlan(scoreDirectoryPlan, finalOutline.outline);
      actualLeafCount = countAiLeaves(finalOutline.outline);
      const latestLeafAnswer = meta.workflow_stage === 'leaf_adjustment'
        ? [...meta.user_question_answers].reverse().find((item) => item.workflow_stage === 'leaf_adjustment')
        : null;
      if (latestLeafAnswer && latestLeafAnswer.selected_option !== '接受当前结果') {
        wordAdjustmentAttempts += 1;
      }
      if (targetLeafCount === null || actualLeafCount === targetLeafCount) return continueWithOutlineReview();

      if (latestLeafAnswer?.selected_option === '接受当前结果') {
        leafWarning = `AI 生成小节目标为 ${targetLeafCount}，用户已接受当前 ${actualLeafCount} 个。`;
        return continueWithOutlineReview();
      }

      publish('AI 生成小节数量存在差异，等待用户决定', 75, {
        outline: {
          phase: 'word-adjusting',
          current_leaf_count: actualLeafCount,
          target_leaf_count: targetLeafCount,
          word_adjustment_attempts: wordAdjustmentAttempts,
        },
      });
      return {
        stage: 'leaf_adjustment',
        message: 'Agent 正在询问如何处理小节数量差异',
        prompt: createLeafAdjustmentPrompt(targetLeafCount, actualLeafCount),
        files: [
          { path: OUTLINE_OUTPUT_FILE, content: JSON.stringify(finalOutline, null, 2) },
          { path: SCORE_DIRECTORY_PLAN_FILE, content: JSON.stringify(scoreDirectoryPlan, null, 2) },
        ],
      };
    },
  });

  let directoryReturned = false;
  let templateReturned = !extractTemplate;
  const observedDirectoryPromise = observeParallelBranch('目录生成', directoryPromise).finally(() => {
    directoryReturned = true;
    if (extractTemplate && !templateReturned) publish('目录生成任务已返回，正在等待投标模版提取任务', 95);
  });

  let agentResult;
  let templateResult = null;
  if (extractTemplate) {
    const observedTemplatePromise = observeParallelBranch('投标模版提取', templatePromise).finally(() => {
      templateReturned = true;
      if (!directoryReturned) publish('投标模版提取任务已返回，正在等待目录生成任务', Math.max(currentProgress, 60));
    });
    const [directorySettled, templateSettled] = await Promise.allSettled([
      observedDirectoryPromise,
      observedTemplatePromise,
    ]);
    if (directorySettled.status === 'rejected' || templateSettled.status === 'rejected') {
      try { workspaceStore.clearBidTemplate(); } catch {}
      if (firstParallelFailure) {
        const failure = new Error(`${firstParallelFailure.label}失败：${firstParallelFailure.error?.message || String(firstParallelFailure.error)}`);
        if (firstParallelFailure.error?.code) failure.code = firstParallelFailure.error.code;
        throw failure;
      }
      const directoryError = directorySettled.status === 'rejected' ? directorySettled.reason : null;
      const templateError = templateSettled.status === 'rejected' ? templateSettled.reason : null;
      const messages = [
        directoryError ? `目录生成失败：${directoryError?.message || String(directoryError)}` : '',
        templateError ? `投标模版提取失败：${templateError?.message || String(templateError)}` : '',
      ].filter(Boolean);
      throw new Error(messages.join('；') || '目录生成未完成');
    }

    agentResult = directorySettled.value;
    templateResult = templateSettled.value;
    if (templateResult.status !== 'skipped' && !workspaceStore.hasBidTemplate()) {
      try { workspaceStore.clearBidTemplate(); } catch {}
      throw new Error('投标模版提取任务已返回，但模版和字段清单不完整');
    }
    publish(
      templateResult.status === 'skipped'
        ? '目录生成完成，当前无招标 Word 原件，已跳过投标模版提取'
        : `目录生成与投标模版提取均已完成，共标记 ${templateResult.field_count || 0} 个字段`,
      98,
    );
  } else {
    agentResult = await observedDirectoryPromise;
    publish('目录生成完成', 98);
  }

  if (!finalOutline) {
    const candidateOutline = readJson(agentResult.output_content, OUTLINE_OUTPUT_FILE);
    finalOutline = buildFinalOutline(candidateOutline);
    scoreDirectoryPlan = synchronizeScoreDirectoryPlan(scoreDirectoryPlan, finalOutline.outline);
    actualLeafCount = countAiLeaves(finalOutline.outline);
  }
  const persistedFinalOutline = stripOutlineInternalFields(finalOutline);
  const completionLog = !extractTemplate
    ? '目录生成与审核完成'
    : templateResult.status === 'skipped'
      ? '目录生成与审核完成，当前无招标 Word 原件'
      : `目录生成、审核与投标模版提取完成，共标记 ${templateResult.field_count || 0} 个字段`;
  const finalLogs = [
    ...logs,
    completionLog,
    ...(leafWarning ? [leafWarning] : []),
  ];
  const finalTaskPatch = {
    status: 'success',
    progress: 100,
    error: undefined,
    logs: finalLogs,
    stats: {
      ...(task.stats || {}),
      outline: {
        phase: 'done',
        current_leaf_count: actualLeafCount,
        target_leaf_count: targetLeafCount,
        leaf_counts_by_mode: countLeavesByMode(finalOutline.outline),
        word_adjustment_attempts: wordAdjustmentAttempts,
        ...(leafWarning ? { word_adjustment_warning: leafWarning, word_adjustment_warning_kind: 'leaf-count' } : {}),
      },
      ...(extractTemplate ? {
        template_agent: {
          ...(task.stats?.template_agent || {}),
          task_key: TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
          run_id: templateTaskId,
          status: templateResult.status,
          phase: templateResult.status === 'skipped' ? 'skipped' : 'completed',
          agent_connection: 'idle',
          field_count: templateResult.field_count || 0,
          ...(templateResult.session_id ? { session_id: templateResult.session_id } : {}),
        },
      } : { template_agent: undefined }),
    },
  };
  const finalCheckpoint = checkpointTask(finalTaskPatch, {
    bidTemplateExists: !standaloneTechnical && workspaceStore.hasBidTemplate(),
    outlineData: { ...persistedFinalOutline, project_overview: storedPlan.projectOverview || '' },
    outlineWordControlSnapshot: wordControlOptions,
    contentGenerationTask: undefined,
    contentGenerationSections: {},
    contentGenerationPlans: {},
    contentGenerationRuntime: undefined,
    contentIllustrationPlan: undefined,
  });
  task = finalCheckpoint.task;
  agentService.updatePersistentTask(OUTLINE_AGENT_TASK_KEY, {
    status: 'success',
    phase: 'completed',
    agent_connection: 'idle',
    error: null,
    completed_at: new Date().toISOString(),
  });
  } catch (error) {
    const message = error?.message || String(error);
    const status = taskControl.signal.aborted || error?.code === 'AGENT_DISCONNECTED'
      ? 'interrupted'
      : 'error';
    try {
      updateAgentState({
        status,
        agent_connection: 'idle',
        error: message,
      });
    } catch {}
    try {
      agentService.updatePersistentTask(OUTLINE_AGENT_TASK_KEY, {
        status,
        agent_connection: 'idle',
        error: message,
      });
    } catch {}
    try { workspaceStore.clearBidTemplate(); } catch {}
    throw error;
  }
}

module.exports = {
  runOutlineGenerationTaskV2,
  OUTLINE_OUTPUT_FILE,
  OUTLINE_JSON_SCHEMA,
  buildFinalOutline,
  stripOutlineInternalFields,
  readJson,
  formatProgressTitle,
  createInitialPrompt,
  createScorePlanningPrompt,
  createChildrenPrompt,
  enforceMinimumLeafTarget,
};
