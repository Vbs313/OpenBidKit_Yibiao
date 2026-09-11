const test = require('node:test');
const assert = require('node:assert/strict');

const U = require('./requestUtils.cjs');

test('trimBaseUrl 去掉首尾空白与尾部斜杠', () => {
  assert.equal(U.trimBaseUrl('  https://api.example.com/v1/  '), 'https://api.example.com/v1');
  assert.equal(U.trimBaseUrl('https://api.example.com///'), 'https://api.example.com');
  assert.equal(U.trimBaseUrl(''), '');
});

test('requireBaseUrl 缺地址时抛错、有地址时归一', () => {
  assert.throws(() => U.requireBaseUrl('', '请先填写 Base URL'), /请先填写 Base URL/);
  assert.equal(U.requireBaseUrl(' https://a.b/v1/ ', 'x'), 'https://a.b/v1');
});

test('isResponseFormatUnsupported 只在同一句话里出现关键字才判真', () => {
  assert.equal(U.isResponseFormatUnsupported('response_format is not supported'), true);
  assert.equal(U.isResponseFormatUnsupported('Unknown parameter: response_format'), true);
  assert.equal(U.isResponseFormatUnsupported('模型不支持该参数'), false);
  assert.equal(U.isResponseFormatUnsupported(''), false);
});

test('超时与请求模式归一', () => {
  assert.equal(U.normalizeRequestTimeoutMs({ timeout_ms: 5000 }), 5000);
  assert.equal(U.normalizeRequestTimeoutMs({ timeout_ms: 0 }), U.AI_REQUEST_TIMEOUT_MS);
  assert.equal(U.normalizeRequestTimeoutMs({}), U.AI_REQUEST_TIMEOUT_MS);
  assert.equal(U.normalizeTextRequestMode({ request_mode: 'normal' }), 'normal');
  assert.equal(U.normalizeTextRequestMode({}), 'stream');
  assert.equal(U.normalizeGoogleImageSize({ image_size: '2K' }), '2K');
  assert.equal(U.normalizeGoogleImageSize({}), '1K');
});

test('imageExtensionFromMime 按 MIME 推断扩展名', () => {
  assert.equal(U.imageExtensionFromMime('image/jpeg'), 'jpg');
  assert.equal(U.imageExtensionFromMime('image/JPG'), 'jpg');
  assert.equal(U.imageExtensionFromMime('image/webp'), 'webp');
  assert.equal(U.imageExtensionFromMime('image/gif'), 'gif');
  assert.equal(U.imageExtensionFromMime('image/bmp'), 'bmp');
  assert.equal(U.imageExtensionFromMime('image/png'), 'png');
  assert.equal(U.imageExtensionFromMime(undefined), 'png');
});

test('safeImageResponse 屏蔽 base64 与 candidates', () => {
  const safe = U.safeImageResponse({
    created: 1,
    data: [{ b64_json: 'AAAA', url: 'https://x/1.png' }],
    candidates: [{ content: 'BBB' }],
  });
  assert.equal(safe.created, 1);
  assert.equal(safe.data[0].b64_json, '[base64 omitted]');
  assert.equal(safe.data[0].url, 'https://x/1.png');
  assert.equal(safe.candidates, '[candidates omitted]');
});

test('copyRawAiErrorResponse 复制原始回包字段', () => {
  const target = {};
  U.copyRawAiErrorResponse({ raw_response_body: 'body', raw_sse_data: 'sse', other: 1 }, target);
  assert.equal(target.raw_response_body, 'body');
  assert.equal(target.raw_sse_data, 'sse');
  assert.equal('other' in target, false);
  assert.doesNotThrow(() => U.copyRawAiErrorResponse(null, {}));
});

test('createAiResponseDataError 带上原始响应数据', () => {
  const error = U.createAiResponseDataError('返回数据格式无效', { data: [] });
  assert.equal(error.message, '返回数据格式无效');
  assert.deepEqual(error.raw_response_data, { data: [] });
});

test('createHeaders 生成 JSON 与 Bearer 头', () => {
  assert.deepEqual(U.createHeaders('sk-1'), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer sk-1',
  });
});

test('createAbortError 标记为可重试的超时错误', () => {
  const error = U.createAbortError();
  assert.equal(error.name, 'AbortError');
  assert.match(error.message, /超时/);
});

test('runWithOperationTimeout 正常返回并在超时后抛错', async () => {
  const value = await U.runWithOperationTimeout(async () => 'ok', 1000);
  assert.equal(value, 'ok');
  await assert.rejects(
    () => U.runWithOperationTimeout(() => new Promise(() => {}), 20),
    /超时/,
  );
});

test('ensureOk 放行成功响应', async () => {
  await assert.doesNotReject(() => U.ensureOk({ ok: true }, '请求失败'));
});
