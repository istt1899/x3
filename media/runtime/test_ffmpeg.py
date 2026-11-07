#!/usr/bin/env python3
"""Execute the offline MP4/MPEG-TS remux gate on Linux/MGU.

The fixtures are synthetic testsrc + 440 Hz sine, not downloaded media. No decoder
GPU, SOME/IP service, Internet or account is required. Run the production binary,
not a Windows substitute, before marking linux_runtime_tested/mgu_runtime_tested.
"""
import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'test-support' if (HERE / 'test-support').is_dir() else HERE.parent / 'service'))
import mediafetch


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--ffmpeg', default=str(HERE / 'ffmpeg'))
    ap.add_argument('--allow-host-substitute', action='store_true', help='test this harness only; not proof of the shipped ELF')
    args = ap.parse_args()
    binary = str(Path(args.ffmpeg).resolve())
    if os.name == 'nt' and args.allow_host_substitute:
        # Host harness only; production Linux uses atomic positional writes.
        def pwrite(fd, data, offset):
            previous = os.lseek(fd, 0, os.SEEK_CUR)
            try:
                os.lseek(fd, offset, os.SEEK_SET)
                return os.write(fd, data)
            finally:
                os.lseek(fd, previous, os.SEEK_SET)
        mediafetch.core.os.pwrite = pwrite
    version = subprocess.run([binary, '-hide_banner', '-version'], capture_output=True, text=True, check=True, timeout=10).stdout
    if not args.allow_host_substitute and '9.0.2-mgu-media-1' not in version:
        raise ValueError('not the pinned production FFmpeg version')
    protocols = subprocess.run([binary, '-hide_banner', '-protocols'], capture_output=True, text=True, check=True, timeout=10).stdout
    if not args.allow_host_substitute:
        lines = protocols.splitlines()
        names = [line.strip() for line in lines if line.startswith('  ') and line.strip()]
        if set(names) != {'file', 'pipe'}:
            raise ValueError('runtime must expose only file/pipe protocols: ' + repr(names))
    results = []
    for extension in ['mp4', 'ts']:
        with tempfile.TemporaryDirectory(prefix='mgu-remux-test-') as temporary:
            directory = Path(temporary)
            audio = directory / 'audio.src.m4a'
            process = subprocess.run(mediafetch.ffmpeg_command(binary, audio),
                input=(HERE / 'test-fixtures' / ('sample.' + extension)).read_bytes(),
                capture_output=True, timeout=15)
            if process.returncode:
                raise RuntimeError('remux failed: ' + process.stderr.decode(errors='replace')[:1000])
            frames, size, ms = mediafetch.core.demux_video(io.BytesIO(process.stdout), str(directory), 1, lambda *_: None)
            audio_size, audio_ms = mediafetch.core.flatten_m4a(str(audio), str(directory / 'audio.m4a'))
            if frames < 1 or size < 1 or audio_size < 1 or audio_ms < 500:
                raise ValueError('remux did not produce usable video and audio')
            results.append({'input': extension, 'frames': frames, 'annex_b_bytes': size,
                            'last_video_ms': ms, 'audio_bytes': audio_size, 'audio_ms': audio_ms})
    print(json.dumps({'production_binary': not args.allow_host_substitute, 'results': results}, indent=2))


if __name__ == '__main__':
    main()
