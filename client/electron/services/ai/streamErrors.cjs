// 流式回包里的错误文案归一：把字符串 / 对象 / 空值统一成一句可展示的错误信息。
// 纯函数，不接触网络、文件或服务状态，可单独测试。

function normalizeStreamPayloadError(error, fallbackMessage) {
  if (!error) {
    return fallbackMessage;
  }

  if (typeof error === 'string') {
    return error;
  }

  return error.message || error.code || fallbackMessage;
}

module.exports = { normalizeStreamPayloadError };
