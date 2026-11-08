import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import zipfile
from unittest import mock

import mediafetch


class MediaFetchTest(unittest.TestCase):
    def fixture_stream(self, root, body, video_id='-123_456'):
        pyz = root / 'fixture-ytdlp.pyz'
        module = """import sys, types, time
extractor = types.SimpleNamespace()
class YoutubeDL:
    def __init__(self, params): self.params = params
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def process_ie_result(self, info, download):
""" + '\n'.join('        ' + line for line in body.splitlines()) + '\n'
        with zipfile.ZipFile(pyz, 'w') as archive:
            archive.writestr('yt_dlp/__init__.py', module)
        job = {'id': video_id, 'provider': 'vk', 'created_at': time.time(),
               'url': 'https://cdn.example/video?private=must-not-enter-argv',
               'format': {'url': 'https://cdn.example/video', 'ext': 'mp4'}}
        (root / (video_id + '.json')).write_text(json.dumps(job), encoding='utf-8')
        args = types.SimpleNamespace(provider='vk', id=video_id, job_dir=str(root),
            cache_dir=str(root), dir=str(root / 'output'), ffmpeg='unused-before-first-byte',
            height=360, node='node', lease=str(root / 'no-lease.json'), pyz=str(pyz), ca_file=None)
        return args, job

    def test_real_stream_subprocess_accepts_negative_vk_id(self):
        # Exercise argparse and the nested process, not a mocked Popen call.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for video_id in ('-123_456', '123_456'):
                args, _ = self.fixture_stream(root, "sys.stdout.buffer.write(b'MGU-fixture-stream')", video_id)
                cmd = mediafetch.stream_command(args)
                self.assertEqual(cmd[-2:], ['--', video_id])
                self.assertNotIn('https://', ' '.join(cmd))
                result = subprocess.run(cmd, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
                self.assertEqual(result.stdout, b'MGU-fixture-stream')

    def test_silent_real_downloader_is_killed_instead_of_waiting_forever(self):
        with tempfile.TemporaryDirectory() as temporary:
            args, job = self.fixture_stream(Path(temporary), 'time.sleep(60)')
            args.first_byte_timeout = 0.3
            started = time.monotonic()
            with mock.patch.object(mediafetch, '_OUT', io.StringIO()), self.assertRaisesRegex(ValueError, 'первые данные'):
                mediafetch.normalize(args, job)
            self.assertLess(time.monotonic() - started, 5)
            self.assertTrue(all(child.poll() is not None for child in mediafetch.CHILDREN))

    def test_real_downloader_http_failure_is_safe_and_actionable(self):
        with tempfile.TemporaryDirectory() as temporary:
            args, job = self.fixture_stream(Path(temporary),
                "raise RuntimeError('HTTP Error 403: https://cdn.example/?token=fixture-secret')")
            log = io.StringIO()
            with mock.patch.object(mediafetch, '_OUT', log), self.assertRaisesRegex(ValueError, 'HTTP 403') as result:
                mediafetch.normalize(args, job)
            self.assertNotIn('fixture-secret', str(result.exception) + log.getvalue())

    def test_stalled_transfer_kills_its_process_after_data_started(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        mediafetch.CHILDREN.append(child)
        with mock.patch.object(mediafetch, '_OUT', io.StringIO()), mediafetch.TransferWatch(first_timeout=2, idle_timeout=0.2) as watch:
            watch.received(4096)
            child.wait(timeout=5)
        self.assertIn('остановился', watch.error)

    def test_prefix_targets_grow_without_waiting_for_full_audio(self):
        self.assertEqual(mediafetch.head_target_ms(0, 120000), 8000)
        self.assertEqual(mediafetch.head_target_ms(8000, 120000), 16000)
        self.assertEqual(mediafetch.head_target_ms(16000, 120000), 32000)
        self.assertEqual(mediafetch.head_target_ms(8000, 10000), 10000)
        self.assertEqual(mediafetch.head_target_ms(12000, 10000), 24000)

    def test_mp4_index_placement_selects_stream_or_seekable_fallback(self):
        box = lambda name, data: struct.pack('>I4s', len(data) + 8, name) + data
        faststart = box(b'ftyp', b'isom') + box(b'moov', b'index') + box(b'mdat', b'media')
        late_index = box(b'ftyp', b'isom') + box(b'mdat', b'media') + box(b'moov', b'index')
        self.assertFalse(mediafetch.mp4_needs_seek(faststart))
        self.assertTrue(mediafetch.mp4_needs_seek(late_index))
        self.assertFalse(mediafetch.mp4_needs_seek(b'\x47' * 4096), 'MPEG-TS remains on the streaming path')

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
        for container in ['mp4', 'mp4_late_moov', 'mpegts']:
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
                subprocess.run(cmd + ['-f', 'mp4' if container == 'mp4_late_moov' else container, str(source)],
                               check=True, capture_output=True)
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

    def test_slow_mp4_and_ts_emit_multiple_playable_prefixes_before_eof(self):
        binary = os.environ.get('MGU_TEST_FFMPEG') or shutil.which('ffmpeg')
        if not binary:
            self.skipTest('set MGU_TEST_FFMPEG to a host FFmpeg binary')
        for container in ('mp4', 'mpegts'):
            with self.subTest(container=container):
                self._assert_slow_stream_prefixes(binary, container)

    def _assert_slow_stream_prefixes(self, binary, container):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / ('long.mp4' if container == 'mp4' else 'long.ts')
            command = [binary, '-hide_banner', '-loglevel', 'error', '-y',
                       '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12',
                       '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
                       '-t', '120', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24',
                       '-c:a', 'aac', '-b:a', '64k']
            if container == 'mp4':
                command += ['-movflags', '+faststart']
            subprocess.run(command + ['-f', container, str(source)], check=True, capture_output=True, timeout=60)
            data = source.read_bytes()
            read_fd, write_fd = os.pipe()
            sent = {'bytes': 0, 'done': False}
            records = []
            lock = threading.Lock()

            class Capture:
                def write(self, value):
                    with lock:
                        records.append((value, sent['bytes'], sent['done']))
                def flush(self):
                    pass

            def writer():
                try:
                    with os.fdopen(write_fd, 'wb', buffering=0) as output:
                        for start in range(0, len(data), 32768):
                            chunk = data[start:start + 32768]
                            output.write(chunk)
                            with lock:
                                sent['bytes'] += len(chunk)
                            time.sleep(0.08)
                finally:
                    with lock:
                        sent['done'] = True

            thread = threading.Thread(target=writer, daemon=True)
            args = types.SimpleNamespace(dir=str(root / 'output'), id='-123_456', ffmpeg=binary)
            stack = contextlib.ExitStack()
            with stack:
                stack.enter_context(mock.patch.object(mediafetch, '_OUT', Capture()))
                if not hasattr(os, 'pwrite'):
                    real_write, real_lseek = os.write, os.lseek
                    write_lock = threading.Lock()
                    def pwrite(fd, chunk, offset):
                        with write_lock:
                            previous = real_lseek(fd, 0, os.SEEK_CUR)
                            real_lseek(fd, offset, os.SEEK_SET)
                            count = real_write(fd, chunk)
                            real_lseek(fd, previous, os.SEEK_SET)
                            return count
                    stack.enter_context(mock.patch.object(os, 'pwrite', pwrite, create=True))
                thread.start()
                try:
                    with os.fdopen(read_fd, 'rb', buffering=0) as stream:
                        mediafetch.normalize(args, {'title': 'Slow fixture', 'duration_s': 120}, source=stream)
                finally:
                    thread.join(timeout=5)
            events = [(json.loads(line), count, done) for line, count, done in records]
            heads = [(event, count, done) for event, count, done in events if event['ev'] == 'audio_head']
            self.assertGreaterEqual(len(heads), 3, heads)
            self.assertLessEqual(heads[0][0]['ms'], 12000)
            self.assertLess(heads[0][1], len(data) / 4)
            self.assertFalse(heads[0][2])
            self.assertEqual([item[0]['n'] for item in heads], list(range(len(heads))))
            self.assertTrue(all((root / 'output' / ('audio.head.m4a' if event['n'] == 0
                                                     else 'audio.head.%d.m4a' % event['n'])).is_file()
                                for event, _, _ in heads))
            self.assertEqual(events[-1][0]['ev'], 'done')

    def test_late_moov_mp4_from_pipe_plays_after_private_staging(self):
        binary = os.environ.get('MGU_TEST_FFMPEG') or shutil.which('ffmpeg')
        if not binary:
            self.skipTest('set MGU_TEST_FFMPEG to a host FFmpeg binary')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'late-moov.mp4'
            subprocess.run([binary, '-hide_banner', '-loglevel', 'error', '-y',
                            '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12',
                            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
                            '-t', '3', '-c:v', 'libx264', '-g', '12', '-c:a', 'aac', str(source)],
                           check=True, capture_output=True, timeout=20)
            data = source.read_bytes()
            self.assertTrue(mediafetch.mp4_needs_seek(data[:4096]))
            read_fd, write_fd = os.pipe()
            def writer():
                with os.fdopen(write_fd, 'wb', buffering=0) as output:
                    for start in range(0, len(data), 16384):
                        output.write(data[start:start + 16384])
            thread = threading.Thread(target=writer, daemon=True)
            args = types.SimpleNamespace(dir=str(root / 'output'), id='-123_456', ffmpeg=binary)
            log = io.StringIO()
            with contextlib.ExitStack() as stack:
                stack.enter_context(mock.patch.object(mediafetch, '_OUT', log))
                if not hasattr(os, 'pwrite'):
                    real_write, real_lseek = os.write, os.lseek
                    write_lock = threading.Lock()
                    def pwrite(fd, chunk, offset):
                        with write_lock:
                            previous = real_lseek(fd, 0, os.SEEK_CUR)
                            real_lseek(fd, offset, os.SEEK_SET)
                            count = real_write(fd, chunk)
                            real_lseek(fd, previous, os.SEEK_SET)
                            return count
                    stack.enter_context(mock.patch.object(os, 'pwrite', pwrite, create=True))
                thread.start()
                try:
                    with os.fdopen(read_fd, 'rb', buffering=0) as stream:
                        mediafetch.normalize(args, {'title': 'Late index', 'duration_s': 3}, source=stream)
                finally:
                    thread.join(timeout=5)
            events = [json.loads(line) for line in log.getvalue().splitlines()]
            self.assertIn('source_wait', [event['ev'] for event in events])
            self.assertIn('audio_ready', [event['ev'] for event in events])
            self.assertEqual(events[-1]['ev'], 'done')
            self.assertFalse((root / 'output' / 'source.media').exists(), 'private staged media is removed')


if __name__ == '__main__':
    unittest.main()
