const test = require('node:test');
const assert = require('node:assert/strict');
const { imageExtensionFromMime, imageExtensionFromPath } = require('./fileService.cjs');

// P0-0.7 修复的回归测试：导出图片无法识别导致导出失败。
test('imageExtensionFromMime 识别标准图片类型', () => {
  assert.equal(imageExtensionFromMime('image/jpeg'), '.jpg');
  assert.equal(imageExtensionFromMime('image/jpg'), '.jpg');
  assert.equal(imageExtensionFromMime('image/png'), '.png');
  assert.equal(imageExtensionFromMime('image/gif'), '.gif');
  assert.equal(imageExtensionFromMime('image/bmp'), '.bmp');
  assert.equal(imageExtensionFromMime('image/webp'), '.webp');
});

test('imageExtensionFromMime 识别 EMF/WMF 图元文件（Word 声明）', () => {
  assert.equal(imageExtensionFromMime('image/x-emf'), '.emf');
  assert.equal(imageExtensionFromMime('image/x-wmf'), '.wmf');
  assert.equal(imageExtensionFromMime('IMAGE/X-EMF'), '.emf');
});

test('imageExtensionFromMime 未登记类型回落 mime-types 推断', () => {
  assert.equal(imageExtensionFromMime('image/svg+xml'), '.svg');
  assert.equal(imageExtensionFromMime('image/tiff'), '.tiff');
});

test('imageExtensionFromMime 非图片类型返回空', () => {
  assert.equal(imageExtensionFromMime('application/pdf'), '');
  assert.equal(imageExtensionFromMime(''), '');
  assert.equal(imageExtensionFromMime(null), '');
});

test('imageExtensionFromPath 按 mime 判定图片扩展名', () => {
  assert.equal(imageExtensionFromPath('photo.png'), '.png');
  assert.equal(imageExtensionFromPath('photo.jpeg'), '.jpg');
  assert.equal(imageExtensionFromPath('https://x.com/a.png?v=1'), '.png');
  assert.equal(imageExtensionFromPath('doc.pdf'), '');
  assert.equal(imageExtensionFromPath(''), '');
});

test('imageExtensionFromPath 不接受未知扩展名', () => {
  assert.equal(imageExtensionFromPath('file.xyz'), '');
  assert.equal(imageExtensionFromPath('noext'), '');
});
