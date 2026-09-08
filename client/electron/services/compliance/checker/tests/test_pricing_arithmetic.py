from __future__ import annotations

import json
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from checks.pricing_arithmetic import parse_chinese_money, run_pricing_arithmetic


def _write_temp_text(directory: str, name: str, content: str) -> str:
    path = Path(directory) / name
    path.write_text(content, encoding="utf-8")
    return str(path)


def _run_with_metadata(line_items, **metadata_overrides):
    with tempfile.TemporaryDirectory() as directory:
        bid_file = _write_temp_text(directory, "投标文件.md", "# 投标文件\n")
        metadata = {
            "line_items": line_items,
            "total_amount": "200.00",
            "bid_amount": "200.00",
            "bid_amount_cn": "贰佰元整",
        }
        metadata.update(metadata_overrides)
        return run_pricing_arithmetic({
            "bid_file": bid_file,
            "project_metadata": metadata,
        })


class PricingArithmeticTests(unittest.TestCase):
    def test_consistent_quote_passes(self):
        result = _run_with_metadata([
            {"name": "设备A", "unit_price": "100.00", "quantity": "2", "subtotal": "200.00"},
        ])
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["metrics"]["failed"], 0)
        self.assertEqual(result["findings"], [])

    def test_line_arithmetic_mismatch_fails(self):
        result = _run_with_metadata([
            {"name": "设备A", "unit_price": "100.00", "quantity": "2", "subtotal": "250.00"},
        ], total_amount="250.00", bid_amount="250.00", bid_amount_cn="贰佰伍拾元整")
        self.assertEqual(result["status"], "fail")
        codes = {item["code"] for item in result["findings"]}
        self.assertIn("PRICING_LINE_ARITHMETIC_MISMATCH", codes)

    def test_missing_quantity_fails(self):
        result = _run_with_metadata([
            {"name": "设备A", "unit_price": "100.00", "subtotal": "100.00"},
        ], total_amount="100.00", bid_amount="100.00", bid_amount_cn="壹佰元整")
        self.assertEqual(result["status"], "fail")
        codes = {item["code"] for item in result["findings"]}
        self.assertIn("PRICING_MISSING_QUANTITY", codes)

    def test_precision_warning_is_reported(self):
        result = _run_with_metadata([
            {"name": "设备A", "unit_price": "0.333", "quantity": "3", "subtotal": "0.999"},
        ], total_amount="0.999", bid_amount="0.999", bid_amount_cn=None)
        codes = {item["code"] for item in result["findings"]}
        self.assertIn("PRICING_PRECISION", codes)

    def test_chinese_money_parser(self):
        self.assertEqual(parse_chinese_money("伍佰捌拾万元整"), Decimal("5800000"))
        self.assertEqual(
            parse_chinese_money("壹仟贰佰叁拾肆万伍仟陆佰柒拾捌元"),
            Decimal("12345678"),
        )

    def test_markdown_table_is_parsed(self):
        with tempfile.TemporaryDirectory() as directory:
            bid_file = _write_temp_text(directory, "投标文件.md", "\n".join([
                "# 投标报价表",
                "| 名称 | 单价 | 数量 | 合计 |",
                "| --- | ---: | ---: | ---: |",
                "| 设备A | 100.00 | 2 | 200.00 |",
                "",
                "投标总价：200.00元",
                "投标报价（大写）：贰佰元整（200.00元）",
            ]))
            result = run_pricing_arithmetic({
                "bid_file": bid_file,
                "project_metadata": {},
            })
            self.assertEqual(result["status"], "pass", result)
            codes = {item["code"] for item in result["findings"]}
            self.assertNotIn("PRICING_NO_LINE_ITEMS", codes)


if __name__ == "__main__":
    unittest.main()
