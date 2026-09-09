/**
 * 合规检查专用的常驻本机模型代理。
 *
 * 存在意义：让 Sidecar 能用上用户配置的模型，同时把密钥严格留在 B 侧。
 * - 只监听 127.0.0.1，端口与随机令牌都不写盘、不进协议、不进日志；
 * - 令牌通过子进程环境变量下发（YIBIAO_COMPLIANCE_MODEL_TOKEN），
 *   因此 model_config 里永远只有路由信息，没有凭据；
 * - 转发动作复用 aiService.runAgentChatCompletion，因此重试、排队、统计与 Pi 走同一套出口；
 * - 代理只常驻一次，Sidecar 与页面共享，避免每次检查重新监听端口与回环探测。
 */
const { createAgentOpenAiProxy } = require('../agent/agentOpenAiProxy.cjs');
const { compactLogError, createDeveloperLogger } = require('../../utils/developerLog.cjs');
const perfTrace = require('../../utils/perfTrace.cjs');

const RUNTIME = Object.freeze({
  id: 'compliance',
  displayName: '合规检查模型代理',
  description: '供 Python Sidecar 调用的本机 OpenAI 兼容代理。',
});

/** 令牌只在内存与子进程环境中流转，不写盘、不进协议、不进日志。 */
const MODEL_TOKEN_ENV = 'YIBIAO_COMPLIANCE_MODEL_TOKEN';

function createComplianceModelProxy({ app, aiService, configStore } = {}) {
  let proxy = null;
  let proxyInfo = null;
  let startPromise = null;
  let closing = false;
  let stats = { requests: 0, failed: 0, retried: 0, lastError: '' };

  const logger = createDeveloperLogger({
    app,
    config: configStore?.load?.() || {},
    moduleName: 'compliance-model-proxy',
    name: 'compliance-model-proxy',
  });

  function writeLog(event, payload = {}) {
    logger.write(event, payload);
  }

  async function start() {
    if (proxy && proxyInfo) return proxyInfo;
    if (closing) {
      const error = new Error('合规检查模型代理已关闭');
      error.code = 'COMPLIANCE_MODEL_PROXY_CLOSED';
      throw error;
    }
    if (startPromise) return startPromise;

    startPromise = (async () => {
      const nextProxy = createAgentOpenAiProxy({
        app,
        aiService,
        runtime: RUNTIME,
        normalRequestTimeoutMs: 15 * 60 * 1000,
        streamIdleTimeoutMs: 5 * 60 * 1000,
        diagnostics: { record: (event, payload) => writeLog(`proxy.${event}`, payload || {}) },
        onActivity: (event = {}) => {
          if (event.source === 'proxy.chat.received') stats.requests += 1;
          if (event.source === 'proxy.chat.failed') {
            stats.failed += 1;
            stats.lastError = String(event?.meta?.error || '模型代理请求失败');
          }
          if (event.source === 'proxy.chat.retried') stats.retried += 1;
        },
        getActivityContext: () => null,
        verifyLoopback: true,
        loopbackHosts: ['127.0.0.1'],
      });
      const info = await perfTrace.time('compliance', 'proxy_start', () => nextProxy.start());
      proxy = nextProxy;
      proxyInfo = {
        base_url: `${info.baseUrl}/v1`,
        port: Number(info.port) || 0,
        host: String(info.host || '127.0.0.1'),
        token: String(info.token || ''),
        started_at: new Date().toISOString(),
      };
      writeLog('proxy.started', { base_url: proxyInfo.base_url, port: proxyInfo.port });
      return proxyInfo;
    })().catch(async (error) => {
      writeLog('proxy.start_failed', { error: compactLogError(error) });
      try { await proxy?.close?.(); } catch { /* ignore */ }
      proxy = null;
      proxyInfo = null;
      throw error;
    }).finally(() => {
      startPromise = null;
    });

    return startPromise;
  }

  async function stop() {
    closing = true;
    if (startPromise) await startPromise.catch(() => undefined);
    const current = proxy;
    proxy = null;
    proxyInfo = null;
    if (!current) return;
    try {
      await current.close();
      writeLog('proxy.stopped', {});
    } catch (error) {
      writeLog('proxy.stop_failed', { error: compactLogError(error) });
    }
  }

  /** 需要接入信息（含令牌）的调用方统一走这里：幂等启动，避免与首次检查竞态。 */
  async function getInfo() {
    if (closing) return null;
    try {
      const info = await start();
      return { ...info };
    } catch (error) {
      writeLog('proxy.info_failed', { error: compactLogError(error) });
      return null;
    }
  }

  /** 需要 base_url 的调用方统一走这里，顺带完成冷启动，避免与首次检查竞态。 */
  async function ensureBaseUrl() {
    if (closing) return '';
    try {
      const info = await start();
      return info.base_url || '';
    } catch (error) {
      writeLog('proxy.ensure_failed', { error: compactLogError(error) });
      return '';
    }
  }

  function getToken() {
    return proxyInfo?.token || '';
  }

  /** 交给 Sidecar 的环境变量：只有本机代理令牌，没有任何模型服务商密钥。 */
  function childEnv() {
    const token = getToken();
    return token ? { [MODEL_TOKEN_ENV]: token } : {};
  }

  /**
   * 交给 Sidecar 的模型路由信息。刻意只含路由字段：
   * base_url 必为回环地址，令牌走环境变量，密钥永不进协议。
   */
  async function buildModelConfig() {
    const config = configStore?.load?.() || {};
    const model = String(config.model_name || '').trim();
    const baseUrl = await ensureBaseUrl();
    if (!baseUrl) return undefined;
    const next = { base_url: baseUrl };
    if (model) next.model = model;
    return next;
  }

  function getStatus() {
    return {
      started: Boolean(proxy && proxyInfo),
      base_url: proxyInfo?.base_url || '',
      port: proxyInfo?.port || 0,
      requests: stats.requests,
      failed: stats.failed,
      retried: stats.retried,
      last_error: stats.lastError,
      started_at: proxyInfo?.started_at || '',
    };
  }

  function resetStats() {
    stats = { requests: 0, failed: 0, retried: 0, lastError: '' };
  }

  async function close() {
    await stop();
  }

  return {
    MODEL_TOKEN_ENV,
    RUNTIME,
    buildModelConfig,
    childEnv,
    close,
    ensureBaseUrl,
    getInfo,
    getStatus,
    resetStats,
    start,
    stop,
    token: getToken,
  };
}

module.exports = {
  MODEL_TOKEN_ENV,
  RUNTIME,
  createComplianceModelProxy,
};
