const assert = require('node:assert/strict');
const test = require('node:test');
const { MODEL_TOKEN_ENV, createComplianceModelProxy } = require('./complianceModelProxy.cjs');

function makeStubAiService(calls) {
  return {
    // 真实契约：request.body + consumeResponse(response) 返回 { responseData, usage }。
    async runAgentChatCompletion({ body, consumeResponse }) {
      calls.push(body);
      const payload = JSON.stringify({
        id: 'chatcmpl-stub',
        model: body.model,
        choices: [{ message: { role: 'assistant', content: '{"items":[]}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      });
      const response = new Response(payload, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      const consumed = await consumeResponse(response, {
        config: { base_url: 'http://stub.invalid/v1', model_name: body.model },
        requestBody: body,
        requestId: 'stub-request',
      });
      return {
        responseData: consumed?.responseData ?? null,
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      };
    },
  };
}

async function post(baseUrl, token, body) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

test('compliance model proxy authenticates by loopback token and never leaks credentials', async (t) => {
  const calls = [];
  const service = createComplianceModelProxy({
    app: { getPath: () => process.env.TEMP || '.' },
    aiService: makeStubAiService(calls),
    configStore: { load: () => ({ model_name: 'test-model', api_key: 'sk-must-not-travel' }) },
  });
  t.after(() => service.close());

  assert.equal(service.getStatus().started, false, '未启动前不应标记为已启动');
  assert.equal(service.token(), '', '未启动时没有令牌');

  const info = await service.getInfo();
  assert.ok(info, 'getInfo 必须返回接入信息');
  assert.match(info.base_url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/, '只允许回环地址');
  assert.equal(typeof info.token, 'string');
  assert.ok(info.token.length >= 24, '令牌必须足够长');
  assert.equal(await service.ensureBaseUrl(), info.base_url);
  assert.equal(await service.ensureBaseUrl(), info.base_url, '第二次调用必须复用同一代理');
  assert.equal(service.getStatus().started, true);
  assert.equal(service.getStatus().port, info.port);

  // 协议侧只拿得到路由信息，令牌走子进程环境变量。
  const modelConfig = await service.buildModelConfig();
  assert.deepEqual(Object.keys(modelConfig).sort(), ['base_url', 'model']);
  assert.equal(modelConfig.base_url, info.base_url);
  assert.equal(modelConfig.model, 'test-model');
  assert.ok(!JSON.stringify(modelConfig).includes('sk-must-not-travel'), 'model_config 不得包含密钥');
  assert.ok(!JSON.stringify(modelConfig).includes(info.token), 'model_config 不得包含令牌');

  const env = service.childEnv();
  assert.deepEqual(Object.keys(env), [MODEL_TOKEN_ENV]);
  assert.equal(env[MODEL_TOKEN_ENV], info.token);

  const noAuth = await post(info.base_url, '', { model: 'm', messages: [] });
  assert.equal(noAuth.status, 401, '缺少令牌必须拒绝');
  const badAuth = await post(info.base_url, 'wrong-token', { model: 'm', messages: [] });
  assert.equal(badAuth.status, 401);
  assert.ok(!badAuth.text.includes(info.token), '错误响应不得回显令牌');
  // 鉴权失败的请求必须在代理层短路，不能消耗模型调用。
  assert.equal(calls.length, 0, '未通过鉴权的请求不得转发到 aiService');

  const ok = await post(info.base_url, info.token, {
    model: 'caller-model',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_object' },
    stream: false,
  });
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'caller-model');
  assert.equal(calls[0].response_format.type, 'json_object');
  assert.ok(!('api_key' in calls[0]), '不接受凭据字段');
  assert.ok(!ok.text.includes('sk-must-not-travel'), '响应不得包含密钥');

  const status = service.getStatus();
  // 401 不进入 chat 处理，因此计数只统计真正被接走的请求。
  assert.equal(status.requests, 1, 'chat 计数只统计通过鉴权的请求');
  assert.equal(status.failed, 0);
  assert.ok(status.started_at, '必须记录代理启动时间');
  service.resetStats();
  assert.equal(service.getStatus().requests, 0);

  await service.close();
  assert.equal(service.getStatus().started, false);
  assert.equal(service.token(), '');
  assert.equal(await service.ensureBaseUrl(), '', '关闭后不再返回可用地址');
  assert.equal(service.childEnv()[MODEL_TOKEN_ENV], undefined);
});
