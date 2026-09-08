import { useEffect, useMemo, useState } from 'react';
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
  ComplianceCheckInput,
  ComplianceCheckResponse,
  ComplianceCheckState,
  ComplianceCheckTaskState,
} from '../types';

const PRICING_ARITHMETIC_CHECK = {
  id: 'pricing_arithmetic',
  name: '报价算术核查',
  description: '检查单价 × 数量、分项合计、总价、大小写金额、空白值和重复计费。',
};

const initialState: ComplianceCheckState = {
  step: 'configure',
  input: { tender_file: '', bid_file: '', project_metadata: {}, checks: [PRICING_ARITHMETIC_CHECK.id] },
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
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    let alive = true;
    window.yibiao.complianceCheck.loadState()
      .then((next) => { if (alive) setState({ ...initialState, ...next }); })
      .catch((error) => { if (alive) showToast(error?.message || '读取合规检查状态失败', 'error'); })
      .finally(() => { if (alive) setLoading(false); });

    const unsubscribe = window.yibiao.tasks.onTaskEvent((event) => {
      if (event.task.type !== 'compliance-check') return;
      if (event.complianceCheck) {
        setState(event.complianceCheck);
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
  const findings = useMemo(() => (report?.results || []).flatMap((result) => result.findings.map((finding) => ({ ...finding, checkName: result.check_name }))), [report]);

  async function saveInput(nextInput: ComplianceCheckInput) {
    const next = await window.yibiao.complianceCheck.saveInput(nextInput);
    setState({ ...initialState, ...next, step: 'configure' });
  }

  async function selectFile(role: 'tender' | 'bid') {
    try {
      const selected = await window.yibiao.complianceCheck.selectFile(role);
      if (selected.canceled || !selected.filePath) return;
      const key = role === 'tender' ? 'tender_file' : 'bid_file';
      const nextInput: ComplianceCheckInput = {
        ...state.input,
        [key]: selected.filePath,
        checks: [PRICING_ARITHMETIC_CHECK.id],
      };
      await saveInput(nextInput);
    } catch (error) {
      showToast(error?.message || '选择文件失败', 'error');
    }
  }

  async function removeFile(role: 'tender' | 'bid') {
    const key = role === 'tender' ? 'tender_file' : 'bid_file';
    await saveInput({ ...state.input, [key]: '', checks: [PRICING_ARITHMETIC_CHECK.id] });
  }

  async function startCheck() {
    if (!state.input.bid_file) {
      showToast('请先选择投标文件', 'info');
      return;
    }
    setSubmitting(true);
    try {
      const nextTask = await window.yibiao.complianceCheck.run({
        input: { ...state.input, checks: [PRICING_ARITHMETIC_CHECK.id] },
        checks: [PRICING_ARITHMETIC_CHECK.id],
      });
      setState((current) => ({ ...current, step: 'running', checkTask: nextTask, lastReport: null }));
    } catch (error) {
      showToast(error?.message || '启动合规检查失败', 'error');
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
    setState({ ...initialState, ...next });
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
          <p>第一版接入常驻 Python Sidecar，先跑通报价算术核查。</p>
        </div>
        <div className={`compliance-check-status is-${report?.results?.[0]?.status || (running ? 'running' : 'idle')}`}>
          {running ? '检查中' : statusLabel(report?.results?.[0]?.status)}
        </div>
      </header>

      <UploadBoard
        kicker="STEP 01"
        title="选择检查文件"
        subtitle="第一版支持 Markdown、JSON、TXT。投标文件必选，招标文件用于读取最高限价。"
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
            <UploadEmpty title="尚未选择招标文件" hint="没有招标文件时仍可执行投标文件内部算术检查" />
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
            <UploadEmpty title="请选择投标报价文件" hint="支持 Markdown 表格或 project_metadata.line_items 结构化数据" />
          )}
        </UploadRow>
      </UploadBoard>

      <section className="compliance-check-panel">
        <div className="compliance-check-panel-head">
          <div>
            <span className="section-kicker">STEP 02</span>
            <h2>检查项</h2>
          </div>
          <span className="compliance-check-count-pill">1 项</span>
        </div>
        <article className="compliance-check-item is-selected">
          <div>
            <strong>{PRICING_ARITHMETIC_CHECK.name}</strong>
            <p>{PRICING_ARITHMETIC_CHECK.description}</p>
          </div>
          <span className="compliance-check-item-state">已启用</span>
        </article>
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

      {report?.results?.length ? (
        <section className="compliance-check-panel">
          <div className="compliance-check-panel-head">
            <div>
              <span className="section-kicker">检查结果</span>
              <h2>{report.results[0].check_name}</h2>
            </div>
            <span className={`compliance-check-result-pill is-${report.results[0].status}`}>{statusLabel(report.results[0].status)}</span>
          </div>
          <p className="compliance-check-summary">{report.results[0].summary}</p>
          <div className="compliance-check-metrics">
            <article><span>检查项</span><strong>{report.results[0].metrics.total}</strong></article>
            <article><span>通过</span><strong>{report.results[0].metrics.passed}</strong></article>
            <article><span>问题</span><strong>{report.results[0].metrics.failed}</strong></article>
            <article><span>提醒</span><strong>{report.results[0].metrics.warning}</strong></article>
          </div>
          {findings.length ? (
            <div className="compliance-check-findings">
              {findings.map((finding) => (
                <article key={`${finding.checkName}-${finding.id}`} className={`compliance-check-finding is-${finding.severity}`}>
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
                </article>
              ))}
            </div>
          ) : (
            <div className="compliance-check-empty-result">没有发现需要处理的问题。</div>
          )}
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
              { id: 'clear', label: '清空结果', variant: 'ghost', disabled: running || (!report && !task), onClick: clearCheck },
            ],
          },
        ]}
      />
    </div>
  );
}

export default ComplianceCheckPage;


