const test = require('node:test');
const assert = require('node:assert/strict');

const O = require('./openaiImages.cjs');

test('createImageFromOpenAICompatibleItem 解码 base64 图片', async () => {
  const image = await O.createImageFromOpenAICompatibleItem({ b64_json: Buffer.from('png-bytes').toString('base64') });
  assert.equal(image.mime_type, 'image/png');
  assert.equal(image.buffer.toString(), 'png-bytes');
});

test('createImageFromOpenAICompatibleItem 保留返回的 MIME', async () => {
  const image = await O.createImageFromOpenAICompatibleItem({ b64_json: 'AAAA', mimeType: 'image/webp' });
  assert.equal(image.mime_type, 'image/webp');
});

test('createImageFromOpenAICompatibleItem 无图片数据时返回 null', async () => {
  assert.equal(await O.createImageFromOpenAICompatibleItem({}), null);
  assert.equal(await O.createImageFromOpenAICompatibleItem(null), null);
});

test('getOpenAICompatibleImageFailureMessage 取第一条错误信息或兜底', () => {
  assert.equal(O.getOpenAICompatibleImageFailureMessage({ errors: [{ message: '限流' }] }, '兜底'), '限流');
  assert.equal(O.getOpenAICompatibleImageFailureMessage({ errors: [{}] }, '兜底'), '兜底');
  assert.equal(O.getOpenAICompatibleImageFailureMessage({}, '兜底'), '兜底');
});
