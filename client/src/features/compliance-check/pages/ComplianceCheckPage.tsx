import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FloatingToolbar,
  ProgressBar,
  UploadBoard,
  UploadEmpty,
  UploadFilePill,
  UploadRow,
  useToast,
} from '../../../shared/ui';
import type {
  ComplianceCheckDefinition,
  ComplianceCheckInput,
  ComplianceCheckState,
  ComplianceCheckTaskState,
} from '../types';

const initialState: ComplianceCheckState = {
  step: 'configure',
  input: { tender_file: '', bid_file: '', project_metadata: {}, checks: [] },
  checkTask: undefined,
  lastReport: null,
};

function fileName(filePath?: string) {
  const value = String(filePath || '').trim();
  if (!value) return '';
  return value.split(/[\\/]/).pop() || value;
}

function isRunning(task?: ComplianceCheckTaskState) {
  return task?.status === 'running' || task?.status === 'pausing';
}

function severityLabel(severity?: string) {
  return ({ critical: '严重', major: '主要', minor: '提醒', info: '信息' } as Record<string, string>)[severity || ''] || '信息';
}

function statusLabel(status?: string) {
  return ({ pass: '通过', fail: '未通过', warning: '有提醒', error: '执行失败' } as Record<string, string>)[status || ''] || '待检查';
}

function ComplianceCheckPage() {
  const [state, setState] = useState<ComplianceCheckState>(initialState);
  const [definitions, setDefinitions] = useState<ComplianceCheckDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    let alive = true;
    Promise.all([window.yibiao.complianceCheck.loadState(), window.yibiao.complianceCheck.listChecks()])
      .then(([next, checks]) => {
        if (!alive) return;
        setDefinitions(checks);
        const enabled = Array.isArray(next.input?.checks) && next.input.checks.length
          ? next.input.checks
          : checks.map((item) => item.check_id);
        setState({ ...initialState, ...next, input: { ...next.input, checks: enabled } });
      })
      .catch((error) => { if (alive) showToast(error?.message || '读取合规检查状态失败', 'error'); })
      .finally(() => { if (alive) setLoading(false); });

    const unsubscribe = window.yibiao.tasks.onTaskEvent((event) => {
      if (event.task.type !== 'compliance-check') return;
      // 与废标项检查一致：整包状态优先，其次合并增量 patch（结果、进度都走 patch）。
      const full = event.complianceCheck;
      const patch = event.complianceCheckPatch;
      if (full || patch) {
        setState((current) => {
          const merged = { ...current, ...(full || {}), ...(patch || {}) };
          return { ...merged, input: { ...current.input, ...((full || patch || {}).input || {}) } };
        });
        return;
      }
      setState((current) => ({
        ...current,
        step: isRunning(event.task) ? 'running' : 'done',
        checkTask: event.task,
      }));
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, [showToast]);

  const task = state.checkTask;
  const report = state.lastReport;
  const running = isRunning(task);
  const progress = Math.max(0, Math.min(100, Number(task?.progress || (state.step === 'done' ? 100 : 0))));
  const selectedChecks = useMemo(
    () => (Array.isArray(state.input?.checks) && state.input.checks.length
      ? state.input.checks
      : definitions.map((item) => item.check_id)),
    [definitions, state.input?.checks],
  );
  const results = report?.results || [];
  const overallSeverity = useMemo(() => {
    if (results.some((item) => item.status === 'error' || item.severity === 'critical')) return 'critical';
    if (results.some((item) => item.status === 'fail')) return 'major';
    if (results.some((item) => item.status === 'warning')) return 'minor';
    return 'info';
  }, [results]);

  async function saveInput(nextInput: ComplianceCheckInput) {
    const next = await window.yibiao.complianceCheck.saveInput(nextInput);
    setState((current) => ({ ...current, ...next, step: 'configure' }));
  }

  const toggleCheck = useCallback(async (checkId: string) => {
    const current = selectedChecks.includes(checkId)
      ? selectedChecks.filter((item) => item !== checkId)
      : [...selectedChecks, checkId];
    if (!current.length) {
      showToast('至少需要保留一个检查项', 'info');
      return;
    }
    try {
      await saveInput({ ...state.input, checks: current });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存检查项失败', 'error');
    }
  }, [selectedChecks, showToast, state.input]);

  async function selectFile(role: 'tender' | 'bid') {
    try {
      const selected = await window.yibiao.complianceCheck.selectFile(role);
      if (selected.canceled || !selected.filePath) return;
      const key = role === 'tender' ? 'tender_file' : 'bid_file';
      await saveInput({ ...state.input, [key]: selected.filePath, checks: selectedChecks });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '选择文件失败', 'error');
    }
  }

  async function removeFile(role: 'tender' | 'bid') {
    const key = role === 'tender' ? 'tender_file' : 'bid_file';
    await saveInput({ ...state.input, [key]: '', checks: selectedChecks });
  }

  async function startCheck() {
    if (!state.input.bid_file) {
      showToast('请先选择投标文件', 'info');
      return;
    }
    setSubmitting(true);
    try {
      const nextTask = await window.yibiao.complianceCheck.run({
        input: { ...state.input, checks: selectedChecks },
        checks: selectedChecks,
      });
      setState((current) => ({ ...current, step: 'running', checkTask: nextTask, lastReport: null }));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动合规检查失败', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelCheck() {
    const result = await window.yibiao.complianceCheck.cancel();
    if (!result.success) showToast(result.message || '当前没有运行中的检查', 'info');
  }

  async function clearCheck() {
    const next = await window.yibiao.complianceCheck.clear();
    setState((current) => ({ ...current, ...next, lastReport: null, checkTask: undefined }));
    showToast('合规检查结果已清空', 'success');
  }

  async function pingSidecar() {
    const result = await window.yibiao.complianceCheck.ping();
    showToast(result.message || (result.ok ? 'Sidecar 正常' : 'Sidecar 不可用'), result.ok ? 'success' : 'error');
  }

  if (loading) {
    return <div className="compliance-check-page is-loading">正在读取合规检查状态…</div>;
  }

  return (
    <div className="compliance-check-page">
      <header className="compliance-check-header">
        <div>
          <span className="section-kicker">标书检查</span>
          <h1>合规检查</h1>
          <p>由常驻 Python Sidecar 执行确定性规则检查，结果写入本地数据库。</p>
        </div>
        <div className={`compliance-check-status is-${results[0]?.status || (running ? 'running' : overallSeverity === 'info' ? 'idle' : overallSeverity)}`}>
          {running ? '检查中' : results.length ? statusLabel(overallSeverity === 'major' ? 'fail' : overallSeverity === 'minor' ? 'warning' : 'pass') : '待检查'}
        </div>
      </header>

      <UploadBoard
        kicker="STEP 01"
        title="选择检查文件"
        subtitle="投标文件必选；招标文件用于读取招标要求的有效期天数与起始日期。当前支持 Markdown、JSON、TXT。"
      >
        <UploadRow
          index="01"
          title="招标文件"
          note="可选"
          actions={(
            <>
              <button type="button" className="secondary-action" onClick={() => selectFile('tender')}>{state.input.tender_file ? '替换' : '选择'}</button>
              {state.input.tender_file ? <button type="button" className="text-button" onClick={() => removeFile('tender')}>移除</button> : null}
            </>
          )}
        >
          {state.input.tender_file ? (
            <UploadFilePill badge="MD" name={fileName(state.input.tender_file)} meta={state.input.tender_file} />
          ) : (
            <UploadEmpty title="尚未选择招标文件" hint="没有招标文件时仍可执行投标文件内部一致性检查" />
          )}
        </UploadRow>

        <UploadRow
          index="02"
          title="投标文件"
          note="必选"
          actions={(
            <>
              <button type="button" className="secondary-action" onClick={() => selectFile('bid')}>{state.input.bid_file ? '替换' : '选择'}</button>
              {state.input.bid_file ? <button type="button" className="text-button" onClick={() => removeFile('bid')}>移除</button> : null}
            </>
          )}
        >
          {state.input.bid_file ? (
            <UploadFilePill badge="MD" name={fileName(state.input.bid_file)} meta={state.input.bid_file} />
          ) : (
            <UploadEmpty title="请选择投标报价文件" hint="支持 Markdown 表格与 project_metadata 结构化数据" />
          )}
        </UploadRow>
      </UploadBoard>

      <section className="compliance-check-panel">
        <div className="compliance-check-panel-head">
          <div>
            <span className="section-kicker">STEP 02</span>
            <h2>检查项</h2>
          </div>
          <span className="compliance-check-count-pill">{selectedChecks.length} / {definitions.length}</span>
        </div>
        <div className="compliance-check-item-list">
          {definitions.map((definition) => {
            const enabled = selectedChecks.includes(definition.check_id);
            return (
              <label key={definition.check_id} className={`compliance-check-item${enabled ? ' is-selected' : ''}`}>
                <input type="checkbox" checked={enabled} onChange={() => toggleCheck(definition.check_id)} disabled={running} />
                <span className="compliance-check-item-copy">
                  <strong>{definition.label}</strong>
                  <span>{definition.description}</span>
                </span>
                {definition.requires_model ? <em className="compliance-check-item-model">需模型</em> : null}
              </label>
            );
          })}
        </div>
      </section>

      {(running || task?.status === 'success' || task?.status === 'error') ? (
        <section className="compliance-check-panel">
          <div className="compliance-check-panel-head">
            <div>
              <span className="section-kicker">STEP 03</span>
              <h2>检查进度</h2>
            </div>
            <span>{progress}%</span>
          </div>
          <ProgressBar value={progress} active={running} tone={task?.status === 'error' ? 'warning' : 'primary'} label={`合规检查进度 ${progress}%`} />
          {Array.isArray(task?.logs) && task.logs.length ? (
            <div className="compliance-check-logs">
              {task.logs.slice(-5).map((log, index) => <span key={`${log}-${index}`}>{log}</span>)}
            </div>
          ) : null}
          {task?.error ? <div className="compliance-check-error">{task.error}</div> : null}
        </section>
      ) : null}

      {results.length ? (
        <section className="compliance-check-panel">
          <div className="compliance-check-panel-head">
            <div>
              <span className="section-kicker">检查结果</span>
              <h2>共 {results.length} 项检查</h2>
            </div>
            <span className="compliance-check-count-pill">
              问题 {results.reduce((sum, item) => sum + item.metrics.failed, 0)} · 提醒 {results.reduce((sum, item) => sum + item.metrics.warning, 0)}
            </span>
          </div>
          {results.map((result) => (
            <article className="compliance-check-result" key={result.check_id}>
              <div className="compliance-check-result-head">
                <div>
                  <strong>{result.check_name}</strong>
                  <span>{result.summary}</span>
                </div>
                <span className={`compliance-check-result-pill is-${result.status}`}>{statusLabel(result.status)}</span>
              </div>
              <div className="compliance-check-metrics">
                <article><span>检查点</span><strong>{result.metrics.total}</strong></article>
                <article><span>通过</span><strong>{result.metrics.passed}</strong></article>
                <article><span>问题</span><strong>{result.metrics.failed}</strong></article>
                <article><span>提醒</span><strong>{result.metrics.warning}</strong></article>
              </div>
              {result.findings.length ? (
                <div className="compliance-check-findings">
                  {result.findings.map((finding) => (
                    <div key={`${result.check_id}-${finding.id}`} className={`compliance-check-finding is-${finding.severity}`}>
                      <div className="compliance-check-finding-head">
                        <strong>{finding.title}</strong>
                        <span>{severityLabel(finding.severity)}</span>
                      </div>
                      <p>{finding.message}</p>
                      {finding.evidence ? <pre>{finding.evidence}</pre> : null}
                      <div className="compliance-check-finding-foot">
                        <span>{finding.suggestion}</span>
                        {finding.location?.line ? <small>{fileName(finding.location.file || '')} 第 {finding.location.line} 行</small> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="compliance-check-empty-result">没有发现需要处理的问题。</div>
              )}
            </article>
          ))}
        </section>
      ) : null}

      <FloatingToolbar
        label="合规检查操作"
        groups={[
          {
            id: 'main',
            actions: [
              { id: 'start', label: submitting ? '启动中…' : '开始检查', variant: 'primary', disabled: running || submitting || !state.input.bid_file, onClick: startCheck },
              { id: 'cancel', label: '取消', variant: 'warning', disabled: !running, onClick: cancelCheck },
              { id: 'ping', label: '测试 Sidecar', variant: 'secondary', onClick: pingSidecar },
              { id: 'clear', label: '清空结果', variant: 'ghost', disabled: running || (!results.length && !task), onClick: clearCheck },
            ],
          },
        ]}
      />
    </div>
  );
}

export default ComplianceCheckPage;
