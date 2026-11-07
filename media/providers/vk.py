"""VK Video provider. Native MGU UI talks to this module through the private worker.

Network policy is always DIRECT. Verified user tokens enable the official personal
video/list/search API. OAuth tokens are not web cookies; if an API media stream is
missing, only an anonymous probe may prove public availability. Explicit private
videos/access keys never fall back to that guest resolver.
All auth methods return {public: AuthState, private: persistence_state}. Only public
may cross the app socket. resolve() is worker-only (its stream URLs are temporary).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
import importlib
import json
import re
import secrets
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


VIDEO_ID = re.compile(r"^-?[1-9]\d{0,19}_[1-9]\d{0,19}$")
API = "https://api.vk.ru/method/"
ID = "https://id.vk.ru"
API_VERSION = "5.199"
MGU_CA = "/var/opt/mgu-python/current/ssl/cacert.pem"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36")


class ProviderError(Exception):
    def __init__(self, code, message, auth=None):
        self.code = code
        self.message = message
        self.auth = auth
        super().__init__(message)


class _NoJsonRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        # JSON endpoints have fixed registered origins. urllib would otherwise
        # forward Authorization to redirected hosts, including a broker key.
        return None


class DirectTransport:
    """Inject request_json(method, url, fields=None, headers=None) for offline tests.

    The existing MGU Python CA bundle is preferred; no TLS verification bypass.
    The bundle must include HARICA, used by the observed okcdn.ru media servers.
    """
    def __init__(self, ca_bundle=None, timeout=15):
        ca_bundle = ca_bundle or (MGU_CA if Path(MGU_CA).is_file() else None)
        context = ssl.create_default_context(cafile=ca_bundle)
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=context),
            _NoJsonRedirect(),
        )
        self.timeout = timeout

    def request_json(self, method, url, fields=None, headers=None):
        data = None
        headers = dict(headers or {})
        if fields is not None:
            if headers.get("Content-Type") == "application/json":
                data = json.dumps(fields, separators=(",", ":")).encode("utf-8")
            else:
                data = urllib.parse.urlencode(fields).encode("utf-8")
                headers["Content-Type"] = "application/x-www-form-urlencoded"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            response = error
        except (OSError, ValueError) as error:
            raise ProviderError("network_error", "Сервис VK недоступен. Повторите запрос.") from error
        try:
            with response:
                data = response.read(2 * 1024 * 1024 + 1)
            if len(data) > 2 * 1024 * 1024:
                raise ValueError("oversized JSON")
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError("non-object JSON")
            return result
        except (ValueError, OSError) as error:
            raise ProviderError("invalid_response", "VK вернул некорректный ответ.") from error


class _QuietLog:
    def debug(self, _message):
        pass

    info = warning = error = debug


def _text(value):
    return html.unescape(re.sub(r"<[^>]*>", "", str(value or ""))).strip()


def _duration(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(0, int(value))
    result = 0
    try:
        parts = str(value).split(":")
        if not 1 <= len(parts) <= 3:
            return 0
        for part in parts:
            result = result * 60 + int(part)
        return max(0, result)
    except (ValueError, TypeError):
        return 0


def _https_url(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
        return value if (parsed.scheme == "https" and parsed.hostname
                         and parsed.username is None and parsed.password is None) else None
    except ValueError:
        return None


def _private(auth):
    if not isinstance(auth, dict):
        return {}
    value = auth.get("private", auth)
    return value if isinstance(value, dict) else {}


def _auth_error(code, message, private=None, required=None):
    public = {"state": "error", "code": code, "msg": message}
    if required:
        public["required"] = required
    return {"public": public, "private": private or {}}


def _auth_temporary(account):
    # A transient failure must not destroy a refresh token, especially after VK
    # has rotated it. Mark the account unverified so the next status cannot
    # report success without retrying the profile/video permission checks.
    candidate = dict(account, verification_pending=True)
    return _auth_error("temporarily_unavailable", "VK ID временно недоступен. Повторите проверку подключения.",
                       private={"account": candidate})


def _definitive_oauth_error(response):
    return response.get("error") in ("invalid_grant", "invalid_token", "access_denied")


def _current(account, skew=30):
    if account.get("auth_type") == "vk_tv" and account.get("expires_at") == 0:
        return True  # Explicit offline token from the native TV authorization response.
    try:
        return float(account.get("expires_at", 0)) > time.time() + skew
    except (ValueError, TypeError):
        return False


class Provider:
    id = "vk"
    network = "direct"

    def __init__(self, transport=None, yt_dlp=None, config=None):
        self.config = dict(config or {})
        self.transport = transport or DirectTransport(self.config.get("ca_bundle"))
        self.yt_dlp = yt_dlp

    def _module(self):
        if self.yt_dlp is None:
            self.yt_dlp = importlib.import_module("yt_dlp")
        return self.yt_dlp

    def _ydl_options(self):
        # Never inherit the YouTube proxy, HTTP_PROXY, cookiefile or account credentials.
        return {"proxy": "", "socket_timeout": 15, "retries": 1, "extractor_retries": 1,
                "ca_certs": self.config.get("ca_bundle"),
                "cachedir": False, "quiet": True, "no_warnings": True, "noprogress": True,
                "logger": _QuietLog(), "http_headers": {"User-Agent": USER_AGENT}}

    def _request(self, method, url, fields=None):
        return self.transport.request_json(method, url, fields=fields,
                                           headers={"User-Agent": USER_AGENT})

    def _oauth_request(self, route, query, body):
        # Match VKCOM/vkid-web-sdk src/auth/auth.ts: flow/client/PKCE fields in
        # the query; authorization code, refresh token or access token in the body.
        return self._request("POST", ID + "/oauth2/" + route + "?" + urllib.parse.urlencode(query), body)

    def _broker_config(self):
        missing = [key for key in ("client_id", "redirect_uri", "callback_broker", "broker_key")
                   if not self.config.get(key)]
        if missing:
            raise ProviderError("configuration_required", "Для входа нужны приложение VK ID и настроенный адрес подтверждения.")
        client_id = str(self.config["client_id"])
        broker = _https_url(self.config["callback_broker"])
        redirect = _https_url(self.config["redirect_uri"])
        key = self.config["broker_key"]
        if (not re.fullmatch(r"[1-9]\d{0,19}", client_id) or not broker or not redirect
                or not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", key)):
            raise ProviderError("invalid_configuration", "Проверьте настройки подключения VK ID.")
        parsed, callback = urllib.parse.urlsplit(broker), urllib.parse.urlsplit(redirect)
        origin = parsed.scheme + "://" + parsed.netloc
        if (parsed.path not in ("", "/") or parsed.query or parsed.fragment
                or callback.scheme != parsed.scheme or callback.netloc != parsed.netloc
                or callback.query or callback.fragment or not re.fullmatch(r"/[A-Za-z0-9/_-]{1,100}", callback.path)
                or callback.path.startswith(("/s/", "/v1/"))
                or len((origin + "/s/" + "x" * 22).encode()) > 62):
            raise ProviderError("invalid_configuration", "Адрес возврата VK ID должен принадлежать короткому HTTPS-адресу подключения.")
        return {"client_id": client_id, "redirect_uri": redirect, "origin": origin, "key": key}

    def _broker_request(self, config, method, route, fields):
        return self.transport.request_json(method, config["origin"] + route, fields=fields,
            headers={"User-Agent": USER_AGENT, "Content-Type": "application/json",
                     "Authorization": "Bearer " + config["key"]})

    @staticmethod
    def _pending_public(pending):
        return {"state": "code", "url": pending["url"], "code": None,
                "expires": max(0, int(pending["expires_at"] - time.time())),
                "msg": "Подтвердите вход на странице VK ID на телефоне."}

    @staticmethod
    def _verified_account(auth):
        account = _private(auth).get("account")
        if not isinstance(account, dict) or account.get("video_access") is not True or account.get("verification_pending"):
            return None
        if (not isinstance(account.get("access_token"), str) or not account["access_token"]
                or not re.fullmatch(r"[1-9]\d{0,19}", str(account.get("user_id") or "")) or not _current(account, 0)):
            raise ProviderError("auth_required", "Повторите вход VK Видео.")
        if not re.fullmatch(r"[a-f0-9]{32}", str(account.get("cache_id") or "")):
            account["cache_id"] = secrets.token_hex(16)
        return account

    def _api_video(self, method, fields, account, auth):
        response = self._request("POST", API + method,
                                 dict(fields, access_token=account["access_token"],
                                      v="5.267" if account.get("auth_type") == "vk_tv" else API_VERSION))
        error = response.get("error")
        if error:
            code = error.get("error_code") if isinstance(error, dict) else None
            if code == 5:
                _private(auth).clear()
                public = {"state": "error", "code": "authorization_expired", "msg": "Повторите вход VK Видео."}
                raise ProviderError("auth_required", public["msg"], auth=public)
            if code in (15, 27, 1051):
                raise ProviderError("video_permission_required", "Приложению VK не предоставлен доступ к этому методу видео.")
            raise ProviderError("video_api_unavailable", "VK API видео временно недоступен. Повторите запрос.")
        value = response.get("response")
        if (not isinstance(value, dict) or not isinstance(value.get("items"), list)
                or not isinstance(value.get("count"), int) or isinstance(value.get("count"), bool) or value["count"] < 0):
            raise ProviderError("invalid_response", "VK API вернул некорректный список видео.")
        return value

    @staticmethod
    def _video_hint(account, video_id, row):
        hints = account.setdefault("video_hints", {})
        if not isinstance(hints, dict):
            hints = account["video_hints"] = {}
        previous = hints.pop(video_id, {})
        access = row.get("access_key")
        if not isinstance(access, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", access):
            access = previous.get("access_key") if isinstance(previous, dict) else None
        hint = {"is_private": bool(row.get("is_private") or row.get("content_restricted") or access)}
        if access:
            hint["access_key"] = access
        hints[video_id] = hint
        while len(hints) > 400:
            hints.pop(next(iter(hints)))
        return hint

    @staticmethod
    def _api_card(row, owners, account):
        if not isinstance(row, dict) or isinstance(row.get("owner_id"), bool) or isinstance(row.get("id"), bool):
            return None
        video_id = f"{row.get('owner_id')}_{row.get('id')}"
        if not VIDEO_ID.fullmatch(video_id):
            return None
        source_images = row.get("image") if isinstance(row.get("image"), list) else []
        images = [image for image in source_images[:64]
                  if isinstance(image, dict) and _https_url(image.get("url"))]
        image = min(images, key=lambda item: abs(_duration(item.get("width")) - 320)) if images else {}
        return {"id": video_id, "title": _text(row.get("title")) or "Видео",
                "channel": owners.get(str(row.get("owner_id")), ""), "duration_s": _duration(row.get("duration")),
                "thumbnail": image.get("url"), "url": "https://vk.com/video" + video_id,
                "_account_user_id": str(account["user_id"])}

    def _api_list(self, response, account, offset=0):
        owners = {}
        profiles = response.get("profiles") if isinstance(response.get("profiles"), list) else []
        groups = response.get("groups") if isinstance(response.get("groups"), list) else []
        for row in profiles[:400]:
            if isinstance(row, dict):
                owners[str(row.get("id"))] = _text(" ".join(str(row.get(k) or "") for k in ("first_name", "last_name")))
        for row in groups[:400]:
            if isinstance(row, dict):
                owners["-" + str(row.get("id"))] = _text(row.get("name"))
        items, seen = [], set()
        for row in response["items"][:200]:
            card = self._api_card(row, owners, account)
            if card and card["id"] not in seen:
                seen.add(card["id"])
                self._video_hint(account, card["id"], row)
                items.append(card)
        after = offset + len(response["items"])
        return {"items": items, "next_offset": after if items and after < response["count"] and after <= 10000 else None,
                "kind": "account", "_account_user_id": str(account["user_id"])}

    def search(self, q, auth=None, offset=0):
        """Official user-token search when verified, otherwise the guest web search.

        Guest endpoint observed on 2026-11-07; it is not a documented VK API.
        Pinned yt-dlp's VKIE handles its normal web response/challenge parsing.
        Array indexes are covered by a structural fixture and invalid rows are skipped.
        """
        q = str(q or "").strip()[:200]
        if not q:
            return {"items": [], "next_offset": None, "kind": "search", "query": ""}
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0 or offset > 10000:
            raise ProviderError("invalid_offset", "Некорректная страница поиска.")
        account = self._verified_account(auth)
        if account:
            response = self._api_video("video.search", {"q": q, "count": 20, "offset": offset,
                                                       "extended": 1, "filters": "vk"}, account, auth)
            return dict(self._api_list(response, account, offset), query=q)
        module = self._module()
        vk_ie = getattr(module, "VKIE", None) or importlib.import_module("yt_dlp.extractor.vk").VKIE
        try:
            with module.YoutubeDL(self._ydl_options()) as downloader:
                payload = vk_ie(downloader)._download_payload("al_video", "search", {
                    "act": "search_video", "section": "search", "q": q,
                    "offset": offset, "oid": 0,
                })
        except Exception as error:
            raise ProviderError("search_unavailable", "Поиск VK Видео сейчас недоступен.") from error
        if not isinstance(payload, list) or len(payload) < 3 or not isinstance(payload[2], dict):
            raise ProviderError("invalid_response", "Формат поиска VK изменился.")
        rows = payload[2].get("list")
        if not isinstance(rows, list):
            raise ProviderError("invalid_response", "Формат поиска VK изменился.")
        items, seen = [], set()
        for row in rows[:200]:
            if not isinstance(row, list) or len(row) < 6:
                continue
            video_id = f"{row[0]}_{row[1]}"
            if not VIDEO_ID.fullmatch(video_id) or video_id in seen:
                continue
            seen.add(video_id)
            duration = row[19] if len(row) > 19 and isinstance(row[19], int) else row[5]
            items.append({"id": video_id, "title": _text(row[3]) or "Видео",
                          "channel": _text(row[8]) if len(row) > 8 else "",
                          "duration_s": _duration(duration), "thumbnail": _https_url(row[2]),
                          "url": f"https://vk.com/video{video_id}"})
        next_offset = payload[5] if len(payload) > 5 else None
        if (not items or isinstance(next_offset, bool) or not isinstance(next_offset, int)
                or next_offset <= offset or next_offset > 10000):
            next_offset = None
        return {"items": items, "next_offset": next_offset, "kind": "search", "query": q}

    def home(self, auth=None):
        account = self._verified_account(auth)
        if account:
            response = self._api_video("video.get", {"owner_id": account["user_id"], "count": 20, "extended": 1}, account, auth)
            result = self._api_list(response, account)
            result["shelves"] = [{"title": "Мои видео VK", "items": result["items"]}]
            result["msg"] = "В вашем списке пока нет видео." if not result["items"] else None
            return result
        # A search for "popular" is not the user's Home/recommendation feed.
        return {"items": [], "next_offset": None, "kind": "requires_search",
                "msg": "Используйте поиск VK Видео. Личная лента пока не подключена."}

    def resolve(self, video_id, auth=None):
        if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
            raise ProviderError("invalid_id", "Некорректный идентификатор VK Видео.")
        canonical = f"https://vk.com/video{video_id}"
        account = self._verified_account(auth)
        if account:
            hint = (account.get("video_hints") or {}).get(video_id) or {}
            target = video_id + ("_" + hint["access_key"] if hint.get("access_key") else "")
            response = self._api_video("video.get", {"videos": target, "count": 1, "extended": 1}, account, auth)
            result = self._api_list(response, account)
            card = next((item for item in result["items"] if item["id"] == video_id), None)
            row = next((item for item in response["items"] if isinstance(item, dict)
                        and f"{item.get('owner_id')}_{item.get('id')}" == video_id), None)
            if not card or not row:
                raise ProviderError("video_unavailable", "VK не предоставил доступ к этому видео.")
            if row.get("content_restricted"):
                raise ProviderError("video_restricted", "VK ограничил доступ к этому видео.")
            files = row.get("files") if isinstance(row.get("files"), dict) else {}
            headers = {"User-Agent": USER_AGENT, "Referer": "https://vkvideo.ru/"}
            formats = [{"format_id": "api-mp4-" + str(height), "url": files["mp4_" + str(height)],
                        "ext": "mp4", "protocol": "https", "height": height, "http_headers": headers}
                       for height in (144, 240, 360, 480, 720, 1080)
                       if _https_url(files.get("mp4_" + str(height)))]
            if formats:
                return dict(card, provider="vk", network="direct", formats=formats, http_headers=headers)
            if files.get("external") or str(row.get("platform") or "").lower() in ("youtube", "vimeo"):
                raise ProviderError("external_video", "Это видео размещено на другом сервисе.")
            if self._video_hint(account, video_id, row).get("is_private"):
                raise ProviderError("private_stream_unavailable", "VK подтвердил доступ к видео, но не предоставил поток для нативного плеера.")
            # The guest extractor receives no cookies/token/access_key. Success
            # proves anonymous availability even if VK omitted its privacy flag.
        else:
            previous = _private(auth).get("account") or {}
            hint = (previous.get("video_hints") or {}).get(video_id) if isinstance(previous, dict) else None
            if hint and hint.get("is_private"):
                raise ProviderError("auth_required", "Для этого видео нужен подтверждённый вход VK Видео.")
        try:
            with self._module().YoutubeDL(self._ydl_options()) as downloader:
                info = downloader.extract_info(canonical, download=False, process=False)
                # VK can embed YouTube/other hosts. Never silently fetch those in direct mode.
                if not isinstance(info, dict) or info.get("_type") in ("url", "url_transparent", "playlist"):
                    raise ProviderError("external_video", "Это видео размещено на другом сервисе.")
                if str(info.get("id")) != video_id:
                    raise ProviderError("invalid_response", "VK вернул другое видео.")
                formats = []
                for value in info.get("formats") or []:
                    if (not isinstance(value, dict) or value.get("has_drm")
                            or not _https_url(value.get("url"))):
                        continue
                    fmt = {key: value[key] for key in (
                        "format_id", "url", "ext", "protocol", "height", "width", "fps",
                        "vcodec", "acodec", "filesize", "tbr", "manifest_url",
                    ) if key in value}
                    # Signed okcdn URLs bind srcAg to the extraction User-Agent. Do not
                    # replace this with the fetcher's own default User-Agent later.
                    fmt["http_headers"] = self._media_headers(downloader, info, value)
                    formats.append(fmt)
                if not formats:
                    raise ProviderError("no_formats", "Нет доступного формата для этого видео.")
                return {"id": video_id, "provider": "vk", "network": "direct", "url": canonical,
                        "title": _text(info.get("title")) or "Видео",
                        "channel": _text(info.get("uploader")),
                        "duration_s": _duration(info.get("duration")),
                        "thumbnail": _https_url(info.get("thumbnail")), "formats": formats,
                        "http_headers": self._media_headers(downloader, info, {})}
        except ProviderError:
            raise
        except Exception as error:
            raise ProviderError("video_unavailable", "VK Видео не удалось открыть этот ролик.") from error

    @staticmethod
    def _media_headers(downloader, info, value):
        headers = dict(downloader.params.get("http_headers") or {})
        headers.update(info.get("http_headers") or {})
        headers.update(value.get("http_headers") or {})
        # This guest resolver must not leak unrelated credentials into a media request.
        return {key: val for key, val in headers.items()
                if key.lower() not in ("cookie", "authorization", "proxy-authorization")}

    def _tv_auth(self):
        module = importlib.import_module("vk_tv")
        return module.TvAuth(self.transport, self._verify_tv_account)

    def auth_begin(self, private_auth=None):
        mode = self.config.get("auth_mode") or "tv"
        if mode == "relay":
            return self._oauth_begin()
        result = self._tv_auth().begin(_private(private_auth))
        if (mode == "auto" and result.get("public", {}).get("state") == "error"
                and all(self.config.get(key) for key in ("client_id", "redirect_uri", "callback_broker", "broker_key"))):
            return self._oauth_begin()
        return result

    def _oauth_begin(self):
        try:
            config = self._broker_config()
        except ProviderError as error:
            required = [key for key in ("client_id", "redirect_uri", "callback_broker", "broker_key")
                        if not self.config.get(key)]
            return _auth_error(error.code, error.message, required=required)
        verifier = secrets.token_urlsafe(64)
        state = secrets.token_urlsafe(24)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        pending = {"state": state, "code_verifier": verifier, "expires_at": time.time() + 600,
                   "client_id": config["client_id"], "redirect_uri": config["redirect_uri"],
                   "broker": config["origin"]}
        fields = {"client_id": config["client_id"], "redirect_uri": config["redirect_uri"],
                  "scope": str(self.config.get("scope") or "video"), "state": state,
                  "code_challenge": challenge, "code_challenge_method": "S256"}
        try:
            session = self._broker_request(config, "POST", "/v1/sessions", fields)
            session_id, poll_token = session.get("session_id"), session.get("poll_token")
            if (not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{22}", session_id)
                    or not isinstance(poll_token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", poll_token)
                    or session.get("url") != config["origin"] + "/s/" + session_id):
                raise ValueError("invalid broker session")
            ttl = int(session.get("expires_in") or 0)
            interval = int(session.get("poll_interval") or 5)
            if not 0 < ttl <= 600 or not 1 <= interval <= 30:
                raise ValueError("invalid broker deadline")
            pending.update({"broker_session": session_id, "broker_poll_token": poll_token,
                            "url": session["url"], "expires_at": time.time() + ttl,
                            "poll_interval": max(5, interval), "next_poll_at": 0})
            return {"public": self._pending_public(pending), "private": {"pending": pending}}
        except (ProviderError, ValueError, TypeError):
            return _auth_error("broker_unavailable", "Не удалось подготовить вход VK ID. Проверьте сервис подключения.")

    def auth_complete(self, callback_url=None, code=None, device_id=None, private_auth=None, state=None):
        private = _private(private_auth)
        pending = private.get("pending")
        if not isinstance(pending, dict) or pending.get("expires_at", 0) <= time.time():
            return _auth_error("authorization_expired", "Начните вход VK ID заново.")
        try:
            if callback_url is not None:
                if not isinstance(callback_url, str) or len(callback_url) > 8192:
                    raise ValueError("bad callback")
                callback = urllib.parse.urlsplit(callback_url)
                redirect = urllib.parse.urlsplit(pending["redirect_uri"])
                if (callback.scheme, callback.netloc, callback.path) != (redirect.scheme, redirect.netloc, redirect.path):
                    raise ValueError("callback target mismatch")
                values = urllib.parse.parse_qs(callback.query, max_num_fields=32)
                if "payload" in values:
                    data = json.loads(values["payload"][0])
                else:
                    data = {key: value[0] for key, value in values.items()}
                code, device_id, state = data.get("code"), data.get("device_id"), data.get("state")
            if (not isinstance(state, str) or not hmac.compare_digest(state.encode(), pending["state"].encode())
                    or not isinstance(code, str) or not 0 < len(code) < 4096
                    or not isinstance(device_id, str) or not 0 < len(device_id) < 1024):
                raise ValueError("callback fields invalid")
        except (ValueError, TypeError, KeyError):
            return _auth_error("invalid_callback", "Ответ VK ID не соответствует начатому входу.")
        try:
            token = self._oauth_request("auth", {
                "grant_type": "authorization_code", "client_id": pending["client_id"],
                "redirect_uri": pending["redirect_uri"], "code_verifier": pending["code_verifier"],
                "state": pending["state"], "device_id": device_id,
            }, {"code": code})
            if token.get("state") != pending["state"] or not token.get("access_token"):
                return _auth_error("authorization_failed", "VK ID не подтвердил вход.")
            account = {"access_token": token["access_token"], "refresh_token": token.get("refresh_token"),
                       "device_id": device_id, "client_id": pending["client_id"],
                       "redirect_uri": pending["redirect_uri"], "expires_at": time.time() + int(token.get("expires_in") or 3600),
                       "verification_pending": True}
            return self._verify_account(account)
        except (ProviderError, ValueError, TypeError):
            return _auth_error("authorization_failed", "Не удалось завершить вход VK ID.")

    def _verify_account(self, account):
        account = dict(account, verification_pending=True)
        try:
            profile = self._oauth_request("user_info", {"client_id": account["client_id"]},
                                          {"access_token": account["access_token"]})
            if _definitive_oauth_error(profile):
                return _auth_error("authorization_expired", "Повторите вход VK ID.")
            if profile.get("error"):
                return _auth_temporary(account)
            user = profile.get("user")
        except ProviderError:
            return _auth_temporary(account)
        return self._finish_video_verification(account, user, API_VERSION)

    def _verify_tv_account(self, account):
        account = dict(account, verification_pending=True)
        if not _current(account, 0):
            return _auth_error("authorization_expired", "Начните вход VK Видео заново.")
        try:
            profile = self._request("POST", API + "users.get", {
                "access_token": account["access_token"], "v": "5.267",
            })
        except ProviderError:
            return _auth_temporary(account)
        error = profile.get("error")
        if isinstance(error, dict) and error.get("error_code") == 5:
            return _auth_error("authorization_expired", "Начните вход VK Видео заново.")
        users = profile.get("response")
        if error or not isinstance(users, list) or len(users) != 1 or not isinstance(users[0], dict):
            return _auth_temporary(account)
        return self._finish_video_verification(account, users[0], "5.267")

    def _finish_video_verification(self, account, user, version):
        account = dict(account, verification_pending=True)
        user_id = str(user.get("user_id") or user.get("id") or "") if isinstance(user, dict) else ""
        if not user_id.isdigit() or int(user_id) <= 0:
            return _auth_temporary(account)
        if account.get("user_id") and str(account["user_id"]) != user_id:
            return _auth_error("authorization_failed", "VK ID вернул другую учётную запись. Повторите вход.")
        account["user_id"] = user_id
        if not re.fullmatch(r"[a-f0-9]{32}", str(account.get("cache_id") or "")):
            account["cache_id"] = secrets.token_hex(16)
        try:
            response = self._request("POST", API + "video.get", {
                "access_token": account["access_token"], "v": version, "owner_id": user_id, "count": 1,
            })
        except ProviderError:
            return _auth_temporary(account)
        error = response.get("error")
        if isinstance(error, dict):
            if error.get("error_code") == 5:  # VK API user authorization failed/revoked.
                return _auth_error("authorization_expired", "Повторите вход VK ID.")
            if error.get("error_code") in (1, 6, 9, 10, 29):  # internal/flood/rate-limit
                return _auth_temporary(account)
        if not error and not isinstance(response.get("response"), dict):
            return _auth_temporary(account)
        account["video_access"] = isinstance(response.get("response"), dict)
        account["verification_pending"] = False
        if not account["video_access"]:
            return _auth_error("video_permission_required",
                               "VK ID подключён, но приложению не предоставлен доступ к API видео.",
                               private={"account": account})
        public = {"state": "signed_in", "user_id": user_id,
                  "name": _text(" ".join(str(user.get(key) or "") for key in ("first_name", "last_name")))}
        return {"public": public, "private": {"account": account}}

    def auth_poll(self, private_auth=None):
        private = _private(private_auth)
        if (private.get("auth_type") == "vk_tv"
                or (isinstance(private.get("pending"), dict) and private["pending"].get("auth_type") == "vk_tv")
                or (isinstance(private.get("account"), dict) and private["account"].get("auth_type") == "vk_tv")):
            return self._tv_auth().poll(private)
        account = private.get("account")
        if isinstance(account, dict) and (account.get("video_access") or account.get("verification_pending")):
            if _current(account):
                if account.get("verification_pending"):
                    return self._verify_account(account)
                return {"public": {"state": "signed_in", "user_id": account.get("user_id")}, "private": private}
            if not account.get("refresh_token"):
                return _auth_error("authorization_expired", "Повторите вход VK ID.")
            try:
                state = secrets.token_urlsafe(24)
                token = self._oauth_request("auth", {
                    "grant_type": "refresh_token", "client_id": account["client_id"],
                    "redirect_uri": account["redirect_uri"], "device_id": account["device_id"],
                    "state": state,
                }, {"refresh_token": account["refresh_token"]})
                if _definitive_oauth_error(token):
                    return _auth_error("authorization_expired", "Повторите вход VK ID.")
                if token.get("error"):
                    return _auth_temporary(account)
                if token.get("state") != state:
                    return _auth_error("authorization_failed", "Ответ VK ID не соответствует начатому входу.")
                if not token.get("access_token"):
                    return _auth_temporary(account)
                account = dict(account, access_token=token["access_token"],
                               refresh_token=token.get("refresh_token") or account["refresh_token"],
                               expires_at=time.time() + int(token.get("expires_in") or 3600),
                               verification_pending=True)
                return self._verify_account(account)
            except ProviderError:
                return _auth_temporary(account)
            except (KeyError, ValueError, TypeError):
                return _auth_error("authorization_expired", "Повторите вход VK ID.")
        pending = private.get("pending")
        if isinstance(pending, dict) and pending.get("expires_at", 0) > time.time():
            try:
                config = self._broker_config()
                if (pending.get("broker") != config["origin"] or pending.get("client_id") != config["client_id"]
                        or pending.get("redirect_uri") != config["redirect_uri"]
                        or not re.fullmatch(r"[A-Za-z0-9_-]{22}", str(pending.get("broker_session") or ""))):
                    raise ValueError("configuration changed")
                if pending.get("next_poll_at", 0) > time.time():
                    return {"public": self._pending_public(pending), "private": private}
                result = self._broker_request(config, "POST", "/v1/sessions/" + pending["broker_session"] + "/poll",
                                              {"poll_token": pending["broker_poll_token"]})
                pending = dict(pending, next_poll_at=time.time() + pending.get("poll_interval", 5))
                if result.get("status") == "pending":
                    return {"public": self._pending_public(pending), "private": {"pending": pending}}
                if result.get("status") == "complete" and not result.get("error"):
                    return self.auth_complete(code=result.get("code"), device_id=result.get("device_id"),
                                              state=result.get("state"), private_auth={"pending": pending})
                if result.get("error") == "session_not_found":
                    return _auth_error("authorization_expired", "Начните вход VK ID заново.")
                return _auth_error("authorization_failed", "VK ID не подтвердил вход. Повторите попытку.")
            except (ProviderError, KeyError, ValueError, TypeError):
                return _auth_error("broker_unavailable", "Не удалось получить подтверждение VK ID. Повторите вход.")
        if isinstance(account, dict):
            return _auth_error("video_permission_required", "Приложению нужен доступ VK к API видео.", private=private)
        return {"public": {"state": "signed_out"}, "private": {}}

    def sign_out(self, private_auth=None):
        private = _private(private_auth)
        if (private.get("auth_type") == "vk_tv"
                or (isinstance(private.get("pending"), dict) and private["pending"].get("auth_type") == "vk_tv")
                or (isinstance(private.get("account"), dict) and private["account"].get("auth_type") == "vk_tv")):
            return self._tv_auth().sign_out(private)
        pending = private.get("pending")
        if isinstance(pending, dict) and pending.get("broker_session") and pending.get("broker_poll_token"):
            try:
                config = self._broker_config()
                if pending.get("broker") == config["origin"]:
                    self._broker_request(config, "DELETE", "/v1/sessions/" + pending["broker_session"],
                                         {"poll_token": pending["broker_poll_token"]})
            except ProviderError:
                pass
        account = private.get("account")
        if isinstance(account, dict) and account.get("access_token") and account.get("client_id"):
            try:
                self._oauth_request("logout", {"client_id": account["client_id"]},
                                    {"access_token": account["access_token"]})
            except ProviderError:
                pass  # Local state still must be removed when the network is unavailable.
        return {"public": {"state": "signed_out"}, "private": {}}
