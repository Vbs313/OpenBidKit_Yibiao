const test = require('node:test');
const assert = require('node:assert/strict');

const { trackAiRequest } = require('./requestTracking.cjs');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('trackAiRequest 上报文本请求的模型与用量', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true }; };
  try {
    trackAiRequest(
      { getVersion: () => '9.9.9' },
      {
        base_url: 'https://api.example.com/v1',
        model_name: 'gpt-x',
        text_model_provider: 'openai',
        analytics_client_id: 'cid',
        analytics_created_at: '2026-01-01',
      },
      { ai_request_type: 'text', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    );
    await flush();
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /analytics/);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.ai_request_type, 'text');
    assert.equal(body.ai_model_name, 'gpt-x');
    assert.equal(body.ai_model_provider, 'openai');
    assert.equal(body.prompt_tokens, 10);
    assert.equal(body.total_tokens, 15);
    assert.equal(body.text_model_name, 'gpt-x');
    assert.equal(body.image_model_name, '');
    assert.equal(body.version, '9.9.9');
    assert.equal(body.client_id, 'cid');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('trackAiRequest 上报图片请求时取图片模型配置', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true }; };
  try {
    trackAiRequest(
      { getVersion: () => '1.0.0' },
      { image_model: { provider: 'jinlong', base_url: 'https://img.example.com/v1', model_name: 'doubao-image' } },
      { ai_request_type: 'image' },
    );
    await flush();
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.ai_request_type, 'image');
    assert.equal(body.ai_model_provider, 'jinlong');
    assert.equal(body.ai_model_name, 'doubao-image');
    assert.equal(body.image_model_name, 'doubao-image');
    assert.equal(body.text_model_name, '');
    assert.equal(body.total_tokens, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('trackAiRequest 上报失败不影响调用方', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('网络不可用'); };
  try {
    assert.doesNotThrow(() => trackAiRequest({}, {}, { ai_request_type: 'text' }));
    await flush();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('trackAiRequest 缺省 app 版本时留空而不是抛错', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return {}; };
  try {
    trackAiRequest(null, {}, { ai_request_type: 'text' });
    await flush();
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.version, '');
    assert.equal(body.platform, process.platform);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
