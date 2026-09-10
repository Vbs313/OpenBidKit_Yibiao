const path = require('node:path');
const { app } = require('electron');

const MARKER = '夹具生成的正文内容';

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

function buildPlan() {
  return {
    outlineData: {
      outline: [{ id: 'c1', title: '章节一', description: '章节描述', content_mode: 'ai-generate', children: [] }],
    },
    globalFacts: [{ title: '项目名称', content: '夹具项目' }],
    globalFactsTask: { status: 'success' },
    globalFactsMode: 'fabricate',
    projectOverview: '项目概述文本',
    contentGenerationOptions: { tableRequirement: 'none', enableConsistencyAudit: false },
  };
}

async function runSmoke() {
  try {
    const { runContentGenerationTask } = require(path.join(__dirname, '..', 'electron', 'services', 'tasks', 'contentGenerationTask.cjs'));
    const plan = buildPlan();
    const calls = { chat: 0, json: 0, agent: 0, checkpoints: [], updates: [] };

    const aiService = {
      getConfig: () => ({ concurrency_limit: 1 }),
      getImageModelAvailability: () => ({ available: false }),
      collectJsonResponse: async () => {
        calls.json += 1;
        // 编排决策故意失败：走“按纯正文生成”的回落分支，这正是夹具想覆盖的路径之一。
        throw new Error('content-generation-smoke: 编排决策回落');
      },
      chat: async () => {
        calls.chat += 1;
        return `## 生成正文\n\n${MARKER}，用于验证生成管线端到端可跑。`;
      },
    };
    const workspaceStore = {
      loadTechnicalPlan: () => plan,
      readOriginalPlanMarkdown: () => '',
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

    assert(calls.chat === 1, `单小节应只调用一次正文生成，实际 ${calls.chat}`);
    assert(calls.agent === 0, `未启用一致性审计时不应调用 Agent，实际 ${calls.agent}`);

    const sectionCheckpoint = calls.checkpoints.find(([, state]) => {
      const section = state && state.contentGenerationItem && state.contentGenerationItem.section;
      return section && String(section.content || '').includes(MARKER);
    });
    assert(sectionCheckpoint, 'checkpointTask 的状态补丁里没有生成正文');

    const planCheckpoint = calls.checkpoints.find(([, , planPatch]) => {
      const section = planPatch && planPatch.contentSection;
      return section && String(section.content || '').includes(MARKER);
    });
    assert(planCheckpoint, 'checkpointTask 的方案补丁里没有生成正文');

    const allPatches = [...calls.updates, ...calls.checkpoints.map(([taskPatch]) => taskPatch)];
    const finalPatch = [...allPatches].reverse().find((patch) => patch && patch.status === 'success');
    assert(finalPatch, '没有收到 status=success 的任务更新');
    assert(finalPatch.progress === 100, `成功态进度应为 100，实际 ${finalPatch.progress}`);
    const logs = Array.isArray(finalPatch.logs) ? finalPatch.logs.join('\n') : '';
    for (const milestone of ['准备生成正文', '开始生成：c1 章节一', '生成完成：c1 章节一']) {
      assert(logs.includes(milestone), `任务日志缺少里程碑：${milestone}`);
    }

    console.log(`[content-generation-smoke] 端到端跑通：编排回落 1 次、正文生成 1 次、检查点 ${calls.checkpoints.length} 次`);
    console.log('[content-generation-smoke] 生成正文已出现在 checkpointTask 的状态补丁与方案补丁中');
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
