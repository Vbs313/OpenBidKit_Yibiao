"""通过 B 暴露的本机模型代理调用文本模型。

约定：
- 只接受 model_config（base_url / model / reasoning_effort），永不接受或转发 API Key；
- base_url 必须是回环地址，密钥由 B 侧持有并在代理内注入；
- 失败抛出 LlmUnavailable，由 runner 转成该检查项的错误结果，不影响同批其他检查。
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "[::1]")
DEFAULT_TIMEOUT_S = 120
# 本机模型代理的访问令牌由 B 通过子进程环境注入；它不是模型服务商密钥，也不进协议与日志。
MODEL_TOKEN_ENV = "YIBIAO_COMPLIANCE_MODEL_TOKEN"


class LlmUnavailable(RuntimeError):
    pass


def _loopback_base(base_url: str) -> str:
    value = str(base_url or "").strip().rstrip("/")
    match = re.match(r"^https?://([^/:]+)", value)
    if not match:
        raise LlmUnavailable("model_config.base_url 缺失或不是 http(s) 地址")
    host = match.group(1).lower()
    if host not in LOOPBACK_HOSTS and not host.startswith("127."):
        raise LlmUnavailable("model_config.base_url 只允许指向本机模型代理")
    return value


def _extract_content(payload: dict[str, Any]) -> str:
    choice = (payload.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content
    raise LlmUnavailable("模型未返回可用内容")


def chat_json(model_config: dict[str, Any] | None, messages: list[dict[str, str]], *, timeout_s: int = DEFAULT_TIMEOUT_S) -> tuple[dict[str, Any], str]:
    """请求模型并解析 JSON，返回 (解析结果, 模型名)。"""
    if not isinstance(model_config, dict) or not model_config:
        raise LlmUnavailable("该检查需要模型能力，但请求未提供 model_config")
    base_url = _loopback_base(model_config.get("base_url"))
    model = str(model_config.get("model") or "").strip()
    if not model:
        raise LlmUnavailable("model_config.model 缺失")

    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
        "stream": False,
    }
    if model_config.get("reasoning_effort"):
        body["reasoning_effort"] = str(model_config["reasoning_effort"])

    # 鉴权令牌由 B 通过子进程环境变量下发，只用于访问本机代理；用户配置的 API Key 永不下发到这一侧。
    token = os.environ.get(MODEL_TOKEN_ENV, "")
    if not token:
        raise LlmUnavailable(f"缺少本机模型代理令牌（环境变量 {MODEL_TOKEN_ENV}），请确认 B 已启动合规检查模型代理")

    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:  # noqa: S310 - 仅允许回环地址
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = error.read().decode("utf-8", errors="replace")[:400]
        except Exception:  # noqa: BLE001
            detail = ""
        raise LlmUnavailable(f"模型代理返回 HTTP {error.code}：{detail or error.reason}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise LlmUnavailable(f"本机模型代理不可达：{error}") from error

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise LlmUnavailable(f"模型代理响应不是合法 JSON：{error}") from error

    content = _extract_content(payload)
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.DOTALL)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise LlmUnavailable(f"模型输出不是合法 JSON：{error}") from error
    if not isinstance(parsed, dict):
        raise LlmUnavailable("模型输出根节点必须是 JSON 对象")
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    return parsed, {
        "model": str(payload.get("model") or model),
        "prompt_tokens": int(usage.get("prompt_tokens") or 0),
        "completion_tokens": int(usage.get("completion_tokens") or 0),
    }
