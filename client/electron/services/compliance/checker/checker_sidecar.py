from __future__ import annotations

import json
import re
import sys
import traceback
from typing import Any

from runner import available_checks, run_checks

PROTOCOL_VERSION = "1.0"
MODEL_CONFIG_FIELDS = ("base_url", "model", "reasoning_effort")
CREDENTIAL_FIELD_PATTERN = re.compile(
    r"^(api[-_ ]?key|apikey|access[-_ ]?key|secret[-_ ]?key|authorization|auth|token|bearer|x-api-key)$",
    re.IGNORECASE,
)
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _write_message(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _error_response(job_id: str, code: str, message: str, detail: str | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if detail:
        error["detail"] = detail
    return {
        "version": PROTOCOL_VERSION,
        "job_id": job_id,
        "status": "error",
        "results": [],
        "error": error,
    }


def _find_credential_field(value: Any) -> str:
    if isinstance(value, dict):
        for key, item in value.items():
            if CREDENTIAL_FIELD_PATTERN.match(str(key)):
                return str(key)
            nested = _find_credential_field(item)
            if nested:
                return nested
    elif isinstance(value, list):
        for item in value:
            nested = _find_credential_field(item)
            if nested:
                return nested
    return ""


def _is_loopback_base_url(base_url: str) -> bool:
    match = re.match(r"^https?://([^/:]+)", base_url)
    if not match:
        return False
    host = match.group(1).lower()
    return host in LOOPBACK_HOSTS or host.startswith("127.")


def _normalize_model_config(raw: Any) -> tuple[dict[str, Any] | None, str]:
    """校验 model_config；返回 (配置, 错误消息)。Sidecar 不信任上游，重复校验。"""
    if raw is None:
        return None, ""
    if not isinstance(raw, dict):
        return None, "model_config 必须是对象"
    credential = _find_credential_field(raw)
    if credential:
        return None, f"model_config 含凭据字段 {credential}，合规检查协议不接受任何 API Key"
    unknown = [key for key in raw if key not in MODEL_CONFIG_FIELDS]
    if unknown:
        return None, f"model_config 含不支持的字段: {', '.join(sorted(str(key) for key in unknown))}"
    normalized: dict[str, Any] = {}
    for key in MODEL_CONFIG_FIELDS:
        if key not in raw:
            continue
        value = str(raw[key] or "").strip()
        if not value:
            return None, f"model_config.{key} 不能为空"
        if key == "base_url" and not _is_loopback_base_url(value):
            return None, "model_config.base_url 只允许指向本机回环地址的本地模型代理"
        normalized[key] = value
    return (normalized or None), ""


def _handle_request(request: dict[str, Any]) -> dict[str, Any] | None:
    job_id = str(request.get("job_id") or "").strip()
    version = str(request.get("version") or "").strip()
    action = str(request.get("action") or "").strip()

    if version != PROTOCOL_VERSION:
        return _error_response(job_id, "UNSUPPORTED_PROTOCOL_VERSION", f"不支持的协议版本: {version or '(empty)'}")
    if not job_id:
        return _error_response(job_id, "MISSING_JOB_ID", "请求缺少 job_id")

    credential = _find_credential_field(request)
    if credential:
        return _error_response(job_id, "CREDENTIAL_FIELD_FORBIDDEN", f"请求含凭据字段 {credential}，合规检查协议不接受任何 API Key")

    if action == "ping":
        return {
            "version": PROTOCOL_VERSION,
            "job_id": job_id,
            "status": "success",
            "results": [],
            "message": "pong",
            "checks": available_checks(),
        }
    if action == "shutdown":
        return {
            "version": PROTOCOL_VERSION,
            "job_id": job_id,
            "status": "success",
            "results": [],
            "message": "shutdown",
        }
    if action != "run_checks":
        return _error_response(job_id, "UNKNOWN_ACTION", f"未知 action: {action or '(empty)'}")

    input_data = request.get("input") or {}
    if not isinstance(input_data, dict):
        return _error_response(job_id, "INVALID_INPUT", "input 必须是对象")
    model_config, model_config_error = _normalize_model_config(request.get("model_config"))
    if model_config_error:
        return _error_response(job_id, "INVALID_MODEL_CONFIG", model_config_error)
    results = run_checks(input_data, model_config)
    return {
        "version": PROTOCOL_VERSION,
        "job_id": job_id,
        "status": "success",
        "results": results,
    }


def main() -> int:
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    request: Any = None
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                _write_message(_error_response("", "INVALID_REQUEST", "请求必须是 JSON 对象"))
                continue
            response = _handle_request(request)
            if response is not None:
                _write_message(response)
            if str(request.get("action") or "").strip() == "shutdown":
                return 0
        except json.JSONDecodeError as error:
            _write_message(_error_response("", "INVALID_JSON", f"JSON 解析失败: {error}", line[:500]))
        except Exception as error:  # noqa: BLE001 - Sidecar 必须持续运行，错误通过协议返回
            traceback.print_exc(file=sys.stderr)
            job_id = str(request.get("job_id") or "") if isinstance(request, dict) else ""
            _write_message(_error_response(job_id, "INTERNAL_ERROR", f"{type(error).__name__}: {error}"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
