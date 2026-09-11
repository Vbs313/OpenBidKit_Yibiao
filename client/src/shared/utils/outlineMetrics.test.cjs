const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadOutlineMetrics() {
  const source = fs.readFileSync(path.join(__dirname, 'outlineMetrics.ts'), 'utf-8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('module', 'exports', 'require', compiled)(module, module.exports, require);
  return module.exports;
}

const { collectLeafItems, countMermaidDiagrams, countOutlineMermaidDiagrams } = loadOutlineMetrics();

const item = (id, overrides = {}) => ({ id, title: id, description: '', ...overrides });
const tree = () => [
  { ...item('1'), children: [item('1.1'), item('1.2', { children: [item('1.2.1')] })] },
  item('2'),
];

test('collectLeafItems 只取叶子并按原顺序展开', () => {
  assert.deepEqual(collectLeafItems(tree()).map((node) => node.id), ['1.1', '1.2.1', '2']);
  assert.deepEqual(collectLeafItems([]), []);
});

test('countMermaidDiagrams 同时统计代码块与 mermaid.ink 图片', () => {
  assert.equal(countMermaidDiagrams(''), 0);
  assert.equal(countMermaidDiagrams('```mermaid\ngraph TD;\n```'), 1);
  assert.equal(countMermaidDiagrams('![](https://mermaid.ink/img/abc)'), 1);
  assert.equal(countMermaidDiagrams('```mermaid\ngraph TD;\n```\nhttps://mermaid.ink/img/xyz'), 2);
});

test('countOutlineMermaidDiagrams 只累加叶子（分支节点自身的 content 不参与统计）', () => {
  const items = [
    { ...item('1'), content: '```mermaid\na\n```', children: [item('1.1', { content: 'https://mermaid.ink/img/b' })] },
    item('2', { content: '无图' }),
  ];
  assert.equal(countOutlineMermaidDiagrams(items), 1);
  assert.equal(countOutlineMermaidDiagrams([]), 0);
});
