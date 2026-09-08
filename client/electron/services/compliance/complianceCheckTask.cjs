const crypto = require('node:crypto');
const { normalizeInput } = require('./complianceCheckStore.cjs');
const { normalizeCheckIds, requiresModel } = require('./complianceCheckRegistry.cjs');

function appendLog(logs, message) {
  const normalized = Array.isArray(logs) ? logs.slice() : [];
  const text = String(message || '').trim();
  if (text && normalized.at(-1) !== text) normalized.push(text);
  return normalized.slice(-80);
}

// 只描述模型路由信息；Sidecar 协议不接受任何凭据字段，因此这里刻意不读取 api_key。
function buildModelConfig(aiService) {
  let config = {};
  try {
    config = aiService?.getConfig?.() || {};
  } catch {
    config = {};
  }
  const model = String(config.model_name || '').trim();
  const baseUrl = String(config.compliance_proxy_base_url || '').trim();
  const next = {};
  if (model) next.model = model;
  if (baseUrl) next.base_url = baseUrl;
  return Object.keys(next).length ? next : undefined;
}

async function runComplianceCheckTask({
  aiService,
  complianceCheckerService,
  workspaceStore,
  updateTask,
  checkpointTask,
  payload = {},
  taskControl,
}) {
  if (!complianceCheckerService) throw new Error('合规检查 Sidecar 服务尚未初始化');
  if (!workspaceStore) throw new Error('合规检查存储服务尚未初始化');

  const input = normalizeInput(payload.input || payload);
  if (!input.bid_file) throw new Error('请选择投标文件');
  const checks = normalizeCheckIds(payload.checks?.length ? payload.checks : input.checks);
  if (!checks.length) throw new Error('请至少选择一个合规检查项');
  const jobId = String(payload.job_id || payload.jobId || crypto.randomUUID()).trim();
  const modelConfig = requiresModel(checks) ? buildModelConfig(aiService) : undefined;
  let logs = ['正在启动合规检查 Sidecar。'];

  let currentTask = updateTask({
    status: 'running',
    progress: 5,
    logs,
    stats: { job_id: jobId, checks },
  }, { input, checkTask: undefined });
  currentTask = currentTask || {
    task_id: jobId,
    type: 'compliance-check',
    status: 'running',
    progress: 5,
    logs,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  workspaceStore.createJob({
    jobId,
    input: { ...input, checks, model_config: modelConfig },
    task: currentTask,
  });

  try {
    const report = await complianceCheckerService.runChecks({
      jobId,
      input: { ...input, checks },
      ...(modelConfig ? { modelConfig } : {}),
      checks,
      signal: taskControl?.signal,
      timeoutMs: Number(payload.timeout_ms || payload.timeoutMs || 120000),
      onProgress(event = {}) {
        const message = String(event.message || '').trim();
        logs = appendLog(logs, message || '合规检查执行中。');
        const progress = Number.isFinite(Number(event.progress))
          ? Math.max(5, Math.min(95, Number(event.progress)))
          : Math.max(5, Math.min(95, Number(currentTask.progress || 5) + 5));
        currentTask = updateTask({
          status: 'running',
          progress,
          logs,
          stats: { ...(currentTask.stats || {}), job_id: jobId, checks },
        });
      },
    });

    logs = appendLog(logs, '合规检查完成。');
    workspaceStore.saveReport(jobId, report);
    const finalTask = checkpointTask({
      status: 'success',
      progress: 100,
      logs,
      stats: {
        job_id: jobId,
        checks,
        result_count: Array.isArray(report.results) ? report.results.length : 0,
      },
    }, {
      input: { ...input, checks },
      lastReport: report,
    }).task;
    return { report, task: finalTask };
  } catch (error) {
    const message = error?.message || String(error);
    logs = appendLog(logs, `合规检查失败：${message}`);
    workspaceStore.updateJob(jobId, { status: 'error', progress: 100, error: message });
    checkpointTask({
      status: 'error',
      progress: 100,
      error: message,
      logs,
      stats: { job_id: jobId, checks },
    }, {
      input: { ...input, checks },
    });
    throw error;
  }
}

module.exports = {
  runComplianceCheckTask,
};
