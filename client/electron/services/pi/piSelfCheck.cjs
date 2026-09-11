// Pi 自检：链路自检（SDK / 工具 / 模型 / 回环）、安全自动修复与自检报告组装。
//
// 该组原本是 createPiRuntimeService 内部的三个闭包（约 540 行）。
// 纯诊断助手早已在 piSelfCheckService.cjs；这里把运行时可变状态用 get/set 门面注入，
// 把「启动 / 重启 / 跑任务 / 写 JSON」等动作作为回调注入，自身不持有模块级状态。

const crypto = require('node:crypto');
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

async function runSelfCheck() {
    const checkedAt = nowIso();
    const startedAt = Date.now();
    const checkId = crypto.randomUUID();
    const steps = createPiSelfCheckSteps();
    const logDir = getDeveloperLogsDir(app, `${getRuntimeId()}-self-check`);
    const logFile = path.join(logDir, 'latest.json');
    let config = {};
    let environmentSnapshot = null;
    let modelCheck = null;
    let loopbackCheck = null;
    let toolCheck = null;
    let agentCheck = null;
    let diagnosis = null;
    let repair = null;
    let runtimeStarted = false;
    let runtimeStartError = null;
    let topLevelError = null;

    const setStep = (id, status, stepMessage) => {
      const step = steps.find((item) => item.id === id);
      if (!step) return;
      const timestamp = nowIso();
      if (status === 'running') {
        step.started_at = timestamp;
        step.started_ms = Date.now();
      } else {
        step.completed_at = timestamp;
        if (step.started_ms) step.duration_ms = Date.now() - step.started_ms;
      }
      step.status = status;
      step.message = stepMessage || '';
      step.updated_at = timestamp;
    };
    const skipPendingSteps = () => {
      steps.filter((step) => step.status === 'pending').forEach((step) => setStep(step.id, 'skipped', '因前置条件不足未执行'));
    };

    try {
      fs.mkdirSync(logDir, { recursive: true });
      getDiagnostics().record('self_check.start', { check_id: checkId });

      setStep('environment', 'running', '正在采集应用、系统、代理和模型配置');
      config = configStore.load();
      environmentSnapshot = createPiEnvironmentSnapshot(app, getLayout(), config);
      setStep('environment', 'success', '环境快照已采集');

      setStep('sdk', 'running', '正在加载 Pi SDK');
      try {
        const { codingAgent } = await loadPiModules();
        setSdkVersion(getSdkVersion() || codingAgent.VERSION || '');
        setStep('sdk', 'success', getSdkVersion() ? `Pi SDK ${getSdkVersion()}` : 'Pi SDK 已加载');
      } catch (error) {
        topLevelError = error;
        setStep('sdk', 'error', error?.message || String(error));
      }

      setStep('runtime', 'running', `正在启动 ${getRuntimeName()} AI Proxy`);
      try {
        await ensureStarted();
        runtimeStarted = true;
        setStep('runtime', 'success', `${getLayout().runtimeRoot}，Proxy=${getProxyInfo()?.baseUrl || '-'}`);
      } catch (error) {
        runtimeStartError = error;
        topLevelError = topLevelError || error;
        setStep('runtime', 'error', error?.message || String(error));
      }

      setStep('tools', 'running', '正在检查共享命令环境');
      try {
        toolCheck = runPiToolEnvironmentSelfCheck(getEnvironment());
        setStep('tools', toolCheck.success ? 'success' : 'error', toolCheck.summary);
      } catch (error) {
        topLevelError = topLevelError || error;
        toolCheck = { success: false, summary: error?.message || String(error), items: [], error: serializeDiagnosticError(error) };
        setStep('tools', 'error', toolCheck.summary);
      }

      modelCheck = await runPiTextModelSelfCheck(config, (probeId, status, probe) => {
        const stepId = `model-${probeId}`;
        const message = status === 'running'
          ? `正在执行${probe.label || '文本模型检测'}`
          : `${probe.message}，${probe.duration_ms} ms${probe.status ? `，HTTP ${probe.status}` : ''}`;
        setStep(stepId, status, message);
      });

      if (runtimeStarted) {
        setStep('loopback', 'running', '正在检测 TCP、原生 HTTP、全局 fetch 和认证模型路由');
        loopbackCheck = await runPiLoopbackSelfCheck(getProxyInfo());
        setStep('loopback', loopbackCheck.success ? 'success' : 'error', loopbackCheck.message);
      } else {
        loopbackCheck = {
          success: false,
          message: runtimeStartError?.message || 'Pi Runtime 未启动，无法执行 loopback 检测',
          blocked_by_system: runtimeStartError?.code === 'AGENT_PROXY_LOOPBACK_BLOCKED',
          startup_attempts: runtimeStartError?.loopbackAttempts || [],
          probes: {},
          error: serializeDiagnosticError(runtimeStartError),
        };
        setStep('loopback', loopbackCheck.blocked_by_system ? 'error' : 'skipped', loopbackCheck.message);
      }

      if (runtimeStarted) {
        setStep('agent', 'running', `正在执行 ${getRuntimeName()} 极简自检任务`);
        agentCheck = await runAgentLinkSelfCheck();
        setStep('agent', agentCheck.success ? 'success' : 'error', `${agentCheck.message}${agentCheck.session_id ? `，session_id=${agentCheck.session_id}` : ''}`);
      } else {
        agentCheck = { success: false, message: 'Pi Runtime 未启动，智能体任务未执行', session_snapshot: {}, output_valid: false, error: serializeDiagnosticError(topLevelError) };
        setStep('agent', 'skipped', agentCheck.message);
      }

      const sessionSnapshot = agentCheck.session_snapshot || {};
      const snapshotValidation = agentCheck.snapshot_validation || validatePiSessionSnapshot(sessionSnapshot);
      if (Object.keys(sessionSnapshot).length) {
        setStep('resources', snapshotValidation.resourcesValid ? 'success' : 'error', snapshotValidation.resourcesValid ? '仅加载易标内置工作区指令' : 'Pi 资源加载结果不符合配置');
      } else {
        setStep('resources', 'skipped', 'Session 未创建，无法校验资源加载');
      }
      if (agentCheck.output_valid) {
        setStep('output', 'success', agentCheck.output_message);
      } else {
        setStep('output', agentCheck.task_completed ? 'error' : 'skipped', agentCheck.output_message || '智能体任务失败，未执行输出校验');
      }

      const failedModelProbes = Object.values(modelCheck?.probes || {}).filter((probe) => probe?.success === false);
      if (agentCheck?.success && failedModelProbes.length) {
        failedModelProbes.forEach((probe) => {
          setStep(`model-${probe.id}`, 'warning', `${probe.message}，${probe.duration_ms} ms${probe.status ? `，HTTP ${probe.status}` : ''}；真实 Pi Agent 工具链路已通过`);
        });
      }

      const eventsBeforeDiagnosis = getDiagnostics().events.filter((event) => String(event.at || '') >= String(agentCheck?.checked_at || checkedAt));
      // 真实 Agent 端到端结果优先，独立模型探针只负责提供诊断信息。
      const initialSuccess = Boolean(
        runtimeStarted
        && toolCheck?.success
        && loopbackCheck?.success
        && agentCheck?.success
      );

      setStep('diagnosis', 'running', initialSuccess ? '正在生成自检结论' : '正在执行规则诊断和文本模型分析');
      if (initialSuccess) {
        const hasModelProbeWarning = failedModelProbes.length > 0;
        diagnosis = {
          resolved: true,
          final_summary: hasModelProbeWarning
            ? 'Pi Agent 端到端链路正常，但独立文本模型探针存在非关键警告。'
            : 'Pi SDK、当前文本模型、loopback、工具、资源和输出链路均正常。',
          rules: {
            source: 'rules',
            category: hasModelProbeWarning ? 'model-probe-warning' : 'normal',
            summary: hasModelProbeWarning ? '真实 Pi Agent 工具链路已通过，模型探针警告不影响使用' : '未发现异常',
            confidence: 'high',
            evidence: hasModelProbeWarning ? failedModelProbes.map((probe) => probe.message || `${probe.label}失败`) : [],
            recommended_action_ids: [],
          },
          ai: null,
        };
      } else {
        const rules = diagnosePiSelfCheck({
          modelCheck,
          loopbackCheck,
          toolCheck,
          agentCheck,
          events: eventsBeforeDiagnosis,
          error: agentCheck?.error || topLevelError,
        });
        const configuredProbe = modelCheck?.probes?.[modelCheck?.configured_mode];
        const ai = configuredProbe?.success
          ? await analyzePiSelfCheckWithModel(aiService, {
            rules,
            model_check: modelCheck,
            loopback_check: loopbackCheck,
            tool_check: { success: toolCheck?.success, summary: toolCheck?.summary },
            agent_check: {
              success: agentCheck?.success,
              message: agentCheck?.message,
              output_valid: agentCheck?.output_valid,
              snapshot_validation: agentCheck?.snapshot_validation,
              error: agentCheck?.error,
            },
            events: eventsBeforeDiagnosis,
          })
          : null;
        diagnosis = {
          resolved: false,
          rules,
          ai,
          final_summary: rules.category === 'loopback-blocked'
            ? rules.summary
            : ai?.success && ai.result?.summary ? ai.result.summary : rules.summary,
        };
      }
      setStep('diagnosis', 'success', diagnosis.final_summary);

      if (initialSuccess) {
        setStep('repair', 'skipped', '自检正常，无需修复');
        setStep('recheck', 'skipped', '未执行修复，无需复检');
        repair = { attempted: false, success: true, actions: [], recheck: null };
      } else {
        const configuredProbe = modelCheck?.probes?.[modelCheck?.configured_mode];
        const repairableCategory = !['text-model', 'tool-calling', 'loopback-blocked'].includes(diagnosis.rules?.category);
        const requestedActions = configuredProbe?.success && repairableCategory
          ? [...new Set([
            ...(diagnosis.rules?.recommended_action_ids || []),
            ...(diagnosis.ai?.result?.recommended_action_ids || []),
          ])]
          : [];
        if (!requestedActions.length) {
          repair = { attempted: false, success: false, actions: [], recheck: null };
          setStep('repair', 'skipped', diagnosis.rules?.category === 'loopback-blocked'
            ? '系统层 loopback 被阻断，安全自动修复不会修改系统网络策略'
            : configuredProbe?.success ? '没有匹配到可执行的安全修复动作' : '文本模型检测未通过，不执行自动修复');
          setStep('recheck', 'skipped', '未执行自动修复');
        } else {
          setStep('repair', 'running', `准备执行 ${requestedActions.length} 个内置安全修复动作`);
          const actions = await executeSafeRepairActions(requestedActions);
          const actionSuccess = actions.every((action) => action.success);
          setStep('repair', actionSuccess ? 'success' : 'error', actionSuccess ? '安全修复动作执行完成' : '部分安全修复动作执行失败');

          setStep('recheck', 'running', '正在重新检测工具、loopback 和 Pi Agent');
          const recheckTool = requestedActions.includes('rebuild-pi-tool-environment')
            ? runPiToolEnvironmentSelfCheck(getEnvironment())
            : toolCheck;
          const recheckLoopback = getProxyInfo() ? await runPiLoopbackSelfCheck(getProxyInfo()) : loopbackCheck;
          const recheckAgent = getProxyInfo() ? await runAgentLinkSelfCheck() : agentCheck;
          const recheckSuccess = Boolean(
            actionSuccess
            && recheckTool?.success
            && recheckLoopback?.success
            && recheckAgent?.success
          );
          repair = {
            attempted: true,
            success: recheckSuccess,
            requested_action_ids: requestedActions,
            actions,
            before: {
              tool_check: toolCheck,
              loopback_check: loopbackCheck,
              agent_check: agentCheck,
            },
            recheck: {
              success: recheckSuccess,
              tool_check: recheckTool,
              loopback_check: recheckLoopback,
              agent_check: recheckAgent,
            },
          };
          setStep('recheck', recheckSuccess ? 'success' : 'error', recheckSuccess ? '自动修复后复检通过' : '自动修复后复检仍未通过');
          if (recheckSuccess) {
            diagnosis.resolved = true;
            diagnosis.final_summary = `已定位并自动修复：${diagnosis.final_summary}`;
          } else {
            const postRepairRules = diagnosePiSelfCheck({
              modelCheck,
              loopbackCheck: recheckLoopback,
              toolCheck: recheckTool,
              agentCheck: recheckAgent,
              events: getDiagnostics().events.filter((event) => String(event.at || '') >= String(recheckAgent?.checked_at || checkedAt)),
              error: recheckAgent?.error,
            });
            diagnosis.post_repair_rules = postRepairRules;
            diagnosis.final_summary = postRepairRules.summary;
          }
        }
      }

      const finalAgentCheck = repair?.recheck?.agent_check || agentCheck;
      const finalSessionSnapshot = finalAgentCheck?.session_snapshot || agentCheck?.session_snapshot || {};
      const finalSuccess = initialSuccess || Boolean(repair?.success);
      getDiagnostics().record('self_check.end', { check_id: checkId, success: finalSuccess, repaired: Boolean(repair?.attempted && repair?.success) });
      const currentEvents = getDiagnostics().events.filter((event) => String(event.at || '') >= checkedAt);
      const conclusion = finalSuccess
        ? diagnosis?.final_summary || 'Pi SDK、当前文本模型、loopback、工具、资源和输出链路均正常。'
        : diagnosis?.final_summary || 'Pi Agent 自检失败。';
      const result = {
        report_version: 3,
        check_id: checkId,
        success: finalSuccess,
        repaired: Boolean(repair?.attempted && repair?.success),
        status: finalSuccess ? 'normal' : 'error',
        message: finalSuccess ? repair?.attempted ? `${getRuntimeName()} 已自动修复并通过自检` : `${getRuntimeName()} 自检正常` : runtimeStartError?.message || finalAgentCheck?.message || topLevelError?.message || `${getRuntimeName()} 自检失败`,
        checked_at: checkedAt,
        duration_ms: Date.now() - startedAt,
        log_dir: logDir,
        log_file: logFile,
        runtime_root: getLayout().runtimeRoot,
        workspace_dir: finalAgentCheck?.workspace_dir || getLayout().workspaceDir,
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_path: path.join(finalAgentCheck?.workspace_dir || getLayout().workspaceDir, SELF_CHECK_OUTPUT_FILE),
        output_content: finalAgentCheck?.output_content || '',
        conclusion,
        sdk_version: getSdkVersion(),
        model_config: summarizeTextModelConfig(config),
        model_check: modelCheck,
        environment: environmentSnapshot,
        loopback_check: repair?.recheck?.loopback_check || loopbackCheck,
        tool_check: repair?.recheck?.tool_check || toolCheck,
        agent_check: finalAgentCheck,
        session_snapshot: finalSessionSnapshot,
        diagnosis,
        repair,
        steps: steps.map(({ started_ms: _startedMs, ...step }) => step),
        diagnostics: {
          events: currentEvents,
          error: finalSuccess ? null : finalAgentCheck?.error || serializeDiagnosticError(topLevelError),
          assistant_error: finalAgentCheck?.diagnostics?.assistant_error || null,
        },
        error: finalSuccess ? undefined : finalAgentCheck?.error || serializeDiagnosticError(topLevelError),
        detail_text: conclusion,
        runtime_status: getStatus(),
      };
      result.sections = createPiDiagnosticSections({
        layout: getLayout(),
        sdkVersion: getSdkVersion(),
        sessionSnapshot: finalSessionSnapshot,
        toolCheck: result.tool_check,
        modelCheck,
        agentCheck: finalAgentCheck,
        loopbackCheck: result.loopback_check,
        diagnosis,
        repair,
      });
      writeJson(logFile, result);
      return result;
    } catch (error) {
      topLevelError = error;
      const current = steps.find((step) => step.status === 'running');
      if (current) setStep(current.id, 'error', error?.message || String(error));
      skipPendingSteps();
      const result = {
        report_version: 3,
        check_id: checkId,
        success: false,
        repaired: false,
        status: 'error',
        message: error?.message || `${getRuntimeName()} 自检失败`,
        checked_at: checkedAt,
        duration_ms: Date.now() - startedAt,
        log_dir: logDir,
        log_file: logFile,
        runtime_root: getLayout().runtimeRoot,
        workspace_dir: getLayout().workspaceDir,
        output_file: SELF_CHECK_OUTPUT_FILE,
        output_path: path.join(getLayout().workspaceDir, SELF_CHECK_OUTPUT_FILE),
        conclusion: 'Pi 自检编排发生异常，完整错误链已写入报告。',
        sdk_version: getSdkVersion(),
        model_config: summarizeTextModelConfig(config),
        model_check: modelCheck,
        environment: environmentSnapshot,
        loopback_check: loopbackCheck,
        tool_check: toolCheck,
        agent_check: agentCheck,
        session_snapshot: agentCheck?.session_snapshot || {},
        diagnosis,
        repair,
        steps: steps.map(({ started_ms: _startedMs, ...step }) => step),
        diagnostics: {
          events: getDiagnostics().events.filter((event) => String(event.at || '') >= checkedAt),
          error: serializeDiagnosticError(error),
        },
        error: serializeDiagnosticError(error),
        detail_text: error?.stack || error?.message || String(error),
        runtime_status: getStatus(),
      };
      result.sections = createPiDiagnosticSections({
        layout: getLayout(),
        sdkVersion: getSdkVersion(),
        sessionSnapshot: result.session_snapshot,
        toolCheck,
        modelCheck,
        agentCheck,
        loopbackCheck,
        diagnosis,
        repair,
      });
      try { writeJson(logFile, result); } catch {}
      return result;
    }
  }
  return { runAgentLinkSelfCheck, executeSafeRepairActions, runSelfCheck };
}

module.exports = { createPiSelfCheck };
