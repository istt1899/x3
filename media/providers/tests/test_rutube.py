"""Deterministic RUTUBE protocol tests. No personal account or network is used."""
import copy
import json
import os
from pathlib import Path
import sys
import unittest
from unittest import mock
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rutube

FIXTURES = Path(__file__).parent / "fixtures" / "rutube"
CLIENT = "fixtureRutubePublicClientId012345678901234"
VIDEO_ID = "03a9cb54bac3376af4c5cb0f18444e01"


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.device_response = (200, fixture("device_code.json"))
        self.poll_response = (400, {"code": "1004003"})
        self.refresh_response = (200, {"access_token": "refreshed-private", "expires_in": 60})
        self.visitor_response = (200, {"id": 12345})
        self.logout_response = (200, {})
        self.feed_response = (200, {"results": [fixture("public_video.json")], "next": None})
        self.options = {"drm_token": None, "video_balancer": {"m3u8": "https://bl.rutube.ru/route/fixture.m3u8?sign=fixture"}}

    def __call__(self, method, url, headers, data, timeout):
        self.calls.append((method, url, headers, data, timeout))
        path = urllib.parse.urlsplit(url).path
        if url == rutube.TV_URL:
            return rutube.Response(200, '<script src="main.fixture.js"></script>')
        if url.endswith("main.fixture.js"):
            return rutube.Response(200, (FIXTURES / "tv_bundle.js").read_bytes())
        if "/device/code/" in path:
            status, body = self.device_response
        elif path.endswith("/device/token"):
            status, body = self.poll_response
        elif path.endswith("/accounts/token"):
            status, body = self.refresh_response
        elif path.endswith("/accounts/visitor/"):
            status, body = self.visitor_response
        elif path == "/api/video/" + VIDEO_ID + "/":
            status, body = 200, fixture("public_video.json")
        elif path.startswith("/api/play/options/"):
            status, body = 200, self.options
        elif path.endswith("/accounts/logout/"):
            status, body = self.logout_response
        else:
            status, body = self.feed_response
        return rutube.Response(status, json.dumps(body))


class RutubeTests(unittest.TestCase):
    def setUp(self):
        self.now = 1800000000.0
        self.transport = FakeTransport()
        self.provider = rutube.Provider(self.transport, lambda: self.now)

    def pending(self):
        return self.provider.auth_begin()["private"]

    def approved(self):
        private = self.pending()
        self.now += 10
        self.transport.poll_response = (200, {"access_token": "access-private", "refresh_token": "refresh-private", "expires_in": 60})
        return self.provider.auth_poll(private)["private"]

    def test_discovery_uses_device_flow_variable_not_fixed_minifier_name(self):
        self.assertEqual(self.provider.discover_client_id(), CLIENT)
        self.provider.discover_client_id()
        self.assertEqual(len(self.transport.calls), 2, "client discovery is cached")
        self.assertIsNone(self.provider._extract_client_id('var other="' + CLIENT + '"; var oauth={client_id:other};'))
        self.assertEqual(self.provider._extract_client_id('post("/device/code/", {"client_id":"' + CLIENT + '"})'), CLIENT)

    def test_device_code_envelope_keeps_secrets_private(self):
        result = self.provider.auth_begin()
        self.assertEqual(result["public"]["state"], "code")
        self.assertEqual(result["public"]["expires"], 1200)
        self.assertIn("user_code=abc123", result["public"]["url"])
        self.assertNotIn("device_code", json.dumps(result["public"]))
        self.assertEqual(result["private"]["pending"]["device_code"], "fixture-device-secret-never-for-ui")
        method, url, headers, body, _ = self.transport.calls[-1]
        self.assertEqual(method, "POST")
        self.assertEqual(url, rutube.CODE_URL)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertTrue(headers["x-device-id"])
        self.assertEqual(json.loads(body), {"client_id": CLIENT, "device_name": "BMW MGU"})

    def test_poll_interval_pending_expiry_and_form_payload(self):
        original = self.pending()
        calls = len(self.transport.calls)
        result = self.provider.auth_poll(original)
        self.assertEqual(len(self.transport.calls), calls, "do not poll earlier than interval")
        self.now += 10
        result = self.provider.auth_poll(result["private"])
        self.assertEqual(result["public"]["state"], "code")
        method, url, headers, body, _ = self.transport.calls[-1]
        self.assertEqual(url, rutube.TOKEN_URL)
        self.assertEqual(headers["Content-Type"], "application/x-www-form-urlencoded")
        self.assertNotIn("Authorization", headers)
        self.assertEqual(urllib.parse.parse_qs(body.decode())["grant_type"], ["device_code"])
        self.assertEqual(original["pending"]["next_poll_at"], 1800000010.0, "caller state is not mutated")
        self.now += 1200
        result = self.provider.auth_poll(result["private"])
        self.assertEqual(result["public"]["state"], "error")
        self.assertNotIn("pending", result["private"])

    def test_approved_tokens_require_successful_profile_verification(self):
        result = self.provider.auth_status(self.approved())
        self.assertEqual(result["public"], {"state": "signed_in"})
        self.assertNotIn("access-private", json.dumps(result["public"]))
        self.assertEqual(result["private"]["tokens"]["profile_id"], "12345")
        self.assertEqual(self.transport.calls[-1][2]["Authorization"], "Bearer access-private")

    def test_token_response_alone_is_not_signed_in(self):
        private = self.pending()
        self.now += 10
        self.transport.poll_response = (200, {"access_token": "private", "refresh_token": "private"})
        self.transport.visitor_response = (401, {})
        result = self.provider.auth_poll(private)
        self.assertEqual(result["public"]["state"], "error")
        self.assertFalse(result["private"]["tokens"]["verified"])

    def test_refresh_uses_first_party_form_endpoint_and_preserves_refresh(self):
        private = self.approved()
        self.now += 61
        result = self.provider.auth_status(private)
        self.assertEqual(result["public"]["state"], "signed_in")
        self.assertEqual(result["private"]["tokens"]["refresh_token"], "refresh-private")
        call = next(c for c in self.transport.calls if c[1] == rutube.REFRESH_URL)
        self.assertEqual(call[2]["Authorization"], "Bearer access-private")
        self.assertEqual(urllib.parse.parse_qs(call[3].decode()), {"client_id": [CLIENT], "refresh_token": ["refresh-private"]})

    def test_personal_feeds_require_auth_and_preserve_http_errors(self):
        for name in ("subs", "wl", "history"):
            with self.assertRaises(rutube.AuthRequired):
                self.provider.feed(name)
        private = self.approved()
        self.transport.feed_response = (403, {"error": "unauthorized"})
        with self.assertRaises(rutube.AuthRequired):
            self.provider.feed("history", private)
        self.transport.feed_response = (200, {"unexpected": []})
        with self.assertRaises(rutube.RutubeError):
            self.provider.feed("wl", private)

    def test_refresh_404_preserves_private_tokens_but_reports_error(self):
        private = self.approved()
        self.transport.refresh_response = (404, {})
        result = self.provider.auth_refresh(private)
        self.assertEqual(result["public"]["state"], "error")
        self.assertEqual(result["private"]["tokens"]["refresh_token"], "refresh-private")

    def test_video_normalization_deduplicates_and_rejects_nonvideo(self):
        video = fixture("public_video.json")
        self.transport.feed_response = (200, {"results": [video, {"object": video}, {"id": "playlist123", "title": "playlist"}], "next": None})
        page = self.provider.search("space & science")
        self.assertEqual(len(page["items"]), 1)
        item = page["items"][0]
        self.assertEqual((item["id"], item["duration_s"]), (VIDEO_ID, 293))
        self.assertEqual(item["url"], "https://rutube.ru/video/" + VIDEO_ID + "/")
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.transport.calls[-1][1]).query)
        self.assertEqual(query["query"], ["space & science"])

    def test_first_party_thumbnail_resize_preserves_signed_and_other_urls(self):
        original = fixture("public_video.json")
        original["thumbnail_url"] = "https://pic.rtbcdn.ru/video/fixture.jpg"
        self.assertEqual(rutube.normalize_video(original)["thumbnail"],
                         "https://pic.rtbcdn.ru/video/fixture.jpg?size=l")
        for url in ("https://pic.rtbcdn.ru/video/fixture.jpg?signature=fixture",
                    "https://pic.rtbcdn.ru/video/fixture.jpg?size=s",
                    "https://pic.rtbcdn.ru/video/fixture.jpg#fixture",
                    "https://pic.rutubelist.ru/video/fixture.jpg",
                    "https://rutube.ru/static/fixture.jpg"):
            with self.subTest(url=url):
                original["thumbnail_url"] = url
                self.assertEqual(rutube.normalize_video(original)["thumbnail"], url)
        for url in ("http://pic.rtbcdn.ru/video/fixture.jpg",
                    "https://pic.rtbcdn.ru:444/video/fixture.jpg",
                    "https://pic.rtbcdn.ru.evil.invalid/video/fixture.jpg",
                    "https://private:secret@pic.rtbcdn.ru/video/fixture.jpg"):
            with self.subTest(url=url):
                original["thumbnail_url"] = url
                self.assertIsNone(rutube.normalize_video(original)["thumbnail"])

    def test_resolve_validates_id_and_returns_backend_playback(self):
        for value in ("https://evil.invalid/x", "../etc/passwd", "03a9cb54"):
            with self.assertRaises(rutube.RutubeError):
                self.provider.resolve(value)
        result = self.provider.resolve(VIDEO_ID)
        self.assertEqual(result["duration_s"], 293)
        self.assertEqual(result["playback"]["protocol"], "hls")
        self.transport.options["drm_token"] = "fixture-drm"
        with self.assertRaises(rutube.RutubeError) as error:
            self.provider.resolve(VIDEO_ID)
        self.assertEqual(error.exception.code, "drm_unsupported")

    def test_external_verification_or_media_urls_are_not_trusted(self):
        self.transport.device_response[1]["verification_uri"] = "https://evil.invalid/activate/"
        result = self.provider.auth_begin()
        self.assertEqual(result["public"]["state"], "error")
        self.transport.options = {"video_balancer": {"m3u8": "https://127.0.0.1/private.m3u8"}}
        with self.assertRaises(rutube.RutubeError):
            self.provider.resolve(VIDEO_ID)

    def test_bearer_is_never_sent_to_bundle_or_external_host(self):
        private = {"tokens": {"access_token": "private"}}
        for url in ("https://static.rtbcdn.ru/a.js", "https://rutube.ru/tv-release/webos.server/webos/main.js"):
            with self.assertRaises(rutube.RutubeError):
                self.provider._request("GET", url, auth=private)
        self.assertEqual(self.transport.calls, [])

    def test_sign_out_discards_tokens_even_if_remote_logout_fails(self):
        private = self.approved()
        self.transport.logout_response = (503, {})
        result = self.provider.sign_out(private)
        self.assertEqual(result, {"public": {"state": "signed_out"}, "private": {"provider": "rutube"}})
        logout = self.transport.calls[-1]
        self.assertEqual(logout[1], rutube.LOGOUT_URL)
        self.assertEqual(json.loads(logout[3]), {"refresh_token": "refresh-private"})

    def test_flat_private_token_record_is_normalized_without_mutating_caller(self):
        original = {"access_token": "private", "refresh_token": "private", "client_id": CLIENT}
        result = self.provider.auth_status(original)
        self.assertEqual(result["public"]["state"], "signed_in")
        self.assertTrue(result["private"]["tokens"]["verified"])
        self.assertNotIn("tokens", original)

    def test_unexpected_network_error_does_not_leak_codes(self):
        private = self.pending()
        self.now += 10
        self.provider.transport = mock.Mock(side_effect=rutube.RutubeError("RUTUBE недоступен.", "network_error"))
        result = self.provider.auth_poll(private)
        self.assertEqual(result["public"]["state"], "error")
        self.assertNotIn("fixture-device-secret", json.dumps(result["public"]))
        self.assertIn("pending", result["private"], "a network failure does not destroy the pending login")


if __name__ == "__main__":
    unittest.main()
