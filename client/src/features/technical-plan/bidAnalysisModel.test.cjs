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

// 真实工作流模块的依赖链太长，这里用等价的桩：4 个解析项、其中 2 个是关键项。
const taskStub = {
  bidAnalysisTasks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }],
  getBidAnalysisTasks: () => [{ id: 't1' }, { id: 't2' }],
};
const model = evaluate(transpile('bidAnalysisModel.ts'), (id) => (
  id.includes('bidAnalysisWorkflow') ? taskStub : require(id)
));

const {
  formatJsonValue,
  getModeForSelection,
  getModeLabel,
  getSelectedTaskIdsForMode,
  normalizeSelectedTaskIds,
  tryParseJsonObject,
} = model;

test('normalizeSelectedTaskIds：关键项恒选，其余按传入勾选，并保持全量顺序', () => {
  assert.deepEqual(normalizeSelectedTaskIds([]), ['t1', 't2']);
  assert.deepEqual(normalizeSelectedTaskIds(['t4', 't1']), ['t1', 't2', 't4']);
  assert.deepEqual(normalizeSelectedTaskIds(['unknown']), ['t1', 't2'], '未知名直接忽略');
});

test('getSelectedTaskIdsForMode：full 全选 / custom 归一化 / key 只要关键项', () => {
  assert.deepEqual(getSelectedTaskIdsForMode('full', []), ['t1', 't2', 't3', 't4']);
  assert.deepEqual(getSelectedTaskIdsForMode('custom', ['t3']), ['t1', 't2', 't3']);
  assert.deepEqual(getSelectedTaskIdsForMode('key', ['t3']), ['t1', 't2']);
});

test('getModeForSelection：全选=full，只有关键项=key，其余=custom', () => {
  assert.equal(getModeForSelection(['t1', 't2', 't3', 't4']), 'full');
  assert.equal(getModeForSelection(['t1', 't2']), 'key');
  assert.equal(getModeForSelection(['t1', 't2', 't3']), 'custom');
  assert.equal(getModeForSelection([]), 'key', '空选择等于只跑关键项');
});

test('getModeLabel 的中文标签', () => {
  assert.equal(getModeLabel('full'), '完整解析');
  assert.equal(getModeLabel('custom'), '自定义解析');
  assert.equal(getModeLabel('key'), '只解析关键项');
});

test('tryParseJsonObject 只接受对象，其余一律 null', () => {
  assert.deepEqual(tryParseJsonObject('{"a":1}'), { a: 1 });
  assert.equal(tryParseJsonObject('[1,2]'), null, '数组不接受');
  assert.equal(tryParseJsonObject('"文本"'), null);
  assert.equal(tryParseJsonObject('not json'), null);
  assert.equal(tryParseJsonObject(''), null);
});

test('formatJsonValue 的空值文案与对象序列化', () => {
  assert.equal(formatJsonValue(null), '没有提及');
  assert.equal(formatJsonValue(undefined), '没有提及');
  assert.equal(formatJsonValue(''), '没有提及');
  assert.equal(formatJsonValue(0), '0');
  assert.equal(formatJsonValue({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(formatJsonValue(['a']), '[\n  "a"\n]');
});
