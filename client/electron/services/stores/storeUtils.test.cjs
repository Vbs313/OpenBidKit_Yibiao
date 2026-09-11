const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const U = require('./storeUtils.cjs');

test('stableHash 是内容稳定的 sha256', () => {
  const expected = crypto.createHash('sha256').update('abc', 'utf8').digest('hex');
  assert.equal(U.stableHash('abc'), expected);
  assert.equal(U.stableHash('abc'), U.stableHash('abc'));
  assert.notEqual(U.stableHash('abc'), U.stableHash('abd'));
  assert.equal(U.stableHash(null), crypto.createHash('sha256').update('', 'utf8').digest('hex'));
});

test('safeFileNamePart 只保留安全字符并限长', () => {
  assert.equal(U.safeFileNamePart('技术标 2026/06版.docx'), '2026_06_.docx');
  assert.equal(U.safeFileNamePart(''), 'file');
  assert.equal(U.safeFileNamePart('///'), 'file');
  assert.ok(U.safeFileNamePart('x'.repeat(100)).length <= 48);
});

test('filePathKey 解析绝对路径并在 Windows 下小写化', () => {
  const resolved = path.resolve('./a/b.txt');
  const key = U.filePathKey('./a/b.txt');
  assert.equal(key, process.platform === 'win32' ? resolved.toLowerCase() : resolved);
});

test('createTenderSourceId 生成带序号的稳定 id', () => {
  const id = U.createTenderSourceId('a.pdf', '正文', 0);
  assert.match(id, /^tender-01-[0-9a-f]{12}$/);
  assert.equal(id, U.createTenderSourceId('a.pdf', '正文', 0));
  assert.notEqual(id, U.createTenderSourceId('a.pdf', '正文', 1));
});

test('createTenderSourceFiles 暴露招标源文件接口', () => {
  const { createTenderSourceFiles } = require('./tenderSourceFiles.cjs');
  const api = createTenderSourceFiles({
    tenderSourceFilesDir: '/tmp/files',
    tenderOriginalsDir: '/tmp/originals',
    tenderSourceFilesDirRelativePath: 'technical-plan/tender-files',
    tenderOriginalsDirRelativePath: 'technical-plan/tender-originals',
    tenderOriginalLogger: { write: () => {} },
    removeWorkspacePathSync: () => {},
    getManagedTenderOriginalRelativePath: () => '',
    clearBidTemplate: () => {},
    readMetaRow: () => ({}),
    resolveMarkdownPath: (value) => value,
  });
  for (const n of ['loadTenderSourceFiles','readTenderSourceMarkdown','readOriginalTenderMarkdown','writeMarkdownFile','writeTenderSourceMarkdown','persistExistingTenderOriginal','pruneTenderOriginals','clearTenderSourceFiles']) {
    assert.equal(typeof api[n], 'function', 'missing ' + n);
  }
});
