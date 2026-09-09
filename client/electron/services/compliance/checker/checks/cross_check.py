"""评分项交叉对照（需要模型能力）。

把招标里需要在技术方案中展开的评分项列成编号清单，交由模型逐项判断投标文件的响应情况，
再按编号回填校验，避免模型编造评分项。命中不了编号或证据缺失的条目会被丢弃。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from llm_client import LlmUnavailable, chat_json

CHECK_ID = "cross_check"
CHECK_NAME = "评分项交叉对照"

MAX_ITEMS = 40
MAX_TEXT_CHARS = 12000
VALID_STATUSES = {"covered", "partial", "missing", "unknown"}
STATUS_LABEL = {"covered": "已覆盖", "partial": "部分覆盖", "missing": "未覆盖", "unknown": "无法判断"}

# 评分行统一按“名称 + 分值 + 分”结尾识别，支持“名称，30分”“名称（30分）”“| 名称 | 30分 |”。
SCORING_LINE = re.compile(
    r"^(?:[（(]?\d{1,2}[）).、]|[①-⑳])?\s*(?P<name>.+?)[\s,，、:：|/（(]{0,4}(?P<score>\d{1,4}(?:\.\d+)?)\s*分[)）.。]?\s*$"
)
# 只排除汇总行与价格类行，避免把“合计/满分”当评分项，也不把非技术项混进技术对照。
SCORING_EXCLUDE = re.compile(r"(合计|总分|满分|小计|加权|价格分|报价分|投标报价|评分标准如下|评标办法|页码|序号)")


def _read_text(path: Any) -> str:
    value = str(path or "").strip()
    if not value:
        return ""
    try:
        return Path(value).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def extract_scoring_items(tender_text: str) -> list[dict[str, str]]:
    """优先用规则抽取“评分项 + 分值”，抽不到时退回按行扫描含“分”的技术评分行。"""
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw_line in (tender_text or "").splitlines():
        line = raw_line.strip()
        if not line or len(line) > 200 or SCORING_EXCLUDE.search(line):
            continue
        match = SCORING_LINE.search(line)
        if not match:
            continue
        name = re.sub(r"[|\s]+", "", match.group("name"))
        # 名称里残留的表格/序号前缀去掉，例如“1.”、“（1）”。
        name = re.sub(r"^(?:[（(]?\d{1,2}[）).、]|[①-⑳])", "", name)
        score = match.group("score")
        if len(name) < 2 or len(name) > 60 or name in seen:
            continue
        seen.add(name)
        items.append({"name": name, "score": score})
        if len(items) >= MAX_ITEMS:
            break
    return items


def _build_messages(scoring_items: list[dict[str, str]], bid_text: str) -> list[dict[str, str]]:
    listing = "\n".join(
        f"T{index:02d}｜{item['name']}｜{item['score']}分" for index, item in enumerate(scoring_items, 1)
    )
    system = (
        "你是投标技术文件的评标预检助手。逐项判断投标文件是否真正响应了招标评分项。\n"
        "判定口径：只有当投标文件存在与该评分项对应、可核查的具体方案内容时才算 covered；\n"
        "泛泛而谈、只有承诺没有做法、或仅出现同词但无实质内容，判 partial 或 missing；\n"
        "投标文件被截断导致看不到对应内容时判 unknown，不要猜测。\n"
        '只输出 JSON：{"items":[{"id":"T01","status":"covered|partial|missing|unknown",'
        '"evidence":"投标文件原文摘录或位置说明","reason":"一句话依据","suggestion":"改进建议"}]}'
    )
    user = (
        f"评分项清单：\n{listing}\n\n"
        f"投标文件（可能被截断）：\n{bid_text[:MAX_TEXT_CHARS]}\n\n"
        "请对清单中每一个 id 都给出一条判定，不要新增清单外的 id。"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _normalize_items(parsed: dict[str, Any], scoring_items: list[dict[str, str]]) -> list[dict[str, Any]]:
    by_id = {f"T{index:02d}": item for index, item in enumerate(scoring_items, 1)}
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in parsed.get("items") or []:
        if not isinstance(raw, dict):
            continue
        item_id = re.sub(r"\s+", "", str(raw.get("id") or "")).upper()
        if item_id not in by_id or item_id in seen:
            continue
        status = str(raw.get("status") or "").strip().lower()
        if status not in VALID_STATUSES:
            continue
        seen.add(item_id)
        rows.append({
            "id": item_id,
            "requirement": by_id[item_id]["name"],
            "score": by_id[item_id]["score"],
            "status": status,
            "evidence": str(raw.get("evidence") or "")[:500],
            "reason": str(raw.get("reason") or "")[:300],
            "suggestion": str(raw.get("suggestion") or "")[:300],
        })
    return rows


#: findings 里是 major/critical 的记为问题，minor 的记为提醒；metrics 必须由 findings 推导，
#: 否则会出现“有明细但汇总计数为 0”，页面顶部就把提醒吞掉。
def _result(
    findings: list[dict[str, Any]],
    summary_text: str,
    status: str,
    severity: str,
    usage: dict[str, Any],
    passed: int,
) -> dict[str, Any]:
    failed = len([item for item in findings if item.get("severity") in ("major", "critical")])
    warning = len([item for item in findings if item.get("severity") == "minor"])
    return {
        "check_id": CHECK_ID,
        "check_name": CHECK_NAME,
        "status": status,
        "severity": severity,
        "summary": summary_text,
        "metrics": {
            "total": passed + failed + warning,
            "passed": passed,
            "failed": failed,
            "warning": warning,
        },
        "findings": findings,
        "usage": usage,
    }


def run_cross_check(input_data: dict[str, Any]) -> dict[str, Any]:
    bid_file = str(input_data.get("bid_file") or "").strip()
    tender_file = str(input_data.get("tender_file") or "").strip()
    tender_text = _read_text(tender_file)
    bid_text = _read_text(bid_file)

    scoring_items = extract_scoring_items(tender_text)
    if not scoring_items:
        return _result(
            [{
                "id": "cross-check:no-items",
                "code": "CROSS_CHECK_NO_SCORING_ITEMS",
                "title": "未识别到评分项",
                "message": "未能从招标文件中识别出可逐项对照的技术评分项。",
                "severity": "minor",
                "evidence": "",
                "suggestion": "请确认招标文件已完整解析，或在 project_metadata 中补充评分项。",
                "location": {"file": tender_file or None, "line": None},
            }],
            "未识别到可对照的评分项",
            "warning",
            "minor",
            {"model": None, "prompt_tokens": 0, "completion_tokens": 0},
            0,
        )

    parsed, usage = chat_json(input_data.get("model_config"), _build_messages(scoring_items, bid_text))
    rows = _normalize_items(parsed if isinstance(parsed, dict) else {}, scoring_items)
    findings: list[dict[str, Any]] = []
    for row in rows:
        if row["status"] in ("covered", "unknown"):
            continue
        findings.append({
            "id": f"cross-check:{row['id']}",
            "code": f"CROSS_CHECK_{row['status'].upper()}",
            "title": f"{row['requirement']}（{row['score']}分）{STATUS_LABEL[row['status']]}",
            "message": row["reason"] or f"模型判定该评分项{STATUS_LABEL[row['status']]}。",
            "severity": "critical" if row["status"] == "missing" else "major",
            "evidence": row["evidence"],
            "suggestion": row["suggestion"] or "请补充该评分项对应的具体做法、流程与可核验承诺。",
            "location": {"file": bid_file or None, "line": None},
        })

    missed = len(findings)
    covered = sum(1 for row in rows if row["status"] == "covered")
    if not rows:
        # 模型没给出任何可校验编号时不能报“通过”，否则用户会误以为已经对照过。
        return _result(
            [{
                "id": "cross-check:no-verdict",
                "code": "CROSS_CHECK_NO_VERDICTS",
                "title": "模型未返回可校验判定",
                "message": f"模型返回的内容里没有命中任何评分项编号（共 {len(scoring_items)} 项待对照）。",
                "severity": "minor",
                "evidence": "",
                "suggestion": "请重试，或检查所用模型是否能稳定输出规定 JSON 结构。",
                "location": {"file": tender_file or None, "line": None},
            }],
            "模型未返回可校验的评分项判定",
            "warning",
            "minor",
            usage,
            0,
        )
    return _result(
        findings,
        f"已对照 {len(rows)} 项评分标准：{covered} 项已覆盖，{missed} 项存在覆盖不足",
        "fail" if missed else "pass",
        "critical" if any(item["severity"] == "critical" for item in findings) else "major" if findings else "info",
        usage,
        len(rows) - missed,
    )
