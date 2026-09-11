const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('./streamReading.cjs');

function makeResponse(chunks) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length
          ? { value: encoder.encode(chunks[index++]), done: false }
          : { value: undefined, done: true }),
      }),
    },
  };
}

test('appendStreamChoiceContent 按 delta→message→text 优先级取值', () => {
  const parts = [];
  S.appendStreamChoiceContent({ delta: { content: 'A' } }, parts);
  S.appendStreamChoiceContent({ message: { content: 'B' } }, parts);
  S.appendStreamChoiceContent({ text: 'C' }, parts);
  S.appendStreamChoiceContent({ delta: { content: 123 } }, parts);
  assert.deepEqual(parts, ['A', 'B', 'C']);
});

test('readSseJsonDataLine 跳过注释与非 data 行，遇 [DONE] 标记结束', async () => {
  const state = { done: false };
  const seen = [];
  const options = { onPayload: (payload) => { seen.push(payload); } };
  await S.readSseJsonDataLine('', state, options);
  await S.readSseJsonDataLine(': keep-alive', state, options);
  await S.readSseJsonDataLine('event: message', state, options);
  await S.readSseJsonDataLine('data:', state, options);
  await S.readSseJsonDataLine('data: {"a":1}', state, options);
  assert.equal(state.done, false);
  assert.deepEqual(seen, [{ a: 1 }]);
  await S.readSseJsonDataLine('data: [DONE]', state, options);
  assert.equal(state.done, true);
  assert.equal(seen.length, 1);
});

test('readSseJsonDataLine 对坏 JSON 与负载错误抛可重试错误', async () => {
  const state = { done: false };
  await assert.rejects(
    () => S.readSseJsonDataLine('data: {oops', state, { parseErrorMessage: 'AI 流式响应解析失败' }),
    /AI 流式响应解析失败/,
  );
  await assert.rejects(
    () => S.readSseJsonDataLine('data: {"error":{"message":"限流"}}', state, { failureMessage: 'AI 流式请求失败' }),
    /限流/,
  );
  // throwOnPayloadError === false 时忽略错误负载
  const seen = [];
  await S.readSseJsonDataLine('data: {"error":{"message":"限流"}}', state, { throwOnPayloadError: false, onPayload: (p) => seen.push(p) });
  assert.equal(seen.length, 1);
});

test('readSseJsonStream 跨分片拼接并按行解析', async () => {
  const response = makeResponse(['data: {"cho', 'ices":[{"delta":{"content":"A"}}]}\n', 'data: [DONE]\n']);
  const payloads = [];
  await S.readSseJsonStream(response, { onPayload: (payload) => payloads.push(payload) });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].choices[0].delta.content, 'A');
});

test('readSseJsonStream 响应不可读时抛可重试错误', async () => {
  await assert.rejects(() => S.readSseJsonStream({}, {}), /AI 流式响应不可读/);
});

test('readOpenAIChatStream 累积正文与用量并给出普通响应结构', async () => {
  const response = makeResponse([
    'data: {"choices":[{"delta":{"content":"第一"}}]}\n',
    'data: {"choices":[{"delta":{"content":"段"}}],"usage":{"total_tokens":7}}\n',
    'data: [DONE]\n',
  ]);
  const result = await S.readOpenAIChatStream(response);
  assert.equal(result.content, '第一段');
  assert.deepEqual(result.usage, { total_tokens: 7 });
  assert.equal(result.responseData.stream, true);
  assert.equal(result.responseData.choices[0].message.content, '第一段');
});
