#!/bin/sh
set -eu
base="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
/usr/bin/node --check "$base/service/main.js"
/usr/bin/node --check "$base/service/gateway.js"
/usr/bin/node --check "$base/service/python_provider.js"
/usr/bin/node --check "$base/core/native/jap-ridetube-d/ytd.js"
test -x "$base/core/native/jap-ridetube-d/ytdec"
test -s "$base/core/native/jap-ridetube-d/ytdlp.pyz"
test -s "$base/runtime/cacert.pem"
test -x "$base/runtime/ffmpeg"
"$base/runtime/ffmpeg" -version >/dev/null
/var/opt/mgu-python/current/bin/python3 -I -c 'import runpy,sys;sys.path.insert(0,sys.argv[1]);import ytfetch' "$base/core/native/jap-ridetube-d"
/var/opt/mgu-python/current/bin/python3 -I "$base/runtime/test_ffmpeg.py"
