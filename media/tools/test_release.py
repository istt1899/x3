#!/usr/bin/env python3
"""Check the actual candidate packages, without network, SDK or car access."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile

MEDIA = Path(__file__).resolve().parents[1]
ROOT = MEDIA.parent
OUT = MEDIA / 'dist/release'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_members(archive):
    members = archive.getmembers()
    for member in members:
        parts = PurePosixPath(member.name)
        assert not parts.is_absolute() and '..' not in parts.parts
        assert not member.issym() and not member.islnk()
        assert 'oap-sdk' not in parts.parts
        assert not any(p in ('private', '__pycache__') for p in parts.parts)
    return members


catalog = json.loads((OUT / 'catalog.json').read_text(encoding='utf-8'))
assert catalog['schema'] == 2
components = {c['id']: c for c in catalog['components']}
assert len(components) == len(catalog['components'])
coding = json.loads((ROOT / 'mgu-coder/dist/publish/x3-coding/catalog.github.json').read_text(encoding='utf-8'))
for original in coding['components']:
    assert components[original['id']] == original, 'existing coding component changed'
youtube = json.loads((MEDIA / 'core/catalog.json').read_text(encoding='utf-8'))
original_app = next(c for c in youtube['components'] if c['id'] == 'jap_ridetube')
assert components['jap_ridetube'] == original_app, 'stable YouTube app changed'
assert components['jap_ridetube']['version'] == '0.3.13'

for app in ('marku_vk_video', 'marku_rutube', 'jap-ridetube-d'):
    spec = components[app]
    artifact = spec['artifact']
    package = OUT / artifact['name']
    data = package.read_bytes()
    assert len(data) == artifact['size'] and digest(data) == artifact['sha256']
    assert artifact['url'].endswith('/' + package.name)
    assert '/catalog/' in artifact['url'], 'installable Store packages must use the catalog release'
    assert spec['requires']['mgu-deploy'] == '0.7.11'
    with tarfile.open(package) as archive:
        safe_members(archive)

with tarfile.open(OUT / components['jap-ridetube-d']['artifact']['name']) as archive:
    manifest = json.load(archive.extractfile('component.json'))
    assert manifest['id'] == 'jap-ridetube-d' and manifest['version'] == '0.4.1'
    assert manifest['internet'] is True and manifest['uids'] == 'state/internet-uids'
    assert manifest['units'] == [{'name': 'jap-ridetube-d.service'}]
    assert manifest['check'] == ['service/check.sh']
    unit = archive.extractfile('units/jap-ridetube-d.service').read().decode()
    assert '/current/service/main.js' in unit and 'Restart=on-failure' in unit
    expected = {'component.json', 'units/jap-ridetube-d.service'}
    for item in manifest['files']:
        assert 'from' not in item
        assert 'test_' not in item['path'] or item['path'] == 'runtime/test_ffmpeg.py'
        name = 'files/' + item['path']
        expected.add(name)
        member = archive.getmember(name)
        assert member.mode == int(item['mode'], 8)
        contents = archive.extractfile(member).read()
        assert digest(contents) == item['sha256']
        current = MEDIA / item['path']
        if item['path'] in ('LICENSE', 'THIRD_PARTY_LICENSES'):
            current = MEDIA / 'core' / item['path']
        if current.is_file():
            assert contents == current.read_bytes(), 'stale service build: ' + item['path']
        else:
            assert item['path'] in ('core/native/jap-ridetube-d/ytdec', 'core/native/jap-ridetube-d/ytdlp.pyz')
    assert set(archive.getnames()) == expected
    for name in ('LICENSE', 'THIRD_PARTY_LICENSES', 'runtime/LICENSE.ffmpeg', 'runtime/LICENSE.musl',
                 'runtime/NOTICE.ffmpeg', 'runtime/LICENSE.certifi', 'runtime/test-fixtures/sample.mp4',
                 'runtime/test-fixtures/sample.ts'):
        assert 'files/' + name in expected
    assert digest(archive.extractfile('files/core/native/jap-ridetube-d/ytdec').read()) == '15a9c75d2a19e3cafda3f5a8d0f7eb706a12c90ca90f5b60f1253d25749dd2eb'
    assert digest(archive.extractfile('files/core/native/jap-ridetube-d/ytdlp.pyz').read()) == '0175a4c99d1e7e92ae6e6515a3097fbdf1f70626c1f0cd8559d2f81137fd46f9'
    check = archive.extractfile('files/service/check.sh').read()
    assert b'\r' not in check and b'runtime/test_ffmpeg.py' in check
    provenance = json.load(archive.extractfile('files/runtime/ffmpeg-sources.json'))
    assert digest(archive.extractfile('files/runtime/ffmpeg').read()) == provenance['binary_sha256']
    assert provenance['mgu_runtime_tested'] is False, 'target verification must not be invented'
    source = provenance['source_bundle']
    source_file = OUT / source['name']
    assert source_file.stat().st_size == source['size'] and digest(source_file.read_bytes()) == source['sha256']
    assert source['url'] == 'https://github.com/istt1899/x3/releases/download/catalog/' + source_file.name
    ca = json.load(archive.extractfile('files/runtime/cacert-sources.json'))
    assert digest(archive.extractfile('files/runtime/cacert.pem').read()) == ca['sha256']

uuids = []
for app, provider in [('marku_vk_video', 'vk'), ('marku_rutube', 'rutube')]:
    spec = components[app]
    assert spec['requires']['jap-ridetube-d'] == '0.4.1'
    with tarfile.open(OUT / spec['artifact']['name']) as archive:
        app_json = json.load(archive.extractfile('package/rhmiData/application.json'))['application']
        assert app_json['name'] == app and app_json['version'] == '0.1.1'
        uuids.append(app_json['uuid'])
        settings = archive.extractfile('package/javascript/service-config.js').read().decode()
        assert '/run/jap-ridetube-d/' + provider + '.sock' in settings
        main = archive.extractfile('package/javascript/app.js').read().decode()
        for shipped, source in [('app.js', 'main.js'), ('yt.js', 'model.js'), ('account-view.js', 'account-view.js')]:
            assert archive.extractfile('package/javascript/' + shipped).read() == (MEDIA / 'ui' / source).read_bytes(), 'stale app build: ' + shipped
        assert archive.extractfile('package/javascript/service-config.js').read() == (MEDIA / 'core/apps' / app / 'service-config.js').read_bytes()
        assert 'Parked.watch(ctx, log, { strict: true })' in main
        assert 'const noVideo = () => parked.moving();' in main
        assert 'google.com/device' not in main
    icon = OUT / (app + '@' + spec['version'] + '.png')
    assert digest(icon.read_bytes()) == spec['iconSha256']
assert len(set(uuids)) == 2
print('ok: coding/YouTube preserved; archives, manifest, runtime pins, source-only SDK exclusion, separate apps and parked video')
