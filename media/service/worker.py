#!/usr/bin/env python3
"""One private provider operation. JSON on stdin/stdout; never logs credentials."""
import base64
import importlib
import ipaddress
import json
import os
from pathlib import Path
import ssl
import sys
import time
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'providers'))
sys.path.insert(0, str(HERE.parent / 'core/native/jap-ridetube-d'))
import ytfetch


def public_https(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.port not in (None, 443):
        raise ValueError('invalid provider media address')
    try:
        if not ipaddress.ip_address(u.hostname).is_global:
            raise ValueError('private network media address is forbidden')
    except ValueError:
        # A domain is accepted only as provider-resolved data, never directly from the UI.
        if ':' in u.hostname or u.hostname.replace('.', '').isdigit():
            raise ValueError('invalid/private network address')
    if u.hostname in ('localhost',) or u.hostname.endswith(('.local', '.localhost', '.invalid')):
        raise ValueError('invalid provider media address')
    return url


def thumbnail_https(provider, url):
    public_https(url)
    host = urllib.parse.urlsplit(url).hostname
    allowed = ('rutube.ru', 'rtbcdn.ru', 'rutubelist.ru') if provider == 'rutube' else (
        'vk.ru', 'vk.com', 'vkvideo.ru', 'vkvideo.com', 'userapi.com', 'vkuserphoto.ru',
        'vkuserphoto.com', 'mycdn.me', 'okcdn.ru', 'vkuservideo.net', 'vkuseraudio.net')
    if not any(host == suffix or host.endswith('.' + suffix) for suffix in allowed):
        raise ValueError('thumbnail is outside the provider CDN')
    return url


class ThumbnailRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, provider):
        super().__init__()
        self.provider = provider

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        thumbnail_https(self.provider, newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def safe_error(error):
    code = str(getattr(error, 'code', 'provider_error'))
    # Provider errors have intentionally safe messages; arbitrary extractor exceptions may
    # contain signed URLs, token values or remote bodies and are not repeated to the app.
    message = getattr(error, 'message', None)
    if message is None and error.__class__.__module__ == 'rutube':
        message = str(error)
    return {'code': code[:80], 'message': str(message or 'Сервис не ответил. Повторите запрос.')[:500]}


def playback_job(provider, card, height, ca_file):
    result = {key: card.get(key) for key in ('id', 'title', 'channel', 'duration_s', 'thumbnail')}
    result.update(provider=provider, created_at=time.time(), ca_file=ca_file)
    if provider == 'vk':
        formats = [f for f in card.get('formats', []) if f.get('url') and
                   f.get('ext') == 'mp4' and f.get('acodec') != 'none' and
                   f.get('vcodec') != 'none' and (f.get('height') or 0) <= 1080]
        for candidate in formats:
            public_https(candidate['url'])
        compatible = [f for f in formats if (f.get('height') or 0) <= height]
        if not compatible:
            raise ValueError('no compatible MP4 format at this quality')
        chosen = max(compatible, key=lambda f: (f.get('height') or 0, f.get('tbr') or 0))
        # Keep every checked source in this private job. The media fetcher can then
        # honor a later 360/480/720 quality selection without reusing the initial source.
        result.update(url=chosen['url'], format=chosen, formats=formats,
                      http_headers=chosen.get('http_headers') or card.get('http_headers') or {})
    else:
        stream = card.get('playback') or {}
        result.update(url=public_https(stream.get('url') or ''),
                      http_headers=stream.get('headers') or {})
    return result


def perform(request):
    if not isinstance(request, dict):
        raise ValueError('request must be an object')
    provider_id = request.get('provider')
    if provider_id not in ('vk', 'rutube'):
        raise ValueError('unknown provider')
    config = dict(request.get('config') or {})
    operation = request.get('op')
    args = dict(request.get('args') or {})
    private = request.get('private') or {}
    if config.get('ca_bundle'):
        ca_file = Path(config['ca_bundle'])
        if not ca_file.is_file():
            raise ValueError('trusted CA bundle is missing')
        # The shipped yt-dlp does not consume a `ca_certs` option. load_ytdlp injects
        # certifi.where() using this checked CA before importing yt-dlp in this process.
        ytfetch.CA = str(ca_file)
    ytfetch.install_dns(config.get('lease_file') or ytfetch.LEASE)
    module = importlib.import_module(provider_id)
    if provider_id == 'vk':
        yt = ytfetch.load_ytdlp(config.get('pyz'), config.get('cache_dir') or '/tmp')
        provider = module.Provider(yt_dlp=yt, config=config)
    else:
        transport = module.DirectTransport(ca_bundle=config.get('ca_bundle'))
        provider = module.Provider(transport=transport)
    try:
        auth_public = None
        if operation in ('search', 'feed', 'resolve') and private:
            # Persist refreshed tokens alongside an ordinary result. The root bridge writes
            # this private member only if its authorization generation is still current.
            auth_result = provider.auth_poll(private) if provider_id == 'vk' else provider.auth_status(private)
            private = auth_result.get('private') or {}
            auth_public = auth_result.get('public') or {}

        def content():
            if operation == 'search':
                return provider.search(str(args.get('q') or '')[:200], auth=private)
            if operation == 'feed':
                which = str(args.get('which') or 'home')
                if which == 'home':
                    return provider.home(auth=private)
                if hasattr(provider, 'feed'):
                    return provider.feed(which, auth=private)
                return {'items': [], 'error': 'Этот личный раздел пока не поддерживается сервисом.'}
            card = provider.resolve(str(args.get('id') or ''), auth=private)
            return playback_job(provider_id, card, min(1080, max(144, int(args.get('height') or 720))), config.get('ca_bundle'))

        if operation in ('search', 'feed', 'resolve'):
            try:
                result = content()
            except Exception as error:
                # A token may have been revoked before its local expiry. Retry at most once
                # after the first-party refresh/profile flow; never report an empty success.
                if provider_id != 'rutube' or getattr(error, 'code', None) != 'auth_required' or not private.get('tokens'):
                    raise
                refreshed = provider.auth_refresh(private)
                private = refreshed.get('private') or {}
                auth_public = refreshed.get('public') or {}
                if auth_public.get('state') != 'signed_in':
                    return {'error': {'code': 'auth_required', 'message': auth_public.get('msg') or 'Войдите в аккаунт RUTUBE.'},
                            'private': private, 'auth': auth_public}
                result = content()
            return {'result': result, 'private': private, 'auth': auth_public}
        if operation == 'thumb':
            url = thumbnail_https(provider_id, str(args.get('url') or ''))
            ctx = ssl.create_default_context(cafile=config.get('ca_bundle'))
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                urllib.request.HTTPSHandler(context=ctx), ThumbnailRedirect(provider_id))
            req = urllib.request.Request(url, headers={'User-Agent': module.USER_AGENT if hasattr(module, 'USER_AGENT') else 'Mozilla/5.0'})
            with opener.open(req, timeout=10) as response:
                data = response.read(2 * 1024 * 1024 + 1)
            if len(data) > 2 * 1024 * 1024:
                raise ValueError('thumbnail is too large')
            return {'result': {'jpeg': base64.b64encode(data).decode('ascii')}}
        if operation == 'auth_begin':
            return provider.auth_begin(private_auth=private) if provider_id == 'vk' else provider.auth_begin(auth=private)
        if operation == 'auth_poll':
            return provider.auth_poll(private)
        if operation == 'auth_status':
            return provider.auth_poll(private) if provider_id == 'vk' else provider.auth_status(private, verify=True)
        if operation == 'sign_out':
            return provider.sign_out(private)
        if operation == 'auth_complete' and provider_id == 'vk':
            return provider.auth_complete(callback_url=args.get('callback_url'), code=args.get('code'),
                                          device_id=args.get('device_id'), state=args.get('state'), private_auth=private)
        raise ValueError('unknown provider operation')
    except Exception as error:
        result = {'error': safe_error(error), 'private': private}
        if provider_id == 'vk' and isinstance(getattr(error, 'auth', None), dict):
            auth_public = error.auth
        # Account refresh/loss may have completed before the content operation
        # failed. Keep its public state paired with the private update so the
        # root bridge does not leave a stale signed_in screen after token removal.
        if isinstance(auth_public, dict):
            result['auth'] = auth_public
        return result


def main():
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('provider request too large')
        request = json.loads(raw)
        for key in list(os.environ):
            if key.lower() in ('http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy'):
                del os.environ[key]
        os.environ['NO_PROXY'] = '*'
        result = perform(request)
    except Exception as error:
        result = {'error': safe_error(error)}
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
    sys.stdout.flush()


if __name__ == '__main__':
    main()
