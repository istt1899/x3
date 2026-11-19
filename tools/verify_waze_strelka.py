#!/usr/bin/env python3
"""Check the imported Waze release and its anonymous shared-Store delivery."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
WAZE = ROOT / 'waze-strelka'
OWN = {'marku_kaluga_cameras', 'marku-kaluga-cameras'}
REQUIRED = OWN | {'waze-on-cluster', 'cluster-render'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def download(url, limit, timeout=30):
    require(url.startswith('https://'), 'HTTPS required')
    # Match sources.js/raw() in the actual MGU Updater. A request without its
    # Accept header can hit a different, stale cached catalog representation.
    request = urllib.request.Request(url, headers={'User-Agent': 'mgu-updater/0.8.18',
                                                 'Accept': 'application/octet-stream'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = response.read(limit + 1)
    require(len(data) <= limit, 'Download exceeds size bound')
    return data


def check_public_catalogs(expected):
    pending = [
        'https://github.com/istt1899/x3/releases/download/catalog/catalog.json',
        'https://raw.githubusercontent.com/istt1899/x3/main/catalog.json',
    ]
    # The same anonymous URLs can briefly serve pre-publication bytes or a 404.
    # Keep this window within the five-minute job, including artifact checks.
    deadline = time.monotonic() + 180
    while pending:
        for url in pending.copy():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                if download(url, 256 * 1024, timeout=min(15, remaining)) == expected:
                    pending.remove(url)
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
        if not pending:
            return
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'Public catalog differs after retries: ' + ', '.join(pending))
        time.sleep(min(15, remaining))


def check_artifact(item):
    require(0 < item['size'] < 32 * 1024 * 1024, 'Invalid artifact size')
    data = download(item['url'], item['size'])
    require(len(data) == item['size'] and digest(data) == item['sha256'],
            'Public artifact differs: ' + item['name'])
    return item['name']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--public', action='store_true')
    args = parser.parse_args()
    raw = (ROOT / 'catalog.json').read_bytes()
    catalog = json.loads(raw)
    require(catalog['schema'] == 2, 'Invalid Store schema')
    entries = {item['id']: item for item in catalog['components']}
    require(len(entries) == len(catalog['components']), 'Duplicate component identity')
    require(REQUIRED <= entries.keys(), 'Missing Waze component or dependency')
    source = {item['id']: item for item in json.loads((WAZE / 'catalog.json').read_bytes())['components']}
    origin = json.loads((WAZE / 'IMPORT.json').read_bytes())
    for item in origin['packages']:
        data = (WAZE / 'packages' / item['name']).read_bytes()
        require(len(data) == item['size'] and digest(data) == item['sha256'],
                'Imported package differs: ' + item['name'])
    for component_id in REQUIRED:
        current, previous = entries[component_id], source[component_id]
        require(current['version'] == previous['version'], 'Imported version changed')
        require(current.get('requires') == previous.get('requires'), 'Imported dependencies changed')
        require(current['artifact']['sha256'] == previous['artifact']['sha256'], 'Imported digest changed')
        require(current['artifact']['size'] == previous['artifact']['size'], 'Imported size changed')
        if component_id in OWN:
            require(current['artifact']['url'].startswith('https://raw.githubusercontent.com/istt1899/x3/'),
                    'Waze must download from the shared repository')
            built = WAZE / 'dist/publish/kaluga-cameras' / current['artifact']['name']
            if built.exists():
                require(digest(built.read_bytes()) == current['artifact']['sha256'], 'Rebuilt package differs')
    evidence = json.loads((ROOT / 'media/RELEASE-EVIDENCE.json').read_bytes())
    require(evidence['store_catalogs']['istt1899/x3']['sha256'] == digest(raw), 'Shared catalog evidence is stale')
    checked = []
    if args.public:
        check_public_catalogs(raw)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            checked = list(pool.map(check_artifact, [entries[key]['artifact'] for key in sorted(REQUIRED)]))
        app = entries['marku_kaluga_cameras']
        icon = download(app['icon'], 128 * 1024)
        require(icon.startswith(b'\x89PNG\r\n\x1a\n') and digest(icon) == app['iconSha256'], 'Public icon differs')
    print(json.dumps({'result': 'pass', 'components': {key: entries[key]['version'] for key in sorted(REQUIRED)},
                      'catalogSha256': digest(raw), 'anonymousPublicArtifacts': checked}, indent=2))


if __name__ == '__main__':
    main()
