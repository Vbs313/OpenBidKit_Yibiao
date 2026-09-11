const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('./textChat.cjs');

test('createChatRequestBody 映射废弃模型并带上消息', () => {
  const body = T.createChatRequestBody({ model_name: 'codex-auto-review' }, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.model, 'gpt-5.6-terra');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal('temperature' in body, false);
  assert.equal('stream' in body, false);
});

test('createChatRequestBody 按配置补温度、思考强度与流式标记', () => {
  const body = T.createChatRequestBody(
    { model_name: 'gpt-x', temperature_enabled: true, temperature: 0.3, reasoning_effort: 'high' },
    { messages: [] },
    { stream: true },
  );
  assert.equal(body.temperature, 0.3);
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.stream, true);
});

test('createChatRequestBody 传递 response_format 但可显式省略', () => {
  const format = { type: 'json_object' };
  assert.deepEqual(T.createChatRequestBody({ model_name: 'm' }, { messages: [], response_format: format }).response_format, format);
  assert.equal('response_format' in T.createChatRequestBody({ model_name: 'm' }, { messages: [], response_format: format }, { omitResponseFormat: true }), false);
});

test('createAgentChatRequestBody 缺少消息时抛错', () => {
  assert.throws(() => T.createAgentChatRequestBody({ model_name: 'm' }, {}), /缺少 messages/);
  assert.throws(() => T.createAgentChatRequestBody({ model_name: 'm' }, { messages: [] }), /缺少 messages/);
});

test('createAgentChatRequestBody 覆盖模型并清理上游不认的长度参数', () => {
  const body = T.createAgentChatRequestBody(
    { model_name: 'gpt-x', request_mode: 'stream' },
    { messages: [{ role: 'user', content: 'a' }], max_tokens: 100, max_output_tokens: 200, max_completion_tokens: 300, stream_options: { include_usage: true } },
  );
  assert.equal(body.model, 'gpt-x');
  assert.equal(body.stream, true);
  assert.equal('max_tokens' in body, false);
  assert.equal('max_output_tokens' in body, false);
  assert.equal('max_completion_tokens' in body, false);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('createAgentChatRequestBody 非流式时去掉 stream 与 stream_options', () => {
  const body = T.createAgentChatRequestBody(
    { model_name: 'm', request_mode: 'normal' },
    { messages: [{ role: 'user', content: 'a' }], stream_options: { include_usage: true } },
  );
  assert.equal(body.stream, false);
  assert.equal('stream_options' in body, false);
});

test('createAgentChatRequestBody 按开关清理温度与思考强度', () => {
  const off = T.createAgentChatRequestBody(
    { model_name: 'm', request_mode: 'stream' },
    { messages: [{ role: 'user', content: 'a' }], temperature: 1, reasoning_effort: 'low' },
  );
  assert.equal('temperature' in off, false);
  assert.equal('reasoning_effort' in off, false);
  const on = T.createAgentChatRequestBody(
    { model_name: 'm', request_mode: 'stream', temperature_enabled: true, temperature: 0.5, reasoning_effort: 'medium' },
    { messages: [{ role: 'user', content: 'a' }] },
  );
  assert.equal(on.temperature, 0.5);
  assert.equal(on.reasoning_effort, 'medium');
});
