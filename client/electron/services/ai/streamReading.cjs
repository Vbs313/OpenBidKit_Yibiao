// SSE / 流式回包读取：逐行解析 `data:` 负载、累积流式增量内容，并统一成与普通请求一致的返回结构。
//
// 这些原本是 aiService.cjs 的模块级函数；搬出来后只依赖同目录的错误文案归一工具，可单独测试。

const { markAiRequestError } = require('../../utils/aiRetry.cjs');
const { normalizeStreamPayloadError } = require('./streamErrors.cjs');

function appendStreamChoiceContent(choice, contentParts) {
  const deltaContent = choice?.delta?.content;
  const messageContent = choice?.message?.content;
  const textContent = choice?.text;

  if (typeof deltaContent === 'string') {
    contentParts.push(deltaContent);
    return;
  }

  if (typeof messageContent === 'string') {
    contentParts.push(messageContent);
    return;
  }

  if (typeof textContent === 'string') {
    contentParts.push(textContent);
  }
}

async function readSseJsonDataLine(line, state, options) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
    return;
  }

  const data = trimmed.slice(5).trim();
  if (!data) {
    return;
  }

  if (data === '[DONE]') {
    state.done = true;
    return;
  }

  let payload = null;
  try {
    payload = JSON.parse(data);
  } catch (error) {
    const parseError = new Error(`${options.parseErrorMessage || 'AI 流式响应解析失败'}：${error.message}`);
    parseError.raw_response_body = data;
    throw markAiRequestError(parseError, { retryable: true });
  }

  if (payload?.error && options.throwOnPayloadError !== false) {
    const streamError = new Error(normalizeStreamPayloadError(payload.error, options.failureMessage || 'AI 流式请求失败'));
    streamError.raw_response_payload = payload;
    streamError.raw_sse_data = data;
    throw markAiRequestError(streamError, { retryable: true });
  }

  await Promise.resolve(options.onPayload?.(payload));
}

async function readSseJsonStream(response, options = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw markAiRequestError(new Error(options.unreadableMessage || 'AI 流式响应不可读'), { retryable: true });
  }

  const decoder = new TextDecoder('utf-8');
  const state = { done: false };
  let buffer = '';

  while (!state.done) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      await readSseJsonDataLine(line, state, options);
      if (state.done) {
        break;
      }
    }
  }

  buffer += decoder.decode();
  if (!state.done && buffer.trim()) {
    const lines = buffer.split(/\r?\n/);
    for (const line of lines) {
      await readSseJsonDataLine(line, state, options);
      if (state.done) {
        break;
      }
    }
  }
}

async function readOpenAIChatStream(response) {
  const state = { usage: null, contentParts: [] };

  await readSseJsonStream(response, {
    unreadableMessage: 'AI 流式响应不可读',
    parseErrorMessage: 'AI 流式响应解析失败',
    failureMessage: 'AI 流式请求失败',
    onPayload(payload) {
      if (payload?.usage) {
        state.usage = payload.usage;
      }

      const choices = Array.isArray(payload?.choices) ? payload.choices : [];
      choices.forEach((choice) => appendStreamChoiceContent(choice, state.contentParts));
    },
  });

  const content = state.contentParts.join('');
  return {
    content,
    usage: state.usage,
    responseData: {
      stream: true,
      choices: [{ message: { content } }],
      usage: state.usage,
    },
  };
}

module.exports = {
  appendStreamChoiceContent,
  readSseJsonDataLine,
  readSseJsonStream,
  readOpenAIChatStream,
};
