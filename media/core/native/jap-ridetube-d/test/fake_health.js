#!/usr/bin/env node
'use strict';
// stands in for `ytfetch.py check --json` in test_ytd.js's health tests: argv = [ctl, 'check', '--json', ...]. Logs its
// argv and pid to <ctl>.log. <ctl>: "ok" (default) | "offline" (DNS fails, TLS skipped) | "expired" (TLS: wrong clock) | "hang" (yt-dlp, then nothing)
// | "hostile" (an unknown name, a non-boolean ok, addresses, an id, a title, newlines, a long text) | "crash" (yt-dlp, then a
// traceback on stderr and exit 1 with no done line).
const fs = require('fs');
const ctl = process.argv[2];
let mode = 'ok';
try { mode = fs.readFileSync(ctl, 'utf8').trim() || 'ok'; } catch (e) { /* default */ }
fs.writeFileSync(ctl + '.log', JSON.stringify({ argv: process.argv.slice(3), pid: process.pid }));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const line = (name, ok, info, x) => say(Object.assign({ ev: 'check', name: name, ok: ok, s: 0.1, info: info }, x || {}));
if (mode === 'hang') {
    line('ytdlp', true, 'loaded', { version: '2026.10.26' });
    setInterval(() => {}, 1000);
} else if (mode === 'crash') {
    line('ytdlp', true, 'loaded', { version: '2026.10.26' });
    process.stderr.write('Traceback (most recent call last):\nOSError: 10.9.9.9 KnownVid001 gone\n');
    process.exit(1);
} else if (mode === 'hostile') {
    line('evil', true, 'injected');
    line('ytdlp', true, 'loaded', { version: '1.2.3.4\nrm -rf' });
    line('dns', 'yes', '10.1.2.3 aa:bb:cc:dd:ee:ff 2a02:1810:abcd::1 KnownVid001\nMy Secret Holiday Video ' + 'x'.repeat(500));
    line('tls', false, 'via 81.82.83.84 for KnownVid001 My Secret Holiday Video');
    say({ ev: 'done', ok: false });
    process.exit(1);
} else {
    line('ytdlp', true, 'loaded', { version: '2026.10.26' });
    if (mode === 'offline') {
        line('dns', false, 'name not resolved', { servers: 2 });
        line('tls', false, 'skipped: no DNS');
    } else if (mode === 'expired') {
        line('dns', true, 'resolved', { servers: 2 });
        line('tls', false, 'wrong clock: 2030-01-01');
    } else {
        line('dns', true, 'resolved', { servers: 2 });
        line('tls', true, 'HTTP 200');
    }
    say({ ev: 'done', ok: mode === 'ok' });
    process.exit(mode === 'ok' ? 0 : 1);
}
