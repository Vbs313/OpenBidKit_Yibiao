"""评分项交叉对照（需要模型能力）。

流程刻意分成两段，避免“整篇截断后交给模型判”的假检查：
1. 规则侧从招标文件抽出编号评分项清单，并在**完整**投标文件里为每一项定位证据片段；
2. 模型只对拿到证据的编号判定 covered/partial，未定位到的直接给可核对提醒，不猜、也不算通过。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from llm_client import LlmUnavailable, chat_json

from checks.document_text import clean_cell, normalize_document_text, read_document_text

CHECK_ID = "cross_check"
CHECK_NAME = "评分项交叉对照"

MAX_ITEMS = 40
# 每项只带一段有限上下文给模型，靠“定位”而不是靠“整篇截断”，长标书同样能覆盖到尾部内容。
EVIDENCE_WINDOW = 400
MAX_EVIDENCE_PER_ITEM = 2
VALID_STATUSES = {"covered", "partial", "missing", "unknown"}
STATUS_LABEL = {"covered": "已覆盖", "partial": "部分覆盖", "missing": "未覆盖", "unknown": "无法判断"}

# 评分行按“名称 + 分值 + 分”结尾识别，支持“名称，30分”“名称（30分）”“| 名称 | 30分 |”。
SCORING_LINE = re.compile(
    r"^(?:[（(]?\d{1,2}[）).、]|[①-⑳])?\s*(?P<name>.+?)[\s,，、:：|/（(]{0,4}(?P<score>\d{1,4}(?:\.\d+)?)\s*分[)）.。]?\s*$"
)
SCORING_EXCLUDE = re.compile(r"(合计|总分|满分|小计|加权|价格分|报价分|投标报价|评分标准如下|评标办法|页码|序号)")
TABLE_HEADER_HINT = re.compile(r"(评分|评审|评标).{0,6}(因素|项)|分值|权重")
TABLE_SCORE_HINT = re.compile(r"^(分值|分值\(分\)|分数|权重|得分)$")


def _read_text(path: Any) -> str:
    value = str(path or "").strip()
    if not value:
        return ""
    try:
        return Path(value).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _normalize(value: Any) -> str:
    return re.sub(r"\s+", "", str(value if value is not None else "")).strip()


def _split_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _is_separator_row(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{2,}:?", cell or "-") for cell in cells)


def parse_markdown_scoring_rows(text: str) -> list[dict[str, str]]:
    """解析“| 评分因素 | 分值 |”型表格；真实招标文件绝大多数用这种写法。"""
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    lines = (text or "").splitlines()
    name_col: int | None = None
    score_col: int | None = None
    for raw in lines:
        line = raw.strip()
        if not line.startswith("|"):
            if "|" not in line:
                name_col = score_col = None
            continue
        cells = _split_cells(line)
        if _is_separator_row(cells):
            continue
        headers = [_normalize(cell) for cell in cells]
        is_header = any(TABLE_HEADER_HINT.search(cell) or TABLE_SCORE_HINT.match(cell) for cell in headers)
        if is_header:
            name_col = score_col = None
            for index, cell in enumerate(headers):
                if name_col is None and (TABLE_HEADER_HINT.search(cell) or re.search(r"(评审|评分|评标)因素", cell)):
                    name_col = index
                if score_col is None and (TABLE_SCORE_HINT.match(cell) or re.fullmatch(r"分值.{0,4}", cell)):
                    score_col = index
            if name_col is None or score_col is None:
                name_col = score_col = None
            continue
        if name_col is None or score_col is None or max(name_col, score_col) >= len(cells):
            continue
        name = re.sub(r"[（(].*?[)）]", "", cells[name_col]).strip(" ：:、")
        score = re.search(r"\d{1,4}(?:\.\d+)?", cells[score_col])
        if not name or not score or len(name) < 2 or len(name) > 60:
            continue
        if SCORING_EXCLUDE.search(name):
            continue
        key = _normalize(name)
        if key in seen:
            continue
        seen.add(key)
        items.append({"name": name, "score": score.group(0)})
        if len(items) >= MAX_ITEMS:
            break
    return items


def extract_scoring_items(tender_text: str) -> list[dict[str, str]]:
    """表格优先，退回按行识别；两条路径共用同一份排除规则。"""
    table_items = parse_markdown_scoring_rows(tender_text)
    if table_items:
        return table_items

    items: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw_line in (tender_text or "").splitlines():
        line = raw_line.strip()
        if not line or len(line) > 160:
            continue
        if SCORING_EXCLUDE.search(line):
            continue
        match = SCORING_LINE.match(line)
        if not match:
            continue
        name = re.sub(r"[（(].*?[)）]", "", match.group("name")).strip(" ：:、，,")
        name = re.sub(r"^(评分标准|评标因素|评审内容|内容)\s*[（(]?\d*分?[）)]?\s*", "", name).strip()
        name = name.strip("。；;，,、 ")
        if len(name) < 2 or name in seen:
            continue
        seen.add(name)
        items.append({"name": name, "score": match.group("score")})
        if len(items) >= MAX_ITEMS:
            break
    return items


def probe_terms(name: str) -> list[str]:
    """把评分项名称切成可检索词，长词优先。

    招标常写“质量保障措施”，投标常写“质量保障”，只用整串匹配会漏定位，
    因此额外补去尾与截短的候选；命中的仍是完整原文片段，不改变判定依据。
    """
    cleaned = _normalize(name)
    cleaned = re.sub(r"[（(].*?[)）]", "", cleaned)
    parts = [part for part in re.split(r"[^\u4e00-\u9fffA-Za-z0-9]+", cleaned) if len(part) >= 2]
    candidates = [cleaned, *parts]
    for part in list(parts):
        if len(part) >= 6:
            candidates.append(part[:-2])
            candidates.append(part[:6])
    terms: list[str] = []
    for term in candidates:
        if len(term) >= 2 and term not in terms:
            terms.append(term)
    return terms[:6]


def _hit_score(haystack: str, term: str, at: int) -> int:
    """位置越靠前、词越长，命中质量越高。"""
    return len(term) * 10 - at // 1000


def build_item_evidence(bid_text: str, scoring_items: list[dict[str, str]]) -> list[dict[str, Any]]:
    """在完整投标文本里为每个编号定位证据；不截断原文，只截取命中附近窗口。"""
    compact = _normalize(bid_text)
    rows: list[dict[str, Any]] = []
    for index, item in enumerate(scoring_items, 1):
        snippets: list[str] = []
        best_line = None
        for term in probe_terms(item["name"]):
            start = 0
            while len(snippets) < MAX_EVIDENCE_PER_ITEM:
                at = compact.find(term, start)
                if at < 0:
                    break
                begin = max(0, at - EVIDENCE_WINDOW // 2)
                end = min(len(compact), at + len(term) + EVIDENCE_WINDOW // 2)
                snippet = compact[begin:end]
                if snippet not in snippets:
                    snippets.append(snippet)
                    if best_line is None:
                        best_line = _line_number_of(bid_text, term)
                start = at + len(term)
            if snippets:
                break
        rows.append({
            "id": f"T{index:02d}",
            "requirement": item["name"],
            "score": item["score"],
            "snippets": snippets,
            "line": best_line,
        })
    return rows


def _line_number_of(raw_text: str, term: str) -> int | None:
    """把命中的检索词映射回原始行号供页面标注；找不到就返回 None，绝不猜行号。"""
    probe = _normalize(term)[:12]
    if not probe:
        return None
    for number, line in enumerate((raw_text or "").splitlines(), 1):
        if probe in _normalize(line):
            return number
    return None


def _build_messages(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    lines = []
    for row in rows:
        joined = "\n".join(f"    - {snippet}" for snippet in row["snippets"]) or "    - （未检索到相关表述）"
        lines.append(f"{row['id']}｜{row['requirement']}｜{row['score']}分\n{joined}")
    listing = "\n".join(lines)
    system = (
        "你是投标技术文件的评标预检助手。只对给出的编号评分项判定投标文件的响应质量。\n"
        "判定口径：\n"
        "covered=证据片段里有与该评分项对应、可核查的具体做法/流程/指标；\n"
        "partial=出现相关表述但缺少具体做法、量化指标或可核验承诺；\n"
        "missing=投标文本里找不到与该评分项对应的方案内容；\n"
        "unknown=证据片段不足以下判断（例如只有标题或片段被截断）。\n"
        "禁止编造未给出的编号，禁止把泛泛承诺当作已覆盖。\n"
        '只输出 JSON：{"items":[{"id":"T01","status":"covered|partial|unknown",'
        '"evidence":"引用的证据片段原文","reason":"一句话依据","suggestion":"改进建议"}]}'
    )
    user = (
        "待判定评分项及其投标文件证据片段：\n" + listing + "\n\n"
        + "请对上面每一个编号各输出一条判定，只返回 JSON。"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _normalize_verdicts(parsed: dict[str, Any], rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {row["id"]: row for row in rows}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in parsed.get("items") or []:
        if not isinstance(raw, dict):
            continue
        item_id = _normalize(raw.get("id")).upper()
        if item_id not in by_id or item_id in seen:
            continue
        status = str(raw.get("status") or "").strip().lower()
        if status not in VALID_STATUSES:
            continue
        seen.add(item_id)
        out.append({
            "id": item_id,
            "requirement": by_id[item_id]["requirement"],
            "score": by_id[item_id]["score"],
            "status": status,
            "evidence": str(raw.get("evidence") or "")[:500],
            "reason": str(raw.get("reason") or "")[:300],
            "suggestion": str(raw.get("suggestion") or "")[:300],
            "line": by_id[item_id].get("line"),
        })
    return out


def _result(
    findings: list[dict[str, Any]],
    summary_text: str,
    status: str,
    severity: str,
    usage: dict[str, Any],
    passed: int,
) -> dict[str, Any]:
    # metrics 一律由 findings 推导：否则页面顶部汇总会把提醒吞掉。
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


def _single_finding(item_id: str, code: str, title: str, message: str, severity: str, suggestion: str, evidence: str = "", line: int | None = None) -> dict[str, Any]:
    return {
        "id": f"cross-check:{item_id}",
        "code": code,
        "title": title,
        "message": message,
        "severity": severity,
        "evidence": evidence[:500],
        "suggestion": suggestion,
        "location": {"file": None, "line": line},
    }


def run_cross_check(input_data: dict[str, Any]) -> dict[str, Any]:
    bid_file = str(input_data.get("bid_file") or "").strip()
    tender_file = str(input_data.get("tender_file") or "").strip()
    tender_text = _read_text(tender_file)
    bid_text = _read_text(bid_file)

    scoring_items = extract_scoring_items(tender_text)
    if not scoring_items:
        return _result(
            [_single_finding(
                "no-items",
                "CROSS_CHECK_NO_SCORING_ITEMS",
                "未识别到评分项",
                "未能从招标文件中识别出可逐项对照的技术评分项。",
                "minor",
                "请确认招标文件已完整解析，或在 project_metadata 中补充评分项。",
            )],
            "未识别到可对照的评分项",
            "warning",
            "minor",
            {"model": None, "prompt_tokens": 0, "completion_tokens": 0},
            0,
        )

    rows = build_item_evidence(bid_text, scoring_items)
    located = [row for row in rows if row["snippets"]]
    unlocated = [row for row in rows if not row["snippets"]]

    usage = {"model": None, "prompt_tokens": 0, "completion_tokens": 0}
    verdicts: list[dict[str, Any]] = []
    if located:
        parsed, usage = chat_json(input_data.get("model_config"), _build_messages(located))
        verdicts = _normalize_verdicts(parsed if isinstance(parsed, dict) else {}, located)

    findings: list[dict[str, Any]] = []
    for verdict in verdicts:
        if verdict["status"] == "covered":
            continue
        findings.append({
            "id": f"cross-check:{verdict['id']}",
            "code": f"CROSS_CHECK_{verdict['status'].upper()}",
            "title": verdict["requirement"] + "（" + verdict["score"] + "分）" + STATUS_LABEL[verdict["status"]],
            "message": verdict["reason"] or "模型判定该评分项" + STATUS_LABEL[verdict["status"]] + "。",
            "severity": "major",
            "evidence": verdict["evidence"],
            "suggestion": verdict["suggestion"] or "请补充该评分项对应的具体做法、流程与可核验承诺。",
            "location": {"file": bid_file or None, "line": verdict.get("line")},
        })
    for row in unlocated:
        findings.append(_single_finding(
            row["id"],
            "CROSS_CHECK_NOT_LOCATED",
            row["requirement"] + "（" + row["score"] + "分）未检索到对应内容",
            "在投标文件全文中未检索到与该评分项对应的表述。",
            "major",
            "请确认该评分项是否已有专章响应；确无内容时按招标要求补写。",
            "",
            None,
        ))

    covered = sum(1 for verdict in verdicts if verdict["status"] == "covered")
    if not verdicts and not unlocated:
        return _result(
            [_single_finding(
                "no-verdicts",
                "CROSS_CHECK_NO_VERDICTS",
                "模型未返回可校验判定",
                "模型返回的内容里没有命中任何待判定编号（共 " + str(len(located)) + " 项）。",
                "minor",
                "请重试，或检查所用模型是否能稳定输出规定 JSON 结构。",
            )],
            "模型未返回可校验的评分项判定",
            "warning",
            "minor",
            usage,
            0,
        )

    summary = "已对照 " + str(len(scoring_items)) + " 项评分标准：" + str(covered) + " 项已覆盖，" + str(len(findings)) + " 项需要处理"
    has_major = any(item["severity"] in ("major", "critical") for item in findings)
    return _result(
        findings,
        summary,
        "fail" if findings else "pass",
        "major" if has_major else "minor" if findings else "info",
        usage,
        covered,
    )
