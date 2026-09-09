from __future__ import annotations

import json
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from checks.document_text import normalize_document_text

CHECK_ID = "pricing_arithmetic"
CHECK_NAME = "报价算术核查"
MONEY_TOLERANCE = Decimal("0.01")

CN_DIGITS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "壹": 1,
    "贰": 2,
    "叁": 3,
    "肆": 4,
    "伍": 5,
    "陆": 6,
    "柒": 7,
    "捌": 8,
    "玖": 9,
}
CN_SMALL_UNITS = {
    "十": 10,
    "拾": 10,
    "百": 100,
    "佰": 100,
    "千": 1000,
    "仟": 1000,
}
CN_SECTION_UNITS = {
    "万": 10000,
    "萬": 10000,
    "亿": 100000000,
    "億": 100000000,
}
CN_MONEY_CHARS = set(CN_DIGITS) | set(CN_SMALL_UNITS) | set(CN_SECTION_UNITS) | set("元圆角分整正")


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


def _read_text_file(file_path: Any) -> str:
    text_path = _normalize_text(file_path)
    if not text_path:
        return ""
    path = Path(text_path).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"文件不存在: {path}")
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            # 解码成功不代表干净：转换器的 U+0001 哨兵和页码标记仍要统一去掉。
            return normalize_document_text(raw.decode(encoding))
        except UnicodeDecodeError:
            continue
    return normalize_document_text(raw.decode("utf-8", errors="replace"))


def _extract_numeric_text(value: Any) -> Decimal | None:
    text = _normalize_text(value)
    if not text:
        return None
    multiplier = Decimal("10000") if "万" in text else Decimal("1")
    normalized = (
        text.replace(",", "")
        .replace("，", "")
        .replace(" ", "")
        .replace("人民币", "")
        .replace("RMB", "")
        .replace("rmb", "")
        .replace("￥", "")
        .replace("¥", "")
    )
    match = re.search(r"[-+]?\d+(?:\.\d+)?", normalized)
    if not match:
        return None
    try:
        return Decimal(match.group(0)) * multiplier
    except InvalidOperation:
        return None


def parse_chinese_integer(value: Any) -> int:
    text = _normalize_text(value)
    if not text:
        return 0
    total = 0
    section = 0
    number = 0
    for char in text:
        if char in CN_DIGITS:
            number = CN_DIGITS[char]
            continue
        if char in CN_SMALL_UNITS:
            unit = CN_SMALL_UNITS[char]
            if number == 0 and unit == 10:
                number = 1
            section += number * unit
            number = 0
            continue
        if char in CN_SECTION_UNITS:
            section += number
            total += section * CN_SECTION_UNITS[char]
            section = 0
            number = 0
    return total + section + number


def parse_chinese_money(value: Any) -> Decimal | None:
    text = _normalize_text(value)
    if not text or not any(char in CN_MONEY_CHARS for char in text):
        return None
    text = re.sub(r"[人民币大写小写：:\s（）()【】\[\]]", "", text)
    text = text.replace("整", "").replace("正", "")
    if not any(char in text for char in set(CN_DIGITS) | set(CN_SMALL_UNITS) | set(CN_SECTION_UNITS)):
        return None

    integer_text = text
    remainder = ""
    if "元" in text or "圆" in text:
        integer_text, remainder = re.split(r"[元圆]", text, maxsplit=1)

    integer_value = parse_chinese_integer(integer_text)
    jiao = 0
    fen = 0
    jiao_match = re.search(r"([零〇一二两三四五六七八九壹贰叁肆伍陆柒捌玖])\s*角", remainder)
    fen_match = re.search(r"([零〇一二两三四五六七八九壹贰叁肆伍陆柒捌玖])\s*分", remainder)
    if jiao_match:
        jiao = CN_DIGITS.get(jiao_match.group(1), 0)
    if fen_match:
        fen = CN_DIGITS.get(fen_match.group(1), 0)
    return Decimal(integer_value) + Decimal(jiao) / Decimal(10) + Decimal(fen) / Decimal(100)


def parse_money(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        try:
            return Decimal(str(value))
        except InvalidOperation:
            return None
    numeric = _extract_numeric_text(value)
    if numeric is not None:
        return numeric
    return parse_chinese_money(value)


def _decimal_places(value: Decimal) -> int:
    exponent = value.as_tuple().exponent
    return abs(exponent) if exponent < 0 else 0


def _split_table_cells(line: str) -> list[str]:
    stripped = line.strip()
    if not stripped.startswith("|"):
        return []
    return [cell.strip() for cell in stripped.strip("|").split("|")]


def _is_separator_row(cells: list[str]) -> bool:
    if not cells:
        return False
    return all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in cells if cell)


def _find_column(headers: list[str], keywords: tuple[str, ...]) -> int | None:
    for index, header in enumerate(headers):
        if any(keyword in header for keyword in keywords):
            return index
    return None


def _cell(cells: list[str], index: int | None) -> str:
    if index is None or index < 0 or index >= len(cells):
        return ""
    return cells[index]


def parse_markdown_line_items(text: str, source_file: str) -> list[dict[str, Any]]:
    lines = text.splitlines()
    items: list[dict[str, Any]] = []
    index = 0
    while index < len(lines):
        cells = _split_table_cells(lines[index])
        if not cells:
            index += 1
            continue
        headers = cells
        header_keywords = ("名称", "项目", "品目", "货物", "服务", "单价", "数量", "合计", "小计", "金额", "总价")
        if not any(any(keyword in header for keyword in header_keywords) for header in headers):
            index += 1
            continue
        name_col = _find_column(headers, ("名称", "项目", "品目", "货物", "服务"))
        unit_price_col = _find_column(headers, ("单价",))
        quantity_col = _find_column(headers, ("数量",))
        subtotal_col = _find_column(headers, ("小计", "合计", "金额"))
        total_col = _find_column(headers, ("总价",))
        data_index = index + 1
        if data_index < len(lines) and _is_separator_row(_split_table_cells(lines[data_index])):
            data_index += 1
        while data_index < len(lines):
            row = _split_table_cells(lines[data_index])
            if not row or _is_separator_row(row):
                break
            if not any(cell for cell in row):
                break
            item = {
                "name": _cell(row, name_col) or f"第{data_index + 1}行",
                "unit_price": _cell(row, unit_price_col) or None,
                "quantity": _cell(row, quantity_col) or None,
                "subtotal": _cell(row, subtotal_col) or _cell(row, total_col) or None,
                "line": data_index + 1,
                "source_file": source_file,
                "evidence": lines[data_index].strip(),
            }
            if any(item.get(key) for key in ("unit_price", "quantity", "subtotal")):
                items.append(item)
            data_index += 1
        index = max(index + 1, data_index)
    return items


def parse_inline_arithmetic(text: str, source_file: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    pattern = re.compile(
        r"(?P<unit>[-+]?\d[\d,，]*(?:\.\d+)?)\s*[×xX*]\s*"
        r"(?P<qty>[-+]?\d[\d,，]*(?:\.\d+)?)\s*=\s*"
        r"(?P<subtotal>[-+]?\d[\d,，]*(?:\.\d+)?)"
    )
    for line_number, line in enumerate(text.splitlines(), 1):
        for match in pattern.finditer(line):
            prefix = line[: match.start()].strip(" |\t")
            items.append({
                "name": prefix[-80:] or f"第{line_number}行",
                "unit_price": match.group("unit"),
                "quantity": match.group("qty"),
                "subtotal": match.group("subtotal"),
                "line": line_number,
                "source_file": source_file,
                "evidence": line.strip(),
            })
    return items


def _match_amount(text: str, pattern: str) -> Decimal | None:
    match = re.search(pattern, text, flags=re.IGNORECASE)
    if not match:
        return None
    value = parse_money(match.group("amount"))
    if value is None:
        return None
    if match.groupdict().get("wan"):
        value *= Decimal("10000")
    return value


def extract_total_amount(text: str, metadata: dict[str, Any]) -> Decimal | None:
    for key in ("total_amount", "total", "bid_amount", "bid_letter_amount", "投标总价", "投标报价", "总价", "合计"):
        value = parse_money(metadata.get(key))
        if value is not None:
            return value
    patterns = (
        r"(?:投标总价|投标报价|总价|合计)\s*[：:]\s*[人民币￥¥]*\s*(?P<amount>[-+]?\d[\d,，]*(?:\.\d+)?)\s*(?P<wan>万)?\s*元?",
        r"(?:投标总价|投标报价)\s*(?P<amount>[-+]?\d[\d,，]*(?:\.\d+)?)\s*(?P<wan>万)?\s*元",
    )
    for pattern in patterns:
        value = _match_amount(text, pattern)
        if value is not None:
            return value
    return None


def extract_bid_amount(text: str, metadata: dict[str, Any], fallback: Decimal | None) -> Decimal | None:
    for key in ("bid_amount", "bid_letter_amount", "投标报价", "投标总价", "报价"):
        value = parse_money(metadata.get(key))
        if value is not None:
            return value
    value = _match_amount(text, r"(?:投标报价|投标总价|报价)\s*[：:]\s*[人民币￥¥]*\s*(?P<amount>[-+]?\d[\d,，]*(?:\.\d+)?)\s*(?P<wan>万)?\s*元?")
    return value if value is not None else fallback


def extract_chinese_amount(text: str, metadata: dict[str, Any]) -> str | None:
    for key in ("bid_amount_cn", "amount_in_words", "amount_in_chinese", "大写金额", "投标报价大写", "投标总价大写"):
        value = _normalize_text(metadata.get(key))
        if value:
            return value
    pattern = re.compile(r"(?:人民币)?\s*([零〇一二两三四五六七八九壹贰叁肆伍陆柒捌玖拾佰仟萬万亿元圆角分整正]{2,})")
    for match in pattern.finditer(text):
        value = match.group(1)
        if any(char in value for char in ("元", "圆", "角", "分")):
            return value
    return None


def extract_max_price(tender_text: str, metadata: dict[str, Any]) -> Decimal | None:
    for key in ("max_price", "budget_amount", "最高限价", "预算金额", "采购预算"):
        value = parse_money(metadata.get(key))
        if value is not None:
            return value
    for pattern in (
        r"(?:最高限价|预算金额|采购预算)\s*[：:]\s*[人民币￥¥]*\s*(?P<amount>[-+]?\d[\d,，]*(?:\.\d+)?)\s*(?P<wan>万)?\s*元?",
    ):
        value = _match_amount(tender_text, pattern)
        if value is not None:
            return value
    return None


def _normalize_line_item(item: dict[str, Any], source_file: str, index: int) -> dict[str, Any]:
    def first_value(*keys: str) -> Any:
        for key in keys:
            if key in item and item.get(key) not in (None, ""):
                return item.get(key)
        return None

    return {
        "name": _normalize_text(first_value("name", "title", "item", "项目名称", "名称")) or f"第{index}项",
        "unit_price": first_value("unit_price", "unitPrice", "price", "单价"),
        "quantity": first_value("quantity", "qty", "amount", "数量"),
        "subtotal": first_value("subtotal", "sub_total", "line_total", "total", "amount_total", "合计", "小计", "金额"),
        "line": item.get("line"),
        "source_file": item.get("source_file") or source_file,
        "evidence": item.get("evidence") or json.dumps(item, ensure_ascii=False),
    }


def extract_line_items(text: str, metadata: dict[str, Any], source_file: str) -> list[dict[str, Any]]:
    raw_items = metadata.get("line_items") or metadata.get("items") or []
    if isinstance(raw_items, dict):
        raw_items = [raw_items]
    items = []
    if isinstance(raw_items, list):
        for index, item in enumerate(raw_items, 1):
            if isinstance(item, dict):
                items.append(_normalize_line_item(item, source_file, index))
    if not items:
        stripped = text.strip()
        if stripped.startswith("{") or stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                nested = parsed.get("line_items") or parsed.get("items")
                if isinstance(nested, list):
                    for index, item in enumerate(nested, 1):
                        if isinstance(item, dict):
                            items.append(_normalize_line_item(item, source_file, index))
            elif isinstance(parsed, list):
                for index, item in enumerate(parsed, 1):
                    if isinstance(item, dict):
                        items.append(_normalize_line_item(item, source_file, index))
    if not items:
        items = parse_markdown_line_items(text, source_file)
    if not items:
        items = parse_inline_arithmetic(text, source_file)
    return items


def _money_text(value: Decimal | None) -> str:
    if value is None:
        return ""
    return format(value.quantize(Decimal("0.01")), "f")


def _build_finding(
    code: str,
    title: str,
    message: str,
    severity: str,
    evidence: str,
    suggestion: str,
    source_file: str,
    line: int | None,
) -> dict[str, Any]:
    location = {"file": source_file or None, "line": line}
    return {
        "id": code,
        "code": code,
        "title": title,
        "message": message,
        "severity": severity,
        "evidence": evidence,
        "suggestion": suggestion,
        "location": location,
    }


def run_pricing_arithmetic(input_data: dict[str, Any]) -> dict[str, Any]:
    tender_file = input_data.get("tender_file")
    bid_file = input_data.get("bid_file")
    metadata = input_data.get("project_metadata") or {}
    if not isinstance(metadata, dict):
        metadata = {}

    tender_text = _read_text_file(tender_file)
    bid_text = _read_text_file(bid_file)
    line_items = extract_line_items(bid_text, metadata, bid_file)
    total_amount = extract_total_amount(bid_text, metadata)
    bid_amount = extract_bid_amount(bid_text, metadata, total_amount)
    chinese_amount = extract_chinese_amount(bid_text, metadata)
    max_price = extract_max_price(tender_text, metadata)

    checks: list[dict[str, Any]] = []

    def add(status: str, severity: str, code: str, title: str, message: str, evidence: str, suggestion: str, line: int | None = None) -> None:
        checks.append({
            "status": status,
            "severity": severity,
            "finding": _build_finding(code, title, message, severity, evidence, suggestion, bid_file, line),
        })

    def add_pass(code: str, title: str, message: str, evidence: str = "", suggestion: str = "", line: int | None = None) -> None:
        add("pass", "info", code, title, message, evidence, suggestion, line)

    if not line_items:
        add(
            "warning",
            "minor",
            "PRICING_NO_LINE_ITEMS",
            "未识别到报价明细",
            "未能从投标文件中识别到包含单价、数量和合计的结构化报价明细。",
            "",
            "请确认投标文件中存在 Markdown 报价表格，或在 project_metadata.line_items 中提供结构化明细。",
        )
    else:
        for index, item in enumerate(line_items, 1):
            checks_before_item = len(checks)
            name = item.get("name") or f"第{index}项"
            line = item.get("line") if isinstance(item.get("line"), int) else None
            evidence = item.get("evidence") or ""
            unit_price = parse_money(item.get("unit_price"))
            quantity = parse_money(item.get("quantity"))
            subtotal = parse_money(item.get("subtotal"))

            if unit_price is None:
                add("fail", "major", "PRICING_MISSING_UNIT_PRICE", "缺少单价", f"{name} 未识别到单价。", evidence, "请补充或修正该分项单价。", line)
                continue
            if quantity is None:
                add("fail", "major", "PRICING_MISSING_QUANTITY", "缺少数量", f"{name} 未识别到数量。", evidence, "请补充或修正该分项数量。", line)
                continue
            if subtotal is None:
                add("fail", "major", "PRICING_MISSING_SUBTOTAL", "缺少分项合计", f"{name} 未识别到分项合计。", evidence, "请补充该分项合计金额。", line)
                continue
            if unit_price < 0 or quantity < 0 or subtotal < 0:
                add("fail", "major", "PRICING_NEGATIVE_VALUE", "出现负数金额或数量", f"{name} 存在负数单价、数量或合计。", evidence, "请检查报价明细是否填写错误。", line)
            expected = unit_price * quantity
            if abs(expected - subtotal) > MONEY_TOLERANCE:
                add(
                    "fail",
                    "major",
                    "PRICING_LINE_ARITHMETIC_MISMATCH",
                    "分项合计计算错误",
                    f"{name}：{_money_text(unit_price)} × {_money_text(quantity)} = {_money_text(expected)}，但填报为 {_money_text(subtotal)}。",
                    evidence,
                    "请按单价 × 数量重新计算该分项合计。",
                    line,
                )
            for field_name, field_value in (("单价", unit_price), ("数量", quantity), ("分项合计", subtotal)):
                if _decimal_places(field_value) > 2:
                    add(
                        "warning",
                        "minor",
                        "PRICING_PRECISION",
                        "金额精度可能存在问题",
                        f"{name} 的{field_name}为 {field_value}，超过两位小数。",
                        evidence,
                        "请确认报价是否允许超过两位小数，并统一精度口径。",
                        line,
                    )
            if len(checks) == checks_before_item:
                add_pass(
                    "PRICING_LINE_ITEM_OK",
                    "分项算术正确",
                    f"{name} 的单价 × 数量与分项合计一致。",
                    evidence,
                    "",
                    line,
                )

        subtotal_values = [parse_money(item.get("subtotal")) for item in line_items]
        if all(value is not None for value in subtotal_values):
            calculated_total = sum((value for value in subtotal_values if value is not None), Decimal("0"))
            if total_amount is None:
                add(
                    "warning",
                    "minor",
                    "PRICING_NO_TOTAL",
                    "未识别到总价",
                    "已识别到分项明细，但未识别到投标总价或合计金额。",
                    "",
                    "请在投标文件中明确填写投标总价，或在 project_metadata.total_amount 中提供。",
                )
            elif abs(calculated_total - total_amount) > MONEY_TOLERANCE:
                add(
                    "fail",
                    "major",
                    "PRICING_TOTAL_SUM_MISMATCH",
                    "总价与分项合计不一致",
                    f"分项合计之和为 {_money_text(calculated_total)}，填报总价为 {_money_text(total_amount)}。",
                    "",
                    "请核对总价是否等于所有分项合计之和。",
                )
            else:
                add_pass(
                    "PRICING_TOTAL_SUM_OK",
                    "总价与分项合计一致",
                    f"分项合计之和与总价均为 {_money_text(total_amount)}。",
                )
        else:
            add(
                "warning",
                "minor",
                "PRICING_INCOMPLETE_SUBTOTALS",
                "分项合计不完整",
                "部分分项缺少合计金额，无法完成总分核对。",
                "",
                "请补齐所有分项的合计金额。",
            )

    if total_amount is None:
        add("warning", "minor", "PRICING_NO_TOTAL", "未识别到总价", "未识别到投标总价或合计金额。", "", "请补充投标总价，或在 project_metadata.total_amount 中提供。")
    if bid_amount is None:
        add("warning", "minor", "PRICING_NO_BID_AMOUNT", "未识别到投标函报价", "未识别到投标函或报价表中的投标报价。", "", "请补充投标函报价。")
    elif total_amount is not None and abs(bid_amount - total_amount) > MONEY_TOLERANCE:
        add(
            "fail",
            "major",
            "PRICING_BID_AMOUNT_MISMATCH",
            "投标函报价与总价不一致",
            f"投标函报价为 {_money_text(bid_amount)}，报价表总价为 {_money_text(total_amount)}。",
            "",
            "请统一投标函、开标一览表和报价汇总表中的报价。",
        )
    elif total_amount is not None:
        add_pass("PRICING_BID_AMOUNT_OK", "投标函报价与总价一致", f"投标函报价与总价均为 {_money_text(total_amount)}。")

    if chinese_amount:
        parsed_chinese = parse_chinese_money(chinese_amount)
        if parsed_chinese is None:
            add("warning", "minor", "PRICING_UPPERCASE_UNPARSEABLE", "大写金额无法解析", f"无法解析大写金额：{chinese_amount}", chinese_amount, "请人工核对大写金额是否规范。")
        elif total_amount is not None and abs(parsed_chinese - total_amount) > MONEY_TOLERANCE:
            add(
                "fail",
                "major",
                "PRICING_UPPERCASE_MISMATCH",
                "大小写金额不一致",
                f"大写金额为 {chinese_amount}（解析值 {_money_text(parsed_chinese)}），小写总价为 {_money_text(total_amount)}。",
                chinese_amount,
                "请统一大写金额和小写金额。",
            )
        elif total_amount is not None:
            add_pass("PRICING_UPPERCASE_OK", "大小写金额一致", "大写金额与小写总价一致。", chinese_amount)
    else:
        add("warning", "minor", "PRICING_NO_UPPERCASE", "未识别到大写金额", "未识别到报价大写金额。", "", "请补充人民币大写金额，或确认招标文件不要求。")

    duplicate_keys: dict[tuple[str, str, str], int] = {}
    for index, item in enumerate(line_items, 1):
        name = re.sub(r"\s+", "", _normalize_text(item.get("name"))).lower()
        unit_price = _money_text(parse_money(item.get("unit_price")))
        quantity = _money_text(parse_money(item.get("quantity")))
        key = (name, unit_price, quantity)
        if name and key in duplicate_keys:
            add(
                "warning",
                "minor",
                "PRICING_DUPLICATE_ITEM",
                "疑似重复计费项",
                f"{item.get('name')} 与第 {duplicate_keys[key]} 项名称、单价和数量相同。",
                item.get("evidence") or "",
                "请确认是否存在重复计费。",
                item.get("line") if isinstance(item.get("line"), int) else None,
            )
        else:
            duplicate_keys[key] = index

    if max_price is not None and total_amount is not None and total_amount > max_price:
        add(
            "fail",
            "critical",
            "PRICING_EXCEEDS_MAX_PRICE",
            "报价超过最高限价",
            f"投标总价 {_money_text(total_amount)} 超过最高限价 {_money_text(max_price)}。",
            "",
            "请调整报价或确认最高限价口径。",
        )

    failures = [item for item in checks if item["status"] == "fail"]
    warnings = [item for item in checks if item["status"] == "warning"]
    passed = [item for item in checks if item["status"] == "pass"]
    status = "fail" if failures else "warning" if warnings else "pass"
    if any(item["severity"] == "critical" for item in failures):
        severity = "critical"
    elif failures:
        severity = "major"
    elif warnings:
        severity = "minor"
    else:
        severity = "info"
    findings = [item["finding"] for item in checks if item["status"] != "pass"]
    if status == "pass":
        summary = "报价算术校验通过"
    elif status == "warning":
        summary = f"报价算术校验发现 {len(warnings)} 项提醒"
    else:
        summary = f"报价算术校验发现 {len(failures)} 项问题"
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


