from __future__ import annotations

import json
import sys
import traceback
from typing import Any

from runner import available_checks, run_checks

PROTOCOL_VERSION = "1.0"


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


def _handle_request(request: dict[str, Any]) -> dict[str, Any] | None:
    job_id = str(request.get("job_id") or "").strip()
    version = str(request.get("version") or "").strip()
    action = str(request.get("action") or "").strip()

    if version != PROTOCOL_VERSION:
        return _error_response(job_id, "UNSUPPORTED_PROTOCOL_VERSION", f"不支持的协议版本: {version or '(empty)'}")
    if not job_id:
        return _error_response(job_id, "MISSING_JOB_ID", "请求缺少 job_id")

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
    results = run_checks(input_data)
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
            _write_message(_error_response(str(request.get("job_id") or "") if isinstance(request, dict) else "", "INTERNAL_ERROR", f"{type(error).__name__}: {error}"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
