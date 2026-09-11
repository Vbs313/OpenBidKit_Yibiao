const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeImageRequestMode,
  createOpenAICompatibleImageRequestBody,
  appendOpenAICompatibleImagePayload,
} = require('./imagePayloads.cjs');

const makeState = () => ({ images: [], errors: [], completed: null, usage: null });

test('normalizeImageRequestMode 只认显式 normal', () => {
  assert.equal(normalizeImageRequestMode({ request_mode: 'normal' }), 'normal');
  assert.equal(normalizeImageRequestMode({ request_mode: 'stream' }), 'stream');
  assert.equal(normalizeImageRequestMode({}), 'stream');
  assert.equal(normalizeImageRequestMode(null), 'stream');
});

test('非 agnes 服务商请求体带上 model/prompt/size 与 url 回包', () => {
  const body = createOpenAICompatibleImageRequestBody(
    'jinlong',
    { model_name: 'doubao-image', request_mode: 'normal', image_size: '1024x1024' },
    '画一张部署图',
    '',
  );
  assert.deepEqual(body, { model: 'doubao-image', prompt: '画一张部署图', size: '1024x1024', response_format: 'url' });
});

test('非 agnes 流式请求体额外带 stream', () => {
  const body = createOpenAICompatibleImageRequestBody('jinlong', { model_name: 'm', request_mode: 'stream' }, 'p', '');
  assert.equal(body.stream, true);
});

test('请求尺寸优先用调用方传入的值', () => {
  const body = createOpenAICompatibleImageRequestBody('jinlong', { model_name: 'm', image_size: '1024x1024' }, 'p', '2K');
  assert.equal(body.size, '2K');
});

test('agnes 不支持流式请求', () => {
  assert.throws(
    () => createOpenAICompatibleImageRequestBody('agnes', { model_name: 'agnes-image-2.0-flash', request_mode: 'stream' }, 'p', '1024x1024'),
    /仅支持普通请求/,
  );
});

test('agnes 2.0 校验尺寸白名单', () => {
  assert.throws(
    () => createOpenAICompatibleImageRequestBody('agnes', { model_name: 'agnes-image-2.0-flash', request_mode: 'normal' }, 'p', '512x512'),
    /仅支持 1024x768/,
  );
  const ok = createOpenAICompatibleImageRequestBody('agnes', { model_name: 'agnes-image-2.0-flash', request_mode: 'normal' }, 'p', '1024x768');
  assert.equal(ok.size, '1024x768');
  assert.deepEqual(ok.extra_body, { response_format: 'url' });
});

test('agnes 2.1 校验尺寸并补 ratio', () => {
  assert.throws(
    () => createOpenAICompatibleImageRequestBody('agnes', { model_name: 'agnes-image-2.1-flash', request_mode: 'normal' }, 'p', '1024x1024'),
    /1K、2K、3K 或 4K/,
  );
  const ok = createOpenAICompatibleImageRequestBody('agnes', { model_name: 'agnes-image-2.1-flash', request_mode: 'normal', image_ratio: '16:9' }, 'p', '2K');
  assert.equal(ok.size, '2K');
  assert.equal(ok.ratio, '16:9');
});

test('appendOpenAICompatibleImagePayload 累积图片、错误与用量', () => {
  const state = makeState();
  appendOpenAICompatibleImagePayload({ type: 'image_generation.partial_succeeded', url: 'https://x/1.png' }, state);
  appendOpenAICompatibleImagePayload({ type: 'image_generation.partial_failed', image_index: 1, error: { message: '超时', code: 'timeout' } }, state);
  appendOpenAICompatibleImagePayload({ type: 'image_generation.completed', usage: { total_tokens: 3 }, data: [{ b64_json: 'AAA' }] }, state);
  assert.equal(state.images.length, 2);
  assert.equal(state.images[0].url, 'https://x/1.png');
  assert.equal(state.images[1].b64_json, 'AAA');
  assert.equal(state.images[1].mime_type, 'image/png');
  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].message, '超时');
  assert.equal(state.errors[0].code, 'timeout');
  assert.deepEqual(state.usage, { total_tokens: 3 });
  assert.ok(state.completed);
});

test('appendOpenAICompatibleImagePayload 忽略没有 url/b64 的条目', () => {
  const state = makeState();
  appendOpenAICompatibleImagePayload({ data: [{}] }, state);
  assert.equal(state.images.length, 0);
});
