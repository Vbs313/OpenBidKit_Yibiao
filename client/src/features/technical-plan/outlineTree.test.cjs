const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadModule(fileName) {
  const source = fs.readFileSync(path.join(__dirname, fileName), 'utf-8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('module', 'exports', 'require', compiled)(module, module.exports, require);
  return module.exports;
}

const {
  assertLeafContentModes,
  collectOutlineIds,
  collectRootIds,
  composeIdMap,
  createIdentityIdMap,
  deleteOutlineItem,
  findOutlineItem,
  findOutlineLocation,
  normalizeOutlineContentModes,
  renumberOutlineItemsWithIdMap,
  reorderOutlineSiblings,
  updateOutlineItem,
} = loadModule('outlineTree.ts');

const tree = () => [
  {
    id: '1',
    title: '第一章',
    description: '',
    children: [
      { id: '1.1', title: '第一节', description: '', content_mode: 'ai-generate' },
      { id: '1.2', title: '第二节', description: '', content_mode: 'ai-generate' },
    ],
  },
  { id: '2', title: '第二章', description: '', content_mode: 'ai-generate' },
];

test('collectOutlineIds / collectRootIds 收集嵌套 id', () => {
  assert.deepEqual([...collectOutlineIds(tree())].sort(), ['1', '1.1', '1.2', '2']);
  assert.deepEqual([...collectRootIds(tree())].sort(), ['1', '2']);
});

test('renumberOutlineItemsWithIdMap 重排编号并给出 idMap', () => {
  const source = [
    { id: 'a', title: 'A', description: '', children: [{ id: 'a-1', title: 'A1', description: '' }, { id: 'a-2', title: 'A2', description: '' }] },
    { id: 'b', title: 'B', description: '' },
  ];
  const { outline, idMap } = renumberOutlineItemsWithIdMap(source);

  assert.deepEqual(outline.map((item) => item.id), ['1', '2']);
  assert.deepEqual(outline[0].children.map((item) => item.id), ['1.1', '1.2']);
  assert.deepEqual(idMap, { a: '1', 'a-1': '1.1', 'a-2': '1.2', b: '2' });
});

test('normalizeOutlineContentModes 父节点去掉处理模式，叶子保留（other 保留去空白备注）', () => {
  const source = [
    {
      id: '1',
      title: '父',
      description: '',
      content_mode: 'ai-generate',
      content_mode_note: '父不该带',
      children: [{ id: '1.1', title: '叶', description: '', content_mode: 'other', content_mode_note: '  手工填  ' }],
    },
  ];
  const [parent] = normalizeOutlineContentModes(source);

  assert.equal('content_mode' in parent, false);
  assert.equal('content_mode_note' in parent, false);
  assert.equal(parent.children[0].content_mode, 'other');
  assert.equal(parent.children[0].content_mode_note, '手工填');
  assert.equal('children' in parent.children[0], false);
});

test('assertLeafContentModes 对缺处理模式的叶子抛错', () => {
  assert.doesNotThrow(() => assertLeafContentModes(tree()));
  assert.throws(
    () => assertLeafContentModes([{ id: '1', title: '缺模式', description: '' }]),
    /缺少内容处理模式/,
  );
});

test('findOutlineItem / findOutlineLocation 定位嵌套节点', () => {
  assert.equal(findOutlineItem(tree(), '1.2').title, '第二节');
  assert.equal(findOutlineItem(tree(), 'nope'), null);
  assert.deepEqual(findOutlineLocation(tree(), '1.2'), { parentId: '1', level: 1, index: 1 });
  assert.equal(findOutlineLocation(tree(), 'nope'), null);
});

test('reorderSiblingItems 支持 before / after，未命中时原样返回', () => {
  const reorder = loadModule('outlineTree.ts');
  const siblings = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(reorder.reorderSiblingItems(siblings, 'a', 'c', 'after').map((i) => i.id), ['b', 'c', 'a']);
  assert.deepEqual(reorder.reorderSiblingItems(siblings, 'c', 'a', 'before').map((i) => i.id), ['c', 'a', 'b']);
  assert.equal(reorder.reorderSiblingItems(siblings, 'a', 'a', 'before'), siblings);
});

test('reorderOutlineSiblings 在子层级里重排', () => {
  const reordered = reorderOutlineSiblings(tree(), '1', '1.2', '1.1', 'before');
  assert.deepEqual(reordered[0].children.map((item) => item.id), ['1.2', '1.1']);
  assert.deepEqual(reordered[1], tree()[1], '其它分支必须原对象返回');
});

test('updateOutlineItem 只替换命中的节点', () => {
  const next = updateOutlineItem(tree(), '1.2', (item) => ({ ...item, title: '改名' }));
  assert.equal(next[0].children[1].title, '改名');
  assert.equal(next[0].children[0].title, '第一节');
  assert.equal(next[1].title, '第二章');
});

test('deleteOutlineItem 删掉节点；父节点变成叶子时补回内容处理模式', () => {
  const onlyChild = [
    { id: '1', title: '父', description: '', children: [{ id: '1.1', title: '唯一子', description: '', content_mode: 'template-fill' }] },
  ];
  const next = deleteOutlineItem(onlyChild, '1.1');
  assert.deepEqual(next[0].children, undefined);
  assert.equal(next[0].content_mode, 'ai-generate');

  const removedRoot = deleteOutlineItem(tree(), '1');
  assert.deepEqual(removedRoot.map((item) => item.id), ['2']);
});

test('createIdentityIdMap / composeIdMap 组合映射', () => {
  assert.deepEqual(createIdentityIdMap(tree()), { '1': '1', '1.1': '1.1', '1.2': '1.2', '2': '2' });
  assert.deepEqual(
    composeIdMap({ a: '1', b: '2' }, { '1': '1.1' }),
    { a: '1.1', b: '2' },
  );
});
