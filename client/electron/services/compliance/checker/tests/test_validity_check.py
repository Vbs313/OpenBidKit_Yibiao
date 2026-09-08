from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from checks.validity_check import run_validity_check


def _write(directory: str, name: str, content: str) -> str:
    path = Path(directory) / name
    path.write_text(content, encoding="utf-8")
    return str(path)


def _run(bid_text: str, tender_text: str, **metadata) -> dict:
    with tempfile.TemporaryDirectory() as directory:
        return run_validity_check({
            "bid_file": _write(directory, "投标文件.md", bid_text),
            "tender_file": _write(directory, "招标文件.md", tender_text),
            "project_metadata": metadata,
        })


def _codes(result: dict) -> set[str]:
    return {item["code"] for item in result["findings"]}


class ValidityCheckTests(unittest.TestCase):
    def test_declared_validity_satisfies_requirement(self):
        result = _run(
            "投标函：投标有效期自投标截止之日起 90 日历天。\n",
            "投标人须知：投标有效期自投标截止之日起计算，不少于 60 日历天。\n",
        )
        self.assertEqual(result["status"], "pass", result)
        self.assertEqual(result["findings"], [])

    def test_short_validity_fails(self):
        result = _run(
            "投标有效期：30 天\n",
            "投标有效期自投标截止之日起计算，不少于 60 日历天。\n",
        )
        self.assertEqual(result["status"], "fail")
        self.assertIn("VALIDITY_SHORTER_THAN_REQUIRED", _codes(result))

    def test_missing_declaration_fails(self):
        result = _run("我方承诺按招标文件要求提交全部资料。\n", "无相关条款。\n")
        self.assertEqual(result["status"], "fail")
        self.assertIn("VALIDITY_NOT_DECLARED", _codes(result))

    def test_conflicting_declarations_fail(self):
        result = _run(
            "投标函：投标有效期 90 日历天。\n报价表备注：投标有效期 60 天。\n",
            "投标有效期不少于 60 日历天。\n",
        )
        self.assertIn("VALIDITY_DECLARATION_CONFLICT", _codes(result))

    def test_expiry_date_earlier_than_commitment_fails(self):
        result = _run(
            "投标有效期 90 日历天，有效期至 2026年5月1日。\n",
            "投标截止时间为 2026年3月15日。\n",
        )
        self.assertIn("VALIDITY_EXPIRES_TOO_EARLY", _codes(result))

    def test_structured_metadata_is_preferred(self):
        result = _run(
            "正文未写有效期。\n",
            "正文未写要求。\n",
            bid_validity_days=120,
            required_validity_days=90,
            bid_deadline="2026-03-15",
        )
        self.assertEqual(result["status"], "pass", result)

    def test_cjk_paths_are_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "中文项目目录"
            base.mkdir()
            bid = base / "投标文件.md"
            bid.write_text("投标有效期 90 日历天。\n", encoding="utf-8")
            result = run_validity_check({
                "bid_file": str(bid),
                "tender_file": "",
                "project_metadata": {},
            })
            self.assertEqual(result["status"], "pass", result)


if __name__ == "__main__":
    unittest.main()
