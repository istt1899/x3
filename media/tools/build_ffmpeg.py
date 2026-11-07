#!/usr/bin/env python3
"""Bootstrap and cross-build FFmpeg for the MGU, using hash-pinned portable tools.

Windows needs an existing Git Bash (as used by Git for Windows); no system tool is
installed. Linux uses bash/make from its build environment. The result is musl
static, so it does not require the MGU's glibc loader or glibc symbol versions.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / 'media/runtime'
VERSION = '9.0.2'
SOURCE_URL = f'https://ffmpeg.org/releases/ffmpeg-{VERSION}.tar.xz'
SOURCE_SHA = '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'
ZIG_VERSION = '0.14.1'
ZIG = {
    'windows': ('zig-x86_64-windows-0.14.1.zip', '554f5378228923ffd558eac35e21af020c73789d87afeabf4bfd16f2e6feed2c'),
    'linux': ('zig-x86_64-linux-0.14.1.tar.xz', '24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c'),
}
MAKE_NAME = 'make-4.4.1-3-x86_64.pkg.tar.zst'
MAKE_SHA = 'af0bdba17f06fe037f0194069adaa31a8fe45f1a11381501896aea1fae37bd5d'


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def download(file, urls, digest):
    if file.exists() and sha(file) == digest:
        return
    temporary = file.with_suffix(file.suffix + '.download')
    error = None
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'MGU-media-runtime-builder'})
            with urllib.request.urlopen(req, timeout=25) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output, 1024 * 1024)
            if sha(temporary) != digest:
                raise ValueError('download SHA-256 does not match the pinned producer digest')
            temporary.replace(file)
            return
        except Exception as exc:
            error = exc
    raise RuntimeError(f'cannot obtain verified {file.name}: {error}')


def extract(archive, directory):
    if archive.suffix == '.zip':
        with zipfile.ZipFile(archive) as package:
            for name in package.namelist():
                if not (directory / name).resolve().is_relative_to(directory.resolve()):
                    raise ValueError('archive path escapes tool directory')
            package.extractall(directory)
    else:
        with tarfile.open(archive) as package:
            package.extractall(directory, filter='data')


def verify_source(archive, source):
    # Streaming avoids repeated xz seeks while verifying thousands of source files.
    with tarfile.open(archive, 'r|xz') as package:
        for member in package:
            if not member.isfile():
                continue
            name = Path(*Path(member.name).parts[1:])
            file = source / name
            if not file.is_file() or file.read_bytes() != package.extractfile(member).read():
                raise ValueError('working source differs from pinned archive: ' + str(name))


def shell_path(file, windows):
    value = str(file.resolve()).replace('\\', '/')
    return '/' + value[0].lower() + value[2:] if windows and len(value) > 2 and value[1] == ':' else value


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--artifacts', type=Path, default=ROOT.parent / 'Media-artifacts')
    ap.add_argument('--bash', default=r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else 'bash')
    ap.add_argument('--jobs', type=int, default=4)
    ap.add_argument('--bootstrap-only', action='store_true')
    ap.add_argument('--collect', action='store_true', help='collect a completed build without reconfiguring')
    args = ap.parse_args()
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    windows = os.name == 'nt'
    platform = 'windows' if windows else 'linux'
    archive = artifacts / f'ffmpeg-{VERSION}.tar.xz'
    download(archive, [SOURCE_URL], SOURCE_SHA)
    print('Verified FFmpeg source archive', flush=True)
    source = artifacts / f'ffmpeg-{VERSION}'
    if not source.is_dir():
        extract(archive, artifacts)
    verify_source(archive, source)
    print('Verified extracted source tree', flush=True)
    zig_name, zig_sha = ZIG[platform]
    zig_archive = artifacts / zig_name
    # The community mirrors are listed by the producer. Only exact bytes matching
    # ziglang.org/download/index.json are accepted, regardless of download host.
    candidate = artifacts / 'zig-x86_64-windows-0.14.1.mirror.zip'
    if windows and candidate.is_file() and sha(candidate) == zig_sha:
        zig_archive = candidate
    else:
        download(zig_archive, [f'https://zig.squirl.dev/{zig_name}',
                              f'https://ziglang.org/download/{ZIG_VERSION}/{zig_name}'], zig_sha)
    zig_root = artifacts / zig_name.removesuffix('.zip').removesuffix('.tar.xz')
    if not (zig_root / ('zig.exe' if windows else 'zig')).is_file():
        extract(zig_archive, artifacts)
    make = 'make'
    if windows:
        make_archive = artifacts / MAKE_NAME
        download(make_archive, ['https://mirror.msys2.org/msys/x86_64/' + MAKE_NAME], MAKE_SHA)
        make_root = artifacts / 'make-msys'
        make_root.mkdir(exist_ok=True)
        make = make_root / 'usr/bin/make.exe'
        if not make.is_file():
            # Windows bsdtar supports zstd; no Python zstd module is needed.
            subprocess.run(['tar', '-xf', str(make_archive), '-C', str(make_root)], check=True)
    build = artifacts / 'ffmpeg-mgu-build'
    if not args.bootstrap_only and not args.collect:
        env = dict(os.environ, FFMPEG_SOURCE=shell_path(source, windows), FFMPEG_BUILD=shell_path(build, windows),
                   ZIG_ROOT=shell_path(zig_root, windows), MAKE_BIN=shell_path(make, windows) if isinstance(make, Path) else make,
                   JOBS=str(max(1, min(args.jobs, 16))))
        if windows:
            git_root = Path(args.bash).resolve().parent.parent
            env['PATH'] = os.pathsep.join([str(git_root / 'usr/bin'), str(git_root / 'mingw64/bin'), env.get('PATH', '')])
        script = ROOT / 'media/tools/build_ffmpeg.sh'
        subprocess.run([args.bash, shell_path(script, windows)], env=env, check=True)
    if args.bootstrap_only:
        print('Verified portable toolchain and corresponding FFmpeg source are ready')
        return
    sys.path.insert(0, str(RUNTIME))
    from verify_ffmpeg import verify
    print('Collecting completed static build', flush=True)
    result = verify(build / 'ffmpeg', config_dir=build)
    RUNTIME.mkdir(exist_ok=True)
    shutil.copyfile(build / 'ffmpeg', RUNTIME / 'ffmpeg')
    os.chmod(RUNTIME / 'ffmpeg', 0o755)
    licenses = {'LICENSE.ffmpeg': source / 'COPYING.LGPLv2.1',
                'NOTICE.ffmpeg': source / 'LICENSE.md',
                'LICENSE.musl': zig_root / 'lib/libc/musl/COPYRIGHT',
                'LICENSE.zig': zig_root / 'LICENSE'}
    for name, file in licenses.items():
        shutil.copyfile(file, RUNTIME / name)
    source_bundle = artifacts / f'ffmpeg-{VERSION}-mgu-media-sources.tar.xz'
    # Exact upstream source archive + exact scripts, configuration and licenses.
    # Keep this public next to the executable release; it is not installed on MGU.
    files = {archive.name: archive,
             'build/build_ffmpeg.py': Path(__file__),
             'build/build_ffmpeg.sh': ROOT / 'media/tools/build_ffmpeg.sh',
             'build/verify_ffmpeg.py': RUNTIME / 'verify_ffmpeg.py',
             'build/test_ffmpeg.py': RUNTIME / 'test_ffmpeg.py',
             'build/FFMPEG.md': RUNTIME / 'FFMPEG.md',
             'build/LICENSE.GPL-3.0-or-later': ROOT / 'media/core/LICENSE',
             'build/test-support/mediafetch.py': ROOT / 'media/service/mediafetch.py',
             'build/test-support/ytfetch.py': ROOT / 'media/core/native/jap-ridetube-d/ytfetch.py',
             'build/zig-cc': build / 'zig-cc',
             'build/zig-ar': build / 'zig-ar',
             'build/zig-host-cc': build / 'zig-host-cc',
             'build/config.h': build / 'config.h',
             'build/config_components.h': build / 'config_components.h',
             'build/config.mak': build / 'ffbuild/config.mak'}
    files.update({name: RUNTIME / name for name in licenses})
    for fixture in (RUNTIME / 'test-fixtures').glob('*'):
        if fixture.is_file():
            files['build/test-fixtures/' + fixture.name] = fixture
    with tarfile.open(source_bundle, 'w:xz', format=tarfile.USTAR_FORMAT) as package:
        for name in sorted(files):
            data = files[name].read_bytes()
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = 0o755 if name.endswith('.sh') else 0o644
            entry.mtime = 0
            package.addfile(entry, io.BytesIO(data))
    manifest = {'schema': 1, 'version': VERSION, 'target': 'x86_64-linux.3.2.0-musl',
                'license': 'LGPL-2.1-or-later', 'network_enabled': False,
                'cpu': 'baseline-x86_64', 'external_x86_asm_enabled': False,
                'binary_sha256': result['sha256'],
                'binary': {'name': 'ffmpeg', 'size': result['size'], 'sha256': result['sha256']},
                'source': {'url': SOURCE_URL, 'sha256': SOURCE_SHA},
                'source_bundle': {'name': source_bundle.name,
                                  'url': 'https://github.com/istt1899/x3/releases/download/catalog/' + source_bundle.name,
                                  'size': source_bundle.stat().st_size,
                                  'sha256': sha(source_bundle)},
                'toolchain': {'zig_version': ZIG_VERSION, 'zig_archive': zig_name, 'zig_sha256': zig_sha,
                              'zig_producer': 'https://ziglang.org/download/index.json',
                              'zig_source_url': 'https://ziglang.org/download/0.14.1/zig-0.14.1.tar.xz',
                              'zig_source_sha256': '237f8abcc8c3fd68c70c66cdbf63dce4fb5ad4a2e6225ac925e3d5b4c388f203',
                              'make_archive': MAKE_NAME if windows else 'build-environment GNU make',
                              'make_sha256': MAKE_SHA if windows else None},
                'elf': result, 'mgu_runtime_tested': False, 'linux_runtime_tested': False}
    (RUNTIME / 'ffmpeg-sources.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(manifest, indent=2))
    print('Publish corresponding source bundle:', source_bundle)


if __name__ == '__main__':
    main()
