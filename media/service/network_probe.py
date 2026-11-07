#!/usr/bin/env python3
"""Bounded HTTPS download comparison; no upload, tokens, or remote response bodies in UI."""
import json
from pathlib import Path
import ssl
import sys
import time
import urllib.error
import urllib.request

CORE = Path(__file__).resolve().parents[1] / 'core/native/jap-ridetube-d'
sys.path.insert(0, str(CORE))
import ytfetch

LIMIT = 4 * 1024 * 1024
TARGETS = {'youtube': 'https://www.youtube.com/tv', 'vk': 'https://vkvideo.ru/', 'rutube': 'https://rutube.ru/'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def perform(config, now=time.monotonic):
    provider = config.get('provider')
    if provider not in TARGETS or config.get('source') not in ('external', 'builtin'):
        raise ValueError('invalid test')
    servers = ytfetch.lease_servers(config['leaseFile'])
    if not servers:
        return {'ok': False, 'message': 'Нет DNS выбранного канала. Проверьте подключение в MGU Store'}
    ytfetch.install_dns(config['leaseFile'])
    ytfetch.CA = config['caFile']
    context = ssl.create_default_context(cafile=config['caFile'])
    direct = urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=context), NoRedirect())
    start = now()
    request = urllib.request.Request('https://speed.cloudflare.com/__down?bytes=' + str(LIMIT if config.get('speed') else 1024),
        headers={'User-Agent': 'MGU-Video-Network-Test/1', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache'})
    result = {'ok': False, 'bytes': 0, 'serviceAvailable': False, 'provider': provider, 'speedTested': bool(config.get('speed'))}
    try:
        with direct.open(request, timeout=8) as response:
            if response.status != 200:
                raise OSError('test endpoint unavailable')
            first = now()
            result['latencyMs'] = round((first - start) * 1000)
            body_start = first
            while result['bytes'] < (LIMIT if config.get('speed') else 1024):
                chunk = response.read(min(65536, (LIMIT if config.get('speed') else 1024) - result['bytes']))
                if not chunk:
                    break
                result['bytes'] += len(chunk)
                if now() - body_start >= 10:
                    break
            duration = max(0.001, now() - body_start)
            result['downloadMbps'] = round(result['bytes'] * 8 / duration / 1000000, 2) if config.get('speed') else None
            result['sampleSeconds'] = round(duration, 3)
            result['shortSample'] = duration < 0.25 or result['bytes'] < 262144
            result['ok'] = result['bytes'] > 0
    except Exception:
        result['message'] = 'Тестовый сервер недоступен через выбранный канал'
    # A fast test endpoint is not evidence that the actual video provider is reachable.
    # YouTube retains its existing proxy; the baseline download above is direct.
    try:
        proxy = ytfetch.parse_proxy(config.get('proxy')) if provider == 'youtube' and config.get('proxy') else None
        opener = ytfetch.url_opener(context, proxy) if proxy else direct
        with opener.open(urllib.request.Request(TARGETS[provider], headers={'User-Agent': 'Mozilla/5.0'}), timeout=6) as response:
            response.read(1024)
            result['serviceAvailable'] = 200 <= response.status < 400
    except urllib.error.HTTPError as error:
        result['serviceAvailable'] = 300 <= error.code < 400
    except Exception:
        pass
    if not result['serviceAvailable']:
        result['ok'] = False
        result['message'] = 'Видеосервис недоступен через выбранный канал'
    if not config.get('speed') and not result['ok'] and result['serviceAvailable']:
        # Selecting a channel only requires its video service, not the speed-test CDN.
        result['ok'] = True
    return result


def main():
    try:
        config = json.loads(sys.stdin.buffer.read(8193))
        result = perform(config)
    except Exception:
        result = {'ok': False, 'message': 'Не удалось проверить канал. Требуется диагностика MGU'}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
