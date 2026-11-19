'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// jap-ridetube-d health (WP4): what the service, the car and the network look like, one line per key, for the app's
// health page ({"cmd":"health"}) and for a log report (send_logs). Every probe runs at once under its own timeout: one
// that fails or hangs never holds the others, and the whole run ends within the budget. run() never rejects: ytd.js's
// guard() would take a rejection for a fault and stop playback. Loaded by ytd.js, so Node 8: no ?. / ?? / catch {}.
// No text carries an address (IP, MAC), a video id or a title: the network texts are fixed phrases (what the fetch uid's
// child printed counts only when it is one of PHRASES), the rest is short printable ASCII with addresses masked, and a
// report runs the block through redactLog as well.
const fs = require('fs');
const cp = require('child_process');
const readline = require('readline');

// the keys, in the order a report lists them (the app's page keys its rows by name)
const KEYS = ['service', 'node', 'node22', 'python', 'ytdlp', 'uid', 'lease', 'dns', 'tls', 'free', 'audio', 'socket'];
const FLOOR = 256 << 20;    // ytfetch.py's MIN_FREE: a fetch stops when less is left on the cache's file system
const BUDGET_MS = 8000;     // the whole run (opts.healthMs overrides it); a local probe gets 3 s of it at most
const TEXT_MAX = 120;
// what ytfetch.py check --json may say in "info" (its _why): anything else shows as "failed"
const PHRASES = ['loaded', 'resolved', 'no uplink lease', 'skipped: no DNS', 'name not resolved', 'timed out', 'certificate not trusted', 'DNS handled by proxy',
    'TLS error', 'connection refused', 'connection reset', 'network unreachable', 'no route to host', 'not found', 'failed'];
const phrase = (x) => (PHRASES.indexOf(x) >= 0 || /^(HTTP \d{3}|wrong clock: \d{4}-\d\d-\d\d)$/.test(x) ? x : 'failed');

function clean(s) {
    return String(s).replace(/[^\x20-\x7e]+/g, ' ')
        .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '[mac]')
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
        .replace(/[0-9a-f:]*::[0-9a-f:]*|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '[ip]')
        .replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
}
// a promise, or "no answer in N s" past ms
function within(p, ms) {
    return new Promise(function (resolve, reject) {
        const t = setTimeout(function () { reject(new Error('no answer in ' + Math.round(ms / 100) / 10 + ' s')); }, ms);
        p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
}
// a command's first output line (root runs only --version and df: nothing the fetch uid wrote)
function first(cmd, args, ms) {
    return new Promise(function (resolve, reject) {
        cp.execFile(cmd, args, { timeout: ms, env: {}, cwd: '/', maxBuffer: 64 << 10 }, function (e, out, err) {
            if (e) return reject(e.code === 'ENOENT' ? new Error('not installed') : e.killed ? new Error('no answer in ' + ms / 1000 + ' s') : new Error('does not start'));
            return resolve(String(out || err).trim().split('\n'));
        });
    });
}
function readLease(f) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

// ytfetch.py check --json as the fetch uid (as every ytfetch.py runs): ytdlp, dns, tls, each put as its line lands, so
// a kill past ms keeps what it already said. Its output is the fetch uid's: only the three names, ok only when true
function fetcherCheck(d, ms, put) {
    return new Promise(function (resolve, reject) {
        d.clockDate();
        const route = d.proxyArgs();
        const args = ['check', '--json', '--cache-dir', d.opts.cacheDir, '--lease', d.opts.leaseFile];
        const proxy = route.indexOf('--proxy-file');
        if (proxy >= 0) args.push('--proxy-file', route[proxy + 1]);
        const child = d.spawnFetchUid(d.opts.fetcher, args);
        let size = 0, lastErr = '', done = false;
        const kill = function () { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } };
        const t = setTimeout(function () { kill(); reject(new Error('no answer in ' + Math.round(ms / 100) / 10 + ' s')); }, ms);
        child.on('error', function (e) { clearTimeout(t); reject(new Error(e.code === 'ENOENT' ? 'mgu-python is not installed' : 'ytfetch.py does not start')); });
        child.stdout.on('data', function (b) { size += b.length; if (size > 64 << 10) kill(); });
        child.stderr.on('data', function (b) { lastErr = String(b).trim().split('\n').pop() || lastErr; });
        readline.createInterface({ input: child.stdout }).on('line', function (l) {
            let o;
            try { o = JSON.parse(l); } catch (e) { return; }
            if (o && o.ev === 'done') done = true;
            if (!o || o.ev !== 'check') return;
            const ok = o.ok === true, info = phrase(o.info);
            if (o.name === 'ytdlp') {
                const v = /^[\w.+-]{1,32}$/.test(String(o.version)) ? String(o.version) : null;
                put('ytdlp', ok && !!v, ok && v ? 'yt-dlp ' + v + ' (bundled)' : 'yt-dlp does not load: ' + info);
            } else if (o.name === 'dns') {
                put('dns', ok, ok ? (info === 'DNS handled by proxy' ? info : 'youtube.com resolves through the uplink DNS') : 'DNS for youtube.com: ' + info);
            } else if (o.name === 'tls') {
                put('tls', ok, !ok ? 'no TLS to youtube.com: ' + info : 'TLS to youtube.com works');
            }
        });
        child.on('close', function (code) {
            clearTimeout(t);
            if (done) return resolve();
            if (lastErr) d.log('health: ytfetch.py check: ' + clean(lastErr));   // the log (a report redacts it), not the screen
            return reject(new Error('ytfetch.py check stopped (exit ' + code + ')'));
        });
    });
}

// the probes: [keys it answers, fn(put) -> a promise]. ms: a local probe's own timeout
function probes(d, version, ms, budget, details) {
    const o = d.opts;
    return [
        [['service', 'node'], function (put) {
            put('service', true, 'jap-ridetube-d ' + version);
            put('node', Number(process.versions.node.split('.')[0]) >= 8, 'Node ' + process.version + ' runs the service');
        }],
        [['node22'], function (put) {
            return first(o.thumbCmd[0], ['--version'], ms).then(function (ls) {
                const v = /^v(\d+)\.\d+\.\d+$/.exec(ls[0]);
                put('node22', !!v && Number(v[1]) >= 22, v ? 'jap-node22 ' + ls[0] : 'jap-node22 answers no version');
            }, function (e) { put('node22', false, 'jap-node22 ' + e.message); });
        }],
        [['python'], function (put) {
            return first(o.fetcher[0], ['--version'], ms).then(function (ls) { put('python', true, 'mgu-python: ' + clean(ls[0]).slice(0, 40)); },
                function (e) { put('python', false, 'mgu-python ' + e.message); });
        }],
        [['ytdlp', 'dns', 'tls'], function (put) { return fetcherCheck(d, budget, put); }],
        [['uid'], function (put) {
            try { put('uid', true, 'internet uid ' + d.uid()); } catch (e) { put('uid', false, e.message); }
        }],
        [['lease'], function (put) {
            const l = readLease(o.leaseFile);
            const n = l && Array.isArray(l.dns) ? l.dns.filter(function (x) { return typeof x === 'string'; }).length : 0;
            put('lease', n > 0, !l ? 'no uplink lease: the uplink is down or not installed' : n ? 'uplink lease, ' + n + ' DNS server' + (n > 1 ? 's' : '') : 'uplink lease without DNS servers');
        }],
        [['free'], function (put) {
            return first('df', ['-Pk', o.cacheDir], ms).then(function (ls) {
                const kb = Number((ls[ls.length - 1] || '').split(/\s+/)[3]);
                if (!(kb >= 0)) return put('free', false, 'free space unknown');
                return put('free', kb * 1024 >= FLOOR, Math.floor(kb / 1024) + ' MiB free for videos (a video needs ' + (FLOOR >> 20) + ' MiB left)');
            }, function (e) { put('free', false, 'free space unknown: df ' + e.message); });
        }],
        [['audio'], function (put) {
            // + where each service's description came from and MainApp's version (ytd.js Audio.sources), once known
            const a0 = (details ? details.audio : d.audio) || {}, cc = a0.cc, src = typeof a0.sources === 'function' && a0.sources() ? '; ' + a0.sources() : '';
            if (a0.unsupported) return put('audio', false, a0.unsupported);
            if (!cc) return put('audio', false, 'BMW audio service not connected yet' + src);
            return within(Promise.resolve().then(function () { return cc.isAvailable(); }), ms).then(function (a) {
                put('audio', a === true, (a === true ? 'BMW audio service reachable' : 'BMW audio service not available') + src);
            }, function (e) { put('audio', false, 'BMW audio service: ' + e.message + src); });
        }],
        [['socket'], function (put) {
            if (details) {
                try {
                    const s = fs.lstatSync(details.socket);
                    const ready = s.isSocket() && s.uid === 0 && s.gid === details.socketGid && (s.mode & 0o777) === 0o660;
                    return put('socket', ready, ready ? 'MGU Video service socket: restricted app group (660)' : 'MGU Video service socket permissions unexpected');
                } catch (e) { return put('socket', false, 'MGU Video service socket unavailable'); }
            }
            let mode = '';
            try { mode = ' (' + (fs.statSync(o.sock).mode & 0o777).toString(8) + ')'; } catch (e) { /* not listening */ }
            // sockUid: the app's uid when locked, 0 root only, null shared with every app, undefined before listen
            const u = d.sockUid;
            put('socket', typeof u === 'number', u > 0 ? 'control socket: the RideTube app only' + mode
                : u === 0 ? 'control socket: root only' + mode : u === null ? 'control socket: shared with other apps' + mode
                : 'control socket: lock state unknown' + mode);
        }]
    ];
}

// all probes -> [{key, ok, text}] in KEYS order; emit (optional) gets each {ev:'health', key, ok, text} as it lands,
// then {ev:'health', done:true}. Every key is answered every time ("not checked: <why>" when its probe failed)
function run(d, version, emit, details) {
    const out = emit || function () {};
    const budget = (d.opts && d.opts.healthMs) || BUDGET_MS, ms = Math.min(3000, budget);
    const got = {};
    const put = function (key, ok, text) {
        if (got[key] || KEYS.indexOf(key) < 0) return;
        got[key] = { key: key, ok: ok === true, text: clean(text) };
        try { out({ ev: 'health', key: key, ok: got[key].ok, text: got[key].text }); } catch (e) { /* the app went */ }
    };
    let ps = [];
    try { ps = probes(d, version, ms, budget, details); } catch (e) { /* every key answers below */ }
    return Promise.all(ps.map(function (p) {
        return new Promise(function (resolve) {
            const fill = function (why) {
                clearTimeout(t);
                p[0].forEach(function (k) { put(k, false, 'not checked: ' + why); });
                resolve();
            };
            const t = setTimeout(function () { fill('no answer in ' + Math.round(budget / 100) / 10 + ' s'); }, budget + 500);
            let r;
            try { r = Promise.resolve(p[1](put)); } catch (e) { r = Promise.reject(e); }
            r.then(function () { fill('no answer'); }, function (e) { fill(e && e.message || String(e)); });
        });
    })).then(function () {
        KEYS.forEach(function (k) { put(k, false, 'not checked'); });
        try { out({ ev: 'health', done: true }); } catch (e) { /* the app went */ }
        return KEYS.map(function (k) { return got[k]; });
    });
}

module.exports = { run: run, KEYS: KEYS, clean: clean };
