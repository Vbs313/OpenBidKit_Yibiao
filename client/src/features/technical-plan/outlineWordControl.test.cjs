const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadOutlineWordControl() {
  const source = fs.readFileSync(path.join(__dirname, 'outlineWordControl.ts'), 'utf-8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('module', 'exports', 'require', compiled)(module, module.exports, require);
  return module.exports;
}

const {
  areWordControlOptionsEqual,
  formatWordCountDraft,
  getEstimatedPages,
  normalizeWordControlDraft,
  parseWordCountDraft,
  WORD_COUNT_INPUT_UNIT,
} = loadOutlineWordControl();

const draft = (overrides = {}) => ({
  minimumWords: '',
  maximumWords: '',
  sectionWords: '',
  strictSectionWords: false,
  ...overrides,
});

test('字数草稿输入单位是 1 万', () => {
  assert.equal(WORD_COUNT_INPUT_UNIT, 10000);
  assert.equal(parseWordCountDraft(''), 0);
  assert.equal(parseWordCountDraft('1.5'), 15000);
  assert.equal(parseWordCountDraft('0'), 0);
  assert.equal(parseWordCountDraft('abc'), null);
  assert.equal(parseWordCountDraft('-1'), null);
  assert.equal(formatWordCountDraft(15000), '1.5');
  assert.equal(formatWordCountDraft(0), '0');
  assert.equal(formatWordCountDraft(Number.NaN), '0');
});

test('normalizeWordControlDraft 生成选项，且每小节字数 > 0 时才带强控', () => {
  assert.deepEqual(
    normalizeWordControlDraft(draft({ minimumWords: '1', maximumWords: '3', strictSectionWords: true })),
    { minimumWords: 10000, maximumWords: 30000, sectionWords: 0, strictSectionWords: false },
  );
  assert.deepEqual(
    normalizeWordControlDraft(draft({ minimumWords: '1', maximumWords: '3', sectionWords: '0.3', strictSectionWords: true })),
    { minimumWords: 10000, maximumWords: 30000, sectionWords: 3000, strictSectionWords: true },
  );
});

test('normalizeWordControlDraft 的三条校验', () => {
  assert.throws(() => normalizeWordControlDraft(draft({ minimumWords: 'x' })), /只允许填写非负整数/);
  assert.throws(() => normalizeWordControlDraft(draft({ minimumWords: '3', maximumWords: '1' })), /最多字数不能低于最少字数/);
  assert.throws(
    () => normalizeWordControlDraft(draft({ minimumWords: '100', maximumWords: '100' })),
    /无法形成有效叶子节点范围/,
  );
});

test('getEstimatedPages 取区间中值按 650 字/页估算', () => {
  assert.equal(getEstimatedPages(0, 0), null);
  assert.equal(getEstimatedPages(13000, 0), 20);
  assert.equal(getEstimatedPages(13000, 26000), 30);
});

test('areWordControlOptionsEqual 四项全等才算相等', () => {
  const base = { minimumWords: 1, maximumWords: 2, sectionWords: 3, strictSectionWords: true };
  assert.equal(areWordControlOptionsEqual(base, { ...base }), true);
  assert.equal(areWordControlOptionsEqual(base, { ...base, strictSectionWords: false }), false);
  assert.equal(areWordControlOptionsEqual(base, undefined), false);
  assert.equal(areWordControlOptionsEqual(undefined, base), false);
});
