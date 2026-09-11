const test = require('node:test');
const assert = require('node:assert/strict');

const G = require('./googleImages.cjs');

const payloadWith = (parts, extra = {}) => ({ candidates: [{ content: { parts } }], ...extra });

test('createGoogleImageRequestBody 构造 contents 与生成配置', () => {
  const withSize = G.createGoogleImageRequestBody('画一张部署图', '2K');
  assert.deepEqual(withSize.contents, [{ role: 'user', parts: [{ text: '画一张部署图' }] }]);
  assert.deepEqual(withSize.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.deepEqual(withSize.generationConfig.imageConfig, { imageSize: '2K' });
  const withoutSize = G.createGoogleImageRequestBody('p', '');
  assert.equal('imageConfig' in withoutSize.generationConfig, false);
});

test('createGoogleImageUrl 区分普通与流式接口并编码模型名', () => {
  assert.equal(G.createGoogleImageUrl('https://g/v1beta', 'gemini-2.0-flash', 'normal'), 'https://g/v1beta/models/gemini-2.0-flash:generateContent');
  assert.equal(G.createGoogleImageUrl('https://g/v1beta', 'gemini-2.0-flash', 'stream'), 'https://g/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse');
  assert.match(G.createGoogleImageUrl('https://g', 'a b', 'normal'), /a%20b/);
});

test('createGoogleHeaders 使用 x-goog-api-key', () => {
  assert.deepEqual(G.createGoogleHeaders('sk-1'), { 'Content-Type': 'application/json', 'x-goog-api-key': 'sk-1' });
});

test('appendGoogleImagePayload 累积候选 parts 与用量元数据', () => {
  const state = { parts: [], usageMetadata: null };
  G.appendGoogleImagePayload(payloadWith([{ text: 'a' }], { usageMetadata: { totalTokenCount: 3 } }), state);
  G.appendGoogleImagePayload(payloadWith([{ text: 'b' }]), state);
  assert.deepEqual(state.parts.map((part) => part.text), ['a', 'b']);
  assert.deepEqual(state.usageMetadata, { totalTokenCount: 3 });
});

test('getGoogleImageInlineData 取首个内联图片数据', () => {
  const inlineData = { mimeType: 'image/png', data: 'AAAA' };
  assert.deepEqual(G.getGoogleImageInlineData(payloadWith([{ text: 'x' }, { inlineData }])), inlineData);
  assert.deepEqual(G.getGoogleImageInlineData(payloadWith([{ inline_data: inlineData }])), inlineData);
  assert.equal(G.getGoogleImageInlineData(payloadWith([{ text: 'x' }])), null);
});

test('getGoogleText 拼接所有文本 part', () => {
  assert.equal(G.getGoogleText(payloadWith([{ text: '第一' }, { text: ' 段 ' }, { inlineData: { data: 'x' } }])), '第一 段');
  assert.equal(G.getGoogleText({}), '');
});
