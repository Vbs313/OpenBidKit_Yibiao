const crypto = require('node:crypto');

function now() {
  return new Date().toISOString();
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeInput(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const checks = Array.isArray(source.checks) && source.checks.length
    ? source.checks.map((item) => String(item || '').trim()).filter(Boolean)
    : ['pricing_arithmetic'];
  return {
    tender_file: String(source.tender_file || source.tenderFile || '').trim(),
    bid_file: String(source.bid_file || source.bidFile || '').trim(),
    project_metadata: source.project_metadata && typeof source.project_metadata === 'object' && !Array.isArray(source.project_metadata)
      ? source.project_metadata
      : {},
    checks,
  };
}

function initialState() {
  return {
    step: 'configure',
    input: normalizeInput({}),
    checkTask: undefined,
    lastReport: null,
  };
}

function createComplianceCheckStore({ db } = {}) {
  if (!db) throw new Error('合规检查数据库尚未初始化');

  let state = initialState();

  const selectLatestJob = db.prepare(`
    SELECT * FROM compliance_check_jobs
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `);
  const selectJob = db.prepare('SELECT * FROM compliance_check_jobs WHERE job_id = ?');
  const selectResult = db.prepare('SELECT result_json FROM compliance_check_results WHERE job_id = ?');
  const insertJob = db.prepare(`
    INSERT INTO compliance_check_jobs (job_id, status, progress, input_json, task_json, error, created_at, updated_at)
    VALUES (@job_id, @status, @progress, @input_json, @task_json, @error, @created_at, @updated_at)
    ON CONFLICT(job_id) DO UPDATE SET
      status = excluded.status,
      progress = excluded.progress,
      input_json = excluded.input_json,
      task_json = excluded.task_json,
      error = excluded.error,
      updated_at = excluded.updated_at
  `);
  const updateJobStatement = db.prepare(`
    UPDATE compliance_check_jobs
    SET status = @status, progress = @progress, task_json = @task_json, error = @error, updated_at = @updated_at
    WHERE job_id = @job_id
  `);
  const insertResult = db.prepare(`
    INSERT INTO compliance_check_results (job_id, version, status, severity, summary, metrics_json, result_json, created_at)
    VALUES (@job_id, @version, @status, @severity, @summary, @metrics_json, @result_json, @created_at)
  `);
  const deleteResults = db.prepare('DELETE FROM compliance_check_results WHERE job_id = ?');
  const deleteFindings = db.prepare('DELETE FROM compliance_check_findings WHERE job_id = ?');
  const insertFinding = db.prepare(`
    INSERT INTO compliance_check_findings (
      job_id, check_id, finding_id, code, title, message, severity, evidence, suggestion, location_json, sort_order
    ) VALUES (
      @job_id, @check_id, @finding_id, @code, @title, @message, @severity, @evidence, @suggestion, @location_json, @sort_order
    )
  `);
  const deleteJobs = db.prepare('DELETE FROM compliance_check_jobs');
  const markInterruptedJobs = db.prepare(`
    UPDATE compliance_check_jobs
    SET status = 'error', error = @error, updated_at = @updated_at
    WHERE status IN ('running', 'pausing')
  `);

  function buildStateFromRow(row, resultRow) {
    const input = normalizeInput(safeJsonParse(row.input_json, {}));
    const task = safeJsonParse(row.task_json, null);
    return {
      step: ['running', 'pausing'].includes(row.status) ? 'running' : 'done',
      input,
      checkTask: task || {
        task_id: row.job_id,
        type: 'compliance-check',
        status: row.status,
        progress: Number(row.progress || 0),
        logs: [],
        started_at: row.created_at,
        updated_at: row.updated_at,
        error: row.error || undefined,
        stats: { job_id: row.job_id, checks: input.checks },
      },
      lastReport: resultRow?.result_json ? safeJsonParse(resultRow.result_json, null) : null,
    };
  }

  function refreshState() {
    const row = selectLatestJob.get();
    if (!row) {
      state = initialState();
      return state;
    }
    state = buildStateFromRow(row, selectResult.get(row.job_id));
    return state;
  }

  function loadComplianceCheck() {
    return clone(refreshState());
  }

  function updateComplianceCheckWithoutReload(partial = {}) {
    const next = partial && typeof partial === 'object' ? partial : {};
    state = {
      ...state,
      ...next,
      input: next.input ? normalizeInput(next.input) : state.input,
      lastReport: Object.prototype.hasOwnProperty.call(next, 'lastReport') ? next.lastReport : state.lastReport,
    };
    return clone(state);
  }

  function saveInput(input = {}) {
    state = {
      ...state,
      step: 'configure',
      input: normalizeInput(input),
      checkTask: undefined,
      lastReport: null,
    };
    return clone(state);
  }

  function createJob({ jobId, input, task } = {}) {
    const normalizedJobId = String(jobId || crypto.randomUUID()).trim();
    const timestamp = now();
    const normalizedInput = normalizeInput(input);
    insertJob.run({
      job_id: normalizedJobId,
      status: task?.status || 'running',
      progress: Number(task?.progress || 0),
      input_json: JSON.stringify(normalizedInput),
      task_json: jsonOrNull(task),
      error: task?.error || null,
      created_at: task?.started_at || timestamp,
      updated_at: task?.updated_at || timestamp,
    });
    state = {
      step: 'running',
      input: normalizedInput,
      checkTask: task || {
        task_id: normalizedJobId,
        type: 'compliance-check',
        status: 'running',
        progress: 0,
        logs: [],
        started_at: timestamp,
        updated_at: timestamp,
        stats: { job_id: normalizedJobId, checks: normalizedInput.checks },
      },
      lastReport: null,
    };
    return { job_id: normalizedJobId, state: clone(state) };
  }

  function updateJob(jobId, patch = {}) {
    const row = selectJob.get(String(jobId || ''));
    if (!row) return null;
    const task = patch.task !== undefined ? patch.task : safeJsonParse(row.task_json, null);
    updateJobStatement.run({
      job_id: row.job_id,
      status: patch.status || row.status,
      progress: patch.progress === undefined ? Number(row.progress || 0) : Number(patch.progress || 0),
      task_json: jsonOrNull(task),
      error: patch.error === undefined ? row.error : patch.error,
      updated_at: patch.updated_at || now(),
    });
    if (state.checkTask?.task_id === row.job_id || state.input) {
      refreshState();
    }
    return clone(state);
  }

  const saveReportTransaction = db.transaction((jobId, report) => {
    const row = selectJob.get(String(jobId || ''));
    if (!row) throw new Error(`合规检查任务不存在: ${jobId}`);
    const timestamp = now();
    const results = Array.isArray(report?.results) ? report.results : [];
    const firstResult = results[0] || null;
    const finalStatus = report?.status === 'success' ? 'success' : 'error';
    const finalError = finalStatus === 'success' ? undefined : (report?.error?.message || '合规检查失败');
    const previousTask = safeJsonParse(row.task_json, null) || {
      task_id: row.job_id,
      type: 'compliance-check',
      logs: [],
      started_at: row.created_at,
    };
    const finalTask = {
      ...previousTask,
      status: finalStatus,
      progress: 100,
      error: finalError,
      updated_at: timestamp,
    };
    updateJobStatement.run({
      job_id: row.job_id,
      status: finalStatus,
      progress: 100,
      task_json: jsonOrNull(finalTask),
      error: finalError || null,
      updated_at: timestamp,
    });
    deleteFindings.run(row.job_id);
    deleteResults.run(row.job_id);
    insertResult.run({
      job_id: row.job_id,
      version: String(report?.version || '1.0'),
      status: String(report?.status || 'error'),
      severity: firstResult?.severity || null,
      summary: firstResult?.summary || null,
      metrics_json: jsonOrNull(firstResult?.metrics || null),
      result_json: JSON.stringify(report || {}),
      created_at: timestamp,
    });
    let sortOrder = 0;
    for (const result of results) {
      const findings = Array.isArray(result?.findings) ? result.findings : [];
      for (const finding of findings) {
        insertFinding.run({
          job_id: row.job_id,
          check_id: String(result?.check_id || ''),
          finding_id: String(finding?.id || `finding-${sortOrder + 1}`),
          code: String(finding?.code || ''),
          title: String(finding?.title || ''),
          message: String(finding?.message || ''),
          severity: String(finding?.severity || 'info'),
          evidence: String(finding?.evidence || ''),
          suggestion: String(finding?.suggestion || ''),
          location_json: jsonOrNull(finding?.location || null),
          sort_order: sortOrder,
        });
        sortOrder += 1;
      }
    }
  });

  function saveReport(jobId, report) {
    saveReportTransaction(jobId, report);
    refreshState();
    return clone(state.lastReport);
  }

  function getReport(jobId) {
    const result = selectResult.get(String(jobId || ''));
    return result?.result_json ? safeJsonParse(result.result_json, null) : null;
  }

  function clearComplianceCheck() {
    const clearTransaction = db.transaction(() => {
      db.prepare('DELETE FROM compliance_check_findings').run();
      db.prepare('DELETE FROM compliance_check_results').run();
      deleteJobs.run();
    });
    clearTransaction();
    state = initialState();
    return clone(state);
  }

  function recoverInterruptedJobs() {
    const timestamp = now();
    const result = markInterruptedJobs.run({
      error: '上次合规检查未完成，请重新运行。',
      updated_at: timestamp,
    });
    if (result.changes > 0) refreshState();
    return result.changes;
  }

  return {
    clearComplianceCheck,
    createJob,
    getReport,
    getState: () => clone(state),
    loadComplianceCheck,
    recoverInterruptedJobs,
    saveInput,
    saveReport,
    updateComplianceCheckWithoutReload,
    updateJob,
  };
}

module.exports = {
  createComplianceCheckStore,
  normalizeInput,
};

