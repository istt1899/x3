"""Direct-network RUTUBE adapter for BMW MGU.

Public catalog, first-party TV device authorization and playback metadata only.
No personal credentials or static client secret are shipped. OAuth tokens and
pending device codes belong in the caller's private 0600 state file; only the
``public`` member of auth envelopes may cross the app socket.

Protocol evidence: media/providers/tests/fixtures/rutube/provenance.json and
media/providers/RUTUBE-RESEARCH-RU.md. This module does not bypass DRM or paywalls.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
import html
import json
import os
from pathlib import Path
import re
import ssl
import time
from typing import Any, Callable
import urllib.error
import urllib.parse
import urllib.request
import uuid


PROVIDER_ID = "rutube"
ORIGIN = "https://rutube.ru"
TV_URL = ORIGIN + "/tv-release/webos.server/webos/"
CODE_URL = ORIGIN + "/multipass/api/v3/oauth2/device/code/?client=tv"
TOKEN_URL = ORIGIN + "/multipass/api/v3/oauth2/device/token?client=tv"
REFRESH_URL = ORIGIN + "/multipass/api/v3/accounts/token?client=tv"
VISITOR_URL = ORIGIN + "/api/accounts/visitor/?client=tv"
LOGOUT_URL = ORIGIN + "/multipass/api/accounts/logout/?client=tv"
UA = ("Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/87.0.4280.144 Safari/537.36 WebAppManager")
VIDEO_ID = re.compile(r"^[0-9a-f]{32}$")
CLIENT_LITERAL = re.compile(r"^[A-Za-z0-9_-]{20,120}$")
MAX_BODY = 8 * 1024 * 1024
CA = Path("/var/opt/mgu-python/current/ssl/cacert.pem")
PERSONAL_PATHS = {
    "subs": "/api/subscription/video/",
    "subscriptions": "/api/subscription/video/",
    "wl": "/api/playlist/future/",
    "watch_later": "/api/playlist/future/",
    "history": "/api/video/history/",
    "liked": "/api/v2/reactions/videos/liked/",
}


class RutubeError(RuntimeError):
    """Safe error without request bodies, signed media URLs or credentials."""

    def __init__(self, message: str, code: str = "rutube_error", status: int | None = None):
        super().__init__(message)
        self.code, self.status = code, status


class AuthRequired(RutubeError):
    def __init__(self, message: str = "Войдите в аккаунт RUTUBE для этого раздела.", status: int | None = None):
        super().__init__(message, "auth_required", status)


@dataclass
class Response:
    status: int
    body: bytes | str
    headers: dict[str, str] = field(default_factory=dict)


class _SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    """Do not forward bearer credentials to a redirected external origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if (old.scheme, old.hostname, old.port) != (new.scheme, new.hostname, new.port):
            raise RutubeError("RUTUBE вернул перенаправление на другой сервер.", "unexpected_redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class DirectTransport:
    """HTTPS urllib transport that explicitly ignores all system proxy settings."""

    def __init__(self, ca_bundle: str | os.PathLike | None = None):
        # A supplied shared Mozilla CA bundle is verified normally. Never disable TLS.
        cafile = str(ca_bundle) if ca_bundle is not None else str(CA) if CA.is_file() else None
        context = ssl.create_default_context(cafile=cafile)
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=context),
            _SameOriginRedirect(),
        )

    def __call__(self, method: str, url: str, headers: dict, data: bytes | None, timeout: float) -> Response:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname not in {"rutube.ru", "static.rtbcdn.ru"}:
            raise RutubeError("Недопустимый сервер API RUTUBE.", "invalid_origin")
        if parsed.username or parsed.password or parsed.port not in (None, 443):
            raise RutubeError("Недопустимый адрес API RUTUBE.", "invalid_origin")
        if any(k.lower() == "authorization" for k in headers) and parsed.hostname != "rutube.ru":
            raise RutubeError("Токен RUTUBE нельзя отправить на внешний сервер.", "invalid_origin")
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=timeout) as result:
                body = result.read(MAX_BODY + 1)
                if len(body) > MAX_BODY:
                    raise RutubeError("Ответ RUTUBE превышает допустимый размер.", "answer_too_large")
                return Response(result.status, body, dict(result.headers))
        except urllib.error.HTTPError as error:
            return Response(error.code, error.read(MAX_BODY + 1), dict(error.headers))
        except (OSError, urllib.error.URLError):
            raise RutubeError("Сервер RUTUBE не ответил. Проверьте прямое подключение к интернету.", "network_error") from None


def _text(body: bytes | str) -> str:
    return body.decode("utf-8", errors="replace") if isinstance(body, bytes) else body


def _safe_https(value: Any, suffixes: tuple[str, ...]) -> str | None:
    if not isinstance(value, str) or len(value) > 16000:
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None
        if any(host == name or host.endswith("." + name) for name in suffixes):
            return value
    except ValueError:
        pass
    return None


def _thumbnail_url(value: Any) -> str | None:
    url = _safe_https(value, ("rtbcdn.ru", "rutubelist.ru", "rutube.ru"))
    if not url:
        return None
    parsed = urllib.parse.urlsplit(url)
    # The current first-party TV bundle appends ?size=l (videoImgSize="l").
    # Real originals can exceed the decoder's 4MP/64MiB safety limits; this
    # CDN response is about 640px wide. Do not alter signed/query URLs or
    # assume that another thumbnail host implements the same protocol.
    if parsed.hostname == "pic.rtbcdn.ru" and not parsed.query and not parsed.fragment:
        return urllib.parse.urlunsplit(parsed._replace(query="size=l"))
    return url


def normalize_video(value: Any) -> dict | None:
    """Normalize API video records; playlists/cards are not playable video IDs."""
    if not isinstance(value, dict):
        return None
    if isinstance(value.get("object"), dict):
        value = value["object"]
    if isinstance(value.get("video"), dict):
        value = value["video"]
    video_id = str(value.get("id") or "").lower()
    if not VIDEO_ID.fullmatch(video_id):
        return None
    title = str(value.get("title") or "").strip()
    if not title:
        return None
    author = value.get("author") if isinstance(value.get("author"), dict) else {}
    try:
        duration = max(0, int(float(value.get("duration") or 0)))
    except (ValueError, TypeError, OverflowError):
        duration = 0
    return {
        "id": video_id,
        "title": title[:1000],
        "channel": str(author.get("name") or value.get("channel") or "")[:500],
        "duration_s": duration,
        "thumbnail": _thumbnail_url(value.get("thumbnail_url")),
        "url": ORIGIN + "/video/" + video_id + "/",
        "is_live": bool(value.get("is_livestream") or value.get("is_on_air")),
    }


def _tokens(auth: dict | None) -> dict:
    if not isinstance(auth, dict):
        return {}
    if isinstance(auth.get("tokens"), dict):
        return auth["tokens"]
    # Allows a caller to pass its private token record without its outer envelope.
    return auth if "access_token" in auth else {}


def _private_copy(auth: dict | None) -> dict:
    private = copy.deepcopy(auth) if isinstance(auth, dict) else {}
    if "access_token" in private and "tokens" not in private:
        token_keys = ("access_token", "refresh_token", "expires_at", "verified", "profile_id")
        private["tokens"] = {key: private.pop(key) for key in token_keys if key in private}
    return private


class RutubeProvider:
    id = PROVIDER_ID

    def __init__(self, transport: Callable | None = None, clock: Callable[[], float] | None = None):
        self.transport = transport or DirectTransport()
        self.clock = clock or time.time
        self._client_id = None
        self._client_until = 0.0

    def _request(self, method: str, url: str, *, auth=None, data=None, form=False) -> Response:
        headers = {"User-Agent": UA, "Accept": "application/json", "Referer": TV_URL}
        if isinstance(auth, dict) and auth.get("device_id"):
            headers["x-device-id"] = str(auth["device_id"])
        token = _tokens(auth).get("access_token")
        # Bearer credentials are sent only to the RUTUBE API, never to bundle/CDN downloads.
        parsed = urllib.parse.urlsplit(url)
        if token:
            if parsed.scheme != "https" or parsed.hostname != "rutube.ru" or not parsed.path.startswith(("/api/", "/multipass/")):
                raise RutubeError("Токен RUTUBE нельзя отправить на внешний сервер.", "invalid_origin")
            headers["Authorization"] = "Bearer " + str(token)
        body = None
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
            body = (urllib.parse.urlencode(data) if form else json.dumps(data, ensure_ascii=False)).encode("utf-8")
        result = self.transport(method, url, headers, body, 15)
        if not isinstance(result, Response):
            if isinstance(result, dict) and "status" in result and "body" in result:
                result = Response(result["status"], result["body"], result.get("headers", {}))
            else:
                raise TypeError("transport must return rutube.Response")
        if len(result.body) > MAX_BODY:
            raise RutubeError("Ответ RUTUBE превышает допустимый размер.", "answer_too_large")
        return result

    def _json(self, method: str, url: str, *, auth=None, data=None, form=False, errors=False):
        result = self._request(method, url, auth=auth, data=data, form=form)
        try:
            obj = json.loads(_text(result.body)) if result.body else {}
        except (ValueError, TypeError):
            if 200 <= result.status < 300:
                raise RutubeError("RUTUBE вернул ответ неизвестного формата.", "invalid_response", result.status) from None
            obj = {}
        if not errors and not 200 <= result.status < 300:
            if result.status in (401, 403):
                raise AuthRequired(status=result.status)
            raise RutubeError("Запрос RUTUBE завершился ошибкой HTTP " + str(result.status) + ".", "api_error", result.status)
        return result.status, obj

    @staticmethod
    def _page(obj: Any) -> dict:
        records = obj.get("results") if isinstance(obj, dict) else obj
        if not isinstance(records, list):
            raise RutubeError("Неизвестный формат списка видео RUTUBE.", "invalid_response")
        items, seen = [], set()
        for record in records:
            card = normalize_video(record)
            if card and card["id"] not in seen:
                items.append(card)
                seen.add(card["id"])
        nxt = obj.get("next") if isinstance(obj, dict) else None
        # Continuations are data only. A caller must not feed arbitrary next URLs back into requests.
        return {"items": items, "next": _safe_https(nxt, ("rutube.ru",)) if nxt else None}

    def search(self, q: str, auth: dict | None = None, page: int = 1) -> dict:
        if not isinstance(q, str) or not q.strip():
            raise RutubeError("Введите запрос для поиска.", "empty_query")
        query = urllib.parse.urlencode({"query": q.strip()[:300], "page": max(1, int(page)), "limit": 40, "client": "tv"})
        _, obj = self._json("GET", ORIGIN + "/api/search/combined/video_playlist?" + query, auth=auth)
        return self._page(obj)

    def home(self, auth: dict | None = None, page: int = 1) -> dict:
        query = urllib.parse.urlencode({"limit": 40, "page": max(1, int(page)), "show_hidden_videos": "False",
                                      "show_user_hidden_videos": "False", "client": "tv"})
        _, obj = self._json("GET", ORIGIN + "/api/v2/video/recommendation/main?" + query, auth=auth)
        return self._page(obj)

    def feed(self, which: str = "home", auth: dict | None = None, page: int = 1) -> dict:
        if which in ("home", "main"):
            return self.home(auth, page)
        if which not in PERSONAL_PATHS:
            raise RutubeError("Этот раздел RUTUBE не поддерживается.", "unsupported_feed")
        tokens = _tokens(auth)
        expiry = tokens.get("expires_at")
        if not tokens.get("access_token") or expiry is not None and float(expiry) <= self.clock():
            raise AuthRequired()
        query = urllib.parse.urlencode({"limit": 40, "page": max(1, int(page)), "client": "tv"})
        _, obj = self._json("GET", ORIGIN + PERSONAL_PATHS[which] + "?" + query, auth=auth)
        return self._page(obj)

    def resolve(self, video_id: str, auth: dict | None = None) -> dict:
        if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
            raise RutubeError("Некорректный идентификатор видео RUTUBE.", "invalid_video_id")
        _, obj = self._json("GET", ORIGIN + "/api/video/" + video_id + "/?format=json&client=tv", auth=auth)
        card = normalize_video(obj)
        if not card or card["id"] != video_id:
            raise RutubeError("Видео RUTUBE не найдено.", "invalid_response")
        _, options = self._json("GET", ORIGIN + "/api/play/options/" + video_id +
                               "/?format=json&no_404=true&client=tv&ac_client=linux_tv&pver=v2&av1=0", auth=auth)
        if not isinstance(options, dict):
            raise RutubeError("Неизвестный формат параметров воспроизведения RUTUBE.", "invalid_response")
        if options.get("drm_token") or options.get("drm"):
            raise RutubeError("Это видео защищено DRM и не поддерживается этим проигрывателем.", "drm_unsupported")
        balancer = options.get("video_balancer") or {}
        candidates = [balancer.get(k) for k in ("m3u8", "default")] if isinstance(balancer, dict) else []
        live = options.get("live_streams") or {}
        if isinstance(live, dict) and isinstance(live.get("hls"), list):
            candidates.extend(v.get("url") for v in live["hls"] if isinstance(v, dict))
        playback = next((v for v in candidates if _safe_https(v, ("rutube.ru", "rtbcdn.ru", "rutubelist.ru"))), None)
        if not playback:
            raise RutubeError("RUTUBE не предоставил доступный медиапоток для этого видео.", "media_unavailable")
        card["playback"] = {"url": playback,
                            "protocol": "hls" if ".m3u8" in urllib.parse.urlsplit(playback).path else "https",
                            "headers": {"User-Agent": UA, "Referer": card["url"]}}
        return card

    def discover_client_id(self) -> str:
        if self._client_id and self._client_until > self.clock():
            return self._client_id
        page = self._request("GET", TV_URL)
        if page.status != 200:
            raise RutubeError("Не удалось загрузить страницу входа RUTUBE TV.", "auth_bootstrap", page.status)
        scripts = re.findall(r'<script\b[^>]*\bsrc=["\']([^"\']+)', _text(page.body), re.I)
        # Only current first-party JS; never execute it or trust its contents as instructions.
        for relative in scripts[:8]:
            url = urllib.parse.urljoin(TV_URL, html.unescape(relative))
            parts = urllib.parse.urlsplit(url)
            if parts.scheme != "https" or parts.hostname != "rutube.ru" or not parts.path.startswith("/tv-release/"):
                continue
            result = self._request("GET", url)
            if result.status != 200:
                continue
            script = _text(result.body)
            client_id = self._extract_client_id(script)
            if client_id:
                self._client_id, self._client_until = client_id, self.clock() + 3600
                return client_id
        raise RutubeError("Формат входа RUTUBE TV изменился. Обновите приложение.", "auth_bootstrap")

    @staticmethod
    def _extract_client_id(script: str) -> str | None:
        # Locate the client_id used by the device-code request, then resolve its literal.
        # The minified variable name is intentionally not fixed to a particular release.
        for occurrence in re.finditer(r"/device/code/?", script):
            nearby = script[max(0, occurrence.start() - 180):occurrence.end() + 450]
            match = re.search(r'''["']?client_id["']?\s*:\s*(?:["']([A-Za-z0-9_-]{20,120})["']|([A-Za-z_$][\w$]*))''', nearby)
            if not match:
                continue
            if match.group(1):
                return match.group(1)
            variable = re.escape(match.group(2))
            assignment = re.search(r'(?<![\w$])' + variable + r'''\s*=\s*["']([A-Za-z0-9_-]{20,120})["']''', script)
            if assignment and CLIENT_LITERAL.fullmatch(assignment.group(1)):
                return assignment.group(1)
        return None

    def _public(self, private: dict) -> dict:
        tokens = _tokens(private)
        expiry = tokens.get("expires_at")
        if tokens.get("access_token") and tokens.get("verified") and (expiry is None or float(expiry) > self.clock()):
            return {"state": "signed_in"}
        pending = private.get("pending") or {}
        if pending and float(pending.get("expires_at", 0)) > self.clock():
            return {"state": "code", "code": pending["user_code"], "url": pending["verification_url"],
                    "expires": max(0, int(pending["expires_at"] - self.clock()))}
        return {"state": "signed_out"}

    def _envelope(self, private: dict, public: dict | None = None) -> dict:
        return {"public": public if public is not None else self._public(private), "private": private}

    def auth_begin(self, device_name: str = "BMW MGU", auth: dict | None = None) -> dict:
        private = _private_copy(auth)
        private["provider"] = self.id
        private.setdefault("device_id", str(uuid.uuid4()))
        if self._public(private)["state"] in ("signed_in", "code"):
            return self._envelope(private)
        try:
            client_id = self.discover_client_id()
            private["client_id"] = client_id
            status, result = self._json("POST", CODE_URL, auth={"device_id": private["device_id"]},
                                        data={"client_id": client_id, "device_name": str(device_name)[:120]}, errors=True)
            if status != 200 or not isinstance(result, dict):
                raise RutubeError("RUTUBE не выдал код входа. Повторите попытку.", "auth_code", status)
            user_code = str(result.get("user_code") or "")
            device_code = result.get("device_code")
            if not re.fullmatch(r"[A-Za-z0-9]{6}", user_code) or not isinstance(device_code, str) or not device_code:
                raise RutubeError("RUTUBE вернул неполный код входа.", "invalid_response")
            uri = _safe_https(result.get("verification_uri"), ("rutube.ru",))
            if not uri or urllib.parse.urlsplit(uri).path.rstrip("/") != "/activate":
                raise RutubeError("Неизвестный адрес подтверждения входа RUTUBE.", "invalid_response")
            interval = min(60, max(5, int(result.get("interval") or 10)))
            expires = min(3600, max(1, int(result.get("expires_in") or 1200)))
            delimiter = "&" if urllib.parse.urlsplit(uri).query else "?"
            private["pending"] = {"device_code": device_code, "user_code": user_code,
                                  "verification_url": uri + delimiter + urllib.parse.urlencode({"user_code": user_code}),
                                  "expires_at": self.clock() + expires, "interval": interval,
                                  "next_poll_at": self.clock() + interval}
            return self._envelope(private)
        except (RutubeError, ValueError, TypeError) as error:
            message = str(error) if isinstance(error, RutubeError) else "RUTUBE вернул некорректные параметры входа."
            return self._envelope(private, {"state": "error", "msg": message})

    def _save_tokens(self, private: dict, result: Any) -> None:
        if not isinstance(result, dict) or not isinstance(result.get("access_token"), str) or not result["access_token"]:
            raise RutubeError("RUTUBE не предоставил токен входа.", "invalid_response")
        previous = _tokens(private)
        refresh = result.get("refresh_token") or previous.get("refresh_token")
        expiry = result.get("expires_in")
        private["tokens"] = {"access_token": result["access_token"], "refresh_token": refresh,
                             "expires_at": self.clock() + max(1, int(expiry)) if expiry is not None else None,
                             "verified": False}
        private.pop("pending", None)

    def _verify_tokens(self, private: dict) -> None:
        _, profile = self._json("GET", VISITOR_URL, auth=private)
        if not isinstance(profile, dict) or not profile.get("id"):
            raise AuthRequired("RUTUBE ещё не подтвердил вход в профиль.")
        private["tokens"]["verified"] = True
        private["tokens"]["profile_id"] = str(profile["id"])

    def auth_poll(self, auth: dict | None) -> dict:
        private = _private_copy(auth)
        pending = private.get("pending")
        if not isinstance(pending, dict):
            return self.auth_status(private)
        now = self.clock()
        if now >= float(pending.get("expires_at", 0)):
            private.pop("pending", None)
            return self._envelope(private, {"state": "error", "msg": "Срок действия кода RUTUBE истёк. Получите новый код."})
        if now < float(pending.get("next_poll_at", 0)):
            return self._envelope(private)
        pending["next_poll_at"] = now + max(5, int(pending.get("interval") or 10))
        try:
            status, result = self._json("POST", TOKEN_URL, auth={"device_id": private.get("device_id")}, form=True,
                                        data={"device_code": pending["device_code"], "client_id": private["client_id"],
                                              "grant_type": "device_code"}, errors=True)
            if status == 200:
                self._save_tokens(private, result)
                self._verify_tokens(private)
                return self._envelope(private)
            code = str(result.get("code") or result.get("error") or "") if isinstance(result, dict) else ""
            if status in (400, 428) and code in ("1004003", "authorization_pending"):
                return self._envelope(private)
            if code == "slow_down" or status == 429:
                pending["interval"] = min(60, int(pending.get("interval") or 10) + 5)
                pending["next_poll_at"] = now + pending["interval"]
                return self._envelope(private)
            if code in ("1004004", "expired_token", "expired_code"):
                private.pop("pending", None)
                raise RutubeError("Срок действия кода RUTUBE истёк. Получите новый код.", "expired_code")
            if status >= 500:
                return self._envelope(private)  # bounded by pending.expires_at; retry at the advertised interval
            private.pop("pending", None)
            raise RutubeError("RUTUBE отклонил подтверждение входа. Получите новый код.", "auth_denied", status)
        except (RutubeError, ValueError, KeyError, TypeError) as error:
            message = str(error) if isinstance(error, RutubeError) else "RUTUBE вернул некорректные параметры входа."
            return self._envelope(private, {"state": "error", "msg": message})

    def auth_refresh(self, auth: dict | None) -> dict:
        private = _private_copy(auth)
        refresh = _tokens(private).get("refresh_token")
        if not refresh or not private.get("client_id"):
            return self._envelope(private, {"state": "error", "msg": "Войдите в аккаунт RUTUBE заново."})
        try:
            status, result = self._json("POST", REFRESH_URL, auth=private,
                                        data={"client_id": private["client_id"], "refresh_token": refresh}, form=True, errors=True)
            if status != 200:
                if status in (400, 401, 403):
                    private.pop("tokens", None)
                # 404/5xx may mean a changed endpoint or temporary server failure.
                # Retain the private tokens for recovery; never turn that into signed_in.
                raise RutubeError("Не удалось продлить вход RUTUBE. Войдите заново.", "auth_refresh", status)
            self._save_tokens(private, result)
            self._verify_tokens(private)
            return self._envelope(private)
        except (RutubeError, ValueError, TypeError) as error:
            message = str(error) if isinstance(error, RutubeError) else "RUTUBE вернул некорректный токен входа."
            return self._envelope(private, {"state": "error", "msg": message})

    def auth_status(self, auth: dict | None, verify: bool = False) -> dict:
        private = _private_copy(auth)
        tokens = _tokens(private)
        if not tokens.get("access_token"):
            if private.get("pending"):
                return self.auth_poll(private)
            return self._envelope(private)
        expiry = tokens.get("expires_at")
        if expiry is not None and float(expiry) <= self.clock():
            return self.auth_refresh(private)
        if verify or not tokens.get("verified"):
            try:
                self._verify_tokens(private)
            except RutubeError as error:
                if isinstance(error, AuthRequired) and tokens.get("refresh_token"):
                    return self.auth_refresh(private)
                return self._envelope(private, {"state": "error", "msg": str(error)})
        return self._envelope(private)

    def sign_out(self, auth: dict | None = None) -> dict:
        private = _private_copy(auth)
        refresh = _tokens(private).get("refresh_token")
        if refresh:
            try:
                self._json("POST", LOGOUT_URL, auth=private, data={"refresh_token": refresh})
            except RutubeError:
                pass  # local credentials are discarded even if the server cannot be reached
        return self._envelope({"provider": self.id}, {"state": "signed_out"})


Provider = RutubeProvider


def search(q, auth=None, **kwargs):
    return Provider().search(q, auth, **kwargs)


def home(auth=None, **kwargs):
    return Provider().home(auth, **kwargs)


def feed(which="home", auth=None, **kwargs):
    return Provider().feed(which, auth, **kwargs)


def resolve(video_id, auth=None):
    return Provider().resolve(video_id, auth)


def auth_begin(device_name="BMW MGU", auth=None):
    return Provider().auth_begin(device_name, auth)


def auth_poll(auth):
    return Provider().auth_poll(auth)


def auth_status(auth, verify=False):
    return Provider().auth_status(auth, verify)


def auth_refresh(auth):
    return Provider().auth_refresh(auth)


def sign_out(auth=None):
    return Provider().sign_out(auth)
