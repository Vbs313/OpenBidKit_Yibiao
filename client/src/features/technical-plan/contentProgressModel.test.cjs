const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function transpile(fileName) {
  const source = fs.readFileSync(path.join(__dirname, fileName), 'utf-8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function evaluate(code, localRequire) {
  const module = { exports: {} };
  Function('module', 'exports', 'require', code)(module, module.exports, localRequire);
  return module.exports;
}

const wordCount = evaluate(transpile('../../shared/utils/wordCount.ts'), require);
const contentEditModel = evaluate(transpile('contentEditModel.ts'), (id) => (id.endsWith('wordCount') ? wordCount : require(id)));
const { buildContentProgressViewModel } = evaluate(transpile('contentProgressModel.ts'), (id) => (
  id.endsWith('contentEditModel') ? contentEditModel : require(id)
));

const illustrationStats = () => ({
  html: { planned: 0, success: 0 },
  mermaid: { planned: 0, success: 0 },
  ai: { planned: 0, success: 0 },
});

function input(overrides = {}) {
  return {
    planning: false,
    task: undefined,
    outlineWordControlSnapshot: undefined,
    running: false,
    pausing: false,
    paused: false,
    taskFailed: false,
    taskInFlight: false,
    phaseVisible: false,
    contentStats: undefined,
    progressDetail: undefined,
    illustrationStats: illustrationStats(),
    contentIllustrationPlan: null,
    developerMode: false,
    outlineMeta: new Map(),
    contentSummary: { completedCount: 0, failedCount: 0, ignoredCount: 0, totalWords: 0 },
    leaves: [],
    allLeaves: [],
    selectedItem: null,
    selectedIsLeaf: false,
    editingItemId: null,
    ...overrides,
  };
}

const leaf = (id) => ({ id, title: id, description: '', content_mode: 'ai-generate' });

test('空任务：进度归零、按钮可生成、无选中状态', () => {
  const vm = buildContentProgressViewModel(input());
  assert.equal(vm.displayProgress, 0);
  assert.equal(vm.displayProgressLabel, '生成统计');
  assert.equal(vm.displayProgressCount, '0/0');
  assert.equal(vm.progressPhaseLabel, '正文生成');
  assert.equal(vm.progressTone, 'primary');
  assert.equal(vm.progressActive, false);
  assert.equal(vm.generationButtonLabel, '生成正文');
  assert.equal(vm.resolvedCount, 0);
  assert.equal(vm.unresolvedCount, 0);
  assert.equal(vm.pendingCount, 0);
  assert.equal(vm.generationStrategyLocked, false);
  assert.equal(vm.awaitingContentDecision, false);
  assert.equal(vm.editing, false);
  assert.equal(vm.showIllustrationStats, false);
});

test('编排阶段：进度取自 planning 统计，按钮文案与色调跟着阶段走', () => {
  const vm = buildContentProgressViewModel(input({
    planning: true,
    running: true,
    taskInFlight: true,
    phaseVisible: true,
    contentStats: { phase: 'planning', planning_total: 10, planning_completed: 4 },
    leaves: [leaf('1'), leaf('2')],
    allLeaves: [leaf('1'), leaf('2')],
  }));
  assert.equal(vm.displayProgress, 40);
  assert.equal(vm.displayProgressLabel, '编排统计');
  assert.equal(vm.displayProgressCount, '4/10');
  assert.equal(vm.progressPhaseLabel, '正文编排');
  assert.equal(vm.progressTone, 'success');
  assert.equal(vm.progressActive, true);
  assert.equal(vm.generationButtonLabel, '暂停');
  assert.equal(vm.progressDescription, '正在编排正文结构，已完成 4/10 个小节。');
  assert.equal(vm.unresolvedCount, 2);
});

test('任务失败：进入待决策状态并展示错误信息', () => {
  const vm = buildContentProgressViewModel(input({
    taskFailed: true,
    phaseVisible: true,
    task: { task_id: 't', status: 'error', error: '生成失败：模型不可用', logs: [] },
    contentStats: { phase: 'planning' },
    leaves: [leaf('1')],
    allLeaves: [leaf('1')],
  }));
  assert.equal(vm.progressDescription, '生成失败：模型不可用');
  assert.equal(vm.contentRetryTargetLabel, '内容矫正');
  assert.equal(vm.canRetryContentCorrection, false, '没有可重试的小节时不提供重试');
});

test('选中并编辑叶子：editing 跟着 editingItemId 走，selectedStatus 取树状态', () => {
  const leafItem = leaf('1');
  const meta = new Map([['1', { status: 'success', leafCount: 1, words: 120 }]]);
  const vm = buildContentProgressViewModel(input({
    selectedItem: leafItem,
    selectedIsLeaf: true,
    editingItemId: '1',
    outlineMeta: meta,
    leaves: [leafItem],
    allLeaves: [leafItem],
    contentSummary: { completedCount: 1, failedCount: 0, ignoredCount: 0, totalWords: 120 },
  }));

  assert.equal(vm.editing, true);
  assert.equal(vm.selectedStatus, 'success');

  const notEditing = buildContentProgressViewModel(input({
    selectedItem: leafItem,
    selectedIsLeaf: true,
    editingItemId: null,
    outlineMeta: meta,
    leaves: [leafItem],
    allLeaves: [leafItem],
  }));
  assert.equal(notEditing.editing, false);
});
