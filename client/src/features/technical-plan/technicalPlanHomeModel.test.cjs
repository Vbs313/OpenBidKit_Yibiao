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

// wordCount 是真的（自身零依赖）；bidAnalysisWorkflow 依赖链太长，这里用等价桩。
const wordCount = evaluate(transpile('../../shared/utils/wordCount.ts'), require);
const outlineMetrics = evaluate(transpile('../../shared/utils/outlineMetrics.ts'), require);
const requiredTaskIds = ['task-a', 'task-b'];
const bidAnalysisWorkflowStub = {
  getBidAnalysisTasks: () => requiredTaskIds.map((id) => ({
    id,
    label: id,
    description: '',
    required: true,
    output: 'markdown',
    buildTaskPrompt: () => '',
  })),
};
const model = evaluate(transpile('technicalPlanHomeModel.ts'), (id) => {
  if (id.endsWith('wordCount')) return wordCount;
  if (id.endsWith('bidAnalysisWorkflow')) return bidAnalysisWorkflowStub;
  if (id.endsWith('outlineMetrics')) return outlineMetrics;
  return require(id);
});

const {
  areRequiredBidAnalysisTasksReady,
  buildWordControlWarningDialog,
  formatCountRange,
  hasRunningTechnicalPlanTask,
  hasWorkflowSpecificProgress,
  isOutlineLeafCountOutsideRange,
  workflowKindFromSection,
  workflowLabel,
} = model;

const aiLeaf = (id) => ({ id, title: id, description: '', content_mode: 'ai-generate' });
const outline = (count) => ({ outline: Array.from({ length: count }, (_, index) => aiLeaf(String(index + 1))) });
const wordOptions = (overrides = {}) => ({ minimumWords: 0, maximumWords: 0, sectionWords: 0, strictSectionWords: false, ...overrides });

test('isOutlineLeafCountOutsideRange 只统计 AI 生成叶子，且在区间内为 false', () => {
  assert.equal(isOutlineLeafCountOutsideRange(outline(1), wordOptions()), false, '未设置字数时不判定');
  assert.equal(isOutlineLeafCountOutsideRange(outline(1), wordOptions({ minimumWords: 30000 })), true);
  assert.equal(isOutlineLeafCountOutsideRange(outline(10), wordOptions({ minimumWords: 30000 })), false);
  assert.equal(isOutlineLeafCountOutsideRange(outline(30), wordOptions({ minimumWords: 30000 })), false);
  assert.equal(isOutlineLeafCountOutsideRange(outline(3), wordOptions({ maximumWords: 3000 })), true);
  assert.equal(
    isOutlineLeafCountOutsideRange({ outline: [{ ...aiLeaf('1'), content_mode: 'template-fill' }] }, wordOptions({ minimumWords: 30000 })),
    true,
    '非 AI 叶子不计入数量',
  );
});

test('formatCountRange 四种区间写法', () => {
  assert.equal(formatCountRange(1000, 2000, '字'), '1,000 至 2,000 字');
  assert.equal(formatCountRange(1000, 0, '字'), '不少于 1,000 字');
  assert.equal(formatCountRange(0, 2000, '字'), '不超过 2,000 字');
  assert.equal(formatCountRange(0, 0, '字'), '未限制');
});

test('buildWordControlWarningDialog：质量类警告不带指标', () => {
  const dialog = buildWordControlWarningDialog({
    task_id: 't1',
    stats: { outline: { word_adjustment_warning: '建议核对', word_adjustment_warning_kind: 'quality' } },
  }, {});
  assert.equal(dialog.taskId, 't1');
  assert.equal(dialog.title, '目录已生成，建议人工核对');
  assert.deepEqual(dialog.metrics, []);
});

test('buildWordControlWarningDialog：数量类警告给出预期与实际', () => {
  const dialog = buildWordControlWarningDialog({
    task_id: 't2',
    stats: { outline: { word_adjustment_warning: '小节偏少', minimum_leaf_count: 10, maximum_leaf_count: 20, current_leaf_count: 4 } },
  }, {});
  assert.equal(dialog.title, 'AI生成小节数量未达到预期');
  assert.deepEqual(dialog.metrics, [{ label: 'AI生成小节', expected: '10 至 20 个', actual: '4 个' }]);
});

test('buildWordControlWarningDialog：正文警告按 ±20% 挑出未达标小节', () => {
  const state = {
    outlineData: { outline: [aiLeaf('1'), aiLeaf('2')] },
    contentGenerationSections: {
      '1': { status: 'success', content: '一'.repeat(3000), title: '第一节' },
      '2': { status: 'success', content: '二'.repeat(500), title: '第二节' },
    },
  };
  const dialog = buildWordControlWarningDialog({
    task_id: 't3',
    stats: {
      content: {
        word_control_warning: '字数不达标',
        minimum_words: 10000,
        maximum_words: 20000,
        section_words: 3000,
        strict_section_words: true,
        current_words: 3500,
      },
    },
  }, state);

  assert.equal(dialog.title, '正文字数未达到预期');
  assert.equal(dialog.metrics.length, 2);
  assert.deepEqual(dialog.metrics[0].expected, '10,000 至 20,000 字');
  assert.deepEqual(dialog.sections.map((section) => section.id), ['2']);
  assert.equal(dialog.sections[0].words, 500);
});

test('buildWordControlWarningDialog：没有警告时返回 null', () => {
  assert.equal(buildWordControlWarningDialog({ task_id: 't4', stats: {} }, {}), null);
});

test('areRequiredBidAnalysisTasksReady 要求全部成功且内容非空', () => {
  const ready = Object.fromEntries(requiredTaskIds.map((id) => [id, { status: 'success', content: '有内容' }]));
  assert.equal(areRequiredBidAnalysisTasksReady(ready), true);
  assert.equal(areRequiredBidAnalysisTasksReady({ ...ready, 'task-b': { status: 'success', content: '   ' } }), false);
  assert.equal(areRequiredBidAnalysisTasksReady({ ...ready, 'task-a': { status: 'running', content: '有内容' } }), false);
});

test('workflowKindFromSection / workflowLabel', () => {
  assert.equal(workflowKindFromSection('technical-plan'), 'technical-plan');
  assert.equal(workflowKindFromSection('existing-plan-expansion'), 'existing-plan-expansion');
  assert.equal(workflowKindFromSection('other'), null);
  assert.equal(workflowLabel('technical-plan'), '生成技术方案');
  assert.equal(workflowLabel('existing-plan-expansion'), '已有方案扩写');
});

test('hasRunningTechnicalPlanTask 把 pausing 也算作运行中', () => {
  assert.equal(hasRunningTechnicalPlanTask({}), false);
  assert.equal(hasRunningTechnicalPlanTask({ contentGenerationTask: { status: 'pausing' } }), true);
  assert.equal(hasRunningTechnicalPlanTask({ outlineGenerationTask: { status: 'success' } }), false);
});

test('hasWorkflowSpecificProgress 认大纲/任务/步骤', () => {
  assert.equal(hasWorkflowSpecificProgress({ bidSections: [], globalFacts: [], step: 'document-analysis' }), false);
  assert.equal(hasWorkflowSpecificProgress({ bidSections: [], globalFacts: [], outlineData: outline(1), step: 'document-analysis' }), true);
  assert.equal(hasWorkflowSpecificProgress({ bidSections: [], globalFacts: [], step: 'content-edit' }), true);
});
