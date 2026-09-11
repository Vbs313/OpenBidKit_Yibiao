const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadCheckRunModel() {
  const sourcePath = path.join(__dirname, 'checkRunModel.ts');
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('module', 'exports', 'require', compiled)(module, module.exports, require);
  return module.exports;
}

const {
  pickActiveCheckResultTab,
  buildExtractionStartPlan,
  buildExtractionErrorState,
  buildCheckRunPlan,
  markCheckResultFailed,
  markBackgroundTaskFailed,
} = loadCheckRunModel();

const resultState = (status, inputSignature) => ({ status, findings: [], inputSignature });
const runOptions = (overrides = {}) => ({
  rejectionCheck: false,
  typoCheck: false,
  logicCheck: false,
  ...overrides,
});

test('pickActiveCheckResultTab 按 废标项 > 错别字 > 逻辑 取当前分页', () => {
  assert.equal(pickActiveCheckResultTab(runOptions({ rejectionCheck: true, typoCheck: true })), 'rejection');
  assert.equal(pickActiveCheckResultTab(runOptions({ typoCheck: true, logicCheck: true })), 'typo');
  assert.equal(pickActiveCheckResultTab(runOptions({ logicCheck: true })), 'logic');
});

test('buildExtractionStartPlan 生成 running 态与对应任务', () => {
  const plan = buildExtractionStartPlan('sig-tender', '2026-09-11T00:00:00.000Z', 'local-1');
  assert.deepEqual(plan.extractionState, {
    status: 'running',
    content: '',
    source: 'ai',
    tenderSignature: 'sig-tender',
    updatedAt: '2026-09-11T00:00:00.000Z',
  });
  assert.equal(plan.extractionTask.type, 'rejection-items-extraction');
  assert.equal(plan.extractionTask.task_id, 'local-1');
  assert.equal(plan.extractionTask.status, 'running');
  assert.equal(plan.extractionTask.progress, 5);
});

test('buildCheckRunPlan 只把勾选的检查置为 running，其余保持原对象', () => {
  const previousRejection = resultState('success', 'rejection-sig');
  const previousTypo = resultState('idle', '');
  const previousLogic = resultState('success', 'bid-sig');
  const plan = buildCheckRunPlan({
    runOptions: runOptions({ typoCheck: true }),
    bidSignature: 'bid-sig',
    rejectionInputSignature: 'rejection-sig',
    startedAt: '2026-09-11T00:00:00.000Z',
    taskId: 'local-2',
    previousRejectionCheckResult: previousRejection,
    previousTypoCheckResult: previousTypo,
    previousLogicCheckResult: previousLogic,
  });

  assert.equal(plan.activeCheckResultTab, 'typo');
  assert.equal(plan.rejectionCheckResult, previousRejection, '未勾选的废标项检查必须原样返回');
  assert.equal(plan.logicCheckResult, previousLogic, '未勾选的逻辑检查必须原样返回');
  assert.equal(plan.typoCheckResult.status, 'running');
  assert.equal(plan.typoCheckResult.inputSignature, 'bid-sig');
  assert.equal(plan.checkTask.type, 'rejection-check-run');
  assert.equal(plan.checkTask.task_id, 'local-2');
  assert.equal(plan.checkTask.progress, 5);
});

test('buildCheckRunPlan 三项全开时各自带上正确的签名', () => {
  const plan = buildCheckRunPlan({
    runOptions: runOptions({ rejectionCheck: true, typoCheck: true, logicCheck: true }),
    bidSignature: 'bid-sig',
    rejectionInputSignature: 'rejection-sig',
    startedAt: 'x',
    taskId: 'local-3',
    previousRejectionCheckResult: resultState('success', 'old'),
    previousTypoCheckResult: resultState('success', 'old'),
    previousLogicCheckResult: resultState('success', 'old'),
  });

  assert.equal(plan.activeCheckResultTab, 'rejection');
  assert.equal(plan.rejectionCheckResult.inputSignature, 'rejection-sig');
  assert.equal(plan.typoCheckResult.inputSignature, 'bid-sig');
  assert.equal(plan.logicCheckResult.inputSignature, 'bid-sig');
  assert.ok([plan.rejectionCheckResult, plan.typoCheckResult, plan.logicCheckResult].every((item) => item.status === 'running'));
});

test('markCheckResultFailed 只在签名一致时改成错误态', () => {
  const current = { ...resultState('running', 'sig-a'), progressMessage: '跑着呢' };
  const marked = markCheckResultFailed(current, '炸了', 'sig-a', 'now');
  assert.equal(marked.status, 'error');
  assert.equal(marked.error, '炸了');
  assert.equal(marked.progressMessage, '炸了');
  assert.equal(marked.updatedAt, 'now');

  const stale = resultState('running', 'sig-b');
  assert.equal(markCheckResultFailed(stale, '炸了', 'sig-a', 'now'), stale, '签名不一致必须原样返回');
});

test('markBackgroundTaskFailed 只在有任务时补错误信息', () => {
  const task = { task_id: 't', type: 'rejection-check-run', status: 'running', progress: 5, logs: ['起'] };
  const marked = markBackgroundTaskFailed(task, '炸了', 'now');
  assert.equal(marked.status, 'error');
  assert.equal(marked.progress, 100);
  assert.deepEqual(marked.logs, ['炸了']);
  assert.equal(marked.updated_at, 'now');
  assert.equal(markBackgroundTaskFailed(undefined, '炸了', 'now'), undefined);
});

test('buildExtractionErrorState 记录签名与错误信息', () => {
  const state = buildExtractionErrorState('sig-tender', '解析失败', 'now');
  assert.deepEqual(state, {
    status: 'error',
    content: '',
    error: '解析失败',
    source: 'ai',
    tenderSignature: 'sig-tender',
    updatedAt: 'now',
  });
});
