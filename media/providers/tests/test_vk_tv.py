"""Offline native-TV protocol checks. All codes/tokens are invented fixtures."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
import urllib.parse

SPEC = importlib.util.spec_from_file_location("mgu_vk_tv", Path(__file__).resolve().parents[1] / "vk_tv.py")
tv = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tv)

ANON = "fixture-anonymous-private"
HASH = "fixture-auth-hash-private"
TOKEN = "fixture-approved-access-private"
CODE = "AB1234"
URL = "https://qr.vk.ru/ca?q=" + CODE


class FakeTransport:
    def __init__(self, clock):
        self.clock = clock
        self.calls = []
        self.anon = {"token": ANON, "expired_at": clock() + 86400}
        self.code = {"auth_code": CODE, "auth_hash": HASH, "auth_id": "fixture-id", "auth_url": URL,
                     "expires_in": clock() + 120,
                     "qr_code_url": "https://chart.googleapis.com/chart?fixture=unused"}
        self.checked = {"status": 0}
        self.fail = None
        self.api_error = None

    def request_json(self, method, url, fields=None, headers=None):
        self.calls.append((method, url, copy.deepcopy(fields), dict(headers or {})))
        if self.fail:
            raise RuntimeError("private upstream body " + TOKEN + HASH)
        if self.api_error:
            return {"error": {"error_code": self.api_error, "error_msg": "private upstream " + HASH}}
        name = url.rsplit("/", 1)[-1]
        return {"response": copy.deepcopy({"auth.getAnonymToken": self.anon, "auth.getAuthCode": self.code,
                                           "auth.checkAuthCode": self.checked}[name])}


class TvAuthTests(unittest.TestCase):
    def setUp(self):
        self.now = 1800000000.0
        self.clock = lambda: self.now
        self.transport = FakeTransport(self.clock)
        self.verified = []

        def verify(account):
            self.verified.append(copy.deepcopy(account))
            candidate = dict(account, video_access=True, verification_pending=False, cache_id="a" * 32)
            return {"public": {"state": "signed_in", "user_id": account["user_id"], "name": "Fixture user",
                               "access_token": TOKEN}, "private": {"account": candidate}}

        self.verify = verify
        self.provider = tv.TvAuth(self.transport, verify, self.clock)

    def pending(self):
        return self.provider.begin()["private"]

    def approve(self, expiry=0):
        private = self.pending()
        self.now += tv.POLL_INTERVAL
        self.transport.checked = {"status": 2, "access_token": TOKEN, "user_id": 12345, "expires_in": expiry}
        return self.provider.poll(private)

    def test_public_bootstrap_has_no_secret_and_only_minimum_permissions(self):
        answer = self.provider.begin()
        self.assertEqual(answer["public"]["state"], "code")
        self.assertEqual(answer["public"]["code"], CODE)
        self.assertEqual(answer["public"]["url"], URL)
        self.assertEqual(answer["public"]["expires"], 120)
        self.assertEqual(len(self.transport.calls), 2)
        anon, code = self.transport.calls
        self.assertEqual(anon[0], "POST")
        self.assertEqual(anon[1], tv.API + "auth.getAnonymToken")
        self.assertEqual(anon[2]["client_id"], 8114066)
        self.assertEqual(code[2]["scope"], "video,offline")
        self.assertEqual(code[2]["device_name"], "BMW MGU")
        self.assertEqual(code[2]["anonymous_token"], ANON)
        self.assertEqual(code[2]["access_token"], "")
        for call in self.transport.calls:
            self.assertNotIn("client_secret", call[2])
            self.assertNotIn("Cookie", call[3])
            self.assertNotIn("Authorization", call[3])
            self.assertEqual(urllib.parse.urlsplit(call[1]).query, "")
        self.assertFalse(any("googleapis" in call[1] for call in self.transport.calls))
        public = json.dumps(answer["public"])
        self.assertNotIn(ANON, public)
        self.assertNotIn(HASH, public)

    def test_poll_interval_status_created_opened_and_private_copy(self):
        private = self.pending()
        original = copy.deepcopy(private)
        self.assertEqual(self.provider.poll(private)["public"]["state"], "code")
        self.assertEqual(len(self.transport.calls), 2)
        for status in (0, 1):
            self.now += tv.POLL_INTERVAL
            self.transport.checked = {"status": status}
            result = self.provider.poll(private)
            self.assertEqual(result["public"]["state"], "code")
            self.assertEqual(self.transport.calls[-1][1], tv.API + "auth.checkAuthCode")
            self.assertEqual(self.transport.calls[-1][2]["auth_hash"], HASH)
            private = result["private"]
        self.assertEqual(original["pending"]["next_poll_at"], 1800000005)
        self.assertEqual(self.verified, [])

    def test_code_expiry_accepts_epoch_or_ttl_and_never_publishes_epoch(self):
        for expiry in (self.now + 120, 120, self.now + 99999999):
            self.transport.code["expires_in"] = expiry
            result = self.provider.begin()
            self.assertGreater(result["public"]["expires"], 0)
            self.assertLessEqual(result["public"]["expires"], tv.MAX_CODE_TTL)
        for expiry in (self.now - 1, -1, float("nan"), float("inf"), True):
            self.transport.code["expires_in"] = expiry
            self.assertEqual(self.provider.begin()["public"]["state"], "error")

    def test_decline_and_expiry_clear_private_polling_secrets(self):
        for status in (3, 4):
            private = self.pending()
            self.now += tv.POLL_INTERVAL
            self.transport.checked = {"status": status}
            result = self.provider.poll(private)
            self.assertEqual(result["public"]["state"], "error")
            self.assertNotIn("pending", result["private"])
        private = self.pending()
        self.now += 121
        self.assertEqual(self.provider.poll(private)["public"]["code"], "authorization_expired")

    def test_approval_requires_real_verifier_and_keeps_offline_account_private(self):
        answer = self.approve()
        self.assertEqual(answer["public"]["state"], "signed_in")
        candidate = self.verified[-1]
        self.assertEqual(candidate["auth_type"], "vk_tv")
        self.assertNotIn("video_access", candidate, "token issuance alone is not Video API permission")
        self.assertTrue(candidate["verification_pending"])
        self.assertEqual(candidate["expires_at"], 0)
        self.assertEqual(candidate["user_id"], "12345")
        self.assertNotIn(TOKEN, json.dumps(answer["public"]))
        self.assertNotIn("access_token", answer["public"])
        self.assertNotIn("pending", answer["private"])
        self.assertEqual(answer["private"]["account"]["access_token"], TOKEN)

    def test_finite_issued_token_expiry_requires_new_qr_not_invented_refresh(self):
        answer = self.approve(30)
        self.assertEqual(answer["private"]["account"]["expires_at"], self.now + 30)
        self.now += 31
        result = self.provider.status(answer["private"])
        self.assertEqual(result["public"]["code"], "authorization_expired")
        self.assertNotIn("account", result["private"])
        self.assertFalse(any("refresh" in call[1] for call in self.transport.calls))

    def test_missing_expiry_does_not_create_an_unlimited_account(self):
        private = self.pending()
        self.now += tv.POLL_INTERVAL
        self.transport.checked = {"status": 2, "access_token": TOKEN, "user_id": "12345"}
        answer = self.provider.poll(private)
        self.assertEqual(answer["private"]["account"]["expires_at"], self.now + 3600)

    def test_verification_failure_retains_issued_token_for_safe_retry(self):
        def network_failure(_account):
            raise RuntimeError(TOKEN)
        self.provider.verify_account = network_failure
        answer = self.approve()
        self.assertEqual(answer["public"]["state"], "error")
        self.assertTrue(answer["private"]["account"]["verification_pending"])
        self.assertNotIn(TOKEN, json.dumps(answer["public"]))
        self.provider.verify_account = self.verify
        recovered = self.provider.status(answer["private"])
        self.assertEqual(recovered["public"]["state"], "signed_in")

    def test_unverified_or_mismatched_callback_cannot_claim_signed_in(self):
        for verifier in (lambda a: {"public": {"state": "signed_in"}, "private": {"account": a}},
                         lambda a: {"public": {"state": "signed_in"}, "private": {"account": dict(
                             a, video_access=True, verification_pending=False, user_id="999")}}):
            self.provider.verify_account = verifier
            answer = self.approve()
            self.assertEqual(answer["public"]["state"], "error")
            self.assertTrue(answer["private"]["account"]["verification_pending"])

    def test_transient_poll_and_rate_limit_preserve_private_until_deadline(self):
        private = self.pending()
        original = copy.deepcopy(private)
        self.now += tv.POLL_INTERVAL
        self.transport.fail = True
        answer = self.provider.poll(private)
        self.assertEqual(answer["public"]["state"], "error")
        self.assertEqual(answer["private"]["pending"]["auth_hash"], HASH)
        self.assertNotIn(HASH, json.dumps(answer["public"]))
        self.assertEqual(private, original)
        self.transport.fail = None
        self.transport.api_error = 6
        self.now += tv.POLL_INTERVAL
        limited = self.provider.poll(answer["private"])
        self.assertEqual(limited["private"]["pending"]["interval"], 10)
        self.assertEqual(limited["private"]["pending"]["next_poll_at"], self.now + 10)

    def test_only_real_first_party_visible_code_url_is_accepted(self):
        self.assertEqual(tv.activation_url(URL, CODE), URL)
        self.assertIsNone(tv.activation_url("https://qr.vk.ru/ca?q=AB_234", "AB_234"))
        for value in (URL.replace("https:", "http:"), URL.replace("qr.vk.ru", "qr.vk.ru.evil.invalid"),
                      URL.replace("qr.vk.ru", "secret:password@qr.vk.ru"), URL + "&auth_hash=" + HASH,
                      URL + "&q=" + CODE, URL + "#private", URL.replace(CODE, "CD1234"),
                      URL.replace(CODE, "%41B1234"), URL.replace("qr.vk.ru", "qr.vk.ru:443"),
                      "https://qr.vk.ru/other?q=" + CODE, "https://chart.googleapis.com/qr?q=" + CODE,
                      "https://qr.vk.ru:444/ca?q=" + CODE):
            with self.subTest(value=value):
                self.assertIsNone(tv.activation_url(value, CODE))
                self.transport.code["auth_url"] = value
                self.assertEqual(self.provider.begin()["public"]["state"], "error")

    def test_sign_out_and_status_never_create_code_or_remote_fake_revocation(self):
        self.assertEqual(self.provider.status()["public"]["state"], "signed_out")
        self.assertEqual(self.transport.calls, [])
        private = self.pending()
        calls = len(self.transport.calls)
        answer = self.provider.sign_out(private)
        self.assertEqual(answer, {"public": {"state": "signed_out"}, "private": {"provider": "vk"}})
        self.assertEqual(len(self.transport.calls), calls)
        self.assertEqual(self.provider.status(answer["private"])["public"]["state"], "signed_out")


if __name__ == "__main__":
    unittest.main()
