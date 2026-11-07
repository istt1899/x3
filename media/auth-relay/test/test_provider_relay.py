"""Real Python transport -> real Node relay; only VK endpoints use synthetic data.

No external accounts/endpoints, no TLS bypass in production. The test transport
maps its allowlisted fake HTTPS origin onto the test server's HTTP loopback socket.
Set MGU_TEST_NODE if node is not on PATH.
"""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import unittest
from unittest import mock
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("vk_provider_relay_test", HERE.parents[1] / "providers/vk.py")
vk = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vk)
NODE = os.environ.get("MGU_TEST_NODE") or shutil.which("node")
KEY = "test-only-key-not-a-real-secret-1234567890"
CONFIG = {"client_id": "123456", "redirect_uri": "https://vk.example/callback",
          "callback_broker": "https://vk.example", "broker_key": KEY}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LoopbackTransport(vk.DirectTransport):
    def __init__(self, port, video_allowed=True):
        super().__init__()
        self.origin = "http://127.0.0.1:" + str(port)
        self.video_allowed = video_allowed
        self.calls = []

    def request_json(self, method, url, fields=None, headers=None):
        self.calls.append((method, url, copy.deepcopy(fields), dict(headers or {})))
        parsed = urllib.parse.urlsplit(url)
        if parsed.hostname == "vk.example":
            return super().request_json(method, self.origin + parsed.path + ("?" + parsed.query if parsed.query else ""),
                                        fields, headers)
        query = {key: values[0] for key, values in urllib.parse.parse_qs(parsed.query).items()}
        if parsed.hostname == "id.vk.ru" and parsed.path == "/oauth2/auth":
            if method != "POST" or set(fields) != {"code"} or query.get("grant_type") != "authorization_code":
                raise AssertionError("Unexpected code exchange layout")
            return {"state": query["state"], "access_token": "synthetic-private-access",
                    "refresh_token": "synthetic-private-refresh", "expires_in": 3600}
        if parsed.hostname == "id.vk.ru" and parsed.path == "/oauth2/user_info":
            return {"user": {"user_id": "123", "first_name": "Synthetic", "last_name": "User"}}
        if parsed.hostname == "api.vk.ru" and parsed.path == "/method/video.get":
            return {"response": {"count": 0, "items": []}} if self.video_allowed else {"error": {"error_code": 15}}
        raise AssertionError("Unexpected external request in offline test")


@unittest.skipUnless(NODE, "Node 18+ required; set MGU_TEST_NODE")
class ProviderRelayIntegration(unittest.TestCase):
    def setUp(self):
        self.process = subprocess.Popen([NODE, str(HERE / "provider-relay-harness.js")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        self.addCleanup(self.stop_server)
        config = {"publicBaseUrl": CONFIG["callback_broker"], "clientId": CONFIG["client_id"],
                  "redirectUri": CONFIG["redirect_uri"], "apiKey": KEY}
        self.process.stdin.write(json.dumps(config) + "\n")
        self.process.stdin.flush()
        started = queue.Queue()
        threading.Thread(target=lambda: started.put(self.process.stdout.readline()), daemon=True).start()
        line = started.get(timeout=5)
        self.assertTrue(line, "Loopback relay did not start")
        self.port = json.loads(line)["port"]
        self.browser = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def stop_server(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()
        self.process.stderr.close()

    def open(self, url):
        path = urllib.parse.urlsplit(url)
        local = "http://127.0.0.1:" + str(self.port) + path.path + ("?" + path.query if path.query else "")
        try:
            return self.browser.open(local, timeout=5)
        except urllib.error.HTTPError as error:
            return error

    def finish_on_phone(self, begun):
        with self.open(begun["public"]["url"]) as redirect:
            self.assertEqual(redirect.status, 302)
            location = urllib.parse.urlsplit(redirect.headers["Location"])
            self.assertEqual(location.netloc, "id.vk.ru")
            values = urllib.parse.parse_qs(location.query)
            pending = begun["private"]["pending"]
            expected = base64.urlsafe_b64encode(hashlib.sha256(pending["code_verifier"].encode()).digest()).decode().rstrip("=")
            self.assertEqual(values["code_challenge"], [expected])
            self.assertEqual(values["state"], [pending["state"]])
            self.assertNotIn("code_verifier", values)
        callback = CONFIG["redirect_uri"] + "?" + urllib.parse.urlencode({
            "state": pending["state"], "code": "synthetic-code", "device_id": "synthetic-device"})
        with self.open(callback) as response:
            self.assertEqual(response.status, 200)
            self.assertNotIn(b"synthetic-code", response.read())

    def test_real_json_headers_pkce_callback_and_one_time_handoff(self):
        # Unusable inherited proxy must not affect VK/broker networking.
        with mock.patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:1", "HTTPS_PROXY": "http://127.0.0.1:1"}):
            transport = LoopbackTransport(self.port)
            provider = vk.Provider(transport=transport, config=CONFIG)
            begun = provider.auth_begin()
            self.assertEqual(begun["public"]["state"], "code")
            self.finish_on_phone(begun)
            completed = provider.auth_poll(begun["private"])
        self.assertEqual(completed["public"]["state"], "signed_in")
        self.assertEqual(completed["private"]["account"]["user_id"], "123")
        self.assertTrue(completed["private"]["account"]["video_access"])
        self.assertNotIn("synthetic-private", json.dumps(completed["public"]))
        pending = begun["private"]["pending"]
        created = transport.calls[0]
        self.assertEqual(created[3]["Authorization"], "Bearer " + KEY)
        self.assertNotIn("code_verifier", created[2])
        self.assertNotIn(pending["broker_poll_token"], json.dumps(begun["public"]))
        config = provider._broker_config()
        result = provider._broker_request(config, "POST", "/v1/sessions/" + pending["broker_session"] + "/poll",
                                          {"poll_token": pending["broker_poll_token"]})
        self.assertEqual(result["error"], "session_not_found")

    def test_callback_without_opened_session_refused_then_pending_and_signout(self):
        provider = vk.Provider(transport=LoopbackTransport(self.port), config=CONFIG)
        begun = provider.auth_begin()
        pending = begun["private"]["pending"]
        callback = CONFIG["redirect_uri"] + "?" + urllib.parse.urlencode({
            "state": pending["state"], "code": "synthetic-code", "device_id": "synthetic-device"})
        with self.open(callback) as response:
            self.assertEqual(response.status, 400)
        waiting = provider.auth_poll(begun["private"])
        self.assertEqual(waiting["public"]["state"], "code")
        self.assertEqual(provider.sign_out(waiting["private"])["private"], {})
        with self.open(begun["public"]["url"]) as response:
            self.assertEqual(response.status, 404)

    def test_valid_vk_id_without_video_api_permission_is_not_signed_in(self):
        provider = vk.Provider(transport=LoopbackTransport(self.port, video_allowed=False), config=CONFIG)
        begun = provider.auth_begin()
        self.finish_on_phone(begun)
        result = provider.auth_poll(begun["private"])
        self.assertEqual(result["public"]["state"], "error")
        self.assertEqual(result["public"]["code"], "video_permission_required")
        self.assertFalse(result["private"]["account"]["video_access"])


if __name__ == "__main__":
    unittest.main()
