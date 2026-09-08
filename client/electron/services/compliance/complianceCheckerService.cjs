const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execFile, spawn } = require('node:child_process');
const { compactLogError, createDeveloperLogger } = require('../../utils/developerLog.cjs');
const {
  getBundledComplianceCheckerPath,
  getComplianceCheckerScriptPath,
} = require('../../utils/paths.cjs');
const {
  PROTOCOL_VERSION,
  createRequest,
  isProgressMessage,
  validateResponse,
} = require('./protocol.cjs');

const DEFAULT_TIMEOUT_MS = 120000;
const PING_TIMEOUT_MS = 1000;

function createAbortError(signal, fallback = '合规检查已取消') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(fallback);
  error.code = 'TASK_CANCELLED';
  return error;
}

function createResponseError(response) {
  const error = new Error(response?.error?.message || '合规检查失败');
  error.code = response?.error?.code || 'COMPLIANCE_CHECK_FAILED';
  error.response = response;
  return error;
}

function resolvePythonCommand() {
  return process.env.YIBIAO_PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
}

function createComplianceCheckerService({ app, configStore } = {}) {
  let child = null;
  let lineReader = null;
  let pending = new Map();
  let queue = Promise.resolve();
  let startingPromise = null;
  let closing = false;
  let terminationPromise = null;

  const logger = createDeveloperLogger({
    app,
    config: configStore?.load?.() || {},
    moduleName: 'compliance-checker',
    name: 'compliance-checker',
  });

  function writeLog(event, payload = {}) {
    logger.write(event, payload);
  }

  function resolveSpawnSpec() {
    if (app?.isPackaged) {
      const executablePath = getBundledComplianceCheckerPath(app);
      if (fs.existsSync(executablePath)) {
        return {
          command: executablePath,
          args: [],
          cwd: path.dirname(executablePath),
        };
      }

      const packagedScript = path.join(process.resourcesPath, 'compliance-checker', 'checker_sidecar.py');
      if (fs.existsSync(packagedScript)) {
        return {
          command: resolvePythonCommand(),
          args: [packagedScript],
          cwd: path.dirname(packagedScript),
        };
      }

      throw new Error('找不到合规检查 Sidecar。请先运行 prepare-compliance-checker 或确认 resources/compliance-checker 已打包。');
    }

    const scriptPath = getComplianceCheckerScriptPath();
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`找不到合规检查 Sidecar 脚本: ${scriptPath}`);
    }
    return {
      command: resolvePythonCommand(),
      args: [scriptPath],
      cwd: path.dirname(scriptPath),
    };
  }

  function cleanupWaiter(waiter) {
    if (!waiter) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }

  function settleWaiter(jobId, method, value) {
    const waiter = pending.get(jobId);
    if (!waiter) return false;
    pending.delete(jobId);
    cleanupWaiter(waiter);
    waiter[method](value);
    return true;
  }

  function rejectPending(error) {
    for (const jobId of Array.from(pending.keys())) {
      settleWaiter(jobId, 'reject', error);
    }
  }

  function handleLine(line) {
    const text = String(line || '').trim();
    if (!text) return;

    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      writeLog('checker.stdout.parse_error', { line: text.slice(0, 500), error: compactLogError(error) });
      return;
    }

    if (isProgressMessage(message)) {
      const waiter = pending.get(message.job_id);
      if (waiter?.onProgress) {
        try { waiter.onProgress(message); } catch (error) { writeLog('checker.progress.handler_error', { error: compactLogError(error) }); }
      }
      return;
    }

    const validation = validateResponse(message);
    if (!validation.valid) {
      const error = new Error(`合规检查响应不符合协议: ${validation.errors.join('; ')}`);
      error.code = 'COMPLIANCE_PROTOCOL_INVALID';
      error.response = message;
      if (message?.job_id) settleWaiter(message.job_id, 'reject', error);
      writeLog('checker.response.invalid', { errors: validation.errors, message });
      return;
    }

    const jobId = message.job_id;
    const waiter = pending.get(jobId);
    if (!waiter) {
      writeLog('checker.response.unmatched', { job_id: jobId, status: message.status });
      return;
    }

    if (message.status === 'success') {
      settleWaiter(jobId, 'resolve', message);
    } else {
      settleWaiter(jobId, 'reject', createResponseError(message));
    }
  }

  function handleExit(nextChild, code, signal) {
    if (child !== nextChild) return;
    child = null;
    if (lineReader) {
      lineReader.close();
      lineReader = null;
    }
    rejectPending(new Error(`合规检查 Sidecar 已退出（code=${code ?? 'null'}, signal=${signal || 'null'}）`));
    writeLog('checker.exit', { code, signal });
  }

  function ensureStarted() {
    if (child && child.exitCode === null && !child.killed) return Promise.resolve();
    if (startingPromise) return startingPromise;

    const spec = resolveSpawnSpec();
    startingPromise = new Promise((resolve, reject) => {
      const next = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      });
      child = next;
      next.stdout.setEncoding('utf8');
      next.stderr.setEncoding('utf8');
      lineReader = readline.createInterface({ input: next.stdout, crlfDelay: Infinity });
      lineReader.on('line', handleLine);
      next.stderr.on('data', (chunk) => {
        const message = String(chunk || '').trim();
        if (message) writeLog('checker.stderr', { message });
      });
      next.once('spawn', () => {
        writeLog('checker.started', { command: spec.command, args: spec.args, pid: next.pid });
        resolve();
      });
      next.once('error', (error) => {
        writeLog('checker.spawn_error', { error: compactLogError(error), command: spec.command, args: spec.args });
        if (child === next) {
          child = null;
          if (lineReader) {
            lineReader.close();
            lineReader = null;
          }
          rejectPending(error);
        }
        reject(error);
      });
      next.on('exit', (code, signal) => handleExit(next, code, signal));
    }).finally(() => {
      startingPromise = null;
    });

    return startingPromise;
  }

  function writeRequest(request) {
    if (!child?.stdin || child.stdin.destroyed) {
      throw new Error('合规检查 Sidecar 尚未就绪');
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(request)}\n`, 'utf8', (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  function sendRequest({ jobId, action, input, timeoutMs = DEFAULT_TIMEOUT_MS, signal, onProgress }) {
    const normalizedJobId = String(jobId || crypto.randomUUID()).trim();
    return ensureStarted().then(() => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError(signal));
        return;
      }

      const waiter = {
        resolve,
        reject,
        onProgress,
        signal,
        onAbort: null,
        timer: null,
      };
      waiter.onAbort = () => {
        const error = createAbortError(signal);
        if (settleWaiter(normalizedJobId, 'reject', error)) {
          void terminateChild();
        }
      };
      waiter.timer = setTimeout(() => {
        const error = new Error(`合规检查超时（${timeoutMs}ms）`);
        error.code = 'COMPLIANCE_CHECK_TIMEOUT';
        if (settleWaiter(normalizedJobId, 'reject', error)) {
          void terminateChild();
        }
      }, timeoutMs);

      pending.set(normalizedJobId, waiter);
      signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
      if (signal?.aborted) {
        waiter.onAbort();
        return;
      }

      try {
        const request = createRequest({ jobId: normalizedJobId, action, input });
        writeRequest(request).catch((error) => settleWaiter(normalizedJobId, 'reject', error));
      } catch (error) {
        settleWaiter(normalizedJobId, 'reject', error);
      }
    }));
  }

  function enqueue(work, signal) {
    let started = false;
    const execute = async () => {
      started = true;
      if (signal?.aborted) throw createAbortError(signal);
      return work();
    };
    const run = queue.then(execute, execute);
    queue = run.then(() => undefined, () => undefined);
    if (!signal) return run;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const settle = (handler, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        handler(value);
      };
      const onAbort = () => {
        if (!started) settle(reject, createAbortError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      run.then(
        (value) => settle(resolve, value),
        (error) => settle(reject, error),
      );
    });
  }

  function runChecks({ jobId, input, checks, timeoutMs, signal, onProgress } = {}) {
    const normalizedChecks = Array.isArray(checks) && checks.length ? checks : ['pricing_arithmetic'];
    return enqueue(() => sendRequest({
      jobId,
      action: 'run_checks',
      input: { ...(input || {}), checks: normalizedChecks },
      timeoutMs,
      signal,
      onProgress,
    }), signal);
  }

  async function ping(timeoutMs = PING_TIMEOUT_MS) {
    if (pending.size > 0) {
      return { ok: false, message: 'Sidecar 正在执行其他检查任务' };
    }
    try {
      const response = await enqueue(() => sendRequest({
        jobId: `ping-${crypto.randomUUID()}`,
        action: 'ping',
        timeoutMs,
      }));
      return { ok: response.status === 'success', message: response.message || 'pong' };
    } catch (error) {
      return { ok: false, message: error.message || String(error) };
    }
  }

  async function terminateChild() {
    if (terminationPromise) return terminationPromise;
    const current = child;
    child = null;
    if (lineReader) {
      lineReader.close();
      lineReader = null;
    }
    rejectPending(new Error('合规检查 Sidecar 已终止'));
    if (!current) return;
    terminationPromise = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (current.exitCode !== null || current.signalCode !== null) {
        finish();
        return;
      }
      current.once('exit', finish);
      current.once('error', finish);
      setTimeout(() => {
        try { current.kill('SIGKILL'); } catch { finish(); }
      }, 1000);
      if (process.platform === 'win32' && current.pid) {
        setTimeout(() => {
          execFile('taskkill', ['/PID', String(current.pid), '/T', '/F'], { windowsHide: true }, () => {});
        }, 300);
      }
      setTimeout(finish, 1000);
      try { current.stdin?.end(); } catch { /* ignore */ }
      try { current.kill(); } catch { finish(); }
    });
    try {
      await terminationPromise;
    } finally {
      terminationPromise = null;
    }
  }

  async function restart() {
    await terminateChild();
    await ensureStarted();
    return getStatus();
  }

  function getStatus() {
    return {
      running: Boolean(child && child.exitCode === null && !child.killed),
      pid: child?.pid || null,
      pending_jobs: pending.size,
      protocol_version: PROTOCOL_VERSION,
    };
  }

  async function close() {
    closing = true;
    await terminateChild();
  }

  return {
    close,
    ensureStarted,
    getStatus,
    ping,
    restart,
    runChecks,
    terminateChild,
  };
}

module.exports = {
  createComplianceCheckerService,
};


