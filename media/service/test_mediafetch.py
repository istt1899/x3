import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
import types
import unittest
from unittest import mock

import mediafetch


class MediaFetchTest(unittest.TestCase):
    def test_direct_policy_ignores_inherited_proxy(self):
        with mock.patch.dict(os.environ, {'HTTP_PROXY': 'http://secret@example.invalid',
                                         'https_proxy': 'socks5://example.invalid'}):
            env = mediafetch.direct_env()
            self.assertNotIn('HTTP_PROXY', env)
            self.assertNotIn('https_proxy', env)
            self.assertEqual(env['NO_PROXY'], '*')
        args = types.SimpleNamespace(height=720, cache_dir='cache', node='node', ca_file=None)
        self.assertEqual(mediafetch.params(args, {})['proxy'], '')

    def test_job_validation_rejects_cross_provider_and_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            args = types.SimpleNamespace(provider='vk', id='-123_456', job_dir=temporary)
            import time
            job = {'provider': 'rutube', 'id': args.id, 'created_at': time.time(),
                   'url': 'https://vkvideo.ru/video-123_456'}
            (path / (args.id + '.json')).write_text(json.dumps(job))
            with self.assertRaisesRegex(ValueError, 'another provider'):
                mediafetch.load_job(args)
            args.id = '../../account'
            with self.assertRaisesRegex(ValueError, 'invalid provider video ID'):
                mediafetch.load_job(args)

    def test_streams_contain_no_credentials_in_ffmpeg_arguments(self):
        cmd = mediafetch.ffmpeg_command('ffmpeg', Path('audio.src.m4a'))
        self.assertEqual(cmd[cmd.index('-i') + 1], 'pipe:0')
        self.assertNotIn('http', ' '.join(cmd))
        self.assertEqual(cmd.count('copy'), 2)

    def test_quality_change_selects_resolved_format_and_matching_agent(self):
        job = {'formats': [{'height': height, 'ext': 'mp4', 'url': f'https://cdn.example/{height}',
                            'http_headers': {'User-Agent': f'original-agent-{height}'}}
                           for height in [144, 360, 720]]}
        selected = mediafetch.select_format(job, 480)
        self.assertEqual(selected['format']['height'], 360)
        self.assertEqual(selected['http_headers']['User-Agent'], 'original-agent-360')
        self.assertEqual(mediafetch.select_format(job, 720)['format']['height'], 720)

    def test_hls_fragments_do_not_require_writable_service_working_directory(self):
        class Downloader:
            def __init__(self, params):
                self.params = params
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def extract_info(self, url, download):
                Path('--Frag1').write_bytes(b'private fragment')
                import sys
                sys.stdout.buffer.write(b'media')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / 'private-cache'
            cache.mkdir()
            caller = root / 'service-working-directory'
            caller.mkdir()
            before = os.getcwd()
            capture = io.TextIOWrapper(io.BytesIO(), encoding='utf-8')
            args = types.SimpleNamespace(cache_dir=str(cache), ca_file=None, pyz='yt.pyz', height=720, node='node')
            try:
                os.chdir(caller)
                with mock.patch.object(mediafetch.core, 'load_ytdlp', return_value=types.SimpleNamespace(YoutubeDL=Downloader)), \
                     mock.patch('sys.stdout', capture):
                    mediafetch.stream(args, {'url': 'https://provider.example/video'})
                self.assertFalse((caller / '--Frag1').exists())
                self.assertEqual(list(cache.iterdir()), [])
                self.assertEqual(os.getcwd(), str(caller))
            finally:
                os.chdir(before)

    def test_mp4_and_ts_normalize_to_real_audio_and_mgyi(self):
        binary = os.environ.get('MGU_TEST_FFMPEG') or shutil.which('ffmpeg')
        if not binary:
            self.skipTest('set MGU_TEST_FFMPEG to a host FFmpeg binary')
        for container in ['mp4', 'mpegts']:
            with self.subTest(container=container), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / 'source.bin'
                cmd = [binary, '-hide_banner', '-loglevel', 'error', '-y',
                       '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
                       '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
                       '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25',
                       '-c:a', 'aac', '-b:a', '64k']
                if container == 'mp4':
                    cmd += ['-movflags', '+faststart']
                subprocess.run(cmd + ['-f', container, str(source)], check=True, capture_output=True)
                out = root / 'output'
                args = types.SimpleNamespace(dir=str(out), id='-123_456', ffmpeg=binary)
                log = io.StringIO()
                stack = contextlib.ExitStack()
                with stack:
                    stack.enter_context(mock.patch.object(mediafetch, '_OUT', log))
                    if os.name == 'nt':
                        real_open = os.open
                        stack.enter_context(mock.patch.object(os, 'open',
                            lambda file, flags, *args, **kw: real_open(file, flags | os.O_BINARY, *args, **kw)))
                    if not hasattr(os, 'pwrite'):
                        lock = threading.Lock()
                        def pwrite(fd, data, offset):
                            with lock:
                                current = os.lseek(fd, 0, os.SEEK_CUR)
                                os.lseek(fd, offset, os.SEEK_SET)
                                written = os.write(fd, data)
                                os.lseek(fd, current, os.SEEK_SET)
                                return written
                        stack.enter_context(mock.patch.object(os, 'pwrite', pwrite, create=True))
                    with source.open('rb') as stream:
                        mediafetch.normalize(args, {'title': 'Fixture', 'duration_s': 2}, source=stream)
                events = [json.loads(line) for line in log.getvalue().splitlines()]
                self.assertIn('audio_ready', [event['ev'] for event in events])
                self.assertEqual(events[-1]['ev'], 'done')
                index = (out / 'index.bin').read_bytes()
                self.assertEqual(index[:4], b'MGYI')
                self.assertGreater(struct.unpack_from('<I', index, 16)[0], 20)
                self.assertGreater((out / 'video.h264').stat().st_size, 1000)
                # Decode the actual resulting audio and video, not just file names.
                for media in [out / 'audio.m4a', out / 'video.h264']:
                    result = subprocess.run([binary, '-v', 'error', '-i', str(media), '-f', 'null', '-'],
                                            capture_output=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
                    self.assertEqual(result.stderr, b'')


if __name__ == '__main__':
    unittest.main()
