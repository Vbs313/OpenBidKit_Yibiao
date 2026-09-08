from __future__ import annotations

from typing import Any, Callable

from checks.pricing_arithmetic import CHECK_ID as PRICING_ARITHMETIC_ID
from checks.pricing_arithmetic import CHECK_NAME as PRICING_ARITHMETIC_NAME
from checks.pricing_arithmetic import run_pricing_arithmetic
from checks.deposit_check import CHECK_ID as DEPOSIT_ID
from checks.deposit_check import CHECK_NAME as DEPOSIT_NAME
from checks.deposit_check import run_deposit_check
from checks.validity_check import CHECK_ID as VALIDITY_ID
from checks.validity_check import CHECK_NAME as VALIDITY_NAME
from checks.validity_check import run_validity_check

CheckRunner = Callable[[dict[str, Any]], dict[str, Any]]

# requires_model 为 True 的检查必须拿到 model_config，否则会返回明确的跳过结果。
CHECK_REGISTRY: dict[str, dict[str, Any]] = {
    PRICING_ARITHMETIC_ID: {
        "name": PRICING_ARITHMETIC_NAME,
        "runner": run_pricing_arithmetic,
        "requires_model": False,
    },
    VALIDITY_ID: {
        "name": VALIDITY_NAME,
        "runner": run_validity_check,
        "requires_model": False,
    },
    DEPOSIT_ID: {
        "name": DEPOSIT_NAME,
        "runner": run_deposit_check,
        "requires_model": False,
    },
}


def available_checks() -> list[dict[str, Any]]:
    return [
        {
            "check_id": check_id,
            "check_name": item["name"],
            "requires_model": bool(item.get("requires_model")),
        }
        for check_id, item in CHECK_REGISTRY.items()
    ]


def _error_result(check_id: str, message: str) -> dict[str, Any]:
    check_name = CHECK_REGISTRY.get(check_id, {}).get("name") or check_id
    return {
        "check_id": check_id,
        "check_name": check_name,
        "status": "error",
        "severity": "critical",
        "summary": message,
        "metrics": {"total": 1, "passed": 0, "failed": 1, "warning": 0},
        "findings": [
            {
                "id": f"{check_id}:error",
                "code": "CHECK_EXECUTION_ERROR",
                "title": "检查执行失败",
                "message": message,
                "severity": "critical",
                "evidence": "",
                "suggestion": "请检查输入文件和 Sidecar 日志后重试。",
                "location": {"file": None, "line": None},
            }
        ],
        "usage": {"model": None, "prompt_tokens": 0, "completion_tokens": 0},
    }


def _skip_result(check_id: str, message: str) -> dict[str, Any]:
    check_name = CHECK_REGISTRY.get(check_id, {}).get("name") or check_id
    return {
        "check_id": check_id,
        "check_name": check_name,
        "status": "warning",
        "severity": "minor",
        "summary": message,
        "metrics": {"total": 1, "passed": 0, "failed": 0, "warning": 1},
        "findings": [
            {
                "id": f"{check_id}:skipped",
                "code": "CHECK_SKIPPED_MODEL_UNAVAILABLE",
                "title": "检查已跳过",
                "message": message,
                "severity": "minor",
                "evidence": "",
                "suggestion": "请在 B 端配置文本模型与本地模型代理后重试。",
                "location": {"file": None, "line": None},
            }
        ],
        "usage": {"model": None, "prompt_tokens": 0, "completion_tokens": 0},
    }


def run_checks(input_data: dict[str, Any], model_config: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    requested = input_data.get("checks") or list(CHECK_REGISTRY.keys())
    if not isinstance(requested, list) or not requested:
        requested = list(CHECK_REGISTRY.keys())

    payload = dict(input_data)
    if isinstance(model_config, dict) and model_config:
        payload["model_config"] = model_config

    results: list[dict[str, Any]] = []
    for raw_check_id in requested:
        check_id = str(raw_check_id or "").strip()
        if not check_id:
            continue
        check = CHECK_REGISTRY.get(check_id)
        if not check:
            results.append(_error_result(check_id, f"未知检查项: {check_id}"))
            continue
        if check.get("requires_model") and not payload.get("model_config"):
            results.append(_skip_result(check_id, "该检查需要模型能力，但本次请求未提供 model_config。"))
            continue
        try:
            results.append(check["runner"](payload))
        except Exception as error:  # noqa: BLE001 - 单个检查失败不能中断后续任务
            results.append(_error_result(check_id, f"{type(error).__name__}: {error}"))
    return results
