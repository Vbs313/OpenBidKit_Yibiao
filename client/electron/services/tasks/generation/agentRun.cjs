// Agent 子任务执行层：错误诊断、忙碌判定、实时进度透传、失败输出恢复与正文 Agent 调用。
//
// 该层原本是 runContentGenerationTask 内部的闭包；这里把状态与副作用显式注入，
// 自身不持有模块级状态，不接触任务编排，可单独测试。
//
// deps 约定：
//   agentService                                          Agent 服务（runTask 入口）
//   state.leaves / state.sections / state.logs            读取会被重新赋值的闭包变量
//   state.appendLog(message)                              追加一行任务日志
//   其余为任务运行时回调（进度、开发者日志、暂停、落盘）

const { progressFor } = require('./progress.cjs');
const { isPauseLikeError, createContentGenerationPausedError } = require('./taskRuntime.cjs');
const { normalizeNewlines } = require('./normalize.cjs');
const { textMetrics } = require('./textEdits.cjs');

function createAgentRun(deps) {
  const {
    agentService,

    publishTaskUpdate,
    statsSnapshot,
    writeDeveloperLog,
    pauseIfRequested,
    isPauseRequested,
  } = deps;
  const { state } = deps;

  function agentErrorDiagnostics(error) {
    return {
      error: error?.message || String(error || '未知错误'),
      name: error?.name || '',
      cause: error?.cause?.message || error?.cause?.code || '',
      stack: error?.stack || '',
      agent_runtime: error?.agentRuntimeId || '',
      agent_task_id: error?.agentTaskId || '',
      agent_title: error?.agentTitle || '',
      agent_workspace_dir: error?.agentWorkspaceDir || '',
      agent_runtime_root: error?.agentRuntimeRoot || '',
      agent_output_file: error?.agentOutputFile || '',
      agent_output_path: error?.agentOutputPath || '',
      agent_partial_output_chars: error?.agentPartialOutputChars || String(error?.agentPartialOutput || '').length,
      agent_validation_failed: Boolean(error?.agentValidationFailed),
      agent_retry_attempts: Array.isArray(error?.agentRetryAttempts) ? error.agentRetryAttempts : [],
      agent_diagnostics: error?.agentDiagnostics || {},
    };
  }

  function isAgentBusyResult(result) {
    return result?.status === 'busy' || result?.skipped === true;
  }

  function createAgentActivityProgressHandler(updateProgress, step, fallbackLabel) {
    let lastKey = '';
    return (event = {}) => {
      const message = String(event.message || '').trim();
      if (!message || event.visible === false) return;
      const key = `${event.stage || ''}:${message}`;
      if (key === lastKey) return;
      lastKey = key;
      state.appendLog(`Agent 实时进度：${message}`);
      updateProgress(step, message || fallbackLabel);
    };
  }

  async function runAgentTaskWithRecoveredOutput(payload, eventPrefix) {
    function normalizeAgentFilePath(value) {
      return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^(\.\/)+/, '').toLowerCase();
    }

    function findSeededOutputContent() {
      const outputPath = normalizeAgentFilePath(payload.output_file || '');
      if (!outputPath) {
        return null;
      }
      const seededOutput = (Array.isArray(payload.files) ? payload.files : [])
        .find((file) => normalizeAgentFilePath(file?.path) === outputPath);
      return seededOutput ? String(seededOutput.content || '') : null;
    }

    try {
      const result = await agentService.runTask(payload);
      if (isAgentBusyResult(result)) {
        writeDeveloperLog(`${eventPrefix}.agent.busy`, {
          message: result?.message || 'Agent 正在处理其他任务',
          active_task: result?.active_task || null,
        });
        return result;
      }
      writeDeveloperLog(`${eventPrefix}.agent.done`, {
        agent_runtime: result?.runtime_id || '',
        agent_task_id: result?.task_id || '',
        agent_session_id: result?.session_id || '',
        agent_workspace_dir: result?.workspace_dir || '',
        agent_runtime_root: result?.runtime_root || '',
        output_file: result?.output_file || '',
        output_metrics: textMetrics(result?.output_content || ''),
        agent_diagnostics: result?.diagnostics || {},
      });
      return result;
    } catch (error) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        throw error;
      }
      const diagnostics = agentErrorDiagnostics(error);
      writeDeveloperLog(`${eventPrefix}.agent.error`, diagnostics);
      if (error?.agentValidationFailed) {
        throw error;
      }
      const recoveredOutput = String(error?.agentPartialOutput || '').trim();
      if (!recoveredOutput) {
        throw error;
      }
      const seededOutputContent = findSeededOutputContent();
      if (seededOutputContent !== null
        && normalizeNewlines(recoveredOutput).trim() === normalizeNewlines(seededOutputContent).trim()) {
        writeDeveloperLog(`${eventPrefix}.output.recovered_rejected`, {
          ...diagnostics,
          reason: 'same_as_seeded_output',
          output_metrics: textMetrics(recoveredOutput),
        });
        throw error;
      }
      writeDeveloperLog(`${eventPrefix}.output.recovered`, {
        ...diagnostics,
        output_metrics: textMetrics(recoveredOutput),
      });
      return {
        success: true,
        recovered: true,
        runtime_id: error?.agentRuntimeId || '',
        task_id: error?.agentTaskId || '',
        title: error?.agentTitle || payload.title || 'Agent 任务',
        workspace_dir: error?.agentWorkspaceDir || '',
        runtime_root: error?.agentRuntimeRoot || '',
        output_file: error?.agentOutputFile || payload.output_file || '',
        output_content: recoveredOutput,
        assistant_text: '',
        diff: [],
        session_id: '',
        retry_count: diagnostics.agent_retry_attempts.length,
        retry_attempts: diagnostics.agent_retry_attempts,
        diagnostics: diagnostics.agent_diagnostics,
      };
    }
  }

  async function runContentAgentTask({ title, prompt, outputFile, files, eventPrefix, activityLabel, timeoutMs, startPauseMessage, resultPauseMessage, pausedLogMessage, validateOutput }) {
    if (!agentService?.runTask) {
      writeDeveloperLog(`${eventPrefix}.unavailable`, { title, output_file: outputFile });
      throw new Error(`Agent 服务尚未初始化，无法执行${title}`);
    }

    function updateContentAgentProgress(_step, label) {
      publishTaskUpdate({ status: 'running', progress: progressFor(state.leaves, state.sections), logs: state.logs, stats: statsSnapshot() });
    }

    const agentAbortController = new AbortController();
    let pauseWatcher = null;
    let pauseLogged = false;
    function abortAgentIfPauseRequested() {
      if (!isPauseRequested()) {
        return;
      }
      if (!pauseLogged) {
        pauseLogged = true;
        state.appendLog(`已请求暂停${title}，正在取消本轮 Agent 任务。`);
        updateContentAgentProgress(0, `正在取消${title}，继续后将重新执行`);
      }
      if (!agentAbortController.signal.aborted) {
        agentAbortController.abort(createContentGenerationPausedError());
      }
    }
    pauseWatcher = setInterval(abortAgentIfPauseRequested, 1000);

    try {
      abortAgentIfPauseRequested();
      pauseIfRequested(startPauseMessage || `正文生成已在${title}开始前暂停，本次 Agent 未启动；继续后将重新执行。`);
      const agentResult = await runAgentTaskWithRecoveredOutput({
        title,
        prompt,
        output_file: outputFile,
        files,
        timeout_ms: timeoutMs || 30 * 60 * 1000,
        max_retries: 1,
        signal: agentAbortController.signal,
        validateOutput: async (agentResult, context) => {
          const outputContent = String(agentResult?.output_content || '').trim();
          if (!outputContent) {
            throw new Error(`Agent 未返回 ${outputFile}`);
          }
          if (typeof validateOutput === 'function') {
            return validateOutput(agentResult, context);
          }
          return null;
        },
        onActivity: createAgentActivityProgressHandler(updateContentAgentProgress, 0, activityLabel || title),
      }, eventPrefix);
      if (isAgentBusyResult(agentResult)) {
        writeDeveloperLog(`${eventPrefix}.busy`, { active_task: agentResult?.active_task || null });
        throw new Error(`Agent 正在处理其他任务，无法执行${title}`);
      }
      pauseIfRequested(resultPauseMessage || `正文生成已在${title}结果回写前暂停，本次 Agent 输出未回写；继续后将重新执行。`);

      const outputContent = String(agentResult?.output_content || '').trim();
      if (!outputContent) {
        writeDeveloperLog(`${eventPrefix}.empty_output`, { agent_result: agentResult, output_file: outputFile });
        throw new Error(`Agent 未返回 ${outputFile}`);
      }
      return { agentResult, outputContent };
    } catch (error) {
      if (isPauseRequested() || isPauseLikeError(error)) {
        state.appendLog(pausedLogMessage || `${title}已暂停：本轮 Agent 已取消并清理，继续后将重新执行。`);
        writeDeveloperLog(`${eventPrefix}.paused`, {
          title,
          output_file: outputFile,
          error: error.message || String(error),
        });
        updateContentAgentProgress(0, `${title}已暂停，继续后将重新执行`);
        pauseIfRequested(`正文生成已在${title}阶段暂停，本次 Agent 已取消；继续后将重新执行。`);
      }
      throw error;
    } finally {
      if (pauseWatcher) clearInterval(pauseWatcher);
    }
  }

  return { agentErrorDiagnostics, isAgentBusyResult, createAgentActivityProgressHandler, runAgentTaskWithRecoveredOutput, runContentAgentTask };
}

module.exports = { createAgentRun };
