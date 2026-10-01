"""performance_check 单元测试。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from checks.performance_check import CHECK_ID, CHECK_NAME, run_performance_check


def _write(directory: str, name: str, content: str) -> str:
    path = Path(directory) / name
    path.write_text(content, encoding="utf-8")
    return str(path)


class PerformanceCheckTest(unittest.TestCase):
    def test_passes_when_met(self):
        with tempfile.TemporaryDirectory() as tmp:
            tender = _write(tmp, "tender.md", "近三年完成类似业绩不少于 3 项。合同金额不低于 100 万元。")
            bid = _write(tmp, "bid.md", "我方近三年完成类似业绩共 5 项。合同金额为 200 万元。")
            result = run_performance_check({"tender_path": tender, "bid_path": bid})
            self.assertEqual(result["check_id"], CHECK_ID)
            self.assertEqual(result["check_name"], CHECK_NAME)
            self.assertEqual(result["status"], "passed")
            self.assertFalse(result["skipped"])

    def test_fails_when_count_insufficient(self):
        with tempfile.TemporaryDirectory() as tmp:
            tender = _write(tmp, "tender.md", "近三年完成类似业绩不少于 5 项。")
            bid = _write(tmp, "bid.md", "我方近三年完成类似业绩共 2 项。")
            result = run_performance_check({"tender_path": tender, "bid_path": bid})
            self.assertEqual(result["status"], "failed")
            self.assertTrue(any(f["level"] == "error" for f in result["findings"]))

    def test_warns_when_amount_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            tender = _write(tmp, "tender.md", "合同金额不低于 500 万元。")
            bid = _write(tmp, "bid.md", "我方业绩丰富。")
            result = run_performance_check({"tender_path": tender, "bid_path": bid})
            self.assertEqual(result["status"], "warned")
            self.assertTrue(any(f["level"] == "warn" for f in result["findings"]))

    def test_skips_when_no_requirement(self):
        with tempfile.TemporaryDirectory() as tmp:
            tender = _write(tmp, "tender.md", "本项目无业绩要求。")
            bid = _write(tmp, "bid.md", "我方响应。")
            result = run_performance_check({"tender_path": tender, "bid_path": bid})
            self.assertEqual(result["status"], "passed")
            self.assertTrue(any("未明确声明业绩要求" in f["message"] for f in result["findings"]))

    def test_skips_when_tender_empty(self):
        result = run_performance_check({"tender_path": "", "bid_path": ""})
        self.assertTrue(result["skipped"])
        self.assertEqual(result["status"], "warned")


if __name__ == "__main__":
    unittest.main()
