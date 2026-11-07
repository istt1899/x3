"""Consumer VK Video TV authorization, without a developer app or callback server.

Observed first-party protocol: official com.vk.tv APK https://vk.ru/atv and
the public VK ID web bootstrap. No native application secret, cookie, password,
attestation or personal account is shipped. The injected transport must be direct.

Only an explicit caller-provided users.get/video.get verifier may declare an
approved token signed_in. All credentials and device polling state stay private.
"""
from __future__ import annotations

import copy
import math
import re
import time
import urllib.parse
import uuid


API = "https://api.vk.ru/method/"
API_VERSION = "5.267"
PUBLIC_CLIENT_ID = 8114066
AUTH_TYPE = "vk_tv"
POLL_INTERVAL = 5
MAX_CODE_TTL = 1200
CODE = re.compile(r"^[A-Za-z0-9]{6}$")
USER_ID = re.compile(r"^[1-9]\d{0,19}$")
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


class TvAuthError(Exception):
    def __init__(self, code="temporarily_unavailable"):
        self.code = code
        super().__init__(code)  # never copy a remote body, URL or transport error


def _private(auth):
    if not isinstance(auth, dict):
        return {}
    value = auth.get("private", auth)
    return copy.deepcopy(value) if isinstance(value, dict) else {}


def _secret(value):
    return isinstance(value, str) and 0 < len(value) <= 16384 and not any(c in value for c in "\r\n\0")


def _number(value):
    if isinstance(value, bool):
        raise ValueError("invalid number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("invalid number")
    return result


def activation_url(value, code):
    """Only the observed short first-party URL carrying the visible code is public."""
    if not isinstance(value, str) or not isinstance(code, str) or not CODE.fullmatch(code):
        return None
    if value != "https://qr.vk.ru/ca?q=" + code:
        return None
    if len(value.encode("utf-8")) > 62:
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
        query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=2)
        if (parsed.scheme != "https" or parsed.hostname != "qr.vk.ru" or parsed.port not in (None, 443)
                or parsed.username or parsed.password or parsed.path != "/ca" or parsed.fragment
                or query != [("q", code)]):
            return None
        return value
    except ValueError:
        return None


def _error(code, message, private):
    return {"public": {"state": "error", "code": code, "msg": message}, "private": private}


class TvAuth:
    """TvAuth(transport, verify_account, clock=time.time).

    transport.request_json(method, url, fields=None, headers=None) returns a dict.
    verify_account(candidate) must check the issued user ID and actual Video API
    access, returning {public,private}. It must retain verification_pending tokens
    on transient failures. The callback does not receive anonymous polling secrets.
    """
    def __init__(self, transport, verify_account, clock=time.time):
        if not callable(getattr(transport, "request_json", None)) or not callable(verify_account):
            raise TypeError("TV authorization requires a direct transport and account verifier")
        self.transport, self.verify_account, self.clock = transport, verify_account, clock

    def _base(self, private):
        device = private.get("device_id")
        try:
            device = str(uuid.UUID(str(device)))
        except (ValueError, AttributeError):
            device = str(uuid.uuid4())
        return {"provider": "vk", "auth_type": AUTH_TYPE, "device_id": device}

    def _api(self, method, fields):
        # Fixed first-party origin. No configuration/UI URL, proxy, cookies,
        # Authorization header, native secret or credential-bearing query.
        try:
            response = self.transport.request_json("POST", API + method,
                fields=dict(fields, v=API_VERSION), headers={"User-Agent": USER_AGENT,
                    "Origin": "https://vkvideo.ru", "Referer": "https://vkvideo.ru/"})
        except Exception:
            raise TvAuthError() from None
        if not isinstance(response, dict):
            raise TvAuthError("invalid_response")
        error = response.get("error")
        if error:
            code = error.get("error_code") if isinstance(error, dict) else None
            raise TvAuthError("session_expired" if code == 5 else "rate_limit" if code in (6, 9, 29)
                              else "temporarily_unavailable" if code in (1, 10) else "invalid_response")
        result = response.get("response")
        if not isinstance(result, dict):
            raise TvAuthError("invalid_response")
        return result

    def _deadline(self, value, default=120, maximum=MAX_CODE_TTL):
        # The real getAuthCode field is named expires_in but contains Unix seconds.
        # Accept a bounded TTL too; never expose the absolute timestamp as UI TTL.
        duration = default if value is None else _number(value)
        if duration >= 1_000_000_000:
            duration -= self.clock()
        if duration <= 0:
            raise ValueError("expired deadline")
        return self.clock() + min(maximum, duration)

    def _code_state(self, pending):
        return {"state": "code", "code": pending["auth_code"], "url": pending["auth_url"],
                "expires": max(0, int(pending["expires_at"] - self.clock())),
                "msg": "Подтвердите вход в приложении VK на телефоне."}

    def _valid_pending(self, pending):
        return (isinstance(pending, dict) and pending.get("auth_type") == AUTH_TYPE
                and str(pending.get("client_id")) == str(PUBLIC_CLIENT_ID)
                and _secret(pending.get("anonymous_token")) and _secret(pending.get("auth_hash"))
                and activation_url(pending.get("auth_url"), pending.get("auth_code")))

    def _verify(self, account, base):
        candidate = dict(account, auth_type=AUTH_TYPE, verification_pending=True)
        retained = dict(base, account=candidate)
        try:
            answer = self.verify_account(copy.deepcopy(candidate))
        except Exception:
            return _error("temporarily_unavailable", "VK временно недоступен. Повторите проверку подключения.", retained)
        if not isinstance(answer, dict) or not isinstance(answer.get("public"), dict) or not isinstance(answer.get("private"), dict):
            return _error("temporarily_unavailable", "VK не подтвердил подключение. Повторите проверку.", retained)
        private = dict(base, **copy.deepcopy(answer["private"]))
        # Even a verifier callback cannot add token/cookie/private members to UI.
        source_public = answer["public"]
        public = {key: copy.deepcopy(source_public[key]) for key in ("state", "code", "msg", "name", "user_id")
                  if key in source_public}
        if public.get("state") not in ("signed_in", "error", "signed_out"):
            return _error("temporarily_unavailable", "VK не подтвердил подключение. Повторите проверку.", retained)
        verified = private.get("account")
        if public.get("state") == "signed_in":
            if (not isinstance(verified, dict) or verified.get("video_access") is not True
                    or verified.get("verification_pending")
                    or verified.get("access_token") != candidate.get("access_token")
                    or str(verified.get("user_id")) != str(candidate.get("user_id"))):
                return _error("authorization_failed", "VK не подтвердил доступ к видео. Повторите вход.", retained)
            verified["auth_type"] = AUTH_TYPE
        return {"public": public, "private": private}

    def begin(self, private_auth=None):
        private = _private(private_auth)
        base = self._base(private)
        account = private.get("account")
        if isinstance(account, dict) and account.get("auth_type") == AUTH_TYPE:
            try:
                expiry = _number(account.get("expires_at", -1))
                if expiry == 0 or expiry > self.clock():
                    return self._verify(account, base)
            except (ValueError, TypeError):
                pass
        pending = private.get("pending")
        if self._valid_pending(pending):
            try:
                if _number(pending["expires_at"]) > self.clock():
                    return {"public": self._code_state(pending), "private": dict(base, pending=pending)}
            except (ValueError, TypeError, KeyError):
                pass
        try:
            anonymous = self._api("auth.getAnonymToken", {"client_id": PUBLIC_CLIENT_ID,
                "device_id": base["device_id"]})
            if not _secret(anonymous.get("token")):
                raise TvAuthError("invalid_response")
            anon_expiry = self._deadline(anonymous.get("expired_at"), default=3600, maximum=7 * 86400)
            result = self._api("auth.getAuthCode", {"client_id": PUBLIC_CLIENT_ID,
                "device_id": base["device_id"], "anonymous_token": anonymous["token"], "access_token": "",
                "device_name": "BMW MGU", "scope": "video,offline", "need_qr_code": 1, "force_regenerate": 1})
            code = result.get("auth_code")
            url = activation_url(result.get("auth_url"), code)
            if not url or not _secret(result.get("auth_hash")):
                raise TvAuthError("invalid_response")
            pending = {"auth_type": AUTH_TYPE, "client_id": PUBLIC_CLIENT_ID,
                "anonymous_token": anonymous["token"], "anon_expires_at": anon_expiry,
                "auth_hash": result["auth_hash"], "auth_id": str(result.get("auth_id") or "")[:200],
                "auth_code": code, "auth_url": url, "expires_at": self._deadline(result.get("expires_in")),
                "interval": POLL_INTERVAL, "poll_interval": POLL_INTERVAL,
                "next_poll_at": self.clock() + POLL_INTERVAL}
            # qr_code_url may point to Google Chart. It is intentionally ignored:
            # the MGU draws its own QR from the validated first-party auth_url.
            return {"public": self._code_state(pending), "private": dict(base, pending=pending)}
        except (TvAuthError, ValueError, TypeError, KeyError):
            return _error("tv_auth_unavailable", "Не удалось получить код VK Видео. Проверьте интернет и повторите вход.", base)

    def poll(self, private_auth=None):
        private = _private(private_auth)
        base = self._base(private)
        account = private.get("account")
        if isinstance(account, dict) and account.get("auth_type") == AUTH_TYPE:
            try:
                expiry = _number(account.get("expires_at", -1))
                if not _secret(account.get("access_token")) or not USER_ID.fullmatch(str(account.get("user_id", ""))):
                    raise ValueError("invalid account")
                if expiry != 0 and expiry <= self.clock():
                    return _error("authorization_expired", "Срок входа VK истёк. Получите новый QR-код.", base)
            except (ValueError, TypeError):
                return _error("authorization_expired", "Повторите вход VK Видео.", base)
            # Finite native-TV tokens have no established refresh-token protocol.
            # Offline lifetime 0 is accepted only after the real verifier succeeds.
            return self._verify(account, base)
        pending = private.get("pending")
        if not pending:
            return {"public": {"state": "signed_out"}, "private": base}
        if not self._valid_pending(pending):
            return _error("authorization_failed", "Повторите вход VK Видео.", base)
        try:
            now = self.clock()
            expires = _number(pending["expires_at"])
            if expires <= now or expires - now > MAX_CODE_TTL or _number(pending["anon_expires_at"]) <= now:
                return _error("authorization_expired", "Срок QR-кода VK истёк. Получите новый код.", base)
            if _number(pending.get("next_poll_at", 0)) > now:
                return {"public": self._code_state(pending), "private": dict(base, pending=pending)}
            pending["next_poll_at"] = now + max(POLL_INTERVAL, min(60, int(pending.get("interval") or POLL_INTERVAL)))
            result = self._api("auth.checkAuthCode", {"client_id": PUBLIC_CLIENT_ID,
                "device_id": base["device_id"], "anonymous_token": pending["anonymous_token"],
                "access_token": "", "auth_hash": pending["auth_hash"]})
            status = result.get("status")
            if isinstance(status, bool) or not isinstance(status, int):
                raise TvAuthError("invalid_response")
            if status in (0, 1):  # CREATED, OPENED: opening the phone URL is not approval.
                return {"public": self._code_state(pending), "private": dict(base, pending=pending)}
            if status in (3, 4):
                return _error("authorization_declined" if status == 3 else "authorization_expired",
                              "Вход VK не подтверждён. Получите новый QR-код.", base)
            if status != 2 or not _secret(result.get("access_token")) or not USER_ID.fullmatch(str(result.get("user_id", ""))):
                raise TvAuthError("invalid_response")
            # Only an explicit 0 means offline/non-expiring. An omitted value
            # gets a conservative finite lease and a new QR after that lease.
            token_lifetime = _number(result.get("expires_in", 3600))
            if token_lifetime < 0:
                raise TvAuthError("invalid_response")
            token_expiry = 0 if token_lifetime == 0 else self._deadline(token_lifetime, maximum=366 * 86400)
            candidate = {"auth_type": AUTH_TYPE, "client_id": str(PUBLIC_CLIENT_ID),
                "device_id": base["device_id"], "access_token": result["access_token"],
                "user_id": str(result["user_id"]), "expires_at": token_expiry,
                "verification_pending": True}
            return self._verify(candidate, base)
        except TvAuthError as error:
            if error.code == "session_expired":
                return _error("authorization_expired", "Срок QR-кода VK истёк. Получите новый код.", base)
            if error.code == "rate_limit":
                pending["interval"] = min(60, int(pending.get("interval") or POLL_INTERVAL) + 5)
                pending["next_poll_at"] = self.clock() + pending["interval"]
            return _error("temporarily_unavailable", "VK временно недоступен. Ожидаем подтверждение входа.", dict(base, pending=pending))
        except (ValueError, TypeError, KeyError):
            return _error("authorization_failed", "Повторите вход VK Видео.", base)

    def status(self, private_auth=None):
        return self.poll(private_auth)

    def sign_out(self, private_auth=None):
        # The investigated native flow establishes no remote token-revocation
        # method. Do not invent one or call the relay's OAuth logout with a TV token.
        # Root's bridge cancels poll generations and atomically clears local state.
        return {"public": {"state": "signed_out"}, "private": {"provider": "vk"}}


VKTVAuth = TvAuth
