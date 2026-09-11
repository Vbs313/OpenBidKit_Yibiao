const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadModel() {
  const source = fs.readFileSync(path.join(__dirname, 'knowledgePickerModel.ts'), 'utf-8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('module', 'exports', 'require', compiled)(module, module.exports, require);
  return module.exports;
}

const { buildKnowledgePickerViewModel, includesKeyword } = loadModel();

const doc = (id, folderId, fileName, status = 'success') => ({ id, folder_id: folderId, file_name: fileName, status, item_count: 1 });
const index = {
  folders: [
    { id: 'f1', name: '技术标' },
    { id: 'f2', name: '商务标' },
    { id: 'f3', name: '空文件夹' },
  ],
  documents: [
    doc('d1', 'f1', '施工组织设计.md'),
    doc('d2', 'f1', '质量保证措施.md'),
    doc('d3', 'f2', '报价明细.md'),
    doc('d4', 'f2', '处理中的文档.md', 'analyzing'),
    doc('d5', 'f3', '别的文件夹.md'),
  ],
};

test('includesKeyword 不区分大小写', () => {
  assert.equal(includesKeyword('ABC.md', 'abc'), true);
  assert.equal(includesKeyword('ABC.md', 'zzz'), false);
});

test('没有搜索词时按文件夹给出全部「已完成」文档，空文件夹不显示', () => {
  const vm = buildKnowledgePickerViewModel(index, '', []);
  assert.deepEqual(vm.availableDocuments.map((item) => item.id), ['d1', 'd2', 'd3', 'd5']);
  assert.deepEqual(vm.visibleFolders.map((group) => group.folder.id), ['f1', 'f2', 'f3']);
  assert.deepEqual(vm.visibleFolders.map((group) => group.documents.map((item) => item.id)), [['d1', 'd2'], ['d3'], ['d5']]);
  assert.equal(vm.visibleDocumentCount, 4);
  assert.equal(vm.keyword, '');
});

test('搜索词命中文件夹名时保留该文件夹全部文档', () => {
  const vm = buildKnowledgePickerViewModel(index, ' 技术标 ', []);
  assert.equal(vm.keyword, '技术标');
  assert.deepEqual(vm.visibleFolders.map((group) => group.folder.id), ['f1']);
  assert.deepEqual(vm.visibleFolders[0].documents.map((item) => item.id), ['d1', 'd2']);
  assert.equal(vm.visibleDocumentCount, 2);
});

test('搜索词只命中文件名时按文件名过滤', () => {
  const vm = buildKnowledgePickerViewModel(index, '报价', []);
  assert.deepEqual(vm.visibleFolders.map((group) => group.folder.id), ['f2']);
  assert.deepEqual(vm.visibleFolders[0].documents.map((item) => item.id), ['d3']);
});

test('搜索无结果时可见文件夹为空', () => {
  const vm = buildKnowledgePickerViewModel(index, '不存在的关键词', []);
  assert.deepEqual(vm.visibleFolders, []);
  assert.equal(vm.visibleDocumentCount, 0);
});

test('selectedDocuments 按已选顺序返回并跳过未知 id', () => {
  const vm = buildKnowledgePickerViewModel(index, '', ['d3', 'nope', 'd1']);
  assert.deepEqual(vm.selectedDocuments.map((item) => item.id), ['d3', 'd1']);
});

test('未完成的文档既不出现在可用列表，也不会以已选身份返回', () => {
  const vm = buildKnowledgePickerViewModel(index, '', ['d4']);
  assert.equal(vm.availableDocuments.some((item) => item.id === 'd4'), false);
  assert.deepEqual(vm.selectedDocuments.map((item) => item.id), ['d4'], '已选列表按 id 直查索引（与既有行为一致）');
});
