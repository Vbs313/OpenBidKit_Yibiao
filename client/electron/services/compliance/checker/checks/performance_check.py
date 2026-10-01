"""业绩要求核查（确定性规则检查，不调用 LLM）。

覆盖：
1. 招标文件是否声明业绩要求（类似业绩/合同金额/数量）；
2. 投标文件是否响应业绩要求；
3. 业绩要求中的金额/数量门槛是否被投标文件满足；
4. 同一份投标文件中出现互相冲突的业绩声明；
5. 业绩要求无法解析时给出提醒而不是误判。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from checks.document_text import read_document_text

CHECK_ID = "performance"
CHECK_NAME = "业绩要求核查"

# 业绩要求声明：「近三年完成类似业绩不少于 X 项」「合同金额不低于 Y 万元」
PERFORMANCE_REQUIREMENT = re.compile(
    r"(类似业绩|合同业绩|项目业绩|业绩)[^0-9\n]{0,12}?(不少于|不低于|至少|不得少于|≥|>=)[^0-9\n]{0,6}(\d{1,4})\s*(?:项|个|家)"
)
AMOUNT_REQUIREMENT = re.compile(
    r"(合同金额|业绩金额|单项合同|合同额)[^0-9\n]{0,12}?(不少于|不低于|至少|不得少于|≥|>=)[^0-9\n]{0,6}(\d{1,4}(?:\.\d{1,2})?)\s*(万元|万|元)"
)
# 投标文件响应：「我方近三年完成类似业绩 X 项」「合同金额 Y 万元」
PERFORMANCE_RESPONSE = re.compile(
    r"(类似业绩|合同业绩|项目业绩|业绩)[^0-9\n]{0,12}?(共|合计|完成|达到|有)[^0-9\n]{0,6}(\d{1,4})\s*(?:项|个|家)"
)
AMOUNT_RESPONSE = re.compile(
    r"(合同金额|业绩金额|单项合同|合同额)[^0-9\n]{0,12}?(共|合计|达到|为|是)[^0-9\n]{0,6}(\d{1,4}(?:\.\d{1,2})?)\s*(万元|万|元)"
)
# 冲突声明检测：同一文件出现多个不同数量/金额
CONFLICT_LABEL = re.compile(r"(类似业绩|合同业绩|项目业绩|业绩)[^0-9\n]{0,12}")


def _read_text(path: Any) -> str:
    value = str(path or "").strip()
    if not value:
        return ""
    try:
        return Path(value).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _normalize_text(value: Any) -> str:
    return re.sub(r"\s+", "", str(value if value is not None else "")).strip()


def _to_number(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def run_performance_check(params: dict[str, Any]) -> dict[str, Any]:
    """执行业绩要求核查。params: { tender_path, bid_path }。"""
    tender_text = _normalize_text(_read_text(params.get("tender_path")))
    bid_text = _normalize_text(_read_text(params.get("bid_path")))

    findings: list[dict[str, Any]] = []
    skipped = False

    if not tender_text:
        skipped = True
        findings.append({
            "level": "warn",
            "message": "招标文件为空或无法读取，跳过业绩要求核查。",
        })

    # 1. 提取招标业绩要求
    required_count = None
    required_amount = None
    for match in PERFORMANCE_REQUIREMENT.finditer(tender_text):
        required_count = _to_number(match.group(3))
        break
    for match in AMOUNT_REQUIREMENT.finditer(tender_text):
        required_amount = _to_number(match.group(3))
        break

    if not skipped and required_count is None and required_amount is None:
        findings.append({
            "level": "info",
            "message": "招标文件未明确声明业绩要求，无需核查。",
        })

    # 2. 提取投标响应
    bid_count = None
    bid_amount = None
    for match in PERFORMANCE_RESPONSE.finditer(bid_text):
        bid_count = _to_number(match.group(3))
        break
    for match in AMOUNT_RESPONSE.finditer(bid_text):
        bid_amount = _to_number(match.group(3))
        break

    # 3. 核查数量门槛
    if required_count is not None:
        if bid_count is None:
            findings.append({
                "level": "warn",
                "message": f"招标要求类似业绩不少于 {required_count:g} 项，投标文件未声明业绩数量。",
            })
        elif bid_count < required_count:
            findings.append({
                "level": "error",
                "message": f"招标要求类似业绩不少于 {required_count:g} 项，投标文件仅声明 {bid_count:g} 项，不满足要求。",
            })

    # 4. 核查金额门槛
    if required_amount is not None:
        if bid_amount is None:
            findings.append({
                "level": "warn",
                "message": f"招标要求合同金额不低于 {required_amount:g} 万元，投标文件未声明合同金额。",
            })
        elif bid_amount < required_amount:
            findings.append({
                "level": "error",
                "message": f"招标要求合同金额不低于 {required_amount:g} 万元，投标文件仅声明 {bid_amount:g} 万元，不满足要求。",
            })

    # 5. 冲突声明检测（数量）
    count_values = [int(m.group(3)) for m in PERFORMANCE_RESPONSE.finditer(bid_text)]
    if len(set(count_values)) > 1:
        findings.append({
            "level": "warn",
            "message": f"投标文件中出现多个不一致的业绩数量声明：{sorted(set(count_values))}。",
        })

    has_error = any(f["level"] == "error" for f in findings)
    has_warn = any(f["level"] == "warn" for f in findings)
    status = "failed" if has_error else ("warned" if has_warn else "passed")

    return {
        "check_id": CHECK_ID,
        "check_name": CHECK_NAME,
        "status": status,
        "skipped": skipped,
        "findings": findings,
    }
