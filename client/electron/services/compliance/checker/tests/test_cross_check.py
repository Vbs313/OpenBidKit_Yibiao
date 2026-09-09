from __future__ import annotations

import json
import os
import unittest.mock as mock
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import runner
from checks.cross_check import _normalize_verdicts, extract_scoring_items, run_cross_check
from llm_client import MODEL_TOKEN_ENV, LlmUnavailable, chat_json

TENDER = "\n".join([
    "技术评分：",
    "施工组织设计，30分",
    "质量保障措施，20分",
    "售后服务方案，15分",
])
BID = "我方施工组织设计覆盖全过程，并提供质量保障与售后响应承诺。"


class _MockProxy(BaseHTTPRequestHandler):
    # 令牌常量必须挂在处理类上，否则鉴权分支会抛 AttributeError 掐断连接。
    SERVER_TOKEN = "cross-check-token"

    payload = DEFAULT_PAYLOAD = {"items": [
        {"id": "T01", "status": "covered", "evidence": "施工组织设计章节", "reason": "有具体做法", "suggestion": ""},
        {"id": "T02", "status": "missing", "evidence": "", "reason": "未检索到质量保障实质内容", "suggestion": "补充检验批与验收标准"},
        {"id": "T99", "status": "covered", "evidence": "编造条目", "reason": "应被丢弃", "suggestion": ""},
    ]}

    def do_POST(self):  # noqa: N802
        # 先把请求体读空，否则 HTTP/1.1 提前返回会让客户端看到连接被掐断。
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        self.server.requests.append(body)
        # 与 B 侧真实代理一致：无令牌一律 401，确保检查链路不会绕过鉴权。
        if self.headers.get("Authorization") != f"Bearer {self.SERVER_TOKEN}":
            payload = b'{"error":{"message":"unauthorized"}}'
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        content = json.dumps(type(self).payload, ensure_ascii=False)
        if type(self).payload.get("_raw"):
            content = type(self).payload["_raw"]
        response = json.dumps({
            "id": "chatcmpl-1",
            "model": body.get("model"),
            "choices": [{"message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 40},
        }, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, *args):
        return


class CrossCheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.token_patch = mock.patch.dict(os.environ, {MODEL_TOKEN_ENV: _MockProxy.SERVER_TOKEN})
        cls.token_patch.start()
        cls.server = HTTPServer(("127.0.0.1", 0), _MockProxy)
        cls.server.requests = []
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_address[1]}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.token_patch.stop()

    def _config(self):
        return {"base_url": self.base_url, "model": "test-model"}

    def test_rule_extraction_finds_scoring_items(self):
        items = extract_scoring_items(TENDER)
        self.assertEqual([item["name"] for item in items], ["施工组织设计", "质量保障措施", "售后服务方案"])

    def test_cross_check_maps_model_verdicts(self):
        with tempfile.TemporaryDirectory() as directory:
            tender = Path(directory) / "tender.md"
            bid = Path(directory) / "bid.md"
            tender.write_text(TENDER, encoding="utf-8")
            bid.write_text(BID, encoding="utf-8")
            result = run_cross_check({
                "tender_file": str(tender),
                "bid_file": str(bid),
                "model_config": self._config(),
            })
        self.assertEqual(result["check_id"], "cross_check")
        self.assertEqual(result["status"], "fail")
        # 模型返回的 T99 不在编号清单内，必须被丢弃；T01/T02 正常回填，T02 missing 成为严重问题。
        # 施工组织设计=covered，质量保障措施=missing，售后服务方案未检索到 → 两项 major 问题。
        self.assertEqual(result["metrics"]["total"], 3)
        self.assertEqual(result["metrics"]["passed"], 1)
        self.assertEqual(result["metrics"]["failed"], 2)
        self.assertEqual(result["metrics"]["warning"], 0)
        self.assertEqual([item["id"] for item in result["findings"]], ["cross-check:T02", "cross-check:T03"])
        self.assertEqual(result["findings"][0]["code"], "CROSS_CHECK_MISSING")
        self.assertEqual(result["findings"][1]["code"], "CROSS_CHECK_NOT_LOCATED")
        self.assertEqual(result["usage"]["model"], "test-model")
        self.assertEqual(result["usage"]["prompt_tokens"], 120)
        sent = self.server.requests[-1]
        self.assertEqual(sent["model"], "test-model")
        self.assertEqual(sent["response_format"], {"type": "json_object"})
        self.assertNotIn("api_key", json.dumps(sent))
        self.assertIn("T01｜施工组织设计｜30分", sent["messages"][1]["content"])

    def test_registry_marks_cross_check_as_needing_model(self):
        entry = runner.CHECK_REGISTRY["cross_check"]
        self.assertTrue(entry["requires_model"])
        listed = next(item for item in runner.available_checks() if item["check_id"] == "cross_check")
        self.assertTrue(listed["requires_model"])

    def test_runner_skips_when_model_config_missing(self):
        results = runner.run_checks({"checks": ["cross_check"]})
        self.assertEqual(results[0]["status"], "warning")
        self.assertEqual(results[0]["findings"][0]["code"], "CHECK_SKIPPED_MODEL_UNAVAILABLE")

    def test_non_loopback_base_url_rejected(self):
        with self.assertRaises(LlmUnavailable):
            chat_json({"base_url": "https://api.deepseek.com/v1", "model": "m"}, [])

    def test_malformed_model_output_raises(self):
        _MockProxy.payload = {"_raw": "not json at all"}
        try:
            with tempfile.TemporaryDirectory() as directory:
                tender = Path(directory) / "tender.md"
                tender.write_text(TENDER, encoding="utf-8")
                bid = Path(directory) / "bid.md"
                bid.write_text(BID, encoding="utf-8")
                with self.assertRaises(LlmUnavailable):
                    run_cross_check({
                        "tender_file": str(tender),
                        "bid_file": str(bid),
                        "model_config": self._config(),
                    })
        finally:
            _MockProxy.payload = {"items": []}

    def test_locates_evidence_at_end_of_very_long_bid(self):
        """回归：旧实现把投标文件截断到 12000 字，尾部内容会被误判为未覆盖。"""
        with tempfile.TemporaryDirectory() as directory:
            tender = Path(directory) / "招标文件.md"
            tender.write_text("应急保障预案，25分\n", encoding="utf-8")
            bid = Path(directory) / "投标文件.md"
            filler = "通用承诺内容。" * 6000  # 约 4.2 万字，远超旧阈值
            bid.write_text(filler + "\n应急保障预案：配备2辆抢修车，30分钟到场。\n", encoding="utf-8")
            before = len(_MockProxy.calls) if hasattr(_MockProxy, "calls") else 0
            result = run_cross_check({
                "tender_file": str(tender),
                "bid_file": str(bid),
                "model_config": self._config(),
            })
        # 尾部内容被定位到，因此不会以“未检索到”结束，而是交给模型判定。
        codes = [item["code"] for item in result["findings"]]
        self.assertNotIn("CROSS_CHECK_NOT_LOCATED", codes, result)

    def test_parses_markdown_scoring_table(self):
        table = "\n".join([
            "| 序号 | 评审因素 | 分值 |",
            "| --- | --- | --- |",
            "| 1 | 施工组织设计 | 30 |",
            "| 2 | 质量保障措施 | 20 |",
            "| 3 | 合计 | 50 |",
        ])
        items = extract_scoring_items(table)
        self.assertEqual([item["name"] for item in items], ["施工组织设计", "质量保障措施"])
        self.assertEqual([item["score"] for item in items], ["30", "20"])

    def test_skips_model_when_nothing_located(self):
        """全文都没命中时不该白烧一次模型调用。"""
        with tempfile.TemporaryDirectory() as directory:
            tender = Path(directory) / "招标文件.md"
            tender.write_text("BIM协同平台应用，18分\n", encoding="utf-8")
            bid = Path(directory) / "投标文件.md"
            bid.write_text("我方完全响应招标文件全部要求。\n", encoding="utf-8")
            calls_before = len(self.server.requests)
            result = run_cross_check({
                "tender_file": str(tender),
                "bid_file": str(bid),
                "model_config": self._config(),
            })
        self.assertEqual(len(self.server.requests), calls_before, "未定位到证据时不应请求模型")
        self.assertEqual(result["findings"][0]["code"], "CROSS_CHECK_NOT_LOCATED")
        self.assertEqual(result["usage"]["model"], None)

    def test_every_verdict_status_is_accepted(self):
        """四种判定都必须被采纳；曾因为漏掉 missing 而把“未覆盖”静默丢弃。"""
        rows = [{"id": f"T0{i}", "requirement": f"项{i}", "score": "10", "snippets": ["证据"], "line": None} for i in range(1, 5)]
        parsed = {"items": [
            {"id": "T01", "status": "covered", "evidence": "e", "reason": "r", "suggestion": "s"},
            {"id": "T02", "status": "partial", "evidence": "e", "reason": "r", "suggestion": "s"},
            {"id": "T03", "status": "missing", "evidence": "e", "reason": "r", "suggestion": "s"},
            {"id": "T04", "status": "unknown", "evidence": "e", "reason": "r", "suggestion": "s"},
        ]}
        verdicts = _normalize_verdicts(parsed, rows)
        self.assertEqual([v["status"] for v in verdicts], ["covered", "partial", "missing", "unknown"])

    def test_metrics_never_contradict_findings(self):
        # metrics 必须由 findings 推导，否则页面顶部汇总会把提醒吞掉。
        with tempfile.TemporaryDirectory() as directory:
            tender = Path(directory) / "招标文件.md"
            tender.write_text("本项目无技术评分表。", encoding="utf-8")
            bid = Path(directory) / "投标文件.md"
            bid.write_text(BID, encoding="utf-8")
            result = run_cross_check({
                "tender_file": str(tender),
                "bid_file": str(bid),
                "model_config": self._config(),
            })
        metrics = result["metrics"]
        minor = len([item for item in result["findings"] if item["severity"] == "minor"])
        major = len([item for item in result["findings"] if item["severity"] in ("major", "critical")])
        self.assertEqual(metrics["warning"], minor)
        self.assertEqual(metrics["failed"], major)
        self.assertEqual(metrics["total"], metrics["passed"] + metrics["failed"] + metrics["warning"])
        self.assertGreater(metrics["total"], 0, "有明细时计数不能全为 0")

    def test_model_without_verdicts_is_warning_not_pass(self):
        # 所有编号都能定位、但模型没给判定时，必须报提醒，不能假装通过。
        _MockProxy.payload = {"items": []}
        try:
            with tempfile.TemporaryDirectory() as directory:
                tender = Path(directory) / "招标文件.md"
                tender.write_text("施工组织设计，30分\n", encoding="utf-8")
                bid = Path(directory) / "投标文件.md"
                bid.write_text("本章为施工组织设计。", encoding="utf-8")
                result = run_cross_check({
                    "tender_file": str(tender),
                    "bid_file": str(bid),
                    "model_config": self._config(),
                })
        finally:
            _MockProxy.payload = _MockProxy.DEFAULT_PAYLOAD
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["findings"][0]["code"], "CROSS_CHECK_NO_VERDICTS")
        self.assertEqual(result["metrics"]["warning"], 1)

    def test_no_scoring_items_is_visible_warning(self):
        with tempfile.TemporaryDirectory() as directory:
            tender = Path(directory) / "tender.md"
            tender.write_text("本项目无技术评分表。", encoding="utf-8")
            bid = Path(directory) / "bid.md"
            bid.write_text("正文", encoding="utf-8")
            result = run_cross_check({"tender_file": str(tender), "bid_file": str(bid), "model_config": self._config()})
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["findings"][0]["code"], "CROSS_CHECK_NO_SCORING_ITEMS")


if __name__ == "__main__":
    unittest.main()
