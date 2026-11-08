#!/usr/bin/env python3
"""Direct VK/RUTUBE media -> AAC M4A + fragmented H264 -> RideTube's MGYI/Annex-B.

The gateway resolves an accepted provider ID into a private job file. Network access
runs in the service's internet UID, explicitly without proxies. FFmpeg reads stdin
for streamable media, or a private local file when an MP4 index follows its media.
Cookies, account tokens and signed CDN URLs never become process arguments.
"""
import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
if not (HERE / 'ytfetch.py').exists():
    sys.path.insert(0, str(HERE.parent / 'core/native/jap-ridetube-d'))
import ytfetch as core

PROVIDERS = {'vk': re.compile(r'^-?\d+_\d+$'), 'rutube': re.compile(r'^[0-9a-f]{32}$')}
CHILDREN = []
_OUT = sys.stdout
_OUT_LOCK = threading.Lock()
HEAD_START_MS = 8000  # a complete first audio file; later snapshots grow while the transfer continues
STREAM_ERRORS = {
    'http_401': 'Сервер видео требует повторного входа (HTTP 401).',
    'http_403': 'Сервер видео отклонил ссылку (HTTP 403). Выберите ролик заново.',
    'http_404': 'Файл видео не найден на сервере (HTTP 404).',
    'dns': 'Не удалось найти сервер видео через DNS подключения MGU Store.',
    'tls': 'Не удалось проверить защищённое соединение с сервером видео.',
    'timeout': 'Сервер видео не передаёт данные. Повторите запуск.',
    'downloader': 'Не удалось загрузить поток с сервера видео.',
}


def event(**fields):
    with _OUT_LOCK:
        _OUT.write(json.dumps(fields, ensure_ascii=True) + '\n')
        _OUT.flush()


def stream_error_code(error):
    """Classify failures without forwarding extractor messages/signed URLs."""
    chain, seen = [error], set()
    while chain:
        item = chain.pop()
        if id(item) in seen:
            continue
        seen.add(id(item))
        code = getattr(item, 'code', None) or getattr(item, 'status', None)
        if code in (401, 403, 404):
            return 'http_%s' % code
        if isinstance(item, socket.gaierror):
            return 'dns'
        if isinstance(item, ssl.SSLError):
            return 'tls'
        if isinstance(item, (TimeoutError, socket.timeout)):
            return 'timeout'
        # yt-dlp wraps urllib/network errors in DownloadError/ExtractorError.
        info = getattr(item, 'exc_info', None)
        chain.extend(value for value in (getattr(item, '__cause__', None), getattr(item, 'cause', None),
                                        getattr(item, 'reason', None), info[1] if isinstance(info, tuple) and len(info) > 1 else None)
                     if isinstance(value, BaseException))
        message = str(item).lower()
        for status in (401, 403, 404):
            if 'http error %s' % status in message or 'http error %s' % status in message.replace(':', ''):
                return 'http_%s' % status
        if 'certificate_verify_failed' in message:
            return 'tls'
        if 'timed out' in message:
            return 'timeout'
    return 'downloader'


class TransferWatch:
    """Bound silence in real downloader/remux subprocesses, including before byte one."""
    def __init__(self, first_timeout=25, idle_timeout=35):
        self.first_timeout, self.idle_timeout = first_timeout, idle_timeout
        self.started = self.last = time.monotonic()
        self.bytes = 0
        self.last_event = 0
        self.error = None
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.watch, daemon=True)

    def received(self, count):
        self.bytes += count
        self.last = time.monotonic()
        if self.last - self.last_event >= 1:
            self.last_event = self.last
            event(ev='source', bytes=self.bytes)

    def activity(self):
        self.last = time.monotonic()

    def watch(self):
        while not self.done.wait(0.1):
            now = time.monotonic()
            if (not self.bytes and now - self.started > self.first_timeout
                    or self.bytes and now - self.last > self.idle_timeout):
                self.error = ('Сервер видео не прислал первые данные за 25 секунд.' if not self.bytes
                              else 'Поток видео остановился: новые данные не поступают.')
                terminate_children()
                return

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.done.set()
        self.thread.join(timeout=5)


def direct_env():
    env = dict(os.environ)
    for name in list(env):
        if name.lower() in ('http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy'):
            env.pop(name, None)
    env['NO_PROXY'] = '*'
    return env


def terminate_children(*_):
    for child in CHILDREN:
        if child.poll() is None:
            try:
                child.terminate()
            except OSError:
                pass
    for child in CHILDREN:
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()


def load_job(a):
    if a.provider not in PROVIDERS or not PROVIDERS[a.provider].fullmatch(a.id or ''):
        raise ValueError('invalid provider video ID')
    # Path is private data generated by the provider bridge, never a URL supplied by UI.
    file = Path(a.job_dir) / (a.id + '.json') if a.job_dir else None
    if not file or not file.is_file() or file.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('video has no resolved playback job; select it again')
    job = json.loads(file.read_text(encoding='utf-8'))
    if job.get('provider') != a.provider or job.get('id') != a.id:
        raise ValueError('playback job belongs to another provider/video')
    if time.time() - float(job.get('created_at', 0)) > 1800:
        raise ValueError('playback link expired; select the video again')
    from urllib.parse import urlsplit
    url = urlsplit(job.get('url', ''))
    if url.scheme != 'https' or not url.hostname or url.username or url.password:
        raise ValueError('provider supplied an invalid HTTPS playback URL')
    return job, file


def params(a, job, hook=None):
    height = min(1080, max(144, a.height))
    # VK sometimes omits codec fields; MP4 fallback is checked by FFmpeg's copy muxers.
    fmt = (f'best[height<={height}][vcodec^=avc1][acodec!=none]/'
           f'best[height<={height}][ext=mp4][acodec!=none]/best[height<={height}]/'
           'worst[vcodec^=avc1][acodec!=none]/worst[ext=mp4][acodec!=none]')
    p = {
        'format': fmt, 'proxy': '', 'cachedir': a.cache_dir, 'quiet': True,
        'no_warnings': True, 'noprogress': True, 'noplaylist': True,
        'socket_timeout': 20, 'retries': 3, 'fragment_retries': 3,
        'hls_prefer_native': True, 'fixup': 'never',
        'outtmpl': {'default': '-'}, 'logger': core._Log(),
        'http_headers': dict(job.get('http_headers') or {}),
        'progress_hooks': [hook] if hook else [],
        'js_runtimes': {'node': {'path': a.node}}, 'remote_components': [],
    }
    ca = job.get('ca_file') or a.ca_file
    if ca:
        if not Path(ca).is_file():
            raise ValueError('trusted CA bundle is missing')
        # The shipped yt-dlp uses certifi, not a ca_certs YoutubeDL parameter.
        # Its import is wired to this verified bundle by stream() before loading.
    return p


def select_format(job, height):
    """A quality change reuses private resolved choices, never a stale fixed 720p URL."""
    choices = [item for item in job.get('formats', []) if item.get('url') and item.get('ext') == 'mp4'
               and item.get('vcodec') != 'none' and item.get('acodec') != 'none']
    if not choices:
        return job
    below = [item for item in choices if (item.get('height') or 0) <= height]
    selected = max(below, key=lambda item: (item.get('height') or 0, item.get('tbr') or 0)) if below else min(
        choices, key=lambda item: item.get('height') or 100000)
    result = dict(job, format=selected, url=selected['url'],
                  http_headers=selected.get('http_headers') or job.get('http_headers') or {})
    return result


class StreamOutput:
    """yt-dlp's binary '-' output with text diagnostics sent to stderr."""
    def __init__(self, binary):
        self.buffer = binary
        self.encoding = 'utf-8'

    def write(self, text):
        return sys.stderr.write(text)

    def flush(self):
        self.buffer.flush()

    def isatty(self):
        return False

    def fileno(self):
        return self.buffer.fileno()


def stream(a, job):
    # This subprocess's stdout contains media only; progress uses stderr JSON.
    job = select_format(job, a.height)
    original = sys.stdout
    def progress(st):
        if st.get('status') in ('downloading', 'finished'):
            fields = {k: st.get(k) for k in ('downloaded_bytes', 'total_bytes', 'total_bytes_estimate', 'eta')}
            print(json.dumps({'progress': fields}), file=sys.stderr, flush=True)
    ca = job.get('ca_file') or a.ca_file
    if ca:
        core.CA = ca
    yt = core.load_ytdlp(a.pyz, a.cache_dir)
    sys.stdout = StreamOutput(original.buffer)
    previous_directory = os.getcwd()
    try:
        # Native HLS writes scratch fragments even with output '-'. The daemon starts
        # helpers in '/', which the internet UID cannot write. Keep fragments private.
        with tempfile.TemporaryDirectory(prefix='stream-', dir=a.cache_dir) as scratch:
            os.chmod(scratch, 0o700)
            os.chdir(scratch)
            try:
                with yt.YoutubeDL(params(a, job, progress)) as downloader:
                    if job.get('format'):
                        info = dict(job['format'], id=a.id, title=job.get('title') or a.id,
                                    http_headers=job.get('http_headers') or {}, ext=job['format'].get('ext') or 'mp4')
                        downloader.process_ie_result(info, download=True)
                    else:
                        downloader.extract_info(job['url'], download=True)
            finally:
                os.chdir(previous_directory)
    finally:
        os.chdir(previous_directory)
        sys.stdout = original


def ffmpeg_command(binary, audio, input_file='pipe:0'):
    # Both outputs are copies. No CPU video transcoding and no FFmpeg network requests.
    fragmented = ['-movflags', '+frag_keyframe+empty_moov+default_base_moof',
                  '-frag_duration', '2000000', '-flush_packets', '1', '-f', 'mp4']
    return [binary, '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
            '-i', input_file, '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'copy',
            '-bsf:a', 'aac_adtstoasc',
            *fragmented, str(audio), '-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'copy',
            *fragmented, 'pipe:1']


def head_target_ms(previous_ms, duration_ms):
    """Grow complete audio prefixes geometrically so playback need not wait for the whole download."""
    target = max(HEAD_START_MS, previous_ms * 2)
    # Provider duration is only a hint. It can be shorter than the actual media;
    # never turn the target into an already reached value and copy every fragment.
    return min(target, duration_ms) if duration_ms > previous_ms else target


def mp4_needs_seek(prefix):
    """A plain MP4 with mdat before moov cannot be demuxed from a non-seekable pipe."""
    if len(prefix) < 8 or prefix[4:8] != b'ftyp':
        return False  # MPEG-TS/HLS or another container: let FFmpeg validate it
    pos = 0
    for _ in range(8):
        if pos + 8 > len(prefix):
            return True  # uncertain MP4 layout: preserve playback with a local file
        size = int.from_bytes(prefix[pos:pos + 4], 'big')
        typ = prefix[pos + 4:pos + 8]
        if typ in (b'moov', b'moof'):
            return False
        if typ == b'mdat' or size == 0:
            return True
        if size == 1:
            if pos + 16 > len(prefix):
                return True
            size = int.from_bytes(prefix[pos + 8:pos + 16], 'big')
        if size < 8 or pos + size > len(prefix):
            return True
        pos += size
    return True


def media_chunks(source):
    read = getattr(source, 'read1', source.read)
    while True:
        chunk = read(65536)
        if not chunk:
            break
        yield chunk


def stream_command(a):
    # VK group IDs start with '-'. Every option must precede the positional
    # separator, including in this second subprocess (not only the daemon).
    cmd = [sys.executable, '-I', str(Path(__file__).resolve()), 'stream',
           '--provider', a.provider, '--job-dir', a.job_dir,
           '--cache-dir', a.cache_dir, '--height', str(a.height), '--node', a.node, '--lease', a.lease]
    if a.pyz:
        cmd += ['--pyz', a.pyz]
    if a.ca_file:
        cmd += ['--ca-file', a.ca_file]
    return cmd + ['--', a.id]


def normalize(a, job, source=None):
    with TransferWatch(getattr(a, 'first_byte_timeout', 25), getattr(a, 'idle_timeout', 35)) as watch:
        try:
            result = _normalize(a, job, source, watch)
        except Exception:
            if watch.error:
                raise ValueError(watch.error) from None
            raise
        if watch.error:
            raise ValueError(watch.error)
        return result


def _normalize(a, job, source, watch):
    directory = Path(a.dir)
    directory.mkdir(parents=True, exist_ok=True)
    audio_src = directory / 'audio.src.m4a'
    audio_part = directory / 'audio.head.m4a.part'
    local_source = directory / 'source.media'
    duration = float(job.get('duration_s') or 0)
    meta = {'id': a.id, 'title': job.get('title') or a.id, 'channel': job.get('channel') or '',
            'duration_s': duration, 'chapters': []}
    (directory / 'meta.json').write_text(json.dumps(meta), encoding='utf-8')
    event(ev='meta', title=meta['title'], duration_s=duration, chapters=[])
    stopped = threading.Event()
    state = {'eta': None, 'head_ms': 0, 'head_n': -1, 'progress': 0, 'stream_error': None}
    progress_thread = None
    if source is None:
        cmd = stream_command(a)
        download = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=direct_env())
        CHILDREN.append(download)
        source = download.stdout
        def read_progress():
            for raw in download.stderr:
                try:
                    status = json.loads(raw)
                    if status.get('stream_error') in STREAM_ERRORS:
                        state['stream_error'] = status['stream_error']
                    progress = status.get('progress') or {}
                except (ValueError, UnicodeError):
                    continue  # never forward signed URLs or private headers from downloader errors
                state['eta'] = progress.get('eta')
                total = progress.get('total_bytes') or progress.get('total_bytes_estimate')
                done = progress.get('downloaded_bytes') or 0
                if total:
                    state['progress'] = min(100, round(done * 100 / total))
                    event(ev='audio', pct=state['progress'])
        progress_thread = threading.Thread(target=read_progress, daemon=True)
        progress_thread.start()
    else:
        download = None  # local fixture path in tests
    prefix = source.read(4096)
    if not prefix:
        terminate_children()
        if progress_thread:
            progress_thread.join(timeout=1)
        if download:
            download.stdout.close()
            download.stderr.close()
        raise ValueError(STREAM_ERRORS.get(state['stream_error'], 'Загрузчик не получил данные видео. Повторите запуск.'))
    watch.received(len(prefix))
    def chunks():
        for data in media_chunks(source):
            watch.received(len(data))
            yield data
    seek_required = mp4_needs_seek(prefix)
    feeder = None
    if seek_required:
        event(ev='source_wait', reason='mp4_index')
        fd = os.open(local_source, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as staged:
            staged.write(prefix)
            for chunk in chunks():
                staged.write(chunk)
        source.close()
        remux = subprocess.Popen(ffmpeg_command(a.ffmpeg, audio_src, str(local_source)), stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=direct_env())
    else:
        remux = subprocess.Popen(ffmpeg_command(a.ffmpeg, audio_src), stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=direct_env())
        def feed():
            try:
                remux.stdin.write(prefix)
                remux.stdin.flush()
                for chunk in chunks():
                    remux.stdin.write(chunk)
                    remux.stdin.flush()
            except (BrokenPipeError, OSError):
                pass  # FFmpeg rejected the stream; normalize reports its failure
            finally:
                try:
                    remux.stdin.close()
                except OSError:
                    pass
                source.close()
        feeder = threading.Thread(target=feed, daemon=True)
        feeder.start()
    CHILDREN.append(remux)
    errors = []
    def drain_errors():
        for raw in remux.stderr:
            if len(errors) < 4:
                errors.append(raw[:160])
    threading.Thread(target=drain_errors, daemon=True).start()

    def watch_audio():
        last_size = 0
        probe_at = 0
        while not stopped.wait(0.5):
            if not audio_src.exists():
                continue
            try:
                size = audio_src.stat().st_size
                if size <= last_size:
                    continue
                if size < probe_at:
                    continue
                last_size = size
                watch.activity()
                result = core.flatten_m4a(str(audio_src), str(audio_part), limit=size)
                if not result:
                    continue
                ms = result[1]
                target = head_target_ms(state['head_ms'], duration * 1000)
                if state['head_n'] < 0 and ms > 0:
                    event(ev='audio_buffer', ms=ms, target_ms=target)
                if ms >= target and ms > state['head_ms']:
                    n = state['head_n'] + 1
                    name = 'audio.head.m4a' if n == 0 else 'audio.head.%d.m4a' % n
                    os.replace(audio_part, directory / name)
                    state['head_ms'], state['head_n'] = ms, n
                    event(ev='audio_head', ms=ms, bytes=result[0], n=n)
                    target = head_target_ms(ms, duration * 1000)
                # FFmpeg's fragmented MP4 has enough samples only when the next
                # moof/mdat is complete. Avoid copying a long prefix every 0.5 s.
                if ms > 0 and target > ms:
                    probe_at = max(size + 4096, int(size * target / ms * 0.85))
                else:
                    probe_at = size + 4096
            except (OSError, ValueError, IndexError, KeyError, core.struct.error):
                pass  # a trailing MP4 fragment is not complete yet
    monitor = threading.Thread(target=watch_audio, daemon=True)
    monitor.start()
    try:
        def video_progress(ms, count, size):
            watch.activity()
            event(ev='video', pct=min(100, round(ms / (duration * 10))) if duration else state['progress'],
                  ms=ms, frames=count, bytes=size)
        frames, size, ms = core.demux_video(remux.stdout, str(directory), duration, video_progress)
        if feeder:
            feeder.join()
        if remux.wait() != 0 or (download and download.wait() != 0):
            raise ValueError(STREAM_ERRORS.get(state['stream_error'],
                'Не удалось обработать видео. Нужен совместимый поток H.264/AAC.'))
        ready = core.flatten_m4a(str(audio_src), str(directory / 'audio.m4a'))
        if not ready:
            raise ValueError('complete audio is unavailable')
        event(ev='audio_ready', ms=ready[1])
        event(ev='video', pct=100, ms=ms, frames=frames, bytes=size)
        event(ev='done')
    finally:
        stopped.set()
        monitor.join(timeout=3)
        terminate_children()
        if feeder:
            feeder.join(timeout=3)
        for path in (audio_part, audio_src, local_source):
            try:
                path.unlink()
            except FileNotFoundError:
                pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cmd', choices=('fetch', 'extract', 'serve', 'stream'))
    parser.add_argument('id', nargs='?')
    parser.add_argument('dir', nargs='?')
    parser.add_argument('--provider', required=True, choices=tuple(PROVIDERS))
    parser.add_argument('--job-dir')
    parser.add_argument('--cache-dir', required=True)
    parser.add_argument('--height', type=int, default=720)
    parser.add_argument('--node', default=core.NODE)
    parser.add_argument('--pyz', default=str(HERE / 'ytdlp.pyz'))
    parser.add_argument('--ffmpeg', default='/var/opt/marku-ffmpeg/current/ffmpeg')
    parser.add_argument('--ca-file')
    parser.add_argument('--lease', default=core.LEASE)
    parser.add_argument('--info')  # accepted for the existing player's prefetch protocol
    # Python 3.12 otherwise loses optional positionals after options/`--` when
    # cmd was already consumed. The daemon deliberately intermixes these fields.
    a = parser.parse_intermixed_args(argv)
    os.environ.update(direct_env())
    for name in list(os.environ):
        if name.lower() in ('http_proxy', 'https_proxy', 'all_proxy'):
            del os.environ[name]
    core.install_dns(a.lease)
    if a.cmd == 'serve':
        event(ev='warm')
        job = json.loads(sys.stdin.readline())
        if not isinstance(job, list) or not job or job[0] not in ('fetch', 'extract'):
            raise ValueError('invalid warm process job')
        suffix = ['--provider', a.provider, '--job-dir', a.job_dir] if a.job_dir else ['--provider', a.provider]
        if a.pyz:
            suffix += ['--pyz', a.pyz]
        suffix += ['--ffmpeg', a.ffmpeg, '--lease', a.lease]
        if a.ca_file:
            suffix += ['--ca-file', a.ca_file]
        split = job.index('--') if '--' in job else len(job)
        return main([str(x) for x in job[:split]] + suffix + [str(x) for x in job[split:]])
    job, _ = load_job(a)
    if a.cmd == 'stream':
        return stream(a, job)
    if a.cmd == 'extract':
        if not a.dir:
            raise ValueError('missing metadata path')
        Path(a.dir).write_text(json.dumps(job), encoding='utf-8')
        event(ev='info', id=a.id, title=job.get('title'), duration_s=job.get('duration_s'))
        return
    if not a.dir or not Path(a.ffmpeg).is_file():
        raise ValueError('FFmpeg runtime is not installed')
    return normalize(a, job)


if __name__ == '__main__':
    def stop(*_):
        terminate_children()
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    try:
        main()
    except Exception as error:
        terminate_children()
        if 'stream' in sys.argv[1:]:
            # stdout is connected to FFmpeg: never inject JSON into the media stream.
            print(json.dumps({'stream_error': stream_error_code(error)}), file=sys.stderr, flush=True)
        else:
            event(ev='error', msg=str(error) if isinstance(error, ValueError) else 'media processing failed')
        raise SystemExit(1)
