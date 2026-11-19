'use strict';
// Host test for ytd.js: fake someip, fake ytdec, fake fetcher and thumb helper, real unix socket.  node test/test_ytd.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { Daemon, Audio, pruneCache, listCache, feedItems, feedShelves, pickFetchUid, fetchRequest, isPlayable, VERSION, CAPS, REPORT_URL, BUILT, clockBehind } = require('../ytd.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytd-'));
const cache = path.join(tmp, 'cache');
const srcGen = path.join(tmp, 'src-gen');
const ytlog = path.join(tmp, 'ytdec.calls');
fs.mkdirSync(cache); fs.mkdirSync(srcGen);
['org_genivi_am_commandinterface_CommandControl.json', 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json']
    .forEach((f) => fs.writeFileSync(path.join(srcGen, f), JSON.stringify({ name: f })));
const fakeYtdec = path.join(__dirname, 'fake_ytdec.js');
fs.chmodSync(fakeYtdec, 0o755);
process.env.FAKE_YTDEC_LOG = ytlog;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setMode = (m) => fs.writeFileSync(ytlog + '.mode', m);

// ---- fake someip
const calls = [];
let conns = [{ mainConnectionID: 7, sourceID: 1046, sinkID: 1024 }, { mainConnectionID: 15, sourceID: 129, sinkID: 387 }];
let nextConn = 20;
let slowPlayFile = 0;
const subs = {};
const someip = {
    buildProxy: async (cfg, inst) => ({
        init: async () => {},
        isAvailable: async () => true,
        subscribe: (s) => { subs[s.name] = s.onReceive; },
        getValue: async (n) => { assert.strictEqual(n, 'listOfMainConnections'); return conns.slice(); },
        callMethod: async (m, a) => {
            calls.push({ inst: inst, m: m, a: a });
            if (m === 'connect') { const id = nextConn++; conns.push({ mainConnectionID: id, sourceID: a.sourceID }); return { mainConnectionID: id, amError: 'E_OK' }; }
            if (m === 'disconnect') { conns = conns.filter((c) => c.mainConnectionID !== a.mainConnectionID); return { amError: 'E_OK' }; }
            if (m === 'playFile' && slowPlayFile) await sleep(slowPlayFile);
            return { EntError: 'OK' };
        }
    })
};
const called = (m) => calls.filter((c) => c.m === m);
const ours = () => conns.filter((c) => c.sourceID === 1046);

// ---- cache fixtures
function mkVideo(id, opts) {
    opts = opts || {};
    const d = path.join(cache, id);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id: id, title: 'T ' + id, channel: 'C', duration_s: 60 }));
    fs.writeFileSync(path.join(d, 'thumb.rgba'), Buffer.alloc(57600, 7));
    (opts.files || ['audio.m4a', 'index.bin', 'video.h264']).forEach((f) => fs.writeFileSync(path.join(d, f), 'x'));
    const t = new Date(opts.mtime || Date.now());
    fs.utimesSync(d, t, t);
    return d;
}

// ---- fake www.youtube.com (ytRequest): the TV page, its base script, device code, token, browse
const yt = { calls: [], inline: false, expiresIn: 1800, token: () => ({ error: 'authorization_pending' }), browse: null };
const SECRETS = ['SeCrEt-1', 'DEV-CODE-XYZ', 'ACCESS-1', 'ACCESS-2', 'ACCESS-3', 'REFRESH-1'];
const CRED = 'clientId:"123-abc.apps.googleusercontent.com",\nqz:"SeCrEt-1"';
const TV_VER = '7.20261103.19.00';
const fakeYt = async (method, url, headers, body) => {
    yt.calls.push({ method: method, url: url, headers: headers, body: body });
    const slow = Object.keys(yt.slow || {}).find((k) => url.endsWith(k));
    if (slow) await sleep(yt.slow[slow]);
    const json = (o, st) => ({ status: st || 200, body: JSON.stringify(o) });
    if (url === 'https://www.youtube.com/tv') return { status: 200, body: yt.creds === false ? '<html></html>' : yt.inline ? 'a ' + CRED + ' clientVersion:"' + TV_VER + '" b' : '<script src="/s/tv/x1/base.js"></script>' };
    if (url === 'https://www.youtube.com/s/tv/x1/base.js') return { status: 200, body: 'var q={' + CRED + ',clientVersion:"' + TV_VER + '"};' };
    if (url === 'https://www.youtube.com/o/oauth2/device/code' && yt.refuse > 0) { yt.refuse--; return json({ error: 'invalid_client' }, 401); }
    if (url === 'https://www.youtube.com/o/oauth2/device/code') return json({ device_code: 'DEV-CODE-XYZ', user_code: 'ABC-DEF-GHI', verification_url: 'https://www.google.com/device', interval: 0.03, expires_in: yt.expiresIn });
    if (url === 'https://www.youtube.com/o/oauth2/token') { const r = yt.token(body); return json(r, r.error ? 400 : 200); }
    if (url === 'https://www.youtube.com/youtubei/v1/browse') return yt.browse(headers, body);
    if (url === 'https://www.youtube.com/youtubei/v1/search') return yt.search(headers, body);
    if (url === 'https://www.youtube.com/youtubei/v1/next' && yt.next) return yt.next(headers, body);
    if (url.indexOf('https://sponsor.ajay.app/api/skipSegments/') === 0 && yt.sb) return yt.sb(url);
    if (url === 'https://www.youtube.com/youtubei/v1/player') return json({ playbackTracking: { videostatsPlaybackUrl: { baseUrl: 'https://s.youtube.com/api/stats/playback?docid=x&ei=E' }, videostatsWatchtimeUrl: { baseUrl: 'https://s.youtube.com/api/stats/watchtime?docid=x&ei=E' } } });
    if (url.indexOf('https://s.youtube.com/api/stats/') === 0) return { status: 204, body: '' };
    return { status: 404, body: '' };
};
// an anonymous TVHTML5 search answer for "big buck bunny" (2026-11-03), trimmed to three lockups
const SEARCH = JSON.parse(fs.readFileSync(path.join(__dirname, 'search_tvhtml5.json'), 'utf8'));
yt.search = () => ({ status: 200, body: JSON.stringify(SEARCH) });
const ytCalls = (end) => yt.calls.filter((x) => x.url.endsWith(end));
// a browse answer shaped like TVHTML5's: shelves of tiles (a video, a short, a channel, the video again)
const tile = (id, type, title, channel, len, line2) => ({ tileRenderer: {
    contentId: id, contentType: type,
    header: { tileHeaderRenderer: { thumbnailOverlays: len ? [{ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: len } } }] : [] } },
    metadata: { tileMetadataRenderer: { title: { runs: [{ text: title }] }, lines: [
        { lineRenderer: { items: [{ lineItemRenderer: { text: { runs: [{ text: channel }] } } }] } },
        { lineRenderer: { items: line2 || [{ lineItemRenderer: { text: { simpleText: '1K views' } } }, { lineItemRenderer: { text: { simpleText: '•' } } }] } }] } },
    onSelectCommand: type === 'TILE_CONTENT_TYPE_SHORTS' ? { reelWatchEndpoint: { videoId: id } } : { watchEndpoint: { videoId: id } } } });
const BROWSE = { contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: { sectionListRenderer: { contents: [
    { shelfRenderer: { content: { horizontalListRenderer: { items: [
        tile('VVVVVVVVVV1', 'TILE_CONTENT_TYPE_VIDEO', 'First', 'Chan A', '39:50'),
        tile('SSSSSSSSSS1', 'TILE_CONTENT_TYPE_SHORTS', 'A short', 'Chan B', null),
        tile('UCxxxxxxxxx', 'TILE_CONTENT_TYPE_CHANNEL', 'A channel', '', null)] } } } },
    { shelfRenderer: { content: { horizontalListRenderer: { items: [
        tile('VVVVVVVVVV2', 'TILE_CONTENT_TYPE_VIDEO', 'Second', 'Chan C', '1:02:03'),
        tile('VVVVVVVVVV1', 'TILE_CONTENT_TYPE_VIDEO', 'First', 'Chan A', '39:50'),
        tile('VVVVVVVVVV3', 'TILE_CONTENT_TYPE_VIDEO', 'Live', 'Chan D', 'LIVE')] } } } }] } } } } } } };

// ---- app side
function client(sock) {
    return new Promise((resolve) => {
        const c = net.connect(sock, () => resolve(c));
        c.evs = [];
        let buf = '';
        c.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { c.evs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
        c.send = (o) => c.write(JSON.stringify(o) + '\n');
        c.waitFor = async (pred, ms) => {
            const end = Date.now() + (ms || 3000);
            for (;;) {
                const e = c.evs.find(pred);
                if (e) return e;
                if (Date.now() > end) throw new Error('timeout waiting; got ' + JSON.stringify(c.evs.slice(-5)));
                await sleep(20);
            }
        };
        c.clear = () => { c.evs.length = 0; };
    });
}
const ytdecLines = () => (fs.existsSync(ytlog) ? fs.readFileSync(ytlog, 'utf8').split('\n').filter(Boolean) : []);
const waitUntil = async (f, ms) => { const end = Date.now() + (ms || 3000); while (!f()) { if (Date.now() > end) throw new Error('timeout'); await sleep(20); } };
const tick = (ms) => subs.currentItemTime({ elapsed: ms, total: 60000 });

const results = [];
async function t(name, fn) {
    try { await fn(); results.push('ok   ' + name); } catch (e) { results.push('FAIL ' + name + '\n' + (e.stack || e)); }
}

async function main() {
    const logs = [];
    const stateDir = path.join(tmp, 'state');
    const acct = path.join(stateDir, 'account.json');
    const ctl = path.join(tmp, 'fetch.ctl');
    const d = new Daemon({
        someip: someip, srcGen: srcGen, ytdec: fakeYtdec, cacheDir: cache, logDir: tmp, sock: path.join(tmp, 'ctl.sock'),
        watchdogMs: 800, tickMs: 200, keep: 20, stateDir: stateDir, noSetuid: true, spare: false, resume: false, fetchRetryMs: [],
        fetcher: [process.execPath, path.join(__dirname, 'fake_ytfetch.js'), ctl],
        accountFile: acct, ytRequest: fakeYt, log: (m) => logs.push(m)
    });
    mkVideo('DemoVideo01', { mtime: Date.now() - 1000 });
    mkVideo('PPPPPPPPPPP', { mtime: Date.now() - 1500 });
    mkVideo('DemoVideo02', { files: ['audio.m4a', 'index.bin', 'video.h264.part'], mtime: Date.now() - 2000 });
    await d.start();
    let c = await client(d.opts.sock);

    await t('leftover 1046 connection removed at start, others kept', async () => {
        assert.deepStrictEqual(called('disconnect').map((x) => x.a.mainConnectionID), [7]);
        assert.ok(conns.some((x) => x.mainConnectionID === 15));
    });

    await t('no downloads: library / download / remove are unknown commands; thumb read from the cache', async () => {
        for (const cmd of ['library', 'download', 'remove']) {
            c.clear();
            c.send({ cmd: cmd, id: 'DemoVideo01' });
            await c.waitFor((x) => x.ev === 'error' && x.msg === 'unknown cmd ' + cmd);
        }
        c.send({ cmd: 'thumb', id: 'DemoVideo01' });
        const th = await c.waitFor((x) => x.ev === 'thumb');
        assert.strictEqual(Buffer.from(th.rgba, 'base64').length, 57600);
        c.clear();
        fs.renameSync(path.join(cache, 'DemoVideo02', 'video.h264.part'), path.join(cache, 'DemoVideo02', 'video.h264'));
    });

    await t('search: TVHTML5 InnerTube, anonymous when signed out; lockups parsed; offline -> "search offline"', async () => {
        c.clear(); yt.calls.length = 0;
        c.send({ cmd: 'search', q: ' bunny ' });
        const e = await c.waitFor((x) => x.ev === 'results');
        assert.deepStrictEqual(e, { ev: 'results', q: 'bunny', items: [
            { id: 'f7NwyBnIRTE', title: 'Animated Short Film "Big Buck Bunny", 4K, Full Length', channel: 'AnimalsReview', duration_s: 635, meta: ['37M views', '11 years ago'] },
            { id: 'PJx173L9jWw', title: 'Big Buck Bunny creative common Blender Foundation Short Film', channel: 'Miniaiza', duration_s: 10205, meta: ['36 views', 'Streamed 15 hours ago'] },
            { id: 'OR6rRQ1fAzM', title: 'LES ANIMOJIS - LA CHANSON DU GROS LAPIN (CLIP)', channel: 'Monsieur Seby', duration_s: 213, meta: ['1.7M views', '8 years ago'] }] });
        const r = ytCalls('/youtubei/v1/search')[0];
        assert.strictEqual(r.method, 'POST');
        assert.strictEqual(r.headers, null, 'anonymous');
        assert.deepStrictEqual(r.body, { context: { client: { clientName: 'TVHTML5', clientVersion: '7.20261103.19.00', hl: 'en' } }, query: 'bunny' });
        yt.search = () => Promise.reject(new Error('ENETUNREACH'));
        c.send({ cmd: 'search', q: 'x' });
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'search offline');
        yt.search = () => ({ status: 200, body: JSON.stringify(SEARCH) });
    });

    await t('play cached: connect + playFile + ytdec args, no fetcher', async () => {
        c.clear(); calls.length = 0; fs.writeFileSync(ytlog, ''); setMode('ok');
        fs.chmodSync(path.join(cache, 'DemoVideo01'), 0o700);       // cached by 0.3.8 or older
        c.send({ cmd: 'play', id: 'DemoVideo01', rect: '1836x504', fill: true });
        const pl = await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        assert.strictEqual(pl.buffering, false);
        assert.ok(!fs.existsSync(ctl + '.log'), 'no fetcher');
        assert.deepStrictEqual(called('connect')[0].a, { sourceID: 1046, sinkID: 1024 });
        assert.deepStrictEqual(called('playFile')[0].a, { path: path.join(cache, 'DemoVideo01', 'audio.m4a'), languageCode: 7695972 });
        assert.strictEqual(called('playFile')[0].inst, 'OapGenericMedia');
        // BMW's media engine (its own uid) opens audio.m4a by name: it must pass through the folder, not list it
        assert.strictEqual(fs.statSync(path.join(cache, 'DemoVideo01')).mode & 0o777, 0o711, 'an old 0700 folder opened up');
        await waitUntil(() => ytdecLines().length > 0);
        assert.ok(ytdecLines()[0].endsWith('argv --dir ' + path.join(cache, 'DemoVideo01') + ' --rect 1836x504 --fill --log ' + path.join(tmp, 'ytdec.log')), ytdecLines()[0]);
    });

    await t('the player\'s own metadata (newer firmware): logged, keys as names or numbers; none of them said so', async () => {
        assert.strictEqual(typeof subs.currentItemMetadata, 'function', 'subscribed');
        const n = logs.length;
        subs.currentItemMetadata([{ key: 3, value: { stringValue: 'Поправка a B58' } }, { key: 'ARTIST', value: { stringValue: 'Night Garage' } },
            { key: 17, value: { stringValue: '/var/cache/cover/1.jpg' } }, { key: 44, value: { numeric: 60000 } }, { key: 0, value: { id: Buffer.from('x') } }]);
        subs.currentItemMetadata([{ key: 16, value: { stringValue: 'audio.m4a' } }]);
        assert.deepStrictEqual(logs.slice(n), ['player metadata: TITLE(14 chars) ARTIST(12 chars) COVER_FILE(22 chars) LENGTH=60000',
            'player metadata: no title, artist, album or cover']);
    });

    await t('clock ticks forwarded to ytdec (mono ms) and as time events', async () => {
        subs.currentItemTime({ elapsed: 0, total: 1 }); // ignored
        subs.playerState('PLAYER_STATE_PLAY');
        tick(1226);
        const e = await c.waitFor((x) => x.ev === 'time');
        assert.deepStrictEqual(e, { ev: 'time', elapsed: 1226, total: 60000 });
        await sleep(100);
        const cl = ytdecLines().filter((l) => / in clock /.test(l));
        assert.strictEqual(cl.length, 1);
        const parts = cl[0].split(' ');
        assert.strictEqual(parts[3], '1226');
        assert.ok(Math.abs(Number(parts[4]) - (process.hrtime()[0] * 1000)) < 5000);
    });

    await t('pause/resume/seek/video map to SOME/IP and ytdec stdin', async () => {
        calls.length = 0;
        c.send({ cmd: 'pause' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'paused');
        c.send({ cmd: 'resume' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        c.send({ cmd: 'seek', ms: 30000 });
        c.send({ cmd: 'video', on: false });
        c.send({ cmd: 'video', on: true });
        await sleep(200);
        assert.strictEqual(called('setTime').length, 0, 'no setTime before the restarted file ticks (the player drops it)');
        tick(0);
        await waitUntil(() => called('setTime').length > 0);
        // pause = STOP where it is (the car's player answers OK to PAUSE and plays on); resume = the file again, set there
        assert.deepStrictEqual(called('sendButtonEvent').map((x) => x.a.button), ['STOP', 'STOP'], 'pause; resume releases (STOP, disconnect) and connects again');
        assert.strictEqual(called('connect').length, 1);
        assert.deepStrictEqual(called('playFile').map((x) => x.a.path), [path.join(cache, 'DemoVideo01', 'audio.m4a')]);
        // the seek sent while the file restarts wins: one setTime, there
        assert.deepStrictEqual(called('setTime').map((x) => x.a.newTimeElapsed), [30000]);
        const ins = ytdecLines().map((l) => l.split(' ').slice(1).join(' ')).filter((l) => /^in (pause|resume|seek|video)/.test(l));
        assert.strictEqual(ins[0], 'in pause');
        assert.ok(/^in seek \d+$/.test(ins[1]) && Number(ins[1].split(' ')[2]) < 60000, 'where it stopped: ' + ins[1]);
        assert.deepStrictEqual(ins.slice(2), ['in resume', 'in seek 30000', 'in video 0', 'in video 1']);
    });

    await t('stop disconnects audio and quits ytdec', async () => {
        calls.length = 0;
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        assert.deepStrictEqual(called('sendButtonEvent').map((x) => x.a.button), ['STOP']);
        assert.strictEqual(called('disconnect').length, 1);
        assert.strictEqual(ours().length, 0);
        await sleep(200);
        assert.ok(ytdecLines().some((l) => / in quit$/.test(l)));
        assert.strictEqual(d.child, null);
    });

    const playing = async (id) => {
        c.clear();
        c.send({ cmd: 'play', id: id || 'DemoVideo01', rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        subs.playerState('PLAYER_STATE_PLAY');
    };

    await t('app disconnect stops within 1 s', async () => {
        await playing();
        const child = d.child;
        const t0 = Date.now();
        c.destroy();
        while (ours().length && Date.now() - t0 < 1000) await sleep(10);
        assert.strictEqual(ours().length, 0);
        assert.ok(child.killed || child.exitCode !== null || d.child === null);
        assert.strictEqual(d.state, 'idle');
        c = await client(d.opts.sock);
    });

    await t('fault (uncaught error path) disconnects and goes idle', async () => {
        await playing();
        d.fault(new Error('boom'));
        await c.waitFor((x) => x.ev === 'error' && /boom/.test(x.msg));
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        assert.strictEqual(ours().length, 0);
        assert.strictEqual(d.child, null);
    });

    await t('ytdec dies -> one restart with seek to the clock; second death -> error, audio keeps playing', async () => {
        await sleep(500); fs.writeFileSync(ytlog, ''); setMode('crash'); // let earlier children finish logging
        await playing();
        tick(4000);
        const err = await c.waitFor((x) => x.ev === 'error' && /audio only/.test(x.msg), 3000);
        assert.ok(err);
        const argv = ytdecLines().filter((l) => / argv /.test(l));
        assert.strictEqual(argv.length, 2, ytdecLines().filter((l) => !/ in clock/.test(l)).join('\n'));
        assert.ok(ytdecLines().some((l) => / in seek 4000$/.test(l)));
        assert.strictEqual(ours().length, 1);
        assert.strictEqual(d.state, 'playing');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('no decoded frames for the watchdog period -> child restarted', async () => {
        fs.writeFileSync(ytlog, ''); setMode('stall');
        await playing();
        await sleep(2200);
        const argv = ytdecLines().filter((l) => / argv /.test(l));
        assert.ok(argv.length >= 2, 'restarted: ' + argv.length);
        assert.ok(logs.some((l) => /watchdog/.test(l)));
        setMode('ok');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('STOP mid-file -> held as paused; resume plays the file again at that point', async () => {
        await playing();
        tick(20000);
        calls.length = 0;
        subs.playerState('PLAYER_STATE_STOP');
        await c.waitFor((x) => x.ev === 'state' && x.state === 'paused');
        assert.strictEqual(ours().length, 1, 'audio kept connected');
        c.send({ cmd: 'resume' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        await waitUntil(() => called('playFile').length > 0);
        tick(0);   // the restarted file's first tick: then setTime
        await waitUntil(() => called('setTime').length > 0);
        assert.strictEqual(called('playFile').length, 1);
        assert.deepStrictEqual(called('setTime')[0].a, { newTimeElapsed: 20000 });
        assert.deepStrictEqual(called('sendButtonEvent').map((x) => x.a.button), ['STOP'], 'no PLAY after a stop (ignored): released, connected again');
        assert.strictEqual(called('disconnect').length, 1);
        assert.strictEqual(called('connect').length, 1);
        assert.strictEqual(ours().length, 1, 'one connection');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('end of file (STOP after PLAY, near the end) -> ended, audio released', async () => {
        await playing();
        tick(58000);
        subs.playerState('PLAYER_STATE_STOP');
        await c.waitFor((x) => x.ev === 'state' && x.state === 'ended');
        assert.strictEqual(ours().length, 0);
    });

    const fetchLog = () => JSON.parse(fs.readFileSync(ctl + '.log', 'utf8'));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
    const fetchPlay = async (id) => {
        c.clear();
        c.send({ cmd: 'play', id: id, rect: '1280x720' });
        return c.waitFor((x) => x.ev === 'state' && x.state === 'playing', 4000);
    };

    await t('play uncached: the fetcher (env {}, cwd /) into a fresh dir; preparing pct; playing after audio_ready + 10 s of video', async () => {
        fs.writeFileSync(ctl, ''); fs.writeFileSync(ytlog, ''); setMode('ok');
        const id = 'FFFFFFFFFF1', dir = path.join(cache, id);
        fs.mkdirSync(dir); // a killed fetch's leftover: fetched again
        ['audio.m4a', 'index.bin', 'video.h264.part'].forEach((f) => fs.writeFileSync(path.join(dir, f), 'old'));
        assert.strictEqual(isPlayable(dir), false);
        const pl = await fetchPlay(id);
        assert.deepStrictEqual(c.evs.filter((x) => x.ev === 'state' && x.state === 'preparing').map((x) => x.pct), [0, 35, 70, 94, 99]);
        assert.strictEqual(pl.title, 'Fetched ' + id);
        assert.strictEqual(pl.buffering, false);
        const l = fetchLog();
        assert.deepStrictEqual(l.argv.slice(1), ['fetch', '--cache-dir', path.join(cache, 'ytdlp'), '--height', '720', '--', id, dir]);
        assert.strictEqual(l.cwd, '/');
        assert.ok(l.env.length < 5, 'an empty env: ' + l.env);
        assert.ok(alive(l.pid), 'still fetching');
        assert.ok(fs.statSync(path.join(cache, 'ytdlp')).isDirectory());
        assert.strictEqual(d.fetchedMs, 12000);
        assert.strictEqual(d.preparing, id);
        assert.strictEqual(called('playFile').slice(-1)[0].a.path, path.join(dir, 'audio.m4a'));
        assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o711, 'the media engine passes through, nobody lists it');
        await waitUntil(() => ytdecLines().some((l2) => / argv --dir /.test(l2)));
    });

    await t('buffering: true when the clock nears the fetched video, the watchdog spares ytdec; fetcher done -> false', async () => {
        c.clear(); fs.writeFileSync(ytlog, ''); setMode('stall');
        tick(11500);
        const b = await c.waitFor((x) => x.ev === 'state' && x.buffering === true);
        assert.strictEqual(b.state, 'playing');
        d.child.kill('SIGKILL'); // death 1: restarted, now a ytdec that decodes nothing
        const wd = logs.filter((l) => /watchdog/.test(l)).length;
        await sleep(2000);
        assert.strictEqual(logs.filter((l) => /watchdog/.test(l)).length, wd, 'no watchdog kill while buffering');
        assert.strictEqual(ytdecLines().filter((l) => / argv /.test(l)).length, 1);
        fs.writeFileSync(ctl, 'done');
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.buffering === false);
        assert.strictEqual(d.fetchedMs, Infinity);
        assert.ok(d.fetcher === null && d.preparing === null);
        assert.ok(isPlayable(path.join(cache, 'FFFFFFFFFF1')));
        setMode('ok');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('fetcher error after playback began (and twice again): one "video incomplete" error, audio plays on', async () => {
        fs.writeFileSync(ctl, '');
        await fetchPlay('FFFFFFFFFF2');
        fs.writeFileSync(ctl, 'error');
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'video incomplete: HTTP 403');
        await sleep(300);
        assert.strictEqual(c.evs.filter((x) => x.ev === 'error').length, 1);
        assert.strictEqual(d.state, 'playing');
        assert.strictEqual(ours().length, 1);
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('stop kills the fetcher', async () => {
        fs.writeFileSync(ctl, '');
        await fetchPlay('FFFFFFFFFF3');
        const pid = fetchLog().pid;
        assert.ok(alive(pid));
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        assert.ok(!alive(pid), 'gone by the idle state');
        assert.ok(d.fetcher === null && d.preparing === null);
    });

    await t('speed: a warm spare takes the prefetch (stream lookup); the next spare takes the play, with --info', async () => {
        fs.writeFileSync(ctl, ''); setMode('ok');
        const id = 'FFFFFFFFFF5';
        d.opts.spare = true;
        c.send({ cmd: 'status' });                                   // the app in use
        await waitUntil(() => d.spare && d.spare.warm, 3000);
        const sp = d.spare.child.pid;
        c.send({ cmd: 'prefetch', id: id });
        await waitUntil(() => d.extracting, 1000);
        assert.ok(d.spare && d.spare.child.pid !== sp, 'a new spare at once, not at the next poll');
        await waitUntil(() => fs.existsSync(d.infoFile(id)) && !d.extracting, 3000);
        const x = JSON.parse(fs.readFileSync(ctl + '.extract', 'utf8'));
        assert.strictEqual(x.served, true);
        assert.deepStrictEqual(x.argv, ['extract', '--cache-dir', path.join(cache, 'ytdlp'), '--', id, d.infoFile(id)]);
        assert.ok(!alive(sp) || !d.spare || d.spare.child.pid !== sp, 'the spare was used up');
        c.send({ cmd: 'prefetch', id: id });                         // fresh: not looked up again
        assert.strictEqual(d.extracting, null);
        await waitUntil(() => d.spare && d.spare.warm, 3000);
        await fetchPlay(id);
        const l = fetchLog();
        assert.strictEqual(l.served, true);
        assert.deepStrictEqual(l.argv.slice(1), ['fetch', '--cache-dir', path.join(cache, 'ytdlp'), '--height', '720', '--info', d.infoFile(id), '--', id, path.join(cache, id)]);
        c.send({ cmd: 'stop' });
        await c.waitFor((x2) => x2.ev === 'state' && x2.state === 'idle');
        d.opts.spare = false;
        d.keepWarm();
        assert.strictEqual(d.spare, null, 'spare off: killed');
    });

    await t('extras: chapters + SponsorBlock (hashed prefix, cached), a segment skipped once; position kept, resumed', async () => {
        const id = 'SSSSSSSSSS1', dir = path.join(cache, id);
        mkVideo(id);
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: id, title: 'T', channel: 'C', duration_s: 60, chapters: [[0, 'Intro'], [30000, 'Main']] }));
        const pre = require('crypto').createHash('sha256').update(id).digest('hex').slice(0, 4);
        yt.sb = (url) => ({ status: 200, body: JSON.stringify([{ videoID: 'other111111', segments: [{ category: 'sponsor', actionType: 'skip', segment: [1, 50] }] },
            { videoID: id, segments: [{ category: 'sponsor', actionType: 'skip', segment: [10, 20] }, { category: 'filler', actionType: 'skip', segment: [40, 45] }, { category: 'intro', actionType: 'mute', segment: [0, 5] }] }]) });
        yt.calls.length = 0;
        await playing(id);
        const ex = await c.waitFor((x) => x.ev === 'extras' && x.segments.length);
        assert.deepStrictEqual(ex, { ev: 'extras', id: id, chapters: [[0, 'Intro'], [30000, 'Main']], segments: [[10000, 20000, 'sponsor']] });
        const sbUrl = yt.calls.find((x) => /sponsor/.test(x.url)).url;
        assert.ok(sbUrl.indexOf('skipSegments/' + pre + '?') > 0 && /categories=/.test(sbUrl), sbUrl);
        calls.length = 0;
        tick(12000);
        const sk = await c.waitFor((x) => x.ev === 'skipped');
        assert.deepStrictEqual(sk, { ev: 'skipped', category: 'sponsor', ms: 10000 });
        await waitUntil(() => called('setTime').length);
        assert.strictEqual(called('setTime').slice(-1)[0].a.newTimeElapsed, 20000);
        tick(15000);                                                 // back into it: played
        await sleep(100);
        assert.strictEqual(c.evs.filter((x) => x.ev === 'skipped').length, 1);
        tick(25000);
        c.send({ cmd: 'stop' });
        const pos = await c.waitFor((x) => x.ev === 'positions');
        assert.deepStrictEqual([pos.items[0].id, pos.items[0].ms, pos.items[0].done], [id, 25000, false]);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(cache, 'positions.json'), 'utf8'))[id].ms, 25000);
        assert.strictEqual(fs.statSync(path.join(cache, 'positions.json')).mode & 0o777, 0o600, 'the watch history: root only');
        d.opts.resume = true; calls.length = 0; yt.calls.length = 0;
        await playing(id);
        tick(500);
        await waitUntil(() => called('setTime').length);
        assert.strictEqual(called('setTime')[0].a.newTimeElapsed, 25000, 'resumed where it was left');
        assert.strictEqual(yt.calls.filter((x) => /sponsor/.test(x.url)).length, 0, 'segments from sb.json');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        d.opts.resume = false;
        fs.rmSync ? fs.rmSync(dir, { recursive: true }) : null;
    });

    await t('SponsorBlock: the play\'s skip list; other categories (outro) only in extras, for the app\'s Skip button', async () => {
        const id = 'SSSSSSSSSS2', dir = path.join(cache, id);
        mkVideo(id);
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: id, title: 'T', channel: 'C', duration_s: 60 }));
        yt.sb = () => ({ status: 200, body: JSON.stringify([{ videoID: id, segments: [{ category: 'sponsor', actionType: 'skip', segment: [10, 20] },
            { category: 'outro', actionType: 'skip', segment: [50, 58] }] }]) });
        c.clear();
        c.send({ cmd: 'play', id: id, rect: '1280x720', skip: ['outro'] });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        subs.playerState('PLAYER_STATE_PLAY');
        const ex = await c.waitFor((x) => x.ev === 'extras' && x.segments.length);
        assert.deepStrictEqual(ex.segments, [[10000, 20000, 'sponsor'], [50000, 58000, 'outro']]);
        tick(12000);
        await sleep(150);
        assert.strictEqual(c.evs.filter((x) => x.ev === 'skipped').length, 0, 'sponsor not in this play\'s list: played');
        tick(51000);
        const sk = await c.waitFor((x) => x.ev === 'skipped');
        assert.strictEqual(sk.category, 'outro');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await t('fetcher error before playable -> error state + "fetch: <msg>", nothing played', async () => {
        fs.writeFileSync(ctl, 'fail'); c.clear(); calls.length = 0;
        c.send({ cmd: 'play', id: 'FFFFFFFFFF4', rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'error', 4000);
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'fetch: boom');
        assert.strictEqual(called('playFile').length, 0);
        assert.strictEqual(d.fetcher, null);
    });

    await t('fetcher error before playable: retried after a wait (retry event), then plays', async () => {
        fs.writeFileSync(ctl, 'fail'); c.clear(); calls.length = 0;
        d.opts.fetchRetryMs = [300];
        c.send({ cmd: 'play', id: 'FFFFFFFFFR4', rect: '1280x720' });
        const r = await c.waitFor((x) => x.ev === 'retry', 4000);
        assert.deepStrictEqual(r, { ev: 'retry', id: 'FFFFFFFFFR4', n: 1, msg: 'boom' });
        fs.writeFileSync(ctl, '');                          // the network back
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.id === 'FFFFFFFFFR4', 4000);
        assert.ok(!c.evs.some((x) => x.ev === 'state' && x.state === 'error'), 'no error on the way');
        d.opts.fetchRetryMs = [];
        c.send({ cmd: 'stop' }); await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        fs.rmSync(path.join(cache, 'FFFFFFFFFR4'), { recursive: true, force: true });
    });

    await t('a refused video (unavailable) is not retried', async () => {
        fs.writeFileSync(ctl, 'gone'); c.clear();
        d.opts.fetchRetryMs = [300];
        c.send({ cmd: 'play', id: 'FFFFFFFFFG4', rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'fetch: Video unavailable', 4000);
        assert.ok(!c.evs.some((x) => x.ev === 'retry'), 'no retry');
        d.opts.fetchRetryMs = [];
        fs.writeFileSync(ctl, '');
    });

    await t('a second play during the first one\'s playFile keeps the second\'s audio', async () => {
        c.clear(); slowPlayFile = 300;
        c.send({ cmd: 'play', id: 'DemoVideo01', rect: '1280x720' });
        await sleep(50);
        c.send({ cmd: 'play', id: 'PPPPPPPPPPP', rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.id === 'PPPPPPPPPPP', 4000);
        await sleep(800);
        slowPlayFile = 0;
        assert.strictEqual(ours().length, 1, JSON.stringify(ours()));
        assert.strictEqual(called('playFile').slice(-1)[0].a.path, path.join(cache, 'PPPPPPPPPPP', 'audio.m4a'));
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        assert.strictEqual(ours().length, 0);
    });

    // ---- head start: audio.head.m4a first, audio.m4a when the fetcher has it all
    const headPlay = async (id, m) => {
        fs.writeFileSync(ctl, m); fs.writeFileSync(ytlog, ''); setMode('ok'); calls.length = 0;
        const pl = await fetchPlay(id);
        calls.splice(0, calls.findIndex((x) => x.m === 'connect')); // the previous play's STOP
        subs.playerState('PLAYER_STATE_PLAY');
        return pl;
    };
    const hdir = (id) => path.join(cache, id);
    const ytdecIns = () => ytdecLines().map((l) => l.split(' ').slice(1).join(' ')).filter((l) => /^in (pause|resume|seek)/.test(l));
    const stopIdle = async () => { c.send({ cmd: 'stop' }); await c.waitFor((x) => x.ev === 'state' && x.state === 'idle'); };

    await t('head: plays audio.head.m4a on audio_head + 10 s video; audio_ready -> playFile(audio.m4a) on the same connection + setTime; head removed', async () => {
        const id = 'FFFFFFFFFH1';
        const pl = await headPlay(id, 'head');
        assert.strictEqual(pl.buffering, false);
        assert.strictEqual(called('playFile')[0].a.path, path.join(hdir(id), 'audio.head.m4a'));
        await waitUntil(() => called('setTime').length === 1);
        assert.deepStrictEqual(called('playFile').map((x) => path.basename(x.a.path)), ['audio.head.m4a', 'audio.m4a']);
        assert.ok(called('setTime')[0].a.newTimeElapsed < 2000, JSON.stringify(called('setTime')[0].a));
        assert.strictEqual(called('connect').length, 1, 'one connection');
        assert.strictEqual(ours().length, 1);
        assert.ok(!fs.existsSync(path.join(hdir(id), 'audio.head.m4a')), 'head removed after the switch');
        assert.strictEqual(d.head, null);
        assert.strictEqual(d.state, 'playing');
        await stopIdle();
    });

    await t('head: total is the video\'s (meta), not the head file\'s; switch seeks to the extrapolated clock; stale times after it ignored', async () => {
        const id = 'FFFFFFFFFH2';
        await headPlay(id, 'hold');
        c.clear();
        tick(20000);
        const tm = await c.waitFor((x) => x.ev === 'time');
        assert.deepStrictEqual(tm, { ev: 'time', elapsed: 20000, total: 600000 });
        await sleep(200);
        fs.writeFileSync(ctl, 'full');
        await waitUntil(() => called('setTime').length === 1);
        const at = called('setTime')[0].a.newTimeElapsed;
        assert.ok(at >= 20200 && at < 22000, 'clock extrapolated: ' + at);
        assert.strictEqual(path.basename(called('playFile').slice(-1)[0].a.path), 'audio.m4a');
        tick(300); // the restart's own time before the setTime landed
        assert.ok(d.elapsed >= 20000, 'stale time ignored: ' + d.elapsed);
        assert.ok(!ytdecLines().some((l) => / in clock 300 /.test(l)), 'ytdec never sees the restart at 0');
        await stopIdle();
    });

    await t('head: the full file\'s PLAY during the switch still arms its end -> ended', async () => {
        await headPlay('FFFFFFFFFH9', 'hold');
        tick(20000);
        slowPlayFile = 300;
        fs.writeFileSync(ctl, 'done');
        await waitUntil(() => called('playFile').length === 2);
        subs.playerState('PLAYER_STATE_STOP'); // the head stops for the new file: ignored
        subs.playerState('PLAYER_STATE_PLAY'); // the full file starts, before our setTime
        await waitUntil(() => called('setTime').length === 1);
        slowPlayFile = 0;
        assert.strictEqual(d.state, 'playing');
        subs.currentItemTime({ elapsed: 598000, total: 600000 });
        subs.playerState('PLAYER_STATE_STOP');
        await c.waitFor((x) => x.ev === 'state' && x.state === 'ended');
        assert.strictEqual(ours().length, 0);
    });

    await t('head runs out before audio.m4a: buffering, player paused, STOP at its end is not `ended`; audio_ready resumes there', async () => {
        const id = 'FFFFFFFFFH3';
        await headPlay(id, 'hold');
        c.clear();
        tick(58600); // within headMarginMs of the 60 s head
        const b = await c.waitFor((x) => x.ev === 'state' && x.buffering === true);
        assert.strictEqual(b.state, 'playing');
        assert.deepStrictEqual(called('sendButtonEvent').map((x) => x.a.button), ['STOP']);
        subs.playerState('PLAYER_STATE_STOP');
        tick(59500);
        await sleep(200);
        assert.strictEqual(d.state, 'playing');
        assert.strictEqual(d.elapsed, 58600);
        assert.ok(!c.evs.some((x) => x.ev === 'state' && x.state === 'ended'));
        assert.strictEqual(ours().length, 1);
        assert.deepStrictEqual(ytdecIns(), ['in pause']);
        fs.writeFileSync(ctl, 'done'); // all of it: past the 12 s of video fetched, buffering ends with the fetch
        await waitUntil(() => called('playFile').length === 2 && d.tickWaiter);
        assert.strictEqual(called('connect').length, 2, 'STOP recovery uses a fresh connection');
        assert.strictEqual(called('setTime').length, 0, 'setTime waits for the new file first tick');
        tick(0);
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.buffering === false);
        assert.deepStrictEqual(called('setTime').map((x) => x.a.newTimeElapsed), [58600]);
        assert.strictEqual(path.basename(called('playFile').slice(-1)[0].a.path), 'audio.m4a');
        await waitUntil(() => ytdecIns().length === 3);
        assert.deepStrictEqual(ytdecIns(), ['in pause', 'in seek 58600', 'in resume']);
        await stopIdle();
    });

    await t('preparing on the head: pct moves with the video lead', async () => {
        c.clear();
        await headPlay('FFFFFFFFFHA', 'head');
        assert.deepStrictEqual(c.evs.filter((x) => x.ev === 'state' && x.state === 'preparing').map((x) => x.pct), [0, 35, 70, 94, 99]);
        await stopIdle();
    });

    await t('seek past the head before audio.m4a: buffering, no setTime on the head; audio_ready -> playFile + setTime there', async () => {
        const id = 'FFFFFFFFFH4';
        await headPlay(id, 'hold');
        c.clear();
        c.send({ cmd: 'seek', ms: 300000 });
        await c.waitFor((x) => x.ev === 'state' && x.buffering === true);
        assert.strictEqual(called('setTime').length, 0);
        assert.deepStrictEqual(called('sendButtonEvent').map((x) => x.a.button), ['STOP']);
        c.send({ cmd: 'pause' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'paused');
        c.send({ cmd: 'resume' }); // still waiting: playing + buffering, no PLAY
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.buffering === true);
        assert.ok(!called('sendButtonEvent').some((x) => x.a.button === 'PLAY'));
        fs.writeFileSync(ctl, 'done'); // all of it: past the 12 s of video fetched, buffering ends with the fetch
        await waitUntil(() => called('playFile').length === 2 && d.tickWaiter);
        assert.strictEqual(called('connect').length, 2, 'seek beyond the prefix reconnects after STOP');
        assert.strictEqual(called('setTime').length, 0, 'no early setTime on the stopped connection');
        tick(0);
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.buffering === false);
        assert.deepStrictEqual(called('setTime').map((x) => x.a.newTimeElapsed), [300000]);
        await waitUntil(() => ytdecIns().slice(-2).join() === 'in seek 300000,in resume');
        await stopIdle();
    });

    await t('paused on the head when audio.m4a arrives: no switch until resume, which plays audio.m4a at that point', async () => {
        const id = 'FFFFFFFFFH5';
        await headPlay(id, 'hold');
        tick(15000);
        c.send({ cmd: 'pause' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'paused');
        fs.writeFileSync(ctl, 'full');
        await waitUntil(() => d.fullReady);
        await sleep(100);
        assert.strictEqual(called('playFile').length, 1);
        c.send({ cmd: 'resume' });
        await waitUntil(() => called('setTime').length === 1, 5000);   // (no tick comes: resume's 3 s tick wait runs out first)
        assert.strictEqual(path.basename(called('playFile').slice(-1)[0].a.path), 'audio.m4a');
        assert.deepStrictEqual(called('setTime')[0].a, { newTimeElapsed: 15000 });
        assert.ok(!called('sendButtonEvent').some((x) => x.a.button === 'PLAY'));
        await stopIdle();
    });

    await t('stop during the switch: release waits for the playFile, no setTime after, audio released', async () => {
        const id = 'FFFFFFFFFH6';
        await headPlay(id, 'hold');
        tick(10000);
        slowPlayFile = 400;
        fs.writeFileSync(ctl, 'full');
        await waitUntil(() => called('playFile').length === 2);
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        slowPlayFile = 0;
        await sleep(300);
        assert.strictEqual(called('setTime').length, 0);
        assert.strictEqual(ours().length, 0);
        const ms = calls.map((x) => x.m);
        assert.ok(ms.lastIndexOf('playFile') < ms.indexOf('disconnect'), ms.join());
    });

    await t('a new play during the switch: the old switch does nothing more, the new video plays', async () => {
        await headPlay('FFFFFFFFFH7', 'hold');
        slowPlayFile = 300;
        fs.writeFileSync(ctl, 'full');
        await waitUntil(() => called('playFile').length === 2);
        c.clear();
        c.send({ cmd: 'play', id: 'DemoVideo01', rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.id === 'DemoVideo01', 4000);
        slowPlayFile = 0;
        await sleep(300);
        assert.strictEqual(called('setTime').length, 0);
        assert.strictEqual(ours().length, 1);
        assert.strictEqual(called('playFile').slice(-1)[0].a.path, path.join(cache, 'DemoVideo01', 'audio.m4a'));
        await stopIdle();
    });

    await t('fetcher dies while only the head is there (and twice again): error state, audio released', async () => {
        await headPlay('FFFFFFFFFH8', 'hold');
        fs.writeFileSync(ctl, 'dead');
        await c.waitFor((x) => x.ev === 'state' && x.state === 'error', 4000);
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'fetch: HTTP 403');
        assert.strictEqual(ours().length, 0);
    });

    // ---- account and feeds
    const authEv = (st) => (x) => x.ev === 'auth' && x.state === st;
    const readAcct = () => JSON.parse(fs.readFileSync(acct, 'utf8'));
    const ok = (o) => ({ status: 200, body: JSON.stringify(o) });

    await t('zoom while playing: ytdec again with the other mode at the clock, no error; same mode does nothing', async () => {
        await sleep(300); fs.writeFileSync(ytlog, ''); setMode('ok');
        await playing();
        await waitUntil(() => ytdecLines().some((l) => / argv /.test(l)));
        const zoomAt = Date.now();
        tick(4000);
        c.send({ cmd: 'fill', on: true });
        await waitUntil(() => ytdecLines().filter((l) => / argv /.test(l)).length === 2);
        const argv = ytdecLines().filter((l) => / argv /.test(l));
        assert.ok(!/--fill/.test(argv[0]) && /--rect 1280x720 --fill /.test(argv[1]), argv.join('\n'));
        await waitUntil(() => ytdecLines().some((l) => / in seek [4-9]\d{3}$/.test(l)));
        const seek = ytdecLines().map((l) => / in seek (\d+)$/.exec(l)).filter(Boolean).map((m) => Number(m[1])).filter((ms) => ms >= 4000)[0];
        assert.ok(seek <= 4000 + Date.now() - zoomAt + 100, 'at the clock: ' + seek);
        c.send({ cmd: 'fill', on: true });
        await sleep(300);
        assert.strictEqual(ytdecLines().filter((l) => / argv /.test(l)).length, 2);
        assert.ok(!c.evs.some((x) => x.ev === 'error'));
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('quality while playing: fetched again at that height; same height: nothing', async () => {
        fs.writeFileSync(ctl, ''); setMode('ok');
        const id = 'FFFFFFFFFF7';
        await fetchPlay(id);
        c.send({ cmd: 'quality', quality: '720' });            // auto is 720 here
        await sleep(300);
        assert.ok(!c.evs.some((x) => x.ev === 'state' && x.state === 'preparing' && c.evs.indexOf(x) > c.evs.findIndex((y) => y.state === 'playing')));
        c.clear();
        c.send({ cmd: 'quality', quality: '480' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing', 4000);
        assert.deepStrictEqual(fetchLog().argv.slice(1, 5), ['fetch', '--cache-dir', path.join(cache, 'ytdlp'), '--height'].slice(0, 4));
        assert.strictEqual(fetchLog().argv[fetchLog().argv.indexOf('--height') + 1], '480');
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
    });

    await t('auth_status with no account: signed out', async () => {
        c.clear();
        c.send({ cmd: 'auth_status' });
        await c.waitFor(authEv('signed_out'));
    });

    await t('TV page with inline credentials also supplies the live client version', async () => {
        yt.inline = true;
        const creds = await d.account.creds();
        assert.strictEqual(creds.ver, TV_VER);
        yt.inline = false;
    });

    await t('auth: creds from the base script, device code, polled until signed in; account 0600 in a dir others cannot list', async () => {
        c.clear(); yt.calls.length = 0;
        let polls = 0;
        yt.token = (b) => (++polls < 3 ? { error: 'authorization_pending' } : { access_token: 'ACCESS-1', refresh_token: 'REFRESH-1', expires_in: 72000 });
        c.send({ cmd: 'auth' });
        const e = await c.waitFor(authEv('code'));
        assert.strictEqual(e.code, 'ABC-DEF-GHI');
        assert.strictEqual(e.url, 'https://www.google.com/device');
        assert.ok(e.expires > 1700 && e.expires <= 1800, String(e.expires));
        const dc = ytCalls('/device/code')[0].body;
        assert.strictEqual(dc.client_id, '123-abc.apps.googleusercontent.com');
        assert.ok(/^[0-9a-f]{32}$/.test(dc.device_id) && dc.device_model === 'ytlr::' && /gdata\.youtube\.com/.test(dc.scope));
        c.send({ cmd: 'auth' }); // again while the code is shown: the same code, no second device flow
        await c.waitFor((x) => x.ev === 'auth' && x.state === 'code' && c.evs.filter(authEv('code')).length === 2);
        await c.waitFor(authEv('signed_in'), 3000);
        assert.strictEqual(ytCalls('/device/code').length, 1);
        assert.deepStrictEqual(ytCalls('/oauth2/token')[0].body, { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'SeCrEt-1', code: 'DEV-CODE-XYZ', grant_type: 'http://oauth.net/grant_type/device/1.0' });
        assert.strictEqual(fs.statSync(acct).mode & 0o777, 0o600);
        assert.strictEqual(fs.statSync(path.dirname(acct)).mode & 0o077, 0, 'state dir stays 0700');
        const a = readAcct();
        assert.ok(a.access === 'ACCESS-1' && a.refresh === 'REFRESH-1' && a.exp > Date.now() + 71000e3);
        assert.strictEqual(a.ver, TV_VER, 'TV client version is persisted with the account');
        assert.ok(!fs.existsSync(acct + '.tmp'));
        c.send({ cmd: 'auth_status' });
        await c.waitFor((x) => authEv('signed_in')(x) && c.evs.filter(authEv('signed_in')).length === 2);
    });

    await t('feed subs: TVHTML5 browse with the token; video tiles and shorts (short:true), each once, channel and length, LIVE in the length: live:true', async () => {
        c.clear(); yt.calls.length = 0;
        yt.browse = (h, b) => ok(BROWSE);
        const cachedCred = d.account.cred;
        d.account.cred = null; // a restarted daemon still uses the account's saved TV version
        c.send({ cmd: 'feed', which: 'subs' });
        const e = await c.waitFor((x) => x.ev === 'feed');
        const v1 = { id: 'VVVVVVVVVV1', title: 'First', channel: 'Chan A', duration_s: 2390, meta: ['1K views'] };
        const v2 = { id: 'VVVVVVVVVV2', title: 'Second', channel: 'Chan C', duration_s: 3723, meta: ['1K views'] };
        const v3 = { id: 'VVVVVVVVVV3', title: 'Live', channel: 'Chan D', duration_s: null, meta: ['1K views'], live: true };
        const s1 = { id: 'SSSSSSSSSS1', title: 'A short', channel: 'Chan B', duration_s: null, meta: ['1K views'], short: true };
        assert.deepStrictEqual(e, { ev: 'feed', which: 'subs', items: [v1, s1, v2, v3],
            shelves: [{ title: '', items: [v1, s1] }, { title: '', items: [v2, v1, v3] }] });
        const b = ytCalls('/browse')[0];
        assert.strictEqual(b.headers.Authorization, 'Bearer ACCESS-1');
        assert.strictEqual(b.body.browseId, 'FEsubscriptions');
        assert.strictEqual(b.body.context.client.clientName, 'TVHTML5');
        assert.strictEqual(b.body.context.client.clientVersion, TV_VER);
        d.account.cred = cachedCred;
        assert.strictEqual(ytCalls('/oauth2/token').length, 0, 'no refresh with 20 h left');
        c.send({ cmd: 'feed', which: 'wl' });
        await c.waitFor((x) => x.ev === 'feed' && x.which === 'wl');
        assert.strictEqual(ytCalls('/browse')[1].body.browseId, 'VLWL');
        c.send({ cmd: 'feed', which: 'nope' });
        await c.waitFor((x) => x.ev === 'feed' && x.which === 'nope' && x.error === 'unknown feed');
        c.send({ cmd: 'search', q: 'bunny' });
        await c.waitFor((x) => x.ev === 'results');
        assert.strictEqual(ytCalls('/youtubei/v1/search')[0].headers.Authorization, 'Bearer ACCESS-1', 'signed in: searched with the token');
        assert.strictEqual(ytCalls('/youtubei/v1/search')[0].body.context.client.clientVersion, TV_VER);
    });

    await t('token with < 5 min left refreshed before the browse; a 401 forces one more refresh', async () => {
        const a = readAcct(); a.exp = Date.now() + 60000; fs.writeFileSync(acct, JSON.stringify(a), { mode: 0o600 });
        c.clear(); yt.calls.length = 0;
        let n = 1;
        yt.token = (b) => { assert.deepStrictEqual(b, { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'SeCrEt-1', refresh_token: 'REFRESH-1', grant_type: 'refresh_token' }); return { access_token: 'ACCESS-' + (++n), expires_in: 3600 }; };
        yt.browse = (h) => (h.Authorization === 'Bearer ACCESS-2' ? { status: 401, body: '{}' } : ok(BROWSE));
        c.send({ cmd: 'feed', which: 'home' });
        const e = await c.waitFor((x) => x.ev === 'feed');
        assert.strictEqual(e.items.length, 4, JSON.stringify(e));
        assert.deepStrictEqual(ytCalls('/browse').map((x) => x.headers.Authorization), ['Bearer ACCESS-2', 'Bearer ACCESS-3']);
        assert.strictEqual(ytCalls('/browse')[0].body.browseId, 'FEwhat_to_watch');
        const a2 = readAcct();
        assert.ok(a2.access === 'ACCESS-3' && a2.refresh === 'REFRESH-1' && a2.exp > Date.now() + 3500e3);
        assert.strictEqual(fs.statSync(acct).mode & 0o777, 0o600);
    });

    await t('youtube offline: feed error, still signed in', async () => {
        c.clear();
        yt.browse = () => Promise.reject(new Error('ENETUNREACH'));
        c.send({ cmd: 'feed', which: 'subs' });
        await c.waitFor((x) => x.ev === 'feed' && x.error === 'feed offline');
        assert.ok(fs.existsSync(acct));
    });

    await t('refresh answered invalid_grant: signed out, account gone, the feed says so', async () => {
        const a = readAcct(); a.exp = Date.now() - 1000; fs.writeFileSync(acct, JSON.stringify(a), { mode: 0o600 });
        c.clear();
        yt.token = () => ({ error: 'invalid_grant' });
        c.send({ cmd: 'feed', which: 'subs' });
        await c.waitFor(authEv('signed_out'));
        await c.waitFor((x) => x.ev === 'feed' && x.error === 'signed out');
        assert.ok(!fs.existsSync(acct));
    });

    await t('sign_out deletes the account; a code left to expire -> signed out; no creds -> auth error', async () => {
        fs.writeFileSync(acct, JSON.stringify({ cid: 'x', sec: 'y', access: 'ACCESS-1', refresh: 'REFRESH-1', exp: Date.now() + 1e7 }), { mode: 0o600 });
        c.clear();
        c.send({ cmd: 'sign_out' });
        await c.waitFor(authEv('signed_out'));
        assert.ok(!fs.existsSync(acct));
        c.clear(); yt.inline = true; yt.expiresIn = 0.15;
        yt.token = () => ({ error: 'authorization_pending' });
        c.send({ cmd: 'auth' });
        await c.waitFor(authEv('code'));
        await c.waitFor(authEv('signed_out'), 2000);
        c.clear(); yt.creds = false; d.account.cred = null; // a fresh process: the page has no client id
        c.send({ cmd: 'auth' });
        const e = await c.waitFor(authEv('error'));
        assert.ok(/no client id/.test(e.msg));
        yt.creds = undefined; yt.inline = false; yt.expiresIn = 1800;
    });

    await t('feed: prototype names are unknown feeds; asks while one is in flight share its browse', async () => {
        fs.writeFileSync(acct, JSON.stringify({ cid: 'x', sec: 'y', access: 'ACCESS-1', refresh: 'REFRESH-1', exp: Date.now() + 1e7 }), { mode: 0o600 });
        c.clear(); yt.calls.length = 0;
        ['constructor', 'toString', '__proto__', 'hasOwnProperty'].forEach((w) => c.send({ cmd: 'feed', which: w }));
        await c.waitFor(() => c.evs.filter((x) => x.ev === 'feed' && x.error === 'unknown feed').length === 4);
        assert.strictEqual(ytCalls('/browse').length, 0);
        yt.slow = { '/browse': 200 }; yt.browse = () => ok(BROWSE);
        for (let i = 0; i < 5; i++) c.send({ cmd: 'feed', which: 'subs' });
        await c.waitFor((x) => x.ev === 'feed' && x.which === 'subs' && x.items);
        await sleep(300);
        assert.strictEqual(ytCalls('/browse').length, 1, 'one browse for five asks');
        c.send({ cmd: 'feed', which: 'subs' });
        await c.waitFor(() => ytCalls('/browse').length === 2, 2000);
        yt.slow = null;
    });

    await t('sign_out while a refresh is in flight: the new token is not written back', async () => {
        fs.writeFileSync(acct, JSON.stringify({ cid: 'x', sec: 'y', access: 'ACCESS-1', refresh: 'REFRESH-1', exp: Date.now() - 1000 }), { mode: 0o600 });
        c.clear(); yt.calls.length = 0;
        yt.slow = { '/oauth2/token': 200 }; yt.token = () => ({ access_token: 'ACCESS-2', expires_in: 3600 });
        c.send({ cmd: 'feed', which: 'home' });
        await waitUntil(() => ytCalls('/oauth2/token').length === 1);
        c.send({ cmd: 'sign_out' });
        await c.waitFor(authEv('signed_out'));
        await c.waitFor((x) => x.ev === 'feed' && x.error === 'signed out', 2000);
        await sleep(100);
        assert.ok(!fs.existsSync(acct), 'still signed out');
        assert.strictEqual(ytCalls('/browse').length, 0);
        yt.slow = null;
    });

    await t('sign_out during the device-code request: no code, no polling', async () => {
        c.clear(); yt.calls.length = 0;
        yt.slow = { '/device/code': 200 }; yt.token = () => ({ error: 'authorization_pending' });
        c.send({ cmd: 'auth' });
        await waitUntil(() => ytCalls('/device/code').length === 1);
        c.send({ cmd: 'sign_out' });
        await sleep(400);
        assert.strictEqual(c.evs.filter(authEv('code')).length, 0, JSON.stringify(c.evs));
        assert.strictEqual(d.account.pending, null);
        assert.strictEqual(ytCalls('/oauth2/token').length, 0, 'no poll');
        yt.slow = null;
    });

    await t('sign_out while a poll is offline: not re-armed', async () => {
        c.clear(); yt.calls.length = 0;
        yt.slow = { '/oauth2/token': 150 }; yt.token = () => { throw new Error('ENETUNREACH'); };
        c.send({ cmd: 'auth' });
        await c.waitFor(authEv('code'));
        await waitUntil(() => ytCalls('/oauth2/token').length === 1);
        c.send({ cmd: 'sign_out' });
        await sleep(500);
        assert.strictEqual(ytCalls('/oauth2/token').length, 1, 'no poll after the sign-out');
        yt.slow = null;
    });

    await t('client id/secret scraped once a process; scraped again once when the device code is refused', async () => {
        c.clear(); yt.calls.length = 0;
        yt.token = () => ({ error: 'authorization_pending' });
        c.send({ cmd: 'auth' });
        await c.waitFor(authEv('code'));
        assert.strictEqual(ytCalls('/tv').length, 0, 'cached: no scrape');
        c.send({ cmd: 'sign_out' }); await c.waitFor(authEv('signed_out'));
        c.clear(); yt.calls.length = 0; yt.refuse = 1;
        c.send({ cmd: 'auth' });
        await c.waitFor(authEv('code'));
        assert.strictEqual(ytCalls('/tv').length, 1, 'refused: one scrape');
        assert.strictEqual(ytCalls('/device/code').length, 2);
        c.send({ cmd: 'sign_out' }); await c.waitFor(authEv('signed_out'));
        c.clear(); yt.calls.length = 0; yt.refuse = 2;
        c.send({ cmd: 'auth' });
        const e = await c.waitFor(authEv('error'));
        assert.ok(/refused/.test(e.msg) && ytCalls('/tv').length === 1 && ytCalls('/device/code').length === 2, 'refused twice: an error, no loop');
        yt.refuse = 0;
    });

    // ---- the fetch uid and the fetch helper
    const fsRoot = path.join(tmp, 'uidfs');
    const mkdirs = (dd) => { if (!fs.existsSync(dd)) { mkdirs(path.dirname(dd)); fs.mkdirSync(dd); } }; // (Node 8: no recursive)
    const put = (f, text) => { mkdirs(path.dirname(f)); fs.writeFileSync(f, text); };
    const rejects = (p, re) => p.then(() => { throw new Error('resolved, expected ' + re); }, (e) => assert.ok(re.test(e.message), e.message)); // (Node 8: no assert.rejects)
    const uo = { stateDir: path.join(fsRoot, 'var/opt/jap-ridetube-d/state'), etcDir: path.join(fsRoot, 'etc'), oapRoot: path.join(fsRoot, 'oap'),
        toolRoot: path.join(fsRoot, 'var/opt'), procDir: path.join(fsRoot, 'proc'), log: (m) => logs.push(m),
        mainapps: [{ root: path.join(fsRoot, 'mainapp'), hmi: 'HmiMain3D' }, { root: path.join(fsRoot, 'mainapp21'), hmi: 'Hmi8' }] };

    await t('fetch uid: none without MainApp\'s ranges; then the lowest free above them, written for the uplink', async () => {
        assert.strictEqual(pickFetchUid(uo), null);
        assert.ok(logs.some((l) => /internet uid: none: MainApp/.test(l)));
        assert.ok(!fs.existsSync(path.join(uo.stateDir, 'internet-uids')));
        put(path.join(fsRoot, 'mainapp/config/base.json'), JSON.stringify({ usableUidsAndGids: { min: 10000, max: 12499 },
            usableUidsAndGidsRse: { rse1: { min: 12600, max: 12700 } }, mainAppUids: [12701] }));
        put(path.join(fsRoot, 'etc/passwd'), 'root:x:0:0::/root:/bin/sh\nfoo:x:12702:12703::/:/bin/false\n');
        put(path.join(fsRoot, 'etc/group'), 'root:x:0:\nbar:x:12704:\n');
        mkdirs(path.join(fsRoot, 'oap/oap_12705'));
        put(path.join(fsRoot, 'oap/oap_12201/data/apps/x.json'), JSON.stringify({ userId: 12706 }));
        put(path.join(fsRoot, 'oap/oap_12201/security/uids.txt'), '12707=some.app\n');
        put(path.join(fsRoot, 'var/opt/mgu-uplink/uids.d/mgu-updater'), '12708\n');
        put(path.join(fsRoot, 'var/opt/mgu-uplink/uids.d/iteriodev-tailscale'), '3910 12709 # two\n');
        put(path.join(fsRoot, 'var/opt/mgu-uplink/uids.d/jap-ridetube-d'), '12710\n');              // our own: not taken
        mkdirs(path.join(fsRoot, 'var/opt/mgu-uplink/current'));
        put(path.join(fsRoot, 'var/opt/mgu-updater/state/uids.json'), JSON.stringify({ build: 12711, fetch: 12712, web: 12713 }));
        put(path.join(fsRoot, 'proc/77/status'), 'Name:\tx\nUid:\t12714\t12714\t12714\t12714\nGid:\t12715\t12715\t12715\t12715\n');
        assert.strictEqual(pickFetchUid(uo), 12710, 'every lower one is taken; our own drop-in is not');
        const rd = (f) => fs.readFileSync(path.join(fsRoot, f), 'utf8');
        assert.strictEqual(rd('var/opt/jap-ridetube-d/state/internet-uids'), '12710\n');
        assert.deepStrictEqual(JSON.parse(rd('var/opt/jap-ridetube-d/state/uids.json')), { fetch: 12710 });
        assert.strictEqual(rd('var/opt/mgu-uplink/uids.d/jap-ridetube-d'), '12710\n');
        assert.strictEqual(fs.statSync(uo.stateDir).mode & 0o777, 0o700);
    });

    await t('fetch uid: kept while free (its own processes do not count); taken since -> picked again; two MainApps: the running one', async () => {
        put(path.join(fsRoot, 'proc/78/status'), 'Uid:\t12710\t12710\t12710\t12710\n');     // our helper running
        assert.strictEqual(pickFetchUid(uo), 12710, 'kept');
        fs.appendFileSync(path.join(fsRoot, 'etc/passwd'), 'new:x:12710:12710::/:/bin/false\n');
        assert.strictEqual(pickFetchUid(uo), 12716, 'taken: the next free (12714/15 run, 12710 in passwd)');
        assert.strictEqual(fs.readFileSync(path.join(fsRoot, 'var/opt/mgu-uplink/uids.d/jap-ridetube-d'), 'utf8'), '12716\n');
        put(path.join(fsRoot, 'mainapp21/config/base.json'), JSON.stringify({ usableUidsAndGids: { min: 20000, max: 29999 } }));
        fs.unlinkSync(path.join(uo.stateDir, 'uids.json'));
        assert.strictEqual(pickFetchUid(uo), null, 'two configs, neither HMI running: unknown');
        put(path.join(fsRoot, 'proc/90/comm'), 'Hmi8\n');
        assert.strictEqual(pickFetchUid(uo), 30000, "iDrive 8's MainApp runs: above its range");
    });

    await t('native UID is reserved separately and never registered with the external uplink', async () => {
        const file = path.join(fsRoot, 'var/opt/mgu-uplink/uids.d/jap-ridetube-d');
        const before = fs.readFileSync(file, 'utf8');
        const native = pickFetchUid(Object.assign({}, uo, { uidRole: 'builtin' }));
        assert.strictEqual(native, 30001);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
        assert.strictEqual(fs.readFileSync(path.join(uo.stateDir, 'internet-uids'), 'utf8'), before);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(uo.stateDir, 'uids.json'))), { fetch: 30000, builtin: 30001 });
        assert.strictEqual(pickFetchUid(uo), 30000);
        assert.strictEqual(pickFetchUid(Object.assign({}, uo, { uidRole: 'builtin' })), native);
    });

    const fakeFetch = path.join(__dirname, 'fake_fetch.js');
    // as root (Docker): a real switch to a uid nothing has; else no switch (only root can)
    const root = process.getuid() === 0, me = root ? 12345 : process.getuid();
    const flogDir = path.join(tmp, 'flog');
    fs.mkdirSync(flogDir); fs.chmodSync(flogDir, 0o777); fs.chmodSync(tmp, 0o711);
    const flog = path.join(flogDir, 'fetch.log');
    const fo = (mode) => ({ noSetuid: !root, fetchCmd: [process.execPath, fakeFetch, flog, mode] });
    const req = { method: 'POST', url: 'https://www.youtube.com/o/oauth2/token', headers: { Authorization: 'Bearer ACCESS-1' },
        body: { client_secret: 'SeCrEt-1', refresh_token: 'REFRESH-1' }, timeoutMs: 300 };

    await t('fetch helper: spawned as the uid, the request (secrets) on stdin only, the answer from stdout', async () => {
        const r = await fetchRequest(fo('ok'), me, req);
        assert.deepStrictEqual(r, { status: 200, body: 'hello' });
        const l = JSON.parse(fs.readFileSync(flog, 'utf8'));
        assert.deepStrictEqual(l.req, req);
        assert.strictEqual(l.uid, me, root ? 'switched to the fetch uid' : 'own uid (not root)');
        const argv = l.argv.join(' ');
        SECRETS.concat(['Bearer']).forEach((x) => assert.ok(argv.indexOf(x) < 0, x + ' in argv'));
        assert.ok(l.env.every((k) => !/SECRET|TOKEN/i.test(k)) && l.env.length < 5, 'an empty env: ' + l.env);
        await rejects(fetchRequest(fo('error'), me, req), /ENETUNREACH/);
    });

    await t('fetch helper: no answer by the timeout -> killed, rejected', async () => {
        const t0 = Date.now();
        await rejects(fetchRequest(fo('hang'), me, req), /timeout/);
        assert.ok(Date.now() - t0 < 2500);
        const pid = JSON.parse(fs.readFileSync(flog, 'utf8')).pid;
        await sleep(100);
        assert.throws(() => process.kill(pid, 0), 'the helper is gone');
    });

    await t('the real helper (ytd.js --fetch): a request it cannot make comes back as an error', async () => {
        const o = { noSetuid: !root, fetchCmd: [process.execPath, '--max-http-header-size=65536', path.join(__dirname, '..', 'ytd.js'), '--fetch'] };
        await rejects(fetchRequest(o, me, { method: 'GET', url: 'https://127.0.0.1:1/', headers: null, body: null, timeoutMs: 3000 }), /ECONNREFUSED/);
    });

    await t('daemon without a fetch uid: sign-in and feeds say so, nothing spawned, no crash', async () => {
        const evs = [];
        const d2 = new Daemon({ someip: someip, srcGen: srcGen, cacheDir: cache, logDir: tmp, sock: path.join(tmp, 'ctl3.sock'),
            accountFile: path.join(tmp, 'acct2.json'), stateDir: path.join(tmp, 'st2'), etcDir: uo.etcDir, oapRoot: uo.oapRoot,
            toolRoot: path.join(tmp, 'none'), procDir: uo.procDir, mainapps: [], fetchCmd: [process.execPath, fakeFetch, flog, 'ok'], log: (m) => logs.push(m) });
        d2.emit = (o) => evs.push(o);
        try { fs.unlinkSync(flog); } catch (e) { /* none */ }
        await d2.account.start();
        const missingUid = evs.pop();
        assert.strictEqual(missingUid.ev, 'auth'); assert.strictEqual(missingUid.state, 'error');
        assert.ok(/no internet uid on the car \(see the log\)$/.test(missingUid.msg));
        fs.writeFileSync(path.join(tmp, 'acct2.json'), JSON.stringify({ cid: 'x', sec: 'y', access: 'A', refresh: 'R', exp: Date.now() + 1e7 }));
        await d2.account.feed('subs');
        assert.deepStrictEqual(evs.pop(), { ev: 'feed', which: 'subs', error: 'no internet uid on the car (see the log)' });
        assert.ok(!fs.existsSync(flog), 'nothing spawned');
    });

    await t('the service version is component.json\'s', async () => {
        assert.strictEqual(VERSION, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'component.json'), 'utf8')).version);
    });

    await t('every log line (daemon, Account, Audio) is kept in the ring; send_logs answers on the socket', async () => {
        ['sign-in: ', 'connect {', 'listening on '].forEach((x) => assert.ok(d.ring.some((l) => l.indexOf(x) > 0), x + ' (Account, Audio, the daemon) not in the ring: ' + d.ring.length));
        assert.ok(d.ring.every((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(l)) && d.ring.length <= 1500);
        c.clear();
        c.send({ cmd: 'send_logs', app: '0.3.12' });
        assert.deepStrictEqual(await c.waitFor((x) => /^logs_/.test(x.ev)), { ev: 'logs_error', msg: 'closed' });
    });

    // ---- send_logs to a local fake relay (MGU_YT_REPORT_URL)
    const relay = { mode: 200, got: [], delay: 0 };
    const srv = require('http').createServer((req, res) => {
        let b = '';
        req.on('data', (x) => { b += x; });
        req.on('end', () => {
            relay.got.push({ url: req.url, method: req.method, type: req.headers['content-type'], body: JSON.parse(b) });
            if (relay.mode === 'hang') return;
            setTimeout(() => {
                const ans = { 200: { id: 'ABC123' }, 410: { error: 'closed' }, 429: { error: 'busy' }, 413: { error: 'too big' }, 500: { error: 'x' }, bad: { id: '<b>no</b>' } };
                res.writeHead(relay.mode === 'bad' ? 200 : relay.mode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(ans[relay.mode]));
            }, relay.delay);
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const rdir = path.join(tmp, 'report'), rcache = path.join(rdir, 'cache'), rstate = path.join(rdir, 'state'), retc = path.join(rdir, 'etc');
    [rdir, rcache, rstate, retc].forEach((x) => fs.mkdirSync(x));
    const FAKE = { cid: '777-fakeclient.apps.googleusercontent.com', sec: 'FaKeSeCrEt99', access: 'ya29.FAKE-ACCESS-TOKEN', refresh: '1//FAKEREFRESHTOKEN0123456789abcd', exp: 1999999999123 };
    fs.writeFileSync(path.join(rstate, 'account.json'), JSON.stringify(FAKE));
    fs.writeFileSync(path.join(retc, 'os-release'), ['NAME="MGU"', 'VERSION="22w45"', 'ID=mgu', 'A=1', 'B=2', 'C=3', 'D=4'].join('\n'));
    const kdir = path.join(rcache, 'KnownVid001');
    fs.mkdirSync(kdir);
    fs.writeFileSync(path.join(kdir, 'meta.json'), JSON.stringify({ id: 'KnownVid001', title: 'My Secret Holiday Video', channel: 'Private Channel Name', duration_s: 60 }));
    fs.writeFileSync(path.join(rcache, 'positions.json'), JSON.stringify({ PosVideo002: { ms: 1, total: 9, title: 'Another Watched Title', channel: 'Some Other Channel', at: 1 } }));
    fs.writeFileSync(path.join(rdir, 'ytdec.log'), Array.from({ length: 400 }, (_, i) => 'ytdec line ' + i + ' dir=' + rcache + '/KnownVid001').join('\n') + '\n');
    process.env.MGU_YT_REPORT_URL = 'http://127.0.0.1:' + srv.address().port;
    const rlogs = [], revs = [];
    const dr = new Daemon({ someip: someip, srcGen: srcGen, cacheDir: rcache, logDir: rdir, stateDir: rstate, accountFile: path.join(rstate, 'account.json'),
        etcDir: retc, noSetuid: !root, fetchCmd: [process.execPath, path.join(__dirname, '..', 'ytd.js'), '--fetch'], reportTimeoutMs: 400, log: (m) => rlogs.push(m) });
    delete process.env.MGU_YT_REPORT_URL;
    dr.fetchUid = me;
    dr.opts.ytRequest = (method, url, headers, body, timeout) => new Promise((resolve, reject) => {
        const req = require('http').request(Object.assign(require('url').parse(url), { method,
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers) }), (res) => {
            let answer = '';
            res.on('data', (chunk) => { answer += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: answer }));
        });
        req.on('error', reject);
        req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
        req.end(JSON.stringify(body));
    });
    dr.emit = (o) => revs.push(o);
    const send = async () => { revs.length = 0; await dr.sendLogs('0.3.12'); return revs.pop(); };
    dr.account.pending = { cid: 'PendingClientId.apps', sec: 'PendingSecret42', device: 'DEVICE-CODE-777', code: 'USR-CDE-XYZ', timer: null };
    dr.onLine(JSON.stringify({ cmd: 'prefetch', id: 'SeenThumb03' }));      // an id the app sent (spare off: nothing runs)
    dr.onLine(JSON.stringify({ cmd: 'playlist', id: 'PLseenplaylist0042' }));
    [
        'sign-in: odd answer ' + FAKE.sec + ' / ' + FAKE.access + ' / ' + FAKE.refresh + ' / ' + FAKE.cid + ' exp ' + FAKE.exp,
        'sign-in poll: client_secret=PendingSecret42 device DEVICE-CODE-777 code USR-CDE-XYZ for PendingClientId.apps',
        'fetch KnownVid001: ERROR: [youtube] KnownVid001: Video unavailable',
        'ytfetch: GET https://rr3---sn-abc.googlevideo.com/videoplayback?ip=81.82.83.84&sig=XYZ&id=o-AB',
        "ytfetch: HTTPSConnectionPool(host='rr3---sn-abc.googlevideo.com', port=443): Max retries exceeded with url: /videoplayback?expire=1&ip=2a02%3A1810%3Aabcd%3A%3A1&sig=QQQ (Caused by timeout)",
        'ytfetch: odd ip=81.82.83.85 alone',
        'thumb UnknownId04: timeout', 'lru removed UnknownId05,KnownVid001', 'ytdec --dir ' + rcache + '/UnknownId06 --rect 1280x720',
        'ytfetch: [youtube] UnknownId07: Downloading webpage', 'playlist list=PLsecretplaylist123 and PLseenplaylist0042', 'positions PosVideo002 SeenThumb03',
        'meta My Secret Holiday Video by Private Channel Name; Another Watched Title', 'channel UCabcdefghijklmnopqrstuv', 'mail someone.private@example.com',
        'vin WBA12345678901234', 'uplink 81.82.83.84 via 192.168.1.1, 10.0.0.2, 172.20.1.1, 127.0.0.1, 8.8.4.4 and 2a02:1810:abcd::1',
        'hdr Authorization: Bearer abc.def-ghi and access_token=zzz123456&x=1', 'Cookie: SAPISID=abc; YSC=def',
        'playback error {"code":3,"path":"' + rcache + '/UnknownId08/audio.m4a"}',
        'internet uid: 30000', 'audio: head -> full at 1234 (waiting)', 'clientVersion 7.20251101.10.00'
    ].forEach((l) => dr.log(l));

    await t('send_logs: one POST to MGU_YT_REPORT_URL/v1/report as the fetch helper -> logs_sent with the relay\'s id', async () => {
        assert.strictEqual(dr.opts.reportUrl, 'http://127.0.0.1:' + srv.address().port, 'the env override');
        assert.strictEqual(new Daemon({ reportUrl: 'https://x.example' }).opts.reportUrl, 'https://x.example', 'the option wins');
        assert.strictEqual(new Daemon({}).opts.reportUrl, REPORT_URL, 'else the constant');
        assert.deepStrictEqual(await send(), { ev: 'logs_sent', id: 'ABC123' });
        const g = relay.got.pop();
        assert.deepStrictEqual([g.method, g.url, g.type], ['POST', '/v1/report', 'application/json']);
        assert.deepStrictEqual([g.body.app, g.body.service], ['0.3.12', VERSION]);
        assert.strictEqual(g.body.os, 'NAME="MGU"\nVERSION="22w45"\nID=mgu\nA=1\nB=2', 'the first 5 lines of os-release');
        const ytl = g.body.log.split('\n').filter((l) => /^ytdec line/.test(l));
        assert.deepStrictEqual([ytl.length, ytl[0].split(' dir=')[0], ytl[299].split(' dir=')[0]], [300, 'ytdec line 100', 'ytdec line 399'], 'ytdec.log: its last 300 lines');
        relay.last = g.body.log;
    });

    await t('send_logs redaction: account values, ids (tagged, one tag per id in a report), titles, URLs, IPs, e-mail, VIN, tokens', async () => {
        const log = relay.last;
        [FAKE.cid, FAKE.sec, FAKE.access, FAKE.refresh, String(FAKE.exp), 'FAKE-ACCESS', 'FAKEREFRESH', 'PendingSecret42', 'DEVICE-CODE-777', 'USR-CDE-XYZ', 'PendingClientId',
            'KnownVid001', 'PosVideo002', 'SeenThumb03', 'UnknownId04', 'UnknownId05', 'UnknownId06', 'UnknownId07', 'UnknownId08', 'PLsecretplaylist123', 'PLseenplaylist0042',
            'UCabcdefghijklmnopqrstuv', 'My Secret Holiday Video', 'Private Channel Name', 'Another Watched Title', 'someone.private', 'example.com', 'WBA12345678901234',
            '81.82.83.84', '81.82.83.85', '8.8.4.4', '2a02:1810', '2a02%3A', 'expire=', 'sig=QQQ', 'videoplayback', 'sig=XYZ', 'abc.def-ghi', 'zzz123456', 'SAPISID=abc', 'YSC=def']
            .forEach((x) => assert.ok(log.indexOf(x) < 0, x + ' left in:\n' + log.split('\n').filter((l) => l.indexOf(x) >= 0).join('\n')));
        Object.keys(FAKE).forEach((key) => assert.ok(log.indexOf(String(FAKE[key])) < 0, 'account.' + key));
        const line = (re) => log.split('\n').find((l) => re.test(l)) || '';
        const k1 = /^fetch (v#[0-9a-f]{4}): ERROR: \[youtube\] (v#[0-9a-f]{4}): Video/.exec(line(/ fetch v#/).slice(25));
        assert.ok(k1 && k1[1] === k1[2], 'a known id: v# + 4 hex, the same each time: ' + line(/ fetch v#/));
        assert.ok(line(/lru removed/).indexOf(',' + k1[1]) > 0 && line(/ytdec line 399/).indexOf(rcache + '/' + k1[1]) > 0, 'the same tag in the LRU line and in ytdec.log');
        assert.ok(/thumb v#[0-9a-f]{4}: timeout/.test(log) && /--dir \S+\/v#[0-9a-f]{4} --rect/.test(log) && /\[youtube\] v#[0-9a-f]{4}: Downloading/.test(log), 'ids by context');
        assert.ok(/list=p#[0-9a-f]{4} and p#[0-9a-f]{4}/.test(log) && /channel c#[0-9a-f]{4}/.test(log), 'playlists p#, channels c#');
        assert.ok(log.indexOf('GET https://rr3---sn-abc.googlevideo.com\n') > 0, 'a URL: scheme and host');
        assert.ok(log.indexOf('with url: /[path] (Caused by timeout)') > 0 && log.indexOf('odd ip=[ip] alone') > 0, 'a bare path with a query, a lone ip=');
        assert.ok(log.indexOf('meta [title] by [title]; [title]') > 0 && log.indexOf('mail [email]') > 0 && log.indexOf('vin [vin]') > 0);
        assert.ok(log.indexOf('uplink [ip] via 192.168.1.1, 10.0.0.2, 172.20.1.1, 127.0.0.1, [ip] and [ip]') > 0, line(/uplink/));
        assert.ok(log.indexOf('Bearer [secret]') > 0 && log.indexOf('access_token=[secret]') > 0 && log.indexOf('Cookie: [secret]') > 0);
        ['internet uid: 30000', 'audio: head -> full at 1234 (waiting)', 'clientVersion 7.20251101.10.00', 'sign-in poll: client_secret=[secret]']
            .forEach((x) => assert.ok(log.indexOf(x) > 0, 'kept: ' + x));
        assert.ok(rlogs.join('\n').indexOf('ABC123') < 0, 'the code is not logged');
        await send();
        const k2 = /fetch (v#[0-9a-f]{4}):/.exec(relay.got.pop().body.log);
        assert.ok(k2 && k2[1] !== k1[1], 'another report, another salt: ' + k2[1]);
    });

    await t('send_logs: closed, busy, too big, a bad answer, no answer, nobody there; one at a time', async () => {
        for (const [mode, msg] of [[410, 'closed'], [429, 'busy'], [413, 'failed'], [500, 'failed'], ['bad', 'failed'], ['hang', 'offline']]) {
            relay.mode = mode;
            assert.deepStrictEqual(await send(), { ev: 'logs_error', msg: msg }, String(mode));
        }
        relay.mode = 200; relay.delay = 300; relay.got.length = 0; revs.length = 0;
        const p1 = dr.sendLogs('0.3.12');
        await dr.sendLogs('0.3.12');                 // while the first is in flight: ignored
        await p1;
        assert.deepStrictEqual([relay.got.length, revs], [1, [{ ev: 'logs_sent', id: 'ABC123' }]]);
        relay.delay = 0;
        assert.strictEqual(relay.got.pop().body.app, '0.3.12');
        revs.length = 0; await dr.sendLogs('1.0; rm -rf');
        assert.strictEqual(relay.got.pop().body.app, 'unknown', 'a bad app version is not sent');
        await new Promise((r) => srv.close(r));
        assert.deepStrictEqual(await send(), { ev: 'logs_error', msg: 'offline' }, 'connection refused');
    });

    await t('send_logs: the log is capped at 200 KB, the newest lines kept; the ring at 1500 lines', async () => {
        for (let i = 0; i < 3000; i++) dr.log('filler ' + i + ' ' + 'x'.repeat(200));
        assert.strictEqual(dr.ring.length, 1500);
        const b = dr.report('0.3.12');
        assert.ok(Buffer.byteLength(b.log) <= 200 * 1024 && Buffer.byteLength(b.log) > 190 * 1024, 'size ' + Buffer.byteLength(b.log));
        assert.ok(/filler 2999 x+$/.test(b.log) && b.log.indexOf('filler 1500 ') < 0, 'the newest kept, the oldest dropped');
    });

    await t('no token, secret or device code in the log', async () => {
        const all = logs.join('\n');
        SECRETS.forEach((s) => assert.ok(all.indexOf(s) < 0, s + ' logged'));
        assert.ok(/sign-in: signed in/.test(all) && /token refreshed/.test(all));
    });

    await t('feedItems: an empty or odd answer is no items', async () => {
        assert.deepStrictEqual(feedItems({}), []);
        assert.deepStrictEqual(feedItems({ a: [null, 1, 'x', { tileRenderer: { contentType: 'TILE_CONTENT_TYPE_VIDEO', contentId: 'bad' } }] }), []);
        const tap = (ep) => ({ commandContext: { onTap: { innertubeCommand: ep } } });
        assert.deepStrictEqual(feedItems({ a: [
            { lockupViewModel: { contentId: 'PLxxxxxxxxxxxxxxxx', rendererContext: tap({ watchEndpoint: { videoId: 'AAAAAAAAAAA' } }) } },
            { lockupViewModel: { contentId: 'UCxxxxxxxxxxxxxxxxxxxxxx', rendererContext: tap({ browseEndpoint: { browseId: 'UCx' } }) } },
            { lockupViewModel: { contentId: 'SSSSSSSSSS1', rendererContext: tap({ reelWatchEndpoint: { videoId: 'SSSSSSSSSS1' } }) } }] }),
            [{ id: 'SSSSSSSSSS1', title: 'SSSSSSSSSS1', channel: '', duration_s: null, meta: [], short: true }], 'playlist, channel dropped; a short kept');
        assert.deepStrictEqual(feedItems({ lockupViewModel: { contentId: 'AAAAAAAAAAA', rendererContext: tap({ watchEndpoint: { videoId: 'AAAAAAAAAAA' } }) } }),
            [{ id: 'AAAAAAAAAAA', title: 'AAAAAAAAAAA', channel: '', duration_s: null, meta: [] }], 'a bare lockup');
    });

    await t('members-only tiles flagged (their badge); Video quality: 360/480/720, auto = 720 on Wi-Fi or unknown, 480 on phone data', async () => {
        const mb = { lineItemRenderer: { badge: { metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_MEMBERS_ONLY', label: 'Members only' } } } };
        const items = feedItems({ a: [tile('MMMMMMMMMM1', 'TILE_CONTENT_TYPE_VIDEO', 'Perk', 'Chan', '9:00', [mb]), tile('MMMMMMMMMM2', 'TILE_CONTENT_TYPE_VIDEO', 'Free', 'Chan', '9:00')] });
        assert.deepStrictEqual(items.map((x) => !!x.members), [true, false]);
        const { qualityHeight } = require('../ytd.js');
        assert.deepStrictEqual([qualityHeight('360'), qualityHeight(480), qualityHeight('720'), qualityHeight('1080', null)], [360, 480, 720, 720]);
        assert.strictEqual(qualityHeight('auto', { interface: 'wlan0' }), 720);
        assert.strictEqual(qualityHeight('auto', { interface: 'usb0' }), 480);
        assert.strictEqual(qualityHeight(undefined, null), 720, 'no uplink known: as before');
    });

    await t('feedShelves: titles, per-channel and mixed groups, shorts shelf kept, per-shelf dedup, meta, caps', async () => {
        const V = 'TILE_CONTENT_TYPE_VIDEO';
        const txt = (x) => ({ lineItemRenderer: { text: { simpleText: x } } });
        const badge = (x) => ({ lineItemRenderer: { badge: { metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_SIMPLE', label: x } } } });
        const shelf = (header, tiles) => ({ shelfRenderer: Object.assign({ content: { horizontalListRenderer: { items: tiles } } }, header) });
        const avatar = (runs) => ({ headerRenderer: { shelfHeaderRenderer: { avatarLockup: { avatarLockupRenderer: { title: { runs: runs.map((x) => ({ text: x })) } } } } } });
        const page = (shelves) => ({ contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: { sectionListRenderer: { contents: shelves } } } } } } });
        const id = (n) => 'fake' + ('0000000' + n).slice(-7);
        const many = [];
        for (let i = 0; i < 13; i++) many.push(tile(id(100 + i), V, 'M' + i, 'Chan M', '1:00'));
        const root = page([
            shelf(avatar(['Consumer Electronics', ' and more']), [
                tile(id(1), V, 'One', 'Chan A', '4:05', [badge('4K'), txt('125K views'), txt('•'), txt('1 day ago')]),
                tile(id(2), V, 'Two', 'Chan B', '10:00', [])]),
            shelf(avatar(['Shorts']), [tile(id(3), 'TILE_CONTENT_TYPE_SHORTS', 'Short', 'Chan C', null)]),
            shelf({ tvhtml5Metadata: { retainShelfIndex: true } }, [
                tile(id(4), V, 'Four', 'Chan D', '2:00'), tile(id(5), V, 'Five', 'Chan D', '3:00'), tile(id(4), V, 'Four', 'Chan D', '2:00')]),
            shelf({ tvhtml5Metadata: { retainShelfIndex: true } }, [tile(id(1), V, 'One', 'Chan A', '4:05'), tile(id(6), V, 'Six', 'Chan E', '1:00')]),
            shelf({ headerRenderer: { shelfHeaderRenderer: { title: { simpleText: 'Plain title' } } } }, many)]);
        const sh = feedShelves(root);
        assert.deepStrictEqual(sh.map((x) => x.title), ['Consumer Electronics and more', 'Shorts', 'Chan D', '', 'Plain title']);
        assert.deepStrictEqual(sh[0].items[0], { id: id(1), title: 'One', channel: 'Chan A', duration_s: 245, meta: ['125K views', '1 day ago'] });
        assert.deepStrictEqual(sh[0].items[1].meta, []);
        assert.deepStrictEqual(sh[1].items.map((x) => [x.id, x.short]), [[id(3), true]], 'the Shorts shelf, its tiles marked');
        assert.deepStrictEqual(sh[2].items.map((x) => x.id), [id(4), id(5)], 'dedup inside a shelf');
        assert.deepStrictEqual(sh[3].items.map((x) => x.id), [id(1), id(6)], 'a video in two shelves stays in both');
        assert.strictEqual(sh[4].items.length, 12);
        const flat = feedItems(root).map((x) => x.id);
        assert.strictEqual(flat.filter((x) => x === id(1)).length, 1, 'flat items deduped across shelves');
        assert.deepStrictEqual(flat.slice(0, 6), [id(1), id(2), id(3), id(4), id(5), id(6)]);
        assert.strictEqual(flat.length, 19);
        const ten = [];
        for (let i = 0; i < 10; i++) ten.push(shelf(avatar(['S' + i]), [tile(id(200 + i), V, 'T', 'C', '1:00')]));
        assert.deepStrictEqual(feedShelves(page(ten)).map((x) => x.title), ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
        // Watch later: a playlist, tiles without shelves
        const wl = { contents: { tvBrowseRenderer: { content: { tvSecondaryNavRenderer: { sections: [{ playlistVideoListRenderer: { contents: [tile(id(7), V, 'Seven', 'Chan F', '5:00')] } }] } } } } };
        assert.deepStrictEqual(feedShelves(wl), []);
        assert.deepStrictEqual(feedItems(wl).map((x) => x.id), [id(7)]);
        assert.deepStrictEqual(feedShelves({}), []);
    });

    await t('thumbs: cached thumb.rgba by its length, else thumbs/<id>.rgba, else the helper (env {}, cwd /), checked, kept, 150 at most', async () => {
        const evs = [], tlog = path.join(tmp, 'thumb.log'), tdir = path.join(cache, 'thumbs');
        const d3 = new Daemon({ someip: someip, srcGen: srcGen, ytdec: fakeYtdec, cacheDir: cache, logDir: tmp, sock: path.join(tmp, 'ctl3.sock'),
            accountFile: path.join(tmp, 'acct3.json'), noSetuid: true, thumbCmd: [process.execPath, path.join(__dirname, 'fake_thumb.js'), tlog],
            ytRequest: fakeYt, log: (m) => logs.push(m) });
        d3.emit = (o) => evs.push(o);
        const sizes = () => evs.map((e) => [e.id, e.w, e.h, Buffer.from(e.rgba, 'base64').length]);
        const put = (vid, n) => { fs.mkdirSync(path.join(cache, vid)); fs.writeFileSync(path.join(cache, vid, 'thumb.rgba'), Buffer.alloc(n, 1)); };
        put('TTTTTTTTTT1', 57600); put('TTTTTTTTTT2', 230400);
        await d3.thumb('TTTTTTTTTT1'); await d3.thumb('TTTTTTTTTT2');
        assert.deepStrictEqual(sizes(), [['TTTTTTTTTT1', 160, 90, 57600], ['TTTTTTTTTT2', 320, 180, 230400]]);
        assert.ok(!fs.existsSync(tlog), 'cached thumbs: no helper');
        fs.mkdirSync(tdir);
        for (let i = 0; i < 150; i++) {
            const f = path.join(tdir, 'X' + i + '.rgba'), tm = new Date(Date.now() - (i + 1) * 60000);
            fs.writeFileSync(f, ''); fs.utimesSync(f, tm, tm);
        }
        evs.length = 0;
        // Earlier playback tests can leave this video's valid cached thumbnail.
        // This case exercises rejection of the helper's malformed output instead.
        try { fs.unlinkSync(path.join(cache, 'SSSSSSSSSS1', 'thumb.rgba')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await Promise.all([d3.thumb('NNNNNNNNNN1'), d3.thumb('ZZZZZZZZZZZ'), d3.thumb('SSSSSSSSSS1')]);
        assert.deepStrictEqual(sizes(), [['NNNNNNNNNN1', 320, 180, 230400]]);
        assert.ok(logs.some((m) => /ZZZZZZZZZZZ: thumb helper exit 1, 0 bytes: no thumbnail/.test(m)));
        assert.ok(logs.some((m) => /SSSSSSSSSS1: thumb helper exit 0, 1000 bytes/.test(m)));
        const hl = fs.readFileSync(tlog, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
        assert.deepStrictEqual(hl.map((x) => x.id).sort(), ['NNNNNNNNNN1', 'SSSSSSSSSS1', 'ZZZZZZZZZZZ']);
        assert.ok(hl.every((x) => x.cwd === '/' && x.env.length < 5), JSON.stringify(hl[0]));
        const tf = path.join(tdir, 'NNNNNNNNNN1.rgba');
        assert.strictEqual(fs.statSync(tf).size, 230400);
        assert.strictEqual(fs.statSync(tf).mode & 0o777, 0o600, "root only: the thumbnails show what was watched");
        assert.strictEqual(fs.readdirSync(tdir).length, 150, 'capped');
        assert.ok(!fs.existsSync(path.join(tdir, 'X149.rgba')), 'the oldest went');
        fs.unlinkSync(tlog); evs.length = 0;
        await d3.thumb('NNNNNNNNNN1');
        assert.deepStrictEqual(sizes(), [['NNNNNNNNNN1', 320, 180, 230400]]);
        assert.ok(!fs.existsSync(tlog), 'from thumbs/: no helper');
        assert.ok(listCache(cache).every((x) => x.id !== 'thumbs'), 'thumbs/ is not a video');
        fs.readdirSync(tdir).forEach((n) => fs.unlinkSync(path.join(tdir, n))); fs.rmdirSync(tdir);
        ['TTTTTTTTTT1', 'TTTTTTTTTT2'].forEach((v) => { fs.unlinkSync(path.join(cache, v, 'thumb.rgba')); fs.rmdirSync(path.join(cache, v)); });
    });

    await t('channels: the FEchannels tiles -> id, name, @handle; videos, playlists and repeats skipped', async () => {
        const { channelTiles } = require('../ytd.js');
        const line = (txt) => ({ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: txt } } }] } });
        const tile = (id, type, title, lines) => ({ tileRenderer: { contentId: id, contentType: type, onSelectCommand: { browseEndpoint: { browseId: id } },
            metadata: { tileMetadataRenderer: { title: { simpleText: title }, lines: lines.map(line) } } } });
        const page = { contents: { shelfRenderer: { content: { horizontalListRenderer: { items: [
            tile('UCdemo000000000000000001', 'TILE_CONTENT_TYPE_CHANNEL', 'Demo Detailing', ['@demo_detailing', '135K subscribers']),
            tile('DemoVideo01', 'TILE_CONTENT_TYPE_VIDEO', 'a video', []),
            tile('UCdemo000000000000000002', 'TILE_CONTENT_TYPE_CHANNEL', 'Seven Demo', ['1M subscribers']),
            tile('UCdemo000000000000000001', 'TILE_CONTENT_TYPE_CHANNEL', 'Demo Detailing', [])] } } } } };
        assert.deepStrictEqual(channelTiles(page), [
            { id: 'UCdemo000000000000000001', title: 'Demo Detailing', handle: '@demo_detailing' },
            { id: 'UCdemo000000000000000002', title: 'Seven Demo', handle: '' }]);
    });

    await t('playlists: the TV Playlists page tiles -> id, name, count, meta, the picture\'s video; Watch later, videos and repeats skipped', async () => {
        const { playlistTiles, playlistTitle, addToPlaylistItems } = require('../ytd.js');
        // as FEplaylist_aggregation answers (TVHTML5, 2026-11): a gridRenderer of tiles, the count on the thumbnail's
        // overlay ("No videos", "1 video", "12 videos"), one lineRenderer a text, no_thumbnail.jpg when empty
        const line = (...txt) => ({ lineRenderer: { items: txt.map((x) => ({ lineItemRenderer: { text: { simpleText: x } } })) } });
        const tile = (id, type, title, lines, count, pic, o) => ({ tileRenderer: Object.assign({ style: 'TILE_STYLE_YTLR_DEFAULT', contentId: id, contentType: type,
            onSelectCommand: { browseEndpoint: { browseId: 'VL' + id } },
            header: { tileHeaderRenderer: { thumbnail: { thumbnails: [{ url: pic ? 'https://i.ytimg.com/vi/' + pic + '/hqdefault.jpg' : 'https://i.ytimg.com/img/no_thumbnail.jpg', width: 480, height: 360 }] },
                thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { text: { runs: [{ text: count }] }, style: 'DEFAULT', icon: { iconType: 'PLAYLISTS' } } },
                    { thumbnailOverlayStackingEffectRenderer: {} }] } },
            metadata: { tileMetadataRenderer: { title: { simpleText: title }, lines: lines } } }, o || {}) });
        const page = { contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: { gridRenderer: { items: [
            tile('WL', 'TILE_CONTENT_TYPE_PLAYLIST', 'Watch later', [line('Private'), line('Updated today')], 'No videos'),
            tile('PLdemo00000000000000000000000001', 'TILE_CONTENT_TYPE_PLAYLIST', 'Road trip', [line('Private'), line('Updated today')], '12 videos', 'DemoVideo01'),
            tile('DemoVideo01', 'TILE_CONTENT_TYPE_VIDEO', 'a video', [], '1:00'),
            tile('LL', 'TILE_CONTENT_TYPE_PLAYLIST', 'Liked videos', [line('Private')], 'No videos'),
            tile('PLdemo00000000000000000000000003', 'TILE_CONTENT_TYPE_PLAYLIST', 'One', [line('Public', '•', 'Updated 3 days ago')], '1 video', null,
                { onSelectCommand: { watchEndpoint: { videoId: 'DemoVideo04', playlistId: 'PLdemo00000000000000000000000003' } } }),
            tile('PLdemo00000000000000000000000001', 'TILE_CONTENT_TYPE_PLAYLIST', 'Road trip', [], '12 videos')] } } } } } },
            // lockups (the web's newer format; not seen from TVHTML5 yet): the playlist id in the tap command, the count on a badge
            more: { lockupViewModel: { contentId: 'PLdemo00000000000000000000000002', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST',
                contentImage: { collectionThumbnailViewModel: { primaryThumbnail: { thumbnailViewModel: {
                    image: { sources: [{ url: 'https://i.ytimg.com/vi/DemoVideo03/hqdefault.jpg' }] },
                    overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: '1,204 videos' } }] } }] } } } },
                metadata: { lockupMetadataViewModel: { title: { content: 'Everything' } } },
                rendererContext: { commandContext: { onTap: { innertubeCommand: { browseEndpoint: { browseId: 'VLPLdemo00000000000000000000000002' } } } } } } } };
        assert.deepStrictEqual(playlistTiles(page), [
            { id: 'PLdemo00000000000000000000000001', title: 'Road trip', count: 12, meta: ['Private', 'Updated today'], thumb: 'DemoVideo01' },
            { id: 'LL', title: 'Liked videos', count: 0, meta: ['Private'], thumb: null },
            { id: 'PLdemo00000000000000000000000003', title: 'One', count: 1, meta: ['Public', 'Updated 3 days ago'], thumb: 'DemoVideo04' },
            { id: 'PLdemo00000000000000000000000002', title: 'Everything', count: 1204, meta: [], thumb: 'DemoVideo03' }]);
        assert.deepStrictEqual(playlistTiles({ tileRenderer: { contentType: 'TILE_CONTENT_TYPE_PLAYLIST' } }), [], 'no id: skipped');
        // a playlist's page (VL + id): its name in the TV header, else the web's
        const entity = { contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: { twoColumnRenderer: {
            leftColumn: { entityMetadataRenderer: { title: { simpleText: 'Liked videos' }, bylines: [line('Private', '•', 'No videos')] } },
            rightColumn: { genericPromoRenderer: { bodyText: { simpleText: 'No videos in this playlist yet' } } } } } } } } } };
        assert.strictEqual(playlistTitle(entity), 'Liked videos');
        assert.strictEqual(playlistTitle({ header: { playlistHeaderRenderer: { title: { runs: [{ text: 'Road ' }, { text: 'trip' }] } } } }), 'Road trip');
        assert.strictEqual(playlistTitle({}), '');
        // the Save to playlist list (the fallback): ids, names, privacy; Watch later skipped
        const opt = (id, title, privacy, pic) => ({ playlistAddToOptionRenderer: { playlistId: id, title: { simpleText: title }, privacy: privacy, containsSelectedVideos: 'NONE',
            thumbnailRenderer: pic ? { playlistVideoThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/' + pic + '/default.jpg' }] } } } : {} } });
        assert.deepStrictEqual(addToPlaylistItems({ contents: [{ addToPlaylistRenderer: { playlists: [opt('WL', 'Watch later', 'PRIVATE'),
            opt('PLdemo00000000000000000000000001', 'Road trip', 'UNLISTED', 'DemoVideo01'), opt('bad id', 'Bad', 'PUBLIC')] } }] }), [
            { id: 'PLdemo00000000000000000000000001', title: 'Road trip', count: null, meta: ['Unlisted'], thumb: 'DemoVideo01' }]);
    });

    await t('playlists: the TV page; the Save to playlist list when the page refuses or lists none; its error only when both fail', async () => {
        const { Account } = require('../ytd.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), file = path.join(dir, 'account.json');
        fs.writeFileSync(file, JSON.stringify({ cid: 'c', sec: 's', access: 'tok', refresh: 'r', exp: Date.now() + 3600000 }));
        const tvTile = { tileRenderer: { contentId: 'PLtv', contentType: 'TILE_CONTENT_TYPE_PLAYLIST', onSelectCommand: { browseEndpoint: { browseId: 'VLPLtv' } },
            metadata: { tileMetadataRenderer: { title: { simpleText: 'From the page' } } } } };
        const saveList = { contents: [{ addToPlaylistRenderer: { playlists: [{ playlistAddToOptionRenderer: { playlistId: 'PLsave', title: { simpleText: 'From the list' }, privacy: 'PRIVATE' } }] } }] };
        const run = async (page, list) => {
            const asked = [], evs = [], logs2 = [];
            const yt = (method, url) => {
                asked.push(/browse/.test(url) ? 'page' : 'list');
                const a = /browse/.test(url) ? page : list;
                return Promise.resolve({ status: a[0], body: JSON.stringify(a[1]) });
            };
            await new Account({ accountFile: file, ytRequest: yt, ytTimeoutMs: 1000, log: (m) => logs2.push(m) }, (e) => evs.push(e)).playlists();
            return { asked, ev: evs[0], logs: logs2 };
        };
        let x = await run([200, { contents: tvTile }], [200, saveList]);
        assert.deepStrictEqual([x.asked, x.ev.items.map((p) => p.title)], [['page'], ['From the page']], 'the page lists some: the list not asked');
        x = await run([404, {}], [200, saveList]);
        assert.deepStrictEqual([x.asked, x.ev.items.map((p) => p.title)], [['page', 'list'], ['From the list']], 'the page refuses: the list');
        x = await run([200, { contents: { somethingNew: {} } }], [200, saveList]);
        assert.deepStrictEqual([x.asked, x.ev.items.map((p) => p.title)], [['page', 'list'], ['From the list']], 'the page answers, nothing we read: the list');
        x = await run([200, { contents: {} }], [500, {}]);
        assert.deepStrictEqual([x.ev.items, x.ev.error], [[], undefined], 'the page empty, the list failing: the page\'s empty answer');
        assert.ok(x.logs.some((m) => /none on the page, save list 500/.test(m)), 'logged');
        x = await run([404, {}], [500, {}]);
        assert.deepStrictEqual([x.ev.items, x.ev.error], [undefined, 'feed offline'], 'both fail: offline');
    });

    await t('setTime is never 0 (the car\'s player ignores it): the start is asked as 1 ms', async () => {
        const { Audio } = require('../ytd.js');
        const got = [];
        const a = new Audio({ log: () => {} }, {});
        a.mp = { callMethod: async (m, x) => { got.push([m, x.newTimeElapsed]); return { EntError: 'OK' }; } };
        await a.seek(0); await a.seek(0.4); await a.seek(25000);
        assert.deepStrictEqual(got, [['setTime', 1], ['setTime', 1], ['setTime', 25000]]);
    });

    await t('LRU keeps 6 newest, never the playing one', async () => {
        const lru = path.join(tmp, 'lru');
        fs.mkdirSync(lru);
        const ids = [];
        for (let i = 0; i < 9; i++) {
            const id = 'L' + String(i).repeat(10);
            const dd = path.join(lru, id);
            fs.mkdirSync(dd);
            const tm = new Date(Date.now() - (i + 1) * 60000); // L0 newest ... L8 oldest
            fs.utimesSync(dd, tm, tm);
            ids.push(id);
        }
        const removed = pruneCache(lru, 6, [ids[8]], () => {});
        assert.deepStrictEqual(removed.sort(), [ids[6], ids[7]].sort());
        assert.deepStrictEqual(listCache(lru).map((x) => x.id).sort(), ids.slice(0, 6).concat([ids[8]]).sort());
    });

    await t('fetch helper resolves through the uplink lease, else the system resolver', async () => {
        const { uplinkLookup } = require('../ytd.js');
        const lease = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lease-')), 'lease.json');
        assert.strictEqual(uplinkLookup(lease), undefined, 'no lease: system resolver');
        fs.writeFileSync(lease, JSON.stringify({ dns: [] }));
        assert.strictEqual(uplinkLookup(lease), undefined, 'no servers: system resolver');
        fs.writeFileSync(lease, JSON.stringify({ dns: ['192.0.2.53'] }));
        assert.strictEqual(typeof uplinkLookup(lease), 'function');
    });

    await t('a played video is deleted once stopped (nothing is kept for offline)', async () => {
        c.send({ cmd: 'stop' }); await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        d.opts.keep = 0;
        fs.writeFileSync(ctl, 'done');
        c.clear();
        c.send({ cmd: 'play', id: 'UUUUUUUUUU1', rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing', 5000);
        assert.ok(fs.existsSync(path.join(cache, 'UUUUUUUUUU1')), 'kept while it plays');
        c.send({ cmd: 'stop' }); await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        assert.ok(!fs.existsSync(path.join(cache, 'UUUUUUUUUU1')), 'gone');
        assert.deepStrictEqual(fs.readdirSync(cache).filter((n) => /^[\w-]{11}$/.test(n)), [], 'no other video left either');
        d.opts.keep = 20;
    });

    await t('history: signed in, /player then a playback ping, watchtime at pause and a final one when it ended', async () => {
        const saved = d.account, id = 'HHHHHHHHHH1';
        mkVideo(id);
        d.account = Object.assign(Object.create(Object.getPrototypeOf(saved)), saved, { status: () => ({ state: 'signed_in' }), token: async () => 'TOK' });
        yt.calls.length = 0;
        await playing(id);
        await waitUntil(() => yt.calls.some((x) => /stats\/playback/.test(x.url)));
        const pl = yt.calls.find((x) => /v1\/player/.test(x.url));
        assert.strictEqual(pl.headers.Authorization, 'Bearer TOK'); assert.strictEqual(pl.body.videoId, id);
        const pb = yt.calls.find((x) => /stats\/playback/.test(x.url));
        assert.ok(/^https:\/\/s\.youtube\.com\/api\/stats\/playback\?docid=x&ei=E&ns=yt&ver=2&cpn=[\w-]{16}&len=60&cmt=0\.0$/.test(pb.url), pb.url);
        assert.strictEqual(pb.headers.Authorization, 'Bearer TOK');
        tick(30000);
        c.send({ cmd: 'pause' });
        await waitUntil(() => yt.calls.some((x) => /stats\/watchtime/.test(x.url)));
        assert.ok(/&st=0&et=30\.0$/.test(yt.calls.find((x) => /watchtime/.test(x.url)).url));
        c.send({ cmd: 'resume' });
        await sleep(100);
        tick(59000);
        d.stop('ended');
        await waitUntil(() => yt.calls.some((x) => /watchtime.*final=1/.test(x.url)));
        assert.ok(/st=60&et=60&final=1$/.test(yt.calls.filter((x) => /watchtime/.test(x.url)).pop().url));
        await c.waitFor((x) => x.ev === 'state' && x.state === 'ended');
        d.account = saved;
        fs.rmSync(path.join(cache, id), { recursive: true, force: true });
    });

    await t('feed tiles carry the account\'s watched share and resume point', async () => {
        const j = { contents: [{ tileRenderer: { contentType: 'TILE_CONTENT_TYPE_VIDEO', contentId: 'AUTOAUTO003',
            metadata: { tileMetadataRenderer: { title: { simpleText: 'A' } } },
            header: { tileHeaderRenderer: { thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '5:00' } } },
                { thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: 40 } }] } },
            onSelectCommand: { watchEndpoint: { videoId: 'AUTOAUTO003', startTimeSeconds: 120 } } } }] };
        assert.strictEqual(feedItems(j)[0].watched_pct, 40); assert.strictEqual(feedItems(j)[0].start_s, 120);
    });

    // ======== WP0 foundations: the protocol table, hello, the stub commands
    await t('the README protocol table lists exactly the onLine commands, and every event ytd.js sends', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'ytd.js'), 'utf8');
        const body = src.slice(src.indexOf('Daemon.prototype.onLine = '), src.indexOf('\n};', src.indexOf('Daemon.prototype.onLine = ')));
        const cases = (body.match(/case '[a-z_]+'/g) || []).map((x) => x.slice(6, -1)).sort();
        const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
        const table = readme.slice(readme.indexOf('App → daemon'), readme.indexOf('Daemon → app:'));
        const rows = table.split('\n').filter((l) => /^\| `\{"cmd"/.test(l)).map((l) => l.split(' | ')[0]);
        const documented = [].concat(...rows.map((l) => (l.match(/"cmd":"[a-z_]+"/g) || []).map((x) => x.slice(7, -1)))).sort();
        assert.ok(cases.length >= 28, 'the switch was found: ' + cases.length);
        assert.deepStrictEqual(documented, cases, 'README rows vs onLine cases');
        const sent = Array.from(new Set((src.match(/ev: '[a-z_]+'/g) || []).map((x) => x.slice(5, -1))));
        const told = readme.slice(readme.indexOf('Daemon → app:'));
        assert.deepStrictEqual(sent.filter((e) => told.indexOf('"ev":"' + e + '"') < 0), [], 'events sent but not in the README');
    });

    await t('hello: service version and caps; lang / region kept for the connection; a bad one dropped, never refused', async () => {
        const FROZEN = ['health', 'related', 'hist', 'playlists', 'ytdlp', 'remote', 'proxy', 'stream'];
        assert.deepStrictEqual(CAPS, ['related', 'hist', 'health', 'playlists'], 'what of the 0.4.0 protocol answers for real (WP1: related, hist; WP4: health)');
        assert.ok(CAPS.every((x) => FROZEN.indexOf(x) >= 0), 'caps only from the frozen names');
        c.clear();
        c.send({ cmd: 'hello', app: '0.4.0', lang: 'ru', region: 'RU' });
        assert.deepStrictEqual(await c.waitFor((x) => x.ev === 'hello'), { ev: 'hello', service: VERSION, caps: CAPS });
        assert.deepStrictEqual([d.hl, d.gl], ['ru', 'RU']);
        for (const [lang, region, want] of [['RU', 'ru', [null, null]], ['rus', 'R1', [null, null]], [7, ['RU'], [null, null]],
            ['de', undefined, ['de', null]], [undefined, 'DE', [null, 'DE']], ['e\n', 'GB\n', [null, null]]]) {
            c.clear(); logs.length = 0;
            c.send({ cmd: 'hello', app: '0.4.0', lang: lang, region: region });
            const e = await c.waitFor((x) => x.ev === 'hello');
            assert.deepStrictEqual([e.service, e.caps, d.hl, d.gl], [VERSION, CAPS].concat(want), JSON.stringify([lang, region]));
            const l = logs.find((x) => /^hello: /.test(x));
            assert.strictEqual(/bad lang/.test(l), lang !== undefined && want[0] === null, l);
            assert.strictEqual(/bad region/.test(l), region !== undefined && want[1] === null, l);
        }
        c.send({ cmd: 'hello', app: '<x>', lang: 'fr', region: 'FR' });
        await waitUntil(() => d.hl === 'fr');
        assert.ok(logs.some((x) => x === 'hello: app unknown, lang fr, region FR'), 'an odd app version is not logged as sent');
        const c2 = await client(d.opts.sock);
        await waitUntil(() => d.client && d.hl === null && d.gl === null);
        c = c2;
        c.send({ cmd: 'status' });
        await c.waitFor((x) => x.ev === 'state');
        assert.deepStrictEqual([d.hl, d.gl], [null, null], 'a new connection starts with none');
    });

    await t('a wrong clock: before BUILT only; hello says it, the fetcher keeps certificate checks, `clock` when it changes', async () => {
        const day = 86400000, built = Date.parse(BUILT);
        assert.ok(/^\d{4}-\d\d-\d\d$/.test(BUILT) && built <= Date.now(), 'BUILT is a date, never in the future: ' + BUILT);
        assert.deepStrictEqual([clockBehind(built - 36 * day), clockBehind(built - 1), clockBehind(built), clockBehind(built + 400 * day)],
            [new Date(built - 36 * day).toISOString().slice(0, 10), new Date(built - 1).toISOString().slice(0, 10), null, null],
            'behind BUILT: the date; at or after it (a clock ahead too): nothing');
        const wrong = Date.parse('2026-10-13T08:00:00Z');
        assert.ok(wrong < built);
        const job = (id) => { d.spawnJob(['extract', '--cache-dir', cache, '--', id, path.join(tmp, id + '.json')]); };
        const jobArgv = async (id) => { await waitUntil(() => fs.existsSync(ctl + '.extract') && JSON.parse(fs.readFileSync(ctl + '.extract', 'utf8')).argv.indexOf(id) >= 0); return JSON.parse(fs.readFileSync(ctl + '.extract', 'utf8')).argv; };
        job('ClockRight1');
        assert.deepStrictEqual(await jobArgv('ClockRight1'), ['extract', '--cache-dir', cache, '--', 'ClockRight1', path.join(tmp, 'ClockRight1.json')], 'the clock right: no flag');
        d.opts.now = () => wrong;
        c.clear(); logs.length = 0;
        c.send({ cmd: 'hello', app: '0.4.0' });
        assert.deepStrictEqual(await c.waitFor((x) => x.ev === 'hello'), { ev: 'hello', service: VERSION, caps: CAPS, clock: '2026-10-13' });
        assert.ok(logs.indexOf('clock wrong (2026-10-13): verify the head unit date and time') >= 0, logs.join('|'));
        job('ClockWrong1');
        assert.deepStrictEqual(await jobArgv('ClockWrong1'), ['extract', '--cache-dir', cache, '--', 'ClockWrong1', path.join(tmp, 'ClockWrong1.json')], 'date checks remain enabled');
        assert.ok(!c.evs.some((x) => x.ev === 'clock'), 'the same date: no clock event');
        d.opts.now = () => wrong + day;
        d.clockDate();
        assert.deepStrictEqual(await c.waitFor((x) => x.ev === 'clock'), { ev: 'clock', clock: '2026-10-14' }, 'the date shown moves on');
        c.clear();
        d.opts.now = null;               // the driver set the clock
        job('ClockRight2');
        assert.ok((await jobArgv('ClockRight2')).indexOf('--no-cert-time') < 0, 'set right: no flag at the next spawn');
        assert.deepStrictEqual(await c.waitFor((x) => x.ev === 'clock'), { ev: 'clock', clock: null });
        c.send({ cmd: 'hello', app: '0.4.0' });
        assert.deepStrictEqual(await c.waitFor((x) => x.ev === 'hello'), { ev: 'hello', service: VERSION, caps: CAPS }, 'no clock key when it is right');
    });

    await t('a wrong clock: the daemon keeps using its verified HTTPS helper', async () => {
        const fl = path.join(tmp, 'clockfetch.log');
        const dq = new Daemon({ cacheDir: cache, noSetuid: true, accountFile: path.join(tmp, 'acct-clock.json'), leaseFile: path.join(tmp, 'lease-clock.json'),
            fetchCmd: [process.execPath, path.join(__dirname, 'fake_fetch.js'), fl + '.node', 'ok'],
            fetcher: [process.execPath, path.join(__dirname, 'fake_fetch.js'), fl, 'ok'], log: () => {} });
        dq.fetchUid = process.getuid();
        fs.writeFileSync(dq.opts.leaseFile, JSON.stringify({ dns: ['127.0.0.1'] }));
        const rq = { method: 'POST', url: 'https://www.youtube.com/youtubei/v1/search', headers: { Authorization: 'Bearer X' }, body: { q: 1 }, timeoutMs: 2000 };
        assert.deepStrictEqual(await dq.opts.ytRequest(rq.method, rq.url, rq.headers, rq.body, rq.timeoutMs), { status: 200, body: 'hello' });
        assert.ok(fs.existsSync(fl + '.node') && !fs.existsSync(fl), 'the clock right: ytd.js --fetch, as before');
        dq.opts.now = () => Date.parse('2026-10-13T08:00:00Z');
        assert.deepStrictEqual(await dq.opts.ytRequest(rq.method, rq.url, rq.headers, rq.body, rq.timeoutMs), { status: 200, body: 'hello' });
        assert.ok(!fs.existsSync(fl), 'no hello yet (no app could warn): dates still checked');
        dq.clockSaid = '2026-10-13';   // the app's hello was told
        await dq.opts.ytRequest('POST', 'https://www.youtube.com/o/oauth2/token', {}, { refresh_token: 'R' }, 2000);
        assert.ok(!fs.existsSync(fl), 'sign-in requests never skip the dates');
        assert.deepStrictEqual(await dq.opts.ytRequest(rq.method, rq.url, rq.headers, rq.body, rq.timeoutMs), { status: 200, body: 'hello' });
        assert.ok(!fs.existsSync(fl), 'innerTube requests still use verified HTTPS');
    });

    await t('the frozen commands not built yet answer "not implemented <cmd>"; an unknown one as before', async () => {
        for (const m of [{ cmd: 'ytdlp', auto: true }, { cmd: 'remote', on: true }, { cmd: 'proxy', mode: 'off' }]) {
            c.clear();
            c.send(m);
            assert.deepStrictEqual(await c.waitFor((x) => x.ev === 'error'), { ev: 'error', cmd: m.cmd, msg: 'not implemented ' + m.cmd });
        }
        c.clear();
        c.send({ cmd: 'bogus' });
        assert.deepStrictEqual(await c.waitFor((x) => x.ev === 'error'), { ev: 'error', msg: 'unknown cmd bogus' });
    });

    // ---- WP1 feeds ----
    // Real TVHTML5 answers (anonymous, from the Mac, 2026-11-19), trimmed to a few entries, session and tracking
    // fields removed: /next for aqz-KE-bpKQ, and a search for "cat shorts" (LOCKUP_CONTENT_TYPE_SHORT lockups).
    // History and Liked videos need an account: their answers below are built like the other browse fixtures.
    const NEXT = JSON.parse(fs.readFileSync(path.join(__dirname, 'next_tvhtml5.json'), 'utf8'));
    const SHORTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'search_shorts_tvhtml5.json'), 'utf8'));
    const NEXT_IDS = ['vE57fPUAQh0', 'rdGTgpVj0Cg', 'sAtlN4OMA1I', 'X2UoFpxy4qo'];
    const signIn = () => fs.writeFileSync(acct, JSON.stringify({ cid: 'x', sec: 'y', access: 'ACCESS-1', refresh: 'REFRESH-1', exp: Date.now() + 1e7 }), { mode: 0o600 });
    const signOut = () => { try { fs.unlinkSync(acct); } catch (e) { /* none */ } };
    const V = 'TILE_CONTENT_TYPE_VIDEO';
    const resumed = (tl, pct) => { tl.tileRenderer.header.tileHeaderRenderer.thumbnailOverlays.push({ thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: pct } }); return tl; };
    const browsePage = (shelves) => ({ contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content: { sectionListRenderer: { contents: shelves } } } } } } });
    const HIST = browsePage([{ shelfRenderer: { headerRenderer: { shelfHeaderRenderer: { title: { simpleText: 'Today' } } }, content: { horizontalListRenderer: { items: [
        resumed(tile('HHHHHHHHHH1', V, 'Watched half', 'Chan H', '10:00'), 50), tile('HHHHHHHHHH2', 'TILE_CONTENT_TYPE_SHORTS', 'A short seen', 'Chan S', null)] } } } }]);
    const LIKED = { contents: { tvBrowseRenderer: { content: { tvSecondaryNavRenderer: { sections: [{ playlistVideoListRenderer: { contents: [
        tile('LLLLLLLLLL1', V, 'Liked one', 'Chan L', '3:00'), tile('LLLLLLLLLL2', V, 'Liked two', 'Chan L', '4:00')] } }] } } } } };

    await t('feed hist / liked: FEhistory and VLLL browsed with the token, tiles parsed (watched share, a short); signed out: "signed out", nothing asked', async () => {
        signIn();
        c.clear(); yt.calls.length = 0;
        yt.browse = (h, b) => ok(b.browseId === 'FEhistory' ? HIST : b.browseId === 'VLLL' ? LIKED : {});
        c.send({ cmd: 'feed', which: 'hist' });
        const h = await c.waitFor((x) => x.ev === 'feed' && x.which === 'hist');
        const h1 = { id: 'HHHHHHHHHH1', title: 'Watched half', channel: 'Chan H', duration_s: 600, meta: ['1K views'], watched_pct: 50 };
        const h2 = { id: 'HHHHHHHHHH2', title: 'A short seen', channel: 'Chan S', duration_s: null, meta: ['1K views'], short: true };
        assert.deepStrictEqual(h, { ev: 'feed', which: 'hist', items: [h1, h2], shelves: [{ title: 'Today', items: [h1, h2] }] });
        c.send({ cmd: 'feed', which: 'liked' });
        const l = await c.waitFor((x) => x.ev === 'feed' && x.which === 'liked');
        assert.deepStrictEqual([l.items.map((x) => x.id), l.shelves], [['LLLLLLLLLL1', 'LLLLLLLLLL2'], []], 'a playlist: no shelves');
        assert.deepStrictEqual(ytCalls('/browse').map((x) => [x.body.browseId, x.headers.Authorization]), [['FEhistory', 'Bearer ACCESS-1'], ['VLLL', 'Bearer ACCESS-1']]);
        signOut();
        c.clear(); yt.calls.length = 0;
        for (const which of ['hist', 'liked']) {
            c.send({ cmd: 'feed', which: which });
            assert.deepStrictEqual(await c.waitFor((x) => x.ev === 'feed' && x.which === which), { ev: 'feed', which: which, error: 'signed out' });
        }
        assert.strictEqual(ytCalls('/browse').length, 0, 'nothing asked without an account');
    });

    await t('related: the watch-next tiles (real TVHTML5 /next), the video itself left out; anonymous signed out; kept 10 min per video and language; offline; bad id', async () => {
        signOut();
        const id = 'aqz-KE-bpKQ';
        c.clear(); yt.calls.length = 0; d.relatedKept = {};
        yt.next = (h, b) => ok({ a: NEXT, b: tile(b.videoId, V, 'Itself', 'Blender', '10:34') });
        c.send({ cmd: 'related', id: id });
        const e = await c.waitFor((x) => x.ev === 'related');
        assert.deepStrictEqual(e.items.map((x) => x.id), NEXT_IDS, JSON.stringify(e));
        assert.deepStrictEqual(e.items[0], { id: 'vE57fPUAQh0', title: 'The Good Dinosaur -  Best Scenes', channel: 'Hinl', duration_s: 1437, meta: ['17M views', '9 years ago'] });
        assert.deepStrictEqual(Object.keys(e), ['ev', 'id', 'items']);
        const r0 = ytCalls('/youtubei/v1/next')[0];
        assert.strictEqual(r0.headers, null, 'anonymous');
        assert.deepStrictEqual(r0.body, { context: { client: { clientName: 'TVHTML5', clientVersion: '7.20261103.19.00', hl: 'en' } }, videoId: id });
        c.clear();
        c.send({ cmd: 'related', id: id });
        assert.deepStrictEqual(await c.waitFor((x) => x.ev === 'related'), e, 'kept');
        assert.strictEqual(ytCalls('/youtubei/v1/next').length, 1, 'within 10 min: not asked again');
        Object.keys(d.relatedKept).forEach((k) => { d.relatedKept[k].t -= 600001; });
        c.clear();
        c.send({ cmd: 'related', id: id });
        await c.waitFor((x) => x.ev === 'related');
        assert.strictEqual(ytCalls('/youtubei/v1/next').length, 2, 'after 10 min: asked again');
        c.send({ cmd: 'hello', app: '0.4.0', lang: 'de', region: 'DE' });
        await c.waitFor((x) => x.ev === 'hello');
        c.clear();
        c.send({ cmd: 'related', id: id });
        await c.waitFor((x) => x.ev === 'related');
        assert.strictEqual(ytCalls('/youtubei/v1/next').length, 3, 'another language: asked again');
        assert.deepStrictEqual(ytCalls('/youtubei/v1/next')[2].body.context.client, { clientName: 'TVHTML5', clientVersion: '7.20261103.19.00', hl: 'de', gl: 'DE' });
        c.send({ cmd: 'hello', app: '0.4.0' });
        await waitUntil(() => d.hl === null);
        signIn();
        c.clear(); yt.calls.length = 0;
        yt.next = (h, b) => (h ? { status: 401, body: '{}' } : ok(NEXT));
        c.send({ cmd: 'related', id: 'XXXXXXXXXX1' });
        assert.deepStrictEqual((await c.waitFor((x) => x.ev === 'related')).items.map((x) => x.id), NEXT_IDS);
        assert.deepStrictEqual(ytCalls('/youtubei/v1/next').map((x) => x.headers && x.headers.Authorization), ['Bearer ACCESS-1', null], 'signed in, then anonymous on a 401');
        c.send({ cmd: 'sign_out' });
        await c.waitFor(authEv('signed_out'));
        c.clear();
        c.send({ cmd: 'related', id: 'XXXXXXXXXX1' });
        await c.waitFor((x) => x.ev === 'related');
        assert.strictEqual(ytCalls('/youtubei/v1/next').length, 3, 'sign_out drops what the account was shown');
        c.clear(); logs.length = 0;
        yt.next = () => Promise.reject(new Error('ENETUNREACH'));
        c.send({ cmd: 'related', id: 'XXXXXXXXXX2' });
        assert.deepStrictEqual(await c.waitFor((x) => x.ev === 'related'), { ev: 'related', id: 'XXXXXXXXXX2', error: 'related offline' });
        assert.ok(logs.some((m) => m === 'related: ENETUNREACH'), logs.join('|'));
        yt.next = () => ({ status: 500, body: 'x' });
        c.clear();
        c.send({ cmd: 'related', id: 'XXXXXXXXXX2' });
        assert.deepStrictEqual(await c.waitFor((x) => x.ev === 'related'), { ev: 'related', id: 'XXXXXXXXXX2', error: 'related offline' }, 'an error answer is not kept');
        c.clear();
        c.send({ cmd: 'related', id: '../etc' });
        assert.deepStrictEqual(await c.waitFor((x) => x.ev === 'related'), { ev: 'related', id: '../etc', error: 'bad id' });
        yt.next = null;
    });

    await t('Shorts: a real TVHTML5 search of shorts (LOCKUP_CONTENT_TYPE_SHORT) and Shorts tiles come with short:true, plain videos without', async () => {
        const items = feedItems(SHORTS);
        assert.deepStrictEqual(items.map((x) => [x.id, x.short, x.duration_s]), [['odPXcj2id8k', true, null], ['TsIvLpSJQbk', true, null], ['SgbNfUpnLj0', true, null], ['6W2q6g-qs4w', true, null]]);
        assert.deepStrictEqual(items[0].meta, ['274M views', '1 year ago']);
        assert.ok(feedItems(SEARCH).concat(feedItems(NEXT)).every((x) => !('short' in x)), 'no flag on plain videos');
        signOut();
        c.clear();
        yt.search = () => ok(SHORTS);
        c.send({ cmd: 'search', q: 'cat shorts' });
        assert.deepStrictEqual((await c.waitFor((x) => x.ev === 'results')).items, items);
        yt.search = () => ok(SEARCH);
    });

    await t('live: a live or upcoming tile / lockup (a real one, its overlay made live) has live:true and no length; plain videos none', async () => {
        const json = (o) => JSON.parse(JSON.stringify(o));
        const findAll = (o, k, out) => { if (o && typeof o === 'object') { if (o[k]) out.push(o[k]); Object.keys(o).forEach((x) => findAll(o[x], k, out)); } return out; };
        const lk = json(findAll(SEARCH, 'lockupViewModel', [])[0]), tl = json(findAll(NEXT, 'tileRenderer', []).filter((x) => x.contentType === 'TILE_CONTENT_TYPE_VIDEO')[0]);
        const lkBadge = lk.contentImage.thumbnailViewModel.overlays[0].thumbnailBottomOverlayViewModel.badges[0].thumbnailBadgeViewModel;
        const tlOv = tl.header.tileHeaderRenderer.thumbnailOverlays.filter((x) => x.thumbnailOverlayTimeStatusRenderer)[0].thumbnailOverlayTimeStatusRenderer;
        const plain = feedItems({ a: [{ lockupViewModel: lk }, { tileRenderer: tl }] });
        assert.ok(plain.length === 2 && plain.every((x) => !('live' in x) && x.duration_s > 0), 'as captured: not live');
        assert.ok(feedItems(SEARCH).concat(feedItems(NEXT), feedItems(SHORTS)).every((x) => !('live' in x)), 'no flag on the captured videos');
        Object.assign(lkBadge, { text: 'LIVE', badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE' });
        Object.assign(tlOv, { text: { runs: [{ text: 'EN DIRECT' }] }, style: 'LIVE' });       // (style, whatever the language)
        const up = json(tl); up.contentId = 'UPCOMING001';
        up.header.tileHeaderRenderer.thumbnailOverlays.filter((x) => x.thumbnailOverlayTimeStatusRenderer)[0].thumbnailOverlayTimeStatusRenderer = { text: { simpleText: 'UPCOMING' }, style: 'UPCOMING' };
        const now = json(tl); now.contentId = 'LIVENOW0001';
        now.header.tileHeaderRenderer.thumbnailOverlays = [];
        now.metadata.tileMetadataRenderer.lines[1].lineRenderer.items.unshift({ lineItemRenderer: { badge: { metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW', label: 'LIVE' } } } });
        const items = feedItems({ a: [{ lockupViewModel: lk }, { tileRenderer: tl }, { tileRenderer: up }, { tileRenderer: now }] });
        assert.deepStrictEqual(items.map((x) => [x.live, x.duration_s]), [[true, null], [true, null], [true, null], [true, null]]);
        assert.deepStrictEqual([items[0].id, items[0].title, items[0].channel], [plain[0].id, plain[0].title, plain[0].channel], 'the rest as before');
        const named = json(findAll(SEARCH, 'lockupViewModel', [])[0]); named.metadata.lockupMetadataViewModel.title.content = 'LIVE';
        assert.ok(!('live' in feedItems({ a: [{ lockupViewModel: named }] })[0]), 'a title "LIVE" is not a live stream');
    });

    await t('100 videos per list; the worst-case feed line (100 items + 8 shelves of 12) stays under the app\'s 1 MiB MAX_LINE', async () => {
        const MAX_LINE = 1 << 20;   // apps/jap_ridetube/yt.js
        // the longest text JSON can make: 100 control characters, each written as \u00XX (6 bytes)
        const big = new Array(101).join('\u0001'), part = { lineItemRenderer: { text: { simpleText: big } } };
        const id = (n) => 'W' + ('000000000' + n).slice(-10);
        const fat = (n) => resumed(tile(id(n), V, big, big, '10:00:00', [part, part, part]), 99);
        const shelves = [];
        for (let s = 0; s < 11; s++) { const tl = []; for (let i = 0; i < 12; i++) tl.push(fat(s * 12 + i)); shelves.push({ shelfRenderer: { content: { horizontalListRenderer: { items: tl } } } }); }
        signIn();
        c.clear();
        yt.browse = () => ok(browsePage(shelves));
        c.send({ cmd: 'feed', which: 'home' });
        const e = await c.waitFor((x) => x.ev === 'feed' && x.which === 'home');
        assert.deepStrictEqual([e.items.length, e.shelves.length, e.shelves.every((x) => x.items.length === 12)], [100, 8, true]);
        const line = JSON.stringify(e) + '\n';
        assert.ok(line.length < MAX_LINE && Buffer.byteLength(line) < MAX_LINE, 'feed line ' + Buffer.byteLength(line) + ' bytes');
        assert.ok(Buffer.byteLength(line) > 400000, 'the worst case really is big: ' + Buffer.byteLength(line));
        yt.search = () => ok(browsePage(shelves));
        c.clear();
        c.send({ cmd: 'search', q: 'x' });
        assert.strictEqual((await c.waitFor((x) => x.ev === 'results')).items.length, 100);
        yt.next = () => ok(browsePage(shelves));
        c.send({ cmd: 'related', id: 'YYYYYYYYYY1' });
        assert.strictEqual((await c.waitFor((x) => x.ev === 'related')).items.length, 100);
        yt.search = () => ok(SEARCH); yt.next = null;
    });

    await t('hl / gl from hello reach feeds, search and related; the Playlists page stays English; no hello: hl en, no gl; caps related + hist', async () => {
        assert.ok(CAPS.indexOf('related') >= 0 && CAPS.indexOf('hist') >= 0);
        signIn();
        yt.browse = () => ok(BROWSE);
        yt.next = () => ok(NEXT);
        const ask = async () => {
            yt.calls.length = 0; c.clear();
            c.send({ cmd: 'feed', which: 'subs' }); await c.waitFor((x) => x.ev === 'feed');
            c.send({ cmd: 'search', q: 'q' }); await c.waitFor((x) => x.ev === 'results');
            c.send({ cmd: 'related', id: 'ZZZZZZZZZZ' + (d.hl ? '1' : '2') }); await c.waitFor((x) => x.ev === 'related');
            c.send({ cmd: 'playlists' }); await c.waitFor((x) => x.ev === 'playlists');
            return yt.calls.filter((x) => x.body && x.body.context).map((x) => [x.url.replace(/.*v1\//, ''), x.body.browseId || '', x.body.context.client]);
        };
        c.send({ cmd: 'hello', app: '0.4.0', lang: 'ru', region: 'RU' });
        await waitUntil(() => d.hl === 'ru');
        const ru = { clientName: 'TVHTML5', clientVersion: '7.20261103.19.00', hl: 'ru', gl: 'RU' };
        const en = { clientName: 'TVHTML5', clientVersion: '7.20261103.19.00', hl: 'en' };
        const got = await ask();
        assert.deepStrictEqual(got.slice(0, 4), [['browse', 'FEsubscriptions', ru], ['search', '', ru], ['next', '', ru], ['browse', 'FEplaylist_aggregation', en]]);
        c.send({ cmd: 'hello', app: '0.4.0', region: 'RU' });
        await waitUntil(() => d.hl === null);
        assert.deepStrictEqual((await ask()).slice(0, 3).map((x) => x[2]), [1, 2, 3].map(() => ({ clientName: 'TVHTML5', clientVersion: '7.20261103.19.00', hl: 'en', gl: 'RU' })), 'a region alone');
        c.send({ cmd: 'hello', app: '0.4.0' });
        await waitUntil(() => d.gl === null);
        assert.deepStrictEqual((await ask()).slice(0, 3).map((x) => x[2]), [en, en, en], 'none: as before');
        yt.next = null;
    });

    // ---- WP3 socket + security ----
    const cp = require('child_process');
    const realChown = fs.chownSync, realSpawnSync = cp.spawnSync;
    const chowns = [];
    const recordChown = (fail) => { chowns.length = 0; fs.chownSync = (p, u, g) => { chowns.push([p, u, g]); if (fail === true || fail === u) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }; };
    const wroot = path.join(tmp, 'wp3'), wcache = path.join(wroot, 'cache'), wlogs = [];
    const reg = path.join(wroot, 'oap', 'oap_12201', 'data', 'apps', 'jap_ridetube.json');
    fs.mkdirSync(path.dirname(reg), { recursive: true }); fs.mkdirSync(wcache, { recursive: true });
    const wsock = path.join(tmp, 'w3.sock');
    const modeOf = (p) => fs.statSync(p).mode & 0o777;
    const wmain = [{ root: path.join(wroot, 'mainapp'), hmi: 'HmiMain3D' }];   // app uids 20000-29999
    fs.mkdirSync(path.join(wroot, 'mainapp', 'config'), { recursive: true });
    fs.writeFileSync(path.join(wroot, 'mainapp', 'config', 'base.json'), JSON.stringify({ usableUidsAndGids: { min: 20000, max: 29999 } }));
    const ds = new Daemon({ someip: { buildProxy: () => new Promise(() => {}) }, srcGen: srcGen, cacheDir: wcache, logDir: wroot, sock: wsock,
        oapRoot: path.join(wroot, 'oap'), mgrUid: process.getuid(), mainapps: wmain, tickMs: 100, noSetuid: !root, spare: false, ytRequest: fakeYt, keep: 20,
        accountFile: path.join(wroot, 'account.json'), stateDir: path.join(wroot, 'state'), log: (m) => wlogs.push(m) });

    await t('WP3 registry: trusted only when MainApp (or root) owns every part, no symlink, not world-writable', async () => {
        fs.writeFileSync(reg, JSON.stringify({ appId: 'jap_ridetube', userId: 23456 }));
        assert.strictEqual(ds.regOk(reg), true);
        const other = new Daemon({ oapRoot: path.join(wroot, 'oap'), mgrUid: process.getuid() + 1, mainapps: wmain, ytRequest: fakeYt,
            accountFile: path.join(wroot, 'acct-x.json'), stateDir: path.join(wroot, 'state-x'), log: () => {} });
        assert.strictEqual(root ? true : other.regOk(reg) === false && other.appUid() === null && other.appRemoved() === false, true);
        fs.chmodSync(reg, 0o666);
        assert.strictEqual(ds.regOk(reg), false);
        assert.strictEqual(ds.appUid(), null);
        fs.chmodSync(reg, 0o644);
        const real = path.join(wroot, 'apps-real'), apps = path.dirname(reg);
        fs.renameSync(apps, real); fs.symlinkSync(real, apps);
        try { assert.strictEqual(ds.regOk(reg), false); assert.strictEqual(ds.appUid(), null); assert.strictEqual(ds.appRemoved(), false); }
        finally { fs.unlinkSync(apps); fs.renameSync(real, apps); }
        assert.strictEqual(ds.appUid(), 23456);
    });
    await t('WP3 socket: owner and mode from MainApp\'s registry (<app uid>:root 0600)', async () => {
        fs.writeFileSync(reg, JSON.stringify({ appId: 'jap_ridetube', userId: 23456 }));
        recordChown(false);
        try {
            ds.start();
            await waitUntil(() => ds.sockUid === 23456, 2000);
            assert.deepStrictEqual(chowns.slice(-1)[0], [wsock, 23456, 0]);
            assert.strictEqual(modeOf(wsock), 0o600);
            assert.strictEqual(ds.sockShared(), false);
            assert.ok(wlogs.indexOf('ctl.sock: app uid 23456 only (0600)') >= 0, wlogs.join('\n'));
        } finally { fs.chownSync = realChown; }
    });

    await t('WP3 socket: a new app uid (reinstall) re-chowns within one tick', async () => {
        recordChown(false);
        try {
            await sleep(250);
            assert.deepStrictEqual(chowns, [], 'nothing re-applied while the uid stays');
            fs.writeFileSync(reg, JSON.stringify({ appId: 'jap_ridetube', userId: 23457 }));
            await waitUntil(() => chowns.length, 250);
            assert.deepStrictEqual(chowns, [[wsock, 23457, 0]]);
            assert.strictEqual(modeOf(wsock), 0o600);
        } finally { fs.chownSync = realChown; }
    });

    await t('WP3 socket: registry entry removed (uninstall) after a uid was known -> root only (0600) until it comes back', async () => {
        recordChown(false);
        const keep = fs.readFileSync(reg);
        try {
            fs.unlinkSync(reg);
            await waitUntil(() => ds.sockUid === 0, 350);
            assert.deepStrictEqual([chowns.slice(-1)[0], modeOf(wsock), ds.sockShared()], [[wsock, 0, 0], 0o600, false]);
            assert.strictEqual(wlogs.filter((m) => /no longer in MainApp's registry: root only$/.test(m)).length, 1, 'logged once');
            fs.writeFileSync(reg, keep);
            await waitUntil(() => ds.sockUid === 23457, 350);
            assert.deepStrictEqual(chowns.slice(-1)[0], [wsock, 23457, 0]);
        } finally { fs.chownSync = realChown; }
    });

    await t('WP3 socket: registry unreadable or not an app uid -> the last uid kept (logged once), never shared; a failed chown keeps the previous owner', async () => {
        recordChown(false);
        try {
            fs.writeFileSync(reg, '{');
            await sleep(350);
            assert.deepStrictEqual([ds.sockUid, chowns, modeOf(wsock), ds.sockShared()], [23457, [], 0o600, false]);
            ['{"userId":"root"}', '{"userId":true}', '{"userId":5}', '{"userId":23999}', '{"userId":23456.5}', '{'].forEach((txt) => {
                ds.fetchUid = 23999;   // the fetch uid is never the app's
                fs.writeFileSync(reg, txt);
                ds.lockSocket();
            });
            ds.fetchUid = null;
            await sleep(250);
            assert.deepStrictEqual([ds.sockUid, chowns, modeOf(wsock)], [23457, [], 0o600]);
            assert.strictEqual(wlogs.filter((m) => /kept 23457$/.test(m)).length, 1, 'logged once');
            assert.ok(!wlogs.some((m) => /^ctl\.sock: shared/.test(m)), wlogs.join('\n'));
            recordChown(23458);
            fs.writeFileSync(reg, JSON.stringify({ userId: 23458 }));
            await waitUntil(() => chowns.length >= 2, 250);                       // the try, then the previous owner back
            assert.deepStrictEqual(chowns.slice(0, 2), [[wsock, 23458, 0], [wsock, 23457, 0]]);
            assert.deepStrictEqual([ds.sockUid, modeOf(wsock), ds.sockShared()], [23457, 0o600, false]);
            await sleep(250);
            assert.strictEqual(wlogs.filter((m) => /EPERM: kept app uid 23457/.test(m)).length, 1, 'logged once');
            recordChown(true);                                                    // the old owner cannot be put back either: root only
            await waitUntil(() => ds.sockUid === 0, 350);
            assert.deepStrictEqual([modeOf(wsock), ds.sockShared()], [0o600, false]);
            recordChown(false);
            await waitUntil(() => ds.sockUid === 23458, 350);
        } finally {
            fs.chownSync = realChown;
            ds.timers.forEach(clearInterval); ds.timers = [];
            ds.server.close();
        }
    });

    // a daemon on its own socket and state, listening only (lockSocket by hand)
    const wds = [];
    const sockDaemon = async (name, state) => {
        const x = new Daemon({ someip: someip, srcGen: srcGen, cacheDir: wcache, logDir: wroot, sock: path.join(tmp, name + '.sock'),
            oapRoot: path.join(wroot, 'oap'), mgrUid: process.getuid(), mainapps: wmain, noSetuid: true, spare: false, ytRequest: fakeYt, keep: 20,
            accountFile: path.join(wroot, 'account.json'), stateDir: state || path.join(wroot, 'st-' + name), log: (m) => wlogs.push(m) });
        wds.push(x);
        x.listen();
        await waitUntil(() => x.sockUid !== undefined, 1000);
        return x;
    };

    await t('WP3 socket: the last app uid is kept in state/app-uid.json (0600): a restart with no registry entry stays locked to it', async () => {
        recordChown(false);
        try {
            const f = path.join(wroot, 'state', 'app-uid.json');
            assert.deepStrictEqual([JSON.parse(fs.readFileSync(f, 'utf8')), modeOf(f)], [{ uid: 23458 }, 0o600]);
            fs.writeFileSync(reg, '{');                                 // unreadable, not removed
            const x = await sockDaemon('restart', path.join(wroot, 'state'));
            assert.deepStrictEqual([x.sockUid, chowns.slice(-1)[0], modeOf(x.opts.sock)], [23458, [x.opts.sock, 23458, 0], 0o600]);
            fs.writeFileSync(f, JSON.stringify({ uid: 5 }));            // not an app uid: not trusted either
            const y = await sockDaemon('restart2', path.join(wroot, 'state'));
            assert.strictEqual(y.sockUid, null);
        } finally { fs.chownSync = realChown; }
    });

    await t('WP3 socket: shared (0660) only while no app uid was ever known; once known, never shared again', async () => {
        recordChown(false);
        try {
            try { fs.unlinkSync(reg); } catch (e) { /* none */ }
            const x = await sockDaemon('fresh');
            assert.deepStrictEqual([x.sockUid, modeOf(x.opts.sock), x.sockShared()], [null, 0o660, true]);
            fs.writeFileSync(reg, JSON.stringify({ userId: 23460 }));
            x.lockSocket();
            assert.deepStrictEqual([x.sockUid, modeOf(x.opts.sock), x.sockShared()], [23460, 0o600, false]);
            fs.unlinkSync(reg);                                          // removed once known: root only, not shared
            x.lockSocket();
            assert.deepStrictEqual([x.sockUid, modeOf(x.opts.sock), x.sockShared()], [0, 0o600, false]);
        } finally { fs.chownSync = realChown; }
    });

    await t('WP3 socket: an owner change drops the connected client (made under the old mode); its reconnect stays', async () => {
        recordChown(false);
        try {
            try { fs.unlinkSync(reg); } catch (e) { /* none */ }
            const x = await sockDaemon('drop');
            assert.strictEqual(x.sockUid, null);
            fs.chmodSync(x.opts.sock, 0o600);   // (as the test's own user: connecting needs the owner bit, chown is stubbed)
            const c1 = await client(x.opts.sock);
            await waitUntil(() => x.client, 1000);
            const gone = new Promise((r) => c1.on('close', r));
            fs.writeFileSync(reg, JSON.stringify({ userId: 23461 }));
            x.lockSocket();
            assert.strictEqual(await Promise.race([gone.then(() => 'closed'), sleep(1000).then(() => 'open')]), 'closed');
            assert.ok(wlogs.some((m) => /owner changed: the connected client is dropped/.test(m)));
            const c2 = await client(x.opts.sock);
            await waitUntil(() => x.client, 1000);
            const closed = [];
            c2.on('close', () => closed.push(1));
            x.lockSocket(); x.lockSocket();
            await sleep(100);
            assert.deepStrictEqual([closed, x.sockUid], [[], 23461], 'same uid: kept');
            c2.destroy();
        } finally { fs.chownSync = realChown; }
    });

    await t('WP3 appUid: an integer or digits inside MainApp\'s ranges, never the fetch uid; ranges unknown: range not checked', async () => {
        const x = wds[0], cases = [[true, null], [1, null], [19999, null], [30000, null], ['23462', 23462], [23462, 23462], [23462.5, null], ['2e4', null], [null, null], [0, null]];
        cases.forEach((cv) => { fs.writeFileSync(reg, JSON.stringify({ userId: cv[0] })); assert.strictEqual(x.appUid(), cv[1], JSON.stringify(cv)); });
        x.fetchUid = 23462;
        assert.strictEqual(x.appUid(), null, 'the fetch uid');
        x.fetchUid = null;
        const y = new Daemon({ oapRoot: path.join(wroot, 'oap'), mgrUid: process.getuid(), mainapps: [], ytRequest: fakeYt, accountFile: path.join(wroot, 'account.json'), log: () => {} });
        fs.writeFileSync(reg, JSON.stringify({ userId: 40000 }));
        assert.strictEqual(y.appUid(), 40000);
        y.account.close();
    });

    await t('WP3 SponsorBlock cache in root\'s cache/.sb: a sb.json symlink in the video folder is never read or written', async () => {
        const id = 'SBSBSBSBSB1', vdir = path.join(wcache, id), victim = path.join(wroot, 'victim.json');
        fs.mkdirSync(vdir);
        const planted = '[{"s":1000,"e":9000,"cat":"sponsor"}]';
        fs.writeFileSync(victim, planted);
        fs.symlinkSync(victim, path.join(vdir, 'sb.json'));
        yt.sb = () => ({ status: 200, body: JSON.stringify([{ videoID: id, segments: [{ category: 'sponsor', actionType: 'skip', segment: [10, 20] }] }]) });
        yt.calls.length = 0;
        const cur = { id: id, dir: vdir };
        ds.cur = cur;
        await ds.loadSegments(cur);
        assert.strictEqual(yt.calls.filter((x) => /sponsor/.test(x.url)).length, 1, 'asked SponsorBlock: the planted file is not read');
        assert.deepStrictEqual(cur.segs, [{ s: 10000, e: 20000, cat: 'sponsor' }]);
        assert.strictEqual(fs.readFileSync(victim, 'utf8'), planted, 'the symlink target is unchanged');
        assert.ok(fs.lstatSync(path.join(vdir, 'sb.json')).isSymbolicLink());
        const f = path.join(wcache, '.sb', id + '.json');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), [{ s: 10000, e: 20000, cat: 'sponsor' }]);
        assert.deepStrictEqual([modeOf(path.join(wcache, '.sb')), modeOf(f)], [0o700, 0o600]);
        await ds.loadSegments(cur);
        assert.strictEqual(yt.calls.filter((x) => /sponsor/.test(x.url)).length, 1, 'cached');
        ds.cur = null;
    });

    await t('WP3 prefetch: root never makes, chowns or prunes info/ (a symlink there reaches nothing); chownFetch refuses deeper paths', async () => {
        const c2 = path.join(wroot, 'cache2'), ytc = path.join(c2, 'ytdlp'), away = path.join(wroot, 'away');
        fs.mkdirSync(ytc, { recursive: true }); fs.mkdirSync(away);
        const old = path.join(away, 'old.json');
        fs.writeFileSync(old, '{}'); fs.utimesSync(old, new Date(0), new Date(0));
        fs.symlinkSync(away, path.join(ytc, 'info'));
        const jobs = [];
        const di = new Daemon({ someip: someip, srcGen: srcGen, cacheDir: c2, logDir: wroot, noSetuid: false, spare: true, ytRequest: fakeYt,
            accountFile: path.join(wroot, 'account.json'), stateDir: path.join(wroot, 'state'), log: (m) => wlogs.push(m) });
        di.fetchUid = 4242;
        di.spawnJob = (args) => { jobs.push(args); return cp.spawn(process.execPath, ['-e', '']); };
        recordChown(false);
        try {
            di.prefetch('INFOINFOIN1');
            await di.extracting.done;
            assert.deepStrictEqual(jobs, [['extract', '--cache-dir', ytc, '--', 'INFOINFOIN1', path.join(ytc, 'info', 'INFOINFOIN1.json')]]);
            assert.ok(chowns.length > 0 && chowns.every((x) => x[0] === ytc && x[1] === 4242), JSON.stringify(chowns));
            assert.ok(fs.existsSync(old), 'an old file behind the symlink is not pruned by root');
            assert.ok(fs.lstatSync(path.join(ytc, 'info')).isSymbolicLink());
            assert.throws(() => di.chownFetch(path.join(ytc, 'info')), /outside the cache/);
            assert.throws(() => di.chownFetch(old), /outside the cache/);
            assert.ok(chowns.every((x) => x[0] === ytc));
        } finally { fs.chownSync = realChown; }
        di.account.close();
    });

    await t('WP3 rmTree: a fetch-owned folder is emptied by its owner (rm -rf as that uid), then root rmdirs it; prune goes through it and skips .sb', async () => {
        const runs = [], own = (p) => { if (root) cp.execSync('chown -hR 4242:4242 ' + p); };   // as root (Docker): a fetch uid's tree
        cp.spawnSync = function (cmd, args, o) { runs.push([cmd, args, o]); return realSpawnSync.apply(cp, arguments); };
        try {
            const vid = path.join(wcache, 'RMRMRMRMRM1'), away = path.join(wroot, 'away2');
            fs.mkdirSync(vid); fs.mkdirSync(away);
            fs.writeFileSync(path.join(vid, 'audio.m4a'), 'a'); fs.writeFileSync(path.join(away, 'keep.txt'), 'k');
            fs.symlinkSync(away, path.join(vid, 'link'));
            own(vid);
            ds.rmTree(vid);
            assert.deepStrictEqual(runs.map((r) => [r[0], r[1]]), [['/bin/rm', ['-rf', '--', vid]]]);
            assert.deepStrictEqual([runs[0][2].env, runs[0][2].cwd], [{}, '/']);
            assert.ok(!fs.existsSync(vid) && fs.existsSync(path.join(away, 'keep.txt')));
            // prune: every id folder through it; .sb/<id>.json goes with its folder, a protected one stays; .sb itself untouched
            runs.length = 0;
            const sbd = path.join(wcache, '.sb');
            ['PRPRPRPRPR1', 'PRPRPRPRPR2'].forEach((id) => { fs.mkdirSync(path.join(wcache, id)); fs.writeFileSync(path.join(sbd, id + '.json'), '[]'); });
            fs.writeFileSync(path.join(sbd, 'KEEPKEEPKE1.json'), '[]');
            ['PRPRPRPRPR1', 'PRPRPRPRPR2', 'SBSBSBSBSB1'].forEach((id) => own(path.join(wcache, id)));
            ds.opts.keep = 0; ds.preparing = 'KEEPKEEPKE1';
            const removed = ds.prune();
            ds.preparing = null;
            assert.deepStrictEqual(removed.sort(), ['PRPRPRPRPR1', 'PRPRPRPRPR2', 'SBSBSBSBSB1']);
            assert.deepStrictEqual(runs.map((r) => r[1][2]).sort(), removed.map((id) => path.join(wcache, id)));
            assert.deepStrictEqual(fs.readdirSync(sbd), ['KEEPKEEPKE1.json']);
        } finally { cp.spawnSync = realSpawnSync; }
        // as root: rm runs as the folder's owner (the fetch uid), never root
        const vid3 = path.join(wroot, 'cache2', 'OWNEROWNER1');
        fs.mkdirSync(vid3); own(vid3);
        const st = fs.lstatSync(vid3), seen = [];
        const di = new Daemon({ cacheDir: path.join(wroot, 'cache2'), noSetuid: false, ytRequest: fakeYt, accountFile: path.join(wroot, 'account.json'), log: () => {} });
        cp.spawnSync = (cmd, args, o) => { seen.push(o); return { status: 1 }; };
        try { di.rmTree(vid3); } finally { cp.spawnSync = realSpawnSync; }
        assert.deepStrictEqual([seen[0].uid, seen[0].gid], [st.uid, st.uid], 'gid = uid, as every fetch spawn');
        assert.ok(!fs.existsSync(vid3), 'root rmdirs the emptied folder');
        di.account.close();
    });

    await t('WP3 pruneCache (the plain function): .sb is not a video, never listed or removed', async () => {
        const lc = path.join(wroot, 'lc');
        fs.mkdirSync(path.join(lc, '.sb'), { recursive: true });
        fs.writeFileSync(path.join(lc, '.sb', 'ZZZZZZZZZZ1.json'), '[]');
        fs.mkdirSync(path.join(lc, 'ZZZZZZZZZZ1'));
        assert.deepStrictEqual(listCache(lc).map((x) => x.id), ['ZZZZZZZZZZ1']);
        assert.deepStrictEqual(pruneCache(lc, 0, [], () => {}), ['ZZZZZZZZZZ1']);
        assert.deepStrictEqual([fs.existsSync(path.join(lc, '.sb')), fs.readdirSync(path.join(lc, '.sb'))], [true, []]);
    });

    await t('WP3 rmTree: a folder owned by one of MainApp\'s app uids is refused (thrown, left), rm never runs', async () => {
        const vid = path.join(wcache, 'APPUIDAPPU1'), runs = [], realLstat = fs.lstatSync;
        fs.mkdirSync(vid);
        fs.lstatSync = function (p) { const st = realLstat.apply(fs, arguments); if (p === vid) st.uid = 20500; return st; };
        cp.spawnSync = function () { runs.push(arguments); return realSpawnSync.apply(cp, arguments); };
        try {
            assert.throws(() => wds[0].rmTree(vid), /owned by app uid 20500/);
        } finally { fs.lstatSync = realLstat; cp.spawnSync = realSpawnSync; }
        assert.deepStrictEqual([runs.length, fs.existsSync(vid)], [0, true]);
        fs.rmdirSync(vid);
    });

    await t('WP3 root reads in a video folder: a FIFO meta.json does not hang, symlinks and wrong sizes are missing', async () => {
        const fifo = path.join(wroot, 'fifo'), fv = path.join(fifo, 'FIFOFIFOFI1');
        fs.mkdirSync(fv, { recursive: true });
        cp.execSync('mkfifo ' + path.join(fv, 'meta.json'));
        const r = cp.spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(process.argv[1]).listCache(process.argv[2])))',
            path.join(__dirname, '..', 'ytd.js'), fifo], { timeout: 3000, encoding: 'utf8' });
        assert.ok(!r.error && r.status === 0, 'listCache returned: ' + (r.error && r.error.message));
        assert.strictEqual(JSON.parse(r.stdout)[0].title, 'FIFOFIFOFI1');
        const away = path.join(wroot, 'away3');
        fs.mkdirSync(away);
        fs.writeFileSync(path.join(away, 'meta.json'), JSON.stringify({ title: 'Planted' }));
        fs.writeFileSync(path.join(away, 'thumb.rgba'), Buffer.alloc(57600, 3));
        const lc = path.join(wroot, 'reads'), big = path.join(lc, 'BIGBIGBIGB1'), sym = path.join(lc, 'SYMSYMSYMS1');
        fs.mkdirSync(big, { recursive: true }); fs.mkdirSync(sym);
        fs.writeFileSync(path.join(big, 'meta.json'), JSON.stringify({ title: 'Big', pad: 'x'.repeat(70 << 10) }));
        fs.symlinkSync(path.join(away, 'meta.json'), path.join(sym, 'meta.json'));
        assert.deepStrictEqual(listCache(lc).map((x) => x.title).sort(), ['BIGBIGBIGB1', 'SYMSYMSYMS1'], 'over 64 KiB / a symlink: no meta');
        fs.writeFileSync(path.join(big, 'meta.json'), JSON.stringify({ title: 'Small' }));
        assert.ok(listCache(lc).some((x) => x.title === 'Small'), 'a plain meta.json is read');
        // thumbs: a symlinked thumb.rgba and an odd size are missing (the helper is asked instead)
        const asked = [], evs = [], x = wds[0];
        x.opts.cacheDir = lc;
        x.thumbFetch = (id) => { asked.push(id); return Promise.reject(new Error('offline')); };
        x.emit = (o) => evs.push(o);
        fs.symlinkSync(path.join(away, 'thumb.rgba'), path.join(sym, 'thumb.rgba'));
        fs.writeFileSync(path.join(big, 'thumb.rgba'), Buffer.alloc(1234, 1));
        await x.thumb('SYMSYMSYMS1'); await x.thumb('BIGBIGBIGB1');
        assert.deepStrictEqual([evs, asked], [[], ['SYMSYMSYMS1', 'BIGBIGBIGB1']]);
        fs.writeFileSync(path.join(big, 'thumb.rgba'), Buffer.alloc(57600, 1));
        await x.thumb('BIGBIGBIGB1');
        assert.deepStrictEqual(evs.map((e) => [e.id, e.w, e.h]), [['BIGBIGBIGB1', 160, 90]]);
        x.opts.cacheDir = wcache;
    });

    await t('WP3 cache dir at start: a symlink or a foreign owner refuses to start; group/other writable is fixed to 0711 and logged', async () => {
        const real = path.join(wroot, 'cdreal'), link = path.join(wroot, 'cdlink'), realLstat = fs.lstatSync;
        fs.mkdirSync(real); fs.chmodSync(real, 0o777);
        fs.symlinkSync(real, link);
        const x = wds[0];
        x.opts.cacheDir = link;
        const r = await Promise.race([x.start().then(() => 'started', (e) => e), sleep(1000).then(() => 'still running')]);
        assert.ok(r instanceof Error && r.refuse && /is not a folder/.test(r.message), String(r));
        x.opts.cacheDir = real;
        fs.lstatSync = function (p) { const st = realLstat.apply(fs, arguments); if (p === real) st.uid = process.getuid() + 1; return st; };
        try { assert.throws(() => x.checkCacheDir(), /owned by uid/); } finally { fs.lstatSync = realLstat; }
        x.checkCacheDir();
        assert.strictEqual(modeOf(real), 0o711);
        assert.ok(wlogs.some((m) => /^SECURITY: cache dir .* was 777/.test(m)), wlogs.join('\n'));
        x.opts.cacheDir = wcache;
    });
    wds.forEach((x) => { x.server.close(); x.account.close(); });

    // ---- WP2 recovery ----
    // every test here ends stopped with no audio connection of ours (the same leftover check as above)
    const idle = async () => { await stopIdle(); c.clear(); assert.strictEqual(ours().length, 0, 'an audio connection left open'); };
    // a BMW proxy's callMethod through f(m, a, real): delays and refusals without touching the harness; returns the undo
    const hook = (o, f) => { const real = o.callMethod; o.callMethod = (m, a, ms) => f(m, a, () => real.call(o, m, a, ms)); return () => { o.callMethod = real; }; };
    const underrun = () => subs.playbackErrorEvent({ event: 'ITEM_BUFFER_UNDERRUN' });
    const cached = async (id) => {
        if (!fs.existsSync(path.join(cache, id))) mkVideo(id);
        fs.writeFileSync(ytlog, ''); setMode('ok');
        c.clear(); c.send({ cmd: 'play', id: id, rect: '1280x720' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.id === id);
        subs.playerState('PLAYER_STATE_PLAY');
        tick(5000); await sleep(50);
        calls.length = 0; c.clear();
    };
    // one recovery to its end: the replayed file's first tick lets its setTime go
    const recovered = async (n) => {
        await waitUntil(() => called('playFile').length === n, 4000);
        tick(0);
        await waitUntil(() => !d.recovering && called('setTime').length === n, 4000);
    };
    d.opts.underrunWaitMs = 60; d.opts.audioRetryMs = 60;

    await t('WP2 underrun on the full file: after the wait the player again at the clock (new connection), state stays playing; other events stay errors', async () => {
        await cached('WP2UNDRUN01');
        underrun();
        await sleep(20);
        assert.strictEqual(called('connect').length, 0, 'not before the wait');
        await recovered(1);
        assert.deepStrictEqual(calls.map((x) => x.m).filter((m) => m !== 'sendButtonEvent'), ['disconnect', 'connect', 'playFile', 'setTime']);
        assert.deepStrictEqual(called('setTime')[0].a, { newTimeElapsed: 5000 });
        assert.ok(!c.evs.some((x) => x.ev === 'error' || x.ev === 'state'), 'no error, no state change: ' + JSON.stringify(c.evs));
        assert.strictEqual(ours().length, 1);
        assert.strictEqual(ytdecIns().slice(-3).join(), 'in pause,in seek 5000,in resume');
        subs.playbackErrorEvent({ event: 'SOMETHING_ELSE' });
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'playback error {"event":"SOMETHING_ELSE"}');
        assert.strictEqual(ours().length, 0);
        await idle();
    });

    await t('WP2 underrun burst (4 at once): one recovery, no error; one after it counts again', async () => {
        await cached('WP2UNDRUN02');
        for (let k = 0; k < 4; k++) underrun();
        await recovered(1);
        underrun();
        await recovered(2);
        assert.strictEqual(called('connect').length, 2);
        assert.ok(!c.evs.some((x) => x.ev === 'error'));
        await idle();
    });

    await t('WP2 underrun: 3 recoveries in a rolling minute, the 4th is an error of its own (audio released)', async () => {
        await cached('WP2UNDRUN03');
        for (let n = 1; n <= 3; n++) { underrun(); await recovered(n); }
        underrun();
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'audio underrun: 3 recoveries in a minute, stopped');
        assert.strictEqual(d.state, 'error');
        assert.strictEqual(ours().length, 0);
        await idle();
    });

    await t('WP2 underrun on the head before audio.m4a: waits for it (buffering), no error; audio_ready plays on', async () => {
        await headPlay('WP2UNDRUNH1', 'hold');
        c.clear();
        underrun();
        await c.waitFor((x) => x.ev === 'state' && x.buffering === true);
        assert.ok(d.headWait);
        fs.writeFileSync(ctl, 'done');
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.buffering === false, 4000);
        assert.ok(!c.evs.some((x) => x.ev === 'error' || x.state === 'error'));
        assert.strictEqual(ours().length, 1);
        await idle();
    });

    await t('WP2 underrun during the head -> full switch: ignored, the switch completes on the same connection', async () => {
        await headPlay('WP2UNDRUNH2', 'hold');
        tick(10000);
        slowPlayFile = 300;
        fs.writeFileSync(ctl, 'full');
        await waitUntil(() => called('playFile').length === 2);
        c.clear();
        underrun();
        slowPlayFile = 0;
        await waitUntil(() => called('setTime').length === 1);
        await sleep(150);
        assert.ok(!c.evs.some((x) => x.ev === 'error' || x.state === 'error'), JSON.stringify(c.evs));
        assert.strictEqual(called('disconnect').length, 0, 'audio connection kept');
        assert.strictEqual(called('connect').length, 1);
        await idle();
    });

    for (const off of [20, 140]) await t('WP2 a fatal error ' + off + ' ms into an underrun recovery (BMW answers in 80 ms): the error stands, nothing reopens the audio', async () => {
        await cached('WP2UNDRUN04');
        d.opts.underrunWaitMs = 100;
        const undo = hook(d.audio.cc, async (m, a, real) => { await sleep(80); return real(); });
        try {
            underrun();
            await sleep(off);
            subs.playbackErrorEvent({ event: 'FATAL' });
            const e = await c.waitFor((x) => x.ev === 'error', 4000);
            assert.ok(/FATAL/.test(e.msg), e.msg);
            await sleep(600);
            assert.strictEqual(d.state, 'error');
            assert.strictEqual(ours().length, 0, 'no audio connection of ours left');
        } finally { undo(); d.opts.underrunWaitMs = 60; }
        await idle();
    });

    await t('WP2 audio start: a refused connect is tried once more and plays; refused twice -> error, nothing left connected', async () => {
        if (!fs.existsSync(path.join(cache, 'WP2AUDIO001'))) mkVideo('WP2AUDIO001');
        let refuse = 1, asked = 0;
        const undo = hook(d.audio.cc, (m, a, real) => { if (m !== 'connect') return real(); asked++; return refuse-- > 0 ? Promise.resolve({ amError: 'E_NOT_POSSIBLE' }) : real(); });
        try {
            c.clear(); calls.length = 0;
            c.send({ cmd: 'play', id: 'WP2AUDIO001', rect: '1280x720' });
            await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
            assert.strictEqual(asked, 2);
            assert.ok(!c.evs.some((x) => x.ev === 'error'));
            assert.strictEqual(ours().length, 1);
            await idle();
            refuse = 2; asked = 0;
            c.send({ cmd: 'play', id: 'WP2AUDIO001', rect: '1280x720' });
            await c.waitFor((x) => x.ev === 'error' && x.msg === 'audio connect: E_NOT_POSSIBLE');
            assert.strictEqual(asked, 2, 'once more, not more');
            assert.strictEqual(d.state, 'error');
            assert.strictEqual(ours().length, 0);
        } finally { undo(); }
        await idle();
    });

    await t('WP2 fetcher dies mid-play: fetched again into the same folder (no --info) after the wait, the sound untouched, ytdec again; it completes', async () => {
        fs.writeFileSync(ctl, ''); setMode('ok'); fs.writeFileSync(ytlog, '');
        d.opts.fetchRetryMs = [300, 300];
        const id = 'WP2FETCH001', dir = path.join(cache, id);
        try {
            await fetchPlay(id);
            calls.length = 0; c.clear();
            await waitUntil(() => ytdecLines().some((x) => / argv /.test(x)));
            const argv = ytdecLines().filter((x) => / argv /.test(x)).length;
            fs.writeFileSync(ctl, 'error');
            await waitUntil(() => logs.some((l) => l === 'fetch ' + id + ': HTTP 403 - fetched again in 300 ms (1 of 2)'));
            fs.writeFileSync(ctl, 'done');
            await waitUntil(() => d.fetchedMs === Infinity, 4000);
            assert.deepStrictEqual(fetchLog().argv.slice(1), ['fetch', '--cache-dir', path.join(cache, 'ytdlp'), '--height', '720', '--', id, dir]);
            await waitUntil(() => ytdecLines().filter((x) => / argv /.test(x)).length === argv + 1);
            assert.deepStrictEqual(calls.map((x) => x.m), [], 'no connect, disconnect or button');
            assert.ok(!c.evs.some((x) => x.ev === 'error' || (x.ev === 'state' && x.state !== 'playing')), JSON.stringify(c.evs));
            assert.ok(isPlayable(dir));
        } finally { d.opts.fetchRetryMs = []; }
        await idle();
    });

    await t('WP2 fetcher dies mid-play three times: fetched again twice, then "video incomplete" as before, the sound plays on', async () => {
        fs.writeFileSync(ctl, '');
        const id = 'WP2FETCH002';
        await fetchPlay(id);
        calls.length = 0; c.clear();
        fs.writeFileSync(ctl, 'error');
        await c.waitFor((x) => x.ev === 'error' && x.msg === 'video incomplete: HTTP 403', 4000);
        assert.deepStrictEqual(logs.filter((l) => l.indexOf('fetch ' + id + ': HTTP 403 - fetched again') === 0).map((l) => l.slice(-8)), ['(1 of 2)', '(2 of 2)']);
        assert.deepStrictEqual(calls.map((x) => x.m), []);
        assert.strictEqual(d.state, 'playing');
        assert.strictEqual(ours().length, 1);
        // a refusal (the video gone) or a full disk is not fetched again
        assert.strictEqual(d.resumeFetch(id, path.join(cache, id), 'Video unavailable'), false);
        assert.strictEqual(d.resumeFetch(id, path.join(cache, id), 'head unit storage almost full (200 MiB free): video stopped'), false);
        await idle();
    });

    await t('WP2 play retry: no --info, and root never unlinks info/<id>.json (info/ swapped for a symlink reaches nothing)', async () => {
        const info = path.join(cache, 'ytdlp', 'info'), away = path.join(tmp, 'wp2away'), id = 'WP2INFO0001';
        const kept = fs.existsSync(info) ? info + '.wp2' : null;
        if (kept) fs.renameSync(info, kept);
        fs.mkdirSync(away, { recursive: true });
        fs.writeFileSync(path.join(away, id + '.json'), JSON.stringify({ id: id }));
        fs.symlinkSync(away, info);
        d.opts.fetchRetryMs = [200];
        try {
            fs.writeFileSync(ctl, 'fail'); c.clear();
            c.send({ cmd: 'play', id: id, rect: '1280x720' });
            await c.waitFor((x) => x.ev === 'retry', 4000);
            fs.writeFileSync(ctl, '');
            await c.waitFor((x) => x.ev === 'state' && x.state === 'playing' && x.id === id, 4000);
            assert.ok(fs.existsSync(path.join(away, id + '.json')), 'the file behind the symlink is still there');
            assert.ok(fetchLog().argv.indexOf('--info') < 0, 'the retry extracts again: ' + fetchLog().argv.join(' '));
        } finally {
            d.opts.fetchRetryMs = [];
            fs.unlinkSync(info);
            if (kept) fs.renameSync(kept, info);
        }
        await idle();
    });

    await t('WP2 quality while playing: back to where it was even under 10 s; paused stays paused (no sound until resume, then there)', async () => {
        fs.writeFileSync(ctl, ''); setMode('ok');
        await fetchPlay('WP2QUALIT01');
        tick(5000); await sleep(100);
        c.clear(); calls.length = 0;
        c.send({ cmd: 'quality', quality: '480' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing', 4000);
        await sleep(100); tick(0);
        await waitUntil(() => called('setTime').length > 0);
        assert.deepStrictEqual(called('setTime').map((x) => x.a.newTimeElapsed), [5000], 'the 5 s it was at, not 0');
        c.send({ cmd: 'pause' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'paused');
        c.clear(); calls.length = 0;
        c.send({ cmd: 'quality', quality: '360' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'paused', 4000);
        await sleep(200);
        assert.ok(!c.evs.some((x) => x.ev === 'state' && x.state === 'playing'), 'paused all along: ' + c.evs.map((x) => x.state).join());
        assert.strictEqual(called('connect').length, 0, 'no sound while paused');
        assert.strictEqual(d.cur.height, 360);
        // resume: the file at the place it was paused
        c.send({ cmd: 'resume' });
        await waitUntil(() => called('playFile').length === 1);
        tick(0);
        await waitUntil(() => called('setTime').length === 1);
        assert.deepStrictEqual(called('setTime')[0].a, { newTimeElapsed: 5000 });
        await idle();
    });

    await t('WP2 quality then stop at once: the video stays stopped (the restart is cancelled)', async () => {
        fs.writeFileSync(ctl, ''); setMode('ok');
        await fetchPlay('WP2QUALIT02');
        c.clear();
        c.send({ cmd: 'quality', quality: '480' });
        c.send({ cmd: 'stop' });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'idle');
        await sleep(800);
        const st = c.evs.filter((x) => x.ev === 'state').map((x) => x.state);
        assert.deepStrictEqual(st.slice(st.indexOf('idle')), ['idle'], 'nothing after idle: ' + st.join());
        assert.strictEqual(ours().length, 0);
        c.clear();
    });

    await t('WP2 a play resumed at its place: no `time` at the old place before the seek lands (the app\'s "Resumed at" reads the first one)', async () => {
        mkVideo('WP2RESUME01');
        d.opts.resume = true;
        try {
            c.clear(); calls.length = 0;
            c.send({ cmd: 'play', id: 'WP2RESUME01', rect: '1280x720', at: 30000 });
            await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
            subs.playerState('PLAYER_STATE_PLAY');
            tick(0);                       // the first tick: the seek there
            await waitUntil(() => called('setTime').length === 1);
            assert.deepStrictEqual(called('setTime')[0].a, { newTimeElapsed: 30000 });
            await sleep(300); tick(250);   // the player's next time, from before the setTime landed
            await sleep(300); tick(30250);
            await c.waitFor((x) => x.ev === 'time');
            assert.deepStrictEqual(c.evs.filter((x) => x.ev === 'time').map((x) => x.elapsed), [30250]);
        } finally { d.opts.resume = false; }
        await idle();
    });

    await t('WP2 play: a FIFO meta.json (the fetch uid\'s folder) does not hang it; chapters read without following a symlink', async () => {
        const fc = path.join(tmp, 'wp2fifo'), fv = path.join(fc, 'FIFOPLAY001');
        fs.mkdirSync(fv, { recursive: true });
        cp.execSync('mkfifo ' + path.join(fv, 'meta.json'));
        const run = [
            'const { Daemon } = require(process.argv[1]);',
            'const d = new Daemon({ someip: { buildProxy: () => new Promise(() => {}) }, cacheDir: process.argv[2], logDir: process.argv[2], stateDir: process.argv[2],',
            '    accountFile: process.argv[2] + "/a.json", noSetuid: true, fetchRetryMs: [], resume: false, ytRequest: async () => ({ status: 404, body: "" }), log: () => {} });',
            'd.emit = () => {}; d.fetchVideo = () => Promise.reject(new Error("stub"));',
            'd.play(process.argv[3], "1280x720").then(() => { console.log(JSON.stringify({ title: d.cur.title, chapters: d.cur.chapters || null })); process.exit(0); });'].join('\n');
        const r = cp.spawnSync(process.execPath, ['-e', run, path.join(__dirname, '..', 'ytd.js'), fc, 'FIFOPLAY001'], { timeout: 4000, encoding: 'utf8' });
        assert.ok(!r.error && r.status === 0, 'play returned: ' + (r.error && r.error.message) + ' ' + r.stderr);
        assert.deepStrictEqual(JSON.parse(r.stdout), { title: 'FIFOPLAY001', chapters: null });
        // a symlinked meta.json: its chapters are not read
        const away = path.join(tmp, 'wp2meta.json'), sv = path.join(fc, 'SYMPLAY0001');
        fs.writeFileSync(away, JSON.stringify({ title: 'Planted', chapters: [[0, 'Planted']] }));
        fs.mkdirSync(sv); fs.symlinkSync(away, path.join(sv, 'meta.json'));
        const r2 = cp.spawnSync(process.execPath, ['-e', run, path.join(__dirname, '..', 'ytd.js'), fc, 'SYMPLAY0001'], { timeout: 4000, encoding: 'utf8' });
        assert.ok(!r2.error && r2.status === 0, r2.stderr);
        assert.deepStrictEqual(JSON.parse(r2.stdout), { title: 'SYMPLAY0001', chapters: null });
    });

    await t('WP2 a play from the start whose first tick is in a skipped segment: its first `time` is that tick, not the segment\'s end', async () => {
        if (!fs.existsSync(path.join(cache, 'WP2SKIP0001'))) mkVideo('WP2SKIP0001');
        fs.mkdirSync(path.join(cache, '.sb'), { recursive: true });
        fs.writeFileSync(path.join(cache, '.sb', 'WP2SKIP0001.json'), JSON.stringify([{ s: 0, e: 30000, cat: 'sponsor' }]));   // the SponsorBlock cache
        c.clear(); calls.length = 0;
        c.send({ cmd: 'play', id: 'WP2SKIP0001', rect: '1280x720', skip: ['sponsor'] });
        await c.waitFor((x) => x.ev === 'state' && x.state === 'playing');
        await waitUntil(() => d.cur && d.cur.segs && d.cur.segs.length === 1);
        subs.playerState('PLAYER_STATE_PLAY');
        tick(200);
        await c.waitFor((x) => x.ev === 'skipped');
        await waitUntil(() => called('setTime').length === 1);
        assert.deepStrictEqual(called('setTime')[0].a, { newTimeElapsed: 30000 });
        assert.deepStrictEqual(c.evs.filter((x) => x.ev === 'time').map((x) => x.elapsed), [200]);
        await idle();
    });

    // ---- WP4 health ----
    {
        const H = require('../health.js');
        const hdir = path.join(tmp, 'health'), hcache = path.join(hdir, 'cache'), hctl = path.join(hdir, 'check.ctl');
        [hdir, hcache].forEach((x) => fs.mkdirSync(x));
        const sh = (name, body) => { const f = path.join(hdir, name); fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); return f; };
        // mgu-python: --version, else the fake check (node); jap-node22: --version only
        const py = sh('python3', 'if [ "$1" = --version ]; then echo "Python 3.12.7"; exit 0; fi\nexec "' + process.execPath + '" "$@"');
        const node22 = sh('node22', 'echo v22.23.4');
        const lease = path.join(hdir, 'lease.json');
        fs.writeFileSync(lease, JSON.stringify({ dns: ['192.168.77.1', '8.8.8.8'], ip: '192.168.77.20' }));
        const kdir = path.join(hcache, 'KnownVid001');
        fs.mkdirSync(kdir);
        fs.writeFileSync(path.join(kdir, 'meta.json'), JSON.stringify({ id: 'KnownVid001', title: 'My Secret Holiday Video', channel: 'Private Channel Name', duration_s: 60 }));
        const hd = (o) => {
            const x = new Daemon(Object.assign({ someip: someip, srcGen: srcGen, cacheDir: hcache, logDir: hdir, stateDir: path.join(hdir, 'state'), etcDir: hdir,
                accountFile: path.join(hdir, 'account.json'), noSetuid: true, leaseFile: lease, sock: path.join(hdir, 'none.sock'),
                fetcher: [py, path.join(__dirname, 'fake_health.js'), hctl], thumbCmd: [node22, 'thumb.js'], log: () => {} }, o || {}));
            x.fetchUid = me;
            x.clockSaid = null;   // as after the app's hello
            x.audio.cc = { isAvailable: async () => true };
            return x;
        };
        const health = async (x) => { const evs = []; x.emit = (e) => evs.push(e); const t0 = Date.now(); await x.health(); evs.ms = Date.now() - t0; return evs; };
        const byKey = (evs) => { const m = {}; evs.filter((e) => e.key).forEach((e) => { m[e.key] = e; }); return m; };
        const NO = ['192.168.77', '8.8.8.8', '10.1.2.3', '81.82.83.84', 'aa:bb:cc', '2a02:1810', 'KnownVid001', 'My Secret Holiday', 'Private Channel'];
        const clean = (evs) => evs.forEach((e) => NO.forEach((x) => assert.ok(JSON.stringify(e).indexOf(x) < 0, x + ' in ' + JSON.stringify(e))));

        await t('health: every key once, as {ev, key, ok, text}, then done; check --json run as the fetch uid with the cache and the lease', async () => {
            fs.writeFileSync(hctl, 'ok');
            const x = hd();
            const evs = await health(x);
            assert.deepStrictEqual(evs[evs.length - 1], { ev: 'health', done: true });
            assert.strictEqual(evs.filter((e) => e.done).length, 1);
            const rows = evs.filter((e) => e.ev === 'health' && !e.done);
            assert.deepStrictEqual(rows.map((e) => e.key).sort(), H.KEYS.slice().sort(), 'each key once');
            rows.forEach((e) => assert.deepStrictEqual([Object.keys(e), typeof e.ok, typeof e.text], [['ev', 'key', 'ok', 'text'], 'boolean', 'string'], JSON.stringify(e)));
            const k = byKey(evs);
            assert.deepStrictEqual(H.KEYS.filter((n) => !k[n].ok), ['socket'], 'all well but the socket (no lock info yet): ' + JSON.stringify(rows));
            assert.strictEqual(k.service.text, 'jap-ridetube-d ' + VERSION);
            assert.strictEqual(k.node.text, 'Node ' + process.version + ' runs the service');
            assert.strictEqual(k.node22.text, 'jap-node22 v22.23.4');
            assert.strictEqual(k.python.text, 'mgu-python: Python 3.12.7');
            assert.strictEqual(k.ytdlp.text, 'yt-dlp 2026.10.26 (bundled)');
            assert.strictEqual(k.uid.text, 'internet uid ' + me);
            assert.strictEqual(k.lease.text, 'uplink lease, 2 DNS servers');
            assert.strictEqual(k.dns.text, 'youtube.com resolves through the uplink DNS');
            assert.strictEqual(k.tls.text, 'TLS to youtube.com works');
            assert.ok(/^\d+ MiB free for videos \(a video needs 256 MiB left\)$/.test(k.free.text), k.free.text);
            assert.strictEqual(k.audio.text, 'BMW audio service reachable');
            assert.strictEqual(k.socket.text, 'control socket: lock state unknown');
            const run = JSON.parse(fs.readFileSync(hctl + '.log', 'utf8'));
            assert.deepStrictEqual(run.argv, ['check', '--json', '--cache-dir', hcache, '--lease', lease]);
            clean(evs);
            // The clock warning does not change the TLS check.
            const wx = hd({ now: () => Date.parse('2026-10-13T08:00:00Z') });
            const tls = byKey(await health(wx)).tls;
            assert.deepStrictEqual(tls, { ev: 'health', key: 'tls', ok: true, text: 'TLS to youtube.com works' });
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(hctl + '.log', 'utf8')).argv, ['check', '--json', '--cache-dir', hcache, '--lease', lease]);
            fs.writeFileSync(hctl, 'expired');   // a clock ahead (expired certificates): no skip, the clock named
            assert.strictEqual(byKey(await health(hd())).tls.text, 'no TLS to youtube.com: wrong clock: 2030-01-01');
            fs.writeFileSync(hctl, 'ok');
            x.sockUid = 23457;
            assert.deepStrictEqual(byKey(await health(x)).socket, { ev: 'health', key: 'socket', ok: true, text: 'control socket: the RideTube app only' });
            x.sockUid = 0;
            assert.deepStrictEqual(byKey(await health(x)).socket, { ev: 'health', key: 'socket', ok: true, text: 'control socket: root only' });
            x.sockUid = null;
            assert.deepStrictEqual(byKey(await health(x)).socket, { ev: 'health', key: 'socket', ok: false, text: 'control socket: shared with other apps' });
        });

        await t('health over the socket: {"cmd":"health"} streams the lines, then done; caps say health', async () => {
            fs.writeFileSync(hctl, 'ok');
            const keep = d.opts.fetcher;
            d.opts.fetcher = [process.execPath, path.join(__dirname, 'fake_health.js'), hctl];
            c.clear();
            c.send({ cmd: 'hello', app: '0.4.0' });
            assert.ok((await c.waitFor((e) => e.ev === 'hello')).caps.indexOf('health') >= 0);
            c.send({ cmd: 'health' });
            await c.waitFor((e) => e.ev === 'health' && e.done, 9000);
            assert.deepStrictEqual(c.evs.filter((e) => e.ev === 'health' && e.key).map((e) => e.key).sort(), H.KEYS.slice().sort());
            d.opts.fetcher = keep;
            const k = byKey(c.evs);
            assert.deepStrictEqual([k.audio.ok, k.dns.ok, k.tls.ok, k.ytdlp.ok], [true, true, true, true], 'the running daemon\'s SOME/IP proxy, the fetcher\'s keys');
        });

        await t('health offline: no lease, DNS fails, TLS skipped -> ok:false with a readable text; the rest still answer', async () => {
            fs.writeFileSync(hctl, 'offline');
            const k = byKey(await health(hd({ leaseFile: path.join(hdir, 'no-lease.json') })));
            assert.deepStrictEqual([k.lease.ok, k.lease.text], [false, 'no uplink lease: the uplink is down or not installed']);
            assert.deepStrictEqual([k.dns.ok, k.dns.text], [false, 'DNS for youtube.com: name not resolved']);
            assert.deepStrictEqual([k.tls.ok, k.tls.text], [false, 'no TLS to youtube.com: skipped: no DNS']);
            assert.ok(k.ytdlp.ok && k.service.ok && k.audio.ok && k.node22.ok);
        });

        await t('health: no internet uid -> uid and the three fetcher keys say so; nothing missing (python, node22) never throws', async () => {
            const x = hd({ noSetuid: false, mainapps: [], fetcher: [path.join(hdir, 'no-python'), 'ytfetch.py'], thumbCmd: [path.join(hdir, 'no-node22')] });
            x.fetchUid = null;
            x.audio.cc = null;
            const evs = await health(x), k = byKey(evs);
            assert.strictEqual(evs.filter((e) => e.key).length, H.KEYS.length);
            assert.deepStrictEqual([k.uid.ok, k.uid.text], [false, 'no internet uid on the car (see the log)']);
            ['ytdlp', 'dns', 'tls'].forEach((n) => assert.deepStrictEqual([k[n].ok, k[n].text], [false, 'not checked: no internet uid on the car (see the log)'], n));
            assert.deepStrictEqual([k.python.text, k.node22.text, k.audio.text], ['mgu-python not installed', 'jap-node22 not installed', 'BMW audio service not connected yet']);
            x.opts.noSetuid = true; x.fetchUid = me;   // a spawn that fails (ENOENT) rather than throws
            assert.strictEqual(byKey(await health(x)).dns.text, 'not checked: mgu-python is not installed');
        });

        await t('health: a hanging check and a hanging audio service time out without holding the others; the child is killed', async () => {
            fs.writeFileSync(hctl, 'hang');
            const x = hd({ healthMs: 700 });
            x.audio.cc = { isAvailable: () => new Promise(() => {}) };
            const evs = await health(x), k = byKey(evs);
            assert.ok(evs.ms < 700 + 600, 'done in ' + evs.ms + ' ms');
            assert.strictEqual(evs.filter((e) => e.key).length, H.KEYS.length);
            assert.deepStrictEqual([k.ytdlp.ok, k.ytdlp.text], [true, 'yt-dlp 2026.10.26 (bundled)'], 'what it said before it hung is kept');
            assert.deepStrictEqual([k.dns.ok, k.dns.text, k.tls.text], [false, 'not checked: no answer in 0.7 s', 'not checked: no answer in 0.7 s']);
            assert.deepStrictEqual([k.audio.ok, k.audio.text], [false, 'BMW audio service: no answer in 0.7 s']);
            assert.ok(k.service.ok && k.node22.ok && k.python.ok && k.lease.ok && k.free.ok, 'the local keys answered');
            const pid = JSON.parse(fs.readFileSync(hctl + '.log', 'utf8')).pid;
            await waitUntil(() => { try { process.kill(pid, 0); return false; } catch (e) { return true; } }, 2000);
        });

        await t('health: what the fetch uid prints is not trusted: unknown names dropped, ok only when true, no address / id / title / newline, capped', async () => {
            fs.writeFileSync(hctl, 'hostile');
            const evs = await health(hd()), k = byKey(evs);
            assert.ok(!evs.some((e) => e.key === 'evil'));
            assert.deepStrictEqual([k.ytdlp.ok, k.ytdlp.text], [false, 'yt-dlp does not load: loaded'], 'a version that is not one');
            assert.strictEqual(k.dns.ok, false, 'ok "yes" is not true');
            assert.deepStrictEqual([k.dns.text, k.tls.text], ['DNS for youtube.com: failed', 'no TLS to youtube.com: failed'], 'only ytfetch\'s own phrases are shown');
            assert.ok(evs.every((e) => !/[\n\r]/.test(e.text || '') && (e.text || '').length <= 120));
            clean(evs);
        });

        await t('health: a check that dies without "done" -> its missing keys say it stopped; its stderr goes to the log, not the screen', async () => {
            fs.writeFileSync(hctl, 'crash');
            const lg = [], x = hd({ log: (m) => lg.push(m) });
            const evs = await health(x), k = byKey(evs);
            assert.deepStrictEqual([k.ytdlp.ok, k.dns.text, k.tls.text], [true, 'not checked: ytfetch.py check stopped (exit 1)', 'not checked: ytfetch.py check stopped (exit 1)']);
            assert.ok(lg.indexOf('health: ytfetch.py check: OSError: [ip] KnownVid001 gone') >= 0, lg.join('\n'));
            clean(evs);
        });

        await t('health in send_logs: the block ends the report\'s log, every key, through redactLog; no health event reaches the app', async () => {
            fs.writeFileSync(hctl, 'hostile');
            let body = null;
            const x = hd({ reportUrl: 'https://example.test', ytRequest: async (m, u, h, b) => { body = b; return { status: 200, body: JSON.stringify({ id: 'ABC123' }) }; } });
            const evs = [];
            x.emit = (e) => evs.push(e);
            x.log('ytfetch: fetch KnownVid001 done');
            await x.sendLogs('0.4.0');
            assert.deepStrictEqual(evs, [{ ev: 'logs_sent', id: 'ABC123' }]);
            const ls = body.log.split('\n'), at = ls.indexOf('--- health');
            assert.ok(at > 0, 'a health block');
            assert.deepStrictEqual(ls.slice(at + 1).map((l) => l.split(' ')[1]), H.KEYS, 'each key, in order, last in the log');
            assert.ok(ls[at + 1] === 'health service ok jap-ridetube-d ' + VERSION, ls[at + 1]);
            assert.strictEqual(ls[at + 8], 'health dns FAIL DNS for youtube.com: failed');
            NO.forEach((s) => assert.ok(body.log.indexOf(s) < 0, s + ' in the report'));
            const b = x.report('0.4.0', [{ key: 'tls', ok: false, text: 'via 81.82.83.84 to KnownVid001' }]);
            assert.ok(/--- health\nhealth tls FAIL via \[ip\] to v#[0-9a-f]{4}$/.test(b.log), b.log.slice(-80));
            assert.ok(!/--- health/.test(x.report('0.4.0').log), 'no block without lines');
        });

        await t('health.clean: one short printable line, addresses masked, versions and words kept', async () => {
            assert.strictEqual(H.clean('a\n\tb  192.168.1.1 fe80::1:2 AA-BB-CC-DD-EE-FF v22.23.4 2026.10.26 12:34:56 é'), 'a b [ip] [ip] [mac] v22.23.4 2026.10.26 12:34:56');
            assert.strictEqual(H.clean('x'.repeat(300)).length, 120);
        });
    }

    // ---- 2021 firmware: where the two SOME/IP descriptions come from (Audio.descriptions) ----
    {
        const H = require('../health.js');
        const sdir = path.join(tmp, 'someip'), mainapp = path.join(sdir, 'oap-mainapp'), sg = path.join(mainapp, 'src-gen');
        fs.mkdirSync(sg, { recursive: true });
        fs.writeFileSync(path.join(mainapp, 'package.json'), JSON.stringify({ name: 'oap-mainapp', version: '8.3.2-pr-847.1' }));
        fs.writeFileSync(path.join(sdir, 'os-release'), 'NAME="BMW MGU"\nVERSION="I_21w12.2-1-4"\nID="mgu"\n');
        const CC = 'org.genivi.am.commandinterface.CommandControl', MP = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';
        const names = (l) => l.reduce((o, n) => { o[n] = {}; return o; }, {});
        // a synthetic catalog (names and ids only); mp: MediaPlayer's instances, or no MediaPlayer at all
        const catalog = (name, mp) => {
            const c = { version: '0.1.0', interfaces: {}, instanceIDs: {} };
            c.interfaces[CC] = { name: 'CommandControl', serviceId: 45088, version: { major: 1, minor: 1 },
                methods: names(['connect', 'disconnect', 'setSinkMuteState']), fields: names(['listOfMainConnections']), events: {} };
            c.instanceIDs[CC] = { 1: 1 };
            if (mp) {
                c.interfaces[MP] = { name: 'MediaPlayer', serviceId: 45122, version: { major: 2, minor: 0 },
                    methods: names(['sendButtonEvent', 'playFile', 'setTime']), fields: names(['playerState', 'currentItemTime']), events: names(['playbackErrorEvent']) };
                c.instanceIDs[MP] = mp;
            }
            const f = path.join(sdir, name + '.json');
            fs.writeFileSync(f, JSON.stringify(c));
            return f;
        };
        // a stub of the firmware's generator in a bundle shaped like AppManagement.js (gen.js loads IFConfigGenerator out of
        // it): each proxy of the manifest -> the catalog's members, and the proxy it was asked for (stub)
        const bundle = path.join(sdir, 'AppManagement.js');
        fs.writeFileSync(bundle, '(function (mods) { var cache = {}; function req(id) { if (!cache[id]) { var m = cache[id] = { exports: {} };' +
            ' mods[id][0](function (n) { return req(mods[id][1][n]); }, m, m.exports); } return cache[id].exports; } return req; })({' +
            '1: [function (require, module) { module.exports = require("someip-interfaces-generator/IFConfigGenerator"); }, {"someip-interfaces-generator/IFConfigGenerator":2}],' +
            '2: [function (require, module) { module.exports = { generate: function (db, manifest) { var out = {}; Object.keys(manifest.proxies).forEach(function (n) {' +
            ' var i = db.interfaces[n]; out[n] = { name: i.name, serviceId: i.serviceId, version: i.version, instances: db.instanceIDs[n], methods: i.methods,' +
            ' fields: i.fields, events: i.events, eventGroups: {}, stub: manifest.proxies[n] }; }); return out; } }; }, {}]},{},[1])\n');
        let built = [];
        const rec = { buildProxy: async (cfg, inst) => { built.push([cfg, inst]); return { init: async () => {}, subscribe: () => {}, isAvailable: async () => true, getValue: async () => [] }; } };
        let n = 0;
        const audio = (o) => {
            const logs = [];
            const a = new Audio(Object.assign({ someip: rec, srcGen: sg, catalog: path.join(sdir, 'none.json'), appMgmt: bundle,
                oapgen: path.join(__dirname, '..', '..', '..', 'kit', 'tools', 'oapgen', 'gen.js'), someipGenCmd: [process.execPath, path.join(__dirname, '..', 'ytd.js'), '--someip-gen'],
                stateDir: path.join(sdir, 'state' + (++n)), etcDir: sdir, log: (m) => logs.push(m) }, o || {}), {});
            a.logs = logs;
            built = [];
            return a;
        };
        const ccFile = path.join(sg, CC.replace(/\./g, '_') + '.json'), mpFile = path.join(sg, MP.replace(/\./g, '_') + '.json');

        await t('someip: MainApp\'s src-gen there -> used as is, the catalog not read (no generator run)', async () => {
            fs.writeFileSync(ccFile, JSON.stringify({ name: 'CommandControl', mine: 1 }));
            fs.writeFileSync(mpFile, JSON.stringify({ name: 'MediaPlayer', mine: 2 }));
            const a = audio({ catalog: catalog('full', { OapGenericMedia: 40 }) });
            await a.init();
            assert.deepStrictEqual(built.map((b) => [b[0].mine, b[1]]), [[1, '1'], [2, 'OapGenericMedia']]);
            assert.deepStrictEqual(a.from, { CommandControl: 'MainApp', MediaPlayer: 'MainApp' });
            assert.deepStrictEqual(a.logs, ['someip: CommandControl from MainApp', 'someip: MediaPlayer from MainApp', 'someip: MainApp v8.3.2-pr-847.1, catalog present, not needed',
                'someip: in use CommandControl ? v? 1=none, lacks instance 1 connect disconnect listOfMainConnections',
                'someip: in use MediaPlayer ? v? OapGenericMedia=none, lacks instance OapGenericMedia sendButtonEvent playFile setTime playerState currentItemTime playbackErrorEvent'],
                'a src-gen file is used unchecked; the report says what it lacks');
            assert.ok(!fs.existsSync(path.join(a.opts.stateDir, 'someip.json')), 'no generator run');
            [ccFile, mpFile].forEach((f) => fs.unlinkSync(f));
        });
        await t('someip: no src-gen, a catalog -> made by the generator from it (manifest: our members, MediaPlayer *), once, root-only', async () => {
            const a = audio({ catalog: catalog('full', { OapGenericMedia: 40, BrowserMedia: 60 }) });
            await a.init();
            await a.descriptions();
            assert.deepStrictEqual(built.map((b) => [b[0].serviceId, b[0].stub, b[1]]), [
                [45088, { instances: '1', attributes: { listOfMainConnections: 'rs' }, methods: ['connect', 'disconnect'] }, '1'], [45122, '*', 'OapGenericMedia']]);
            assert.deepStrictEqual(a.from, { CommandControl: 'catalog', MediaPlayer: 'catalog' });
            assert.deepStrictEqual(a.logs, ['someip: CommandControl from catalog', 'someip: MediaPlayer from catalog', 'someip: MainApp v8.3.2-pr-847.1, catalog db v0.1.0',
                'someip: catalog CommandControl 0xB020 v1.1 instances 1=1', 'someip: catalog MediaPlayer 0xB042 v2.0 instances OapGenericMedia=40 BrowserMedia=60',
                'someip: in use CommandControl 0xB020 v1.1 1=1', 'someip: in use MediaPlayer 0xB042 v2.0 OapGenericMedia=40']);
            assert.strictEqual(fs.statSync(path.join(a.opts.stateDir, 'someip.json')).mode & 0o777, 0o600);
            assert.strictEqual(fs.statSync(a.opts.stateDir).mode & 0o777, 0o700);
            assert.strictEqual(a.sources(), 'CommandControl from catalog, MediaPlayer from catalog; MainApp v8.3.2-pr-847.1');
        });
        await t('someip: the catalog lacks a service or our instance -> that one built-in, said in the diagnostics', async () => {
            const a = audio({ catalog: catalog('noinst', { BrowserMedia: 60 }) });
            await a.init();
            assert.deepStrictEqual(a.from, { CommandControl: 'catalog', MediaPlayer: 'built-in' });
            assert.strictEqual(built[1][0].instances.OapGenericMedia, 40);
            assert.strictEqual(a.logs[4], 'someip: catalog MediaPlayer 0xB042 v2.0 instances BrowserMedia=60');
            const b = audio({ catalog: catalog('nomp', null) });
            await b.descriptions();
            assert.deepStrictEqual(b.from, { CommandControl: 'catalog', MediaPlayer: 'built-in' });
            assert.strictEqual(b.logs[4], 'someip: catalog MediaPlayer none with service id 0xB042');
            const c = audio({ catalog: catalog('full', { OapGenericMedia: 40 }), appMgmt: path.join(sdir, 'no-bundle.js') });
            await c.descriptions();
            assert.deepStrictEqual(c.from, { CommandControl: 'built-in', MediaPlayer: 'built-in' }, 'the generator failing');
            assert.ok(/^someip: MainApp v8\.3\.2-pr-847\.1, catalog db v0\.1\.0, ENOENT/.test(c.logs[2]), c.logs[2]);
        });
        await t('someip: neither src-gen nor catalog -> both built-in (our unit\'s ids and versions)', async () => {
            const a = audio();
            await a.init();
            assert.deepStrictEqual(a.from, { CommandControl: 'built-in', MediaPlayer: 'built-in' });
            const [cc, mp] = built.map((b) => b[0]);
            assert.deepStrictEqual([cc.serviceId, cc.version, cc.instances, cc.methods.connect.id, cc.methods.disconnect.id, cc.fields.listOfMainConnections.getter.id],
                [0xB020, { major: 1, minor: 1 }, { 1: 1 }, 1, 2, 22]);
            assert.deepStrictEqual([mp.serviceId, mp.version, mp.instances, mp.methods.playFile.id, mp.fields.currentItemTime.event.id, mp.events.playbackErrorEvent.groups],
                [0xB042, { major: 2, minor: 0 }, { OapGenericMedia: 40 }, 258, 32783, [101]]);
            assert.strictEqual(cc.methods.connect.retSchema.e[1].e.E_ALREADY_EXISTS, 5);
            assert.strictEqual(a.logs[2], 'someip: MainApp v8.3.2-pr-847.1, catalog missing');
        });
        await t('someip: all three fail -> "this car\'s software ... does not offer" logged once over retries, in health and the report; ready when it comes', async () => {
            let up = false;
            const off = { buildProxy: async () => ({ init: async () => {}, subscribe: () => {}, isAvailable: async () => up, getValue: async () => [] }) };
            const logs = [], xdir = path.join(sdir, 'd1');
            fs.mkdirSync(path.join(xdir, 'cache'), { recursive: true });
            const x = new Daemon({ someip: off, srcGen: sg, catalog: path.join(sdir, 'none.json'), etcDir: sdir, availWaitMs: 30, someipRetryMs: 10,
                cacheDir: path.join(xdir, 'cache'), logDir: xdir, stateDir: path.join(xdir, 'state'), accountFile: path.join(xdir, 'account.json'),
                sock: path.join(tmp, 'someip.sock'), noSetuid: true, spare: false, ytRequest: fakeYt, healthMs: 1500, log: (m) => logs.push(m) });
            x.start();
            const SAY = 'This car\'s software (I_21w12.2-1-4) does not offer the audio connection RideTube uses';
            await waitUntil(() => x.audio.unsupported === SAY, 2000);
            await sleep(400);   // ~10 more tries
            assert.deepStrictEqual(logs.filter((l) => /someip not ready/.test(l)), ['someip not ready: ' + SAY + ' (CommandControl not available)']);
            const k = {};
            (await H.run(x, VERSION)).forEach((h) => { k[h.key] = h; });
            assert.deepStrictEqual([k.audio.ok, k.audio.text], [false, SAY]);
            assert.ok(/--- someip\nsomeip: CommandControl from built-in\nsomeip: MediaPlayer from built-in\nsomeip: MainApp v8\.3\.2-pr-847\.1, catalog missing\n(someip: in use .*\n){2}--- health/.test(x.report('0.4.0', [{ key: 'audio', ok: false, text: SAY }]).log));
            up = true;
            await waitUntil(() => logs.indexOf('someip ready') >= 0, 2000);
            assert.strictEqual(x.audio.unsupported, null);
            await x.close();
        });
        await t('someip: the report carries the diagnostics block whole through redactLog; the health audio row says the sources', async () => {
            const logs = [], xdir = path.join(sdir, 'd2');
            fs.mkdirSync(path.join(xdir, 'cache'), { recursive: true });
            const x = new Daemon({ someip: rec, srcGen: sg, catalog: catalog('noinst', { BrowserMedia: 60, 'ExternalDeviceUsbFrontAInstanceRearL': 11 }), appMgmt: bundle,
                oapgen: path.join(__dirname, '..', '..', '..', 'kit', 'tools', 'oapgen', 'gen.js'), etcDir: sdir,
                cacheDir: path.join(xdir, 'cache'), logDir: xdir, stateDir: path.join(xdir, 'state'), accountFile: path.join(xdir, 'account.json'),
                sock: path.join(tmp, 'someip2.sock'), noSetuid: true, spare: false, ytRequest: fakeYt, healthMs: 1500, log: (m) => logs.push(m) });
            await x.audio.init();
            const block = ['--- someip', 'someip: CommandControl from catalog', 'someip: MediaPlayer from built-in', 'someip: MainApp v8.3.2-pr-847.1, catalog db v0.1.0',
                'someip: catalog CommandControl 0xB020 v1.1 instances 1=1', 'someip: catalog MediaPlayer 0xB042 v2.0 instances BrowserMedia=60 ExternalDeviceUsbFrontAInstanceRearL=11',
                'someip: in use CommandControl 0xB020 v1.1 1=1', 'someip: in use MediaPlayer 0xB042 v2.0 OapGenericMedia=40'];
            const ls = x.report('0.4.0').log.split('\n'), at = ls.indexOf('--- someip');
            assert.deepStrictEqual(ls.slice(at, at + block.length), block);
            assert.strictEqual(ls.length, at + block.length, 'last without a health block');
            const k = {};
            (await H.run(x, VERSION)).forEach((h) => { k[h.key] = h; });
            assert.deepStrictEqual([k.audio.ok, k.audio.text], [true, 'BMW audio service reachable; CommandControl from catalog, MediaPlayer from built-in; MainApp v8.3.2-pr-847.1']);
            await x.close();
        });
    }

    c.destroy();
    await d.close();
    console.log(results.join('\n'));
    const failed = results.filter((r) => r.indexOf('FAIL') === 0).length;
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
