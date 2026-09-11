// 自检主流程：从 piSelfCheck 工厂里整段搬出的 381 行运行逻辑。
// 工厂依赖、state 访问器与同目录助手全部由调用方注入——这里只负责流程，
// 不反向 require 工厂，避免新的循环依赖。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createPiSelfCheckRun(deps) {
  const {
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
  } = deps;

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

  return { runSelfCheck };
}

module.exports = { createPiSelfCheckRun };
