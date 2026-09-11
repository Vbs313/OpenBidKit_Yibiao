const path = require('node:path');
const { app } = require('electron');

const MARKER = '夹具生成的正文内容';
const ORIGINAL_MARKER = '原方案正文段落';

function exitWithCode(code) {
  if (app?.isReady?.()) {
    app.exit(code);
    return;
  }
  process.exit(code);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// 覆盖审计要求「每个允许的 source_id 都必须回一条 items」，从提示词里取其允许清单，
// 夹具才能对任意分段数都返回合法结果。
// 还原映射同理：从提示词里取原方案段编号，避免把段编号写死。
function extractAllowedSourceIds(messages) {
  const message = (messages || []).find(
    (item) => String(item?.content || '').startsWith('允许的 source_id：'),
  );
  if (!message) return [];
  const raw = String(message.content).replace('允许的 source_id：', '').trim();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractOriginalSegmentIds(messages) {
  const text = (messages || []).map((item) => String(item?.content || '')).join('\n');
  return [...text.matchAll(/<original_segment id="([^"]+)"/g)].map((match) => match[1]);
}

function buildPlan({ expansion, audit, coverageAudit, wordControl }) {
  const plan = {
    outlineData: {
      outline: [{ id: 'c1', title: '章节一', description: '章节描述', content_mode: 'ai-generate', children: [] }],
    },
    globalFacts: [{ title: '项目名称', content: '夹具项目' }],
    globalFactsTask: { status: 'success' },
    globalFactsMode: 'fabricate',
    projectOverview: '项目概述文本',
    contentGenerationOptions: {
      tableRequirement: 'none',
      enableConsistencyAudit: Boolean(audit),
      ...(audit ? { consistencyRepairMode: 'normal' } : {}),
      ...(coverageAudit
        ? { enableOriginalPlanCoverageAudit: true, originalPlanCoverageRepairMode: 'normal' }
        : {}),
    },
  };
  if (wordControl) {
    // 严格小节字数：生成正文远低于下限，必然进入正文字数调整阶段。
    plan.outlineWordControlSnapshot = {
      enabled: true,
      minimumWords: 0,
      maximumWords: 0,
      sectionWords: 100,
      strictSectionWords: true,
    };
  }
  if (expansion) {
    plan.workflowKind = 'existing-plan-expansion';
    plan.originalPlanFile = 'original.md';
  }
  return plan;
}

async function runScenario({
  name, expansion = false, audit = false, coverageAudit = false, wordControl = false,
}) {
  const { runContentGenerationTask } = require(path.join(__dirname, '..', 'electron', 'services', 'tasks', 'contentGenerationTask.cjs'));
  const plan = buildPlan({ expansion, audit, coverageAudit, wordControl });
  const calls = {
    chat: 0, json: 0, audit: 0, coverageAudit: 0, wordAdjust: 0, agent: 0, checkpoints: [], updates: [],
  };

  const aiService = {
    getConfig: () => ({ concurrency_limit: 1 }),
    getImageModelAvailability: () => ({ available: false }),
    collectJsonResponse: async ({ logTitle, messages }) => {
      calls.json += 1;
      const title = String(logTitle || '');
      if (audit && title.startsWith('一致性审计')) {
        calls.audit += 1;
        return { conflicts: [] };
      }
      if (coverageAudit && title.startsWith('原方案覆盖审计')) {
        calls.coverageAudit += 1;
        return {
          items: extractAllowedSourceIds(messages).map((sourceId) => ({
            source_id: sourceId,
            node_id: 'c1',
            status: 'covered',
          })),
        };
      }
      if (wordControl && title.startsWith('正文扩写')) {
        calls.wordAdjust += 1;
        // 一次性插入足够长的正文，让严格小节字数在一轮内收敛。
        return {
          mode: 'expand',
          granularity: 'paragraph',
          operations: [{ operation: 'insert', anchor: 'end', content: '扩写补充内容。'.repeat(9) }],
        };
      }
      // 直接返回 normalizer 之后的形状：真实 aiService 会先 normalize 再 validate，
      // 夹具不能替它包一层 result，否则还原结果会被丢弃、扩写路径静默退化成纯生成。
      if (expansion && title.includes('还原')) {
        return { assignments: [{ node_id: 'c1', source_ids: extractOriginalSegmentIds(messages) }] };
      }
      // 其余场景：编排决策故意失败，走“按纯正文生成”的回落分支。
      throw new Error('content-generation-smoke: 编排决策回落');
    },
    chat: async () => {
      calls.chat += 1;
      return `## 生成正文\n\n${MARKER}，用于验证${name}路径。`;
    },
  };
  const workspaceStore = {
    loadTechnicalPlan: () => plan,
    readOriginalPlanMarkdown: () => `## 原方案章节\n\n${ORIGINAL_MARKER}，需要保留实质内容。`,
    clearMermaidCache: () => {},
    clearIllustrationFiles: () => {},
    clearUnreferencedGeneratedImages: () => {},
  };
  const knowledgeBaseService = { readReferences: () => [] };
  const agentService = {
    runTask: async () => {
      calls.agent += 1;
      throw new Error('content-generation-smoke: 夹具不应进入 Agent 修复阶段');
    },
  };
  // checkpointTask 是三参数契约：(任务补丁, 状态补丁, 方案补丁)，正文在第二、三个参数里。
  const checkpointTask = (...args) => {
    calls.checkpoints.push(args);
    return args[0];
  };
  const updateTask = (patch) => {
    calls.updates.push(patch);
    return patch;
  };

  await runContentGenerationTask({
    aiService,
    agentService,
    workspaceStore,
    knowledgeBaseService,
    updateTask,
    checkpointTask,
    payload: {
      generationOptions: {
        tableRequirement: 'none',
        enableConsistencyAudit: audit,
        ...(audit ? { consistencyRepairMode: 'normal' } : {}),
        ...(coverageAudit
          ? { enableOriginalPlanCoverageAudit: true, originalPlanCoverageRepairMode: 'normal' }
          : {}),
      },
    },
    taskControl: {},
    previousState: undefined,
  });

  assert(calls.chat >= 1, `${name}：没有调用正文生成`);
  assert(calls.agent === 0, `${name}：夹具不应进入 Agent 修复阶段，实际 ${calls.agent}`);
  assert(
    calls.checkpoints.some(([, state]) => {
      const section = state && state.contentGenerationItem && state.contentGenerationItem.section;
      return section && String(section.content || '').includes(MARKER);
    }),
    `${name}：checkpointTask 的状态补丁里没有生成正文`,
  );
  assert(
    calls.checkpoints.some(([, , planPatch]) => {
      const section = planPatch && planPatch.contentSection;
      return section && String(section.content || '').includes(MARKER);
    }),
    `${name}：checkpointTask 的方案补丁里没有生成正文`,
  );
  const allTaskPatches = [...calls.updates, ...calls.checkpoints.map(([taskPatch]) => taskPatch)];
  const finalPatch = [...allTaskPatches].reverse().find((patch) => patch && patch.status === 'success');
  assert(finalPatch, `${name}：没有收到 status=success 的任务更新`);
  assert(finalPatch.progress === 100, `${name}：成功态进度应为 100，实际 ${finalPatch.progress}`);
  const logs = Array.isArray(finalPatch.logs) ? finalPatch.logs.join('\n') : '';
  // 已还原的小节走「基于原方案优化扩写」，未还原的走普通生成，里程碑不同。
  const milestones = expansion
    ? ['准备生成正文', '开始基于原方案优化扩写：c1 章节一', '原方案优化扩写完成：c1 章节一']
    : ['准备生成正文', '开始生成：c1 章节一', '生成完成：c1 章节一'];
  for (const milestone of milestones) {
    assert(logs.includes(milestone), `${name}：任务日志缺少里程碑：${milestone}`);
  }
  if (audit) {
    assert(calls.audit >= 1, `${name}：审计阶段没有调用模型`);
    assert(logs.includes('一致性审计'), `${name}：任务日志里没有一致性审计阶段`);
  }
  if (coverageAudit) {
    assert(calls.coverageAudit >= 1, `${name}：原方案覆盖审计阶段没有调用模型`);
    assert(logs.includes('原方案覆盖审计'), `${name}：任务日志里没有原方案覆盖审计阶段`);
  }
  if (wordControl) {
    assert(calls.wordAdjust >= 1, `${name}：字数调整阶段没有调用模型`);
    assert(
      calls.checkpoints.some(([, , planPatch]) => (
        String(planPatch?.contentSection?.content || '').includes('扩写补充内容')
      )),
      `${name}：字数调整结果没有写回小节正文`,
    );
  }
  if (expansion) {
    assert(
      logs.includes('原方案还原完成：已还原 1 个小节，未分配原文段 0 个。'),
      `${name}：扩写路径没有真正完成原方案还原`,
    );
  }

  return { name, ...calls, checkpoints: calls.checkpoints.length };
}

async function runSmoke() {
  try {
    const results = [];
    results.push(await runScenario({ name: '纯 AI 生成' }));
    results.push(await runScenario({ name: '已有方案扩写', expansion: true }));
    results.push(await runScenario({ name: '一致性审计', audit: true }));
    results.push(await runScenario({ name: '原方案覆盖审计', expansion: true, coverageAudit: true }));
    results.push(await runScenario({ name: '小节字数控制', wordControl: true }));

    for (const result of results) {
      console.log(
        `[content-generation-smoke] ${result.name}：正文 ${result.chat} 次、模型 JSON ${result.json} 次`
        + `、审计 ${result.audit} 次、覆盖审计 ${result.coverageAudit} 次、字数调整 ${result.wordAdjust} 次`
        + `、检查点 ${result.checkpoints} 次`,
      );
    }
    console.log('[content-generation-smoke] 五条路径的生成正文都已进入 checkpointTask 的状态补丁与方案补丁');
    console.log('[content-generation-smoke] all checks passed');
    exitWithCode(0);
  } catch (error) {
    console.error('[content-generation-smoke] failed');
    console.error(error?.stack || error?.message || String(error));
    exitWithCode(1);
  }
}

if (app?.whenReady) {
  app.whenReady().then(runSmoke, (error) => {
    console.error('[content-generation-smoke] Electron app failed to become ready.');
    console.error(error?.stack || error?.message || String(error));
    exitWithCode(1);
  });
} else {
  runSmoke();
}
