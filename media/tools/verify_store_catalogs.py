#!/usr/bin/env python3
"""Verify the public Store catalogs and current media packages without credentials."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

MEDIA = Path(__file__).resolve().parents[1]
IDS = {'marku_vk_video', 'marku_rutube', 'jap_ridetube', 'jap-ridetube-d'}
VERSIONS = {'marku_vk_video': '0.1.5', 'marku_rutube': '0.1.5',
            'jap_ridetube': '0.3.16', 'jap-ridetube-d': '0.4.4'}


def download(url, limit):
    if not url.startswith('https://github.com/istt1899/'):
        raise ValueError('Unexpected published artifact URL')
    request = urllib.request.Request(url, headers={'User-Agent': 'MGU-public-catalog-verification'})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Download exceeds its size bound')
    return data


def check(item):
    if not 0 < item['size'] <= 64 * 1024 * 1024:
        raise ValueError('Unbounded artifact size')
    data = download(item['url'], item['size'])
    digest = hashlib.sha256(data).hexdigest()
    if len(data) != item['size'] or digest != item['sha256']:
        raise ValueError('Published artifact differs from catalog: ' + item['name'])
    print('verified ' + item['url'], file=sys.stderr, flush=True)
    return {'name': item['name'], 'url': item['url'], 'size': len(data), 'sha256': digest}


def main():
    expected = json.loads((MEDIA / 'RELEASE-EVIDENCE.json').read_text(encoding='utf-8'))['store_catalogs']
    catalogs, artifacts = {}, {}
    for repo, pin in expected.items():
        url = 'https://github.com/' + repo + '/releases/download/catalog/catalog.json'
        data = download(url, 256 * 1024)
        digest = hashlib.sha256(data).hexdigest()
        if digest != pin['sha256']:
            raise ValueError('Public catalog differs from release evidence: ' + repo)
        catalog = json.loads(data)
        found = {item['id']: item for item in catalog['components']}
        if len(found) != len(catalog['components']):
            raise ValueError('Duplicate component identity')
        required = IDS if repo.endswith('/x3') else {'jap_ridetube', 'jap-ridetube-d'}
        for component_id in required:
            item = found[component_id]
            if item['version'] != VERSIONS[component_id]:
                raise ValueError('Unexpected public component version: ' + component_id)
            artifacts[item['artifact']['url']] = item['artifact']
            if component_id in {'marku_vk_video', 'marku_rutube'}:
                icon = download(item['icon'], 128 * 1024)
                if not icon.startswith(b'\x89PNG\r\n\x1a\n') or hashlib.sha256(icon).hexdigest() != item['iconSha256']:
                    raise ValueError('Published icon differs from catalog')
        catalogs[repo] = {'sha256': digest, 'versions': {key: value['version'] for key, value in found.items()}}
        print('verified ' + url, file=sys.stderr, flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        checked = list(pool.map(check, artifacts.values()))
    print(json.dumps({'anonymous_public_download': True, 'catalogs': catalogs, 'artifacts': checked}, indent=2))


if __name__ == '__main__':
    main()
