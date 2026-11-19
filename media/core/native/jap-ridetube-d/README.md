# jap-ridetube-d

The car-side daemon of RideTube (`ytd.js`, Node 8, root, `jap-ridetube-d.service`), packaged as an
mgu-deploy tool with the video decoder `ytdec` (built in `../ytdec`). yt-dlp, search and thumbnails all
run on the car; nothing is downloaded for keeps: the cache holds the last few videos played.

- audio: BMW MediaPlayer over SOME/IP (`/usr/lib/someip.node`), source 1046 → sink 1024,
  `playFile` on `cache/<id>/audio.m4a`.
- video: `ytdec --dir cache/<id> --rect WxH [--fill] --log /var/opt/jap-ridetube-d/log/ytdec.log`, which
  writes `/dev/shm/mgu-video-ridetube` for mgu-render; paced by `clock <elapsed_ms> <mono_ms>` lines.
- media: `/var/opt/jap-ridetube-d/cache/<id>/` {meta.json, thumb.rgba, audio.m4a, index.bin, video.h264, and
  `audio.head.m4a` while the rest of the audio downloads}, written on the car by the fetcher (below).

## Architecture

Every internet request runs as the daemon's fetch uid (below, "Internet: the fetch uid"), never root:

- `ytfetch.py` in mgu-python (`/var/opt/mgu-python/current/bin/python3 -I`), with yt-dlp from
  `ytdlp.pyz` on its `sys.path`, fetches the playing video straight into its cache dir
  (`cache/<id>/`); yt-dlp's own cache is `/var/opt/jap-ridetube-d/cache/ytdlp`.
- Playable gate: a play starts once enough of the files is on disk to play, not when the download
  ends; until then the state is `preparing` and `pct` is the download progress towards playable.
- Audio (0.2.1): `playFile` needs a complete file, so the fetcher downloads the audio format yt-dlp picked
  itself, 4 parallel `Range` requests (1 MB, then 2 MB chunks, handed out in file order; googlevideo
  paces each connection), into `audio.src.m4a`; yt-dlp's own download is the fallback (no `filesize`,
  not https, or a range failing 3 times). Once the gap-free prefix holds max(60 s, 1.5 x the rest's
  estimated download time) of samples, it writes `audio.head.m4a`, a plain MP4 of just those, and says
  `audio_head {ms}`. The daemon starts on `audio_head` (or `audio_ready`) + 10 s of video, playing the head.
- Head -> full: on `audio_ready` the daemon calls `playFile(audio.m4a)` on the live connection, then
  `setTime` at the clock (extrapolated from the last tick: ytdec keeps running) and deletes the head; the
  player's times and states between the two are ignored, and its times below the target for 3 s after.
  Paused at that moment: `resume` does it (as after a STOP mid-file). Within 1.5 s of the head's end, or a
  seek past it, before `audio_ready`: the player and ytdec pause there, the state is `playing` with
  `buffering: true` (never `ended`), and `audio_ready` resumes there. The fetcher dying with only the
  head: `error`. A cached video (audio.m4a there) plays it at once, as before. The switch itself
  (a restart of the file, then the seek) may be audible: not measured on the car yet.
- Buffering: if playback catches up with the download, the `state` event says `buffering: true`
  until enough data is there again.
- Search: InnerTube (`/youtubei/v1/search`) from the daemon, through the same fetch helper.
- Thumbnails: `thumb.js` in jap-node22 fetches `i.ytimg.com/vi/<id>/mqdefault.jpg` (8 s, no
  redirects, ≤ 2 MB, any status but 200 fails: private videos get a 404 placeholder), decodes it
  with the vendored jpeg-js decoder (baseline and progressive; the car has no image library),
  resamples to 320x180 if needed and writes 230400 bytes RGBA on stdout. DNS: the uplink lease's
  servers (`--lease`, default `/run/mgu-uplink/lease.json`), else the system resolver.

## Proxy (0.3.11)

When YouTube is unreachable from the car's own network (a phone hotspot in a throttled region,
for example), an admin can send all of the service's YouTube traffic through an HTTP CONNECT or
SOCKS5 proxy. It applies to every egress: the TV sign-in page, `youtubei` search/feeds, OAuth
tokens, SponsorBlock, `i.ytimg.com` thumbnails (`thumb.js --proxy-file`), and both the yt-dlp
download and the ranged audio (`ytfetch.py --proxy-file`) to `googlevideo`.

Set it with one root-owned file on the head unit:

    printf '{"url": "socks5://user:pass@host:port"}\n' > /var/opt/jap-ridetube-d/state/proxy.json
    chmod 600 /var/opt/jap-ridetube-d/state/proxy.json
    systemctl restart jap-ridetube-d.service

Schemes `http://` and `socks5://` (default ports 8080/1080). The daemon re-reads the file when it
changes; deleting it restores direct connections. With a proxy set, DNS resolves behind the proxy
and the `mgu-uplink` lease preflight is skipped — any working internet on the car is enough.
Credentials never appear in argv/env: the daemon passes the parsed proxy to `ytd.js --fetch`
inside the stdin JSON, and leaves a 0600 copy owned by the fetch uid at `cache/proxy.json` for
`thumb.js` and `ytfetch.py`. `proxy.js` (Node, dependency-free) and the SOCKS5 client in
`ytfetch.py` implement the two tunnels; `ytfetch.py check` prints a `proxy` line next to `dns`.

## Updating yt-dlp

`ytdlp.pyz` is built from the official yt-dlp zipapp of a pinned GitHub release
(`https://github.com/yt-dlp/yt-dlp/releases`, Unlicense), checked by sha256; no yt-dlp code is kept here.

1. Set `YTDLP_VERSION` and `YTDLP_SHA256` in `tools/build_pyz.sh` (the release's `SHA2-256SUMS`, file `yt-dlp`).
2. `./build.sh` (rebuilds `build/ytdlp.pyz`, runs the tests, packs).
3. Bump `version` in `component.json`.
4. Install the new artifact through the Store; its `check` (`check.sh`) rolls back a pyz that does not load.

## Self-check on the car (root)

    /var/opt/mgu-python/current/bin/python3 -I /var/opt/jap-ridetube-d/current/ytfetch.py check --cache-dir /var/opt/jap-ridetube-d/cache/ytdlp
    U=$(sed 's/.*"fetch":\([0-9]*\).*/\1/' /var/opt/jap-ridetube-d/state/uids.json); /var/opt/mgu-python/current/bin/python3 -I -c "import os,sys;u=int(sys.argv[1]);os.setgroups([]);os.setgid(u);os.setuid(u);os.execv('/var/opt/jap-node22/current/bin/node',['node','/var/opt/jap-ridetube-d/current/thumb.js','dQw4w9WgXcQ'])" $U | wc -c    # 230400
    sh /var/opt/jap-ridetube-d/current/check.sh    # offline; exit 0

The first two need the internet, which the uplink gives the fetch uid, never root: `ytfetch.py check`
drops to that uid itself (from `state/uids.json`); `thumb.js` does not, so the second line runs it
as that uid. `check.sh` is the install `check`: yt-dlp (and `yt_dlp_ejs`) import from
`ytdlp.pyz` in mgu-python, and node22 loads the JPEG decoder and `thumb.js`.

## Control socket `/run/jap-ridetube-d/ctl.sock` (0660 root:tm_oap_app), JSON lines

The audio head is internal: `time.total` is the video's length, not the head's.

App → daemon (every `case` of `onLine` in `ytd.js`, no more, no fewer: `test_ytd.js` checks the two match):

| cmd | |
|---|---|
| `{"cmd":"hello","app":"0.4.0","lang":"ru","region":"RU"}` | → `hello` `{service, caps, clock?}`. `lang` (`^[a-z]{2}$`) and `region` (`^[A-Z]{2}$`) are optional; one that does not match is dropped (logged), never refused. Both hold for this connection only, kept for the `hl` / `gl` of its feed, search and related requests. `caps` lists only what this build really answers, from the frozen names `health`, `related`, `hist`, `ytdlp`, `remote`, `proxy`, `stream`; this build: `related`, `hist`, `health`, `playlists`. A service older than 0.4.0 answers `error` `unknown cmd hello`: the app reads that as no caps |
| `{"cmd":"status"}` | → `state` (and `time` when known) |
| `{"cmd":"search","q":".."}` | → `results` (InnerTube), or `error` `empty search` / `search offline` |
| `{"cmd":"thumb","id":".."}` | → `thumb` (cache `thumb.rgba` first, else `thumb.js` on the car; nothing if neither works, or if the length is neither 57600 nor 230400) |
| `{"cmd":"prefetch","id":".."}` | the stream lookup (`ytfetch.py extract`) ahead of a likely play, while the controller rests on a tile; nothing is answered. Skipped when cached, being prepared or looked up in the last 25 min; one at a time (the last one asked waits) |
| `{"cmd":"play","id":"..","rect":"WxH","fill":bool,"at":ms,"quality":q,"skip":[cat]}` | cached and ready: plays; else fetches with `ytfetch.py` (`preparing` + pct, `retry` between tries), plays once playable. `at`: YouTube's own resume point (the tile's `start_s`), used when this car has no position for the video; `quality`: `360`, `480`, `720`, else auto (720 on Wi-Fi or no uplink known, 480 on phone data); `skip`: the SponsorBlock categories skipped (default `sponsor`, `selfpromo`, `interaction`, `intro`). Starts where it was left (`positions`) unless finished |
| `{"cmd":"pause"}` / `{"cmd":"resume"}` | `sendButtonEvent PAUSE/PLAY` + ytdec `pause`/`resume` |
| `{"cmd":"seek","ms":N}` | absolute; `setTime` + ytdec `seek N` |
| `{"cmd":"video","on":bool}` | ytdec `video 1/0` (audio unaffected) |
| `{"cmd":"fill","on":bool}` | zoom while playing: ytdec again at the clock with `--fill` or without; the sound plays on; the same mode: nothing |
| `{"cmd":"quality","quality":q}` | while playing, at another height (as `play`): the video fetched again from where it is (in the first 10 s too), paused if it was; the same height: nothing. A pause, resume, seek, stop or play sent during that restart is applied or cancels it |
| `{"cmd":"stop"}` | STOP, disconnect, ytdec `quit` (SIGKILL after 1 s) |
| `{"cmd":"positions"}` | → `positions` |
| `{"cmd":"auth_status"}` | → `auth` |
| `{"cmd":"auth"}` | signed in, or a code still valid: → that `auth` again; else a new device code → `auth` `code`, then polled until `signed_in`, `signed_out` (expired, denied) or `error` |
| `{"cmd":"sign_out"}` | deletes the account → `auth` `signed_out` |
| `{"cmd":"feed","which":"home\|subs\|wl\|hist\|liked"}` | → `feed` (items, or error `signed out` / `feed offline` / `unknown feed`). `hist` (`FEhistory`, the watch history) and `liked` (`VLLL`) are new in 0.4.0, cap `hist`; an older service answers them `unknown feed` |
| `{"cmd":"channels"}` | → `channels` (every subscription; kept 10 min), or its error as `feed` |
| `{"cmd":"channel","id":"UC.."}` | → `channel` (its page), or its error as `feed`, or `bad channel` |
| `{"cmd":"playlists"}` | → `playlists` (the account's playlists, or error as `feed`) |
| `{"cmd":"playlist","id":".."}` | → `playlist` (its videos, or error as `feed`, or `bad playlist`) |
| `{"cmd":"send_logs","app":"0.4.0"}` | the recent log and the health check's lines, redacted, to the relay configured through `MGU_YT_REPORT_URL` → `logs_sent` or `logs_error`; a second one while one is on its way is ignored |
| `{"cmd":"health"}` | 0.4.0, cap `health`: → one `{"ev":"health","key","ok","text"}` per check as each one ends, then `{"ev":"health","done":true}`, all within about 8 s. The 12 keys: `service`, `node`, `node22`, `python`, `ytdlp`, `uid`, `lease`, `dns`, `tls`, `free`, `audio`, `socket` (`ytdlp`, `dns` and `tls` from `ytfetch.py check --json`, run as the fetch uid). Every key is answered; a check that could not run says `not checked: <why>`. `text` is one short line with no address (IP, MAC), video id or title |
| `{"cmd":"related","id":".."}` | 0.4.0, cap `related`: → `{"ev":"related","id","items":[item]}` (the TVHTML5 watch-next tiles, the video itself left out, ≤ 100; kept 10 min per video and language) or `{"ev":"related","id","error"}` (`bad id`, `related offline`) |
| `{"cmd":"ytdlp","auto":bool}` | 0.4.1, cap `ytdlp` (WP6): `auto` optional (sets the self-update on or off) → `{"ev":"ytdlp","auto","version","bundled","checking"}`. Not implemented yet: `error` `not implemented ytdlp` |
| `{"cmd":"remote","on":bool}` | 0.5.0, not yet implemented, cap `remote` (WP9): → `{"ev":"remote","on","url","expires"}`; until then `error` `not implemented remote` |
| `{"cmd":"proxy"}` | reserved for the standalone service protocol. The shared x3 gateway uses `network_set` for transport selection |

A command not in this table: `{"ev":"error","msg":"unknown cmd <cmd>"}`. A command of the table whose package has not
landed: `{"ev":"error","cmd":"<cmd>","msg":"not implemented <cmd>"}`; the app sends none of them unless `hello` listed its cap.

Daemon → app:

- `{"ev":"hello","service":"0.4.0","caps":[..]}`: the answer to `hello` (above). `"clock":"2026-10-13"` is added
  only while the head unit's clock is wrong (below, "Security notes"): the date the head unit shows. The app then warns
  the driver.
- `{"ev":"clock","clock":"2026-10-13"|null}`: the clock went wrong, or right again (`null`), after `hello`. Checked at
  each fetch, lookup, request and health check.
- `{"ev":"state","state":"idle|preparing|playing|paused|ended|error","pct","id","title","buffering"}`; 0.5.0 (not yet
  implemented, cap `stream`) adds `"stored":"ram|flash"`: where the playing video is held.
- `{"ev":"time","elapsed","total"}` (ms, ≤ 4/s).
- `{"ev":"results","q","items":[item]}` (`meta: ["12K views"]` when there is a view count).
- `{"ev":"thumb","id","w","h","rgba":"<base64 w*h*4 bytes>"}` (320x180; 160x90 from caches older than 0.1.6; the size comes
  from the length; a 320x180 line is ~307 kB).
- `{"ev":"error","msg"}` (with `cmd` for a command not implemented yet).
- `{"ev":"retry","id","n","msg"}`: the fetch of the video being prepared failed (the network, not the video), tried again
  after a wait; `n` counts from 1.
- `{"ev":"extras","id","chapters":[[ms,title]],"segments":[[ms,ms,category]]}`: the playing video's chapters (yt-dlp's)
  and SponsorBlock segments (`sponsor`, `selfpromo`, `interaction`, `intro`, `outro`, `music_offtopic`), at the play and
  again when the segments come in.
- `{"ev":"skipped","category","ms"}`: a SponsorBlock segment of a `skip` category was skipped (`ms`: its length).
- `{"ev":"positions","items":[{id,ms,total,done,at,title,channel,duration_s}]}`: where each video played on this car was
  left, newest first (`at`: when, epoch ms; `done`: within 5 % or 5 s of its end), at most 300.
- `{"ev":"auth","state":"signed_out|code|signed_in|error","code","url","expires" (s left, with code),"msg" (with error)}`.
- `{"ev":"feed","which","items":[item],"shelves":[{title,items:[item]}]}` or `{"ev":"feed","which","error"}` (feed thumbs:
  `thumb`).
- `{"ev":"channels","items":[{id,title,handle}]}` or `{"ev":"channels","error"}`: the subscriptions, A-Z.
- `{"ev":"channel","id","items":[item],"shelves":[..]}` or `{"ev":"channel","id","error"}`: a channel's page (Videos,
  Popular...), as `feed`.
- `{"ev":"playlists",..}`, `{"ev":"playlist",..}`, `{"ev":"logs_sent",..}`, `{"ev":"logs_error",..}`: below.
- 0.4.0 / 0.4.1, cap-gated: `{"ev":"health",..}`, `{"ev":"related",..}`, `{"ev":"ytdlp",..}` (shapes in the table).
- 0.5.0, not yet implemented: `{"ev":"remote","on","url","expires"}`; `{"ev":"remote_do","do":"search|play","q"|"id"}`: a
  phone action the app carries out itself (the parked rule and the screen stay the app's); `{"ev":"net","proxy","ok"}`.

An item is `{id,title,channel,duration_s,meta}`, plus `watched_pct` (the account's progress on the tile), `start_s` (its
resume point) and `members: true` (a members-only badge) when the tile has them; `meta` = the texts of the tile's second
line as YouTube writes them, without
the `•` and the badges (`["125K views","1 day ago"]`, `[]` when none), `short: true` for a Short (the app decides
whether it shows them), and `live: true` for a live stream or an upcoming premiere (`duration_s` null; not playable yet,
the app shows a LIVE tag and does not ask to play it). `items`: every video tile once, page order, ≤ 100.
`shelves`: YouTube's rows in page order (≤ 8, ≤ 12 tiles each, video tiles and Shorts only, deduped per row, empty rows
dropped); `title` is the row header, else the channel when all its tiles share one (Subscriptions' per-channel rows), else `""`.
Watch later is a playlist with no rows: `shelves: []`, use `items`.
`{"ev":"playlists","items":[{id,title,count,meta,thumb}]}` or `{"ev":"playlists","error"}`: the library page's playlists, page
order, each once, Watch later left out (`feed` `wl` has it). `count` is the tile's "N videos" (null when it shows none), `meta`
its other texts (`["Private","Updated today"]`), `thumb` the video whose picture the tile shows (ask it with `thumb`; null when
none). `{"ev":"playlist","id","title","items":[item]}` or `{"ev":"playlist","id","error"}`: a playlist's videos (≤ 100), `title`
its name (`""` when the page has none).
`{"ev":"logs_sent","id":"ABC123"}`: the relay took the report, `id` is the code the user quotes in a GitHub issue.
`{"ev":"logs_error","msg":"closed|busy|offline|failed"}`: reporting switched off at the relay (410), too many reports
(429), no answer (no network, no internet uid, the relay down), anything else; never the relay's own text.

`state` carries `buffering` (bool; true while playback waits for the fetch), and `preparing`'s `pct`
is the fetch's progress to playable (0-100).

One client at a time; a new connection replaces the old one. The client going away stops
playback at once.

## Account

The car signs in itself with the TV device sign-in: the client id and secret are scraped from `https://www.youtube.com/tv` (Tizen user agent) at run time, never shipped
(once a process; again once when the device-code request is refused);
`/o/oauth2/device/code` gives the code the user enters at google.com/device; `/o/oauth2/token`
is polled, then refreshes the token when less than 5 min is left (`invalid_grant` = signed out).
Feeds: `POST /youtubei/v1/browse` as `TVHTML5`, `FEwhat_to_watch` (home), `FEsubscriptions`
(subs), `VLWL` (wl); their video tiles, each id once (no shorts, channels, playlists), at most 50.
The account (tokens and the scraped secret) is `/var/opt/jap-ridetube-d/state/account.json`, 0600 in the
0700 state dir, written atomically; nothing secret goes on the socket or into the log. `sign_out` wins
over work in flight: a refresh, device-code request or poll started before it saves, shows and
re-arms nothing. Asks for a feed while its browse is in flight share that browse.

### Internet: the fetch uid

`mgu-uplink` lets out only the uids it lists, never root. Every youtube.com request runs in a child,
`node --max-http-header-size=65536 ytd.js --fetch`, spawned as the daemon's own fetch uid (gid the same
number, empty env, cwd `/`). The request, with the secret, tokens and body, goes on the child's stdin
(never argv or env: `ps` shows those); `{status, body}` or `{error}` comes back on its stdout. 10 s
timeout (the child is killed 1 s after), 8 MiB body. The child never touches the account file.

The uid is picked as mgu-updater's `js/uids.js` picks its own, at start and on first need:

- kept from `state/uids.json` (`{"fetch": N}`) while nothing else holds it (running processes do not
  count: they may be our own helpers);
- else the lowest number above MainApp's app uid ranges (`usableUidsAndGids` and
  `usableUidsAndGidsRse` in the `config/base.json` of `/usr/lib/oap-mainapp` or `oap-mainapp21`;
  both there: the one whose HMI, `HmiMain3D` or `Hmi8`, runs), at most 60000, inside none of them and
  not taken: a uid or gid in `/etc/passwd` or `/etc/group`, an `oap_<uid>` folder, MainApp's app
  registry and `uids.txt`, `mainAppUids`, another component's `mgu-uplink/uids.d` entry,
  mgu-updater's `state/uids.json`, a running process's uid or gid;
- no readable MainApp config and no kept uid: none. The log says why; `auth` and `feed` answer with
  the error `no internet uid on the car (see the log)`.

It is written to `state/internet-uids` (component.json `"internet": true, "uids":
"state/internet-uids"`: the deploy tool copies it into `/var/opt/mgu-uplink/uids.d/jap-ridetube-d`) and,
while the uplink is installed, straight into that drop-in (the uplink rescans every 5 s). The unit
starts node with `--max-http-header-size=65536`: the TV page's headers pass 8 kB.

## Rules

- Every exit path releases audio (STOP + `disconnect`): stop, end of file, playback error, app
  gone, SIGTERM, uncaught exception. At start it disconnects every connection with sourceID 1046
  left over (no other) before any play.
- ytdec dies while playing → restarted once at the current clock; a second death → `error`
  `video failed, audio only`, the state stays `playing` and audio continues. No change in
  `stats.decoded` for 5 s while playing with video on → the child is killed (counts as a death).
- Cache: `keep` played ids by dir mtime (default 0: a video is deleted once played), never the
  playing or preparing one. ytfetch stops a download when less than 256 MiB is left free.
- Never exits on its own; uncaught errors → log, release audio, idle.
- Unit: `Restart=on-failure`, `RestartSec=3`, `TimeoutStopSec=5`, `LimitCORE=1`; `recmgr`
  and `crashNames` in `component.json` (recmgr's list counts from the next boot; the unit is
  safe before that: it starts idle and stays active).

## Security notes

- The daemon runs as root: it talks SOME/IP to BMW's MediaPlayer. Every internet request runs as the fetch uid
  instead (above).
- ytdec also runs as root (accepted risk, not verified otherwise on the car). It opens the GPU's render node
  `/dev/dri/renderD128` for the Intel Media SDK and writes the frames to `/dev/shm/mgu-video-ridetube` for
  mgu-render, and running it under another uid was not tested on a head unit. It reads only the video folder
  the daemon names (`--dir`) and takes commands only from the daemon's pipe. It opens no socket and fetches
  nothing.
- `/run/jap-ridetube-d/ctl.sock` is 0660 root:`tm_oap_app`. Every app on the head unit shares that group, so any
  installed app (not only RideTube) can drive the daemon: play, search, read the feeds and the watch history, or
  sign the account in or out. Install only apps you trust.
- The cache (`/var/opt/jap-ridetube-d/cache`) is 0711: the fetch uid reaches its own folders, and nobody else can
  list what was watched. Each video's folder and the thumbnail folder are 0700, and `positions.json` (where each
  video was left, the watch history) is 0600. The account tokens live in `state/` (0700).

## Build and test

    node test/test_ytd.js           # fake someip, fake ytdec, fake fetcher, fake youtube.com
    node test/test_thumb.js         # Node 22+: ffmpeg-made JPEGs (baseline, resampled, progressive via jpegtran); online part skipped offline
    python3.12 -I test/test_ytfetch.py   # ffmpeg fixtures, local Range server (head MP4, ranged == one stream); online part skipped offline
    MGU_STORE=... ./build.sh [path/to/ytdec]   # → dist/jap-ridetube-d@<version>.tgz (default ../ytdec/build/target/ytdec)

`build.sh`: checks ytdec is an x86-64 ELF, runs `tools/build_pyz.sh` (→ `build/ytdlp.pyz`),
`tools/vendor_jpeg.sh` when `vendor/jpeg-js/` is missing, the three tests, copies ytdec into `build/`,
then packs with the MGU Store's `deploy/hu artifact` (`MGU_STORE`; `SOURCE_DATE_EPOCH`: the last commit).
`tools/vendor_jpeg.sh` fetches the pinned jpeg-js tarball (BSD-3-Clause) from the npm registry,
checks its sha512 and keeps only `lib/decoder.js` and `LICENSE`.

Requires (catalog `requires`, installed first): mgu-deploy 0.7.0, mgu-python 1.0.2, jap-node22 22.23.4,
mgu-render 0.6.11 (the video layer).

Overrides (tests): `MGU_YT_SOMEIP`, `MGU_YT_SRCGEN`, `MGU_YT_YTDEC`, `MGU_YT_CACHE`,
`MGU_YT_LOGDIR`, `MGU_YT_SOCK`, `MGU_YT_STATE`, `MGU_YT_ACCOUNT`, `MGU_YT_PROXY`, or the `Daemon` constructor options.
