const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extractMetadata } = require('./documentMetadata.cjs');

function makeFile(name, content = 'x') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-meta-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return { dir, filePath };
}

const byKey = (fields) => Object.fromEntries(fields.map((field) => [field.key, field]));

test('extractMetadata 输出基础字段与可比对标记', async () => {
  const { filePath } = makeFile('说明.txt', 'hello');
  const fields = await extractMetadata({ file_path: filePath, file_name: '说明.txt', extension: '.txt' });
  const map = byKey(fields);
  assert.equal(map.file_name.value, '说明.txt');
  assert.equal(map.extension.value, '.txt');
  assert.equal(String(map.size.value), '5');
  assert.ok(map.file_sha256.value);
  assert.equal(map.size.comparable, false);
  assert.equal(map.created_at.comparable, true);
  assert.equal(map.created_at.date_comparable, true);
  assert.equal(map.created_at.date_day.length >= 10, true);
  assert.equal(map.file_name.comparable, false);
});

test('extractMetadata 对损坏的 docx 记 metadata_error 而不抛错', async () => {
  const { filePath } = makeFile('坏文件.docx', 'not a zip');
  const fields = await extractMetadata({ file_path: filePath, file_name: '坏文件.docx', extension: '.docx' });
  const map = byKey(fields);
  assert.ok(map.metadata_error, '应当记录 metadata_error');
  assert.ok(map.metadata_error.value);
});

test('extractMetadata 文件不存在时向上抛错', async () => {
  await assert.rejects(
    () => extractMetadata({ file_path: path.join(os.tmpdir(), '不存在的文件-xyz.txt'), file_name: 'x.txt', extension: '.txt' }),
    /ENOENT|no such file/i,
  );
});
