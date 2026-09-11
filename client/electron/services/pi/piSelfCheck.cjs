// Pi 自检：链路自检（SDK / 工具 / 模型 / 回环）、安全自动修复与自检报告组装。
//
// 该组原本是 createPiRuntimeService 内部的三个闭包（约 540 行）。
// 纯诊断助手早已在 piSelfCheckService.cjs；这里把运行时可变状态用 get/set 门面注入，
// 把「启动 / 重启 / 跑任务 / 写 JSON」等动作作为回调注入，自身不持有模块级状态。

const crypto = require('node:crypto');
const { createPiSelfCheckRun } = require('./piSelfCheckRun.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { getDeveloperLogsDir } = require('../../utils/paths.cjs');
const { preparePiEnvironment } = require('./piEnvironment.cjs');
const { loadPiModules } = require('./piSessionFactory.cjs');
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

const SELF_CHECK_OUTPUT_FILE = 'agent-self-check-result.json';
const SELF_CHECK_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['message', 'input', 'node'],
  additionalProperties: false,
  properties: {
    message: { const: 'YIBIAO_PI_AGENT_SELF_CHECK_OK' },
    input: { const: 'YIBIAO_PI_AGENT_SELF_CHECK_INPUT' },
    node: { const: 'YIBIAO_PI_NODE_OK' },
  },
};

function clearDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  });
}

function nowIso() {
  return new Date().toISOString();
}

function createPiSelfCheck(deps) {
  const {
    app,
    configStore,
    aiService,
    ensureStarted,
    getStatus,
    restart,
    runTask,
    writeJson,
    state,
  } = deps;
  const {
    getRuntimeId,
    getRuntimeName,
    getDiagnostics,
    getEnvironment,
    setEnvironment,
    getLayout,
    getProxyInfo,
    getSdkVersion,
    setSdkVersion,
  } = state;
async function runAgentLinkSelfCheck() {
    const taskCheckedAt = nowIso();
    const taskStartedAt = Date.now();
    try {
      const result = await runTask({
        task_id: `${getRuntimeId()}-agent-self-check-latest`,
        title: `${getRuntimeName()} 自检`,
        output_file: SELF_CHECK_OUTPUT_FILE,
        files: [{ path: 'self-check-input.txt', content: 'YIBIAO_PI_AGENT_SELF_CHECK_INPUT' }],
        prompt: `请完成以下自检：
1. 使用 read 工具读取 self-check-input.txt。
2. 使用 bash 工具执行 node -e "console.log('YIBIAO_PI_NODE_OK')"。
3. 使用 write 工具将 JSON 写入 ${SELF_CHECK_OUTPUT_FILE}，格式为 {"message":"YIBIAO_PI_AGENT_SELF_CHECK_OK","input":"YIBIAO_PI_AGENT_SELF_CHECK_INPUT","node":"YIBIAO_PI_NODE_OK"}。
4. 使用 json-validation 工具校验 ${SELF_CHECK_OUTPUT_FILE}。程序已预置 Schema，只传 file_path，不要传入 schema。
5. 不要访问当前工作区以外的文件。`,
        json_validation_schemas: { [SELF_CHECK_OUTPUT_FILE]: SELF_CHECK_OUTPUT_SCHEMA },
        timeout_ms: 5 * 60 * 1000,
        max_retries: 0,
      });
      const sessionSnapshot = result.diagnostics?.session || {};
      const snapshotValidation = validatePiSessionSnapshot(sessionSnapshot);
      const validationToolSucceeded = (result.diagnostics?.events || []).some((event) => (
        event.source === 'pi.tool.end'
        && event.meta?.tool === 'json-validation'
        && event.meta?.is_error === false
      ));
      let output = null;
      let outputValid = false;
      let outputMessage = '';
      try {
        output = JSON.parse(result.output_content || '{}');
        outputValid = output.message === 'YIBIAO_PI_AGENT_SELF_CHECK_OK'
          && output.input === 'YIBIAO_PI_AGENT_SELF_CHECK_INPUT'
          && output.node === 'YIBIAO_PI_NODE_OK';
        outputMessage = outputValid ? '输出内容符合预期' : 'Pi Agent 自检输出不符合预期';
      } catch (error) {
        outputMessage = `Pi Agent 自检输出不是合法 JSON：${error?.message || String(error)}`;
      }
      const success = snapshotValidation.resourcesValid
        && snapshotValidation.toolsValid
        && validationToolSucceeded
        && outputValid;
      return {
        success,
        task_completed: true,
        checked_at: taskCheckedAt,
        duration_ms: Date.now() - taskStartedAt,
        message: success
          ? 'Pi Agent 极简任务执行成功'
          : !validationToolSucceeded
            ? 'Pi Agent 未成功执行 json-validation 工具'
            : outputMessage || 'Pi Agent 极简任务未通过校验',
        session_id: result.session_id || '',
        workspace_dir: result.workspace_dir || getLayout().workspaceDir,
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_content: result.output_content || '',
        output_valid: outputValid,
        output_message: outputMessage,
        parsed_output: output,
        validation_tool_succeeded: validationToolSucceeded,
        session_snapshot: sessionSnapshot,
        snapshot_validation: snapshotValidation,
        retry_count: result.retry_count || 0,
        retry_attempts: result.retry_attempts || [],
        model_retry_count: result.model_retry_count || 0,
        diagnostics: {
          ...(result.diagnostics || {}),
          events: (result.diagnostics?.events || []).filter((event) => String(event.at || '') >= taskCheckedAt),
        },
        error: null,
      };
    } catch (error) {
      return {
        success: false,
        task_completed: false,
        checked_at: taskCheckedAt,
        duration_ms: Date.now() - taskStartedAt,
        message: error?.message || `${getRuntimeName()} 自检任务失败`,
        session_id: '',
        workspace_dir: error?.agentWorkspaceDir || getLayout().workspaceDir,
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_content: error?.agentPartialOutput || '',
        output_valid: false,
        output_message: '智能体任务失败，未执行输出校验',
        parsed_output: null,
        validation_tool_succeeded: false,
        session_snapshot: error?.agentDiagnostics?.session || {},
        snapshot_validation: validatePiSessionSnapshot(error?.agentDiagnostics?.session || {}),
        retry_count: error?.agentRetryAttempts?.length || 0,
        retry_attempts: error?.agentRetryAttempts || [],
        model_retry_count: error?.agentModelRetryCount || 0,
        diagnostics: {
          ...(error?.agentDiagnostics || {}),
          events: (error?.agentDiagnostics?.events || []).filter((event) => String(event.at || '') >= taskCheckedAt),
        },
        error: serializeDiagnosticError(error),
      };
    }
  }

async function executeSafeRepairActions(actionIds) {
    const allowed = new Map(SAFE_REPAIR_ACTIONS.map((item) => [item.id, item]));
    const requested = new Set((actionIds || []).filter((id) => allowed.has(id)));
    const order = [
      'apply-loopback-no-proxy',
      'rebuild-pi-tool-environment',
      'reset-pi-self-check-workspace',
      'restart-pi-runtime',
      'retry-pi-session',
    ];
    const actions = [];
    for (const id of order) {
      if (!requested.has(id)) continue;
      const meta = allowed.get(id);
      const startedAt = Date.now();
      try {
        let detail = null;
        if (id === 'apply-loopback-no-proxy') {
          detail = {
            process: ensureLoopbackNoProxy(process.env),
            pi_environment: ensureLoopbackNoProxy(getEnvironment().env),
          };
        } else if (id === 'rebuild-pi-tool-environment') {
          setEnvironment(preparePiEnvironment(app));
          detail = { runtime_root: getEnvironment().layout.runtimeRoot };
        } else if (id === 'reset-pi-self-check-workspace') {
          clearDirectory(getLayout().workspaceDir);
          detail = { workspace_dir: getLayout().workspaceDir };
        } else if (id === 'restart-pi-runtime') {
          await restart('Pi 自检安全自动修复');
          detail = { proxy_base_url: getProxyInfo()?.baseUrl || '' };
        } else if (id === 'retry-pi-session') {
          detail = { message: '将在修复动作完成后重新创建 Session' };
        }
        actions.push({
          id,
          label: meta.label,
          success: true,
          message: '执行成功',
          duration_ms: Date.now() - startedAt,
          detail,
        });
      } catch (error) {
        actions.push({
          id,
          label: meta.label,
          success: false,
          message: error?.message || String(error),
          duration_ms: Date.now() - startedAt,
          error: serializeDiagnosticError(error),
        });
      }
    }
    return actions;
  }

  const { runSelfCheck } = createPiSelfCheckRun({
    app,
    configStore,
    aiService,
    ensureStarted,
    getStatus,
    writeJson,
    getRuntimeId,
    getRuntimeName,
    getDiagnostics,
    getEnvironment,
    getLayout,
    getProxyInfo,
    getSdkVersion,
    setSdkVersion,
    nowIso,
    serializeDiagnosticError,
    validatePiSessionSnapshot,
    SELF_CHECK_OUTPUT_FILE,
    createPiSelfCheckSteps,
    getDeveloperLogsDir,
    createPiEnvironmentSnapshot,
    loadPiModules,
    runPiToolEnvironmentSelfCheck,
    runPiTextModelSelfCheck,
    runPiLoopbackSelfCheck,
    diagnosePiSelfCheck,
    analyzePiSelfCheckWithModel,
    summarizeTextModelConfig,
    createPiDiagnosticSections,
    runAgentLinkSelfCheck,
    executeSafeRepairActions,
  });
  return { runAgentLinkSelfCheck, executeSafeRepairActions, runSelfCheck };
}

module.exports = { createPiSelfCheck };
