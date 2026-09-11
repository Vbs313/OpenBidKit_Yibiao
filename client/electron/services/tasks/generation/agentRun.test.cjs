const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgentRun } = require('./agentRun.cjs');

function makeRun(overrides = {}) {
  const state = {
    leaves: [],
    sections: {},
    logs: [],
    published: [],
    devLogs: [],
    pauses: [],
  };
  const liveState = {
    get leaves() { return state.leaves; },
    get sections() { return state.sections; },
    get logs() { return state.logs; },
    appendLog: (message) => { state.logs.push(message); },
  };
  const deps = {
    state: liveState,
    agentService: { runTask: async () => ({ success: true, output_content: '输出内容' }) },
    publishTaskUpdate: (partial) => { state.published.push(partial); },
    statsSnapshot: () => ({ phase: 'generating' }),
    writeDeveloperLog: (event, payload) => { state.devLogs.push([event, payload]); },
    pauseIfRequested: (message) => { state.pauses.push(message); },
    isPauseRequested: () => false,
  };
  return { run: createAgentRun({ ...deps, ...overrides }), state, deps };
}

function pauseError(message = 'paused') {
  const error = new Error(message);
  error.code = 'CONTENT_GENERATION_PAUSED';
  return error;
}

test('agentErrorDiagnostics 收集 Agent 现场字段并给出空默认值', () => {
  const { run } = makeRun();
  const bare = run.agentErrorDiagnostics(new Error('boom'));
  assert.equal(bare.error, 'boom');
  assert.equal(bare.name, 'Error');
  assert.equal(bare.agent_validation_failed, false);
  assert.deepEqual(bare.agent_retry_attempts, []);
  assert.deepEqual(bare.agent_diagnostics, {});

  const rich = new Error('bad');
  rich.agentRuntimeId = 'runtime-1';
  rich.agentTaskId = 'task-9';
  rich.agentTitle = '标题';
  rich.agentWorkspaceDir = '/ws';
  rich.agentRuntimeRoot = '/root';
  rich.agentOutputFile = 'technical-plan.md';
  rich.agentOutputPath = '/ws/technical-plan.md';
  rich.agentPartialOutput = '半截输出';
  rich.agentValidationFailed = true;
  rich.agentRetryAttempts = [{ attempt: 1 }];
  rich.agentDiagnostics = { foo: 'bar' };
  const diag = run.agentErrorDiagnostics(rich);
  assert.equal(diag.agent_runtime, 'runtime-1');
  assert.equal(diag.agent_task_id, 'task-9');
  assert.equal(diag.agent_output_file, 'technical-plan.md');
  assert.equal(diag.agent_partial_output_chars, '半截输出'.length);
  assert.equal(diag.agent_validation_failed, true);
  assert.deepEqual(diag.agent_retry_attempts, [{ attempt: 1 }]);
  assert.deepEqual(diag.agent_diagnostics, { foo: 'bar' });
});

test('isAgentBusyResult 只认 busy 与 skipped', () => {
  const { run } = makeRun();
  assert.equal(run.isAgentBusyResult({ status: 'busy' }), true);
  assert.equal(run.isAgentBusyResult({ skipped: true }), true);
  assert.equal(run.isAgentBusyResult({ status: 'success' }), false);
  assert.equal(run.isAgentBusyResult(null), false);
});

test('实时进度处理器去重、跳过空消息与不可见事件', () => {
  const { run, state } = makeRun();
  const seen = [];
  const handler = run.createAgentActivityProgressHandler((step, label) => seen.push([step, label]), 2, '兜底标签');
  handler({ stage: 'plan', message: '步骤一' });
  handler({ stage: 'plan', message: '步骤一' });
  handler({ stage: 'plan', message: '步骤二' });
  handler({ stage: 'plan', message: '   ' });
  handler({ stage: 'plan', message: '隐藏', visible: false });
  assert.deepEqual(seen, [[2, '步骤一'], [2, '步骤二']]);
  assert.deepEqual(state.logs, ['Agent 实时进度：步骤一', 'Agent 实时进度：步骤二']);
});

test('Agent 成功执行时记录完成日志并原样返回结果', async () => {
  const result = { success: true, runtime_id: 'r1', task_id: 't1', output_content: '正文' };
  const { run, state } = makeRun({ agentService: { runTask: async () => result } });
  const returned = await run.runAgentTaskWithRecoveredOutput({ output_file: 'a.md' }, 'content.agent');
  assert.equal(returned, result);
  const done = state.devLogs.find(([event]) => event === 'content.agent.agent.done');
  assert.ok(done);
  assert.equal(done[1].agent_runtime, 'r1');
  assert.equal(done[1].agent_task_id, 't1');
});

test('Agent 忙碌时记录日志并把 busy 结果交回调用方', async () => {
  const busy = { status: 'busy', message: '正在处理其他任务', active_task: { id: 'x' } };
  const { run, state } = makeRun({ agentService: { runTask: async () => busy } });
  const returned = await run.runAgentTaskWithRecoveredOutput({}, 'content.agent');
  assert.equal(returned, busy);
  const logged = state.devLogs.find(([event]) => event === 'content.agent.agent.busy');
  assert.ok(logged);
  assert.equal(logged[1].message, '正在处理其他任务');
});

test('暂停类错误直接向上抛，不做输出恢复', async () => {
  const { run, state } = makeRun({ agentService: { runTask: async () => { throw pauseError('暂停了'); } } });
  await assert.rejects(() => run.runAgentTaskWithRecoveredOutput({}, 'content.agent'), /暂停了/);
  assert.equal(state.devLogs.some(([event]) => event === 'content.agent.agent.error'), false);
});

test('校验失败的 Agent 错误不尝试恢复', async () => {
  const error = new Error('校验失败');
  error.agentValidationFailed = true;
  error.agentPartialOutput = '半截输出';
  const { run } = makeRun({ agentService: { runTask: async () => { throw error; } } });
  await assert.rejects(() => run.runAgentTaskWithRecoveredOutput({}, 'content.agent'), /校验失败/);
});

test('没有可用半截输出时原样抛出', async () => {
  const { run } = makeRun({ agentService: { runTask: async () => { throw new Error('硬失败'); } } });
  await assert.rejects(() => run.runAgentTaskWithRecoveredOutput({}, 'content.agent'), /硬失败/);
});

test('Agent 崩溃但有半截输出时按恢复结果返回', async () => {
  const error = new Error('崩溃');
  error.agentPartialOutput = '恢复出来的正文';
  error.agentRuntimeId = 'r9';
  error.agentTaskId = 't9';
  const { run, state } = makeRun({ agentService: { runTask: async () => { throw error; } } });
  const returned = await run.runAgentTaskWithRecoveredOutput({ output_file: 'a.md', title: '任务' }, 'content.agent');
  assert.equal(returned.recovered, true);
  assert.equal(returned.success, true);
  assert.equal(returned.output_content, '恢复出来的正文');
  assert.equal(returned.runtime_id, 'r9');
  assert.equal(returned.task_id, 't9');
  assert.equal(returned.title, '任务');
  assert.equal(state.devLogs.some(([event]) => event === 'content.agent.output.recovered'), true);
});

test('半截输出与预置文件内容相同则拒绝恢复', async () => {
  const error = new Error('崩溃');
  error.agentPartialOutput = '原样未改';
  const { run, state } = makeRun({ agentService: { runTask: async () => { throw error; } } });
  await assert.rejects(
    () => run.runAgentTaskWithRecoveredOutput({ output_file: 'a.md', files: [{ path: './A.md', content: '原样未改' }] }, 'content.agent'),
    /崩溃/,
  );
  const rejected = state.devLogs.find(([event]) => event === 'content.agent.output.recovered_rejected');
  assert.ok(rejected);
  assert.equal(rejected[1].reason, 'same_as_seeded_output');
});

test('runContentAgentTask 在 Agent 不可用时直接报错', async () => {
  const { run } = makeRun({ agentService: {} });
  await assert.rejects(() => run.runContentAgentTask({ title: '正文生成', prompt: 'p', outputFile: 'a.md' }), /Agent 服务尚未初始化/);
});

test('runContentAgentTask 成功后返回结果与输出内容', async () => {
  const { run, state } = makeRun({ agentService: { runTask: async () => ({ success: true, output_content: ' 正文 ' }) } });
  const result = await run.runContentAgentTask({
    title: '正文生成', prompt: '提示词', outputFile: 'a.md', eventPrefix: 'content.agent', activityLabel: '生成中',
  });
  assert.equal(result.outputContent, '正文');
  assert.equal(result.agentResult.output_content, ' 正文 ');
  assert.equal(state.pauses.some((m) => m.includes('结果回写前暂停')), true);
});

test('runContentAgentTask 遇到 busy 结果时按错误抛出', async () => {
  const { run } = makeRun({ agentService: { runTask: async () => ({ status: 'busy' }) } });
  await assert.rejects(
    () => run.runContentAgentTask({ title: '正文生成', prompt: 'p', outputFile: 'a.md', eventPrefix: 'content.agent' }),
    /Agent 正在处理其他任务/,
  );
});

test('runContentAgentTask 拿到空输出时报错', async () => {
  const { run } = makeRun({ agentService: { runTask: async () => ({ success: true, output_content: '   ' }) } });
  await assert.rejects(
    () => run.runContentAgentTask({ title: '正文生成', prompt: 'p', outputFile: 'technical-plan.md', eventPrefix: 'content.agent' }),
    /Agent 未返回 technical-plan.md/,
  );
});

test('runContentAgentTask 暂停时记录日志并向上抛', async () => {
  const { run, state } = makeRun({ agentService: { runTask: async () => { throw pauseError('取消'); } } });
  await assert.rejects(
    () => run.runContentAgentTask({
      title: '正文生成', prompt: 'p', outputFile: 'a.md', eventPrefix: 'content.agent',
      pausedLogMessage: '本轮 Agent 已取消',
    }),
    /取消/,
  );
  assert.equal(state.logs.includes('本轮 Agent 已取消'), true);
});

test('runContentAgentTask 在启动前发现暂停请求时取消本轮 Agent', async () => {
  let signalWasAborted = false;
  const { run, state } = makeRun({
    agentService: {
      runTask: async (payload) => {
        signalWasAborted = Boolean(payload.signal?.aborted);
        throw payload.signal?.reason || new Error('未被取消');
      },
    },
    isPauseRequested: () => true,
  });
  await assert.rejects(
    () => run.runContentAgentTask({ title: '正文生成', prompt: 'p', outputFile: 'a.md', eventPrefix: 'content.agent' }),
    /CONTENT_GENERATION_PAUSED/,
  );
  assert.equal(signalWasAborted, true);
  assert.equal(state.logs.some((m) => m.includes('已请求暂停正文生成，正在取消本轮 Agent 任务。')), true);
  assert.equal(state.pauses.length > 0, true);
});
