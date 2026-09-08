"""投标有效期核查（确定性规则检查，不调用 LLM）。

覆盖：
1. 投标文件是否声明投标有效期；
2. 声明天数是否满足招标要求；
3. 到期日是否覆盖“起始日 + 要求天数”；
4. 同一份投标文件中出现互相冲突的有效期声明；
5. 起始日/到期日无法解析时给出提醒而不是误判。
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from pathlib import Path
from typing import Any

CHECK_ID = "validity"
CHECK_NAME = "投标有效期核查"

DAY_UNITS = "天日"

VALIDITY_DECLARATION = re.compile(
    r"(投标|报价|响应)?有效期[^0-9\n]{0,12}?(\d{1,4})\s*(?:个)?([%s])" % DAY_UNITS
)
REQUIRED_VALIDITY = re.compile(
    r"(投标|报价|响应)?有效期[^0-9\n]{0,16}?(不少于|不低于|至少|不得少于|≥|>=)[^0-9\n]{0,6}(\d{1,4})\s*(?:个)?([%s])" % DAY_UNITS
)
DATE_PATTERNS = [
    re.compile(r"(20\d{2})\s*[年/\-\.]\s*(\d{1,2})\s*[月/\-\.]\s*(\d{1,2})\s*[日号]?"),
]
START_DATE_LABEL = re.compile(r"(投标截止|开标|响应截止|递交截止|截标)时间[^0-9\n]{0,8}")
EXPIRY_DATE_LABEL = re.compile(r"有效期(届满|到期|截止|终止|至|到)[^0-9\n]{0,6}")


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


def _parse_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = int(value)
        return number if number > 0 else None
    text = _normalize_text(value).replace(",", "")
    if not re.fullmatch(r"\d{1,4}", text):
        return None
    number = int(text)
    return number if number > 0 else None


def _parse_date(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    for pattern in DATE_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        try:
            return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            return None
    return None


def _first_declared_validity_days(text: str) -> tuple[int | None, str]:
    for match in VALIDITY_DECLARATION.finditer(text or ""):
        days = _parse_int(match.group(2))
        if days:
            return days, _normalize_text(match.group(0))[:120]
    return None, ""


def _all_declared_validity_days(text: str) -> list[tuple[int, str]]:
    found: list[tuple[int, str]] = []
    seen: set[int] = set()
    for match in VALIDITY_DECLARATION.finditer(text or ""):
        days = _parse_int(match.group(2))
        if days and days not in seen:
            seen.add(days)
            found.append((days, _normalize_text(match.group(0))[:120]))
    return found


def _required_validity_days(text: str) -> tuple[int | None, str]:
    for match in REQUIRED_VALIDITY.finditer(text or ""):
        days = _parse_int(match.group(3))
        if days:
            return days, _normalize_text(match.group(0))[:120]
    return None, ""


def _find_date_after(text: str, label: re.Pattern[str]) -> date | None:
    for match in label.finditer(text or ""):
        tail = text[match.end() : match.end() + 40]
        parsed = _parse_date(tail)
        if parsed:
            return parsed
    return None


def _result(checks: list[dict[str, Any]]) -> dict[str, Any]:
    failures = [item for item in checks if item["status"] == "fail"]
    warnings = [item for item in checks if item["status"] == "warning"]
    passed = [item for item in checks if item["status"] == "pass"]
    if failures:
        status = "fail"
        summary = f"投标有效期核查发现 {len(failures)} 项风险"
    elif warnings:
        status = "warning"
        summary = f"投标有效期核查发现 {len(warnings)} 项提醒"
    else:
        status = "pass"
        summary = "投标有效期核查通过"
    severity = "major" if failures else "minor" if warnings else "info"
    findings = []
    for index, item in enumerate((failures + warnings), 1):
        evidence = item.get("evidence") or ""
        location_text = evidence or item.get("message") or ""
        line = None
        if item.get("line") is not None:
            line = item["line"]
        findings.append(
            {
                "id": f"validity-{index:03d}",
                "code": item["code"],
                "title": item["title"],
                "message": item["message"],
                "severity": item["severity"],
                "evidence": location_text[:500],
                "suggestion": item["suggestion"],
                "location": {"file": item.get("file"), "line": line},
            }
        )
    return {
        "check_id": CHECK_ID,
        "check_name": CHECK_NAME,
        "status": status,
        "severity": severity,
        "summary": summary,
        "metrics": {
            "total": len(checks),
            "passed": len(passed),
            "failed": len(failures),
            "warning": len(warnings),
        },
        "findings": findings,
        "usage": {"model": None, "prompt_tokens": 0, "completion_tokens": 0},
    }


def run_validity_check(input_data: dict[str, Any]) -> dict[str, Any]:
    metadata = input_data.get("project_metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    bid_file = str(input_data.get("bid_file") or "").strip()
    tender_file = str(input_data.get("tender_file") or "").strip()
    bid_text = _read_text(bid_file)
    tender_text = _read_text(tender_file)

    checks: list[dict[str, Any]] = []

    def add(status: str, severity: str, code: str, title: str, message: str, suggestion: str, evidence: str = "", file: str = "") -> None:
        checks.append(
            {
                "status": status,
                "severity": severity,
                "code": code,
                "title": title,
                "message": message,
                "suggestion": suggestion,
                "evidence": evidence,
                "file": file or None,
            }
        )

    declared_days = _parse_int(metadata.get("bid_validity_days"))
    declared_evidence = _normalize_text(metadata.get("bid_validity_days") or "")
    if declared_days is None:
        declared_days, declared_evidence = _first_declared_validity_days(bid_text)

    required_days = _parse_int(metadata.get("required_validity_days"))
    required_evidence = _normalize_text(metadata.get("required_validity_days") or "")
    if required_days is None:
        required_days, required_evidence = _required_validity_days(tender_text)

    start_date = _parse_date(metadata.get("bid_deadline") or metadata.get("opening_date"))
    if start_date is None:
        start_date = _find_date_after(tender_text, START_DATE_LABEL) or _find_date_after(bid_text, START_DATE_LABEL)
    expiry_date = _parse_date(metadata.get("validity_expiry_date"))
    if expiry_date is None:
        expiry_date = _find_date_after(bid_text, EXPIRY_DATE_LABEL)

    if declared_days is None:
        add(
            "fail",
            "major",
            "VALIDITY_NOT_DECLARED",
            "未声明投标有效期",
            "投标文件中未识别到投标（报价/响应）有效期天数。",
            "请在投标函中明确写清投标有效期，例如“投标有效期自投标截止之日起 90 日历天”。",
            "",
            bid_file,
        )
    else:
        if required_days is not None and declared_days < required_days:
            add(
                "fail",
                "major",
                "VALIDITY_SHORTER_THAN_REQUIRED",
                "投标有效期短于招标要求",
                f"投标有效期为 {declared_days} 天，招标要求不少于 {required_days} 天。",
                "请将投标有效期改为不少于招标要求的天数，并与投标函、开标一览表保持一致。",
                declared_evidence,
                bid_file,
            )
        else:
            detail = f"，招标要求不少于 {required_days} 天" if required_days is not None else "（招标未声明强制天数）"
            add(
                "pass",
                "info",
                "VALIDITY_DECLARED_OK",
                "投标有效期已声明",
                f"投标有效期为 {declared_days} 天{detail}。",
                "",
                declared_evidence,
                bid_file,
            )

    conflicting = _all_declared_validity_days(bid_text)
    if len(conflicting) > 1:
        values = "、".join(f"{days} 天" for days, _ in conflicting)
        add(
            "fail",
            "major",
            "VALIDITY_DECLARATION_CONFLICT",
            "投标有效期前后不一致",
            f"投标文件中出现互相冲突的有效期声明：{values}。",
            "请统一投标函、报价表与商务响应表中的投标有效期。",
            conflicting[0][1],
            bid_file,
        )

    # 只有起始日与届满日都能确定时才做覆盖校验；缺日期属于信息不足，不作为提醒刷屏。
    if declared_days is not None and start_date is not None and expiry_date is not None:
        expected_expiry = start_date + timedelta(days=declared_days)
        if expiry_date < expected_expiry:
            add(
                "fail",
                "major",
                "VALIDITY_EXPIRES_TOO_EARLY",
                "有效期届满日早于承诺天数",
                f"自起始日 {start_date.isoformat()} 起 {declared_days} 天应为 {expected_expiry.isoformat()}，但投标文件写明届满日为 {expiry_date.isoformat()}。",
                "请核对有效期起始日与届满日，确保两者与承诺天数一致。",
                declared_evidence,
                bid_file,
            )
        else:
            add(
                "pass",
                "info",
                "VALIDITY_EXPIRY_COVERED",
                "有效期届满日覆盖承诺天数",
                f"届满日 {expiry_date.isoformat()} 不早于 {expected_expiry.isoformat()}。",
                "",
                declared_evidence,
                bid_file,
            )

    return _result(checks)
