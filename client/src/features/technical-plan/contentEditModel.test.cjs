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
const model = evaluate(transpile('contentEditModel.ts'), (id) => (id.endsWith('wordCount') ? wordCount : require(id)));

const {
  buildDefaultGenerationOptions,
  buildOutlineMeta,
  defaultContentGenerationOptions,
  getLeafContent,
  getLeafStatus,
  getParentStatus,
  getTreeStatus,
  normalizeGenerationOptions,
} = model;

const leaf = (id, overrides = {}) => ({ id, title: id, description: '', content_mode: 'ai-generate', ...overrides });

test('buildDefaultGenerationOptions 按叶子数收紧配图上限，并按模型可用性决定 AI 配图', () => {
  const options = buildDefaultGenerationOptions(true, 2);
  assert.equal(options.useAiImages, true);
  assert.equal(options.maxAiImages, 2);
  assert.equal(options.maxMermaidImages, 2);
  assert.equal(options.maxHtmlImages, 2);
  assert.equal(options.htmlImageTypes, defaultContentGenerationOptions.htmlImageTypes);

  const none = buildDefaultGenerationOptions(false, 0);
  assert.equal(none.useAiImages, false);
  assert.equal(none.maxAiImages, Math.min(defaultContentGenerationOptions.maxAiImages, 1));
});

test('normalizeGenerationOptions 夹紧越界值并回退非法枚举', () => {
  const normalized = normalizeGenerationOptions({
    useAiImages: true,
    maxAiImages: 999,
    maxMermaidImages: -5,
    tableRequirement: 'bogus',
    consistencyRepairMode: 'bogus',
    enableOriginalPlanCoverageAudit: true,
  }, true, 3, false);

  assert.equal(normalized.maxAiImages, 3, '上限不能超过叶子数');
  assert.equal(normalized.maxMermaidImages, 0, '负数夹到 0');
  assert.equal(normalized.tableRequirement, 'heavy', '非法表格要求回退默认');
  assert.equal(normalized.consistencyRepairMode, 'agent', '非法修复模式回退默认');
  assert.equal(normalized.enableOriginalPlanCoverageAudit, false, '非扩写工作流强制关闭原方案覆盖审计');
});

test('normalizeGenerationOptions 扩写工作流才允许原方案覆盖审计', () => {
  const normalized = normalizeGenerationOptions({ enableOriginalPlanCoverageAudit: true, originalPlanCoverageRepairMode: 'normal' }, true, 5, true);
  assert.equal(normalized.enableOriginalPlanCoverageAudit, true);
  assert.equal(normalized.originalPlanCoverageRepairMode, 'normal');
});

test('normalizeGenerationOptions 没有生图模型时强制关闭 AI 配图', () => {
  const normalized = normalizeGenerationOptions({ useAiImages: true }, false, 5);
  assert.equal(normalized.useAiImages, false);
});

test('getLeafContent 优先取 sections 里已有 content 字段的值', () => {
  const item = leaf('1', { content: '大纲里的内容' });
  assert.equal(getLeafContent(item, {}), '大纲里的内容');
  assert.equal(getLeafContent(item, { '1': { content: '生成的内容' } }), '生成的内容');
  assert.equal(getLeafContent(item, { '1': { content: '' } }), '', '字段存在但为空时不再回退大纲内容');
  assert.equal(getLeafContent(item, { '1': { status: 'running' } }), '大纲里的内容');
});

test('getLeafStatus 依次看 section.status → 正文是否为空 → 内容模式', () => {
  assert.equal(getLeafStatus(leaf('1'), { '1': { status: 'error' } }), 'error');
  assert.equal(getLeafStatus(leaf('1'), { '1': { content: '有内容' } }), 'success');
  assert.equal(getLeafStatus(leaf('1'), {}), 'idle');
  assert.equal(getLeafStatus(leaf('1', { content_mode: 'template-fill' }), {}), 'pending');
});

test('getParentStatus 按子状态聚合', () => {
  assert.equal(getParentStatus([]), 'success', '空数组时 every 恒真——沿用既有行为');
  assert.equal(getParentStatus(['success', 'running']), 'running');
  assert.equal(getParentStatus(['success', 'success']), 'success');
  assert.equal(getParentStatus(['ignored', 'ignored']), 'ignored');
  assert.equal(getParentStatus(['pending', 'pending']), 'pending');
  assert.equal(getParentStatus(['success', 'error']), 'error');
  assert.equal(getParentStatus(['success', 'pending']), 'partial');
  assert.equal(getParentStatus(['planning', 'planning']), 'planning');
});

test('getTreeStatus 叶子走 getLeafStatus，分支聚合子状态', () => {
  const tree = {
    ...leaf('1'),
    children: [leaf('1.1'), leaf('1.2')],
  };
  assert.equal(getTreeStatus(tree, { '1.1': { status: 'success' }, '1.2': { status: 'success' } }), 'success');
  assert.equal(getTreeStatus(tree, { '1.1': { status: 'running' }, '1.2': { status: 'success' } }), 'running');
  assert.equal(getTreeStatus(tree, { '1.1': { status: 'error' }, '1.2': { status: 'success' } }), 'error');
  assert.equal(getTreeStatus(tree, { '1.1': { status: 'idle' }, '1.2': { status: 'success' } }), 'partial');
});

test('buildOutlineMeta 汇总叶子数与字数，planning 只作用于待生成的 AI 叶子', () => {
  const items = [
    { ...leaf('1'), children: [leaf('1.1', { content: '一二三' }), leaf('1.2', { content_mode: 'template-fill' })] },
    leaf('2', { content: '四五' }),
    leaf('3'),
  ];
  const sections = { '1.1': { status: 'success', content: '一二三' } };

  const meta = buildOutlineMeta(items, sections, false);
  assert.deepEqual(meta.get('1'), { status: 'partial', leafCount: 2, words: 3 });
  assert.deepEqual(meta.get('1.1'), { status: 'success', leafCount: 1, words: 3 });
  assert.deepEqual(meta.get('2'), { status: 'success', leafCount: 1, words: 2 });
  assert.deepEqual(meta.get('3'), { status: 'idle', leafCount: 1, words: 0 });

  const planning = buildOutlineMeta(items, sections, true);
  assert.equal(planning.get('3').status, 'planning', '编排中：待生成的 AI 叶子显示为 planning');
  assert.equal(planning.get('2').status, 'success', '已有正文的叶子不受 planning 影响');
  assert.equal(planning.get('1.2').status, 'pending', '非 AI 叶子不受 planning 影响');
  assert.equal(planning.get('1.1').status, 'success', '已生成的叶子不受 planning 影响');
});
