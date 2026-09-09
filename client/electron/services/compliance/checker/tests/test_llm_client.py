from __future__ import annotations

import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from llm_client import MODEL_TOKEN_ENV, LlmUnavailable, chat_json

CAPTURED: list[dict] = []


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        CAPTURED.append({
            "authorization": self.headers.get("Authorization") or "",
            "body": body,
            "path": self.path,
        })
        if self.headers.get("Authorization") != "Bearer loopback-token":
            payload = json.dumps({"error": {"message": "Unauthorized"}}).encode("utf-8")
            self.send_response(401)
        else:
            payload = json.dumps({
                "model": body.get("model"),
                "choices": [{"message": {"role": "assistant", "content": '{"ok":true}'}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 4},
            }, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        return


class LlmClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        CAPTURED.clear()
        cls.server = HTTPServer(("127.0.0.1", 0), _Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_address[1]}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _config(self, **extra):
        return {"base_url": self.base_url, "model": "m1", **extra}

    def test_token_comes_from_environment_not_protocol(self):
        previous = os.environ.get(MODEL_TOKEN_ENV)
        os.environ[MODEL_TOKEN_ENV] = "loopback-token"
        try:
            parsed, usage = chat_json(self._config(), [{"role": "user", "content": "hi"}])
        finally:
            if previous is None:
                os.environ.pop(MODEL_TOKEN_ENV, None)
            else:
                os.environ[MODEL_TOKEN_ENV] = previous
        self.assertEqual(parsed, {"ok": True})
        self.assertEqual(usage["model"], "m1")
        self.assertEqual(usage["prompt_tokens"], 3)
        sent = CAPTURED[-1]
        self.assertEqual(sent["authorization"], "Bearer loopback-token")
        self.assertEqual(sent["body"]["response_format"], {"type": "json_object"})
        self.assertNotIn("api_key", json.dumps(sent["body"]))
        self.assertNotIn("loopback-token", json.dumps(sent["body"]))

    def test_missing_token_raises_clear_message(self):
        os.environ.pop(MODEL_TOKEN_ENV, None)
        with self.assertRaises(LlmUnavailable) as raised:
            chat_json(self._config(), [{"role": "user", "content": "hi"}])
        self.assertIn(MODEL_TOKEN_ENV, str(raised.exception))

    def test_rejects_non_loopback_and_credentials_in_config(self):
        with self.assertRaises(LlmUnavailable):
            chat_json({"base_url": "https://api.deepseek.com/v1", "model": "m"}, [])
        with self.assertRaises(LlmUnavailable):
            chat_json(None, [])
        with self.assertRaises(LlmUnavailable):
            chat_json({"base_url": self.base_url}, [])

    def test_authorization_header_ignores_any_injected_value(self):
        # 即使调用方误把令牌塞进 model_config，也只认环境变量，不外传该值。
        os.environ[MODEL_TOKEN_ENV] = "loopback-token"
        try:
            parsed, _usage = chat_json(self._config(api_token="evil"), [{"role": "user", "content": "x"}])
            self.assertEqual(parsed, {"ok": True})
        finally:
            os.environ.pop(MODEL_TOKEN_ENV, None)


if __name__ == "__main__":
    unittest.main()
