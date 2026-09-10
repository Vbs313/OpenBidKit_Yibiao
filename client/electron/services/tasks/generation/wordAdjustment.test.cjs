const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('./wordAdjustment.cjs');

const op = (over = {}) => ({ operation: 'insert', anchor: 'end', content: '新增', ...over });

test('validateWordAdjustmentResponse 放行 expand 的 insert 与 shrink 的 delete', () => {
  assert.doesNotThrow(() => W.validateWordAdjustmentResponse({ mode: 'expand', granularity: 'paragraph', operations: [op()] }));
  assert.doesNotThrow(() => W.validateWordAdjustmentResponse({ mode: 'shrink', granularity: 'sentence', operations: [{ operation: 'delete', target_text: '待删' }] }));
  assert.doesNotThrow(() => W.validateWordAdjustmentResponse({ mode: 'expand', granularity: 'paragraph', operations: [op({ operation: 'replace', target_text: '旧', content: '新' })] }));
});

test('validateWordAdjustmentResponse 校验 mode / granularity / operations 形状', () => {
  assert.throws(() => W.validateWordAdjustmentResponse({ mode: 'x', granularity: 'paragraph', operations: [op()] }), /mode 只能是/);
  assert.throws(() => W.validateWordAdjustmentResponse({ mode: 'expand', granularity: 'x', operations: [op()] }), /granularity 只能是/);
  assert.throws(() => W.validateWordAdjustmentResponse({ mode: 'expand', granularity: 'paragraph', operations: [] }), /operations 不能为空/);
  assert.throws(() => W.validateWordAdjustmentResponse(null), /mode 只能是/);
});

test('validateWordAdjustmentResponse 只放行当前方向允许的操作并检查必填项', () => {
  assert.throws(() => W.validateWordAdjustmentResponse({ mode: 'shrink', granularity: 'paragraph', operations: [op()] }), /不允许 insert 操作/);
  assert.throws(() => W.validateWordAdjustmentResponse({ mode: 'expand', granularity: 'paragraph', operations: [{ operation: 'insert', content: 'c' }] }), /insert anchor 不能为空/);
  assert.throws(() => W.validateWordAdjustmentResponse({ mode: 'shrink', granularity: 'paragraph', operations: [{ operation: 'delete' }] }), /target_text 不能为空/);
  assert.throws(() => W.validateWordAdjustmentResponse({ mode: 'shrink', granularity: 'paragraph', operations: [{ operation: 'replace', target_text: '旧' }] }), /content 不能为空/);
});

test('validateWordAdjustmentResponse 拒绝会改变结构的 content', () => {
  const bad = ['## 标题', '![](a.png)', '<img src="a.png">', '```\nx\n```', '```mermaid\ngraph\n```', '| A |\n| --- |\n| 1 |'];
  for (const content of bad) {
    assert.throws(
      () => W.validateWordAdjustmentResponse({ mode: 'expand', granularity: 'paragraph', operations: [op({ content })] }),
      /不能包含标题、图片、Mermaid、代码块或表格/,
      JSON.stringify(content) + ' 应被拒绝',
    );
  }
});

test('applyWordAdjustmentOperations 处理 start/end/锚点三种插入', () => {
  assert.equal(W.applyWordAdjustmentOperations('正文A', { operations: [{ operation: 'insert', anchor: 'start', content: '新增' }] }), '新增\n\n正文A');
  assert.equal(W.applyWordAdjustmentOperations('正文A', { operations: [{ operation: 'insert', anchor: 'end', content: '新增' }] }), '正文A\n\n新增');
  assert.equal(W.applyWordAdjustmentOperations('第一段\n\n第二段', { operations: [{ operation: 'insert', anchor: '第一段', content: '新增' }] }), '第一段\n\n新增\n\n第二段');
});

test('applyWordAdjustmentOperations 处理 replace 与 delete', () => {
  assert.equal(W.applyWordAdjustmentOperations('旧句子在这里', { operations: [{ operation: 'replace', target_text: '旧句子', content: '新句子' }] }), '新句子在这里');
  assert.equal(W.applyWordAdjustmentOperations('保留删除保留', { operations: [{ operation: 'delete', target_text: '删除' }] }), '保留保留');
});

test('applyWordAdjustmentOperations 拒绝非唯一定位', () => {
  assert.throws(() => W.applyWordAdjustmentOperations('A A', { operations: [{ operation: 'insert', anchor: 'A', content: 'x' }] }), /insert anchor 未在当前正文中精确唯一命中/);
  assert.throws(() => W.applyWordAdjustmentOperations('abc', { operations: [{ operation: 'replace', target_text: 'zzz', content: 'x' }] }), /target_text 未在当前正文中精确唯一命中/);
});

test('applyWordAdjustmentOperations 保护图片、代码块与表格', () => {
  assert.throws(() => W.applyWordAdjustmentOperations('前 ![](a.png) 后', { operations: [{ operation: 'replace', target_text: '![](a.png)', content: 'x' }] }), /不能修改图片、Mermaid、代码块或表格/);
  assert.throws(() => W.applyWordAdjustmentOperations('前\n```\ncode\n```\n后', { operations: [{ operation: 'replace', target_text: 'code', content: 'x' }] }), /不能修改图片、Mermaid、代码块或表格/);
  assert.throws(() => W.applyWordAdjustmentOperations('前\n| A |\n| --- |\n| 1 |\n后', { operations: [{ operation: 'replace', target_text: '| A |', content: 'x' }] }), /不能修改图片、Mermaid、代码块或表格/);
});

test('applyWordAdjustmentOperations 拒绝重复范围与空改动', () => {
  assert.throws(
    () => W.applyWordAdjustmentOperations('目标段落', { operations: [
      { operation: 'replace', target_text: '目标段落', content: '改一' },
      { operation: 'replace', target_text: '目标段落', content: '改二' },
    ] }),
    /范围重复/,
  );
  assert.throws(() => W.applyWordAdjustmentOperations('旧', { operations: [{ operation: 'replace', target_text: '旧', content: '旧' }] }), /没有变化/);
});

test('applyWordAdjustmentOperations 一次应用多条互不冲突的操作', () => {
  const content = '开头\n\n中间\n\n结尾';
  const result = W.applyWordAdjustmentOperations(content, { operations: [
    { operation: 'replace', target_text: '中间', content: '中段' },
    { operation: 'insert', anchor: '结尾', content: '收尾补充' },
  ] });
  assert.equal(result, '开头\n\n中段\n\n结尾\n\n收尾补充');
});