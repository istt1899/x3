"""Offline contract/regression checks. No account or online endpoint is used here."""
import copy
import hashlib
import base64
import importlib.util
import json
import os
from pathlib import Path
import ssl
import time
import types
import unittest
from unittest import mock
import urllib.parse

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("mgu_vk_provider", HERE.parent / "vk.py")
vk = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vk)


class FakeTransport:
    def __init__(self, video_allowed=True, bad_token_state=False):
        self.calls = []
        self.video_allowed = video_allowed
        self.bad_token_state = bad_token_state
        self.callback_ready = False
        self.broker_consumed = False
        self.broker_state = None
        self.broker_url = "https://vk.example/s/" + "s" * 22

    def request_json(self, method, url, fields=None, headers=None):
        self.calls.append((method, url, copy.deepcopy(fields), dict(headers or {})))
        parsed = urllib.parse.urlsplit(url)
        query = {key: values[0] for key, values in urllib.parse.parse_qs(parsed.query).items()}
        if parsed.path == "/v1/sessions":
            self.broker_state = fields["state"]
            return {"session_id": "s" * 22, "poll_token": "p" * 43, "url": self.broker_url,
                    "expires_in": 600, "poll_interval": 5}
        if parsed.path.endswith("/poll"):
            if self.broker_consumed:
                return {"error": "session_not_found"}
            if not self.callback_ready:
                return {"status": "pending", "poll_after": 5}
            self.broker_consumed = True
            return {"status": "complete", "state": self.broker_state, "code": "returned-code", "device_id": "returned-device"}
        if method == "DELETE":
            return {"status": "deleted"}
        if parsed.path.endswith("/oauth2/auth"):
            return {"access_token": "private-access", "refresh_token": "private-refresh", "expires_in": 3600,
                    "state": "wrong-state" if self.bad_token_state else query["state"]}
        if parsed.path.endswith("/oauth2/user_info"):
            return {"user": {"user_id": "123", "first_name": "Test", "last_name": "Person"}}
        if parsed.path.endswith("/method/video.get"):
            return {"response": {"count": 0, "items": []}} if self.video_allowed else {"error": {"error_code": 15}}
        if parsed.path.endswith("/oauth2/logout"):
            return {"response": 1}
        raise AssertionError("Unexpected endpoint")


class FakeModule:
    def __init__(self, payload=None, info=None):
        self.options = []
        self.requests = []
        self.payload = payload
        self.info = info
        parent = self

        class VKIE:
            def __init__(self, downloader):
                self.downloader = downloader

            def _download_payload(self, path, video_id, data):
                parent.requests.append((path, video_id, data))
                return copy.deepcopy(parent.payload)

        self.VKIE = VKIE

    def YoutubeDL(self, options):
        self.options.append(copy.deepcopy(options))
        parent = self

        class Downloader:
            params = dict(options)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def extract_info(self, url, download, process):
                parent.requests.append((url, download, process))
                return copy.deepcopy(parent.info)

        return Downloader()


class VKProviderTest(unittest.TestCase):
    def test_search_fixture_and_direct_policy(self):
        payload = json.loads((HERE / "fixtures/vk_search.json").read_text(encoding="utf-8"))
        # Invalid source rows are not allowed to become commands/paths.
        payload[2]["list"].extend([["../bad", 12, "https://invalid", "bad", 0, "0:10"], payload[2]["list"][0]])
        module = FakeModule(payload=payload)
        with mock.patch.dict(os.environ, {"HTTP_PROXY": "http://youtube-proxy.invalid:3128",
                                          "HTTPS_PROXY": "http://youtube-proxy.invalid:3128"}):
            result = vk.Provider(FakeTransport(), module).search(" NASA ")
        self.assertEqual(len(result["items"]), 2)
        first = result["items"][0]
        self.assertEqual(first["id"], "-230138956_456239834")
        self.assertEqual(first["title"], "Space & NASA!")
        self.assertEqual(first["channel"], "Fixture channel")
        self.assertEqual(first["duration_s"], 4964)
        self.assertEqual(result["items"][1]["duration_s"], 9)
        self.assertEqual(result["next_offset"], 2)
        self.assertEqual(module.options[0]["proxy"], "")
        self.assertNotIn("cookiefile", module.options[0])
        self.assertEqual(module.requests[0][2]["act"], "search_video")

    def test_search_schema_change_is_explicit(self):
        with self.assertRaises(vk.ProviderError) as context:
            vk.Provider(FakeTransport(), FakeModule(payload=[3, []])).search("NASA")
        self.assertEqual(context.exception.code, "invalid_response")

    def test_home_is_not_fake_recommendations(self):
        result = vk.Provider(FakeTransport()).home()
        self.assertEqual(result["kind"], "requires_search")
        self.assertEqual(result["items"], [])

    def test_resolve_keeps_signed_url_user_agent(self):
        info = {"id": "205387401_165548505", "title": "No name", "duration": 9,
                "formats": [{"format_id": "url144", "url": "https://vkvd586.okcdn.ru/test.mp4?srcAg=bound",
                             "ext": "mp4", "height": 144}],
                "http_headers": {"Cookie": "unrelated-private-cookie", "Authorization": "private-bearer"}}
        module = FakeModule(info=info)
        result = vk.Provider(FakeTransport(), module).resolve("205387401_165548505")
        self.assertEqual(result["network"], "direct")
        self.assertEqual(result["formats"][0]["http_headers"]["User-Agent"], module.options[0]["http_headers"]["User-Agent"])
        self.assertNotIn("Cookie", result["http_headers"])
        self.assertNotIn("Authorization", result["http_headers"])
        self.assertEqual(module.options[0]["proxy"], "")

    def test_resolve_rejects_external_youtube_embed(self):
        module = FakeModule(info={"_type": "url", "url": "https://www.youtube.com/watch?v=example"})
        with self.assertRaises(vk.ProviderError) as context:
            vk.Provider(FakeTransport(), module).resolve("205387401_165548505")
        self.assertEqual(context.exception.code, "external_video")

    def test_resolve_rejects_paths_and_urls_from_ui(self):
        provider = vk.Provider(FakeTransport(), FakeModule())
        for value in ["../account", "https://vk.com/video1_2", "0_2", "1_0", "1_2;command"]:
            with self.subTest(value=value), self.assertRaises(vk.ProviderError):
                provider.resolve(value)

    def test_direct_transport_does_not_inherit_proxy_or_disable_tls(self):
        with mock.patch.dict(os.environ, {"HTTPS_PROXY": "http://youtube-proxy.invalid:3128"}):
            transport = vk.DirectTransport()
        for handler in transport.opener.handlers:
            if isinstance(handler, vk.urllib.request.ProxyHandler):
                self.assertEqual(handler.proxies, {})
            if isinstance(handler, vk.urllib.request.HTTPSHandler):
                self.assertEqual(handler._context.verify_mode, ssl.CERT_REQUIRED)
                self.assertTrue(handler._context.check_hostname)
        redirect = next(handler for handler in transport.opener.handlers if isinstance(handler, vk.urllib.request.HTTPRedirectHandler))
        self.assertIsNone(redirect.redirect_request(None, None, 302, 'redirect', {}, 'http://attacker.invalid/'))


class VKAuthTest(unittest.TestCase):
    CONFIG = {"client_id": "123456", "redirect_uri": "https://vk.example/callback", "scope": "video",
              "callback_broker": "https://vk.example", "broker_key": "test-only-key-not-a-real-secret-1234567890"}

    def begin(self, transport=None):
        provider = vk.Provider(transport or FakeTransport(), config=self.CONFIG)
        result = provider.auth_begin()
        self.assertEqual(result["public"]["state"], "code")
        return provider, result

    def complete(self, provider, result, **changes):
        fields = {"code": "returned-code", "device_id": "returned-device",
                  "state": result["private"]["pending"]["state"], "private_auth": result["private"]}
        fields.update(changes)
        return provider.auth_complete(**fields)

    def test_no_registered_app_is_not_signed_in(self):
        result = vk.Provider(FakeTransport()).auth_begin()
        self.assertEqual(result["public"]["code"], "configuration_required")
        self.assertEqual(result["public"]["state"], "error")
        self.assertEqual(result["private"], {})

    def test_pkce_verifier_is_private_and_challenge_matches(self):
        provider, result = self.begin()
        pending = result["private"]["pending"]
        fields = provider.transport.calls[0][2]
        expected = base64.urlsafe_b64encode(hashlib.sha256(pending["code_verifier"].encode()).digest()).decode().rstrip("=")
        self.assertEqual(fields["code_challenge"], expected)
        self.assertEqual(fields["state"], pending["state"])
        self.assertNotIn("code_verifier", fields)
        self.assertLessEqual(len(result["public"]["url"]), 62)
        self.assertEqual(urllib.parse.urlsplit(result["public"]["url"]).path, "/s/" + "s" * 22)
        self.assertNotIn(pending["code_verifier"], json.dumps(result["public"]))
        self.assertNotIn(pending["broker_poll_token"], json.dumps(result["public"]))
        self.assertNotIn(self.CONFIG["broker_key"], json.dumps(result["public"]))
        self.assertEqual(provider.auth_poll(result)["public"]["state"], "code")

    def test_callback_state_target_and_expiry_must_match(self):
        for mode in ["state", "host", "expired"]:
            with self.subTest(mode=mode):
                transport = FakeTransport()
                provider, result = self.begin(transport)
                if mode == "state":
                    output = self.complete(provider, result, state="wrong")
                elif mode == "host":
                    output = provider.auth_complete(callback_url="https://attacker.example/callback?code=x&device_id=y&state=z", private_auth=result)
                else:
                    result["private"]["pending"]["expires_at"] = time.time() - 1
                    output = self.complete(provider, result)
                self.assertEqual(output["public"]["state"], "error")
                self.assertEqual(len(transport.calls), 1, "invalid callback must not exchange a token")

    def test_actual_video_permission_required_before_signed_in(self):
        transport = FakeTransport(video_allowed=False)
        provider, begin = self.begin(transport)
        result = self.complete(provider, begin)
        self.assertEqual(result["public"]["code"], "video_permission_required")
        self.assertFalse(result["private"]["account"]["video_access"])
        self.assertNotIn("private-access", json.dumps(result["public"]))

    def test_success_and_refresh_return_no_public_tokens(self):
        transport = FakeTransport()
        provider, begin = self.begin(transport)
        result = self.complete(provider, begin)
        self.assertEqual(result["public"]["state"], "signed_in")
        self.assertEqual(result["public"]["name"], "Test Person")
        self.assertEqual(result["private"]["account"]["access_token"], "private-access")
        self.assertNotIn("private-access", json.dumps(result["public"]))
        result["private"]["account"]["expires_at"] = time.time() - 1
        refreshed = provider.auth_poll(result)
        self.assertEqual(refreshed["public"]["state"], "signed_in")
        refresh_query = urllib.parse.parse_qs(urllib.parse.urlsplit(transport.calls[-3][1]).query)
        self.assertEqual(refresh_query["grant_type"], ["refresh_token"])
        self.assertEqual(transport.calls[-3][2], {"refresh_token": "private-refresh"})
        signed_out = provider.sign_out(refreshed)
        self.assertEqual(signed_out, {"public": {"state": "signed_out"}, "private": {}})
        self.assertTrue(urllib.parse.urlsplit(transport.calls[-1][1]).path.endswith("/oauth2/logout"))

    def test_token_exchange_response_state_is_checked(self):
        provider, begin = self.begin(FakeTransport(bad_token_state=True))
        result = self.complete(provider, begin)
        self.assertEqual(result["public"]["state"], "error")
        self.assertNotIn("account", result["private"])

    def test_broker_callback_is_polled_once_and_then_exchanged_by_the_mgu(self):
        transport = FakeTransport()
        provider, begin = self.begin(transport)
        pending = provider.auth_poll(begin)
        calls = len(transport.calls)
        self.assertEqual(provider.auth_poll(pending)["public"]["state"], "code")
        self.assertEqual(len(transport.calls), calls, "respect broker poll interval locally")
        pending["private"]["pending"]["next_poll_at"] = 0
        transport.callback_ready = True
        result = provider.auth_poll(pending)
        self.assertEqual(result["public"]["state"], "signed_in")
        token_call = next(call for call in transport.calls if urllib.parse.urlsplit(call[1]).path == "/oauth2/auth")
        self.assertEqual(token_call[2], {"code": "returned-code"})
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(token_call[1]).query)
        self.assertEqual(query["grant_type"], ["authorization_code"])
        self.assertEqual(query["code_verifier"], [begin["private"]["pending"]["code_verifier"]])
        self.assertEqual(query["device_id"], ["returned-device"])
        broker_calls = [call for call in transport.calls if urllib.parse.urlsplit(call[1]).hostname == "vk.example"]
        self.assertTrue(all("code_verifier" not in call[2] for call in broker_calls))
        self.assertTrue(all(call[3]["Authorization"] == "Bearer " + self.CONFIG["broker_key"] for call in broker_calls))

    def test_broker_cannot_substitute_a_different_short_link_origin(self):
        transport = FakeTransport()
        transport.broker_url = "https://attacker.example/s/" + "s" * 22
        provider = vk.Provider(transport, config=self.CONFIG)
        result = provider.auth_begin()
        self.assertEqual(result["public"]["state"], "error")
        self.assertNotIn("attacker", json.dumps(result["public"]))

    def test_sign_out_cancels_the_pending_mailbox_and_clears_private_state(self):
        transport = FakeTransport()
        provider, begin = self.begin(transport)
        result = provider.sign_out(begin)
        self.assertEqual(result, {"public": {"state": "signed_out"}, "private": {}})
        self.assertEqual(transport.calls[-1][0], "DELETE")
        self.assertEqual(transport.calls[-1][2], {"poll_token": "p" * 43})

    def test_refresh_network_failure_keeps_refresh_token_without_claiming_signed_in(self):
        transport = FakeTransport()
        provider, begun = self.begin(transport)
        account = self.complete(provider, begun)
        account["private"]["account"]["expires_at"] = time.time() - 1
        with mock.patch.object(transport, "request_json", side_effect=vk.ProviderError("network_error", "Offline")):
            result = provider.auth_poll(account)
        self.assertEqual(result["public"]["state"], "error")
        self.assertEqual(result["public"]["code"], "temporarily_unavailable")
        self.assertEqual(result["private"]["account"]["refresh_token"], "private-refresh")
        self.assertTrue(result["private"]["account"]["verification_pending"])
        self.assertEqual(provider.auth_poll(result)["public"]["state"], "signed_in")

    def test_rotated_refresh_token_survives_profile_failure_and_is_reverified(self):
        transport = FakeTransport()
        provider, begun = self.begin(transport)
        account = self.complete(provider, begun)
        account["private"]["account"]["expires_at"] = time.time() - 1
        original = transport.request_json

        def failing_profile(method, url, fields=None, headers=None):
            path = urllib.parse.urlsplit(url).path
            if path == "/oauth2/user_info":
                raise vk.ProviderError("network_error", "Offline")
            result = original(method, url, fields, headers)
            if path == "/oauth2/auth":
                return dict(result, access_token="rotated-access", refresh_token="rotated-refresh")
            return result

        with mock.patch.object(transport, "request_json", side_effect=failing_profile):
            result = provider.auth_poll(account)
        self.assertEqual(result["public"]["state"], "error")
        self.assertEqual(result["private"]["account"]["refresh_token"], "rotated-refresh")
        self.assertEqual(result["private"]["account"]["access_token"], "rotated-access")
        self.assertTrue(result["private"]["account"]["verification_pending"])
        auth_calls = sum(urllib.parse.urlsplit(call[1]).path == "/oauth2/auth" for call in transport.calls)
        recovered = provider.auth_poll(result)
        self.assertEqual(recovered["public"]["state"], "signed_in")
        self.assertFalse(recovered["private"]["account"]["verification_pending"])
        self.assertEqual(sum(urllib.parse.urlsplit(call[1]).path == "/oauth2/auth" for call in transport.calls), auth_calls,
                         "verify the rotated token before trying another refresh")

    def test_initial_profile_failure_keeps_issued_tokens_but_requires_verification(self):
        transport = FakeTransport()
        provider, begun = self.begin(transport)
        original = transport.request_json

        def failing_profile(method, url, fields=None, headers=None):
            if urllib.parse.urlsplit(url).path == "/oauth2/user_info":
                raise vk.ProviderError("network_error", "Offline")
            return original(method, url, fields, headers)

        with mock.patch.object(transport, "request_json", side_effect=failing_profile):
            result = self.complete(provider, begun)
        self.assertEqual(result["public"]["state"], "error")
        self.assertEqual(result["private"]["account"]["refresh_token"], "private-refresh")
        self.assertEqual(provider.auth_poll(result)["public"]["state"], "signed_in")

    def test_definitive_invalid_grant_clears_the_account(self):
        transport = FakeTransport()
        provider, begun = self.begin(transport)
        account = self.complete(provider, begun)
        account["private"]["account"]["expires_at"] = time.time() - 1
        with mock.patch.object(transport, "request_json", return_value={"error": "invalid_grant"}):
            result = provider.auth_poll(account)
        self.assertEqual(result["public"]["code"], "authorization_expired")
        self.assertEqual(result["private"], {})

    def test_video_api_internal_error_is_retryable_without_public_tokens(self):
        transport = FakeTransport()
        provider, begun = self.begin(transport)
        original = transport.request_json

        def failing_video(method, url, fields=None, headers=None):
            if urllib.parse.urlsplit(url).path == "/method/video.get":
                return {"error": {"error_code": 10}}
            return original(method, url, fields, headers)

        with mock.patch.object(transport, "request_json", side_effect=failing_video):
            result = self.complete(provider, begun)
        self.assertEqual(result["public"]["state"], "error")
        self.assertEqual(result["public"]["code"], "temporarily_unavailable")
        self.assertNotIn("private-refresh", json.dumps(result["public"]))
        self.assertEqual(provider.auth_poll(result)["public"]["state"], "signed_in")


if __name__ == "__main__":
    unittest.main()
