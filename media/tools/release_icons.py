#!/usr/bin/env python3
"""Prepare the two icon-only 0.1.3 Store updates, preserving all other entries.

Run build_apps.py first. This prepares files locally; it does not publish.
"""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import struct

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'media/dist/icons-0.1.3'
VERSION = '0.1.3'
APPS = ('marku_vk_video', 'marku_rutube')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    original = json.loads((ROOT / 'catalog.json').read_text(encoding='utf-8'))
    catalog = copy.deepcopy(original)
    for item in catalog['components']:
        app = item['id']
        if app not in APPS:
            continue
        source = ROOT / 'media/core/dist' / f'{app}@{VERSION}.tgz'
        target = OUT / source.name
        shutil.copyfile(source, target)
        icon = OUT / f'{app}@{VERSION}.png'
        shutil.copyfile(ROOT / 'media/core/apps' / app / 'icon.png', icon)
        data = icon.read_bytes()
        assert struct.unpack('>IIBB', data[16:26]) == (140, 140, 8, 6)
        item['version'] = VERSION
        item['artifact'] = {'name': target.name, 'size': target.stat().st_size,
            'sha256': sha(target.read_bytes()),
            'url': 'https://github.com/istt1899/x3/releases/download/catalog/' + target.name}
        item['icon'] = 'https://github.com/istt1899/x3/releases/download/catalog/' + icon.name
        item['iconSha256'] = sha(data)
    assert sum(c['id'] in APPS for c in catalog['components']) == 2
    assert [c for c in original['components'] if c['id'] not in APPS] == [c for c in catalog['components'] if c['id'] not in APPS]
    (OUT / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    for file in sorted(OUT.iterdir()):
        print(file.name, file.stat().st_size, sha(file.read_bytes()))


if __name__ == '__main__':
    main()
