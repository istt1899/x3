'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// jap-ridetube-d daemon (RideTube): plays a video on the MGU. Audio goes through BMW's
// MediaPlayer over SOME/IP, video through
// ytdec, paced by the MediaPlayer clock. The app talks to it on /run/jap-ridetube-d/ctl.sock (JSON
// lines; README.md has the protocol). Node 8: no ?. / ?? / catch without binding.
// 0.1.6: feed{which, items, shelves:[{title, items}]}, items carry meta (the tile's second line).
// The car fetches (ytfetch.py), searches (InnerTube) and makes thumbs (thumb.js) itself, all as the fetch uid; playback starts while the video is still being fetched.
// It never exits on its own: a stray exception is logged, audio is released, it goes idle.
const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const cp = require('child_process');
const readline = require('readline');
const proxyMod = require('./proxy.js');
const nativeNetwork = require('./network_native.js');

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MEDIA_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SOURCE_ID = 1046, SINK_ID = 1024;
const MEDIA_FILES = ['audio.m4a', 'index.bin', 'video.h264'];
function headName(n) { return n ? 'audio.head.' + n + '.m4a' : 'audio.head.m4a'; }
const CACHE_INTERNAL = ['ytdlp', 'ytc', 'jobs', 'runtime-tools', 'thumbs', 'ytfetch-check', 'youtube', 'vk', 'rutube', 'network-builtin'];
// a video's folder: BMW's media engine (its own uid, no capabilities) opens audio.m4a in it, so it must be able to
// pass through; no read bit, so nobody lists it (and the cache above is 0711: the video ids aren't listed either)
const VIDEO_DIR_MODE = 0o711;
// thumb.rgba length -> [w, h]: 160x90 in caches from older proxies, 320x180 since 0.1.6
const THUMB_SIZES = { 57600: [160, 90], 230400: [320, 180] };
const VERSION = '0.4.7';   // component.json's (test_ytd.js checks): sent with a log report
// the day this build was released (UTC), bumped with VERSION at each release (tools/release.py refuses one in the
// future). An older clock warns the driver because valid TLS certificates can appear not yet valid.
const BUILT = '2026-11-23';
// what `hello` says this build answers for real. The frozen names: health, related, hist (feed hist|liked), ytdlp,
// remote, proxy, stream. A package adds its name here (through the integrator) once its command works
const CAPS = ['related', 'hist', 'health', 'playlists'];
const LANG_RE = /^[a-z]{2}$/, REGION_RE = /^[A-Z]{2}$/;   // hello's lang ("ru") and region ("RU")
// the log relay (send_logs posts <REPORT_URL>/v1/report): the only place reports go. MGU_YT_REPORT_URL or opts.reportUrl override it
const REPORT_URL = null;
const RING_MAX = 1500, REPORT_MAX = 200 * 1024, OS_MAX = 2048; // log lines kept for a report; its log and os caps (bytes)

function defaults() {
    const env = process.env;
    const here = __dirname;
    return {
        someip: env.MGU_YT_SOMEIP || '/usr/lib/someip.node',
        srcGen: env.MGU_YT_SRCGEN || '/usr/lib/oap-mainapp/src-gen',
        // where a service MainApp's src-gen lacks is described from (Audio.descriptions): the unit's SOME/IP catalog, the
        // firmware's own generator (inside AppManagement.js), and kit/tools/oapgen/gen.js (shipped as oapgen.js) to load it
        catalog: env.MGU_YT_CATALOG || '/etc/oap/someip/someip-interfaces.json',
        appMgmt: '/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js',
        oapgen: path.join(here, 'oapgen.js'),
        someipGenCmd: [process.execPath, __filename, '--someip-gen'],
        someipRetryMs: 5000, // the SOME/IP services not up yet (boot): tried again after this
        ytdec: env.MGU_YT_YTDEC || path.join(here, 'ytdec'),
        cacheDir: env.MGU_YT_CACHE || '/var/opt/jap-ridetube-d/cache',
        logDir: env.MGU_YT_LOGDIR || '/var/opt/jap-ridetube-d/log',
        sock: env.MGU_YT_SOCK || '/run/jap-ridetube-d/ctl.sock',
        sockGid: 12202, // tm_oap_app
        embedded: false,
        eventSink: null,
        providerId: 'youtube',
        genericMediaIds: false,
        proxyPolicy: 'youtube',
        accountFile: env.MGU_YT_ACCOUNT || '/var/opt/jap-ridetube-d/state/account.json',
        // an admin-written {"url": "http://user:pass@host:port"} (0600 root). When it parses, all
        // of the service's YouTube traffic goes through it and the uplink preflight is skipped.
        proxyFile: env.MGU_YT_PROXY || '/var/opt/jap-ridetube-d/state/proxy.json',
        reportUrl: env.MGU_YT_REPORT_URL || REPORT_URL,
        reportTimeoutMs: 30000,
        ytRequest: null,     // null: each request in a child as the fetch uid (fetchRequest)
        // the fetch uid's pick (pickFetchUid) and the helper it runs
        stateDir: env.MGU_YT_STATE || '/var/opt/jap-ridetube-d/state',
        etcDir: '/etc',
        oapRoot: '/var/opt/public/oap',
        mgrUid: 12201,       // MainApp's uid: its registry must be owned by it (or root)
        toolRoot: '/var/opt',
        procDir: '/proc',
        mainapps: MAINAPPS,
        fetchCmd: [process.execPath, '--max-http-header-size=65536', __filename, '--fetch'],
        fetcher: ['/var/opt/mgu-python/current/bin/python3', '-I', path.join(here, 'ytfetch.py')],
        thumbCmd: ['/var/opt/jap-node22/current/bin/node', path.join(here, 'thumb.js')],
        startVideoMs: 6000,  // video fetched ahead before playback starts (later the buffering pause covers a slow link)
        fetchRetryMs: [3000, 8000], // a fetch failing before playback (the network): tried again after these waits
        spare: true,         // keep a ytfetch.py serve (yt-dlp loaded) waiting while the app is in use
        warmMs: 600000,      // ... for this long after the app's last command
        infoMaxMs: 1500000,
        leaseFile: '/run/mgu-uplink/lease.json',
        resume: true,        // a play starts where the video was left (positions.json)
        sponsorBlock: 'https://sponsor.ajay.app/api/skipSegments/',
        skip: ['sponsor', 'selfpromo', 'interaction', 'intro'], // SponsorBlock categories skipped (the play's own `skip` wins)
        sbCategories: ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'music_offtopic'], // looked up, sent in extras  // a prefetched stream lookup is used this long (ytfetch: 30 min, URLs: ~6 h)
        headMarginMs: 1500,  // on the head file: wait for audio.m4a this close to the head's end
        audioRetryMs: 1000,  // the audio start (connect + playFile) failed: tried once more after this
        underrunWaitMs: 500, // the player ran dry (underrun): started again at the clock after this
        thumbMax: 150,
        ytTimeoutMs: 10000,
        authTimeoutMs: 25000, // the TV page is large and may be slow over the car's uplink
        authDeadlineMs: 75000, // a sign-in attempt must answer the app, even if a network request stalls
        networkRetryMs: 5500, // mgu-uplink notices a newly registered fetch uid within 5 s
        keep: 0,             // played videos kept in the cache (0: deleted once played; nothing is kept for offline)
        watchdogMs: 5000,
        tickMs: 5000,
        availWaitMs: 5000,
        log: function (m) { console.log(new Date().toISOString() + ' ' + m); }
    };
}

function monoMs() {
    const t = process.hrtime(); // CLOCK_MONOTONIC on Linux
    return Math.floor(t[0] * 1000 + t[1] / 1e6);
}
// the app's Video quality: 360 | 480 | 720, else auto: 720 on Wi-Fi (the uplink's wlan*) or no uplink known, 480 on phone data
function qualityHeight(q, lease) {
    if ([360, 480, 720].indexOf(Number(q)) >= 0) return Number(q);
    return lease && lease.interface && !/^wlan/.test(String(lease.interface)) ? 480 : 720;
}
// members-only (or members-first) videos: a badge somewhere in the tile, its shape unknown (no capture) - matched on the text
// shortcut: a JSON scan of the tile, swap for the badge's field once a real members tile is captured
const isMembers = (t) => /BADGE_STYLE_TYPE_MEMBERS|"Members (only|first)"/i.test(JSON.stringify(t));
// live now or upcoming (a premiere): the overlay's style (LIVE / UPCOMING) or its English text, a lockup's LIVE badge, a
// LIVE_NOW line badge; never a length
// shortcut: the values are YouTube's live enums from its other clients, no TVHTML5 live capture in test/; check on the first one
const LIVE_VALUES = ['LIVE', 'UPCOMING', 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE', 'BADGE_STYLE_TYPE_LIVE_NOW'];
const isLive = (marks, duration) => duration === null && marks.some((x) => LIVE_VALUES.indexOf(x) >= 0);
const REFRESH_SOURCE_ERRORS = ['http_403', 'http_404', 'http_410', 'job_expired'];
const PERMANENT_RE = /unavailable|private|removed|terminated|copyright|members|age|confirm your age|not available in your country|can't be played|can't play|head unit clock/i;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function withTimeout(p, ms, what) {
    return new Promise(function (resolve, reject) {
        const t = setTimeout(function () { reject(new Error(what + ' timed out')); }, ms);
        p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
}
// root-owned trees only: a fetch-uid folder goes through Daemon.rmTree (a symlink swapped in between lstat and
// readdir would point root elsewhere)
function rmrf(p) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
        fs.readdirSync(p).forEach(function (n) { rmrf(path.join(p, n)); });
        fs.rmdirSync(p);
    } else {
        fs.unlinkSync(p);
    }
}
function mkdirp(p) {
    if (fs.existsSync(p)) return;
    mkdirp(path.dirname(p));
    fs.mkdirSync(p, 0o755);
}

// ---------------------------------------------------------------- playback cache (no downloads: a played video goes)
// a file in a folder the fetch uid owns, read by root: no symlink (last component), only a regular file (a FIFO would
// block root, a device feed it forever), ok(size) true; read from that fd. null on anything else (treated as missing)
function readFetchFile(f, ok) {
    let fd = null;
    try {
        fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const st = fs.fstatSync(fd);
        if (!st.isFile() || !ok(st.size)) return null;
        const b = Buffer.alloc(st.size);
        let n = 0, r = 1;
        while (n < b.length && r > 0) { r = fs.readSync(fd, b, n, b.length - n, n); n += r; }
        return n === b.length ? b : null;
    } catch (e) {
        return null;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* closed */ } }
    }
}
const META_MAX = 64 << 10;
function readMeta(dir, id) {
    try {
        const b = readFetchFile(path.join(dir, 'meta.json'), (n) => n <= META_MAX); // ytfetch writes it
        if (!b) throw new Error('no meta');
        const m = JSON.parse(b.toString('utf8'));
        return { id: id, title: m.title || id, channel: m.channel || '', duration_s: m.duration_s || null };
    } catch (e) { return { id: id, title: id, channel: '', duration_s: null }; }
}
// enough to start without a fetch. No video.h264.part: play() stops any fetcher first, so a .part is a
// dead fetch's leftover that would never complete (fetched again instead)
function isPlayable(dir) {
    const has = (n) => fs.existsSync(path.join(dir, n));
    return has('audio.m4a') && !has('audio.m4a.part') && has('index.bin') && has('video.h264');
}
function isReady(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return false; }
    if (names.some(function (n) { return /\.part$/.test(n); })) return false;
    return MEDIA_FILES.every(function (n) { return names.indexOf(n) >= 0; });
}
function listCache(cacheDir, idRe) {
    let names;
    try { names = fs.readdirSync(cacheDir); } catch (e) { return []; }
    const out = [];
    names.forEach(function (n) {
        if (CACHE_INTERNAL.indexOf(n) >= 0) return;
        if (!(idRe || ID_RE).test(n)) return;
        const dir = path.join(cacheDir, n);
        let st;
        try { st = fs.statSync(dir); } catch (e) { return; }
        if (!st.isDirectory()) return;
        const item = readMeta(dir, n);
        item.ready = isReady(dir);
        item.mtime = st.mtime.getTime();
        out.push(item);
    });
    out.sort(function (a, b) { return b.mtime - a.mtime; });
    return out;
}
// SponsorBlock answers, cache/.sb/<id>.json: root's (0700), never in a video's folder, which the fetch uid owns
const SB_DIR = '.sb';
// Keep the `keep` most recent ids (dir mtime); never the protected ones (playing/preparing). rm: how a folder
// goes (the daemon's rmTree; rmrf by default). .sb/<id>.json (SponsorBlock, root's) goes with its video's folder.
function pruneCache(cacheDir, keep, protect, log, idRe, rm) {
    const items = listCache(cacheDir, idRe);
    const removed = [];
    let kept = 0;
    items.forEach(function (it) {
        if (protect.indexOf(it.id) >= 0) { kept++; return; }
        if (kept < keep) { kept++; return; }
        try { (rm || rmrf)(path.join(cacheDir, it.id)); removed.push(it.id); } catch (e) { log('lru: ' + it.id + ': ' + e.message); }
    });
    if (removed.length) log('lru removed ' + removed.join(','));
    const sb = path.join(cacheDir, SB_DIR);
    list(sb).forEach(function (n) {
        const id = n.replace(/\.json$/, '');
        if (protect.indexOf(id) < 0 && !fs.existsSync(path.join(cacheDir, id))) { try { fs.unlinkSync(path.join(sb, n)); } catch (e) { /* gone */ } }
    });
    return removed;
}

// ---------------------------------------------------------------- the fetch uid
// mgu-uplink lets out only the uids it lists, never root: every youtube.com request runs in a child
// as our own "fetch" uid, which the uplink learns from uids.d/jap-ridetube-d (written here, and by the deploy
// tool from state/internet-uids). Picked as mgu-updater's js/uids.js picks its own: the lowest free
// number above MainApp's app uid ranges, kept in state/uids.json while nothing else holds it.
const SELF = 'jap-ridetube-d';
const MAX_UID = 60000; // login.defs UID_MAX
const MAINAPPS = [{ root: '/usr/lib/oap-mainapp', hmi: 'HmiMain3D' }, { root: '/usr/lib/oap-mainapp21', hmi: 'Hmi8' }];
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n'); } catch (e) { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const list = (d) => { try { return fs.readdirSync(d); } catch (e) { return []; } };
const isId = (n) => n > 0 && n === Math.floor(n);
const inRanges = (cfg, u) => !!cfg && cfg.ranges.some((r) => u >= r.min && u <= r.max);

// MainApp's app uid ranges [{min,max}] and own uids, from the config of the MainApp the unit runs; null unknown
function mainappRanges(o) {
    const have = o.mainapps.filter((m) => fs.existsSync(path.join(m.root, 'config', 'base.json')));
    let m = have.length === 1 ? have[0] : null;
    if (have.length > 1) {
        const running = list(o.procDir).filter((n) => /^\d+$/.test(n)).map((n) => (lines(path.join(o.procDir, n, 'comm'))[0] || '').trim());
        const which = have.filter((x) => running.indexOf(x.hmi) >= 0);
        m = which.length === 1 ? which[0] : null;
    }
    const c = m && readJson(path.join(m.root, 'config', 'base.json'));
    if (!c) return null;
    const rse = c.usableUidsAndGidsRse || {};
    const ranges = [c.usableUidsAndGids].concat(Object.keys(rse).map((k) => rse[k]))
        .filter((r) => r && isId(Number(r.min)) && Number(r.max) >= Number(r.min)).map((r) => ({ min: Number(r.min), max: Number(r.max) }));
    return ranges.length ? { ranges: ranges, own: (Array.isArray(c.mainAppUids) ? c.mainAppUids : []).map(Number).filter(isId) } : null;
}
// every uid and gid in use: /etc/passwd and group, OAP apps (oap_<uid> folders, MainApp's registry and
// uids.txt), other components' uplink drop-ins, mgu-updater's uids.json, MainApp's own; procs: running ones
function takenIds(o, cfg, procs) {
    const ids = {};
    const add = (v) => { const n = Number(v); if (String(v).trim() !== '' && isId(n)) ids[n] = true; };
    lines(path.join(o.etcDir, 'passwd')).forEach((l) => { const f = l.split(':'); add(f[2] || ''); add(f[3] || ''); });
    lines(path.join(o.etcDir, 'group')).forEach((l) => add(l.split(':')[2] || ''));
    list(o.oapRoot).forEach((n) => { const m = /^oap_(\d+)$/.exec(n); if (m) add(m[1]); });
    const mgr = path.join(o.oapRoot, 'oap_12201');
    list(path.join(mgr, 'data', 'apps')).forEach((n) => { const e = readJson(path.join(mgr, 'data', 'apps', n)); add(e && e.userId !== undefined ? e.userId : ''); });
    lines(path.join(mgr, 'security', 'uids.txt')).forEach((l) => add(l.split('=')[0]));
    const dropins = path.join(o.toolRoot, 'mgu-uplink', 'uids.d');
    list(dropins).filter((n) => n !== SELF && !/^\./.test(n))
        .forEach((n) => lines(path.join(dropins, n)).forEach((l) => l.split('#')[0].split(/[\s,]+/).forEach(add)));
    const upd = readJson(path.join(o.toolRoot, 'mgu-updater', 'state', 'uids.json')) || {};
    Object.keys(upd).forEach((k) => add(upd[k]));
    // A native UID has no uplink drop-in. Reserve other components' persistent
    // UID files as well, so a later idle service cannot be assigned our UID.
    list(o.toolRoot).filter((name) => name !== SELF && /^[A-Za-z0-9_.-]{1,100}$/.test(name)).forEach((name) => {
        const stored = readJson(path.join(o.toolRoot, name, 'state', 'uids.json')) || {};
        Object.keys(stored).forEach((key) => add(stored[key]));
    });
    (cfg ? cfg.own : []).forEach(add);
    if (procs) {
        list(o.procDir).filter((n) => /^\d+$/.test(n)).forEach((pid) => lines(path.join(o.procDir, pid, 'status')).forEach((l) => {
            const m = /^[UG]id:\s+(.*)$/.exec(l);
            if (m) m[1].split(/\s+/).forEach(add);
        }));
    }
    return ids;
}
function writeIfChanged(file, text, mode) {
    try { if (fs.readFileSync(file, 'utf8') === text) return; } catch (e) { /* not there yet */ }
    fs.writeFileSync(file + '.tmp', text, { mode: mode });
    fs.renameSync(file + '.tmp', file);
}
// the kept fetch uid while nothing else holds it, else a new pick; written for the uplink. null: none (logged)
function pickFetchUid(o) {
    const role = o.uidRole === 'builtin' ? 'builtin' : 'fetch';
    const saved = readJson(path.join(o.stateDir, 'uids.json')) || {};
    const kept = Number(saved[role]);
    const reserved = Number(saved[role === 'builtin' ? 'fetch' : 'builtin']);
    const cfg = mainappRanges(o);
    const inRange = (u) => inRanges(cfg, u);
    let uid = null;
    if (isId(kept) && kept !== reserved && !takenIds(o, cfg, false)[kept] && !inRange(kept)) uid = kept;
    else if (cfg) {
        const all = takenIds(o, cfg, true);
        let u = Math.max.apply(null, cfg.ranges.map((r) => r.max)) + 1;
        while (u <= MAX_UID && (all[u] || u === reserved || inRange(u))) u++;
        if (u <= MAX_UID) { uid = u; o.log('internet uid: ' + u + (isId(kept) ? ' (' + kept + ' is taken)' : '')); }
    }
    if (uid === null) {
        o.log('internet uid: none: ' + (cfg ? 'no free uid below ' + MAX_UID : "MainApp's config/base.json (its app uid ranges) cannot be read"));
        return null;
    }
    if (!fs.existsSync(o.stateDir)) { mkdirp(path.dirname(o.stateDir)); fs.mkdirSync(o.stateDir, 0o700); }
    saved[role] = uid;
    writeIfChanged(path.join(o.stateDir, 'uids.json'), JSON.stringify(saved) + '\n', 0o644);
    // Native requests must never enter the external uplink's UID routing table.
    if (role === 'builtin') return uid;
    writeIfChanged(path.join(o.stateDir, 'internet-uids'), uid + '\n', 0o644);
    const uplink = path.join(o.toolRoot, 'mgu-uplink');
    if (fs.existsSync(path.join(uplink, 'current')) || fs.existsSync(path.join(uplink, 'uids.d'))) {
        try { mkdirp(path.join(uplink, 'uids.d')); writeIfChanged(path.join(uplink, 'uids.d', SELF), uid + '\n', 0o644); } catch (e) { o.log('internet uid: uplink drop-in: ' + e.message); }
    }
    return uid;
}
// one request in a child as uid (fetchCmd: ytd.js --fetch). The request, secrets and all, goes on its stdin
// (argv and env show in ps); {status, body} or {error} comes back on its stdout. Killed past the timeout.
// proxyUrl (the raw URL string): rides inside the stdin JSON, as credentials may not show in argv/env.
function fetchRequest(o, uid, req, proxyUrl) {
    return new Promise(function (resolve, reject) {
        let child;
        try {
            // (o.noSetuid: tests not run as root, which cannot switch uid)
            const ids = o.noSetuid ? {} : { uid: uid, gid: uid };
            child = cp.spawn(o.fetchCmd[0], o.fetchCmd.slice(1), Object.assign(ids, { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'ignore'] }));
        } catch (e) { return reject(e); }
        const chunks = [];
        let size = 0, done = false;
        const finish = function (e, v) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (e) { try { child.kill('SIGKILL'); } catch (x) { /* gone */ } reject(e); } else resolve(v);
        };
        const timer = setTimeout(function () { finish(new Error('timeout')); }, (req.timeoutMs || 10000) + 1000);
        child.on('error', finish);
        child.stdin.on('error', function () { /* it died: close says */ });
        child.stdout.on('data', function (c) {
            size += c.length;
            if (size > 24 << 20) return finish(new Error('answer too big')); // 8 MiB of body, JSON-escaped
            chunks.push(c);
            return undefined;
        });
        child.on('close', function () {
            let r = null;
            try { r = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* none */ }
            if (!r) return finish(new Error('fetch helper gave no answer'));
            if (r.error) return finish(new Error(r.error));
            return finish(null, { status: r.status, body: String(r.body) });
        });
        child.stdin.end(JSON.stringify(Object.assign({}, req, { leaseFile: o.leaseFile }, proxyUrl ? { proxy: proxyUrl } : {})));
    });
}

// ---------------------------------------------------------------- YouTube account: the TV device sign-in (as SmartTube does)
// The car itself talks to www.youtube.com: the TV page's client id + secret (scraped at run time, never
// shipped), a device code the user enters at google.com/device, then TVHTML5 browse for the feeds.
// Tokens live in accountFile (0600, written atomically) and never cross the ctl socket or the log.
const YT = 'https://www.youtube.com';
const TV_UA = 'Mozilla/5.0 (Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1';
const TV_CLIENT = { clientName: 'TVHTML5', clientVersion: '7.20261103.19.00', hl: 'en' };

// TV_CLIENT in hello's language and region (feeds, search, related); English and no region when the app sent none
function tvClient(hl, gl) { return Object.assign({}, TV_CLIENT, hl ? { hl: hl } : {}, gl ? { gl: gl } : {}); }
const CRED_RE = /clientId:"([-\w]+\.apps\.googleusercontent\.com)",\n?[$\w]+:"([-\w]+)"/;
const TV_VERSION_RE = /(?:clientVersion:"|INNERTUBE_CLIENT_VERSION\\?":\\?")(7\.\d{8}\.\d+\.\d+)/;
const SCOPE = 'http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content';
const TOKEN_URL = YT + '/o/oauth2/token';
const FEEDS = { home: 'FEwhat_to_watch', subs: 'FEsubscriptions', wl: 'VLWL', hist: 'FEhistory', liked: 'VLLL' };
const FEED_MAX = 100;   // a feed's, channel's, playlist's, search's or related list's videos (a full feed line stays far under the app's 1 MiB)

// method, url, headers, body (object or null) -> {status, body (utf8)}.
// OAuth accepts form fields; InnerTube uses JSON. No redirects on these URLs.
// via (a parsed proxy from proxy.js): CONNECT/SOCKS5 to it first; DNS then happens behind the proxy.
function ytRequest(method, url, headers, body, timeoutMs, lookup, via, native) {
    return new Promise(function (resolve, reject) {
        const u = require('url').parse(url);
        const oauth = /^\/o\/oauth2\//.test(u.pathname);
        const data = body ? Buffer.from(oauth ? require('querystring').stringify(body) : JSON.stringify(body)) : null;
        const h = Object.assign({ 'User-Agent': TV_UA }, headers || {});
        if (data) {
            h['Content-Type'] = oauth ? 'application/x-www-form-urlencoded' : 'application/json';
            h['Content-Length'] = data.length;
        }
        let done = false, size = 0, req = null;
        const fail = function (e) { if (!done) { done = true; clearTimeout(timer); try { if (req) req.abort(); } catch (x) { /* gone */ } reject(e); } };
        const timer = setTimeout(function () { fail(new Error('timeout')); }, timeoutMs || 10000);
        if (timer.unref) timer.unref();
        const onResponse = function (res) {
            const chunks = [];
            res.on('data', function (c) {
                size += c.length;
                if (size > 8 << 20) { fail(new Error('answer too big')); req.abort(); return; }
                chunks.push(c);
            });
            res.on('end', function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
            });
            res.on('error', fail);
        };
        const start = function () {
            if (done) return;
            // A custom connection has no HTTPS agent to supply its default port.
            // Without this, Node sends Host: www.youtube.com:80 over the TLS tunnel.
            req = https.request({ hostname: u.hostname, port: Number(u.port) || 443, defaultPort: 443,
                path: u.path, method: method, headers: h, lookup: lookup, localAddress: native && native.localAddress || undefined, createConnection: cc || undefined }, onResponse);
            req.on('error', fail);
            if (data) req.write(data);
            req.end();
        };
        let cc = null;
        if (via) {
            if (native && net.isIP(via.host)) nativeNetwork.assertRoute(native, via.host);
            proxyMod.connect(via, u.hostname, Number(u.port) || 443, { timeoutMs: timeoutMs || 10000, lookup: lookup, localAddress: native && native.localAddress || undefined }, function (e, sock) {
                if (e) return fail(e);
                cc = function () { return tls.connect({ socket: sock, servername: u.hostname }); };
                start();
            });
        } else {
            start();
        }
    });
}

const runsText = (x) => (!x ? '' : typeof x.simpleText === 'string' ? x.simpleText
    : Array.isArray(x.runs) ? x.runs.map((r) => (r && r.text) || '').join('') : '');
function hms(s) { return /^\d+(:\d{1,2}){1,2}$/.test(s) ? s.split(':').reduce((a, p) => a * 60 + Number(p), 0) : null; }
// One TVHTML5 tileRenderer -> {id,title,channel,duration_s,meta}, or null when it is not a video (channels,
// playlists). A short (reelWatchEndpoint) is a video with short:true: the app decides whether it shows them. A live
// stream or an upcoming premiere (isLive) has live:true and no length.
// meta: the texts of the second line, without its "•" and badges ("4K").
function tileItem(t) {
    const sel = t.onSelectCommand || {}, short = t.contentType === 'TILE_CONTENT_TYPE_SHORTS';
    const ep = short ? sel.reelWatchEndpoint : sel.watchEndpoint;
    const id = t.contentId || (ep && ep.videoId);
    if ((t.contentType !== 'TILE_CONTENT_TYPE_VIDEO' && !short) || !ID_RE.test(String(id))) return null;
    const m = (t.metadata && t.metadata.tileMetadataRenderer) || {};
    const lines = (Array.isArray(m.lines) ? m.lines : []).map((l) => ((l && l.lineRenderer && l.lineRenderer.items) || [])
        .map((i) => runsText(i && i.lineItemRenderer && i.lineItemRenderer.text)));
    const ovs = (t.header && t.header.tileHeaderRenderer && t.header.tileHeaderRenderer.thumbnailOverlays) || [];
    const ov = ovs.map((x) => x && x.thumbnailOverlayTimeStatusRenderer).filter(Boolean)[0];
    const rp = ovs.map((x) => x && x.thumbnailOverlayResumePlaybackRenderer).filter(Boolean)[0];   // the account's own progress
    const it = { id: id, title: runsText(m.title) || id, channel: (lines[0] || []).join(''), duration_s: hms(runsText(ov && ov.text)),
        meta: (lines[1] || []).filter((x) => x && x.trim() !== '\u2022') };
    if (short) it.short = true;
    if (rp && rp.percentDurationWatched > 0) it.watched_pct = Math.min(100, Number(rp.percentDurationWatched) || 0);
    if (ep && ep.startTimeSeconds > 0) it.start_s = Number(ep.startTimeSeconds);
    if (isMembers(t)) it.members = true;
    const badges = [].concat.apply([], (Array.isArray(m.lines) ? m.lines : []).map((l) => ((l && l.lineRenderer && l.lineRenderer.items) || [])
        .map((i) => { const b = i && i.lineItemRenderer && i.lineItemRenderer.badge; return b && b.metadataBadgeRenderer && b.metadataBadgeRenderer.style; })));
    if (isLive([ov && ov.style, runsText(ov && ov.text).toUpperCase()].concat(badges), it.duration_s)) it.live = true;
    return it;
}
// One TVHTML5 lockupViewModel (search answers, 2026-11) -> the same, or null when not a video: playlists
// (contentId a list) and channels (no watchEndpoint). A short (LOCKUP_CONTENT_TYPE_SHORT, a reelWatchEndpoint) has
// short:true, a live one live:true. meta: the second metadata row, without badges.
function lockupItem(l) {
    const cc = l.rendererContext && l.rendererContext.commandContext;
    const cmd = (cc && cc.onTap && cc.onTap.innertubeCommand) || {};
    const ep = cmd.watchEndpoint || cmd.reelWatchEndpoint, id = ep && ep.videoId;
    if (!ID_RE.test(String(id)) || id !== l.contentId) return null;
    const m = (l.metadata && l.metadata.lockupMetadataViewModel) || {};
    const cm = m.metadata && m.metadata.contentMetadataViewModel;
    const rows = ((cm && cm.metadataRows) || []).map((r) => ((r && r.metadataParts) || []).map((x) => (x && x.text && x.text.content) || '').filter(Boolean));
    const tv = (l.contentImage && l.contentImage.thumbnailViewModel) || {};
    const ov = (tv.overlays || []).map((x) => x && x.thumbnailBottomOverlayViewModel).filter(Boolean)[0];
    const bvs = ((ov && ov.badges) || []).map((x) => x && x.thumbnailBadgeViewModel).filter(Boolean);
    const len = bvs.map((b) => b.text).filter(Boolean)[0];
    const it = { id: id, title: (m.title && m.title.content) || id, channel: (rows[0] || []).join(''), duration_s: hms(String(len)), meta: rows[1] || [] };
    if (!cmd.watchEndpoint) it.short = true;
    if (isMembers(l)) it.members = true;
    if (isLive([].concat.apply([], bvs.map((b) => [b.badgeStyle, String(b.text || '').toUpperCase()])), it.duration_s)) it.live = true;
    return it;
}
// every video tile (or lockup) under o, in page order, each id once
function videoTiles(o) {
    const out = [], seen = {};
    (function walk(o) {
        if (!o || typeof o !== 'object') return;
        const t = o.tileRenderer || o.lockupViewModel;
        if (t && typeof t === 'object') {
            const it = o.tileRenderer ? tileItem(t) : lockupItem(t);
            if (it && !seen[it.id]) { seen[it.id] = true; out.push(it); }
            return;
        }
        Object.keys(o).forEach((k) => walk(o[k]));
    })(o);
    return out;
}
// A TVHTML5 browse answer -> its video tiles wherever they sit (shelves, tabs, the playlist), each id once.
function feedItems(root) { return videoTiles(root); }
const SHELF_MAX = 8, SHELF_TILES = 12;
// A TVHTML5 browse answer -> [{title, items}], one per shelfRenderer with video tiles, page order. An untitled
// shelf (Subscriptions' per-channel groups) is named after its channel when all its tiles share one.
// No shelfRenderer (Watch later is a playlist): [].
function feedShelves(root) {
    const out = [];
    (function walk(o) {
        if (!o || typeof o !== 'object') return;
        const s = o.shelfRenderer;
        if (s && typeof s === 'object') {
            const items = videoTiles(s.content);
            if (!items.length) return;
            const h = (s.headerRenderer && s.headerRenderer.shelfHeaderRenderer) || {};
            const al = h.avatarLockup && h.avatarLockup.avatarLockupRenderer;
            let title = runsText(al && al.title) || runsText(h.title);
            if (!title && items.every((i) => i.channel === items[0].channel)) title = items[0].channel;
            out.push({ title: title, items: items.slice(0, SHELF_TILES) });
            return;
        }
        Object.keys(o).forEach((k) => walk(o[k]));
    })(root);
    return out.slice(0, SHELF_MAX);
}

// FEchannels (the TV app's "Channels" page: every subscription, A-Z) -> [{id, title, handle}], each channel once
const CHAN_RE = /^UC[\w-]{22}$/;
function channelTiles(root) {
    const out = [], seen = {};
    (function walk(o) {
        if (!o || typeof o !== 'object') return;
        const t = o.tileRenderer;
        if (t && typeof t === 'object') {
            const ep = t.onSelectCommand && t.onSelectCommand.browseEndpoint, id = t.contentId || (ep && ep.browseId);
            if (t.contentType !== 'TILE_CONTENT_TYPE_CHANNEL' || !CHAN_RE.test(String(id)) || seen[id]) return;
            const m = (t.metadata && t.metadata.tileMetadataRenderer) || {};
            const lines = (Array.isArray(m.lines) ? m.lines : []).map((l) => ((l && l.lineRenderer && l.lineRenderer.items) || [])
                .map((i) => runsText(i && i.lineItemRenderer && i.lineItemRenderer.text)).join(''));
            seen[id] = true;
            out.push({ id: id, title: runsText(m.title) || id, handle: lines.filter((x) => x.charAt(0) === '@')[0] || '' });
            return;
        }
        Object.keys(o).forEach((k) => walk(o[k]));
    })(root);
    return out;
}

// The TV app's Playlists page (FEplaylist_aggregation) -> the account's playlists [{id, title, count, meta, thumb}], each once, page order.
// A tileRenderer (TILE_CONTENT_TYPE_PLAYLIST) or a lockupViewModel (LOCKUP_CONTENT_TYPE_PLAYLIST). id: the playlist's
// (its browse id without "VL"); count: the "N videos" text, null when none; meta: the other texts ("Private", "Updated
// today"); thumb: the video whose picture the tile shows (thumb{id} makes it), null when none. Watch later is skipped:
// the app has it as a page of its own.
const PL_RE = /^[\w-]{2,64}$/;
const isPl = (x) => typeof x === 'string' && PL_RE.test(x);
function playlistTiles(root) {
    const out = [], seen = { WL: true };
    const plId = (c) => {
        const be = c && c.browseEndpoint, wp = c && (c.watchPlaylistEndpoint || c.watchEndpoint);
        if (be && /^VL[\w-]{2,64}$/.test(String(be.browseId))) return be.browseId.slice(2);
        return (wp && wp.playlistId) || null;
    };
    const vidOf = (url) => { const m = /\/vi(?:_webp)?\/([\w-]{11})\//.exec(String(url || '')); return m ? m[1] : null; };
    const firstVid = (o) => {                      // the first thumbnail URL under o that names a video
        let v = null;
        (function walk(x) {
            if (v || !x || typeof x !== 'object') return;
            if (typeof x.url === 'string') v = vidOf(x.url);
            Object.keys(x).forEach((k) => walk(x[k]));
        })(o);
        return v;
    };
    const add = (id, title, texts, thumb) => {
        if (!isPl(id) || seen[id]) return;
        seen[id] = true;
        const COUNT = /^(?:([\d.,\s]+)|no)\s+videos?$/i, n = texts.map((s) => COUNT.exec(s.trim())).filter(Boolean)[0];
        out.push({ id: id, title: title || id, count: n ? Number((n[1] || '0').replace(/[^\d]/g, '')) : null,
            meta: texts.filter((s) => s && s.trim() !== '•' && !COUNT.test(s.trim())), thumb: thumb || null });
    };
    (function walk(o) {
        if (!o || typeof o !== 'object') return;
        const t = o.tileRenderer, l = o.lockupViewModel;
        if (t && typeof t === 'object' && /PLAYLIST/.test(String(t.contentType))) {
            const m = (t.metadata && t.metadata.tileMetadataRenderer) || {};
            const texts = [].concat(...(Array.isArray(m.lines) ? m.lines : []).map((x) => ((x && x.lineRenderer && x.lineRenderer.items) || [])
                .map((i) => runsText(i && i.lineItemRenderer && i.lineItemRenderer.text))));
            const ov = ((t.header && t.header.tileHeaderRenderer && t.header.tileHeaderRenderer.thumbnailOverlays) || [])
                .map((x) => runsText(x && x.thumbnailOverlayTimeStatusRenderer && x.thumbnailOverlayTimeStatusRenderer.text)).filter(Boolean);
            const ep = t.onSelectCommand || {};
            add(plId(ep) || t.contentId, runsText(m.title), ov.concat(texts).filter(Boolean),
                (ep.watchEndpoint && ID_RE.test(String(ep.watchEndpoint.videoId)) && ep.watchEndpoint.videoId) || firstVid(t.header));
            return;
        }
        if (l && typeof l === 'object' && /PLAYLIST/.test(String(l.contentType))) {
            const m = (l.metadata && l.metadata.lockupMetadataViewModel) || {};
            const cm = m.metadata && m.metadata.contentMetadataViewModel;
            const texts = [].concat(...((cm && cm.metadataRows) || []).map((r) => ((r && r.metadataParts) || []).map((x) => (x && x.text && x.text.content) || '')));
            const badges = [];
            (function walk(x) {
                if (!x || typeof x !== 'object') return;
                if (x.thumbnailBadgeViewModel && typeof x.thumbnailBadgeViewModel.text === 'string') badges.push(x.thumbnailBadgeViewModel.text);
                Object.keys(x).forEach((k) => walk(x[k]));
            })(l.contentImage);
            const cc = l.rendererContext && l.rendererContext.commandContext, cmd = (cc && cc.onTap && cc.onTap.innertubeCommand) || {};
            add(plId(cmd) || l.contentId, m.title && m.title.content, badges.concat(texts).filter(Boolean), firstVid(l.contentImage));
            return;
        }
        Object.keys(o).forEach((k) => walk(o[k]));
    })(root);
    return out;
}
// A playlist page's name (its header: TVHTML5's entityMetadataRenderer, 2026-11), or ''
function playlistTitle(root) {
    let t = '';
    (function walk(o) {
        if (t || !o || typeof o !== 'object') return;
        const h = o.entityMetadataRenderer || o.playlistHeaderRenderer || o.pageHeaderViewModel;
        if (h) { t = runsText(h.title) || (h.title && h.title.dynamicTextViewModel && h.title.dynamicTextViewModel.text && h.title.dynamicTextViewModel.text.content) || ''; if (t) return; }
        Object.keys(o).forEach((k) => walk(o[k]));
    })(root);
    return t;
}
// playlist/get_add_to_playlist (the Save to playlist list: the playlists the account owns) -> as playlistTiles, with
// no count; meta: its privacy ("Private"); thumb: the video its picture shows, when it names one. Watch later skipped.
function addToPlaylistItems(root) {
    const out = [], seen = { WL: true };
    (function walk(o) {
        if (!o || typeof o !== 'object') return;
        const p = o.playlistAddToOptionRenderer;
        if (p && typeof p === 'object') {
            const id = p.playlistId;
            if (!isPl(id) || seen[id]) return;
            seen[id] = true;
            const pv = String(p.privacy || ''), m = /\/vi(?:_webp)?\/([\w-]{11})\//.exec(JSON.stringify(p.thumbnailRenderer || {}));
            out.push({ id: id, title: runsText(p.title) || id, count: null, meta: pv ? [pv.charAt(0) + pv.slice(1).toLowerCase()] : [], thumb: m ? m[1] : null });
            return;
        }
        Object.keys(o).forEach((k) => walk(o[k]));
    })(root);
    return out;
}

// emit(o): to the app. Every method answers with an event and never rejects (a rejection would be a fault).
// client(): the InnerTube client of this connection's language (tvClient); TV_CLIENT when not given
function Account(opts, emit, client) {
    this.opts = opts;
    this.log = opts.log;
    this.emit = emit;
    this.client = client || (() => TV_CLIENT);
    this.pending = null;     // the device code shown: {cid, sec, device, code, url, interval, expires, timer}
    this.starting = false;
    this.refreshing = null;
    this.feeding = Object.create(null); // which -> the browse in flight, shared by later asks
    this.cred = null;        // the TV page's client id + secret, scraped once a process (again when refused)
    this.gen = 0;            // bumped by sign_out: work started before it saves, shows and re-arms nothing
}
Account.prototype.load = function () {
    try {
        const a = JSON.parse(fs.readFileSync(this.opts.accountFile, 'utf8'));
        return a && (a.refresh || a.access) ? a : null;
    } catch (e) { return null; }
};
Account.prototype.save = function (a) {
    const f = this.opts.accountFile, tmp = f + '.tmp', dir = path.dirname(f);
    if (!fs.existsSync(dir)) { mkdirp(path.dirname(dir)); fs.mkdirSync(dir, 0o700); }
    try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify(a)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
};
Account.prototype.json = function (method, url, body, headers) {
    return this.opts.ytRequest(method, url, headers || null, body || null, this.opts.ytTimeoutMs).then((r) => {
        let j = null;
        try { j = JSON.parse(r.body); } catch (e) { /* not JSON */ }
        return { status: r.status, j: j };
    });
};
Account.prototype.client = function () {
    const a = this.load();
    const ver = (a && a.ver) || (this.cred && this.cred.ver) || TV_CLIENT.clientVersion;
    return Object.assign({}, TV_CLIENT, { clientVersion: ver });
};
Account.prototype.status = function () {
    if (this.load()) return { ev: 'auth', state: 'signed_in' };
    const p = this.pending;
    if (p && Date.now() < p.expires) return { ev: 'auth', state: 'code', code: p.code, url: p.url, expires: Math.round((p.expires - Date.now()) / 1000) };
    return { ev: 'auth', state: 'signed_out' };
};
// the TV page's client id + secret: inline in the page (2026-11), else in its base script
Account.prototype.creds = async function () {
    const get = (u) => this.opts.ytRequest('GET', u, null, null, this.opts.ytTimeoutMs).then((r) => {
        if (r.status !== 200) throw new Error('tv page ' + r.status);
        return r.body;
    });
    const page = await get(YT + '/tv');
    let m = CRED_RE.exec(page);
    let v = TV_VERSION_RE.exec(page);
    const re = /src="(\/s\/[^"]+(?:\/base\.js|m=base))"/g;
    let s;
    // A current /tv page already has both credentials and its escaped
    // INNERTUBE_CLIENT_VERSION. Do not download the large base script just to
    // refresh a version; issuing a device code should take one page request.
    while (!m && (s = re.exec(page))) {
        const script = await get(YT + s[1]);
        if (!m) m = CRED_RE.exec(script);
        if (!v) v = TV_VERSION_RE.exec(script);
    }
    if (!m) throw new Error('no client id in the TV page');
    return { cid: m[1], sec: m[2], ver: v ? v[1] : TV_CLIENT.clientVersion };
};
// `auth`: signed in or a code still valid -> said again; else a new device code, then polled until used or expired
Account.prototype.start = async function () {
    if (this.status().state !== 'signed_out') return this.emit(this.status());
    if (this.starting) return undefined; // its answer comes
    this.starting = true;
    const g = this.gen;
    const deadline = Date.now() + (Number(this.opts.authDeadlineMs) || 75000);
    // Bound the entire attempt, not only each HTTP request. A late response cannot
    // issue a code: only the awaited result below can change account state.
    const step = (stage, work) => {
        const left = deadline - Date.now();
        if (left <= 0) return Promise.reject(new Error('sign-in ' + stage + ': timeout'));
        return withTimeout(Promise.resolve().then(work), left, stage).catch((e) => {
            const msg = e.message === stage + ' timed out' ? 'timeout' : e.message;
            throw new Error('sign-in ' + stage + ': ' + msg);
        });
    };
    const ask = (c) => this.json('POST', YT + '/o/oauth2/device/code',
        { client_id: c.cid, scope: SCOPE, device_id: crypto.randomBytes(16).toString('hex'), device_model: 'ytlr::' });
    try {
        const cached = !!this.cred;
        let c = this.cred || (this.cred = await step('TV credentials', () => this.creds()));
        if (g !== this.gen) return undefined;
        let r = await step('device code', () => ask(c));
        if (g !== this.gen) return undefined;
        if (cached && !(r.j && r.j.device_code)) { // the cached client refused: scrape the page again, once
            this.cred = null;
            c = this.cred = await step('TV credentials', () => this.creds());
            if (g !== this.gen) return undefined;
            r = await step('device code', () => ask(c));
            if (g !== this.gen) return undefined;
        }
        const j = r.j || {};
        if (!j.user_code || !j.device_code) throw new Error('device code refused: ' + (j.error || r.status));
        this.pending = { cid: c.cid, sec: c.sec, ver: c.ver, device: j.device_code, code: String(j.user_code), url: j.verification_url || 'https://www.google.com/device',
            interval: Number(j.interval) > 0 ? Number(j.interval) * 1000 : 5000, expires: Date.now() + (Number(j.expires_in) || 1800) * 1000 };
        this.log('sign-in: code issued');
        this.emit(this.status());
        this.poll(this.pending);
    } catch (e) {
        this.log('sign-in: ' + e.message);
        if (g === this.gen) this.emit({ ev: 'auth', state: 'error', msg: e.message });
    } finally {
        this.starting = false;
    }
    return undefined;
};
Account.prototype.poll = function (p) {
    p.timer = setTimeout(() => this.pollOnce(p).catch((e) => {
        this.log('sign-in: ' + e.message);
        if (this.pending === p) { this.pending = null; this.emit({ ev: 'auth', state: 'error', msg: e.message }); }
    }), p.interval);
};
Account.prototype.pollOnce = async function (p) {
    if (this.pending !== p) return undefined;
    if (Date.now() >= p.expires) {
        this.pending = null;
        this.log('sign-in: code expired');
        return this.emit({ ev: 'auth', state: 'signed_out' });
    }
    let r;
    try {
        r = await this.json('POST', TOKEN_URL, { client_id: p.cid, client_secret: p.sec, code: p.device, grant_type: 'http://oauth.net/grant_type/device/1.0' });
    } catch (e) {
        this.log('sign-in poll: ' + e.message); // offline a moment: ask again until the code expires
        return this.pending === p ? this.poll(p) : undefined;
    }
    if (this.pending !== p) return undefined;
    const j = r.j || {};
    if (j.access_token) {
        this.pending = null;
        this.save({ cid: p.cid, sec: p.sec, ver: p.ver, access: j.access_token, refresh: j.refresh_token || null, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
        this.log('sign-in: signed in');
        return this.emit({ ev: 'auth', state: 'signed_in' });
    }
    if (j.error === 'slow_down') p.interval += 5000;
    if (j.error === 'authorization_pending' || j.error === 'slow_down') return this.poll(p);
    this.pending = null;
    this.log('sign-in: ' + (j.error || 'token ' + r.status));
    return this.emit(j.error === 'access_denied' || j.error === 'expired_token' ? { ev: 'auth', state: 'signed_out' } : { ev: 'auth', state: 'error', msg: j.error || 'token ' + r.status });
};
Account.prototype.signOut = function () {
    this.gen++;
    this.refreshing = null;
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.drop('asked');
};
Account.prototype.drop = function (why) {
    try { fs.unlinkSync(this.opts.accountFile); } catch (e) { /* none */ }
    this.log('account: signed out (' + why + ')');
    this.emit({ ev: 'auth', state: 'signed_out' });
};
// an access token with 5 min left at least: refreshed when not (force: anyway), one refresh at a time
Account.prototype.token = function (force) {
    const a = this.load();
    const out = new Error('signed out');
    out.signedOut = true;
    if (!a) return Promise.reject(out);
    if (!force && a.access && a.exp - Date.now() > 5 * 60000) return Promise.resolve(a.access);
    if (!this.refreshing) {
        const p = this.refresh(a, out), done = () => { if (this.refreshing === p) this.refreshing = null; };
        this.refreshing = p;
        p.then(done, done);
    }
    return this.refreshing;
};
Account.prototype.refresh = async function (a, out) {
    if (!a.refresh) { this.drop('token expired'); throw out; }
    const g = this.gen;
    const r = await this.json('POST', TOKEN_URL, { client_id: a.cid, client_secret: a.sec, refresh_token: a.refresh, grant_type: 'refresh_token' });
    if (g !== this.gen) throw out; // signed out meanwhile: the new token is not kept
    const j = r.j || {};
    if (j.access_token) {
        a.access = j.access_token;
        a.exp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
        if (j.refresh_token) a.refresh = j.refresh_token;
        this.save(a);
        this.log('account: token refreshed');
        return a.access;
    }
    if (j.error === 'invalid_grant') { this.drop('invalid_grant'); throw out; } // revoked or expired: sign in again
    throw new Error('refresh: ' + (j.error || r.status));
};
Account.prototype.browse = function (browseId, token, client) {
    return this.json('POST', YT + '/youtubei/v1/browse', { context: { client: client || this.client() }, browseId: browseId }, { Authorization: 'Bearer ' + token });
};
// `feed` {which: home|subs|wl|hist|liked} -> feed{which, items, shelves} or feed{which, error}; hist is the account's
// watch history (FEhistory), liked its Liked videos (VLLL). Signed out: error 'signed out', as every feed
Account.prototype.feed = function (which, emit, locale) {
    which = String(which);
    const reply = emit || this.emit;
    if (typeof FEEDS[which] !== 'string') {
        reply({ ev: 'feed', which: which, error: 'unknown feed' });
        return Promise.resolve();
    }
    const client = locale ? tvClient(locale.lang, locale.region) : this.client();
    const key = [this.gen, which, client.hl, client.gl].join('/');
    if (!this.feeding[key]) {
        const done = () => { delete this.feeding[key]; };
        const request = this.feeding[key] = this.loadFeed(which, client);
        request.then(done, done);
        if (!emit) request.then(reply);
    }
    if (emit) return this.feeding[key].then(reply);
    return this.feeding[key].then(() => undefined);
};
Account.prototype.loadFeed = async function (which, client) {
    const g = this.gen;
    try {
        let r = await this.browse(FEEDS[which], await this.token(false), client);
        if (r.status === 401) r = await this.browse(FEEDS[which], await this.token(true), client);
        if (g !== this.gen) throw Object.assign(new Error('signed out'), { signedOut: true });
        if (r.status !== 200 || !r.j) throw new Error('browse ' + r.status);
        return { ev: 'feed', which: which, items: feedItems(r.j).slice(0, FEED_MAX), shelves: feedShelves(r.j) };
    } catch (e) {
        if (!e.signedOut) this.log('feed ' + which + ': ' + e.message);
        return { ev: 'feed', which: which, error: e.signedOut ? 'signed out' : e.noUid ? e.message : 'feed offline' };
    }
};
// `channels` -> channels{items:[{id,title,handle}]} or channels{error}; the list is kept 10 min
// `channel` {id} -> channel{id, items, shelves} (its page: Videos, Popular...) or channel{id, error}
Account.prototype.channels = function () { return this.browseEv({ ev: 'channels' }, 'FEchannels', (j) => ({ items: channelTiles(j) }), 600000); };
Account.prototype.channel = function (id) {
    if (!CHAN_RE.test(String(id))) { this.emit({ ev: 'channel', id: String(id), error: 'bad channel' }); return Promise.resolve(); }
    return this.browseEv({ ev: 'channel', id: id }, id, (j) => ({ items: feedItems(j).slice(0, FEED_MAX), shelves: feedShelves(j) }), 0);
};
// `playlists` -> playlists{items:[{id,title,count,meta,thumb}]} or playlists{error}, never kept. The TV Playlists page;
// when it refuses (seen 2026-11: 404 for an account a while, then 200) or lists none (a page we no longer read:
// every account has Liked videos at least), the Save to playlist list (no counts). That one failing after the
// page's 200: the page's (empty) answer.
// `playlist` {id} -> playlist{id, title, items} (its videos, at most FEED_MAX) or playlist{id, error}
const ANY_VIDEO = 'jNQXAC9IVRw';   // get_add_to_playlist lists the playlists for a video; any public one does
Account.prototype.playlists = async function (emit) {
    emit = emit || this.emit;
    const g = this.gen, call = async (fn) => {
        let r = await fn(await this.token(false));
        if (r.status === 401) r = await fn(await this.token(true));
        if (g !== this.gen) throw Object.assign(new Error('signed out'), { signedOut: true });
        return r;
    };
    try {
        const r = await call((tok) => this.browse('FEplaylist_aggregation', tok, TV_CLIENT));   // English: playlistTiles reads "N videos"
        let items = r.status === 200 && r.j ? playlistTiles(r.j) : null;
        if (!items || !items.length) {
            const q = await call((tok) => this.json('POST', YT + '/youtubei/v1/playlist/get_add_to_playlist',
                { context: { client: TV_CLIENT }, videoIds: [ANY_VIDEO] }, { Authorization: 'Bearer ' + tok }));
            if (q.status === 200 && q.j) items = addToPlaylistItems(q.j);
            else if (!items) throw new Error('playlists ' + r.status + ', save list ' + q.status);
            else this.log('playlists: none on the page, save list ' + q.status);
        }
        emit({ ev: 'playlists', items: items });
    } catch (e) {
        if (!e.signedOut) this.log('playlists: ' + e.message);
        emit({ ev: 'playlists', error: e.signedOut ? 'signed out' : e.noUid ? e.message : 'feed offline' });
    }
    return undefined;
};
Account.prototype.playlist = function (id, emit) {
    emit = emit || this.emit;
    if (!isPl(id)) { emit({ ev: 'playlist', id: String(id), error: 'bad playlist' }); return Promise.resolve(); }
    return this.browseEv({ ev: 'playlist', id: id }, 'VL' + id, (j) => ({ title: playlistTitle(j), items: feedItems(j).slice(0, FEED_MAX) }), 0, emit);
};
Account.prototype.browseEv = async function (head, browseId, parse, keepMs, emit) {
    emit = emit || this.emit;
    const g = this.gen, c = this.kept || (this.kept = {}), k = c[browseId];
    try {
        if (k && keepMs && Date.now() - k.t < keepMs && k.g === g) { emit(Object.assign({}, head, k.v)); return undefined; }
        let r = await this.browse(browseId, await this.token(false));
        if (r.status === 401) r = await this.browse(browseId, await this.token(true));
        if (g !== this.gen) throw Object.assign(new Error('signed out'), { signedOut: true });
        if (r.status !== 200 || !r.j) throw new Error('browse ' + r.status);
        const v = parse(r.j);
        if (keepMs) c[browseId] = { t: Date.now(), g: g, v: v };
        emit(Object.assign({}, head, v));
    } catch (e) {
        if (!e.signedOut) this.log(head.ev + ': ' + e.message);
        emit(Object.assign({}, head, { error: e.signedOut ? 'signed out' : e.noUid ? e.message : 'feed offline' }));
    }
    return undefined;
};
Account.prototype.close = function () {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
};

// ---------------------------------------------------------------- audio: BMW MediaPlayer
// The player's own reading of the item playing (currentItemMetadata: newer firmware's MediaPlayer has it, read-only;
// the older OAP one has only playFile/setTime). Logged, to see whether it found the tags ytfetch writes into the
// file - what the cluster and the media screen show. Keys come as names or as their numbers. Text values are logged
// as their length only: titles and channels must not reach the log a report sends (redactLog matches them whole).
const META_KEYS = { 3: 'TITLE', 5: 'ARTIST', 7: 'ALBUM', 17: 'COVER_FILE', 44: 'LENGTH' };
function metadataLine(v) {
    const out = [];
    (Array.isArray(v) ? v : []).forEach((e) => {
        const k = e && (typeof e.key === 'number' ? META_KEYS[e.key] : e.key);
        if (!k || ['TITLE', 'ARTIST', 'ALBUM', 'COVER_FILE', 'LENGTH'].indexOf(k) < 0) return;
        const x = (e.value && typeof e.value === 'object') ? e.value : { v: e.value };
        const val = x.stringValue !== undefined ? x.stringValue : x.numeric !== undefined ? x.numeric : Object.keys(x).map((n) => x[n])[0];
        out.push(k + (typeof val === 'string' ? '(' + val.length + ' chars)' : '=' + String(val)));
    });
    return out.length ? out.join(' ') : 'no title, artist, album or cover';
}
// The two SOME/IP services' descriptions (the JSON someip.buildProxy takes). Per service, the first source that has it:
// 1. 'MainApp': MainApp's src-gen, made from MainApp's own manifest when MainApp was built (2021 MainApps list neither
//    service: their src-gen has no such file);
// 2. 'catalog': made at start from the unit's catalog (/etc/oap/someip/someip-interfaces.json) by the firmware's own
//    generator, the way MainApp's installer makes an app's someipInterfaces/ (kit/tools/oapgen/gen.js loads it; in a
//    child, ytd.js --someip-gen: the catalog is 5 MB of JSON). The catalog is searched by service id, its name may differ;
// 3. 'built-in': BUILTIN below.
const IFACES = [
    { key: 'CommandControl', id: 'org.genivi.am.commandinterface.CommandControl', serviceId: 0xB020, inst: '1',
        proxy: { instances: '1', attributes: { listOfMainConnections: 'rs' }, methods: ['connect', 'disconnect'] },
        uses: { methods: ['connect', 'disconnect'], fields: ['listOfMainConnections'], events: [] } },
    { key: 'MediaPlayer', id: 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', serviceId: 0xB042, inst: 'OapGenericMedia', proxy: '*',
        uses: { methods: ['sendButtonEvent', 'playFile', 'setTime'], fields: ['playerState', 'currentItemTime'], events: ['playbackErrorEvent'] } }
];
// what a description lacks of our instance and of what this file calls, subscribes to or reads ([]: usable)
function lacking(d, i) {
    if (!d || typeof d !== 'object') return ['everything'];
    const out = d.instances && typeof d.instances[i.inst] === 'number' ? [] : ['instance ' + i.inst];
    Object.keys(i.uses).forEach((kind) => i.uses[kind].forEach((n) => { if (!(d[kind] && d[kind][n])) out.push(n); }));
    return out;
}
const usable = (d, i) => lacking(d, i).length === 0;
// Last resort, used only when MainApp's src-gen and the catalog both lack a service: our own minimal description of the
// two services as our P18_23w44 unit (MainApp 8.3.2) has them, limited to what this file uses (the enums it decodes in
// full, the button enum to the three it sends). Ids, versions or instances may differ on other firmware: then the
// service never answers, and Audio.why says the car does not offer it.
const seqEnum = (names) => ({ t: 'Enum', w: 1, e: names.split(' ').reduce((o, n, i) => { o[n] = i; return o; }, {}) });
const named = (n, t) => Object.assign({ n: n }, t);
const struct = function () { return { t: 'Struct', e: Array.prototype.slice.call(arguments) }; };
const u16 = (n) => ({ n: n, t: 'UInt16' }), u32 = (n) => ({ n: n, t: 'UInt32' });
function builtin(key) {
    const amError = () => named('amError', seqEnum('E_OK E_UNKNOWN E_OUT_OF_RANGE E_NOT_USED E_DATABASE_ERROR E_ALREADY_EXISTS E_NO_CHANGE E_NOT_POSSIBLE E_NON_EXISTENT E_ABORTED E_WRONG_FORMAT E_MAX'));
    const ent = () => struct(named('EntError', seqEnum('OK GENERAL_ERROR BAD_ARGUMENT NOT_SUPPORTED NOT_AVAILABLE DESTINATION_FULL NOT_BOOKMARKABLE NOT_ENOUGH_SIMILAR_MUSIC METADATA_PROVIDER_OUT_OF_DATE MAX_NUMBER_DOWNLOADS_REACHED')));
    const rel = (o) => Object.assign(o, { reliable: true });
    if (key === 'CommandControl') {
        return { name: 'CommandControl', serviceId: 0xB020, version: { major: 1, minor: 1 }, instances: { 1: 1 },
            methods: {
                connect: { id: 1, schema: struct(u16('sourceID'), u16('sinkID')), retSchema: struct(u16('mainConnectionID'), amError()) },
                disconnect: { id: 2, schema: struct(u16('mainConnectionID')), retSchema: struct(amError()) }
            },
            fields: { listOfMainConnections: { schema: { n: 'am_MainConnection_L', t: 'ArrayD', nl: 0, xl: 100,
                e: struct(u16('mainConnectionID'), u16('sourceID'), u16('sinkID'), { n: 'delay', t: 'Int16' },
                    named('connectionState', seqEnum('CS_UNKNOWN CS_CONNECTING CS_CONNECTED CS_DISCONNECTING CS_DISCONNECTED CS_SUSPENDED CS_MAX'))) },
            getter: { id: 22 }, event: { id: 32769, groups: [1] } } },
            events: {},
            eventGroups: { fields: { 32769: [1] }, events: {} } };
    }
    return { name: 'MediaPlayer', serviceId: 0xB042, version: { major: 2, minor: 0 }, instances: { OapGenericMedia: 40 },
        methods: {
            sendButtonEvent: rel({ id: 257, schema: struct(named('button', { t: 'Enum', w: 1, e: { PLAY: 0, PAUSE: 1, STOP: 2 } }), named('action', seqEnum('PRESS RELEASE'))), retSchema: ent() }),
            playFile: rel({ id: 258, schema: struct({ n: 'path', t: 'Utf16D', bo: true }, u32('languageCode')), retSchema: ent() }),
            setTime: rel({ id: 264, schema: struct(u32('newTimeElapsed')), retSchema: ent() })
        },
        fields: {
            playerState: { schema: seqEnum('PLAYER_STATE_UNKNOWN PLAYER_STATE_PLAY PLAYER_STATE_STOP PLAYER_STATE_PAUSE PLAYER_STATE_FAST_FORWARD PLAYER_STATE_FAST_BACKWARD'),
                getter: rel({ id: 1 }), event: rel({ id: 32769, groups: [1] }) },
            currentItemTime: { schema: struct(u32('elapsed'), u32('total')), getter: rel({ id: 15 }), event: rel({ id: 32783, groups: [1] }) }
        },
        events: { playbackErrorEvent: rel({ id: 33025, groups: [101],
            schema: struct(named('event', seqEnum('NO_ERROR ITEM_UNPLAYABLE ITEM_CORRUPTED ITEM_CHANGE_DELAYED ITEM_NO_DATA NO_NETWORK DRM PLAYLIST_EMPTY ITEM_BUFFER_UNDERRUN'))) }) },
        eventGroups: { fields: { 32769: [1], 32783: [1] }, events: { 33025: [101] } } };
}
// os-release's VERSION ("P18_23w44.2-1-3"), for the line saying this car's software lacks the services
function osVersion(etcDir) {
    const m = /^VERSION="?([\w.-]{1,40})"?\s*$/m.exec(String(lines(path.join(etcDir, 'os-release')).join('\n')));
    return m ? m[1] : 'unknown';
}
// "v8.3.2-pr-847.1" (the v: a four-part version would read as an IP address to redactLog and health.clean)
function mainappVersion(srcGen) {
    const dir = path.dirname(srcGen);
    const v = (readJson(path.join(dir, 'package.json')) || {}).version || (readJson(path.join(dir, 'manifest.json')) || {}).version;
    return typeof v === 'string' && /^[\w.+-]{1,40}$/.test(v) ? 'v' + v : 'unknown';
}
const hex = (n) => (typeof n === 'number' ? '0x' + n.toString(16).toUpperCase() : '?');
const ver = (v) => (v && v.major !== undefined ? 'v' + v.major + '.' + v.minor : 'v?');
const instText = (m) => (m && typeof m === 'object' ? Object.keys(m).map((k) => k + '=' + m[k]).join(' ') : 'none');
// ytd.js --someip-gen <catalog> <out.json> <oapgen.js> <keys JSON> (root, OAP_APPMGMT: the generator's bundle): what the
// catalog says of the two services (names and ids only) and, for the keys asked, their descriptions -> out.json
function someipGen(catalog, out, oapgen, keys) {
    const r = { info: {}, descs: {} };
    try {
        const db = JSON.parse(fs.readFileSync(catalog, 'utf8'));
        const ifs = db.interfaces || {}, manifest = { proxies: {} };
        r.db = String(db.version);
        IFACES.forEach((i) => {
            const name = Object.keys(ifs).filter((n) => ifs[n] && ifs[n].serviceId === i.serviceId)[0];
            if (!name) return;
            r.info[i.key] = { name: name, serviceId: i.serviceId, version: ifs[name].version, instances: (db.instanceIDs || {})[name] || null };
            if (keys.indexOf(i.key) >= 0) manifest.proxies[name] = i.proxy;
        });
        if (Object.keys(manifest.proxies).length) {
            const gen = require(oapgen).load('IFConfigGenerator').generate(db, manifest);
            IFACES.forEach((i) => { if (r.info[i.key] && manifest.proxies[r.info[i.key].name]) r.descs[i.key] = gen[r.info[i.key].name] || null; });
        }
    } catch (e) { r.error = String(e && e.message || e).slice(0, 200); }
    fs.writeFileSync(out, JSON.stringify(r), { mode: 0o600 });
}

function Audio(opts, handlers) {
    this.opts = opts;
    this.h = handlers; // {time(v), state(v), error(v)}
    this.cc = null;
    this.mp = null;
    this.connId = null;
    this.descP = null;     // the descriptions, found once (descriptions)
    this.from = null;      // {CommandControl, MediaPlayer}: 'MainApp' | 'catalog' | 'built-in'
    this.diag = [];        // what the report says of the services: the lines logged once
    this.unsupported = null; // the line saying this car lacks the services (why), while it does
}
// -> {CommandControl, MediaPlayer}: each from the first source that has it; once a daemon, never rejects
Audio.prototype.descriptions = function () {
    if (!this.descP) this.descP = this.resolve();
    return this.descP;
};
Audio.prototype.resolve = async function () {
    const o = this.opts, out = {}, from = {};
    const missing = IFACES.filter((i) => {
        const d = readJson(path.join(o.srcGen, i.id.replace(/\./g, '_') + '.json'));
        if (!d) return true;
        out[i.key] = d;
        from[i.key] = 'MainApp';
        return false;
    });
    const hasCatalog = fs.existsSync(o.catalog);
    const cat = missing.length && hasCatalog ? await this.fromCatalog(missing.map((i) => i.key)) : null;
    missing.forEach((i) => {
        const d = cat && cat.descs && cat.descs[i.key];
        if (usable(d, i)) { out[i.key] = d; from[i.key] = 'catalog'; } else { out[i.key] = builtin(i.key); from[i.key] = 'built-in'; }
    });
    this.from = from;
    const diag = IFACES.map((i) => 'someip: ' + i.key + ' from ' + from[i.key]);
    diag.push('someip: MainApp ' + mainappVersion(o.srcGen) + ', catalog ' + (!hasCatalog ? 'missing' : !cat ? 'present, not needed'
        : (cat.db ? 'db v' + cat.db : 'not read') + (cat.error ? ', ' + cat.error : '')));
    if (cat && cat.info) {
        IFACES.forEach((i) => {
            const x = cat.info[i.key];
            diag.push('someip: catalog ' + i.key + ' ' + (!x ? 'none with service id ' + hex(i.serviceId) : (x.name === i.id ? '' : 'named ' + x.name + ' ') + hex(x.serviceId) +
                ' ' + ver(x.version) + ' instances ' + instText(x.instances)));
        });
    }
    // what goes to buildProxy, whatever its source (a src-gen file is used unchecked, as before)
    IFACES.forEach((i) => {
        const d = out[i.key] || {}, miss = lacking(d, i);
        diag.push('someip: in use ' + i.key + ' ' + hex(d.serviceId) + ' ' + ver(d.version) + ' ' + i.inst + '=' +
            (d.instances && d.instances[i.inst] !== undefined ? d.instances[i.inst] : 'none') + (miss.length ? ', lacks ' + miss.join(' ') : ''));
    });
    this.diag = diag;
    diag.forEach((l) => o.log(l));
    return out;
};
// the catalog route (child: ytd.js --someip-gen), into the root-only state folder, made again at each start (a firmware
// update changes the catalog) -> its out.json, or {error}
Audio.prototype.fromCatalog = function (keys) {
    const o = this.opts, f = path.join(o.stateDir, 'someip.json');
    return new Promise((resolve) => {
        try {
            if (!fs.existsSync(o.stateDir)) { mkdirp(path.dirname(o.stateDir)); fs.mkdirSync(o.stateDir, 0o700); }
            try { fs.unlinkSync(f); } catch (e) { /* none yet */ }
        } catch (e) { return resolve({ error: 'state dir: ' + e.message }); }
        return cp.execFile(o.someipGenCmd[0], o.someipGenCmd.slice(1).concat([o.catalog, f, o.oapgen, JSON.stringify(keys)]),
            { timeout: 60000, cwd: '/', env: { OAP_APPMGMT: o.appMgmt }, maxBuffer: 64 << 10 }, (e, stdout, stderr) => {
                const r = readJson(f);
                if (r) return resolve(r);
                const last = String(stderr || '').trim().split('\n').pop();
                return resolve({ error: e && e.killed ? 'generator: no answer in 60 s' : 'generator: ' + (last || (e && e.message) || 'no result').slice(0, 200) });
            });
    });
};
// a failed start -> the reason logged: with a built-in description, the car most likely lacks the service
Audio.prototype.why = function (e) {
    const f = this.from || {};
    const guess = IFACES.some((i) => f[i.key] === 'built-in');
    this.unsupported = guess ? 'This car\'s software (' + osVersion(this.opts.etcDir) + ') does not offer the audio connection RideTube uses' : null;
    return this.unsupported ? this.unsupported + ' (' + e.message + ')' : e.message;
};
// "CommandControl from catalog, MediaPlayer from MainApp; MainApp v8.3.2-pr-847.1" (the health check's audio row), '' before
Audio.prototype.sources = function () {
    if (!this.from) return '';
    return IFACES.map((i) => i.key + ' from ' + this.from[i.key]).join(', ') + '; MainApp ' + mainappVersion(this.opts.srcGen);
};
Audio.prototype.init = async function () {
    if (this.cc && this.mp) return;
    const someip = typeof this.opts.someip === 'string' ? require(this.opts.someip) : this.opts.someip;
    const d = await this.descriptions();
    const cc = await someip.buildProxy(d.CommandControl, IFACES[0].inst);
    await cc.init();
    const mp = await someip.buildProxy(d.MediaPlayer, IFACES[1].inst);
    await mp.init();
    const h = this.h;
    const safe = (fn) => (v) => { try { fn(v); } catch (e) { this.opts.log('someip handler: ' + (e && e.stack || e)); } };
    mp.subscribe({ name: 'playerState', onReceive: safe(h.state) });
    mp.subscribe({ name: 'currentItemTime', onReceive: safe(h.time) });
    mp.subscribe({ name: 'playbackErrorEvent', onReceive: safe(h.error) });
    try {
        const r = mp.subscribe({ name: 'currentItemMetadata', onReceive: safe((v) => this.opts.log('player metadata: ' + metadataLine(v))) });
        if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) { /* not in this firmware's MediaPlayer */ }
    this.cc = cc;
    this.mp = mp;
};
Audio.prototype.waitAvailable = async function () {
    const end = Date.now() + this.opts.availWaitMs;
    while (!(await this.cc.isAvailable())) {
        if (Date.now() > end) throw new Error('CommandControl not available');
        await sleep(100);
    }
};
// At start: a connection from our source left by a killed daemon would hold the sink.
Audio.prototype.dropLeftovers = async function () {
    await this.waitAvailable();
    const list = await this.cc.getValue('listOfMainConnections');
    const ours = (Array.isArray(list) ? list : []).filter((c) => c && c.sourceID === SOURCE_ID);
    for (const c of ours) {
        const r = await this.cc.callMethod('disconnect', { mainConnectionID: c.mainConnectionID }, 5000).catch((e) => String(e));
        this.opts.log('leftover connection ' + c.mainConnectionID + ' disconnect ' + JSON.stringify(r));
    }
    return ours.length;
};
// release() waits for a play in flight, so a stop during connect/playFile still finds connId
Audio.prototype.play = function (file) {
    const p = this.playNow(file);
    this.pending = p.catch(() => {});
    return p;
};
Audio.prototype.playNow = async function (file) {
    await this.init();
    await this.waitAvailable();
    const r = await this.cc.callMethod('connect', { sourceID: SOURCE_ID, sinkID: SINK_ID }, 5000);
    this.opts.log('connect ' + JSON.stringify(r));
    if (!r || (r.amError !== 'E_OK' && r.amError !== 'E_ALREADY_EXISTS')) throw new Error('audio connect: ' + (r && r.amError));
    this.connId = r.mainConnectionID;
    if (this.connId === undefined || this.connId === null) this.connId = -1; // id unknown: release sweeps by source
    const p = await this.mp.callMethod('playFile', { path: file, languageCode: 7695972 }, 5000);
    this.opts.log('playFile ' + JSON.stringify(p));
    if (!p || p.EntError !== 'OK') throw new Error('playFile: ' + (p && p.EntError));
};
// playFile again on the live connection: after a STOP the player needs the file, not PLAY
Audio.prototype.replay = function (file) {
    const p = this.mp.callMethod('playFile', { path: file, languageCode: 7695972 }, 5000).then((r) => {
        this.opts.log('replay ' + JSON.stringify(r));
        if (!r || r.EntError !== 'OK') throw new Error('playFile: ' + (r && r.EntError));
    });
    this.pending = p.catch(() => {}); // release() waits for it, as for play()
    return p;
};
Audio.prototype.button = function (b) {
    if (!this.mp) return Promise.resolve();
    return this.mp.callMethod('sendButtonEvent', { button: b, action: 'PRESS' }, 3000)
        .catch((e) => this.opts.log(b + ' failed: ' + e));
};
// setTime(0) is ignored by the car's player (seen on the car: back to the start, the sound plays on where it was and
// the picture follows it back a second later), so the start is asked as 1 ms
Audio.prototype.seek = function (ms) {
    if (!this.mp) return Promise.resolve();
    return this.mp.callMethod('setTime', { newTimeElapsed: Math.max(1, Math.round(ms)) }, 3000).catch((e) => this.opts.log('setTime failed: ' + e));
};
// Every exit path ends here. Safe to call twice.
Audio.prototype.release = async function () {
    if (this.pending) await this.pending;
    if (this.connId === null) return;
    const id = this.connId;
    this.connId = null;
    await this.button('STOP');
    try {
        if (id === -1) throw new Error('no connection id');
        this.opts.log('disconnect ' + JSON.stringify(await this.cc.callMethod('disconnect', { mainConnectionID: id }, 5000)));
    } catch (e) {
        this.opts.log('disconnect failed: ' + e + '; sweeping source ' + SOURCE_ID);
        await this.dropLeftovers().catch((e2) => this.opts.log('sweep failed: ' + e2));
    }
};

// ---------------------------------------------------------------- log reports: what leaves the car (send_logs)
// text -> the same text with nothing that names the account, the car, the user or what was watched. k: what the daemon
// knows {secrets, titles, ids: {id: 'v'|'p'|'c'}}; salt: one report's, so a video keeps one tag (v#1a2b) in it, and
// reports can't be matched to each other. Node 8: no lookbehind, no named groups, no replaceAll.
function redactLog(text, k, salt, cacheDir) {
    const tag = (kind, id) => kind + '#' + crypto.createHash('sha256').update(salt + id).digest('hex').slice(0, 4);
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const longest = (a, min) => a.filter((x, i) => typeof x === 'string' && x.length >= min && a.indexOf(x) === i).sort((x, y) => y.length - x.length);
    let s = String(text);
    // what the daemon knows, word for word (min lengths: a short value would shred ordinary words)
    longest(k.secrets || [], 6).forEach((x) => { s = s.split(x).join('[secret]'); });
    longest(k.titles || [], 6).forEach((x) => { s = s.split(x).join('[title]'); });
    const ids = k.ids || {};
    longest(Object.keys(ids), 10).forEach((x) => { s = s.split(x).join(tag(ids[x], x)); });
    // tokens, cookies, e-mails
    s = s.replace(/\b(Bearer|OAuth)\s+[\w.~+\/-]+=*/gi, '$1 [secret]')
        .replace(/\bya29\.[\w.-]+/g, '[secret]').replace(/\b1\/\/[\w.-]{20,}/g, '[secret]')
        .replace(/\b((?:access_token|refresh_token|device_code|user_code|client_secret|id_token)["']?\s*[:=]\s*["']?)[^"'&\s,;}]+/gi, '$1[secret]')
        .replace(/\b(Set-Cookie|Cookie)\b\s*[:=].*/gi, '$1: [secret]')
        .replace(/\b(SAPISID|APISID|HSID|SSID|SID|LOGIN_INFO|VISITOR_INFO1_LIVE|YSC|__Secure-[\w-]+)=[^;\s"']+/g, '$1=[secret]')
        .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]');
    // a URL: its scheme and host only (googlevideo URLs carry ip= and signatures; paths carry ids)
    s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\/\s"'<>@]*@)?([^\/\s"'<>?#]+)[^\s"'<>]*/gi, '$1$2')
        // a path with a query and no scheme (urllib3's "with url: /videoplayback?...&ip=..."), a lone ip= value
        .replace(/\/[^\s"'()<>?]*\?[^\s"'()<>]+/g, '/[path]').replace(/\bip=[^&\s"'()]+/gi, 'ip=[ip]');
    // ids by their context: a cache path, the log lines that name one, yt-dlp's "[youtube] <id>:", JSON keys
    if (cacheDir) {
        s = s.replace(new RegExp(esc(cacheDir) + '([^\\s"\']*)', 'g'),
            (x, rest) => cacheDir + rest.replace(/\/([\w-]{11})(?=[\/.]|$)/g, (y, id) => '/' + tag('v', id)));
    }
    s = s.replace(/((?:\bv=|\bwatch\/|\/vi\/|youtu\.be\/|\/shorts\/|\/embed\/|\[youtube\]\s+|\b(?:fetch|thumb|prefetch|play|lru:)\s+|"(?:id|videoId|video_id)"\s*:\s*"))([\w-]{11})(?![\w-])/g,
        (x, pre, id) => pre + tag('v', id))
        .replace(/(lru removed )([\w#,-]+)/g, (x, pre, l) => pre + l.split(',').map((id) => (ID_RE.test(id) ? tag('v', id) : id)).join(','))
        .replace(/((?:\blist=|"playlistId"\s*:\s*"))([\w-]{2,64})/g, (x, pre, id) => pre + tag('p', id))
        .replace(/\bUC[\w-]{22}(?![\w-])/g, (id) => tag('c', id));
    // the car's VIN (17 characters, a letter among them), public IP addresses (v4: not 127/8, 10/8, 172.16/12, 192.168/16)
    s = s.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, (x) => (/[A-Z]/.test(x) ? '[vin]' : x))
        .replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (x, a, b) => {
            a = Number(a); b = Number(b);
            const own = a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
            return own || x.split('.').some((n) => Number(n) > 255) ? x : '[ip]';
        })
        .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}\b/gi, (x) => (/^(fe80|fc|fd)/i.test(x) ? x : '[ip]'));
    return s;
}
// the newest lines that fit in max bytes (a line on its own past max: none)
function lastBytes(ls, max) {
    let size = 0, i = ls.length;
    while (i > 0 && size + Buffer.byteLength(ls[i - 1]) + 1 <= max) size += Buffer.byteLength(ls[--i]) + 1;
    return ls.slice(i);
}
// a file's last n lines (from its last 256 KiB); [] when it can't be read
function tailLines(f, n) {
    try {
        const fd = fs.openSync(f, 'r');
        try {
            const size = fs.fstatSync(fd).size, len = Math.min(size, 256 << 10), b = Buffer.alloc(len);
            fs.readSync(fd, b, 0, len, size - len);
            const ls = b.toString('utf8').split('\n');
            if (len < size) ls.shift();   // cut mid-line
            return ls.filter(Boolean).slice(-n);
        } finally { fs.closeSync(fd); }
    } catch (e) { return []; }
}

// ---------------------------------------------------------------- daemon
function Daemon(o) {
    this.opts = Object.assign(defaults(), o || {});
    // every log line (the daemon's, Account's, Audio's: they all log through opts.log) also goes to a ring for send_logs
    const out = this.opts.log;
    this.ring = [];
    this.opts.log = (m) => {
        this.ring.push(new Date().toISOString() + ' ' + m);
        if (this.ring.length > RING_MAX) this.ring.shift();
        out(m);
    };
    this.log = this.opts.log;
    this.seen = {};        // video/playlist/channel ids the app sent: a log report tags them (see report)
    this.reporting = false;
    this.state = 'idle';
    this.cur = null;      // {id, title, dir, rect, fill, gen}
    this.gen = 0;         // bumps on every play/stop: stale async work checks it
    this.client = null;
    this.child = null;
    this.deaths = 0;
    this.videoOn = true;
    this.paused = false;
    this.elapsed = 0;
    this.total = 0;
    this.stoppedAt = null;
    this.lastTimeEv = 0;
    this.sawPlay = false;
    this.ticking = false;
    this.preparing = null; // id the fetcher is writing
    this.fetcher = null;   // ytfetch.py, as the fetch uid
    this.fetchedMs = Infinity; // video fetched up to there (pts ms)
    this.buffering = false;
    this.head = null;      // {ms,n}: a complete audio prefix currently playing
    this.nextHead = null;  // a longer complete prefix, offered while the transfer continues
    this.headStop = null;  // pending STOP at an empty prefix must finish before replay
    this.switchVideoPaused = false;
    this.seekSeq = 0;
    this.fullReady = false; // audio.m4a complete
    this.headWait = false; // past the head, waiting for audio.m4a: the player is paused, the state buffering
    this.switching = false; // head -> full: the player's events until the seek are the restart's, not ours
    this.settle = null;    // {ms, until}: after the switch, ignore the player's stale times below ms
    this.lastTickAt = 0;
    this.thumbQ = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
    this.thumbN = 0;
    this.timers = [];
    this.ready = new Promise((r) => { this.readyResolve = r; }); // leftover check done
    this.audio = new Audio(this.opts, {
        time: (v) => this.onTime(v),
        state: (v) => this.onPlayerState(v),
        error: (v) => this.onPlaybackError(v)
    });
    this.childFetch = !this.opts.ytRequest;
    if (this.childFetch) this.opts.ytRequest = (m, u, h, b, t) => this.fetch({ method: m, url: u, headers: h, body: b, timeoutMs: t });
    this.fetchUid = null;
    this.account = new Account(this.opts, (o) => this.emit(o), () => tvClient(this.hl, this.gl));
}
// the fetch uid (picked on first need; none: an error naming why, never a crash)
Daemon.prototype.uid = function () {
    if (this.fetchUid === null) {
        try { this.fetchUid = pickFetchUid(this.opts); } catch (e) { this.log('internet uid: ' + e.message); }
    }
    if (this.fetchUid === null) throw Object.assign(new Error('no internet uid on the car (see the log)'), { noUid: true });
    return this.fetchUid;
};
// Run verified HTTPS requests as the fetch uid on the selected network route.
Daemon.prototype.fetch = function (req) {
    this.clockDate();
    let uid;
    try { uid = this.uid(); } catch (e) { return Promise.reject(e); }
    const via = this.proxy();
    // The system resolver alone cannot reach internet names on the MGU. The uplink
    // removes this lease when offline; report that state before a misleading timeout.
    // With a proxy configured the lease is not the uplink anymore: DNS and the route
    // live behind the proxy, so a missing lease must not block the request.
    const online = () => {
        if (via) return;
        const lease = readJson(this.opts.leaseFile);
        if (!lease || !Array.isArray(lease.dns) || !lease.dns.length)
            throw new Error('car internet is offline (MGU Store > Settings > Internet)');
    };
    try { online(); } catch (e) { return Promise.reject(e); }
    const signIn = /^https:\/\/www\.youtube\.com\/(?:tv(?:$|\?)|s\/.*(?:base\.js|m=base)|o\/oauth2\/)/.test(req.url);
    const retryable = /^https:\/\/www\.youtube\.com\/(?:tv(?:$|\?)|s\/.*(?:base\.js|m=base)|o\/oauth2\/device\/code$)/.test(req.url);
    const q = signIn ? Object.assign({}, req, { timeoutMs: Math.max(Number(req.timeoutMs) || 0, this.opts.authTimeoutMs) }) : req;
    const go = () => fetchRequest(this.opts, uid, q, via ? this._proxyRaw : undefined);
    return go().catch((e) => {
        if (!retryable || e.message !== 'timeout') throw e;
        // The first request may precede mgu-uplink's 5 s UID-rule reconciliation.
        this.log('sign-in network timeout; retrying once');
        return sleep(this.opts.networkRetryMs).then(() => { online(); return go(); });
    });
};
// the admin-configured proxy, re-read when proxy.json changes. The parsed value goes to the
// children over stdin/0600 files; the daemon itself never proxies (it never talks to YouTube).
Daemon.prototype.proxy = function () {
    if (this.opts.proxyPolicy === 'direct') return null;
    let st = null;
    try { st = fs.statSync(this.opts.proxyFile); } catch (e) { /* absent: no proxy */ }
    const mtime = st ? st.mtime.getTime() : -1;
    if (this._proxyMtime === mtime) return this._proxy;
    this._proxyMtime = mtime;
    this._proxy = null;
    this._proxyRaw = undefined;
    if (!st) return null;
    const src = readJson(this.opts.proxyFile);
    const via = src && typeof src.url === 'string' ? proxyMod.parse(src.url) : null;
    if (!via) { this.log('proxy: ' + this.opts.proxyFile + ' has no usable url; ignored'); return null; }
    try {
        const run = this.proxyRunFile();
        fs.writeFileSync(run, JSON.stringify({ url: src.url.trim() }), { mode: 0o600 });
        fs.chmodSync(run, 0o600);
        this.chownFetch(run);
    } catch (e) { this.log('proxy: ' + e.message); }
    this.log('proxy: ' + via.type + ' ' + via.host + ':' + via.port + ' (' + this.opts.proxyFile + ')');
    this._proxy = via;
    this._proxyRaw = src.url.trim();
    return via;
};
// the fetch-uid-readable copy for the helper children (cacheDir is 0711, the file 0600 their uid)
Daemon.prototype.proxyRunFile = function () { return path.join(this.opts.cacheDir, 'proxy.json'); };
// extra argv for the helper children; only a path, never credentials
Daemon.prototype.proxyArgs = function () {
    const args = this.opts.leaseFile && this.opts.leaseFile !== '/run/mgu-uplink/lease.json' ? ['--lease', this.opts.leaseFile] : [];
    return this.proxy() ? args.concat(['--proxy-file', this.proxyRunFile()]) : args;
};
// Report clock changes after hello. TLS always verifies certificate dates.
Daemon.prototype.clockDate = function () {
    const clock = clockBehind((this.opts.now || Date.now)());
    if (this.clockSaid !== undefined && clock !== this.clockSaid) {
        this.clockSaid = clock;
        this.emit({ ev: 'clock', clock: clock });
    }
    return clock;
};
// a helper (ytfetch.py, thumb.js) as the fetch uid, as fetchRequest spawns its child
Daemon.prototype.spawnFetchUid = function (cmd, args, stdin) {
    const ids = this.opts.noSetuid ? {} : { uid: this.uid(), gid: this.uid() };
    return cp.spawn(cmd[0], cmd.slice(1).concat(args), Object.assign(ids, { cwd: '/', env: {}, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] }));
};
// yt-dlp's cache dir (5 chars: listCache's 11-char id filter skips it), the fetch uid's. Root makes and chowns only
// this folder (in root's cache/, so it cannot be swapped); everything below it (info/, yt-dlp's files) is the fetcher's
Daemon.prototype.ytc = function () {
    const ytc = path.join(this.opts.cacheDir, 'ytdlp');
    if (!fs.existsSync(ytc)) fs.mkdirSync(ytc, 0o700);
    this.chownFetch(ytc);
    return ytc;
};
// ---- the account's history and resume point, as SmartTube keeps them: /player (signed in) gives the playbackTracking
// URLs; a playback ping at the start, watchtime pings (st..et) every minute, on pause and at the stop (final when done)
Daemon.prototype.trackStart = async function (c) {
    if (this.opts.providerId !== 'youtube') return;
    if (this.account.status().state !== 'signed_in') return;
    try {
        const r = await this.account.json('POST', YT + '/youtubei/v1/player', { context: { client: this.account.client() }, videoId: c.id },
            { Authorization: 'Bearer ' + await this.account.token(false) });
        const pt = (r.j && r.j.playbackTracking) || {};
        const pb = pt.videostatsPlaybackUrl && pt.videostatsPlaybackUrl.baseUrl, wt = pt.videostatsWatchtimeUrl && pt.videostatsWatchtimeUrl.baseUrl;
        if (!/^https:\/\/s\.youtube\.com\//.test(pb) || !/^https:\/\/s\.youtube\.com\//.test(wt) || this.cur !== c) return;
        const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        c.track = { pb: pb, wt: wt, st: 0, at: Date.now(), cpn: Array.from(require('crypto').randomBytes(16), (b) => A[b & 63]).join('') };
        await this.ping(c, false);
    } catch (e) { if (!e.signedOut) this.log('history: ' + e.message); }
};
// watch: false = the playback ping (the start), true = a watchtime ping up to now
Daemon.prototype.ping = async function (c, watch, final) {
    const t = c.track;
    if (!t) return;
    const len = Math.round((c.durationMs || this.total || 0) / 1000), pos = Math.max(0, this.elapsed / 1000).toFixed(1);
    const q = { ns: 'yt', ver: 2, cpn: t.cpn, len: len, cmt: pos };
    if (watch) { q.st = t.st; q.et = pos; t.st = pos; }
    if (final) { q.final = 1; if (watch) q.st = q.et = q.cmt = len; }
    t.at = Date.now();
    const url = (watch ? t.wt : t.pb) + '&' + Object.keys(q).map((k) => k + '=' + encodeURIComponent(q[k])).join('&');
    try {
        const r = await this.opts.ytRequest('GET', url, { Authorization: 'Bearer ' + await this.account.token(false), Referer: 'https://www.youtube.com/tv' }, null, 8000);
        if (r.status >= 300) this.log('history ping ' + r.status);
    } catch (e) { this.log('history ping: ' + e.message); }
};

// ---- where each video was left (positions.json, kept after its files go): resume, Continue watching, progress bars
Daemon.prototype.positions = function () {
    if (!this.pos) this.pos = readJson(path.join(this.opts.cacheDir, 'positions.json')) || {};
    return this.pos;
};
Daemon.prototype.savePos = function (force) {
    const c = this.cur;
    if (!c || !this.total || this.head && !c.durationMs) return;
    if (!force && Date.now() - (this.posAt || 0) < 15000) return;
    this.posAt = Date.now();
    const p = this.positions(), m = readMeta(c.dir, c.id);
    p[c.id] = { ms: this.elapsed, total: this.total, done: this.total - this.elapsed < Math.max(5000, this.total * 0.05),
        at: Date.now(), title: c.title || m.title, channel: m.channel, duration_s: Math.round(this.total / 1000) };
    const ids = Object.keys(p).sort((a, b) => p[b].at - p[a].at);
    ids.slice(300).forEach((id) => { delete p[id]; });
    try {
        const f = path.join(this.opts.cacheDir, 'positions.json');
        fs.writeFileSync(f + '.tmp', JSON.stringify(p), { mode: 0o600 }); // the watch history: root only
        fs.renameSync(f + '.tmp', f);
    } catch (e) { this.log('positions: ' + e.message); }
};
Daemon.prototype.sendPositions = function () {
    const p = this.positions();
    this.emit({ ev: 'positions', items: Object.keys(p).sort((a, b) => p[b].at - p[a].at).map((id) => Object.assign({ id: id }, p[id])) });
};
// ---- chapters (ytfetch's meta) and SponsorBlock segments of the playing video, sent as one 'extras' event
Daemon.prototype.sendExtras = function () {
    const c = this.cur;
    if (c) this.emit({ ev: 'extras', id: c.id, chapters: c.chapters || [], segments: (c.segs || []).map((x) => [x.s, x.e, x.cat]) });
};
Daemon.prototype.loadSegments = async function (c) {
    if (this.opts.providerId !== 'youtube') return;
    // root's own folder: a sb.json in the video's folder (0.3.x) is the fetch uid's to plant a symlink in, never read
    const sb = path.join(this.opts.cacheDir, SB_DIR), f = path.join(sb, c.id + '.json');
    let segs = readJson(f);
    if (!Array.isArray(segs)) {
        const pre = require('crypto').createHash('sha256').update(c.id).digest('hex').slice(0, 4);
        const url = this.opts.sponsorBlock + pre + '?categories=' + encodeURIComponent(JSON.stringify(this.opts.sbCategories)) + '&actionTypes=' + encodeURIComponent('["skip"]');
        let r;
        try { r = await this.opts.ytRequest('GET', url, { 'User-Agent': 'jap-ridetube-d (BMW head unit)' }, null, 8000); } catch (e) { this.log('sponsorblock: ' + e.message); return; }
        segs = [];
        if (r.status === 200) {
            let all = [];
            try { all = JSON.parse(r.body); } catch (e) { /* none */ }
            const v = Array.isArray(all) && all.find((x) => x && x.videoID === c.id);
            ((v && v.segments) || []).forEach((g) => {
                if (g && g.actionType === 'skip' && this.opts.sbCategories.indexOf(g.category) >= 0 && Array.isArray(g.segment))
                    segs.push({ s: Math.round(g.segment[0] * 1000), e: Math.round(g.segment[1] * 1000), cat: g.category });
            });
        } else if (r.status !== 404) return; // 404: none for this video (cached as such); else asked again next play
        try {
            if (!fs.existsSync(sb)) fs.mkdirSync(sb, 0o700);
            fs.writeFileSync(f, JSON.stringify(segs), { mode: 0o600 });
        } catch (e) { this.log('sponsorblock cache: ' + e.message); }
    }
    if (this.cur !== c) return;
    c.segs = segs.filter((x) => x && x.e - x.s >= 1000).sort((a, b) => a.s - b.s);
    if (c.segs.length) this.sendExtras();
};
// a segment the clock entered: seek past it, once per play (a seek back into it plays it)
Daemon.prototype.skipSegments = function () {
    const skip = (this.cur && this.cur.skip) || this.opts.skip;   // the others: the app's (a Skip button, or nothing)
    const seg = ((this.cur && this.cur.segs) || []).find((x) => !x.done && skip.indexOf(x.cat) >= 0 && this.elapsed >= x.s && this.elapsed < x.e - 1000);
    if (!seg) return false;
    seg.done = true;
    this.log('skip ' + seg.cat + ' ' + seg.s + '-' + seg.e);
    this.emit({ ev: 'skipped', category: seg.cat, ms: seg.e - seg.s });
    this.seek(seg.e).catch((e) => this.log('skip: ' + e));
    return true;
};

// ---- speed: a warm ytfetch.py (yt-dlp loaded: ~1.2 s on the car) takes the next job, and the stream lookup
// (~2.5 s) runs while the controller rests on a tile (prefetch), so a play skips both
Daemon.prototype.spawnJob = function (job) {
    this.clockDate();
    const s = this.spare;
    this.spare = null;
    if (s && s.child.exitCode === null && s.child.signalCode === null) { // still loading: serve reads the job once warm
        s.child.stdin.end(JSON.stringify(job) + '\n');
        return s.child;
    }
    if (s) { try { s.child.kill('SIGKILL'); } catch (e) { /* gone */ } }
    const split = job.indexOf('--');
    const args = split < 0 ? job.concat(this.proxyArgs()) : job.slice(0, split).concat(this.proxyArgs(), job.slice(split));
    return this.spawnFetchUid(this.opts.fetcher, args);
};
// from tick: a spare while the app is in use and no fetch is starting; none past warmMs
Daemon.prototype.keepWarm = function () {
    const want = this.opts.spare && this.client && Date.now() < (this.usedAt || 0) + this.opts.warmMs;
    if (!want) {
        if (this.spare) { try { this.spare.child.kill('SIGKILL'); } catch (e) { /* gone */ } this.spare = null; }
        return;
    }
    if (this.spare || (this.preparing && this.state === 'preparing')) return;
    let child;
    try { child = this.spawnFetchUid(this.opts.fetcher, ['serve', '--cache-dir', this.ytc()].concat(this.proxyArgs()), true); } catch (e) { this.log('spare: ' + e.message); return; }
    const s = this.spare = { child: child, warm: false };
    child.stdin.on('error', () => { /* it died: close says */ });
    readline.createInterface({ input: child.stdout }).on('line', (l) => { if (/"ev": ?"warm"/.test(l)) s.warm = true; });
    child.on('error', (e) => this.log('spare: ' + e.message));
    child.on('close', () => { if (this.spare === s) this.spare = null; });
};
Daemon.prototype.infoFile = function (id) { return path.join(this.opts.cacheDir, 'ytdlp', 'info', id + '.json'); };
Daemon.prototype.freshInfo = function (id) {
    try { return Date.now() - fs.statSync(this.infoFile(id)).mtime.getTime() < this.opts.infoMaxMs; } catch (e) { return false; }
};
Daemon.prototype.prefetch = function (id) {
    if (!ID_RE.test(String(id)) || !this.opts.spare) return undefined;
    if (this.extracting) { if (this.extracting.id !== id) this.nextPrefetch = id; return undefined; }
    if (isPlayable(path.join(this.opts.cacheDir, id)) || this.preparing === id || this.freshInfo(id)) return undefined;
    // info/ and its stale files: the fetcher makes and prunes them (extract), root never writes below ytdlp/
    const child = this.spawnJob(['extract', '--cache-dir', this.ytc(), '--', id, this.infoFile(id)]);
    this.keepWarm(); // the play after this lookup finds a spare, not a cold start (the 5 s poll was too late)
    const x = this.extracting = { id: id, child: child, done: null };
    x.done = new Promise((r) => child.on('close', r)).then(() => {
        if (this.extracting === x) this.extracting = null;
        const n = this.nextPrefetch;
        this.nextPrefetch = null;
        if (n) this.prefetch(n);
    });
    child.on('error', (e) => this.log('prefetch: ' + e.message));
    child.stdout.resume();
    readline.createInterface({ input: child.stderr }).on('line', (l) => this.log('ytfetch (prefetch): ' + l));
    return undefined;
};
// hands a folder root just made to the fetch uid. chownSync follows symlinks, so only a direct child of root's
// cache/ (nobody else can swap it); never a path below a fetch-owned folder (a symlink there: any file to the fetch uid)
Daemon.prototype.chownFetch = function (p) {
    if (path.dirname(path.resolve(p)) !== path.resolve(this.opts.cacheDir)) throw new Error('chownFetch outside the cache: ' + p);
    if (!this.opts.noSetuid) fs.chownSync(p, this.uid(), this.uid());
};
// a folder under cache/: a fetch-uid tree is emptied by its owner (rm -rf runs as that uid, so a symlink in it
// reaches nothing that uid could not already touch), then root removes the empty folder (rmdir: never follows one).
// A root-owned tree (or a file) as before. Throws if it stays (logged by the callers), never falls back to root's walk.
Daemon.prototype.rmTree = function (p) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (!st.isDirectory() || st.uid === 0) { rmrf(p); return; }   // root's own: rm never runs as root
    if (inRanges(this.appRanges(), st.uid)) throw new Error('rm ' + p + ': owned by app uid ' + st.uid + ', left alone');
    // the owner (the fetch uid, or one it had before); its gid as every fetch spawn's: the same number
    const ids = this.opts.noSetuid ? {} : { uid: st.uid, gid: st.uid };
    const r = cp.spawnSync('/bin/rm', ['-rf', '--', p], Object.assign(ids, { cwd: '/', env: {}, stdio: 'ignore', timeout: 30000 }));
    if (r.error) this.log('rm ' + p + ': ' + r.error.message);   // (exit 1 is normal: it cannot remove p itself, root's cache/ holds it)
    try { fs.rmdirSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
};

// cache/ must be root's own real folder, else a swapped one points every root step in it elsewhere: refuse to start.
// 0711: the fetch uid reaches its own folders in it, nobody else can list what was watched (a wider mode is fixed)
Daemon.prototype.checkCacheDir = function () {
    const dir = this.opts.cacheDir, me = process.getuid();   // root on the car (a test: its own uid)
    try { mkdirp(dir); } catch (e) { this.log('cache dir: ' + e.message); }
    const refuse = (why) => Object.assign(new Error('cache dir ' + dir + ' ' + why + ': not starting'), { refuse: true });
    let st;
    try { st = fs.lstatSync(dir); } catch (e) { throw refuse(e.message); }
    if (!st.isDirectory()) throw refuse('is not a folder (a symlink?)');
    if (st.uid !== me) throw refuse('is owned by uid ' + st.uid + ', not ' + me);
    if (st.mode & 0o022) this.log('SECURITY: cache dir ' + dir + ' was ' + (st.mode & 0o777).toString(8) + ' (group/other writable): set to 711');
    fs.chmodSync(dir, 0o711);
};
// MainApp's app uid ranges (mainappRanges), kept once read: they do not change while it runs. null: unknown
Daemon.prototype.appRanges = function () {
    if (!this.ranges) this.ranges = mainappRanges(this.opts);
    return this.ranges;
};
Daemon.prototype.start = async function () {
    this.checkCacheDir();
    try { mkdirp(this.opts.logDir); } catch (e) { this.log('log dir: ' + e.message); }
    if (!this.opts.embedded) this.listen();
    // the uplink learns our fetch uid at start (its 5 s rescan), before anyone signs in
    if (this.childFetch && this.fetchUid === null) { try { this.fetchUid = pickFetchUid(this.opts); } catch (e) { this.log('internet uid: ' + e.message); } }
    this.timers.push(setInterval(() => this.guard(() => this.watchdog()), 1000));
    this.timers.push(setInterval(() => this.guard(() => this.keepWarm()), this.opts.tickMs));
    this.timers.push(setInterval(() => this.guard(() => this.lockSocket()), this.opts.tickMs));   // a reinstall can change the app's uid
    this.keepWarm();
    this.prune();
    // The SOME/IP services may come up after us at boot: retry until the leftover check ran (logged when the reason changes)
    for (let last = null; ;) {
        try {
            await this.audio.init();
            await this.audio.dropLeftovers();
            this.audio.unsupported = null;
            if (last) this.log('someip ready');
            this.readyResolve();
            break;
        } catch (e) {
            const why = this.audio.why(e);
            if (why !== last) this.log('someip not ready: ' + why);
            last = why;
            await sleep(this.opts.someipRetryMs);
        }
    }
};
Daemon.prototype.guard = function (fn) {
    try {
        const r = fn();
        if (r && r.catch) r.catch((e) => this.fault(e));
    } catch (e) {
        this.fault(e);
    }
};
// uncaughtException / unhandledRejection / handler errors: log, release audio, idle.
Daemon.prototype.fault = function (e) {
    this.log('fault: ' + (e && e.stack || e));
    this.emit({ ev: 'error', msg: 'internal error: ' + (e && e.message || e) });
    this.stop('idle').catch((e2) => this.log('stop after fault: ' + e2));
};

// ---- control socket
Daemon.prototype.listen = function () {
    const sock = this.opts.sock;
    try { mkdirp(path.dirname(sock)); } catch (e) { this.log('socket dir: ' + e.message); }
    try { fs.unlinkSync(sock); } catch (e) { /* none */ }
    this.server = net.createServer((c) => this.guard(() => this.onClient(c)));
    this.server.on('error', (e) => this.log('ctl server: ' + e.message));
    this.server.listen(sock, () => {
        this.sockUid = undefined;   // nothing applied yet: lockSocket sets the mode and logs it
        this.lockSocket();
        this.log('listening on ' + sock);
    });
};
// the uid MainApp's registry gives RideTube's app (apps/jap_ridetube.json userId), null if it cannot be read or is
// not an app's: an integer (or all-digit string) inside MainApp's app uid ranges (unchecked while those are unknown),
// never the fetch uid
Daemon.prototype.appUid = function () {
    const f = path.join(this.opts.oapRoot, 'oap_12201', 'data', 'apps', 'jap_ridetube.json');
    const e = this.regOk(f) ? readJson(f) : null;
    const v = e && e.userId;
    const u = typeof v === 'number' || typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
    return this.okAppUid(u) ? u : null;
};
Daemon.prototype.okAppUid = function (u) {
    const cfg = this.appRanges();
    return isId(u) && u <= MAX_UID && u !== this.fetchUid && (!cfg || inRanges(cfg, u));
};
// the last good app uid, kept in state/app-uid.json (root's): a failed registry read keeps it, a restart too
Daemon.prototype.knownAppUid = function () {
    const f = path.join(this.opts.stateDir, 'app-uid.json');
    if (this.lastAppUid === undefined) {
        const k = Number((readJson(f) || {}).uid);
        this.lastAppUid = this.okAppUid(k) ? k : null;
    }
    const u = this.appUid();
    if (u === null && this.lastAppUid !== null && this.appRemoved()) {
        // uninstalled (or mid-reinstall): its old uid may go to another app, so root only until an entry comes back
        if (!this.regGone) this.log('ctl.sock: RideTube is no longer in MainApp\'s registry: root only');
        this.regGone = true;
        return 0;
    }
    this.regGone = false;
    if (u === null) {
        if (this.lastAppUid !== null && !this.regBad) this.log('ctl.sock: no valid app uid in MainApp\'s registry: kept ' + this.lastAppUid);
        this.regBad = true;
        return this.lastAppUid;
    }
    this.regBad = false;
    if (u !== this.lastAppUid) {
        this.lastAppUid = u;
        try {
            if (!fs.existsSync(this.opts.stateDir)) { mkdirp(path.dirname(this.opts.stateDir)); fs.mkdirSync(this.opts.stateDir, 0o700); }
            writeIfChanged(f, JSON.stringify({ uid: u }) + '\n', 0o600);
        } catch (e) { this.log('app uid: ' + e.message); }
    }
    return u;
};
// true when MainApp's apps folder lists fine and has no jap_ridetube.json (a read error is not a removal)
Daemon.prototype.appRemoved = function () {
    const d = path.join(this.opts.oapRoot, 'oap_12201', 'data', 'apps');
    try { return this.regOk(d) && fs.readdirSync(d).indexOf('jap_ridetube.json') < 0; }
    catch (e) { return false; }
};
// every app can write /var/opt/public/oap (group mgu_persist), so one could rename oap_12201 and plant its own
// registry: trust a path only when each part from oap_12201 down is no symlink, owned by MainApp (or root) and not
// world-writable
Daemon.prototype.regOk = function (p) {
    const top = path.join(this.opts.oapRoot, 'oap_12201'), parts = path.relative(top, p).split(path.sep);
    let cur = top;
    for (let i = 0; i <= parts.length; i++) {
        if (i > 0) cur = path.join(cur, parts[i - 1]);
        let st;
        try { st = fs.lstatSync(cur); } catch (e) { return false; }
        if (st.isSymbolicLink() || (st.uid !== this.opts.mgrUid && st.uid !== 0) || (st.mode & 0o002)) {
            if (!this.regUntrusted) this.log('ctl.sock: MainApp\'s registry is not MainApp\'s (' + cur + '): ignored');
            this.regUntrusted = true;
            return false;
        }
    }
    this.regUntrusted = false;
    return true;
};
// ctl.sock belongs to the app's uid alone (<uid>:root 0600): no other app can play, read feeds or sign out. Shared
// (0660 root:tm_oap_app, every app can connect) only while no app uid was ever known (a fresh install whose registry
// cannot be read). Applied only when it changes, logged then; a connection made before a change is dropped (the app
// reconnects every 2 s under the new owner). A failed chown keeps the previous owner (root only if none), never shared.
// sockUid (read it through sockShared()): the uid it is locked to, 0 root only, null while shared, undefined before listen
Daemon.prototype.lockSocket = function () {
    if (!this.server || !this.server.listening) return;
    const u = this.knownAppUid(), sock = this.opts.sock, was = this.sockUid;
    if (u === was) return;
    try {
        if (u === null) { fs.chmodSync(sock, 0o660); fs.chownSync(sock, 0, this.opts.sockGid); }
        else { fs.chmodSync(sock, 0o600); fs.chownSync(sock, u, 0); }   // closed first, then handed over
        this.log(u === null ? 'ctl.sock: shared with every app (0660 root:tm_oap_app): no app uid known' : u === 0 ? 'ctl.sock: root only (0600)' : 'ctl.sock: app uid ' + u + ' only (0600)');
        this.sockUid = u;
        this.sockErr = null;
    } catch (e) {
        if (u === null) {
            this.sockUid = null;   // shared anyway (0660); the group is best effort (not root: tests)
        } else {
            let back = 0;
            try { if (typeof was === 'number' && was > 0) { fs.chownSync(sock, was, 0); back = was; } } catch (e2) { /* root only */ }
            this.sockUid = back;
        }
        if (e.message !== this.sockErr) this.log('ctl.sock: ' + e.message + (u === null ? ': shared with every app (0660 root:tm_oap_app)' : this.sockUid ? ': kept app uid ' + this.sockUid : ': root only (0600)'));
        this.sockErr = e.message;   // once, not every tick
    }
    if (this.sockUid !== was && was !== undefined && this.client) {
        this.log('ctl.sock: owner changed: the connected client is dropped');
        this.client.destroy();
    }
};
// true while any app on the unit can use the socket (health: "socket: shared with other apps")
Daemon.prototype.sockShared = function () { return typeof this.sockUid !== 'number'; };
Daemon.prototype.onClient = function (c) {
    if (this.client) {
        this.log('new client replaces the old one');
        const old = this.client;
        this.client = null; // its close must not stop playback for the new one
        old.destroy();
    }
    this.client = c;
    this.hl = this.gl = null;   // hello's lang and region hold for this connection only
    this.clockSaid = undefined; // what hello (then `clock`) told this connection about the clock; undefined: no hello yet
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', (d) => {
        buf += d;
        if (buf.length > 65536) { this.log('client line too long'); c.destroy(); return; }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) this.guard(() => this.onLine(line));
        }
    });
    c.on('error', (e) => this.log('client: ' + e.message));
    c.on('close', () => {
        if (this.client !== c) return;
        this.client = null;
        this.log('client gone: stop');
        this.stop('idle').catch((e) => this.log('stop: ' + e));
    });
};
Daemon.prototype.emit = function (o) {
    if (typeof this.opts.eventSink === 'function') return this.opts.eventSink(o);
    if (!this.client) return;
    try { this.client.write(JSON.stringify(o) + '\n'); } catch (e) { this.log('emit: ' + e.message); }
};
Daemon.prototype.onLine = function (line) {
    let m;
    try { m = JSON.parse(line); } catch (e) { return this.emit({ ev: 'error', msg: 'bad json' }); }
    if (!m || typeof m.cmd !== 'string') return this.emit({ ev: 'error', msg: 'no cmd' });
    this.usedAt = Date.now();
    if (typeof m.id === 'string') this.see(m.cmd === 'playlist' ? 'p' : m.cmd === 'channel' ? 'c' : 'v', m.id);
    switch (m.cmd) {
    case 'prefetch': return this.prefetch(m.id);
    case 'positions': return this.sendPositions();
    case 'status': this.sendState(); if (this.total) this.emit({ ev: 'time', elapsed: this.elapsed, total: this.total }); return undefined;
    case 'search': return this.search(m.q);
    case 'thumb': return this.thumb(m.id);
    case 'play': return this.play(m.id, m.rect, !!m.fill, m.at, m.quality, m.skip);
    case 'pause': return this.pause();
    case 'resume': return this.resume();
    case 'seek': return this.seek(m.ms);
    case 'stop': return this.stop('idle');
    case 'video': return this.setVideo(!!m.on);
    case 'fill': return this.setFill(!!m.on);
    case 'quality': return this.requality(m.quality);
    case 'auth': return this.account.start();
    case 'auth_status': return this.emit(this.account.status());
    case 'sign_out': return this.account.signOut();
    case 'feed': return this.account.feed(m.which);
    case 'channels': return this.account.channels();
    case 'channel': return this.account.channel(m.id);
    case 'playlists': return this.account.playlists();
    case 'playlist': return this.account.playlist(m.id);
    case 'send_logs': return this.sendLogs(m.app);
    case 'hello': return this.hello(m);
    case 'health': return this.health();
    case 'related': return this.related(m.id);
    case 'ytdlp': return this.ytdlp(m.auto);
    case 'remote': return this.remote(m.on);   // 0.5.0
    case 'proxy': return this.notImplemented('proxy');   // 0.5.0
    default: return this.emit({ ev: 'error', msg: 'unknown cmd ' + m.cmd });
    }
};
// `hello` {app, lang?, region?} -> hello{service, caps}. A lang or region that does not match is dropped (logged), never
// refused: the app still learns the caps. Kept for this connection (onClient clears them) as the hl / gl of its requests
Daemon.prototype.hello = function (m, emit, locale) {
    emit = emit || this.emit.bind(this);
    const lang = typeof m.lang === 'string' && LANG_RE.test(m.lang) ? m.lang : null;
    const region = typeof m.region === 'string' && REGION_RE.test(m.region) ? m.region : null;
    if (locale) Object.assign(locale, { lang, region });
    else { this.hl = lang; this.gl = region; }
    const bad = (m.lang !== undefined && !lang ? ' (bad lang dropped)' : '') + (m.region !== undefined && !region ? ' (bad region dropped)' : '');
    this.log('hello: app ' + (/^\d+(\.\d+){0,3}$/.test(String(m.app)) ? m.app : 'unknown') + ', lang ' + (lang || '-') + ', region ' + (region || '-') + bad);
    const clk = clockBehind((this.opts.now || Date.now)());
    this.clockSaid = clk;
    if (clk) this.log('clock wrong (' + clk + '): verify the head unit date and time');
    return emit(Object.assign({ ev: 'hello', service: VERSION, caps: this.opts.reportUrl ? CAPS.concat(['logs']) : CAPS.slice() }, clk ? { clock: clk } : {}));
};
// commands of the frozen protocol whose package has not landed: each answers this until its package replaces the body
Daemon.prototype.notImplemented = function (cmd) { return this.emit({ ev: 'error', cmd: cmd, msg: 'not implemented ' + cmd }); };
Daemon.prototype.health = function (emit, options) {
    return require('./health.js').run(this, VERSION, emit || this.emit.bind(this), options);
};
// `related` {id} -> related{id, items} (what YouTube plays after it: the TVHTML5 watch-next answer's video tiles, the
// video itself left out) or related{id, error}. Signed in when we can, anonymous otherwise (as search); kept 10 min
// per video and language, dropped at sign-out. After marilykinson-glitch's fork (GPL-3.0)
const RELATED_KEEP = 600000;
Daemon.prototype.related = async function (id, emit, locale) {
    emit = emit || this.emit.bind(this);
    const lang = locale ? locale.lang : this.hl, region = locale ? locale.region : this.gl;
    if (!ID_RE.test(String(id))) return emit({ ev: 'related', id: String(id), error: 'bad id' });
    const key = id + '/' + (lang || '') + '/' + (region || ''), g = this.account.gen;
    const c = this.relatedKept || (this.relatedKept = {}), k = c[key];
    if (k && k.g === g && Date.now() - k.t < RELATED_KEEP) return emit({ ev: 'related', id: id, items: k.items });
    const body = { context: { client: tvClient(lang, region) }, videoId: id };
    const ask = (tok) => this.account.json('POST', YT + '/youtubei/v1/next', body, tok ? { Authorization: 'Bearer ' + tok } : null);
    let r;
    try {
        const tok = await this.account.token(false).catch(() => null);
        r = await ask(tok);
        if (r.status === 401 && tok) r = await ask(null);
        if (r.status !== 200 || !r.j) throw new Error('next ' + r.status);
    } catch (e) {
        this.log('related: ' + e.message);
        return emit({ ev: 'related', id: id, error: e.noUid ? e.message : 'related offline' });
    }
    if (g !== this.account.gen) return undefined;
    const items = feedItems(r.j).filter((x) => x.id !== id).slice(0, FEED_MAX);
    Object.keys(c).forEach((x) => { if (Date.now() - c[x].t >= RELATED_KEEP) delete c[x]; });   // old ones go: no unbounded map
    c[key] = { t: Date.now(), g: g, items: items };
    return emit({ ev: 'related', id: id, items: items });
};
Daemon.prototype.ytdlp = function (auto) { return this.notImplemented('ytdlp'); };            // WP6
Daemon.prototype.remote = function (on) { return this.notImplemented('remote'); };            // WP9, 0.5.0
Daemon.prototype.setState = function (s) {
    this.state = s;
    this.sendState();
};
Daemon.prototype.sendState = function (pct) {
    this.buffering = this.isBuffering();
    const o = { ev: 'state', state: this.state, pct: pct === undefined ? (this.state === 'preparing' ? this.pct || 0 : null) : pct,
        id: this.cur ? this.cur.id : null, title: this.cur ? this.cur.title : null, buffering: this.buffering,
        phase: this.state === 'preparing' ? this.phase || 'connecting' : null };
    this.emit(o);
};
// playing ahead of the video fetched so far, while the fetcher still writes it
Daemon.prototype.isBuffering = function () {
    return this.state === 'playing' && (this.headWait || (!!this.fetcher && this.elapsed + 1000 > this.fetchedMs));
};
Daemon.prototype.checkBuffering = function () {
    if (this.isBuffering() !== this.buffering) this.sendState();
};

Daemon.prototype.prune = function () {
    const protect = [];
    if (this.cur) protect.push(this.cur.id);
    if (this.preparing) protect.push(this.preparing);
    return pruneCache(this.opts.cacheDir, this.opts.keep, protect, this.log, this.opts.genericMediaIds ? MEDIA_ID_RE : ID_RE, (p) => this.rmTree(p));
};
// ---- send_logs {app}: the ring and ytdec.log's tail, redacted (redactLog), to the log relay as the fetch uid
// -> logs_sent{id} (the code the user quotes) or logs_error{msg: closed|busy|offline|failed}. One at a time.
Daemon.prototype.see = function (kind, id) {
    if (!/^[\w-]{2,64}$/.test(id) || this.seen[id]) return;
    this.seen[id] = kind;
    const all = Object.keys(this.seen);
    if (all.length > 2000) delete this.seen[all[0]];
};
// what a report must not carry: the account (the file, and a sign-in under way), titles and ids the daemon knows
Daemon.prototype.known = function () {
    const secrets = [], titles = [], ids = Object.assign({}, this.seen);
    const walk = (o) => {
        if (typeof o === 'string' || typeof o === 'number') secrets.push(String(o));
        else if (o && typeof o === 'object') Object.keys(o).forEach((key) => { if (key !== 'timer') walk(o[key]); });
    };
    walk(readJson(this.opts.accountFile));
    walk(this.account.cred);
    walk(this.account.pending);
    const vid = (id) => { if (ID_RE.test(String(id))) ids[id] = 'v'; };
    const meta = (m) => { [m.title, m.channel].forEach((x) => { if (typeof x === 'string' && x !== m.id) titles.push(x); }); };
    if (this.cur) { vid(this.cur.id); meta(this.cur); }
    [this.preparing, this.nextPrefetch, this.extracting && this.extracting.id].forEach(vid);
    listCache(this.opts.cacheDir).forEach((it) => { vid(it.id); meta(it); });
    const pos = this.positions();
    Object.keys(pos).forEach((id) => { vid(id); meta(Object.assign({ id: id }, pos[id])); });
    list(path.join(this.opts.cacheDir, 'thumbs')).concat(list(path.join(this.opts.cacheDir, 'ytdlp', 'info'))).forEach((n) => vid(n.split('.')[0]));
    return { secrets: secrets, titles: titles, ids: ids };
};
// health: health.js's lines, last in the log (lastBytes keeps the newest), through the same redaction as the rest
Daemon.prototype.report = function (app, health) {
    const k = this.known(), salt = crypto.randomBytes(16).toString('hex');
    const red = (ls) => redactLog(ls.join('\n'), k, salt, this.opts.cacheDir).split('\n');
    const ytdec = tailLines(path.join(this.opts.logDir, 'ytdec.log'), 300);
    const hl = (health || []).map((h) => 'health ' + h.key + ' ' + (h.ok ? 'ok' : 'FAIL') + ' ' + h.text);
    const log = ['--- ytdec.log, last ' + ytdec.length + ' lines'].concat(ytdec, ['--- jap-ridetube-d ' + VERSION + ', last ' + this.ring.length + ' lines'], this.ring,
        this.audio.diag.length ? ['--- someip'].concat(this.audio.diag) : [], hl.length ? ['--- health'].concat(hl) : []);
    return { app: /^[\d.]{1,12}$/.test(String(app)) ? String(app) : 'unknown', service: VERSION,
        os: lastBytes(red(lines(path.join(this.opts.etcDir, 'os-release')).slice(0, 5)), OS_MAX).join('\n'),
        log: lastBytes(red(log), REPORT_MAX).join('\n') };
};
Daemon.prototype.sendLogs = async function (app, reply, details) {
    const emit = reply || this.emit.bind(this);
    if (!this.opts.reportUrl) return emit({ ev: 'logs_error', msg: 'closed' });
    if (this.reporting) return undefined;
    this.reporting = true;
    try {
        // the health page's lines ride in the report (no clipboard in the car): up to healthMs (8 s) before the POST
        const body = this.report(app, await require('./health.js').run(this, VERSION, null, details));
        this.log('logs: sending ' + body.log.length + ' characters');
        const r = await this.opts.ytRequest('POST', String(this.opts.reportUrl).replace(/\/+$/, '') + '/v1/report',
            { 'User-Agent': 'jap-ridetube-d/' + VERSION }, body, this.opts.reportTimeoutMs);
        let id = null;
        try { id = JSON.parse(r.body).id; } catch (e) { /* not JSON */ }
        if (r.status === 200 && /^[A-Za-z0-9]{4,16}$/.test(String(id))) {
            this.log('logs: sent');
            return emit({ ev: 'logs_sent', id: String(id) });
        }
        this.log('logs: relay ' + r.status);
        return emit({ ev: 'logs_error', msg: r.status === 410 ? 'closed' : r.status === 429 ? 'busy' : 'failed' });
    } catch (e) {
        this.log('logs: ' + e.message);
        // no answer at all (no network, no internet uid, the relay down): offline; else something on our side
        return emit({ ev: 'logs_error', msg: e.noUid || /timeout|\bE[A-Z]{3,}\b|socket hang up/.test(e.message) ? 'offline' : 'failed' });
    } finally {
        this.reporting = false;
    }
};
// ---- search / thumbs
// TVHTML5 search: signed in when we can (as feed), anonymous otherwise (it answers lockupViewModels)
Daemon.prototype.search = async function (q, emit, locale) {
    emit = emit || this.emit.bind(this);
    const lang = locale ? locale.lang : this.hl, region = locale ? locale.region : this.gl;
    q = typeof q === 'string' ? q.trim() : '';
    if (!q) return emit({ ev: 'error', msg: 'empty search' });
    const accountGen = this.account.gen;
    const ask = (tok) => this.account.json('POST', YT + '/youtubei/v1/search', { context: { client: tvClient(lang, region) }, query: q },
        tok ? { Authorization: 'Bearer ' + tok } : null);
    let r;
    try {
        const tok = await this.account.token(false).catch(() => null);
        if (accountGen !== this.account.gen) return undefined;
        r = await ask(tok);
        if (accountGen !== this.account.gen) return undefined;
        if (r.status === 401 && tok) r = await ask(null);
        if (r.status !== 200 || !r.j) throw new Error('search ' + r.status);
    } catch (e) {
        if (accountGen !== this.account.gen) return undefined;
        this.log('search: ' + e.message);
        return emit({ ev: 'error', msg: e.noUid ? e.message : 'search offline' });
    }
    if (accountGen !== this.account.gen) return undefined;
    return emit({ ev: 'results', q: q, items: feedItems(r.j).slice(0, FEED_MAX) });
};
Daemon.prototype.thumb = async function (id) {
    if (!ID_RE.test(String(id))) return this.emit({ ev: 'error', msg: 'bad id' });
    const accountGen = this.account.gen;
    const tdir = path.join(this.opts.cacheDir, 'thumbs'), tf = path.join(tdir, id + '.rgba');
    const read = (f) => readFetchFile(f, (n) => !!THUMB_SIZES[n]);   // the video folder's is the fetch uid's
    let data = read(path.join(this.opts.cacheDir, id, 'thumb.rgba')) || read(tf);
    if (!data) {
        // at most 3 helpers at once: each is a Node 22 process, and a page asks for 20 thumbs
        const i = this.thumbN++ % this.thumbQ.length;
        const p = this.thumbQ[i].then(() => accountGen === this.account.gen ? this.thumbFetch(id) : null);
        this.thumbQ[i] = p.catch(() => {});
        try { data = await p; } catch (e) {
            this.log('thumb ' + id + ': ' + e.message);
            return undefined; // no thumb: the app keeps its placeholder
        }
        if (accountGen !== this.account.gen || !data) return undefined;
        try { mkdirp(tdir); fs.chmodSync(tdir, 0o700); fs.writeFileSync(tf, data, { mode: 0o600 }); this.pruneThumbs(tdir); } catch (e) { this.log('thumb cache: ' + e.message); }
    }
    if (accountGen !== this.account.gen) return undefined;
    const wh = THUMB_SIZES[data.length];
    if (!wh) { this.log('thumb ' + id + ': ' + data.length + ' bytes, not 160x90 or 320x180 RGBA'); return undefined; }
    return this.emit({ ev: 'thumb', id: id, w: wh[0], h: wh[1], rgba: data.toString('base64') });
};
// thumb.js <id> as the fetch uid: exactly 320x180 RGBA on stdout, exit 0; killed after 10 s
Daemon.prototype.thumbFetch = function (id) {
    return new Promise((resolve, reject) => {
        if (!this.opts.thumbCmd) return reject(new Error('provider thumbnails use their own adapter'));
        const child = this.spawnFetchUid(this.opts.thumbCmd, [id].concat(this.proxyArgs()));
        const out = [], err = [];
        let size = 0;
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, 10000);
        child.stdout.on('data', (c) => { size += c.length; if (size <= 230400) out.push(c); });
        child.stderr.on('data', (c) => err.push(c));
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code, sig) => {
            clearTimeout(timer);
            if (code === 0 && size === 230400) return resolve(Buffer.concat(out));
            return reject(new Error('thumb helper ' + (sig || 'exit ' + code) + ', ' + size + ' bytes: ' + Buffer.concat(err).toString('utf8', 0, 200).trim()));
        });
    });
};
// thumbs/ keeps the newest thumbMax (mtime)
Daemon.prototype.pruneThumbs = function (tdir) {
    const names = list(tdir);
    if (names.length <= this.opts.thumbMax) return;
    names.map((n) => { try { return { n: n, t: fs.statSync(path.join(tdir, n)).mtime.getTime() }; } catch (e) { return { n: n, t: 0 }; } })
        .sort((x, y) => y.t - x.t).slice(this.opts.thumbMax)
        .forEach((x) => { try { fs.unlinkSync(path.join(tdir, x.n)); } catch (e) { /* gone */ } });
};

// ---- playback
// restore: {ms, paused, fill, height}, a quality restart of the same video: back to ms (even under 10 s), paused if it was.
// Every play keeps its start in this.restart until its first tick puts it there; a pause, resume, seek (or fill) sent
// meanwhile changes it (the last word counts), a stop or another play replaces it.
Daemon.prototype.play = async function (id, rect, fill, at, quality, skip, restore) {
    if (!(this.opts.genericMediaIds ? MEDIA_ID_RE : ID_RE).test(String(id))) return this.emit({ ev: 'error', msg: 'bad id' });
    if (!/^\d{2,4}x\d{2,4}$/.test(String(rect))) rect = '1280x720';
    const own = restore || { ms: 0, paused: false, height: qualityHeight(quality, readJson(this.opts.leaseFile)) };
    this.restart = own;
    await this.stop(null, true);
    if (this.restart !== own) return undefined;   // stopped, or replaced, while the one before stopped
    if (own.fill !== undefined) fill = own.fill;
    const gen = ++this.gen;
    const dir = path.join(this.opts.cacheDir, id);
    // Upgrade a cached directory from the old mode without following symlinks.
    try {
        const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try { fs.fchmodSync(fd, VIDEO_DIR_MODE); } finally { fs.closeSync(fd); }
    } catch (e) { /* fetchVideo creates missing directories */ }
    const meta0 = Object.assign(readMeta(dir, id), this.opts.initialMetadata && this.opts.initialMetadata.id === id ? this.opts.initialMetadata : {});
    // the chapters too: meta.json is the fetch uid's (a symlink or a FIFO there is no meta, never followed or waited on)
    const mb = readFetchFile(path.join(dir, 'meta.json'), (n) => n <= META_MAX);
    let chapters;
    try { chapters = mb ? JSON.parse(mb.toString('utf8')).chapters : undefined; } catch (e) { /* none */ }
    this.cur = { id: id, title: meta0.title, durationMs: meta0.duration_s > 0 ? meta0.duration_s * 1000 : undefined, dir: dir, rect: rect, fill: fill, gen: gen, height: own.height,
        skip: Array.isArray(skip) ? skip.filter((x) => typeof x === 'string') : null, chapters: chapters };
    const was = this.positions()[id];
    // where it was left (here, else YouTube's own position the tile carried: at): seek there on the first tick
    if (!restore && !own.sought) own.ms = !this.opts.resume ? 0 : was ? (!was.done && was.ms > 10000 ? was.ms : 0) : (Number(at) > 10000 ? Math.floor(Number(at)) : 0);
    this.posAt = Date.now();
    this.pct = 0;
    this.phase = 'connecting';
    this.fetchedMs = Infinity;
    this.head = null;
    this.nextHead = null;
    this.headStop = null;
    this.switchVideoPaused = false;
    this.seekSeq = 0;
    this.underruns = [];   // the recoveries of the last minute (onPlaybackError)
    this.timeSent = false; // a `time` of this play went out (onTime)
    this.recovering = false;
    this.headWait = false;
    this.switching = false;
    this.settle = null;
    this.fullReady = true;
    let firstHead = null;
    if (!isPlayable(dir)) {
        this.fullReady = false;
        this.setState('preparing');
        const waits = this.opts.fetchRetryMs || [];
        for (let k = 0; ; k++) {
            try {
                const x = this.extracting;   // its lookup is nearly there: wait for it rather than redo it
                if (x && x.id === id) await withTimeout(x.done, 8000, 'prefetch').catch(() => undefined);
                if (gen !== this.gen) return undefined;
                firstHead = await this.fetchVideo(id, dir, k ? 'retry' : undefined);
                break;
            } catch (e) {
                if (gen !== this.gen) return undefined;
                // the video itself refused (gone, private, members, age): no retry; else the network, maybe back soon
                if (k >= waits.length || PERMANENT_RE.test(e.message)) return this.failPlayback('fetch: ' + e.message);
                // the retry extracts again (its stream URLs may be what failed: another uplink), without --info. Root never
                // unlinks info/<id>.json: info/ is the fetch uid's, a symlink there would point the unlink anywhere
                this.log('fetch ' + id + ': ' + e.message + ' - again in ' + waits[k] + ' ms');
                this.emit({ ev: 'retry', id: id, n: k + 1, msg: e.message });
                await sleep(waits[k]);
                if (gen !== this.gen) return undefined;
                if (this.opts.refreshSource && REFRESH_SOURCE_ERRORS.indexOf(e.code) >= 0) {
                    try {
                        await this.opts.refreshSource(() => gen === this.gen);
                    } catch (error) {
                        if (gen !== this.gen) return undefined;
                        return this.failPlayback('fetch: ' + error.message);
                    }
                }
            }
        }
        if (gen !== this.gen) return undefined;
    }
    try { const now = new Date(); fs.utimesSync(dir, now, now); } catch (e) { /* LRU recency only */ }
    this.sendExtras();
    this.loadSegments(this.cur).catch((e) => this.log('sponsorblock: ' + e));
    if (this.opts.providerId === 'youtube') this.trackStart(this.cur).catch((e) => this.log('history: ' + e));
    this.prune();
    this.deaths = 0;
    this.paused = false;
    this.elapsed = 0;
    this.total = 0;
    this.stoppedAt = null;
    this.sawPlay = false;
    this.ticking = false;
    this.lastTickAt = Date.now();
    try {
        // never connect before the leftover sweep; a car without the services: the line that says so
        await withTimeout(this.ready, 10000, 'audio service').catch((e) => { throw this.audio.unsupported ? new Error(this.audio.unsupported) : e; });
        if (gen !== this.gen) return undefined;
        if (firstHead !== null && !this.fullReady) {
            this.head = this.nextHead || firstHead;
            this.nextHead = null;
        } else if (this.nextHead) {
            this.dropHead(this.nextHead);
            this.nextHead = null;
        }
        if (own.paused) { // paused while it started (a paused quality restart): no sound until resume starts it at ms
            if (this.restart === own) this.restart = null;
            this.paused = true;
            this.stoppedAt = this.elapsed = own.ms;
            this.ticking = true;
            this.spawnYtdec(own.ms);
            this.setState('paused');
            return undefined;
        }
        await this.startAudio(path.join(dir, this.head ? headName(this.head.n) : 'audio.m4a'), gen);
    } catch (e) {
        if (gen !== this.gen) return this.audio.release();
        return this.failPlayback(e.message);
    }
    if (gen !== this.gen) return this.audio.release(); // stopped while connecting
    this.ticking = true;
    this.spawnYtdec(null);
    this.setState('playing');
    if (this.head && this.fullReady) await this.switchToFull(); // audio.m4a came during the connect
    return undefined;
};
Daemon.prototype.dropHead = function (head) {
    if (!head || !this.cur) return;
    try { fs.unlinkSync(path.join(this.cur.dir, headName(head.n))); } catch (e) { /* already gone or still in use */ }
};
// The car can drop setTime until the first tick from a newly connected file.
Daemon.prototype.waitFirstAudioTick = function () {
    return new Promise((resolve) => {
        const wake = () => {
            clearTimeout(timer);
            if (this.tickWaiter === wake) this.tickWaiter = null;
            resolve();
        };
        const timer = setTimeout(wake, 3000);
        this.tickWaiter = wake;
    });
};
Daemon.prototype.offerHead = function (head) {
    if (this.fullReady || !this.cur || this.head && head.ms <= this.head.ms || this.nextHead && head.ms <= this.nextHead.ms) return;
    if (head.ms > (this.cur.durationMs || 0)) {
        this.cur.durationMs = head.ms; // provider metadata can underestimate the real stream
        this.total = Math.max(this.total || 0, head.ms);
    }
    if (this.nextHead && this.nextHead !== this.head) this.dropHead(this.nextHead);
    this.nextHead = head;
    if (this.ticking && !this.paused && this.headWait && head.ms > this.elapsed + this.opts.headMarginMs)
        this.switchToHead().catch((e) => this.log(e));
};
// The BMW player accepts a complete file, not a growing fMP4. Replace the prefix with a
// longer complete one on the same audio connection, keeping the absolute playback clock.
Daemon.prototype.switchToHead = async function () {
    const next = this.nextHead, old = this.head, gen = this.gen, waiting = this.headWait;
    if (!next || !old || this.switching || this.fullReady || next.ms <= old.ms) return undefined;
    const at = waiting || this.paused ? this.elapsed : this.elapsed + (Date.now() - this.lastTickAt);
    if (next.ms <= at + this.opts.headMarginMs) return undefined;
    this.switching = true;
    this.nextHead = null;
    this.head = next;
    this.sawPlay = false;
    this.log('audio: head ' + old.n + ' -> ' + next.n + ' at ' + at + (waiting ? ' (waiting)' : ''));
    let target;
    try {
        if (this.headStop) await this.headStop;
        if (gen !== this.gen) return undefined;
        if (this.fullReady) {
            this.switching = false;
            this.dropHead(old);
            return this.switchToFull();
        }
        if (waiting) {
            await this.audio.release(); // a STOPped BMW player needs a fresh connection
            if (gen !== this.gen) return undefined;
            await this.audio.play(path.join(this.cur.dir, headName(next.n)));
            if (gen !== this.gen) return undefined;
            await this.waitFirstAudioTick();
        } else await this.audio.replay(path.join(this.cur.dir, headName(next.n)));
        if (gen !== this.gen) return undefined;
        for (;;) {
            const seq = this.seekSeq;
            target = waiting || this.paused || this.switchVideoPaused ? this.elapsed :
                this.elapsed + (Date.now() - this.lastTickAt);
            if (this.total) target = Math.min(target, Math.max(0, this.total - 1000));
            if (this.fullReady) {
                this.switching = false;
                this.dropHead(old);
                return this.switchToFull();
            }
            if (target >= next.ms - this.opts.headMarginMs) {
                this.switching = false;
                this.headWait = false;
                this.dropHead(old);
                return this.waitFull(target);
            }
            await this.audio.seek(target);
            if (gen !== this.gen) return undefined;
            if (seq === this.seekSeq) break;
        }
    } catch (e) {
        if (gen !== this.gen) return undefined;
        this.switching = false;
        return this.failPlayback('audio prefix switch: ' + e.message);
    }
    if (gen !== this.gen) return undefined;
    this.switching = false;
    this.headWait = false;
    this.elapsed = target;
    this.lastTickAt = Date.now();
    this.settle = { ms: target, until: Date.now() + 3000 };
    if (waiting) {
        this.toYtdec('seek ' + target);
        if (!this.paused) this.toYtdec('resume');
    } else if (this.switchVideoPaused && !this.paused) {
        this.toYtdec('seek ' + target);
        this.toYtdec('resume');
    }
    this.switchVideoPaused = false;
    if (!this.paused) this.stoppedAt = null;
    if (this.paused) await this.hold(target);
    this.checkBuffering();
    this.dropHead(old);
    if (this.fullReady) return this.onFullAudio();
    return undefined;
};
// connect + playFile, once more after a wait (BMW can refuse a route just after a disconnect: E_NOT_POSSIBLE, seen on
// marilykinson-glitch's car); gen: the play or resume it belongs to, gone stale -> the first error, no second try
Daemon.prototype.startAudio = async function (file, gen) {
    try {
        return await this.audio.play(file);
    } catch (e) {
        if (gen !== this.gen) throw e;
        this.log('audio start: ' + e.message + ' - again in ' + this.opts.audioRetryMs + ' ms');
        await this.audio.release();   // (connect may have worked before playFile failed)
        await sleep(this.opts.audioRetryMs);
        if (gen !== this.gen) throw e;
        return this.audio.play(file);
    }
};
// audio.m4a is complete. On the head: switch now; paused: resume() switches (as after a STOP mid-file)
Daemon.prototype.onFullAudio = function () {
    this.fullReady = true;
    if (!this.head || !this.ticking || this.switching) return undefined; // not playing yet: play() picks it
    if (this.paused) {
        this.stoppedAt = this.elapsed;
        const old = this.head;
        this.head = null;
        this.headWait = false;
        this.dropHead(old);
        this.dropHead(this.nextHead);
        this.nextHead = null;
        return undefined;
    }
    return this.switchToFull();
};
// playFile(audio.m4a) on the live connection, then setTime where the head was. ytdec keeps its clock meanwhile
// (or, waiting, is paused at elapsed), so the target is the extrapolated clock (or elapsed).
Daemon.prototype.switchToFull = async function () {
    const gen = this.gen, waiting = this.headWait;
    const old = this.head, pending = this.nextHead;
    this.switching = true;
    this.head = null;
    this.nextHead = null;
    this.sawPlay = false;
    this.log('audio: head -> full at ' + this.elapsed + (waiting ? ' (waiting)' : ''));
    let target;
    try {
        if (this.headStop) await this.headStop;
        if (gen !== this.gen) return undefined;
        if (waiting) {
            await this.audio.release();
            if (gen !== this.gen) return undefined;
            await this.audio.play(path.join(this.cur.dir, 'audio.m4a'));
            if (gen !== this.gen) return undefined;
            await this.waitFirstAudioTick();
        } else await this.audio.replay(path.join(this.cur.dir, 'audio.m4a'));
        if (gen !== this.gen) return undefined;
        for (;;) {
            const seq = this.seekSeq;
            target = waiting || this.paused || this.switchVideoPaused ? this.elapsed :
                this.elapsed + (Date.now() - this.lastTickAt);
            if (this.total) target = Math.min(target, Math.max(0, this.total - 1000));
            await this.audio.seek(target);
            if (gen !== this.gen) return undefined;
            if (seq === this.seekSeq) break;
        }
    } catch (e) {
        if (gen !== this.gen) return undefined;
        this.switching = false;
        return this.failPlayback('audio switch: ' + e.message);
    }
    if (gen !== this.gen) return undefined;
    this.switching = false;
    this.headWait = false;
    this.elapsed = target;
    this.lastTickAt = Date.now();
    this.settle = { ms: target, until: Date.now() + 3000 };
    if (waiting) {
        this.toYtdec('seek ' + target);
        if (!this.paused) this.toYtdec('resume');
    } else if (this.switchVideoPaused && !this.paused) {
        this.toYtdec('seek ' + target);
        this.toYtdec('resume');
    }
    this.switchVideoPaused = false;
    if (!this.paused) this.stoppedAt = null;
    if (this.paused) await this.hold(target); // paused during the switch: the playFile started it
    this.checkBuffering();
    this.dropHead(old);
    this.dropHead(pending);
    return undefined;
};
// Past the available prefix: pause the player and ytdec until another prefix or full audio arrives.
Daemon.prototype.waitFull = function (ms) {
    if (this.headWait) return this.headStop || Promise.resolve();
    this.log('audio: past the available prefix at ' + ms + ', buffering');
    this.headWait = true;
    this.switchVideoPaused = false;
    this.elapsed = ms;
    this.toYtdec('pause');
    this.checkBuffering();
    this.sawPlay = false;             // (STOP: PAUSE leaves the player playing; switchToFull plays the full file anyway)
    const pending = Promise.resolve().then(() => this.audio.button('STOP'));
    this.headStop = pending;
    pending.then(() => { if (this.headStop === pending) this.headStop = null; },
                 () => { if (this.headStop === pending) this.headStop = null; });
    return pending;
};
// ytfetch.py into a fresh dir; resolves once playable (audio complete or a prefix, and startVideoMs of video,
// or all of it), rejects if it ends before. A provider may offer longer prefixes during playback.
// It keeps writing the video (and the rest of the audio) after that, while we play.
// how: 'retry' (play's next try: a new extraction, no --info) or 'again' (resumeFetch: playing, into the folder as it is)
Daemon.prototype.fetchVideo = function (id, dir, how) {
    return new Promise((resolve, reject) => {
        const again = how === 'again';
        if (!again) {
            this.rmTree(dir); // a killed fetch's leftovers
            mkdirp(dir);
            fs.chmodSync(dir, VIDEO_DIR_MODE);
            this.chownFetch(dir);
        }
        const info = !how && this.freshInfo(id) ? ['--info', this.infoFile(id)] : [];
        const child = this.spawnJob(['fetch', '--cache-dir', this.ytc(), '--height', String(this.cur.height || 720)].concat(info, ['--', id, dir]));
        this.fetcher = child;
        this.preparing = id;
        this.fetchedMs = 0;
        let audio = again && this.fullReady, head = null, done = false, started = again, err = null, errorCode = null, ytdecAgain = again;
        const pct = (p) => {
            p = Math.min(99, Math.max(this.pct, Math.round(p)));
            if (p !== this.pct && this.state === 'preparing') { this.pct = p; this.sendState(); }
        };
        const check = () => {
            if (!started && (audio || head !== null) && (done || this.fetchedMs >= this.opts.startVideoMs)) { started = true; resolve(audio ? null : head); }
        };
        const end = (why) => {
            if (child === this.fetcher) {
                this.fetcher = null;
                this.preparing = null;
                if (done && why === 'exit 0') this.fetchedMs = Infinity;
                else if (started && this.resumeFetch(id, dir, err || why, errorCode)) { /* fetched again after a wait */ }
                else if (started && !this.fullReady) { // playing the head: the rest of the audio never comes
                    this.failPlayback('fetch: ' + (err || why)).catch((e) => this.log(e));
                    return;
                } else if (started) {
                    this.log('fetch ' + id + ': ' + (err || why));
                    this.emit({ ev: 'error', msg: 'video incomplete: ' + (err || why) });
                }
                this.checkBuffering();
            }
            if (!started) {
                started = true;
                const error = new Error(err || why);
                error.code = errorCode;
                reject(error);
            }
        };
        readline.createInterface({ input: child.stdout }).on('line', (l) => this.guard(() => {
            if (child !== this.fetcher) return;
            let m;
            try { m = JSON.parse(l); } catch (e) { return; }
            if (m.ev === 'meta') {
                if (m.title) this.cur.title = String(m.title);
                if (m.duration_s > 0) this.cur.durationMs = m.duration_s * 1000;
                if (Array.isArray(m.chapters)) this.cur.chapters = m.chapters;
            } else if (m.ev === 'source' && this.opts.genericMediaIds && this.phase === 'connecting') {
                this.phase = 'transfer';
                if (this.state === 'preparing') this.sendState();
            } else if (m.ev === 'source_wait' && m.reason === 'mp4_index') {
                this.phase = 'download';
                if (this.state === 'preparing') this.sendState();
            } else if (m.ev === 'audio') {
                if (!this.opts.genericMediaIds || this.phase === 'download') {
                    if (this.phase !== 'download') this.phase = 'audio';
                    pct(0.7 * (Number(m.pct) || 0));
                }
            }
            else if (m.ev === 'audio_buffer' && this.opts.genericMediaIds && !audio && head === null) {
                const ms = Number(m.ms), target = Number(m.target_ms);
                if (ms >= 0 && target > 0) { this.phase = 'audio'; pct(70 * Math.min(1, ms / target)); }
            }
            else if (m.ev === 'audio_head' && Number(m.ms) > 0) {
                const n = m.n === undefined ? 0 : Number(m.n);
                if (Number.isInteger(n) && n >= 0 && n <= 64 && (!head || Number(m.ms) > head.ms)) {
                    head = { ms: Number(m.ms), n: n };
                    this.offerHead(head);
                    this.phase = 'video';
                    pct(70);
                }
            }
            else if (m.ev === 'audio_ready') {
                audio = true;
                if (Number(m.ms) > 0 && this.cur) {
                    this.cur.durationMs = Number(m.ms);
                    this.total = Number(m.ms);
                }
                this.phase = 'video';
                pct(70);
                if (started) this.onFullAudio();
                else this.fullReady = true;
            }
            else if (m.ev === 'video') {
                this.fetchedMs = Number(m.ms) || 0;
                if (head !== null || audio) this.phase = 'video';
                if (ytdecAgain && this.child && this.ticking) { // the index begun again: a ytdec reading it from the start, at the clock
                    ytdecAgain = false;
                    this.killYtdec();
                    this.spawnYtdec(this.paused || this.headWait ? this.elapsed : this.elapsed + (Date.now() - this.lastTickAt));
                }
                if (audio || head !== null) pct(70 + 29 * Math.min(1, this.fetchedMs / this.opts.startVideoMs));
            } else if (m.ev === 'done') done = true;
            else if (m.ev === 'error') { err = String(m.msg); errorCode = m.code; }
            check();
            this.checkBuffering();
        }));
        readline.createInterface({ input: child.stderr }).on('line', (l) => this.log('ytfetch: ' + l));
        child.on('error', (e) => end(e.message));
        child.on('close', (code, sig) => end(sig ? 'killed ' + sig : 'exit ' + code)); // close: after its last line
    });
};
// The fetcher ended early while playing (the network, mostly): fetched again into the same folder after a wait, twice a
// video at most, then as before. The sound plays on meanwhile (the player holds audio.m4a; the new one replaces it whole,
// on the head its audio_ready switches as usual), ytdec again once the new index starts. False: not this time.
// shortcut: it fetches from 0 again (ytfetch.py has no start position), audio included; WP8's streaming fetcher brings `pos`
Daemon.prototype.resumeFetch = function (id, dir, why, errorCode) {
    const c = this.cur, n = (c && c.fetchAgain) || 0;
    if (!c || n >= 2 || PERMANENT_RE.test(why) || /storage almost full/.test(why)) return false;
    c.fetchAgain = n + 1;
    const gen = this.gen, wait = (this.opts.fetchRetryMs || [])[n] || 0;
    this.log('fetch ' + id + ': ' + why + ' - fetched again in ' + wait + ' ms (' + c.fetchAgain + ' of 2)');
    sleep(wait).then(async () => {
        if (gen !== this.gen) return undefined;
        if (this.opts.refreshSource && REFRESH_SOURCE_ERRORS.indexOf(errorCode) >= 0)
            await this.opts.refreshSource(() => gen === this.gen);
        if (gen === this.gen) return this.fetchVideo(id, dir, 'again');
    }).catch((e) => {
        if (gen !== this.gen) return undefined;
        if (!this.fullReady) return this.failPlayback('fetch: ' + e.message);
        return this.emit({ ev: 'error', msg: 'video incomplete: ' + e.message });
    }).catch((e) => this.log(e));
    return true;
};
// SIGTERM (it leaves .part files), SIGKILL after 3 s; resolves when it is gone
Daemon.prototype.stopFetch = function () {
    const c = this.fetcher;
    if (!c) return Promise.resolve();
    this.fetcher = null;
    this.preparing = null;
    return new Promise((resolve) => {
        const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 3000);
        c.on('exit', () => { clearTimeout(t); resolve(); });
        if (c.exitCode !== null || c.signalCode !== null) { clearTimeout(t); resolve(); }
        try { c.kill('SIGTERM'); } catch (e) { /* gone */ }
    });
};
Daemon.prototype.failPlayback = async function (msg) {
    this.log('error: ' + msg);
    const g = ++this.gen;   // what a resume, recovery or start under way checks: none may open the audio again
    this.restart = null;
    this.ticking = false;
    this.killYtdec();
    await Promise.all([this.audio.release(), this.stopFetch()]);
    if (g !== this.gen) return;   // a new video (or a stop) came in meanwhile: the error was the old one's
    this.setState('error');
    this.emit({ ev: 'error', msg: msg });
};
// reason: 'idle' | 'ended' | null (internal, before a new play: no state event)
Daemon.prototype.stop = async function (reason, preservePlayIntent) {
    if (!preservePlayIntent || reason) {   // a stop cancels a start under way (a quality restart's too), and none starts while it tears down
        this.restart = null;
        if (this.cur) this.cur.stopped = true;
    }
    if (this.ticking) {
        this.savePos(true);
        if (reason === 'ended' && this.pos && this.cur && this.pos[this.cur.id]) this.pos[this.cur.id].done = true;
        const p = this.cur && this.pos && this.pos[this.cur.id];
        if (this.cur && this.cur.track) this.ping(this.cur, true, !!(p && p.done));
    }
    const g = ++this.gen;
    this.ticking = false;
    this.killYtdec();
    await Promise.all([this.audio.release(), this.stopFetch()]);
    if (g !== this.gen) return;   // another stop or a play came in while this one waited: the late tail would wipe it
    if (reason) {
        this.setState(reason);
        if (this.pos) this.sendPositions();
        this.cur = null;
        this.prune();          // a played video goes
    }
};
// a start under way that pause, resume and seek leave to this.restart (its first tick applies it): a play not at the
// player yet, or a quality restart until that tick (a setTime before it is dropped)
Daemon.prototype.waiting = function () { return !!(this.restart && (this.restart.restore || !this.ticking)); };
Daemon.prototype.pause = async function () {
    if (this.restart) this.restart.paused = true;
    if (this.waiting()) return;
    if (this.state !== 'playing') return;
    if (this.switching && !this.headWait) {
        this.elapsed += Date.now() - this.lastTickAt;
        if (this.total) this.elapsed = Math.min(this.elapsed, Math.max(0, this.total - 1000));
        this.lastTickAt = Date.now();
        this.switchVideoPaused = true;
        this.seekSeq++;
    }
    this.paused = true;
    this.toYtdec('pause');
    this.setState('paused'); // at once: the button's reply can take seconds, and a second tap must not send it twice
    // the MediaPlayer answers OK to PAUSE (and PLAY) and plays on (car, 2026-11-03); STOP does stop it, and resume()
    // starts the file again where it stopped
    this.savePos(true);
    if (this.cur && this.cur.track) this.ping(this.cur, true);
    if (this.headWait || this.switching) return; // the active switch will hold the new file if still paused
    await this.hold(this.elapsed); // (the last tick: at most a fraction of a second back)
};
// the player stopped at ms (STOP: our own, not the end of the file), for resume() to start it there again
Daemon.prototype.hold = function (ms) {
    this.stoppedAt = ms;
    this.elapsed = ms;
    this.sawPlay = false;
    return this.audio.button('STOP');
};
Daemon.prototype.resume = async function () {
    if (this.restart) this.restart.paused = false;
    if (this.waiting()) return;
    if (this.state !== 'paused') return;
    this.paused = false;
    this.lastProgress = Date.now();
    this.setState('playing');
    if (this.switching) { this.seekSeq++; return; } // the active switch owns both clocks until audio is ready
    if (this.headWait) {
        if (this.nextHead && this.nextHead.ms > this.elapsed + this.opts.headMarginMs)
            return this.switchToHead();
        return; // ytdec and the player stay paused until another complete prefix arrives
    }
    if (this.stoppedAt !== null && this.stoppedAt !== undefined) return this.replayAt('resume'); // the player stopped mid-file
    this.toYtdec('resume');
    await this.audio.button('PLAY');
};
// The player stopped (our STOP, or it ran dry): start the file again at stoppedAt. Stopped, it ignores playFile and PLAY
// (car, 2026-11-03): a new connection, as a new video starts. why: the error's prefix if that fails.
Daemon.prototype.replayAt = async function (why) {
    const gen = this.gen;
    this.sawPlay = false; // the new file's own STOP/PLAY is not a stop mid-file
    this.toYtdec('seek ' + this.stoppedAt);
    this.toYtdec('resume');
    try {
        await this.audio.release();
        if (gen !== this.gen) return;
        await this.startAudio(path.join(this.cur.dir, this.head ? headName(this.head.n) : 'audio.m4a'), gen);
    } catch (e) {
        if (gen === this.gen) await this.failPlayback(why + ': ' + e.message);
        return;
    }
    // (connected after a teardown had released: let it go too)
    if (gen !== this.gen && (this.state === 'error' || this.state === 'idle')) await this.audio.release().catch(() => undefined);
    if (gen !== this.gen || this.state !== 'playing') return; // stopped, or paused again meanwhile
    // a setTime before the new file's first tick is dropped (it started at 0 on the car): wait for one (3 s at most)
    await this.waitFirstAudioTick();
    if (gen !== this.gen || this.state !== 'playing') return;
    const at = this.stoppedAt;  // (a seek meanwhile moved it: seek() keeps it while the file restarts)
    this.stoppedAt = null;
    this.settle = { ms: at, until: Date.now() + 3000 };
    await this.audio.seek(at);
};
Daemon.prototype.seek = async function (ms) {
    ms = Math.max(0, Math.floor(Number(ms) || 0));
    if (this.restart) { this.restart.ms = ms; this.restart.sought = true; } // the start under way ends there, not where it was left
    if (this.waiting()) return;
    if (this.state !== 'playing' && this.state !== 'paused') return;
    if (this.total) ms = Math.min(ms, Math.max(0, this.total - 1000));
    this.elapsed = ms;
    this.lastProgress = Date.now();
    this.lastTickAt = Date.now();
    this.settle = null; // a seek back right after the switch: its times are ours
    this.seekSeq++;
    this.toYtdec('seek ' + ms);
    if (this.switching) return this.checkBuffering(); // replay will seek the new file to this latest time
    if (this.headWait) {
        if (this.nextHead && this.nextHead.ms > ms + this.opts.headMarginMs && !this.paused) return this.switchToHead();
        return this.checkBuffering();
    }
    if (this.head && !this.switching && ms > this.head.ms - this.opts.headMarginMs) {
        if (this.nextHead && this.nextHead.ms > ms + this.opts.headMarginMs) return this.switchToHead();
        return this.waitFull(ms);
    }
    this.checkBuffering();
    if (this.stoppedAt !== null && this.stoppedAt !== undefined) { this.stoppedAt = ms; return undefined; } // resume() replays there
    await this.audio.seek(ms);
};
Daemon.prototype.setVideo = function (on) {
    this.videoOn = on;
    this.lastProgress = Date.now();
    this.toYtdec('video ' + (on ? 1 : 0));
};

// zoom while playing: ytdec again at the clock with the other mode (the sound plays on)
Daemon.prototype.setFill = function (on) {
    const c = this.cur;
    if (!c || c.fill === on) return;
    c.fill = on;
    if (!this.child) return; // the next ytdec takes it
    this.killYtdec();
    this.spawnYtdec(this.paused || this.headWait ? this.elapsed : this.elapsed + (Date.now() - this.lastTickAt));
};
// Video quality while playing: the same video fetched again at that height, from where it is (under 10 s too), paused
// if it was. A restart already under way carries its place and mode over; the last quality asked wins.
Daemon.prototype.requality = async function (quality) {
    const c = this.cur, h = qualityHeight(quality, readJson(this.opts.leaseFile)), was = this.restart;
    if (!c || c.stopped || h === (was ? was.height : c.height)) return undefined;
    const restore = { ms: was ? was.ms : this.elapsed, paused: was ? was.paused : this.state === 'paused', fill: was ? was.fill : undefined, height: h, restore: true };
    this.restart = restore;
    await this.stop(null, true);
    if (this.restart !== restore) return undefined;   // stopped, replaced or asked again meanwhile: this one is cancelled
    this.rmTree(c.dir);
    return this.play(c.id, c.rect, c.fill, null, quality, c.skip, restore);
};

// ---- MediaPlayer events
Daemon.prototype.onTime = function (v) {
    if (!this.ticking || !v || typeof v.elapsed !== 'number') return;
    if (!(v.total > 1)) return; // {elapsed:0,total:1} right after playFile
    if (this.tickWaiter) { this.tickWaiter(); return; } // resume(): the restarted file plays, its setTime can follow
    if (this.switching || this.headWait) return; // the restart's times, or a paused player
    if (this.settle && Date.now() < this.settle.until && v.elapsed < this.settle.ms - 2000) return; // before our setTime landed
    this.elapsed = v.elapsed;
    this.lastTickAt = Date.now();
    this.total = this.head ? (this.cur.durationMs || v.total) : v.total; // the head's own total is ~60 s
    if (this.head && !this.fullReady && v.elapsed >= this.head.ms - this.opts.headMarginMs) {
        const next = this.nextHead;
        (next && next.ms > v.elapsed + this.opts.headMarginMs ? this.switchToHead() : this.waitFull(v.elapsed))
            .catch((e) => this.log(e));
        return;
    }
    if (this.restart) { // the play's start: where it was left (or the quality restart's place), paused if asked meanwhile
        const r = this.restart, at = Math.floor(r.ms) || 0;
        this.restart = null;
        (at > 0 ? this.seek(at) : Promise.resolve()).then(() => (r.paused && this.state === 'playing' ? this.pause() : undefined))
            .catch((e) => this.log('resume at: ' + e));
        if (at > 0) {
            // the player's next times can still be the old place: none of them goes out as `time` (the app's first one
            // after a play says where it resumed: "Resumed at 12:34")
            this.settle = { ms: at, until: Date.now() + 3000 };
            return;
        }
    }
    if (this.skipSegments()) {
        // a play from the start landing in a segment: its first `time` is still this tick's, not the segment's end
        // (past 10 s, the app would read the play as resumed there)
        if (!this.timeSent) { this.timeSent = true; this.emit({ ev: 'time', elapsed: v.elapsed, total: this.total }); }
        return;
    }
    this.savePos(false);
    if (this.cur.track && Date.now() - this.cur.track.at > 60000) this.ping(this.cur, true);
    this.toYtdec('clock ' + v.elapsed + ' ' + monoMs());
    this.checkBuffering();
    const now = Date.now();
    if (now - this.lastTimeEv >= 240) { // <= 4/s
        this.lastTimeEv = now;
        this.timeSent = true;
        this.emit({ ev: 'time', elapsed: v.elapsed, total: this.total });
    }
};
Daemon.prototype.onPlayerState = function (v) {
    if (!this.ticking) return;
    if (v === 'PLAYER_STATE_PLAY') this.sawPlay = true; // also mid-switch: the full file's own PLAY arms its end
    if (this.switching) return;
    // the current prefix ran out (before onTime saw its end): use another prefix or buffer, never `ended`
    if (v === 'PLAYER_STATE_STOP' && this.head && this.sawPlay) {
        this.sawPlay = false;
        if (!this.headWait) {
            const next = this.nextHead;
            (next && next.ms > this.elapsed + this.opts.headMarginMs ? this.switchToHead() : this.waitFull(this.elapsed))
                .catch((e) => this.log(e));
        }
        return;
    }
    // STOP we did not ask for, after it played: the end of the file when near it, else the player
    // stopped mid-file (seen after a PLAY sent while playing): hold as paused, resume restarts it there.
    if (v === 'PLAYER_STATE_STOP' && this.sawPlay) {
        this.sawPlay = false;
        if (!this.total || this.total - this.elapsed < 4000) {
            this.log('audio ended');
            this.stop('ended').catch((e) => this.log('stop: ' + e));
            return;
        }
        this.log('audio stopped at ' + this.elapsed + ' of ' + this.total + ': held as paused');
        this.stoppedAt = this.elapsed;
        this.paused = true;
        this.toYtdec('pause');
        this.setState('paused');
    }
};
// ITEM_BUFFER_UNDERRUN (marilykinson-glitch's car, 2026-11-18, {event: ...} on a long video): the player ran dry, not the
// end. On the head before audio.m4a: wait for it, as at the head's end. During the head -> full switch (or the wait for it),
// a recovery under way, or paused: the same stall, ignored. Else the player again at the clock after a short wait, 3 times
// in a rolling minute, then an error. Any other error event: an error, as before.
// shortcut: matched as UNDERRUN anywhere in the event (one capture), check the exact shape on the car
const UNDERRUN_MAX = 3;
Daemon.prototype.onPlaybackError = function (v) {
    if (!this.ticking) return undefined;
    const msg = 'playback error ' + JSON.stringify(v);
    const fail = (m) => this.failPlayback(m).catch((e) => this.log(e));
    if (!/UNDERRUN/.test(msg)) return fail(msg);
    if (this.switching || this.headWait || this.recovering || this.paused) {
        this.log('audio: underrun at ' + this.elapsed + (this.recovering ? ' while recovering' : this.paused ? ' while paused' : ' during the head -> full switch') + ', ignored');
        return undefined;
    }
    if (this.head && !this.fullReady) {
        const next = this.nextHead;
        if (next && next.ms > this.elapsed + this.opts.headMarginMs) return this.switchToHead();
        this.log('audio: underrun on the head at ' + this.elapsed + ', waiting for audio.m4a');
        return this.waitFull(this.elapsed).catch((e) => this.log(e));
    }
    const now = Date.now();
    this.underruns = this.underruns.filter((t) => now - t < 60000);
    if (this.underruns.length >= UNDERRUN_MAX) return fail('audio underrun: ' + UNDERRUN_MAX + ' recoveries in a minute, stopped');
    this.underruns.push(now);
    return this.recover().catch((e) => this.log('underrun recovery: ' + e));
};
Daemon.prototype.recover = async function () {
    const gen = this.gen;
    this.recovering = true;
    this.sawPlay = false;   // the dry player's own STOP is neither the end nor a stop mid-file
    this.toYtdec('pause');
    this.log('audio: underrun at ' + this.elapsed + ', the player again there in ' + this.opts.underrunWaitMs + ' ms');
    try {
        await sleep(this.opts.underrunWaitMs);
        if (gen !== this.gen || this.state !== 'playing' || this.paused) return; // stopped, failed or paused meanwhile
        this.stoppedAt = this.elapsed;
        await this.replayAt('underrun recovery');
    } finally {
        if (gen === this.gen) this.recovering = false;
    }
};

// ---- ytdec
Daemon.prototype.spawnYtdec = function (seekMs) {
    const c = this.cur;
    const args = ['--dir', c.dir, '--rect', c.rect];
    if (c.fill) args.push('--fill');
    args.push('--log', path.join(this.opts.logDir, 'ytdec.log'));
    let child;
    try {
        child = cp.spawn(this.opts.ytdec, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
        return this.ytdecDied(null, 'spawn: ' + e.message);
    }
    this.child = child;
    this.lastProgress = Date.now();
    this.lastDecoded = -1;
    this.eof = false;
    child.stdin.on('error', () => { /* EPIPE when it dies: handled by exit */ });
    child.on('error', (e) => this.ytdecDied(child, e.message));
    child.on('exit', (code, sig) => this.ytdecDied(child, 'exit ' + (sig || code)));
    readline.createInterface({ input: child.stdout }).on('line', (l) => this.guard(() => this.onYtdecLine(child, l)));
    if (seekMs !== null) this.toYtdec('seek ' + seekMs);
    if (this.paused) this.toYtdec('pause');
    if (!this.videoOn) this.toYtdec('video 0');
    this.log('ytdec ' + args.join(' ') + (seekMs !== null ? ' (restart at ' + seekMs + ')' : ''));
};
Daemon.prototype.toYtdec = function (line) {
    if (!this.child) return;
    try { this.child.stdin.write(line + '\n'); } catch (e) { /* dying */ }
};
Daemon.prototype.onYtdecLine = function (child, l) {
    if (child !== this.child) return;
    let m;
    try { m = JSON.parse(l); } catch (e) { return; }
    if (m.ev === 'stats') {
        if (typeof m.decoded === 'number' && m.decoded !== this.lastDecoded) {
            this.lastDecoded = m.decoded;
            this.lastProgress = Date.now();
        }
    } else if (m.ev === 'ready') {
        this.lastProgress = Date.now();
    } else if (m.ev === 'eof') {
        this.eof = true;
    } else if (m.ev === 'error') {
        this.log('ytdec error: ' + m.msg);
    }
};
Daemon.prototype.killYtdec = function () {
    const c = this.child;
    if (!c) return;
    this.child = null;
    try { c.stdin.write('quit\n'); } catch (e) { /* gone */ }
    try { c.stdin.end(); } catch (e) { /* gone */ }
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1000);
    c.on('exit', () => clearTimeout(t));
};
// Child died on its own (or the watchdog killed it): restart once at the clock, then audio only.
Daemon.prototype.ytdecDied = function (child, why) {
    if (child && child !== this.child) return; // a child we already let go
    this.child = null;
    if (!this.ticking) return;
    this.deaths++;
    this.log('ytdec died (' + why + '), death ' + this.deaths);
    if (this.deaths === 1) return this.spawnYtdec(this.elapsed);
    this.emit({ ev: 'error', msg: 'video failed, audio only' });
    return undefined;
};
Daemon.prototype.watchdog = function () {
    if (!this.child || this.state !== 'playing' || !this.videoOn || this.eof) return;
    // waiting for video not fetched yet (buffering, or the fetcher ended early): not a stall
    if (this.headWait || this.elapsed + 1000 > this.fetchedMs) { this.lastProgress = Date.now(); return; }
    if (Date.now() - this.lastProgress < this.opts.watchdogMs) return;
    this.log('watchdog: no decoded frames for ' + this.opts.watchdogMs + ' ms');
    const c = this.child;
    try { c.kill('SIGKILL'); } catch (e) { /* gone */ }
    this.lastProgress = Date.now();
};

Daemon.prototype.close = async function () {
    this.timers.forEach(clearInterval);
    [this.spare, this.extracting].forEach((x) => { if (x) { try { x.child.kill('SIGKILL'); } catch (e) { /* gone */ } } });
    this.spare = this.extracting = null;
    this.account.close();
    await this.stop(null);
    if (this.client) this.client.destroy();
    if (this.server) this.server.close();
};

module.exports = { BUILT: BUILT, clockBehind: clockBehind, qualityHeight: qualityHeight, channelTiles: channelTiles, playlistTiles: playlistTiles, playlistTitle: playlistTitle, addToPlaylistItems: addToPlaylistItems, Daemon: Daemon, Audio: Audio, Account: Account, feedItems: feedItems, isPlayable: isPlayable, redactLog: redactLog, VERSION: VERSION, CAPS: CAPS, REPORT_URL: REPORT_URL, feedShelves: feedShelves, ytRequest: ytRequest, uplinkLookup: uplinkLookup, pickFetchUid: pickFetchUid, fetchRequest: fetchRequest, listCache: listCache, pruneCache: pruneCache, isReady: isReady };

// the head unit's date (YYYY-MM-DD) when its clock is provably wrong (before BUILT), else null. A clock ahead of real
// time cannot be proven wrong: it gets nothing
function clockBehind(now) { return now < Date.parse(BUILT) ? new Date(now).toISOString().slice(0, 10) : null; }

// the uplink's DNS servers (its lease): the system resolver (127.0.0.1) answers no internet names. No
// lease (uplink down or not installed): the system resolver, as before
function uplinkLookup(leaseFile) {
    const servers = ((readJson(leaseFile || '/run/mgu-uplink/lease.json') || {}).dns || []).filter((x) => typeof x === 'string');
    if (!servers.length) return undefined;
    const r = new (require('dns').Resolver)();
    r.setServers(servers);
    return function (host, opts, cb) {
        if (typeof opts === 'function') cb = opts;
        r.resolve4(host, (e, a) => (e ? cb(e) : cb(null, a[0], 4)));
    };
}

if (require.main === module && process.argv[2] === '--someip-gen') {
    someipGen(process.argv[3], process.argv[4], process.argv[5], JSON.parse(process.argv[6] || '[]'));
} else if (require.main === module && process.argv[2] === '--fetch') {
    // the fetch helper (as the fetch uid): one request from stdin, its answer on stdout
    let input = '';
    const out = (o) => process.stdout.write(JSON.stringify(o), () => process.exit(0));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { input += d; });
    process.stdin.on('end', () => {
        let q;
        try { q = JSON.parse(input); } catch (e) { return out({ error: 'bad request' }); }
        let via = null;
        if (q.proxy) {
            // the daemon sends the raw URL string; a parsed object (with its type) is accepted too
            via = (q.proxy && typeof q.proxy === 'object' && q.proxy.type)
                ? q.proxy
                : proxyMod.parse(typeof q.proxy === 'string' ? q.proxy : (q.proxy && q.proxy.url));
            if (!via) return out({ error: 'bad proxy' });
        }
        try {
            const native = nativeNetwork.fromLease(q.leaseFile);
            const lookup = nativeNetwork.lookupGuard(uplinkLookup(q.leaseFile), native);
            return ytRequest(q.method, q.url, q.headers, q.body, q.timeoutMs, lookup, via, native).then(out, (e) => out({ error: e.message }));
        } catch (e) { return out({ error: 'Native channel is unavailable' }); }
    });
} else if (require.main === module) {
    const d = new Daemon();
    process.on('uncaughtException', (e) => d.fault(e));
    process.on('unhandledRejection', (e) => d.fault(e));
    let exiting = false;
    ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((s) => process.on(s, () => {
        if (exiting) return;
        exiting = true;
        d.log(s + ': releasing audio');
        setTimeout(() => process.exit(0), 4000); // TimeoutStopSec=5
        d.close().then(() => process.exit(0), () => process.exit(0));
    }));
    d.start().catch((e) => {
        if (!(e && e.refuse)) return d.fault(e);
        d.log(e.message);
        process.exit(1);
    });
}
