const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadFindingModel() {
  const sourcePath = path.join(__dirname, 'findingModel.ts');
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('module', 'exports', 'require', compiled)(module, module.exports, require);
  return module.exports;
}

const {
  toggleResultFinding,
  deleteResultFinding,
  filterFindingsByActiveBid,
  groupFindingsByBid,
} = loadFindingModel();

const finding = (id, bidDocumentId) => ({ id, bidDocumentId });
const result = (overrides = {}) => ({ status: 'success', findings: [], ...overrides });

test('toggleResultFinding 点同一条收起，点别的切过去', () => {
  const base = result({ findings: [finding('a', 'doc-1'), finding('b', 'doc-1')] });

  const opened = toggleResultFinding(base, 'a', 'now');
  assert.equal(opened.activeFindingId, 'a');
  assert.equal(opened.updatedAt, 'now');
  assert.equal(base.activeFindingId, undefined, '不能改到原对象');

  const switched = toggleResultFinding({ ...base, activeFindingId: 'a' }, 'b', 'now');
  assert.equal(switched.activeFindingId, 'b');

  const closed = toggleResultFinding({ ...base, activeFindingId: 'a' }, 'a', 'now');
  assert.equal(closed.activeFindingId, undefined);
});

test('deleteResultFinding 删掉当前展开项时会收起，并写入保留数', () => {
  const base = result({
    findings: [finding('a', 'doc-1'), finding('b', 'doc-1'), finding('c', 'doc-2')],
    activeFindingId: 'a',
  });

  const next = deleteResultFinding(base, 'a', 'now', '需复核风险项', '风险项');
  assert.deepEqual(next.findings.map((item) => item.id), ['b', 'c']);
  assert.equal(next.activeFindingId, undefined);
  assert.equal(next.progressMessage, '保留 2 个需复核风险项');
  assert.equal(next.updatedAt, 'now');
});

test('deleteResultFinding 删掉非展开项时保持展开，并在删空时写收尾文案', () => {
  const base = result({
    findings: [finding('a', 'doc-1'), finding('b', 'doc-1')],
    activeFindingId: 'a',
  });

  const kept = deleteResultFinding(base, 'b', 'now', '疑似错别字', '错别字项');
  assert.equal(kept.activeFindingId, 'a');
  assert.equal(kept.progressMessage, '保留 1 个疑似错别字');

  const emptied = deleteResultFinding(kept, 'a', 'now', '疑似错别字', '错别字项');
  assert.deepEqual(emptied.findings, []);
  assert.equal(emptied.progressMessage, '所有错别字项已处理');
});

test('filterFindingsByActiveBid 在 all 时原样返回', () => {
  const findings = [finding('a', 'doc-1'), finding('b', 'doc-2')];
  assert.equal(filterFindingsByActiveBid(findings, 'all'), findings);
  assert.deepEqual(filterFindingsByActiveBid(findings, 'doc-2').map((item) => item.id), ['b']);
});

test('groupFindingsByBid 按投标文件分组并丢掉空组', () => {
  const documents = [{ id: 'doc-1' }, { id: 'doc-2' }, { id: 'doc-3' }];
  const findings = [finding('a', 'doc-1'), finding('b', 'doc-2'), finding('c', 'doc-2')];

  const groups = groupFindingsByBid(findings, documents, 'all');
  assert.deepEqual(groups.map((group) => group.document.id), ['doc-1', 'doc-2']);
  assert.deepEqual(groups[1].findings.map((item) => item.id), ['b', 'c']);
});

test('groupFindingsByBid 指定单份文件时只返回该组，未知文件返回空数组', () => {
  const documents = [{ id: 'doc-1' }, { id: 'doc-2' }];
  const findings = [finding('a', 'doc-1'), finding('b', 'doc-2')];

  const single = groupFindingsByBid(findings, documents, 'doc-2');
  assert.equal(single.length, 1);
  assert.equal(single[0].document.id, 'doc-2');
  assert.deepEqual(single[0].findings.map((item) => item.id), ['b']);

  assert.deepEqual(groupFindingsByBid(findings, documents, 'doc-9'), []);
});
