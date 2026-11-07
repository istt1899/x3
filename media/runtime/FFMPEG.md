# MGU remux runtime

The shipped FFmpeg is a minimal build of upstream **9.0.2**, LGPL-2.1-or-later,
targeting `x86_64-linux.3.2.0-musl` with the baseline x86-64 CPU. It is a static
ELF executable, requires no glibc loader/version and exposes only `file`/`pipe`
protocols. Network requests, cookies and account headers belong to Python and
never enter FFmpeg's arguments. It copies AVC/H.264 and AAC packets; it has no
encoders. H.264/AAC decoders are available for stream probing.

Build inputs, executable SHA-256 and verification boundaries are recorded in
`ffmpeg-sources.json`. `LICENSE.ffmpeg` and `NOTICE.ffmpeg` are upstream's license
texts; musl and Zig runtime notices travel as `LICENSE.musl` and `LICENSE.zig`.

Build on Windows with existing Git Bash and Python 3.12+, without installing a
system compiler:

```powershell
python media/tools/build_ffmpeg.py --artifacts D:\BMW\Media-artifacts
```

On Linux the same script uses a pinned Linux Zig distribution and the build
environment's bash/GNU make. No Docker or GPU is needed. The producer hashes are
pinned in the script. Zig's community mirror is accepted only when its bytes
match the official Zig download index's hash.

The release **must also publish** the exact source bundle named in the manifest,
alongside the binary/service artifacts. The bundle contains the original FFmpeg
source tarball, the exact build/verifier scripts, generated configuration and
license texts. It is not installed on the car. Do not replace it with a link to
an unrelated/current producer source directory. This build does not use the
John Van Sickle binary or its GPL configuration.

Static ABI/provenance check, also usable on Windows:

```sh
python media/runtime/verify_ffmpeg.py media/runtime/ffmpeg --manifest media/runtime/ffmpeg-sources.json
```

Actual execution check on Linux and then MGU:

```sh
python3 media/runtime/test_ffmpeg.py --ffmpeg media/runtime/ffmpeg
```

The latter feeds synthetic MP4 and MPEG-TS through the production remux command,
then validates MGYI/Annex-B video and plain M4A using the actual service parser.
No Internet/account is used. The fixture recipe is testsrc 128x72, 5 fps, 1 s,
440 Hz AAC audio; MPEG-TS is a packet-copy remux of the MP4 with
`h264_mp4toannexb`. The fixture generator is deliberately not in the minimal
runtime.

An ELF check proves architecture/static linking, not successful execution on a
specific kernel or head unit. Keep `mgu_runtime_tested: false` until the owner
has run the production binary on that MGU. Component installation checks should
execute `ffmpeg -version`, then the offline remux gate where available.

Primary sources: [FFmpeg release](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz),
[FFmpeg licensing](https://ffmpeg.org/legal.html),
[Zig producer hashes](https://ziglang.org/download/index.json),
[Zig producer mirror list](https://ziglang.org/download/community-mirrors.txt),
[GNU make package/hash](https://packages.msys2.org/packages/make?repo=msys&variant=x86_64).
