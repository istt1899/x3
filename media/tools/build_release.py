#!/usr/bin/env python3
"""Build candidate archives/catalogs. This script never publishes or overwrites another app."""
import argparse
import copy
import gzip
import hashlib
import io
import importlib.util
import json
from pathlib import Path
import re
import shutil
import tarfile

ROOT = Path(__file__).resolve().parents[2]
MEDIA = ROOT / 'media'
OUT = MEDIA / 'dist/release'
VERSION = '0.4.5'
YOUTUBE_VERSION = '0.3.16'
RELEASE_TAG = 'media-preview-0.4.5-r4'
BASE_SHA = '984429e16be494d8e17e53f2606c7aaf38ea5ea049e86046f4aafe8cebf7bb75'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pack(entries):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as out:
        for name, (data, mode) in sorted(entries.items()):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = mode
            info.uid = info.gid = info.mtime = 0
            out.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), mtime=0)


def service(base, ffmpeg, source_bundle):
    data = base.read_bytes()
    if sha(data) != BASE_SHA:
        raise ValueError('unverified 0.3.13 source artifact')
    binaries = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as old:
        for name in ['ytdec', 'ytdlp.pyz']:
            binaries['core/native/jap-ridetube-d/' + name] = old.extractfile('files/' + name).read()
    files = {}
    core = MEDIA / 'core/native/jap-ridetube-d'
    for file in [core / n for n in ['ytd.js', 'proxy.js', 'thumb.js', 'ytfetch.py', 'network_native.js', 'network_native.py', 'vendor/jpeg-js/decoder.js', 'vendor/jpeg-js/LICENSE']]:
        files['core/native/jap-ridetube-d/' + file.relative_to(core).as_posix()] = (file.read_bytes(), 0o644)
    for directory in ['service', 'providers']:
        for file in (MEDIA / directory).glob('*'):
            if file.is_file() and file.suffix in ('.py', '.js', '.sh') and not file.name.startswith('test_'):
                files[directory + '/' + file.name] = (file.read_bytes(), 0o755 if file.suffix == '.sh' else 0o644)
    for file in (MEDIA / 'runtime').iterdir():
        if file.is_file() and (file.suffix in ('.pem', '.json', '.txt') or file.name.startswith(('LICENSE', 'NOTICE'))):
            files['runtime/' + file.name] = (file.read_bytes(), 0o644)
    files['runtime/test_ffmpeg.py'] = ((MEDIA / 'runtime/test_ffmpeg.py').read_bytes(), 0o644)
    files['runtime/test_cluster_socket.js'] = ((MEDIA / 'service/test_cluster_socket.js').read_bytes(), 0o644)
    for fixture in (MEDIA / 'runtime/test-fixtures').iterdir():
        if fixture.is_file() and fixture.name in ('sample.mp4', 'sample.ts'):
            files['runtime/test-fixtures/' + fixture.name] = (fixture.read_bytes(), 0o644)
    if not ffmpeg or not ffmpeg.is_file():
        raise ValueError('a verified compatible FFmpeg runtime is required to build the candidate')
    binary = ffmpeg.read_bytes()
    if binary[:4] != b'\x7fELF' or binary[4:6] != b'\x02\x01' or int.from_bytes(binary[18:20], 'little') != 62:
        raise ValueError('FFmpeg must be a Linux x86-64 ELF, not the Windows host binary')
    provenance = json.loads((MEDIA / 'runtime/ffmpeg-sources.json').read_text(encoding='utf-8'))
    expected = provenance.get('binary_sha256') or provenance.get('sha256')
    if not expected or sha(binary) != expected:
        raise ValueError('FFmpeg binary does not match its verified build provenance')
    spec = importlib.util.spec_from_file_location('mgu_ffmpeg_verify', MEDIA / 'runtime/verify_ffmpeg.py')
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    verifier.verify(ffmpeg, MEDIA / 'runtime/ffmpeg-sources.json')
    source = provenance['source_bundle']
    if (not source_bundle.is_file() or source_bundle.stat().st_size != source['size']
            or sha(source_bundle.read_bytes()) != source['sha256']):
        raise ValueError('corresponding FFmpeg source bundle does not match its build provenance')
    files['runtime/ffmpeg'] = (binary, 0o755)
    for name, data in binaries.items():
        files[name] = (data, 0o755 if name.endswith('/ytdec') else 0o644)
    for name in ['LICENSE', 'THIRD_PARTY_LICENSES']:
        files[name] = ((MEDIA / 'core' / name).read_bytes(), 0o644)
    manifest = json.loads((core / 'component.json').read_text(encoding='utf-8'))
    manifest.update(version=VERSION, title='MGU Video service',
                    description='Shared playback owner for RideTube, VK Video and RUTUBE; isolated accounts and routing.')
    manifest['requires']['mgu-deploy'] = '0.7.11'
    manifest['files'] = [{'path': name, 'mode': f'{mode:04o}', 'sha256': sha(data)} for name, (data, mode) in sorted(files.items())]
    manifest['check'] = ['service/check.sh']
    manifest['units'] = [{'name': 'jap-ridetube-d.service'}]
    manifest.pop('license', None)
    manifest.pop('uninstallable', None)
    manifest.pop('requires', None)
    entries = {'files/' + name: value for name, value in files.items()}
    entries['units/jap-ridetube-d.service'] = ((MEDIA / 'service/jap-ridetube-d.service').read_bytes(), 0o644)
    entries['component.json'] = ((json.dumps(manifest, indent=2) + '\n').encode(), 0o644)
    target = OUT / f'jap-ridetube-d@{VERSION}.tgz'
    target.write_bytes(pack(entries))
    return target


def artifact(file):
    return {'name': file.name, 'size': file.stat().st_size, 'sha256': sha(file.read_bytes()),
            'url': 'https://github.com/istt1899/x3/releases/download/' + RELEASE_TAG + '/' + file.name}


def main():
    global RELEASE_TAG
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-service', type=Path, required=True)
    parser.add_argument('--ffmpeg', type=Path, required=True)
    parser.add_argument('--source-bundle', type=Path, required=True)
    parser.add_argument('--release-tag', default=RELEASE_TAG)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', args.release_tag):
        raise ValueError('release tag must be a simple immutable tag name')
    RELEASE_TAG = args.release_tag
    OUT.mkdir(parents=True, exist_ok=True)
    tool = service(args.base_service, args.ffmpeg, args.source_bundle)
    # This exact source bundle accompanies every binary review release. Its
    # permanent /catalog/ URL in runtime provenance is published as well, without
    # replacing the stable Store catalog or its component artifacts.
    source_name = json.loads((MEDIA / 'runtime/ffmpeg-sources.json').read_text(encoding='utf-8'))['source_bundle']['name']
    if args.source_bundle.resolve() != (OUT / source_name).resolve():
        shutil.copyfile(args.source_bundle, OUT / source_name)
    catalog = json.loads((ROOT / 'catalog.json').read_text(encoding='utf-8'))
    # Preserve every pre-existing component; fail instead of silently replacing coding.
    components = {component['id']: component for component in catalog['components']}
    assert 'marku_x3_coding' in components
    youtube = components['jap_ridetube']
    youtube = copy.deepcopy(youtube)
    youtube_file = OUT / f'jap_ridetube@{YOUTUBE_VERSION}.tgz'
    shutil.copyfile(MEDIA / 'core/dist' / youtube_file.name, youtube_file)
    youtube['version'] = YOUTUBE_VERSION
    youtube['artifact'] = artifact(youtube_file)
    youtube['requires']['jap-ridetube-d'] = VERSION
    youtube['requires']['mgu-deploy'] = '0.7.11'
    components['jap_ridetube'] = youtube
    for app in ['marku_vk_video', 'marku_rutube']:
        spec = json.loads((MEDIA / 'core/apps' / app / 'app.json').read_text(encoding='utf-8'))
        source = MEDIA / 'core/dist' / f"{app}@{spec['version']}.tgz"
        target = OUT / source.name
        shutil.copyfile(source, target)
        with tarfile.open(target) as archive:
            assert not any('node_modules/oap-sdk' in n for n in archive.getnames())
        components[app] = {'id': app, 'kind': 'app', 'title': spec['title'], 'version': spec['version'],
                           'description': spec['description'], 'artifact': artifact(target),
                           'requires': {'jap-ridetube-d': VERSION, 'mgu-deploy': '0.7.11',
                                        'mgu-render': '0.6.11', 'mgu-inputgate': '1.0.0'},
                           'mguHmi': ['ID7'], 'uninstallable': True}
        icon = OUT / (app + '@' + spec['version'] + '.png')
        shutil.copyfile(MEDIA / 'core/apps' / app / 'icon.png', icon)
        components[app]['icon'] = artifact(icon)['url']
        components[app]['iconSha256'] = sha(icon.read_bytes())
    requires = json.loads((MEDIA / 'core/native/jap-ridetube-d/component.json').read_text(encoding='utf-8'))['requires']
    components['jap-ridetube-d'] = {'id': 'jap-ridetube-d', 'kind': 'tool', 'title': 'MGU Video service',
                                  'version': VERSION, 'description': 'Тестовый общий проигрыватель: YouTube через прежний прокси, VK Видео и RUTUBE напрямую. Раздельные аккаунты.',
                                  'requires': dict(requires, **{'mgu-deploy': '0.7.11', 'cluster-render': '0.4.0'}),
                                  'artifact': artifact(tool), 'uninstallable': True, 'mguHmi': ['ID7']}
    runtime = json.loads((MEDIA / 'core/tools/runtime-providers.json').read_text(encoding='utf-8'))
    for provider in runtime:
        components.setdefault(provider['id'], provider)
    result = {'schema': 2, 'components': list(components.values())}
    (OUT / 'catalog.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
    # Explicit candidate destination: no mutation of the stable root catalog here.
    for file in sorted(OUT.iterdir()):
        print(file.name, file.stat().st_size, sha(file.read_bytes()))


if __name__ == '__main__':
    main()
