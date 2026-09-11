const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('./fileSignature.cjs');

test('stableFileId 优先用显式 id，否则按路径生成稳定哈希', () => {
  assert.equal(S.stableFileId({ id: 'F1', file_path: 'a' }), 'F1');
  const first = S.stableFileId({ file_path: 'D:/x/a.docx' });
  assert.equal(first, S.stableFileId({ file_path: 'D:/x/a.docx' }));
  assert.notEqual(first, S.stableFileId({ file_path: 'D:/x/b.docx' }));
  assert.equal(first.length, 40);
});

test('getTenderFilesFromPayload 兼容数组与单个文件', () => {
  assert.deepEqual(S.getTenderFilesFromPayload({ tenderFiles: [1, 2] }), [1, 2]);
  assert.deepEqual(S.getTenderFilesFromPayload({ tenderFile: 1 }), [1]);
  assert.deepEqual(S.getTenderFilesFromPayload({}), []);
  assert.deepEqual(S.getTenderFilesFromPayload(), []);
});

test('createSignature 由招标与投标文件共同决定', () => {
  const base = { tenderFiles: [{ file_path: 'a.pdf', size: 1, modified_at: 't1' }], bidFiles: [{ file_path: 'b.docx', size: 2, modified_at: 't2' }] };
  const sig = S.createSignature(base);
  assert.equal(sig, S.createSignature(base));
  assert.notEqual(sig, S.createSignature({ ...base, bidFiles: [{ file_path: 'b.docx', size: 3, modified_at: 't2' }] }));
  assert.equal(sig.length, 40);
});

test('hashText 与 crypto.sha256 一致', () => {
  const expected = crypto.createHash('sha256').update('内容', 'utf8').digest('hex');
  assert.equal(S.hashText('内容'), expected);
  assert.equal(S.hashText(''), crypto.createHash('sha256').update('', 'utf8').digest('hex'));
});

test('hashFileSha256 读取文件内容做哈希', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-sig-'));
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, 'abc');
  const expected = crypto.createHash('sha256').update(Buffer.from('abc')).digest('hex');
  assert.equal(await S.hashFileSha256(file), expected);
});

test('now 返回 ISO 时间串', () => {
  assert.match(S.now(), /^\d{4}-\d{2}-\d{2}T/);
});
