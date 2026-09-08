from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import checker_sidecar
import runner


def _request(payload: dict) -> dict:
    return checker_sidecar._handle_request(payload)


class ProtocolModelConfigTests(unittest.TestCase):
    def setUp(self):
        self.bid_dir = tempfile.TemporaryDirectory()
        bid = Path(self.bid_dir.name) / "投标文件.md"
        bid.write_text("投标有效期 90 日历天。\n", encoding="utf-8")
        self.bid_file = str(bid)

    def tearDown(self):
        self.bid_dir.cleanup()

    def test_available_checks_report_requires_model_flag(self):
        checks = runner.available_checks()
        self.assertTrue(all("requires_model" in item for item in checks))
        self.assertTrue(all(item["requires_model"] is False for item in checks))

    def test_valid_loopback_model_config_is_accepted(self):
        response = _request({
            "version": "1.0",
            "job_id": "job-1",
            "action": "run_checks",
            "model_config": {"base_url": "http://127.0.0.1:4891/v1", "model": "deepseek-chat"},
            "input": {"bid_file": self.bid_file, "checks": ["validity"]},
        })
        self.assertEqual(response["status"], "success", response)
        self.assertEqual(response["results"][0]["check_id"], "validity")

    def test_api_key_in_model_config_is_rejected(self):
        # 请求级凭据扫描先于 model_config 字段校验，两种拒绝码都算通过；关键是密钥不得外泄。
        response = _request({
            "version": "1.0",
            "job_id": "job-2",
            "action": "run_checks",
            "model_config": {"base_url": "http://localhost:4891/v1", "api_key": "sk-secretvalue"},
            "input": {"bid_file": self.bid_file, "checks": ["validity"]},
        })
        self.assertEqual(response["status"], "error")
        self.assertIn(response["error"]["code"], {"INVALID_MODEL_CONFIG", "CREDENTIAL_FIELD_FORBIDDEN"})
        self.assertNotIn("sk-secretvalue", json.dumps(response, ensure_ascii=False))

    def test_non_loopback_base_url_is_rejected(self):
        response = _request({
            "version": "1.0",
            "job_id": "job-3",
            "action": "run_checks",
            "model_config": {"base_url": "https://api.deepseek.com/v1"},
            "input": {"bid_file": self.bid_file, "checks": ["validity"]},
        })
        self.assertEqual(response["error"]["code"], "INVALID_MODEL_CONFIG")

    def test_credential_field_anywhere_in_request_is_rejected(self):
        response = _request({
            "version": "1.0",
            "job_id": "job-4",
            "action": "run_checks",
            "input": {"bid_file": self.bid_file, "checks": ["validity"], "api_key": "sk-anothersecret"},
        })
        self.assertEqual(response["error"]["code"], "CREDENTIAL_FIELD_FORBIDDEN")
        self.assertNotIn("sk-anothersecret", json.dumps(response, ensure_ascii=False))

    def test_llm_check_without_model_config_is_skipped_not_crashed(self):
        runner.CHECK_REGISTRY["temporary_llm"] = {
            "name": "临时模型检查",
            "runner": lambda payload: {"check_id": "temporary_llm"},
            "requires_model": True,
        }
        try:
            response = _request({
                "version": "1.0",
                "job_id": "job-5",
                "action": "run_checks",
                "input": {"bid_file": self.bid_file, "checks": ["temporary_llm"]},
            })
            self.assertEqual(response["status"], "success")
            self.assertEqual(response["results"][0]["status"], "warning")
            self.assertEqual(response["results"][0]["findings"][0]["code"], "CHECK_SKIPPED_MODEL_UNAVAILABLE")
        finally:
            runner.CHECK_REGISTRY.pop("temporary_llm", None)

    def test_main_survives_invalid_json_and_keeps_running(self):
        script = Path(checker_sidecar.__file__).read_text(encoding="utf-8")
        self.assertIn("for raw_line in sys.stdin", script)
        stdin = io.StringIO('not-json\n' + json.dumps({"version": "1.0", "job_id": "job-6", "action": "ping"}) + "\n")
        stdout = io.StringIO()
        original_stdin, original_stdout = sys.stdin, sys.stdout
        sys.stdin, sys.stdout = stdin, stdout
        try:
            # main() 会尝试 reconfigure，StringIO 具备该方法，直接跑完输入即可退出。
            exit_code = checker_sidecar.main()
        finally:
            sys.stdin, sys.stdout = original_stdin, original_stdout
        self.assertEqual(exit_code, 0)
        lines = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertEqual(lines[0]["error"]["code"], "INVALID_JSON")
        self.assertEqual(lines[1]["message"], "pong")


if __name__ == "__main__":
    unittest.main()
