"""投标保证金核查（确定性规则检查，不调用 LLM）。

覆盖：
1. 招标是否要求保证金，要求金额是多少；
2. 投标文件是否声明已缴纳的保证金金额；
3. 金额是否一致（含大写金额一致性与超额）；
4. 是否写明缴纳方式（转账/电汇/银行保函/支票等）；
5. 缴纳截止日是否早于投标截止日；
6. 要求比例（如“不超过预算金额的 2%%”）时的比例校验。
"""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from checks.document_text import read_document_text
from checks.pricing_arithmetic import MONEY_TOLERANCE, parse_chinese_money, parse_money

CHECK_ID = "deposit"
CHECK_NAME = "投标保证金核查"

AMOUNT_LABEL = r"(?:投标保证金|保证金|投标保证金|履约保证金|响应保证金)"
AMOUNT_PATTERN = re.compile(
    AMOUNT_LABEL + r"[^0-9\n。；;]{0,24}?([\d][\d,，. ]*)\s*(万元|万元整|千元|元|人民币元)",
)
RATE_PATTERN = re.compile(AMOUNT_LABEL + r"[^0-9\n。；;]{0,24}?([\d.]{1,5})\s*[%％]")
METHOD_PATTERN = re.compile(
    r"(银行转账|电汇|网银|转账|银行保函|保证保险|支票|现金|汇票|电子保函)"
)
# 缴纳时限常写成“须于 X年X月X日前”，中间还夹着金额数字，因此允许跨数字并要求“截止/于/前”提示词。
DEADLINE_PATTERN = re.compile(
    r"(?:保证金|缴纳|递交)[^。\n]{0,40}?(?:截止|于|前|到期)[^0-9\n]{0,6}(20\d{2})\s*[年/\-\.]\s*(\d{1,2})\s*[月/\-\.]\s*(\d{1,2})\s*[日号]?"
)
BID_DEADLINE_PATTERN = re.compile(
    r"(?:投标截止|递交截止|截标|开标)[^0-9\n。；;]{0,10}?(20\d{2})\s*[年/\-\.]\s*(\d{1,2})\s*[月/\-\.]\s*(\d{1,2})\s*[日号]?"
)
REQUIRED_DAYS_PATTERN = re.compile(
    r"(?:保证金|缴纳)[^0-9\n。；;]{0,16}?(\d{1,3})\s*(?:个)?(?:日历)?[天日](?:以内|前|之前)"
)


def _read_text(path: Any) -> str:
    value = str(path or "").strip()
    if not value:
        return ""
    try:
        return read_document_text(value)
    except OSError:
        return ""


def _normalize_text(value: Any) -> str:
    return re.sub(r"\s+", "", str(value if value is not None else "")).strip()


def _date_from_match(match: re.Match[str]) -> date:
    return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))


def _find_date(text: str, pattern: re.Pattern[str]) -> date | None:
    match = pattern.search(text or "")
    return _date_from_match(match) if match else None


def _first_amount(text: str) -> tuple[Decimal | None, str]:
    for match in AMOUNT_PATTERN.finditer(text or ""):
        raw = match.group(1)
        unit = match.group(2)
        amount = parse_money(raw)
        if amount is None:
            continue
        if unit.startswith("万"):
            amount = amount * Decimal("10000")
        elif unit.startswith("千"):
            amount = amount * Decimal("1000")
        return amount, _normalize_text(match.group(0))[:120]
    return None, ""


def _first_rate(text: str) -> tuple[Decimal | None, str]:
    match = RATE_PATTERN.search(text or "")
    if not match:
        return None, ""
    rate = parse_money(match.group(1))
    if rate is None:
        return None, _normalize_text(match.group(0))[:120]
    return rate, _normalize_text(match.group(0))[:120]


def _money_text(value: Decimal | None) -> str:
    if value is None:
        return "未知"
    return f"{value.quantize(Decimal('0.01')).normalize():f}"


def _result(checks: list[dict[str, Any]]) -> dict[str, Any]:
    failures = [item for item in checks if item["status"] == "fail"]
    warnings = [item for item in checks if item["status"] == "warning"]
    passed = [item for item in checks if item["status"] == "pass"]
    if failures:
        status = "fail"
        summary = f"投标保证金核查发现 {len(failures)} 项风险"
    elif warnings:
        status = "warning"
        summary = f"投标保证金核查发现 {len(warnings)} 项提醒"
    else:
        status = "pass"
        summary = "投标保证金核查通过"
    severity = "critical" if any(item["severity"] == "critical" for item in failures) else "major" if failures else "minor" if warnings else "info"
    findings = []
    for index, item in enumerate(failures + warnings, 1):
        findings.append(
            {
                "id": f"deposit-{index:03d}",
                "code": item["code"],
                "title": item["title"],
                "message": item["message"],
                "severity": item["severity"],
                "evidence": (item.get("evidence") or item.get("message") or "")[:500],
                "suggestion": item["suggestion"],
                "location": {"file": item.get("file") or None, "line": None},
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


def run_deposit_check(input_data: dict[str, Any]) -> dict[str, Any]:
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
                "file": file,
            }
        )

    required_amount, required_evidence = _first_amount(tender_text)
    if "deposit_amount" in metadata:
        required_amount = parse_money(metadata.get("deposit_amount")) or required_amount
    required_rate, rate_evidence = _first_rate(tender_text)
    budget = parse_money(metadata.get("budget_amount"))

    bid_amount, bid_evidence = _first_amount(bid_text)
    if "bid_deposit_amount" in metadata:
        bid_amount = parse_money(metadata.get("bid_deposit_amount")) or bid_amount


    if required_amount is None and required_rate is None:
        add(
            "pass",
            "info",
            "DEPOSIT_NOT_REQUIRED",
            "未识别到保证金要求",
            "招标文件中未识别到投标保证金金额或比例要求，本项按无需校验处理。",
            "",
            "",
            tender_file,
        )
    elif bid_amount is None:
        add(
            "fail",
            "critical",
            "DEPOSIT_BID_AMOUNT_MISSING",
            "投标文件未声明保证金",
            "招标文件要求投标保证金，但投标文件中未识别到已缴纳或拟缴纳的保证金金额。",
            "请在投标函或保证金缴纳凭证页写明保证金金额，并附缴纳凭证。",
            required_evidence,
            bid_file,
        )
    else:
        if required_amount is not None:
            if abs(bid_amount - required_amount) > MONEY_TOLERANCE:
                add(
                    "fail",
                    "critical",
                    "DEPOSIT_AMOUNT_MISMATCH",
                    "保证金金额与招标要求不一致",
                    f"招标要求 {_money_text(required_amount)} 元，投标文件写明 {_money_text(bid_amount)} 元。",
                    "请按招标文件金额缴纳并保持投标文件、凭证三者一致。",
                    bid_evidence,
                    bid_file,
                )
            else:
                add(
                    "pass",
                    "info",
                    "DEPOSIT_AMOUNT_MATCH",
                    "保证金金额与招标要求一致",
                    f"保证金金额均为 {_money_text(bid_amount)} 元。",
                    "",
                    bid_evidence,
                    bid_file,
                )
        if required_rate is not None and budget is not None:
            expected = (budget * required_rate / Decimal("100")).quantize(Decimal("0.01"))
            if bid_amount > expected + MONEY_TOLERANCE:
                add(
                    "fail",
                    "major",
                    "DEPOSIT_RATE_EXCEEDED",
                    "保证金超过招标规定比例",
                    f"按预算金额 {required_rate}% 计算上限为 {_money_text(expected)} 元，投标文件写明 {_money_text(bid_amount)} 元。",
                    "请核对保证金比例与预算金额口径。",
                    rate_evidence,
                    bid_file,
                )
        chinese_amount = parse_chinese_money(metadata.get("bid_deposit_amount_cn"))
        if chinese_amount is not None and abs(chinese_amount - bid_amount) > MONEY_TOLERANCE:
            add(
                "fail",
                "major",
                "DEPOSIT_UPPERCASE_MISMATCH",
                "保证金大小写金额不一致",
                f"大写金额解析为 {_money_text(chinese_amount)} 元，与数字金额 {_money_text(bid_amount)} 元不一致。",
                "请统一保证金的大写与小写金额。",
                _normalize_text(metadata.get("bid_deposit_amount_cn"))[:120],
                bid_file,
            )

    method_match = METHOD_PATTERN.search(bid_text or "")
    if required_amount is not None or required_rate is not None:
        if not method_match:
            add(
                "fail",
                "major",
                "DEPOSIT_METHOD_MISSING",
                "未写明保证金缴纳方式",
                "投标文件中未识别到保证金缴纳方式（如银行转账、电汇、银行保函、电子保函）。",
                "请按招标文件允许的方式缴纳，并在投标文件中写明方式与账户信息。",
                "",
                bid_file,
            )
        else:
            add(
                "pass",
                "info",
                "DEPOSIT_METHOD_DECLARED",
                "已写明保证金缴纳方式",
                f"投标文件写明缴纳方式为“{method_match.group(1)}”。",
                "",
                _normalize_text(method_match.group(0))[:120],
                bid_file,
            )

        deposit_deadline = _find_date(tender_text, DEADLINE_PATTERN)
        bid_deadline = _find_date(tender_text, BID_DEADLINE_PATTERN) or _find_date(bid_text, BID_DEADLINE_PATTERN)
        required_days = None
        days_match = REQUIRED_DAYS_PATTERN.search(tender_text or "")
        if days_match:
            required_days = int(days_match.group(1))
        if deposit_deadline and bid_deadline and deposit_deadline > bid_deadline:
            add(
                "warning",
                "minor",
                "DEPOSIT_DEADLINE_LATE",
                "保证金缴纳截止日晚于投标截止日",
                f"保证金需在 {deposit_deadline.isoformat()} 前缴纳，但投标截止日为 {bid_deadline.isoformat()}。",
                "请确认保证金实际到账时间早于投标截止日。",
                "",
                tender_file,
            )
        elif deposit_deadline or required_days:
            detail = deposit_deadline.isoformat() if deposit_deadline else f"投标截止前 {required_days} 天"
            add(
                "pass",
                "info",
                "DEPOSIT_DEADLINE_KNOWN",
                "保证金缴纳时限已识别",
                f"招标要求的缴纳时限为 {detail}。",
                "",
                "",
                tender_file,
            )
        elif bid_deadline:
            # 招标没有单列缴纳时限时，默认以投标截止日为限，这是行业常规口径，不应作为提醒刷屏。
            add(
                "pass",
                "info",
                "DEPOSIT_DEADLINE_FOLLOW_BID_DEADLINE",
                "缴纳时限按投标截止日处理",
                f"招标未单列保证金缴纳截止日，按投标截止日 {bid_deadline.isoformat()} 前到账校验。",
                "",
                "",
                tender_file,
            )
        else:
            add(
                "warning",
                "minor",
                "DEPOSIT_DEADLINE_MISSING",
                "未识别保证金缴纳时限",
                "招标文件中既未识别到保证金缴纳截止日，也未识别到投标截止日。",
                "建议按投标截止日提前缴纳，并保留到账凭证。",
                "",
                tender_file,
            )

    return _result(checks)
