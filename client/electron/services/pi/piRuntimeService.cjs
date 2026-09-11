const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const perfTrace = require('../../utils/perfTrace.cjs');
const { getDeveloperLogsDir } = require('../../utils/paths.cjs');
const { createAgentOpenAiProxy } = require('../agent/agentOpenAiProxy.cjs');
const { isExpectedAgentInterruption, resolveAgentAbortReason } = require('../agent/agentInterruption.cjs');
const { trackAgentRuntime } = require('../agent/agentRuntimeAnalytics.cjs');
const { preparePiEnvironment } = require('./piEnvironment.cjs');
const { restorePiErrorMessage } = require('./piRetryErrorNormalizer.cjs');
const { createPiSession, loadPiModules } = require('./piSessionFactory.cjs');
const { createPiSelfCheck } = require('./piSelfCheck.cjs');
const { AGENT_REPORTED_FAILURE_CODE } = require('./piTaskFailureTool.cjs');
const {
  createPersistentAgentTask,
  getPersistentAgentSessionPath,
  loadPersistentAgentTask,
  updatePersistentAgentTask,
} = require('./piPersistentTaskStore.cjs');
const {
  SAFE_REPAIR_ACTIONS,
  analyzePiSelfCheckWithModel,
  createPiEnvironmentSnapshot,
  createPiDiagnosticSections,
  createPiSelfCheckSteps,
  diagnosePiSelfCheck,
  ensureLoopbackNoProxy,
  runPiLoopbackSelfCheck,
  runPiTextModelSelfCheck,
  runPiToolEnvironmentSelfCheck,
  serializeDiagnosticError,
  summarizeTextModelConfig,
  validatePiSessionSnapshot,
} = require('./piSelfCheckService.cjs');

const DEFAULT_IDLE_TIMEOUT_MS = 8 * 60 * 1000;
const DEFAULT_NORMAL_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_RETRIES = 3;
const STATUS_TICK_MS = 1000;
const PI_RUNTIME_ID = 'pi';
const PI_RUNTIME_NAME = 'Pi Agent';
const PI_RUNTIME = Object.freeze({
  id: PI_RUNTIME_ID,
  displayName: PI_RUNTIME_NAME,
  description: '使用内嵌 Pi SDK 智能体链路。',
});

function nowIso() {
  return new Date().toISOString();
}

function normalizeTimeoutMs(value, fallback = DEFAULT_IDLE_TIMEOUT_MS) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeMaxRetries(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(MAX_RETRIES, Math.floor(number))) : 1;
}

function safeTaskSegment(value) {
  return String(value || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || crypto.randomUUID();
}

// 限制任务输入和输出只能使用普通相对路径，并禁止覆盖 Pi 资源文件。
function safeRelativePath(value) {
  const relative = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const lower = relative.toLowerCase();
  if (!relative || relative.includes('..')) throw new Error(`非法文件路径：${value}`);
  if (
    lower === 'agents.md'
    || lower === 'claude.md'
    || lower.startsWith('.pi/')
    || lower.startsWith('.agents/')
  ) {
    throw new Error(`Pi Agent 保留路径不允许作为任务文件：${value}`);
  }
  return relative;
}

function ensureInsideRoot(rootDir, targetPath, sourcePath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`文件路径越界：${sourcePath}`);
  return target;
}

async function clearDirectoryAsync(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map((entry) => fs.promises.rm(path.join(dir, entry.name), { recursive: true, force: true })));
}

async function writeWorkspaceFilesAsync(workspaceDir, files = []) {
  await fs.promises.mkdir(workspaceDir, { recursive: true });
  for (const file of files) {
    const relative = safeRelativePath(file.path);
    const target = ensureInsideRoot(workspaceDir, path.join(workspaceDir, relative), file.path);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, String(file.content || ''), 'utf-8');
  }
}

async function readOutputAsync(workspaceDir, outputFile) {
  const relative = safeRelativePath(outputFile);
  const target = ensureInsideRoot(workspaceDir, path.join(workspaceDir, relative), outputFile);
  try {
    return { path: target, content: await fs.promises.readFile(target, 'utf-8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: target, content: '' };
    throw error;
  }
}

function createDefaultPrompt(task, outputFile) {
  return `请只在当前工作目录内工作。

任务：
${task}

要求：
1. 先阅读当前目录中的输入文件。
2. 自主判断下一步需要做什么。
3. 将最终结果写入 ${outputFile}。
4. 不要访问当前工作目录外的文件。
5. 不要联网。
6. 最终回复简要说明处理动作和输出文件。`;
}

function compactText(value, maxLength = 300) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

// 识别 Pi 手动压缩在当前上下文无需处理时返回的正常结果。
function isCompactionNoopError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('nothing to compact') || message.includes('already compacted');
}

// 提取一条 Agent 消息中的完整文本内容。
function extractMessageText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .join('\n')
    .trim();
}

function extractAssistantText(messages = []) {
  const assistant = [...messages].reverse().find((message) => message?.role === 'assistant');
  return extractMessageText(assistant);
}

function getAssistantError(messages = []) {
  const assistant = [...messages].reverse().find((message) => message?.role === 'assistant');
  return assistant?.stopReason === 'error'
    ? restorePiErrorMessage(assistant.errorMessage || 'Pi Agent 模型请求失败')
    : '';
}

function getAssistantErrorDetails(messages = []) {
  const assistant = [...messages].reverse().find((message) => message?.role === 'assistant');
  if (!assistant || assistant.stopReason !== 'error') return null;
  return {
    stop_reason: assistant.stopReason,
    error_message: restorePiErrorMessage(assistant.errorMessage || 'Pi Agent 模型请求失败'),
    api: assistant.api || '',
    provider: assistant.provider || '',
    model: assistant.model || '',
    timestamp: assistant.timestamp || 0,
  };
}

function buildRetryPrompt(outputFile, error, attempt, maxRetries) {
  return `上一轮执行未通过程序校验或执行失败：${compactText(error?.message || error, 800)}

请继续使用当前会话和工作区，只做必要修复，并将最终结果写入 ${outputFile}。
这是第 ${attempt}/${maxRetries} 次自动修复机会。`;
}

function createRetrySummary(attempt, error, outputContent) {
  return {
    attempt,
    at: nowIso(),
    error: compactText(error?.message || error, 600),
    output_chars: String(outputContent || '').length,
  };
}

function createRuntimeDiagnostics(limit = 500) {
  const events = [];
  return {
    events,
    record(event, payload = {}) {
      events.push({ at: nowIso(), event, ...payload });
      if (events.length > limit) events.splice(0, events.length - limit);
    },
  };
}

function normalizeMonitorValue(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack || '' };
      return item;
    }));
  } catch {
    return String(value);
  }
}

function createPiRuntimeService({ app, configStore, aiService, isMonitorActive, onMonitorEvent, requestUserQuestion }) {
  const runtime = PI_RUNTIME;
  const runtimeId = PI_RUNTIME_ID;
  const runtimeName = PI_RUNTIME_NAME;
  let environment = preparePiEnvironment(app);
  const { layout } = environment;
  const diagnostics = createRuntimeDiagnostics(2000);
  const listeners = new Set();
  let phase = 'stopped';
  let healthy = false;
  let message = `${runtimeName} 未启动`;
  let updatedAt = nowIso();
  let lastHealthAt = '';
  let lastHealthError = '';
  let restartPending = false;
  let restartPendingReason = '';
  let proxy = null;
  let proxyInfo = null;
  let startPromise = null;
  let closePromise = null;
  let activeTask = null;
  let activeController = null;
  let statusTimer = null;
  let sdkVersion = '';

  // Pi 事件只在开发者监视器实际挂载时转换为 IPC 可传输数据。
  function emitMonitorEvent(event = {}) {
    if (!isMonitorActive?.()) return;
    try {
      onMonitorEvent?.({
        ...event,
        task_id: event.task_id || activeTask?.task_id || '',
        session_id: event.session_id || activeTask?.session_id || '',
        title: event.title || activeTask?.title || '',
        at: event.at || nowIso(),
      });
    } catch {}
  }

  function getActiveTaskSummary() {
    if (!activeTask) return null;
    const started = new Date(activeTask.started_at).getTime();
    const lastActivity = new Date(activeTask.last_activity_at).getTime();
    return {
      task_id: activeTask.task_id,
      session_id: activeTask.session_id || '',
      title: activeTask.title,
      stage: activeTask.stage,
      progress_text: activeTask.progress_text,
      started_at: activeTask.started_at,
      last_activity_at: activeTask.last_activity_at,
      last_progress_at: activeTask.last_progress_at,
      elapsed_seconds: Math.max(0, Math.floor((Date.now() - started) / 1000)),
      idle_seconds: Math.max(0, Math.floor((Date.now() - lastActivity) / 1000)),
      waiting_for_user: Boolean(activeTask.waiting_for_user),
      workspace_dir: activeTask.workspace_dir || '',
    };
  }

  function getStatus() {
    return {
      phase,
      healthy,
      message,
      updated_at: updatedAt,
      last_health_at: lastHealthAt,
      last_health_error: lastHealthError,
      restart_pending: restartPending,
      restart_pending_reason: restartPendingReason,
      active_task: getActiveTaskSummary(),
      queued_count: 0,
      queued_tasks: [],
      proxy: proxy?.getStatus?.() || { active: 0, queued: 0, limit: 0 },
      runtime_details: {
        sdk_version: sdkVersion,
        runtime_root: layout.runtimeRoot,
        workspace_dir: activeTask?.workspace_dir || layout.workspaceDir,
      },
    };
  }

  function emitStatus() {
    const status = getStatus();
    listeners.forEach((listener) => {
      try { listener(status); } catch {}
    });
  }

  function setPhase(nextPhase, nextMessage) {
    phase = nextPhase;
    healthy = ['starting', 'idle', 'running', 'restarting'].includes(nextPhase);
    message = nextMessage || message;
    updatedAt = nowIso();
    diagnostics.record('runtime.phase', { phase, message });
    emitStatus();
  }

  function touchActivity(event = {}) {
    if (!activeTask || event.task_token !== activeTask.task_token) return;
    const now = nowIso();
    if (event.activity !== false) activeTask.last_activity_at = now;
    if (event.visible !== false && event.message) {
      activeTask.stage = event.stage || activeTask.stage;
      activeTask.progress_text = event.message;
      activeTask.last_progress_at = now;
      message = event.message;
    }
    diagnostics.record(event.source || 'runtime.activity', event);
    try { activeTask.onActivity?.({ ...event, at: now }); } catch {}
    emitStatus();
  }

  // 同步持久 Agent 任务检查点，并通知所属业务任务落盘必要状态。
  function checkpointPersistentTask(partial = {}) {
    if (!activeTask?.persistent_task_key) return null;
    const updated = updatePersistentAgentTask(app, activeTask.persistent_task_key, partial);
    try { activeTask.onCheckpoint?.(updated.state); } catch {}
    return updated;
  }

  // 加载 Pi SDK 并启动本地 AI Proxy。
  async function ensureStarted() {
    if (proxy && phase !== 'unhealthy' && phase !== 'stopped' && phase !== 'closing') return proxyInfo;
    if (startPromise) return startPromise;
    const bootStartedAt = performance.now();
    startPromise = (async () => {
      setPhase(phase === 'unhealthy' ? 'restarting' : 'starting', `正在启动 ${runtimeName}`);
      const { codingAgent } = await loadPiModules();
      sdkVersion = codingAgent.VERSION || '';
      proxy = createAgentOpenAiProxy({
        app,
        aiService,
        runtime,
        normalRequestTimeoutMs: DEFAULT_NORMAL_REQUEST_TIMEOUT_MS,
        streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        diagnostics,
        onActivity: touchActivity,
        getActivityContext: () => activeTask ? {
          task_token: activeTask.task_token,
          task_id: activeTask.task_id,
          queue_scope_id: activeTask.queue_scope_id,
        } : null,
        verifyLoopback: true,
        loopbackHosts: ['127.0.0.1', '::1', 'localhost'],
      });
      proxyInfo = await proxy.start();
      lastHealthAt = nowIso();
      lastHealthError = '';
      setPhase(activeTask ? 'running' : 'idle', activeTask ? `${runtimeName} 正在执行任务` : `${runtimeName} 空闲`);
      if (!statusTimer) statusTimer = setInterval(() => { if (activeTask) emitStatus(); }, STATUS_TICK_MS);
      // 冷启动成本（Pi 模块加载 + 本地代理监听 + 回环探测）单独记录，命中复用时不走这条路径。
      perfTrace.record('agent', 'cold_boot', performance.now() - bootStartedAt);
      return proxyInfo;
    })();
    try {
      return await startPromise;
    } catch (error) {
      lastHealthError = error?.message || String(error);
      try { await proxy?.close?.(); } catch {}
      proxy = null;
      proxyInfo = null;
      setPhase('unhealthy', `${runtimeName} 启动失败`);
      throw error;
    } finally {
      startPromise = null;
    }
  }

  async function archiveWorkspace(taskId) {
    const taskDir = path.join(layout.tasksRoot, safeTaskSegment(taskId));
    const archivedWorkspace = path.join(taskDir, 'workspace');
    await fs.promises.rm(taskDir, { recursive: true, force: true });
    await fs.promises.mkdir(taskDir, { recursive: true });
    await fs.promises.cp(layout.workspaceDir, archivedWorkspace, { recursive: true });
    return { taskDir, archivedWorkspace };
  }

  // 普通任务结果已交付或诊断已读取后删除归档现场。
  async function deleteTaskArchive(taskId) {
    const taskDir = path.join(layout.tasksRoot, safeTaskSegment(taskId));
    await fs.promises.rm(taskDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }

  function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
  }

  async function writeJsonAsync(filePath, value) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
  }

  function subscribeSession(session, taskToken, diffEntries, modelRetryStats) {
    let streamedText = '';
    return session.subscribe((event) => {
      if (event.type === 'message_start' && event.message?.role === 'assistant') {
        streamedText = '';
      }
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        const delta = event.assistantMessageEvent.delta || '';
        streamedText += delta;
        if (isMonitorActive?.()) emitMonitorEvent({ type: 'assistant_delta', delta });
        return;
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const completedText = extractMessageText(event.message) || streamedText.trim();
        streamedText = '';
        if (isMonitorActive?.()) emitMonitorEvent({ type: 'assistant_end', text: completedText });
        touchActivity({
          task_token: taskToken,
          stage: 'assistant_text',
          message: compactText(completedText, 200),
          source: 'pi.message',
          visible: Boolean(completedText),
          activity: true,
        });
        return;
      }
      if (event.type === 'tool_execution_start') {
        if (isMonitorActive?.()) {
          emitMonitorEvent({
            type: 'tool_start',
            tool_call_id: event.toolCallId || '',
            tool_name: event.toolName || '',
            args: normalizeMonitorValue(event.args),
          });
        }
        touchActivity({
          task_token: taskToken,
          stage: 'tool',
          message: `正在调用工具：${event.toolName}`,
          source: 'pi.tool.start',
          visible: true,
          activity: true,
          meta: { tool: event.toolName },
        });
        return;
      }
      if (event.type === 'tool_execution_update') {
        if (isMonitorActive?.()) {
          emitMonitorEvent({
            type: 'tool_update',
            tool_call_id: event.toolCallId || '',
            tool_name: event.toolName || '',
            partial_result: normalizeMonitorValue(event.partialResult),
          });
        }
        touchActivity({ task_token: taskToken, stage: 'tool', message: '', source: 'pi.tool.update', visible: false, activity: true });
        return;
      }
      if (event.type === 'tool_execution_end') {
        const details = event.result?.details || {};
        if (details.diff || details.patch) diffEntries.push({ tool: event.toolName, diff: details.diff || '', patch: details.patch || '' });
        if (isMonitorActive?.()) {
          emitMonitorEvent({
            type: 'tool_end',
            tool_call_id: event.toolCallId || '',
            tool_name: event.toolName || '',
            result: normalizeMonitorValue(event.result),
            is_error: Boolean(event.isError),
          });
        }
        touchActivity({
          task_token: taskToken,
          stage: 'tool',
          message: `${event.toolName} ${event.isError ? '执行失败' : '执行完成'}`,
          source: 'pi.tool.end',
          visible: true,
          activity: true,
          meta: { tool: event.toolName, is_error: Boolean(event.isError) },
        });
        return;
      }
      if (event.type === 'auto_retry_start') {
        modelRetryStats.count += 1;
        const errorMessage = restorePiErrorMessage(event.errorMessage || '模型服务暂时不可用');
        const delaySeconds = Math.max(0, Math.round(Number(event.delayMs || 0) / 1000));
        const retryMessage = `模型请求遇到临时错误，${delaySeconds} 秒后进行第 ${event.attempt}/${event.maxAttempts} 次重试：${compactText(errorMessage, 160)}`;
        if (isMonitorActive?.()) {
          emitMonitorEvent({
            type: 'auto_retry_start',
            attempt: event.attempt,
            maximum: event.maxAttempts,
            delay_ms: event.delayMs,
            message: errorMessage,
            model_retry_count: modelRetryStats.count,
          });
        }
        touchActivity({
          task_token: taskToken,
          stage: 'model_retry',
          message: retryMessage,
          source: 'pi.auto-retry.start',
          visible: true,
          activity: true,
          meta: { attempt: event.attempt, maximum: event.maxAttempts, delay_ms: event.delayMs, error: errorMessage, model_retry_count: modelRetryStats.count },
        });
        return;
      }
      if (event.type === 'auto_retry_end') {
        const finalError = restorePiErrorMessage(event.finalError || '');
        const retryMessage = event.success
          ? `模型请求已恢复，第 ${event.attempt} 次重试成功`
          : `模型请求重试 ${event.attempt} 次后仍失败${finalError ? `：${compactText(finalError, 160)}` : ''}`;
        if (isMonitorActive?.()) {
          emitMonitorEvent({
            type: 'auto_retry_end',
            attempt: event.attempt,
            success: Boolean(event.success),
            final_error: finalError,
            message: retryMessage,
            model_retry_count: modelRetryStats.count,
          });
        }
        touchActivity({
          task_token: taskToken,
          stage: 'model_retry',
          message: retryMessage,
          source: 'pi.auto-retry.end',
          visible: true,
          activity: true,
          meta: { attempt: event.attempt, success: Boolean(event.success), error: finalError, model_retry_count: modelRetryStats.count },
        });
        return;
      }
      if (['agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end', 'compaction_start', 'compaction_end'].includes(event.type)) {
        if (isMonitorActive?.()) emitMonitorEvent({ type: event.type });
        touchActivity({ task_token: taskToken, stage: event.type, message: '', source: `pi.${event.type}`, visible: false, activity: true });
      }
    });
  }

  function bindAbort(parentSignal, controller, getSession) {
    const abortSession = () => {
      const session = getSession();
      try { session?.abortCompaction?.(); } catch {}
      void session?.abort?.().catch(() => undefined);
    };
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(resolveAgentAbortReason(parentSignal));
      abortSession();
    };
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener?.('abort', abort, { once: true });
    const sessionAbort = () => abortSession();
    controller.signal.addEventListener('abort', sessionAbort, { once: true });
    return () => {
      parentSignal?.removeEventListener?.('abort', abort);
      controller.signal.removeEventListener('abort', sessionAbort);
    };
  }

  function startWatchdog(controller, timeoutMs, taskToken) {
    return setInterval(() => {
      if (!activeTask || activeTask.waiting_for_user) return;
      const idleMs = Date.now() - new Date(activeTask.last_activity_at).getTime();
      if (idleMs < timeoutMs || controller.signal.aborted) return;
      const error = new Error('Pi Agent 长时间无进展，已停止本轮任务');
      error.code = 'AGENT_STALLED';
      touchActivity({ task_token: taskToken, stage: 'stalled', message: error.message, source: 'pi.watchdog', visible: true, activity: false });
      controller.abort(error);
    }, 2000);
  }

  // 暂停当前工具调用并等待 Renderer 返回用户答案。
  async function waitForUserQuestion(request, signal, taskToken) {
    if (!activeTask || activeTask.task_token !== taskToken) {
      throw new Error('当前 Agent 任务已结束，无法继续提问');
    }
    const workflowStage = activeTask.workflow_stage;
    activeTask.waiting_for_user = true;
    touchActivity({
      task_token: taskToken,
      stage: 'waiting_for_user',
      message: 'Agent 正在等待您的回答',
      source: 'pi.user-question.waiting',
      visible: true,
      activity: true,
    });
    let answered = false;
    try {
      const result = await requestUserQuestion({
        ...request,
        task_id: activeTask.task_id,
        session_id: activeTask.session_id || '',
        task_title: activeTask.title,
      }, signal);
      if (activeTask?.task_token === taskToken) {
        activeTask.user_question_answers.push({
          workflow_stage: workflowStage,
          question: String(request.question || ''),
          answer: String(result.answer || ''),
          selected_option: String(result.selected_option || ''),
          is_custom: Boolean(result.is_custom),
          answered_at: nowIso(),
        });
      }
      answered = true;
      return result;
    } finally {
      if (activeTask?.task_token === taskToken) {
        activeTask.waiting_for_user = false;
        touchActivity({
          task_token: taskToken,
          stage: answered ? 'running' : activeTask.stage,
          message: answered ? '已收到回答，Agent 正在继续执行' : '',
          source: 'pi.user-question.settled',
          visible: answered,
          activity: true,
        });
      }
    }
  }

  // 在多阶段工作流中等待业务侧用户操作，期间不计入 Agent 无进展超时。
  async function waitForExternalUser(waiter, waitMessage, taskToken, waitState = {}) {
    if (!activeTask || activeTask.task_token !== taskToken) {
      throw new Error('当前 Agent 任务已结束，无法继续等待用户操作');
    }
    activeTask.waiting_for_user = true;
    touchActivity({
      task_token: taskToken,
      stage: 'waiting_for_user',
      message: waitMessage || 'Agent 正在等待您的操作',
      source: 'pi.workflow.waiting',
      visible: true,
      activity: true,
    });
    const signal = activeController?.signal;
    let onAbort;
    try {
      const result = await new Promise((resolve, reject) => {
        onAbort = () => reject(signal?.reason || new Error('Agent 任务已取消'));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener?.('abort', onAbort, { once: true });
        Promise.resolve(waiter).then(resolve, reject);
      });
      return result;
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
      if (activeTask?.task_token === taskToken) {
        activeTask.waiting_for_user = false;
        touchActivity({
          task_token: taskToken,
          stage: 'running',
          message: '已收到用户操作，Agent 正在继续执行',
          source: 'pi.workflow.resumed',
          visible: true,
          activity: true,
        });
      }
    }
  }

  // 执行单个 Pi Agent 任务，并保持业务输出协议一致。
  async function runTask(payload = {}) {
    if (activeTask) throw new Error(`${runtimeName} 正在执行其他任务`);
    const taskId = payload.task_id || crypto.randomUUID();
    const title = payload.title || '易标智能体任务';
    const outputFile = payload.output_file || 'agent-result.md';
    const timeoutMs = normalizeTimeoutMs(payload.timeout_ms);
    const maxRetries = normalizeMaxRetries(payload.max_retries);
    const retryAttempts = [];
    const modelRetryStats = { count: 0 };
    const taskToken = crypto.randomUUID();
    const startedAt = nowIso();
    const persistentConfig = payload.persistent_task && typeof payload.persistent_task === 'object'
      ? payload.persistent_task
      : null;
    let persistentTask = null;
    if (persistentConfig?.task_key) {
      persistentTask = persistentConfig.mode === 'resume'
        ? loadPersistentAgentTask(app, persistentConfig.task_key)
        : createPersistentAgentTask(app, persistentConfig.task_key, {
          run_id: taskId,
          title,
          status: 'running',
          phase: payload.initial_stage || 'initial',
          agent_connection: 'running',
          session_file: '',
        });
      if (!persistentTask) throw new Error('持久 Agent 任务不存在，请重新执行当前业务任务');
      if (persistentTask.state.run_id !== taskId) throw new Error('持久 Agent 任务与当前业务任务不匹配，请重新执行当前业务任务');
      if (persistentConfig.mode === 'resume' && !persistentTask.state.session_file) {
        throw new Error('持久 Agent Session 不存在，请重新执行当前业务任务');
      }
    }
    const transientTaskDir = path.join(layout.tasksRoot, safeTaskSegment(taskId));
    const workspaceDir = persistentTask?.paths.workspaceDir || path.join(transientTaskDir, 'workspace');
    const persistentSessionFile = persistentConfig?.mode === 'resume'
      ? getPersistentAgentSessionPath(app, persistentConfig.task_key, persistentTask.state.session_file)
      : '';
    activeTask = {
      task_id: taskId,
      session_id: '',
      title,
      stage: payload.initial_stage || persistentTask?.state.phase || 'starting',
      progress_text: `正在启动 ${runtimeName}`,
      started_at: startedAt,
      last_activity_at: startedAt,
      last_progress_at: startedAt,
      task_token: taskToken,
      onActivity: payload.onActivity,
      onCheckpoint: payload.onCheckpoint,
      waiting_for_user: false,
      user_question_answers: [],
      workspace_dir: workspaceDir,
      persistent_task_key: persistentConfig?.task_key || '',
      queue_scope_id: String(payload.queue_scope_id || payload.queueScopeId || '').trim(),
      stage_index: Number(payload.initial_stage_index || persistentTask?.state.stage_index || 0),
      workflow_stage: payload.initial_stage || persistentTask?.state.phase || 'starting',
    };
    let prompt = payload.prompt || createDefaultPrompt(payload.task || '请分析当前输入文件并输出结果。', outputFile);
    if (isMonitorActive?.()) {
      emitMonitorEvent({
        type: 'task_start',
        task_id: taskId,
        title,
        workspace_dir: workspaceDir,
        stage_index: activeTask.stage_index,
        workflow_stage: activeTask.workflow_stage,
        prompt,
        output_file: outputFile,
        files: (payload.files || []).map((file) => ({ path: String(file.path || ''), content: String(file.content || '') })),
      });
    }
    activeController = new AbortController();
    setPhase('running', activeTask.progress_text);
    let session = null;
    let sessionSnapshot = null;
    let unsubscribe = null;
    let archivedWorkspace = '';
    let retainTransientWorkspace = false;
    const diffEntries = [];
    const cleanupAbort = bindAbort(payload.signal, activeController, () => session);
    const watchdog = startWatchdog(activeController, timeoutMs, taskToken);

    try {
      if (!persistentTask) await clearDirectoryAsync(workspaceDir);
      await perfTrace.time('agent', 'write_workspace', () => writeWorkspaceFilesAsync(workspaceDir, payload.files || []));
      await ensureStarted();
      const created = await perfTrace.time('agent', 'session_create', () => createPiSession({
        workspaceDir,
        sessionsDir: persistentTask?.paths.sessionsDir,
        sessionFile: persistentSessionFile,
        environment,
        proxyInfo,
        config: configStore.load(),
        timeoutMs: DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS,
        jsonValidationSchemas: payload.json_validation_schemas,
        requestUserQuestion: (request, signal) => waitForUserQuestion(request, signal, taskToken),
        reportTaskFailure: (reason) => {
          const error = new Error(String(reason || '').trim() || 'Agent 无法继续当前任务');
          error.code = AGENT_REPORTED_FAILURE_CODE;
          if (!activeController.signal.aborted) activeController.abort(error);
        },
        openXmlTool: payload.open_xml_tool,
      }));
      session = created.session;
      sessionSnapshot = created.snapshot;
      activeTask.session_id = session.sessionId || '';
      try {
        payload.onSessionStarted?.({
          task_id: taskId,
          task_key: persistentConfig?.task_key || '',
          session_id: activeTask.session_id,
          workspace_dir: workspaceDir,
        });
      } catch {}
      emitMonitorEvent({
        type: 'session_start',
        task_id: taskId,
        session_id: activeTask.session_id,
        title,
        workspace_dir: workspaceDir,
      });
      if (persistentTask) {
        persistentTask = checkpointPersistentTask({
          status: 'running',
          phase: activeTask.workflow_stage,
          agent_connection: 'running',
          session_file: created.sessionFile ? path.basename(created.sessionFile) : persistentTask.state.session_file || '',
        });
      }
      unsubscribe = subscribeSession(session, taskToken, diffEntries, modelRetryStats);
      let assistantText = '';
      let validationResult = null;
      let retryCount = 0;
      let stageIndex = Number(payload.initial_stage_index || persistentTask?.state.stage_index || 0);
      let stagePrompt = prompt;

      const createWorkflowMeta = () => ({
        stage: stageIndex,
        workflow_stage: activeTask.workflow_stage,
        task_id: taskId,
        title,
        output_file: outputFile,
        workspace_dir: workspaceDir,
        session_id: session.sessionId,
        user_question_answers: activeTask.user_question_answers.map((item) => ({ ...item })),
        readFile: async (filePath) => (await readOutputAsync(workspaceDir, filePath)).content,
        writeFiles: async (files) => writeWorkspaceFilesAsync(workspaceDir, files),
        waitForUser: (waiter, waitMessage, waitState) => waitForExternalUser(waiter, waitMessage, taskToken, waitState),
      });

      while (true) {
        let candidate = null;
        for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
          try {
            if (activeController.signal.aborted) throw activeController.signal.reason;
            activeTask.stage_index = stageIndex;
            checkpointPersistentTask({
              status: 'running',
              phase: activeTask.workflow_stage,
              agent_connection: 'running',
            });
            await perfTrace.time('agent', 'prompt_round', () => session.prompt(stagePrompt, { expandPromptTemplates: false }));
            if (activeController.signal.aborted) throw activeController.signal.reason;
            const assistantError = getAssistantError(session.messages);
            if (assistantError) {
              const error = new Error(assistantError);
              error.piAssistantError = getAssistantErrorDetails(session.messages);
              throw error;
            }
            assistantText = extractAssistantText(session.messages);
            const output = await readOutputAsync(workspaceDir, outputFile);
            checkpointPersistentTask({
              status: 'running',
              phase: activeTask.workflow_stage,
              agent_connection: 'running',
              session_file: session.sessionFile ? path.basename(session.sessionFile) : persistentTask?.state.session_file || '',
            });
            candidate = {
              success: true,
              runtime_id: runtimeId,
              task_id: taskId,
              title,
              output_file: outputFile,
              output_content: output.content,
              assistant_text: assistantText,
              session_id: session.sessionId,
              retry_count: retryAttempts.length,
              retry_attempts: [...retryAttempts],
              model_retry_count: modelRetryStats.count,
            };
            if (typeof payload.validateOutput === 'function') {
              try {
                validationResult = await payload.validateOutput(candidate, {
                  attempt: attemptIndex + 1,
                  stage: stageIndex,
                  max_retries: maxRetries,
                  task_id: taskId,
                  title,
                  output_file: outputFile,
                  workspace_dir: workspaceDir,
                  session_id: session.sessionId,
                  retry_attempts: [...retryAttempts],
                });
              } catch (validationError) {
                if (validationError && typeof validationError === 'object') {
                  validationError.agentValidationFailed = true;
                }
                throw validationError;
              }
            }
            retryCount = retryAttempts.length;
            break;
          } catch (error) {
            if (activeController.signal.aborted) throw activeController.signal.reason || error;
            if (attemptIndex >= maxRetries) throw error;
            const output = await readOutputAsync(workspaceDir, outputFile);
            retryAttempts.push(createRetrySummary(retryAttempts.length + 1, error, output.content));
            retryCount = retryAttempts.length;
            touchActivity({
              task_token: taskToken,
              stage: 'retry',
              message: `${runtimeName} 正在自动修复：${compactText(error?.message || error, 160)}`,
              source: 'pi.retry',
              visible: true,
              activity: true,
            });
            stagePrompt = buildRetryPrompt(outputFile, error, attemptIndex + 1, maxRetries);
            emitMonitorEvent({
              type: 'retry',
              task_id: taskId,
              title,
              attempt: retryCount,
              maximum: maxRetries,
              message: compactText(error?.message || error, 600),
              prompt: stagePrompt,
            });
          }
        }

        if (typeof payload.continueTask !== 'function') break;
        const completedStageIndex = stageIndex;
        const completedWorkflowStage = activeTask.workflow_stage;
        const continuation = await payload.continueTask(candidate, createWorkflowMeta());
        if (!continuation || continuation.complete === true || !continuation.prompt) break;
        emitMonitorEvent({
          type: 'task_output',
          task_id: taskId,
          title,
          workspace_dir: workspaceDir,
          stage_index: completedStageIndex,
          workflow_stage: completedWorkflowStage,
          output_file: candidate.output_file || outputFile,
          output_content: candidate.output_content || '',
        });
        const continuationFiles = Array.isArray(continuation.files) ? continuation.files : [];
        if (continuationFiles.length) {
          await writeWorkspaceFilesAsync(workspaceDir, continuationFiles);
        }
        stageIndex = Number.isFinite(Number(continuation.stage_index))
          ? Number(continuation.stage_index)
          : stageIndex + 1;
        activeTask.stage_index = stageIndex;
        const continuationStage = continuation.stage || `workflow_stage_${stageIndex}`;
        activeTask.workflow_stage = continuationStage;
        stagePrompt = continuation.prompt;
        if (continuation.compact_before_prompt === true) {
          const compactionStage = continuation.compaction_stage || `${continuationStage}_compaction`;
          activeTask.workflow_stage = compactionStage;
          checkpointPersistentTask({
            status: 'running',
            phase: compactionStage,
            agent_connection: 'running',
          });
          touchActivity({
            task_token: taskToken,
            stage: compactionStage,
            message: continuation.compaction_message || 'Agent 正在压缩上下文',
            source: 'pi.workflow.compaction',
            visible: true,
            activity: true,
          });
          try {
            await session.compact(continuation.compaction_instructions);
            if (activeController.signal.aborted) throw activeController.signal.reason;
            touchActivity({
              task_token: taskToken,
              stage: compactionStage,
              message: continuation.compaction_complete_message || 'Agent 上下文压缩完成',
              source: 'pi.workflow.compaction.completed',
              visible: true,
              activity: true,
            });
          } catch (error) {
            if (activeController.signal.aborted) throw activeController.signal.reason;
            if (!isCompactionNoopError(error)) throw error;
            touchActivity({
              task_token: taskToken,
              stage: compactionStage,
              message: '当前上下文无需压缩，继续执行下一阶段',
              source: 'pi.workflow.compaction.skipped',
              visible: true,
              activity: true,
            });
          }
          activeTask.workflow_stage = continuationStage;
          checkpointPersistentTask({
            status: 'running',
            phase: continuationStage,
            agent_connection: 'running',
          });
        }
        emitMonitorEvent({
          type: 'task_input',
          task_id: taskId,
          title,
          workspace_dir: workspaceDir,
          stage_index: stageIndex,
          workflow_stage: continuationStage,
          prompt: stagePrompt,
          files: continuationFiles.map((file) => ({ path: String(file.path || ''), content: String(file.content || '') })),
        });
        touchActivity({
          task_token: taskToken,
          stage: continuationStage,
          message: continuation.message || 'Agent 正在继续执行下一阶段',
          source: 'pi.workflow.continue',
          visible: Boolean(continuation.message),
          activity: true,
        });
      }

      const output = await readOutputAsync(workspaceDir, outputFile);
      archivedWorkspace = persistentTask ? workspaceDir : '';
      const result = {
        success: true,
        runtime_id: runtimeId,
        task_id: taskId,
        title,
        workspace_dir: archivedWorkspace,
        runtime_workspace_dir: workspaceDir,
        runtime_root: layout.runtimeRoot,
        output_file: outputFile,
        output_content: output.content,
        assistant_text: assistantText,
        diff: diffEntries,
        session_id: session.sessionId,
        retry_count: retryCount,
        retry_attempts: retryAttempts,
        model_retry_count: modelRetryStats.count,
        validation_result: validationResult,
        diagnostics: {
          session: sessionSnapshot,
          events: diagnostics.events.filter((event) => String(event.at || '') >= startedAt),
        },
      };
      if (persistentTask) {
        await writeJsonAsync(persistentTask.paths.resultFile, result);
        checkpointPersistentTask({
          status: 'running',
          phase: activeTask.workflow_stage,
          agent_connection: 'idle',
          session_file: session.sessionFile ? path.basename(session.sessionFile) : persistentTask.state.session_file || '',
        });
      }
      emitMonitorEvent({
        type: 'task_end',
        task_id: taskId,
        title,
        workspace_dir: archivedWorkspace,
        stage_index: activeTask.stage_index,
        workflow_stage: activeTask.workflow_stage,
        output_file: outputFile,
        output_content: output.content,
        assistant_text: assistantText,
        retry_count: retryCount,
        model_retry_count: modelRetryStats.count,
      });
      trackAgentRuntime(app, configStore, 'success', { modelRetryCount: modelRetryStats.count });
      return result;
    } catch (error) {
      if (activeController.signal.aborted && activeController.signal.reason instanceof Error) {
        error = activeController.signal.reason;
      }
      let output = { path: '', content: '' };
      try { output = await readOutputAsync(workspaceDir, outputFile); } catch {}
      if (persistentTask) {
        archivedWorkspace = workspaceDir;
        const current = loadPersistentAgentTask(app, persistentConfig.task_key);
        checkpointPersistentTask({
          status: error?.code === 'AGENT_DISCONNECTED' ? 'interrupted' : 'error',
          phase: activeTask.workflow_stage,
          agent_connection: 'idle',
          error: error?.message || String(error),
          session_file: session?.sessionFile ? path.basename(session.sessionFile) : current?.state?.session_file || '',
        });
      } else {
        archivedWorkspace = workspaceDir;
        retainTransientWorkspace = true;
      }
      if (error && typeof error === 'object') {
        error.agentRuntimeId = runtimeId;
        error.agentTaskId = taskId;
        error.agentTitle = title;
        error.agentWorkspaceDir = archivedWorkspace || workspaceDir;
        error.agentRuntimeRoot = layout.runtimeRoot;
        error.agentOutputFile = outputFile;
        error.agentOutputPath = archivedWorkspace ? path.join(archivedWorkspace, outputFile) : output.path;
        error.agentPartialOutput = output.content;
        error.agentPartialOutputChars = output.content.length;
        error.agentRetryAttempts = retryAttempts;
        error.agentModelRetryCount = modelRetryStats.count;
        error.agentDiagnostics = {
          session: sessionSnapshot,
          session_messages: Array.isArray(session?.messages) ? [...session.messages] : [],
          diff: [...diffEntries],
          events: diagnostics.events.filter((event) => String(event.at || '') >= startedAt),
          assistant_error: error.piAssistantError || null,
          error: serializeDiagnosticError(error),
        };
      }
      emitMonitorEvent({
        type: 'task_error',
        task_id: taskId,
        title,
        workspace_dir: archivedWorkspace || workspaceDir,
        stage_index: activeTask.stage_index,
        workflow_stage: activeTask.workflow_stage,
        output_file: outputFile,
        output_content: output.content,
        message: error?.message || String(error),
      });
      if (!isExpectedAgentInterruption(error)) {
        trackAgentRuntime(app, configStore, 'failed', { modelRetryCount: modelRetryStats.count });
      }
      throw error;
    } finally {
      unsubscribe?.();
      session?.dispose?.();
      cleanupAbort();
      clearInterval(watchdog);
      activeTask = null;
      activeController = null;
      if (!persistentTask && !retainTransientWorkspace) {
        try { await deleteTaskArchive(taskId); } catch {}
      }
      if (phase !== 'closing' && phase !== 'stopped') {
        if (restartPending) {
          await restart(restartPendingReason || 'config changed').catch((error) => {
            lastHealthError = error?.message || String(error);
            setPhase('unhealthy', `${runtimeName} 重启失败`);
          });
        } else {
          setPhase(proxy ? 'idle' : 'unhealthy', proxy ? `${runtimeName} 空闲` : `${runtimeName} 异常`);
        }
      }
    }
  }

  // 执行环境、模型、loopback、Pi SDK、工具和输出文件的完整自检，并尝试安全修复。
  async function warmup() {
    await ensureStarted();
    return getStatus();
  }

  // Pi 自检：实现见 piSelfCheck.cjs（原 3 个闭包函数下沉，行为不变）。
  const { runAgentLinkSelfCheck, executeSafeRepairActions, runSelfCheck } = createPiSelfCheck({
    app,
    configStore,
    aiService,
    ensureStarted,
    getStatus,
    restart,
    runTask,
    writeJson,
    state: {
      getRuntimeId: () => runtimeId,
      getRuntimeName: () => runtimeName,
      getDiagnostics: () => diagnostics,
      getEnvironment: () => environment,
      setEnvironment: (value) => { environment = value; },
      getLayout: () => layout,
      getProxyInfo: () => proxyInfo,
      getSdkVersion: () => sdkVersion,
      setSdkVersion: (value) => { sdkVersion = value; },
    },
  });

  async function restart(reason = 'manual') {
    if (activeTask) {
      restartPending = true;
      restartPendingReason = reason;
      emitStatus();
      return getStatus();
    }
    restartPending = false;
    restartPendingReason = '';
    setPhase('restarting', `正在重启 ${runtimeName}`);
    await proxy?.close?.();
    proxy = null;
    proxyInfo = null;
    await ensureStarted();
    return getStatus();
  }

  function handleConfigChanged(nextConfig = {}, previousConfig = {}) {
    if (Number(nextConfig.context_length_limit || 0) !== Number(previousConfig.context_length_limit || 0)) {
      if (activeTask) {
        restartPending = true;
        restartPendingReason = 'context_length_limit changed';
        emitStatus();
      } else if (proxy) {
        void restart('context_length_limit changed').catch((error) => {
          lastHealthError = error?.message || String(error);
          setPhase('unhealthy', `${runtimeName} 重启失败`);
        });
      }
    }
  }

  function onStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      setPhase('closing', `正在关闭 ${runtimeName}`);
      if (activeController && !activeController.signal.aborted) {
        const error = new Error('Agent 服务正在关闭');
        error.code = 'AGENT_DISCONNECTED';
        activeController.abort(error);
      }
      if (startPromise) await startPromise.catch(() => undefined);
      await proxy?.close?.();
      proxy = null;
      proxyInfo = null;
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
      setPhase('stopped', `${runtimeName} 已停止`);
      healthy = false;
    })().finally(() => { closePromise = null; });
    return closePromise;
  }

  return {
    warmup,
    runTask,
    deleteTaskArchive,
    runSelfCheck,
    getStatus,
    restart,
    handleConfigChanged,
    onStatus,
    close,
  };
}

module.exports = {
  createPiRuntimeService,
};
