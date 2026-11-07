#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Cross-build a small LGPL FFmpeg. No SDK, Docker, system installation or network in the binary.
set -euo pipefail
: "${FFMPEG_SOURCE:?set the verified extracted FFmpeg source directory}"
: "${FFMPEG_BUILD:?set the build directory}"
: "${ZIG_ROOT:?set the verified Zig directory}"
: "${MAKE_BIN:=make}"
: "${JOBS:=4}"
export LC_ALL=C SOURCE_DATE_EPOCH=0
if test -f "$ZIG_ROOT/zig.exe"; then
  export ZIG_BIN="$ZIG_ROOT/zig.exe" ZIG_HOST_TARGET=x86_64-windows-gnu
else
  export ZIG_BIN="$ZIG_ROOT/zig" ZIG_HOST_TARGET=x86_64-linux-musl
fi
mkdir -p "$FFMPEG_BUILD"
cd "$FFMPEG_BUILD"
cat > zig-cc <<'EOF'
#!/usr/bin/env sh
exec "$ZIG_BIN" cc -target x86_64-linux.3.2.0-musl -mcpu=baseline "$@"
EOF
cat > zig-ar <<'EOF'
#!/usr/bin/env sh
exec "$ZIG_BIN" ar "$@"
EOF
cat > zig-host-cc <<'EOF'
#!/usr/bin/env sh
exec "$ZIG_BIN" cc -target "$ZIG_HOST_TARGET" -mcpu=baseline "$@"
EOF
chmod +x zig-cc zig-ar zig-host-cc
export ZIG_ROOT
"$FFMPEG_SOURCE/configure" \
  --prefix=/usr/local/mgu-media \
  --target-os=linux --arch=x86_64 --cpu=generic --enable-cross-compile \
  --cc="$FFMPEG_BUILD/zig-cc" --ld="$FFMPEG_BUILD/zig-cc" \
  --ar="$FFMPEG_BUILD/zig-ar" --host-cc="$FFMPEG_BUILD/zig-host-cc" \
  --nm=true --disable-stripping \
  --extra-cflags='-Os -fno-ident' --extra-ldflags='-static -Wl,--build-id=none -Wl,-s' \
  --disable-everything --disable-autodetect --disable-x86asm \
  --disable-doc --disable-debug --disable-network \
  --disable-shared --enable-static --disable-gpl --disable-version3 --disable-nonfree \
  --disable-avdevice --disable-swscale --disable-swresample \
  --disable-ffplay --disable-ffprobe --enable-ffmpeg \
  --enable-protocol=file,pipe \
  --enable-demuxer=mov,mpegts \
  --enable-muxer=mp4,ipod \
  --enable-parser=h264,aac,aac_latm \
  --enable-decoder=h264,aac \
  --enable-bsf=aac_adtstoasc,h264_mp4toannexb,extract_extradata \
  --extra-version=mgu-media-1
"$MAKE_BIN" -j"$JOBS" RANLIB="$FFMPEG_BUILD/zig-ar s" ffmpeg
test -s ffmpeg
