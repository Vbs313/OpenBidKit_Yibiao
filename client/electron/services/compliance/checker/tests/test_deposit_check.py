from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from checks.deposit_check import run_deposit_check


def _write(directory: str, name: str, content: str) -> str:
    path = Path(directory) / name
    path.write_text(content, encoding="utf-8")
    return str(path)


def _run(tender_lines, bid_lines, **metadata) -> dict:
    with tempfile.TemporaryDirectory() as directory:
        return run_deposit_check({
            "tender_file": _write(directory, "招标文件.md", "\n".join(tender_lines) + "\n"),
            "bid_file": _write(directory, "投标文件.md", "\n".join(bid_lines) + "\n"),
            "project_metadata": metadata,
        })


def _codes(result: dict) -> set[str]:
    return {item["code"] for item in result["findings"]}


class DepositCheckTests(unittest.TestCase):
    def test_matching_deposit_passes(self):
        result = _run(
            ["投标保证金：人民币 20,000.00元，须于 2026年3月10日前 以银行转账缴纳。", "投标截止时间：2026年3月15日。"],
            ["我方已缴纳投标保证金 20,000.00元，缴纳方式为银行转账。"],
        )
        self.assertEqual(result["status"], "pass", result)
        self.assertEqual(result["findings"], [])

    def test_amount_mismatch_is_critical(self):
        result = _run(
            ["投标保证金 20,000.00元", "投标截止时间：2026年3月15日。"],
            ["投标保证金 15,000.00元，银行转账。"],
        )
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["severity"], "critical")
        self.assertIn("DEPOSIT_AMOUNT_MISMATCH", _codes(result))

    def test_missing_deposit_declaration_fails(self):
        result = _run(
            ["投标保证金 20,000.00元", "投标截止时间：2026年3月15日。"],
            ["我方完全响应招标文件要求。"],
        )
        self.assertIn("DEPOSIT_BID_AMOUNT_MISSING", _codes(result))

    def test_missing_method_fails(self):
        result = _run(
            ["投标保证金 20,000.00元"],
            ["投标保证金 20,000.00元，已按要求缴纳。"],
        )
        self.assertIn("DEPOSIT_METHOD_MISSING", _codes(result))

    def test_wan_unit_is_scaled(self):
        result = _run(
            ["投标保证金 2万元", "投标截止时间：2026年3月15日。"],
            ["投标保证金 20,000元，采用电汇方式缴纳。"],
        )
        self.assertEqual(result["status"], "pass", result)

    def test_no_deposit_requirement_is_skipped(self):
        result = _run(
            ["本项目不收取投标保证金。"],
            ["我方按招标文件要求提交全部文件。"],
        )
        self.assertEqual(result["status"], "pass", result)
        self.assertEqual(result["findings"], [], "无需缴纳保证金时不应产生任何提醒")
        self.assertEqual(result["metrics"], {"total": 1, "passed": 1, "failed": 0, "warning": 0})

    def test_rate_and_budget_upper_bound(self):
        result = _run(
            ["投标保证金为预算金额的 2%", "投标截止时间：2026年3月15日。"],
            ["投标保证金 30,000.00元，银行转账缴纳。"],
            budget_amount="1000000.00",
        )
        self.assertIn("DEPOSIT_RATE_EXCEEDED", _codes(result))

    def test_deadline_after_bid_deadline_warns(self):
        result = _run(
            ["投标保证金 20,000.00元，须于 2026年3月20日前 缴纳。", "投标截止时间：2026年3月15日。"],
            ["投标保证金 20,000.00元，银行转账。"],
        )
        self.assertIn("DEPOSIT_DEADLINE_LATE", _codes(result))

    def test_cjk_path_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "中文项目目录"
            base.mkdir()
            tender = base / "招标文件.md"
            bid = base / "投标文件.md"
            tender.write_text("投标保证金 20,000.00元，投标截止时间：2026年3月15日。\n", encoding="utf-8")
            bid.write_text("投标保证金 20,000.00元，银行转账缴纳。\n", encoding="utf-8")
            result = run_deposit_check({
                "tender_file": str(tender),
                "bid_file": str(bid),
                "project_metadata": {},
            })
            self.assertEqual(result["status"], "pass", result)


if __name__ == "__main__":
    unittest.main()
