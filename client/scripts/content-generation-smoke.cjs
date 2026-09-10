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

function buildPlan({ expansion }) {
  const plan = {
    outlineData: {
      outline: [{ id: 'c1', title: '章节一', description: '章节描述', content_mode: 'ai-generate', children: [] }],
    },
    globalFacts: [{ title: '项目名称', content: '夹具项目' }],
    globalFactsTask: { status: 'success' },
    globalFactsMode: 'fabricate',
    projectOverview: '项目概述文本',
    contentGenerationOptions: { tableRequirement: 'none', enableConsistencyAudit: false },
  };
  if (expansion) {
    plan.workflowKind = 'existing-plan-expansion';
    plan.originalPlanFile = 'original.md';
  }
  return plan;
}

async function runScenario({ name, expansion }) {
  const { runContentGenerationTask } = require(path.join(__dirname, '..', 'electron', 'services', 'tasks', 'contentGenerationTask.cjs'));
  const plan = buildPlan({ expansion });
  const calls = { chat: 0, json: 0, agent: 0, checkpoints: [], updates: [] };

  const aiService = {
    getConfig: () => ({ concurrency_limit: 1 }),
    getImageModelAvailability: () => ({ available: false }),
    collectJsonResponse: async ({ logTitle }) => {
      calls.json += 1;
      if (expansion && String(logTitle || '').includes('还原')) {
        return { result: { assignments: [{ node_id: 'c1', source_ids: ['P001'] }] } };
      }
      // 纯生成场景：编排决策故意失败，走“按纯正文生成”的回落分支。
      throw new Error('content-generation-smoke: 编排决策回落');
    },
    chat: async () => {
      calls.chat += 1;
      return `## 生成正文\n\n${MARKER}，用于验证${expansion ? '已有方案扩写' : '纯生成'}路径。`;
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
      throw new Error('content-generation-smoke: 未启用一致性审计，不应调用 Agent');
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
    payload: { generationOptions: { tableRequirement: 'none', enableConsistencyAudit: false } },
    taskControl: {},
    previousState: undefined,
  });

  assert(calls.chat >= 1, `${name}：没有调用正文生成`);
  assert(calls.agent === 0, `${name}：未启用一致性审计时不应调用 Agent，实际 ${calls.agent}`);
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
  for (const milestone of ['准备生成正文', '开始生成：c1 章节一', '生成完成：c1 章节一']) {
    assert(logs.includes(milestone), `${name}：任务日志缺少里程碑：${milestone}`);
  }
  if (expansion) {
    assert(logs.includes('还原') || logs.includes('原方案'), `${name}：扩写路径日志里没有提到原方案还原`);
  }

  return { name, chat: calls.chat, json: calls.json, checkpoints: calls.checkpoints.length, expansion };
}

async function runSmoke() {
  try {
    const results = [];
    results.push(await runScenario({ name: '纯 AI 生成', expansion: false }));
    results.push(await runScenario({ name: '已有方案扩写', expansion: true }));

    const expansionResult = results.find((result) => result.expansion);
    assert(expansionResult.json >= 1, '扩写路径应调用一次还原映射');

    console.log(`[content-generation-smoke] 场景一（纯生成）：正文 ${results[0].chat} 次、检查点 ${results[0].checkpoints} 次`);
    console.log(`[content-generation-smoke] 场景二（方案扩写）：正文 ${expansionResult.chat} 次、还原映射 ${expansionResult.json} 次、检查点 ${expansionResult.checkpoints} 次`);
    console.log('[content-generation-smoke] 两条路径的生成正文都已进入 checkpointTask 的状态补丁与方案补丁');
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
