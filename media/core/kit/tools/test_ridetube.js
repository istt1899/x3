'use strict';

// RideTube (apps/jap_ridetube): the control-socket client and the playback state against a fake jap-ridetube-d daemon on a
// temporary Unix socket; then, when dist/jap_ridetube is built, one results and one player frame through the stubbed
// head unit into a renderer stream (pictures as message 10, the video as 13 + op 19), the feed tabs, the sign-in
// page and signing out; where the kit runs the screen: the rail and the bar, Home's shelves (arrows, the controller
// bringing any tile into view, thumbs asked for the drawn tiles only, the picture pool). No SDK or car needed:
//   node kit/tools/test_ridetube.js

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Ctl, Model, clock } = require('../../apps/jap_ridetube/yt');

const quiet = { info() {}, warn() {}, error(m, e) { throw e || new Error(m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
    const end = Date.now() + (ms || 3000);
    while (!fn()) { if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(10); }
}

// the daemon got obj as its last command (the socket delivers a moment later)
async function lastIs(d, obj, msg) {
    try { await until(() => JSON.stringify(d.got.filter((m) => m.cmd === obj.cmd).slice(-1)[0]) === JSON.stringify(obj), 2000, msg); } catch (e) {
        assert.deepStrictEqual(d.got.filter((m) => m.cmd === obj.cmd).slice(-1)[0], obj, msg);
    }
}

function fakeDaemon(sock) {
    const d = { got: [], conn: null, conns: 0 };
    d.server = net.createServer((c) => {
        d.conn = c; d.conns++;
        let buf = '';
        c.setEncoding('utf8');
        c.on('data', (x) => {
            buf += x;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { d.got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
        });
        c.on('error', () => {});
    });
    d.send = (o) => d.conn.write(JSON.stringify(o) + '\n');
    d.cmds = (cmd) => d.got.filter((m) => m.cmd === cmd);
    return new Promise((r) => d.server.listen(sock, () => r(d)));
}

// Windows Node cannot bind a Unix socket path; use a private named pipe there.
function socketPath(dir) {
    return process.platform === 'win32' ? '\\\\.\\pipe\\ridetube-' + path.basename(dir) : path.join(dir, 'ctl.sock');
}

async function clientAndModel() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'));
    const sock = socketPath(dir);
    const d = await fakeDaemon(sock);
    const ctl = new Ctl(sock, quiet);
    const m = new Model((o) => ctl.send(o));
    ctl.on('up', () => m.setConnected(true)).on('down', () => m.setConnected(false)).on('msg', (x) => m.onMsg(x));
    ctl.connect();
    await until(() => d.cmds('status').length, 2000, 'status on connect');
    assert.ok(m.connected, 'connected');
    await until(() => d.cmds('auth_status').length, 2000, 'auth_status on connect');
    assert.deepStrictEqual(d.got.slice(1, 3), [{ cmd: 'status' }, { cmd: 'auth_status' }], 'on connect: status, then the account (no library: nothing is kept on the car)');
    assert.strictEqual(d.got[0].cmd, 'hello', 'hello first: the service skips no certificate date before the app can warn');

    // first results: no thumb asked on its own (the screens ask for the tiles they draw: wantThumb), each asked once
    assert.ok(m.search('first'));
    d.send({ ev: 'results', q: 'first', items: [{ id: 'lib1', title: 'First' }, { bad: 1 }] });
    await until(() => m.results.length === 1, 2000, 'first results (the bad item dropped)');
    await sleep(50);
    assert.strictEqual(d.cmds('thumb').length, 0, 'no thumb asked before a screen draws one');
    assert.ok(m.wantThumb('lib1') && !m.wantThumb('lib1') && !m.wantThumb('nope'), 'asked once; an unknown id never');
    await lastIs(d, { cmd: 'thumb', id: 'lib1' });
    d.send({ ev: 'thumb', id: 'lib1', w: 160, h: 90, rgba: Buffer.alloc(57600, 9).toString('base64') });
    await until(() => m.thumbs.lib1, 2000, 'thumb stored');
    assert.deepStrictEqual([m.thumbs.lib1.w, m.thumbs.lib1.h, m.thumbs.lib1.buf.length, m.pending.size], [160, 90, 57600, 0], '160x90 kept, no longer pending');
    assert.ok(!m.wantThumb('lib1'), 'held: not asked again');
    d.got.length = 0;

    // proxy offline: the daemon's error ends the search
    assert.ok(m.search('offline test'));
    d.send({ ev: 'error', msg: 'search offline' });
    await until(() => !m.searching, 2000, 'offline error');
    assert.strictEqual(m.searchError, 'search offline', 'the daemon text shown on the search screen');
    // no answer at all: the app gives up on its own
    m.search('silent');
    assert.ok(m.searching && !m.checkSearch(Date.now(), 8000), 'still waiting at first');
    assert.ok(m.checkSearch(Date.now() + 9000, 8000) && !m.searching && /No answer/.test(m.searchError), 'no answer in 8 s: an error');
    d.got.length = 0;

    // search -> results (thumbs asked by the screen, see wantThumb)
    assert.ok(m.search('  cats  '));
    await lastIs(d, { cmd: 'search', q: 'cats' }, 'trimmed query');
    assert.ok(m.searching);
    d.send({ ev: 'results', q: 'dogs', items: [{ id: 'zzz' }] });
    await sleep(50);
    assert.ok(!m.results.some((r) => r.id === 'zzz'), "an older search's results are ignored");
    const items = [{ id: 'aaa', title: 'Cat video', channel: 'Cats', duration_s: 83 }, { id: 'bbb', title: 'More cats', channel: 'C', duration_s: 3723 }, { title: 'no id' }];
    d.send({ ev: 'results', q: 'cats', items });
    await until(() => m.results.length === 2, 2000, 'results');
    assert.strictEqual(m.searchError, null, 'results clear the last search error');
    assert.ok(!m.searching && m.results.length === 2);
    assert.ok(m.wantThumb('aaa') && m.wantThumb('bbb'));
    await until(() => d.cmds('thumb').length === 2, 2000, 'thumb requests');
    // a thumb: 160x90 (0.1.5 daemon, a line of 76.8 kB) or 320x180 (0.1.6, 307 kB) RGBA base64; anything else dropped
    d.send({ ev: 'thumb', id: 'aaa', w: 160, h: 90, rgba: Buffer.alloc(160 * 90 * 4, 200).toString('base64') });
    d.send({ ev: 'thumb', id: 'bbb', w: 160, h: 90, rgba: Buffer.alloc(10).toString('base64') });
    d.send({ ev: 'thumb', id: 'bbb', w: 200, h: 72, rgba: Buffer.alloc(57600).toString('base64') });
    d.send({ ev: 'thumb', id: 'nope', w: 160, h: 90, rgba: Buffer.alloc(160 * 90 * 4).toString('base64') });
    await until(() => m.thumbs.aaa, 2000, 'thumb');
    await sleep(30);
    assert.strictEqual(m.thumbs.aaa.buf.length, 57600);
    assert.ok(!m.thumbs.bbb && !m.thumbs.nope, 'wrong size or unknown id dropped');
    assert.ok(!m.wantThumb('bbb'), 'a bad thumb is not asked again in a loop');
    d.send({ ev: 'thumb', id: 'bbb', w: 320, h: 180, rgba: Buffer.alloc(320 * 180 * 4, 7).toString('base64') });
    await until(() => m.thumbs.bbb, 2000, '320x180 thumb');
    assert.deepStrictEqual([m.thumbs.bbb.w, m.thumbs.bbb.h, m.pending.size], [320, 180, 0], '320x180 kept');

    // play -> preparing -> playing; buttons
    m.play('aaa', '1836x504', false);
    await lastIs(d, { cmd: 'play', id: 'aaa', rect: '1836x504', fill: false });
    assert.strictEqual(m.state, 'preparing');
    assert.ok(m.active(), 'preparing holds the app active');
    assert.strictEqual(m.toggle(), false, 'no pause while preparing');
    d.send({ ev: 'state', state: 'preparing', pct: 42, id: 'aaa', title: 'Cat video' });
    await until(() => m.pct === 42, 2000, 'pct');
    m.setWantVideo(true);
    await lastIs(d, { cmd: 'video', on: true }, 'player shown, parked: video on');
    const nVideo = d.cmds('video').length;
    d.send({ ev: 'state', state: 'playing', pct: 100, id: 'aaa', title: 'Cat video' });
    d.send({ ev: 'time', elapsed: 5000, total: 60000 });
    await until(() => m.elapsed === 5000, 2000, 'time');
    await until(() => d.cmds('video').length > nVideo, 2000, 'video again');
    assert.deepStrictEqual(d.cmds('video').slice(nVideo), [{ cmd: 'video', on: true }], 'playback start: video state told again');
    m.toggle();
    await lastIs(d, { cmd: 'pause' });
    d.send({ ev: 'state', state: 'paused', id: 'aaa', title: 'Cat video' });
    await until(() => m.state === 'paused', 2000, 'paused');
    m.toggle();
    await lastIs(d, { cmd: 'resume' });
    m.skip(-10000);
    await lastIs(d, { cmd: 'seek', ms: 0 }, '-10 s clamps at 0');
    m.elapsed = 55000; m.skip(10000);
    await lastIs(d, { cmd: 'seek', ms: 59000 }, '+10 s clamps 1 s before the end');
    m.setWantVideo(false);
    await lastIs(d, { cmd: 'video', on: false }, 'driving or hidden: video off');
    await sleep(50);
    const n = d.got.length;
    m.setWantVideo(false);
    await sleep(50);
    assert.strictEqual(d.got.length, n, 'no repeat while unchanged');
    d.send({ ev: 'error', msg: 'proxy down' });
    await until(() => m.error === 'proxy down', 2000, 'error');
    d.send({ ev: 'state', state: 'idle' });
    await until(() => m.state === 'idle', 2000, 'idle');
    assert.ok(!m.active() && m.error === null && m.elapsed === 0);
    assert.strictEqual(m.stop(), false, 'nothing to stop');

    // the account: a code asked once, signed in, a feed (at most 100, thumbs asked), no answer, signed out
    d.got.length = 0;
    assert.strictEqual(m.authStart(), false, 'no code asked before the daemon said signed out');
    d.send({ ev: 'auth', state: 'signed_out' });
    await until(() => m.auth.state === 'signed_out', 2000, 'signed out');
    assert.ok(m.authStart() && m.auth.state === 'asking' && !m.authStart(), 'asked once');
    await lastIs(d, { cmd: 'auth' });
    d.send({ ev: 'error', msg: 'internal error: sign-in failed' });
    await until(() => m.auth.state === 'error', 2000, 'daemon error must end sign-in wait');
    assert.ok(m.authStart(true), 'can retry after a daemon error');
    assert.ok(m.checkAuth(m.authT + 90000, 90000) && m.auth.state === 'error', 'missing sign-in answer has a deadline');
    assert.ok(m.authStart(true), 'can retry after the deadline');
    d.send({ ev: 'auth', state: 'code', code: 'ABC-DEF-GHIJ', url: 'https://www.google.com/device', expires: 1800 });
    await until(() => m.auth.code === 'ABC-DEF-GHIJ', 2000, 'code');
    assert.strictEqual(m.feed('home'), false, 'no feed while signed out');
    d.send({ ev: 'auth', state: 'error', msg: 'timeout' });
    await until(() => m.auth.state === 'error', 2000, 'auth error');
    assert.ok(!m.authStart() && m.authStart(true), 'after an error only a retry asks again');
    d.send({ ev: 'auth', state: 'signed_in' });
    await until(() => m.auth.state === 'signed_in', 2000, 'signed in');
    d.got.length = 0;
    assert.ok(m.feed('subs') && !m.feed('subs') && m.feeds.subs.loading, 'one feed request at a time');
    await lastIs(d, { cmd: 'feed', which: 'subs' });
    const many = Array.from({ length: 105 }, (_, i) => ({ id: 'sub' + i, title: 'Sub ' + i, channel: 'C', duration_s: 60, meta: ['1K views', '2 days ago'] }));
    d.send({ ev: 'feed', which: 'subs', items: many.concat([{ bad: 1 }]) });
    await until(() => m.feeds.subs.items.length, 2000, 'feed');
    assert.ok(m.feeds.subs.items.length === 100 && !m.feeds.subs.loading && m.feeds.subs.error === null, 'at most 100');
    assert.strictEqual(m.feeds.subs.shelves, null, 'no shelves (an older daemon): none');
    assert.deepStrictEqual(m.feeds.subs.items[0].meta, ['1K views', '2 days ago'], 'meta kept');
    await sleep(30);
    assert.strictEqual(d.cmds('thumb').length, 0, 'a feed asks no thumbs on its own');
    // shelves: at most 8 of at most 12 videos, empty ones dropped, [] = none; their videos are known (thumbs, titles)
    const shelf = (k, n) => ({ title: 'Shelf ' + k, items: Array.from({ length: n }, (_, i) => ({ id: 's' + k + '_' + i, title: 'T' + k + '.' + i })) });
    d.send({ ev: 'feed', which: 'subs', items: many, shelves: [shelf(0, 15), { title: 'empty', items: [] }, 'bad'].concat(Array.from({ length: 9 }, (_, k) => shelf(k + 1, 3))) });
    await until(() => m.feeds.subs.shelves, 2000, 'shelves');
    assert.deepStrictEqual(m.feeds.subs.shelves.map((x) => x.items.length), [12, 3, 3, 3, 3, 3, 3, 3], 'shelves capped');
    assert.strictEqual(m.feeds.subs.shelves[0].title, 'Shelf 0');
    assert.ok(m.item('s1_2') && m.item('s1_2').title === 'T1.2' && m.wantThumb('s1_2'), 'a shelf video is known');
    d.send({ ev: 'feed', which: 'subs', items: many, shelves: [] });
    await until(() => m.feeds.subs.shelves === null, 2000, 'shelves [] = none');
    assert.ok(!m.pending.has('s1_2'), 'its video gone: no longer pending');
    d.send({ ev: 'thumb', id: 'sub3', w: 160, h: 90, rgba: Buffer.alloc(57600, 1).toString('base64') });
    await until(() => m.thumbs.sub3, 2000, 'feed thumb kept');
    m.play('sub3', '1280x720', false);
    assert.strictEqual(m.title, 'Sub 3', 'a feed item plays with its title');
    // the tile tapped: its title and channel, kept while the daemon says only the id; its own title then wins
    m.play('zzz', '1280x720', false, { id: 'zzz', title: 'Tapped tile', channel: 'Its channel' });
    d.send({ ev: 'state', state: 'preparing', pct: 5, id: 'zzz', title: 'zzz' });
    await until(() => m.pct === 5, 2000, 'preparing zzz');
    assert.deepStrictEqual([m.title, m.channel], ['Tapped tile', 'Its channel'], 'the id is not shown as the title');
    d.send({ ev: 'state', state: 'playing', id: 'zzz', title: 'Real title' });
    await until(() => m.state === 'playing', 2000, 'playing zzz');
    assert.strictEqual(m.title, 'Real title', "the daemon's own title");
    d.send({ ev: 'state', state: 'playing', id: 'sub4', title: 'sub4' });
    await until(() => m.id === 'sub4', 2000, 'another video');
    assert.deepStrictEqual([m.title, m.channel], ['Sub 4', 'C'], "another video (the daemon's, only its id said): title and channel from the list");
    d.send({ ev: 'state', state: 'idle' });
    m.feed('wl');
    assert.ok(!m.checkFeeds(Date.now(), 15000) && m.checkFeeds(Date.now() + 16000, 15000) && /No answer/.test(m.feeds.wl.error), 'no answer in 15 s: an error');
    m.feeds.wl.loading = false;
    m.feed('wl');
    d.send({ ev: 'feed', which: 'wl', error: 'feed offline' });
    await until(() => m.feeds.wl.error === 'feed offline', 2000, 'feed error');
    assert.strictEqual(m.error, null, 'a feed error is not a playback error');

    // playlists: asked once at a time; bad ids dropped; a count only when a number; the tile's picture (a video id)
    // is asked like a video's; a playlist's videos, and another playlist's late answer ignored
    assert.ok(m.loadPlaylists() && !m.loadPlaylists() && m.pls.loading, 'one playlists request at a time');
    await lastIs(d, { cmd: 'playlists' });
    d.send({ ev: 'playlists', items: [{ id: 'PLaaaaaaaaaa', title: 'Drives', count: 3, meta: ['Private', 7], thumb: 'plthumb0001' },
        { id: 'LL', title: 'Liked videos', count: null, thumb: 'bad' }, { id: 'no spaces', title: 'Bad' }, { title: 'No id' }] });
    await until(() => m.pls.items.length, 2000, 'playlists');
    assert.deepStrictEqual(m.pls.items, [{ id: 'PLaaaaaaaaaa', title: 'Drives', count: 3, meta: ['Private'], thumb: 'plthumb0001' },
        { id: 'LL', title: 'Liked videos', count: null, meta: [], thumb: null }], 'checked');
    assert.ok(m.wantThumb('plthumb0001'), "a playlist's picture is asked as its video's");
    d.send({ ev: 'thumb', id: 'plthumb0001', w: 320, h: 180, rgba: Buffer.alloc(320 * 180 * 4, 3).toString('base64') });
    await until(() => m.thumbs.plthumb0001, 2000, 'playlist picture kept');
    assert.ok(m.openPlaylist('PLaaaaaaaaaa', 'Drives') && m.plist.loading && m.plist.title === 'Drives', 'its name until it loads');
    await lastIs(d, { cmd: 'playlist', id: 'PLaaaaaaaaaa' });
    assert.strictEqual(m.openPlaylist('bad id'), false, 'a bad id is not sent');
    d.send({ ev: 'playlist', id: 'PLbbbbbbbbbb', items: [{ id: 'other000001' }] });
    d.send({ ev: 'playlist', id: 'PLaaaaaaaaaa', title: 'Drives (renamed)', items: [{ id: 'plvid000001', title: 'One' }, { id: 'plvid000002', title: 'Two' }, { bad: 1 }] });
    await until(() => m.plist.items.length, 2000, 'playlist videos');
    assert.deepStrictEqual([m.plist.title, m.plist.items.map((x) => x.id)], ['Drives (renamed)', ['plvid000001', 'plvid000002']], 'its videos, not the other one');
    assert.ok(m.item('plvid000002') && m.wantThumb('plvid000002'), 'its videos are known (play, thumbs)');
    m.openPlaylist('PLaaaaaaaaaa');
    assert.ok(!m.checkFeeds(Date.now(), 15000) && m.checkFeeds(Date.now() + 16000, 15000) && /No answer/.test(m.plist.error), 'no answer in 15 s: an error');
    assert.strictEqual(m.plist.items.length, 2, 'what it held stays shown');
    // a daemon older than playlists: the page says so, not a playback error
    m.pls.loading = false; m.loadPlaylists();
    d.send({ ev: 'error', msg: 'unknown cmd playlists' });
    await until(() => m.pls.error === 'unknown cmd playlists', 2000, 'older daemon');
    assert.ok(!m.pls.loading && m.error === null, 'not a playback error');
    d.got.length = 0;
    assert.ok(m.signOut());
    await lastIs(d, { cmd: 'sign_out' });
    d.send({ ev: 'auth', state: 'signed_out' });
    await until(() => m.auth.state === 'signed_out', 2000, 'signed out again');
    assert.deepStrictEqual(m.feeds, {}, 'signed out: the feeds are gone');
    assert.ok(!m.thumbs.sub3 && !m.thumbs.plthumb0001, 'and their thumbs');
    assert.ok(m.pls === null && m.plist === null, 'and the playlists');
    // an older daemon: no sign-in, and nothing shown as an error
    d.send({ ev: 'error', msg: 'unknown cmd auth_status' });
    await until(() => m.auth.state === 'unsupported', 2000, 'unsupported');
    assert.strictEqual(m.error, null);

    // a bad line is skipped, the next one read
    d.conn.write('not json\n{"ev":"time","elapsed":1,"total":2}\n');
    await until(() => m.total === 2, 2000, 'line after a bad one');

    // the daemon goes away and comes back: reconnect within 2 s, status asked again
    const statuses = d.cmds('status').length;
    m.onMsg({ ev: 'results', q: m.q, items: [{ id: 'lib2', title: 'Second' }] });
    assert.ok(m.wantThumb('lib2'), 'lib2 asked');
    d.conn.destroy();
    await until(() => !m.connected, 2000, 'down');
    assert.strictEqual(m.send({ cmd: 'status' }), false, 'commands dropped while down');
    assert.strictEqual(m.pending.size, 0, 'down: what was asked is asked again once back');
    await until(() => d.conns === 2, 3500, 'reconnect');
    await until(() => d.cmds('status').length === statuses + 1, 2000, 'status after reconnect');
    ctl.close();
    d.server.close();
    assert.strictEqual(clock(83000), '1:23');
    assert.strictEqual(clock(3723000), '1:02:03');
    console.log('ok   ctl client + state machine');
}

// renderer stream: message types, picture ids drawn (op 18, native form: id in word 6), whether video 1 is drawn (op 19)
function scan(s) {
    const r = { types: [], pics: [], all: [], frames: [], op19: false, vrect: null, xf: false };
    for (let o = 0; o + 8 <= s.length;) {
        const t = s.readUInt32LE(o), len = s.readUInt32LE(o + 4);
        r.types.push(t);
        if (t === 7) { r.pics = []; r.frames.push(r.pics); r.vrect = null; }   // vrect: the last frame's
        if (t === 7) for (let i = o + 8; i + 28 <= o + 8 + len; i += 4) {
            const w = s.readUInt32LE(i);
            if (w === 19 && s.readUInt32LE(i + 24) === 1) { r.op19 = true; r.vrect = [4, 8, 12, 16].map((k) => s.readFloatLE(i + k)); }
            if (w === 18 && s.readUInt32LE(i + 24) > 0 && s.readUInt32LE(i + 24) < 4096) { r.pics.push(s.readUInt32LE(i + 24)); r.all.push(s.readUInt32LE(i + 24)); }
        }
        o += 8 + len;
    }
    return r;
}

// the app itself, drawn into a renderer stream (preview path of kit/tools/hu-stub.js)
async function appFrames() {
    const stage = path.join(__dirname, '..', '..', 'dist', 'jap_ridetube');
    if (!fs.existsSync(path.join(stage, 'source', 'javascript', 'app.js'))) { console.log('skip app frames (python3 kit/tools/build.py jap_ridetube first)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-app-'));
    const sock = socketPath(dir), file = path.join(dir, 'stream.bin');
    const d = await fakeDaemon(sock);
    process.env.MGU_YT_SOCKET = sock;
    process.env.MGU_RENDERD_FILE = file;
    const vfile = process.env.MGU_YT_VIDEO = path.join(dir, 'mgu-video-ridetube');
    const { headUnit } = require('./hu-stub');
    const hu = headUnit(stage, { dataDir: dir, fresh: true, image: () => Promise.resolve(), log: quiet });
    const disp = hu.display;
    // parked: the car reads 0 km/h (the video gate counts no speed as moving)
    let speedH = null;
    let batH = null;
    let rockerH = null, rockerIface = null;
    hu.ctx.signals = { watch: async (i, n, h) => { if (h && h.statusCarSpeed2) { speedH = h.statusCarSpeed2; speedH({ speedVehicleCentreOfGravity: 0 }); } if (h && h.statusBattery2) batH = h.statusBattery2; if (h && h.statusSearchSwitch1) { rockerH = h.statusSearchSwitch1; rockerIface = i + '/' + n; } return {}; } };
    // (the stub's ctx predates these: as kit/mgu.js)
    hu.ctx.hideButton = (id, hide) => disp.hideButton(id, hide);
    hu.ctx.onPageFocus = (fn) => { disp.onPageFocus = fn; };
    hu.ctx.focus = (k) => disp.focusPage(k);
    // the car's HMI language (kit/mgu.js: CurrentVehicleUnits): en_GB here until WP7 turns it to Russian
    const hmiLang = { now: 'en_GB', fns: [] };
    hu.ctx.hmiLanguage = (fn) => { if (fn) hmiLang.fns.push(fn); return hmiLang.now; };
    assert.strictEqual(typeof hu.ctx.onTouch, 'function', 'the stub has onTouch, as kit/mgu.js');
    const wp5 = wp5Spies(hu);
    hu.start();
    await until(() => d.cmds('auth_status').length, 3000, 'app connects and asks for the account');
    await until(() => d.cmds('hello').length, 3000, 'hello on connect');
    assert.deepStrictEqual(d.cmds('hello')[0], { cmd: 'hello', app: require('../../apps/jap_ridetube/app.json').version, lang: 'en', region: 'GB' }, 'hello: the app version, the car\'s en_GB as YouTube language and country');
    const POOL = (id) => id >= 8 && id < 64;
    const frame = () => scan(fs.readFileSync(file));
    // first screen: Home, signed out: the sign-in card, no tiles; never a library (nothing is kept on the car)
    await hu.ui.open('VIEW');
    await hu.loopFn();
    await sleep(100);
    assert.strictEqual(d.cmds('thumb').length, 0, 'no tiles, no thumbs');
    assert.strictEqual(d.cmds('library').length, 0, 'no library asked');
    // recent search -> results with a 320x180 thumb
    hu.handlers.BTN_S1();
    await until(() => d.cmds('search').length, 2000, 'search');
    assert.deepStrictEqual(d.cmds('search')[0], { cmd: 'search', q: 'Music' }, 'first suggestion');
    d.send({ ev: 'results', q: 'Music', items: [{ id: 'aaa', title: 'Song', channel: 'Band', duration_s: 200, meta: ['5 views'] }] });
    await sleep(100);
    await hu.loopFn();
    await until(() => d.cmds('thumb').some((x) => x.id === 'aaa'), 2000, 'results thumb asked');
    d.send({ ev: 'thumb', id: 'aaa', w: 320, h: 180, rgba: Buffer.alloc(320 * 180 * 4, 255).toString('base64') });
    await sleep(100);
    await hu.loopFn();
    assert.ok(frame().pics.some(POOL), 'results frame draws its 320x180 thumb');
    // offline search: the error, drawn, no hang
    hu.handlers.BTN_S2();
    await until(() => d.cmds('search').length === 2, 2000, 'second search');
    d.send({ ev: 'error', msg: 'search offline' });
    await sleep(100);
    await hu.loopFn();
    // player: video file there -> VIDEO + op 19
    fs.writeFileSync(vfile, '');
    hu.handlers.BTN_NOW();
    d.send({ ev: 'state', state: 'playing', id: 'aaa', title: 'Song' });
    d.send({ ev: 'time', elapsed: 1000, total: 200000 });
    await sleep(400);              // the 250 ms gate
    await hu.loopFn();
    const f = frame();
    assert.ok(f.types.indexOf(10) >= 0, 'the thumbnails uploaded as pictures (10)');
    assert.ok(f.types.indexOf(13) >= 0, 'VIDEO (13) names the decoder file');
    assert.ok(f.op19, 'player frame draws video 1 (op 19)');
    const plays = d.cmds('video');
    assert.deepStrictEqual(plays.slice(-1)[0], { cmd: 'video', on: true }, 'player shown and parked: video on');
    // where the kit runs the screen (a renderer that routes touch, full-screen layout): no bar; the player covers the
    // whole screen with its overlay (targets ov:*), a tap beside them hides it, any tap or the controller shows it
    disp.gpu.touch = true; disp._place();
    await hu.loopFn();
    const own = disp.own();
    const bar = () => disp.buttons().map((b) => b.id);
    const pl = disp.place;
    const keys = () => disp.pageTargets.map((x) => x.key);
    if (own && pl && pl.full) {
        assert.deepStrictEqual(bar(), [], 'no bar where the kit runs the screen');
        assert.ok(pl.extra > 0, 'so the page reaches the screen bottom: extra ' + pl.extra);
        assert.deepStrictEqual(frame().vrect, [0, 0, pl.w, pl.h], 'the player: the video over the whole screen at once');
        assert.deepStrictEqual(keys(), ['ov:back', 'ov:qr', 'ov:close', 'ov:rw', 'ov:play', 'ov:ff', 'ov:q', 'ov:zoom', 'ov:bar'], 'the overlay controls');
        // Quality: auto -> 720 (the setting too); zoom: whole picture (default, 0.3.6) -> fill
        disp.pageTargets.find((t) => t.key === 'ov:q').run();
        await lastIs(d, { cmd: 'quality', quality: '720' }, 'Quality: the next one');
        assert.strictEqual(hu.ctx.settings.get('quality'), '720');
        await hu.loopFn();
        disp.pageTargets.find((t) => t.key === 'ov:zoom').run();
        await lastIs(d, { cmd: 'fill', on: true }, 'Zoom: fill the screen');
        assert.strictEqual(hu.ctx.settings.get('fill'), true);
        hu.ctx.settings.set('quality', 'auto'); hu.ctx.settings.set('fill', false);
        await hu.loopFn();
        disp.pageTargets.find((t) => t.key === 'ov:qr').run();
        await hu.loopFn();
        assert.deepStrictEqual(keys(), ['ov:back', 'ov:qr', 'ov:qrcard'], 'On phone: the QR card over the controls');
        disp.pageTargets.find((t) => t.key === 'ov:qrcard').run();
        await hu.loopFn();
        disp.pageTargets.find((t) => t.key === 'ov:play').run();
        await lastIs(d, { cmd: 'pause' }, 'play / pause on the overlay');
        disp.pageTargets.find((t) => t.key === 'ov:ff').run();
        await lastIs(d, { cmd: 'seek', ms: 11000 }, '+10 s on the overlay');
        // the knob on the progress bar: 10 s a detent, one seek when it rests (through the kit's controller path)
        const nSeek = d.cmds('seek').length;
        disp.focusKey = 'tgt:ov:bar';
        const knob = (k) => disp._ccu({ frontRotaryEncoderOperation: k, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
        knob(100); knob(102); knob(101);                    // +2 then -1 detents
        assert.strictEqual(disp.focusKey, 'tgt:ov:bar', 'turning on the bar stays on it');
        await sleep(500);
        assert.strictEqual(d.cmds('seek').length, nSeek + 1, 'one seek for the three detents');
        await lastIs(d, { cmd: 'seek', ms: 21000 }, 'the knob on the bar: +10 s net');
        // a finger on the bar (the kit's touch path, page px): dragged, the time follows it, one seek where it lets go;
        // a tap on it jumps there (no play / pause); a touch beside it is the page's as before
        const barT = disp.pageTargets.find((t) => t.key === 'ov:bar'), at = (k) => [barT.x + 10 + (barT.w - 20) * k, barT.y + barT.h / 2];
        const nSeek2 = d.cmds('seek').length, nPause0 = d.cmds('pause').length;
        disp._touch(1, ...at(0.25)); disp._touch(2, ...at(0.4)); disp._touch(2, ...at(0.5));
        await sleep(400); await hu.loopFn();
        assert.strictEqual(d.cmds('seek').length, nSeek2, 'no seek while the finger holds the bar');
        assert.ok(disp.pageTargets.some((t) => t.key === 'ov:bar'), 'the controls stay while it holds the bar');
        disp._touch(3, ...at(0.5));
        await lastIs(d, { cmd: 'seek', ms: 100000 }, 'let go at half the bar: half the video (200 s)');
        assert.strictEqual(d.cmds('seek').length, nSeek2 + 1, 'one seek for the drag');
        disp._touch(1, ...at(0.75)); disp._touch(3, ...at(0.75));
        await lastIs(d, { cmd: 'seek', ms: 150000 }, 'a tap on the bar jumps there');
        disp._touch(1, ...at(1)); disp._touch(2, ...at(-0.5)); disp._touch(3, ...at(-0.5));
        await lastIs(d, { cmd: 'seek', ms: 0 }, 'dragged past the start: the start');
        assert.strictEqual(d.cmds('pause').length, nPause0, 'a finger on the bar never pauses');
        const sx = (x) => x * pl.scale + pl.ox, sy = (y) => y * pl.scale + pl.oy;
        assert.strictEqual(disp.onTouch(1, sx(barT.x + barT.w / 2), sy(barT.y - 120)), false, 'a touch above the bar: the page\'s (its controls, the tap that hides them)');
        assert.strictEqual(disp.onTouch(3, sx(barT.x + barT.w / 2), sy(barT.y - 120)), false);
        d.send({ ev: 'time', elapsed: 21000, total: 200000 });
        await sleep(300); await hu.loopFn();
        console.log('ok   the progress bar: dragged or tapped with a finger, one seek where it lets go');
        // double taps on the picture (overlay px -> the kit's page px): the right third +10 s a tap after the first, one seek
        // once they stop; a single tap none; a double tap on a control shown is the control's; with the controls hidden,
        // a second tap where a control just showed is still a double tap
        const SW = pl.w / pl.scale, SH = pl.h / pl.scale, ovPt = (X, Y) => [X - pl.ox / pl.scale, Y - pl.oy / pl.scale];
        const tap = (p) => { disp._touch(1, ...p); disp._touch(3, ...p); };
        const nPause1 = d.cmds('pause').length, nFill = d.cmds('fill').length;
        // (parked: the speed read again, as the car sends it - a reading older than 5 s counts as driving: podcast mode)
        const parkedNow = () => speedH({ speedVehicleCentreOfGravity: 0 });
        const at50 = async () => { parkedNow(); d.send({ ev: 'time', elapsed: 50000, total: 200000 }); disp.onPageFocus('ov:rw'); await sleep(300); await hu.loopFn(); };
        await at50();
        let nS = d.cmds('seek').length;
        const R = ovPt(SW * 0.85, SH * 0.3);
        tap(R); tap([R[0] + 20, R[1] + 10]); tap(R);
        await sleep(500);
        assert.deepStrictEqual(d.cmds('seek').slice(nS), [{ cmd: 'seek', ms: 70000 }], 'a triple tap on the right: +20 s, one seek');
        await sleep(300); await hu.loopFn();
        nS = d.cmds('seek').length;
        tap(ovPt(SW * 0.15, SH * 0.3));
        await sleep(600);
        assert.strictEqual(d.cmds('seek').length, nS, 'a single tap on the left: no seek');
        await at50();
        const Z = ovPt(SW - 150, SH / 2 - 6);                // the Zoom control (right third)
        nS = d.cmds('seek').length;
        tap(Z); await hu.loopFn(); tap(Z);
        await sleep(500);
        assert.deepStrictEqual([d.cmds('seek').length, d.cmds('fill').slice(nFill).map((x) => x.on)], [nS, [true, false]], 'a double tap on Zoom: Zoom twice, no seek');
        parkedNow(); disp.onTap(800, 300); await sleep(300); await hu.loopFn();    // (controls hidden)
        assert.ok(disp.pageTargets.every((t) => t.w > 1000), 'controls hidden');
        tap(Z); await hu.loopFn(); tap(Z);
        await sleep(500);
        assert.deepStrictEqual(d.cmds('seek').slice(nS), [{ cmd: 'seek', ms: 60000 }], 'controls hidden: a double tap where Zoom shows is +10 s');
        assert.strictEqual(d.cmds('fill').length, nFill + 2, 'and not a Zoom');
        assert.strictEqual(d.cmds('pause').length, nPause1, 'double taps never pause');
        hu.ctx.settings.set('fill', false);
        d.send({ ev: 'time', elapsed: 21000, total: 200000 });
        await sleep(300); await hu.loopFn();
        console.log('ok   double tap on the picture\'s left / right third: -10 s / +10 s a tap, the controls keep theirs');
        // SponsorBlock "ask" (end cards by default): a Skip button while the clock is in one, the overlay kept
        d.send({ ev: 'extras', id: 'aaa', chapters: [], segments: [[15000, 60000, 'outro']] });
        await sleep(100); await hu.loopFn();
        assert.ok(keys().indexOf('ov:sbskip') >= 0, 'Skip end cards: ' + keys());
        disp.pageTargets.find((t) => t.key === 'ov:sbskip').run();
        await lastIs(d, { cmd: 'seek', ms: 60000 }, 'Skip jumps to its end');
        d.send({ ev: 'extras', id: 'aaa', chapters: [], segments: [] });
        // the 12 V battery under the setting (65 %) while parked and playing: paused, with why
        const nPause = d.cmds('pause').length;
        batH({ conditionBatteryChargingCondition: 62 });
        await until(() => d.cmds('pause').length > nPause, 2500, 'low 12 V battery pauses');
        batH({ conditionBatteryChargingCondition: 90 });
        await hu.loopFn();
        console.log('ok   SponsorBlock Skip button (ask), 12 V battery guard');
        disp.onTap(800, 300);
        await hu.loopFn();
        const hid = disp.pageTargets;
        assert.ok(hid.length === 9 && hid.every((t) => t.w > 1000 && t.h > 500), 'a tap beside them: hidden, each key the whole screen');
        assert.deepStrictEqual(frame().vrect, [0, 0, pl.w, pl.h], 'the video stays whole');
        const pauses = d.cmds('pause').length;
        hid.find((t) => t.key === 'ov:play').run();       // (as the controller pressed on its key, or a tap)
        await hu.loopFn();
        assert.strictEqual(d.cmds('pause').length, pauses, 'hidden, a press only shows the overlay');
        assert.ok(disp.pageTargets.find((t) => t.key === 'ov:play').w < 300, 'shown again');
        disp.onTap(800, 300);
        await hu.loopFn();
        disp.onPageFocus('ov:rw');                           // the knob turned
        await hu.loopFn();
        assert.ok(disp.pageTargets.find((t) => t.key === 'ov:rw').w < 300, 'the controller shows it');
        console.log('ok   full-screen player: overlay controls, hides on a tap, a tap or the controller shows it');
        // driving: podcast mode - no picture, the big controls always there (no overlay to wake)
        speedH({ speedVehicleCentreOfGravity: 50 * 64 });
        const seeks = d.cmds('seek').length;
        await sleep(300); await hu.loopFn();                 // (an unchanged model redraws within 250 ms)
        assert.ok(!frame().vrect, 'no video while driving');
        // Enabling while moving must not switch video on. It must be enabled while parked.
        hu.ctx.settings.set('video_driving', true);
        await sleep(300); await hu.loopFn();
        assert.ok(!frame().vrect, 'switching the setting on while moving keeps video off');
        speedH({ speedVehicleCentreOfGravity: 0 });
        await sleep(300); await hu.loopFn();
        speedH({ speedVehicleCentreOfGravity: 50 * 64 });
        await sleep(300); await hu.loopFn();
        assert.ok(frame().vrect, 'setting enabled while parked: video stays available while moving');
        assert.deepStrictEqual(d.cmds('video').slice(-1)[0], { cmd: 'video', on: true }, 'Video while driving: video on');
        hu.ctx.settings.set('video_driving', false);
        await sleep(300); await hu.loopFn();
        assert.ok(!frame().vrect, 'setting off: no video while driving again');
        console.log('ok   Video while driving setting keeps the picture while moving');
        ['ov:rw', 'ov:play', 'ov:ff', 'ov:close'].forEach((k) => assert.ok(disp.pageTargets.some((t) => t.key === k && t.w > 120 && t.w < 300), 'podcast control ' + k + ': ' + keys()));
        disp.pageTargets.find((t) => t.key === 'ov:ff').run();
        await until(() => d.cmds('seek').length > seeks, 2000, 'a podcast +10 s');
        assert.ok(disp.pageTargets.some((t) => t.key === 'ov:bar' && t.turn), 'podcast: the knob seeks on the bar');
        await sleep(300); await hu.loopFn();
        const podBar = disp.pageTargets.find((t) => t.key === 'ov:bar'), pAt = (k) => [podBar.x + 10 + (podBar.w - 20) * k, podBar.y + podBar.h / 2];
        disp._touch(1, ...pAt(0.1)); disp._touch(2, ...pAt(0.5)); disp._touch(3, ...pAt(0.5));
        await lastIs(d, { cmd: 'seek', ms: 100000 }, 'podcast: the bar dragged with a finger');
        // a failed play while driving: Try again in the middle (the same video)
        d.send({ ev: 'state', state: 'error', id: 'aaa', title: 'Song' }); d.send({ ev: 'error', msg: 'fetch: boom' });
        await sleep(300); await hu.loopFn();
        const nPlay = d.cmds('play').length;
        disp.pageTargets.find((t) => t.key === 'ov:play').run();
        await until(() => d.cmds('play').length > nPlay, 2000, 'Try again plays it again');
        assert.strictEqual(d.cmds('play').slice(-1)[0].id, 'aaa');
        assert.strictEqual(d.cmds('play').slice(-1)[0].quality, 'auto', 'the Video quality setting goes with each play');
        assert.deepStrictEqual(d.cmds('play').slice(-1)[0].skip, ['sponsor', 'selfpromo', 'interaction', 'intro'], 'and the SponsorBlock categories skipped');
        d.send({ ev: 'state', state: 'playing', id: 'aaa', title: 'Song' }); d.send({ ev: 'time', elapsed: 21000, total: 200000 });
        speedH({ speedVehicleCentreOfGravity: 0 });
        await sleep(300); await hu.loopFn();
        console.log('ok   podcast mode while driving: no picture, big controls, knob seek, Try again');
        // Close: the video ends now (the daemon's stop: sound, speakers, decoder), off the player onto the list
        await hu.loopFn();
        const nStop = d.cmds('stop').length;
        disp.pageTargets.find((t) => t.key === 'ov:close').run();
        await until(() => d.cmds('stop').length === nStop + 1, 2000, 'Close sends stop');
        await sleep(50); await hu.loopFn();
        assert.ok(keys().indexOf('ov:play') < 0 && keys().indexOf('rail:search') >= 0, 'Close: back on the list: ' + keys());
        assert.ok(frame().types.indexOf(14) >= 0, 'Close: the picture dropped (DROP_VIDEO)');
        d.send({ ev: 'state', state: 'idle' });
        await sleep(100);
        // the HMI menu's Close video does the same; with nothing playing it sends nothing
        hu.handlers.BTN_CLOSE();
        await sleep(100);
        assert.strictEqual(d.cmds('stop').length, nStop + 1, 'nothing playing: Close video sends nothing');
        d.send({ ev: 'state', state: 'playing', id: 'aaa', title: 'Song' });
        await sleep(100);
        hu.handlers.BTN_CLOSE();
        await until(() => d.cmds('stop').length === nStop + 2, 2000, 'Close video (HMI menu) sends stop');
        // playing again for what follows
        hu.handlers.BTN_NOW();
        d.send({ ev: 'state', state: 'playing', id: 'aaa', title: 'Song' }); d.send({ ev: 'time', elapsed: 21000, total: 200000 });
        await sleep(400); await hu.loopFn();
        console.log('ok   Close: stop sent, the list again (overlay and HMI menu)');
    } else console.log('skip full-screen player (the stub has no full-screen placement)');
    // back to the list (the overlay's back, or the bar's list button where the HMI runs the screen): DROP_VIDEO
    if (own) disp.pageTargets.find((t) => t.key === 'ov:back').run(); else hu.handlers.BTN_LIST();
    await sleep(50);
    assert.ok(frame().types.indexOf(14) >= 0, 'leaving the player sends DROP_VIDEO');
    await lastIs(d, { cmd: 'video', on: false }, 'and tells the daemon video off');
    if (own) {
        await hu.loopFn();
        assert.ok(keys().indexOf('rail:player') >= 0, 'browsing while a video plays: Playing on the rail: ' + keys());
        assert.ok(disp.onBack(false) === false && disp.onBack(true) === false, 'browsing: the controller pushed left is the kit\'s (leaves the app at the edge)');
        disp.pageTargets.find((t) => t.key === 'rail:player').run();
        await hu.loopFn();
        assert.ok(keys().indexOf('ov:play') >= 0, 'the rail\'s Playing opens the player');
        assert.ok(disp.onBack(false) === true, 'the controller pushed left in the player: taken');
        await hu.loopFn();
        assert.ok(keys().indexOf('rail:player') >= 0, 'and back on the list');
        d.send({ ev: 'state', state: 'idle' });
        await sleep(100);
        assert.deepStrictEqual(bar(), [], 'nothing playing: no bar either');
        d.send({ ev: 'results', q: d.cmds('search').slice(-1)[0].q, items: [{ id: 'lib1', title: 'First', channel: 'Me', duration_s: 60 }, { id: 'lib2', title: 'Second' }] });
        await sleep(100);
        hu.handlers.BTN_RESULTS();           // (the search's results page)
        await hu.loopFn();
        const ks = keys();
        assert.deepStrictEqual(ks.slice(0, 4), ['rail:search', 'rail:home', 'rail:subs', 'rail:wl'], 'the rail first: ' + ks);
        assert.ok(ks.indexOf('rail:library') < 0, 'no Library');
        assert.ok(ks.indexOf('rail:player') < 0, 'nothing playing: no Playing');
        assert.ok(ks.indexOf('r:0:lib1') > 3 && ks.indexOf('r:0:lib2') > 3, 'then the tiles: ' + ks);
        // the controller on a tile, pressed: the player; pushed left: back on that tile
        disp.onPageFocus('r:0:lib1');
        disp.pageTargets.find((t) => t.key === 'r:0:lib1').run();
        await hu.loopFn();
        assert.ok(keys().indexOf('ov:back') >= 0, 'the tile opens the player');
        assert.ok(disp.onBack(false) === true);
        await hu.loopFn();
        assert.strictEqual(disp.focusKey, 'tgt:r:0:lib1', 'the controller back on the tile it left from');
        console.log('ok   no bar, rail (Playing while a video plays), back from the player onto the tile');
    }
    console.log('ok   app frames (Home signed out, results, offline search, player through the renderer stream)');

    // the feed tabs: signed out, Home asks for a code and shows the sign-in page (QR + code); signed in, the feed
    const { Recorder } = require(path.join(hu.kitDir, 'record'));
    const texts = [], rects = [];
    const ot = Recorder.prototype.text, of = Recorder.prototype.fillRect;
    Recorder.prototype.text = function (str) { texts.push(String(str)); return ot.apply(this, arguments); };
    Recorder.prototype.fillRect = function (x, y, w, h, c) { rects.push({ w, h, c }); return of.apply(this, arguments); };
    const drawn = async () => {
        texts.length = 0;
        rects.length = 0;
        disp._layoutChanged();
        await hu.loopFn();
    };
    d.send({ ev: 'auth', state: 'signed_out' });
    await sleep(100);
    assert.strictEqual(d.cmds('auth').length, 0, 'signed out on the results: no code asked');
    disp.onTab(0);
    await until(() => d.cmds('auth').length === 1, 2000, 'Home, signed out: a sign-in code asked');
    await drawn();
    assert.ok(texts.indexOf('Getting a sign-in code...') >= 0, texts.join('|'));
    d.send({ ev: 'auth', state: 'code', code: 'ABC-DEF-GHIJ', url: 'https://www.google.com/device', expires: 1800 });
    await sleep(100);
    await drawn();
    assert.ok(texts.indexOf('ABC-DEF-GHIJ') >= 0 && texts.indexOf('Enter this code on your phone') >= 0, texts.join('|'));
    assert.ok(rects.some((r) => r.w === 296 && r.h === 296 && r.c === '#ffffff'), 'the QR code on its white square (29 + 8 modules of 8 px)');
    assert.ok(rects.filter((r) => r.c === '#000000' && r.h === 8).length > 100, 'its dark modules');
    d.send({ ev: 'auth', state: 'error', msg: 'car internet is offline (MGU Store > Settings > Internet)' });
    await sleep(100);
    await drawn();
    assert.ok(texts.indexOf('Car internet is offline') >= 0 && texts.some((s) => s.indexOf('MGU Store') >= 0), 'offline has an actionable message: ' + texts.join('|'));
    d.send({ ev: 'auth', state: 'error', msg: 'timeout' });
    await sleep(100);
    await drawn();
    assert.ok(texts.indexOf('YouTube did not answer') >= 0, 'timeout names the remote service');
    d.send({ ev: 'auth', state: 'error', msg: 'sign-in TV credentials: timeout' });
    await sleep(100);
    await drawn();
    assert.ok(texts.indexOf('YouTube TV page did not answer') >= 0, 'TV-page timeout identifies its stage');
    d.send({ ev: 'auth', state: 'error', msg: 'sign-in device code: timeout' });
    await sleep(100);
    await drawn();
    assert.ok(texts.indexOf('YouTube sign-in code did not arrive') >= 0, 'device-code timeout identifies its stage');
    d.send({ ev: 'auth', state: 'error', msg: 'no answer from the RideTube service' });
    await sleep(100);
    await drawn();
    assert.ok(texts.indexOf('RideTube service did not answer') >= 0, 'lost sign-in answer is visible: ' + texts.join('|'));
    d.send({ ev: 'auth', state: 'unsupported' });
    await sleep(100);
    await drawn();
    assert.ok(texts.indexOf('Signing in needs a newer jap-ridetube-d tool on the car') >= 0, 'old service is visible: ' + texts.join('|'));
    d.send({ ev: 'auth', state: 'code', code: 'ABC-DEF-GHIJ', url: 'https://www.google.com/device', expires: 1800 });
    await sleep(100);
    // a url longer than the QR holds: the fixed sign-in URL instead, never a throw
    d.send({ ev: 'auth', state: 'code', code: 'ABC-DEF-GHIJ', url: 'https://www.google.com/device?' + 'x'.repeat(80), expires: 1700 });
    await sleep(100);
    await drawn();
    assert.ok(texts.indexOf('Scan the code, or go to google.com/device') >= 0 && rects.some((r) => r.w === 296 && r.c === '#ffffff'), 'long url: the fixed one');
    disp.onTab(1);
    await sleep(100);
    assert.strictEqual(d.cmds('auth').length, 1, 'another feed tab: the code shown, not asked again');
    d.send({ ev: 'auth', state: 'signed_in' });
    await until(() => d.cmds('feed').length === 1, 2000, 'signed in on Subscriptions: its feed asked');
    assert.deepStrictEqual(d.cmds('feed')[0], { cmd: 'feed', which: 'subs' });
    await drawn();
    assert.ok(texts.indexOf('Loading Subscriptions...') >= 0, texts.join('|'));
    // an older daemon: a flat list, no shelves -> a grid of four a row; thumbs asked for the tiles drawn only
    const thumbs0 = d.cmds('thumb').length;
    d.send({ ev: 'feed', which: 'subs', items: Array.from({ length: 24 }, (_, i) => ({ id: 'f' + i, title: 'Feed ' + i, channel: 'Ch', duration_s: 90 })) });
    await sleep(100);
    await drawn();
    await sleep(100);
    const asked = d.cmds('thumb').slice(thumbs0).map((x) => x.id);
    assert.ok(asked.length >= 4 && asked.length <= 12 && asked.indexOf('f0') >= 0 && asked.indexOf('f19') < 0, 'only the drawn tiles asked: ' + asked);
    d.send({ ev: 'thumb', id: 'f0', w: 160, h: 90, rgba: Buffer.alloc(57600, 77).toString('base64') });
    await sleep(100);
    await drawn();
    assert.ok(frame().pics.some(POOL), 'feed frame draws a pooled picture');
    assert.ok(texts.indexOf('Feed 0') >= 0 && texts.indexOf('Feed 1') >= 0, 'the first row: Feed 0 and Feed 1 side by side');
    if (own) {
        assert.ok(disp.onScroll(5000), 'the feed scrolls');
        await drawn();
        const keys = disp.pageTargets.map((x) => x.key);
        assert.ok(keys.some((k) => /^s:\d+:f19$/.test(k)) && !keys.some((k) => /^s:\d+:f0$/.test(k)), 'scrolled to the end: the last row, not the first: ' + keys.join(','));
        assert.ok(!disp.onScroll(100), 'at the end');
        disp.pageTargets.find((x) => /^s:\d+:f19$/.test(x.key)).run();
        await until(() => d.cmds('play').some((x) => x.id === 'f19' && x.fill === false && /^\d+x\d+$/.test(x.rect)), 2000, 'a feed tile plays its video');
        console.log('ok   feed scrolls (kit runs the screen) and a tile plays');
        d.send({ ev: 'state', state: 'idle' });
        hu.handlers.BTN_LIST();             // (back to the list)
    } else console.log('skip feed scrolling (the stub does not run the screen)');
    // sign out: pressed twice; the daemon says signed out, the feed tab asks for a new code
    disp.onTab(1);
    await until(() => d.cmds('feed').length === 2, 2000, 'back on Subscriptions: reloaded');
    hu.handlers.BTN_ACCOUNT();
    await sleep(50);
    assert.strictEqual(d.cmds('sign_out').length, 0, 'one press does not sign out');
    hu.handlers.BTN_ACCOUNT();
    await until(() => d.cmds('sign_out').length === 1, 2000, 'second press signs out');
    d.send({ ev: 'auth', state: 'signed_out' });
    await sleep(150);
    assert.strictEqual(d.cmds('auth').length, 1, 'signed out (or a code expired) on a feed tab: no new device flow on its own');
    await drawn();
    if (own) {
        assert.ok(texts.indexOf('Tap here to get a sign-in code') >= 0, texts.join('|'));
        disp.pageTargets.find((x) => x.key === 'signin').run();
        await until(() => d.cmds('auth').length === 2, 2000, 'the tap asks for a code');
    } else {
        hu.handlers.BTN_ACCOUNT();
        await until(() => d.cmds('auth').length === 2, 2000, 'Sign in in the menu asks for a code');
    }
    // an expired code (daemon: signed_out) while the page shows: also no new flow on its own
    d.send({ ev: 'auth', state: 'code', code: 'NEW-COD-EEEE', url: 'https://www.google.com/device', expires: 1800 });
    d.send({ ev: 'auth', state: 'signed_out' });
    await sleep(150);
    assert.strictEqual(d.cmds('auth').length, 2, 'code expired: not asked again until a tap');
    disp.onTab(0);
    await until(() => d.cmds('auth').length === 3, 2000, 'opening a feed tab asks again');
    console.log('ok   feed tabs (sign-in page with QR and code, feed tiles, sign out)');

    // Home with the account's shelves (daemon 0.1.6): the shelves, Watch later (asked with Home)
    if (own) {
        const SH = 8, N = 12, vids = [];
        const shelves = Array.from({ length: SH }, (_, k) => ({ title: 'Shelf ' + k, items: Array.from({ length: N }, (_, i) => { const v = { id: 'h' + k + '_' + i, title: 'Video ' + k + '.' + i, channel: 'C', duration_s: 4053, meta: ['1K views'] }; vids.push(v); return v; }) }));
        const feeds0 = d.cmds('feed').length;
        d.send({ ev: 'auth', state: 'signed_in' });
        await until(() => d.cmds('feed').length === feeds0 + 2, 2000, 'Home asks for its feed and Watch later');
        assert.deepStrictEqual(d.cmds('feed').slice(feeds0).map((x) => x.which), ['home', 'wl']);
        d.send({ ev: 'feed', which: 'home', items: vids.slice(0, 20), shelves });
        d.send({ ev: 'feed', which: 'wl', items: [{ id: 'w1', title: 'Later', channel: 'C' }], shelves: [] });
        // the daemon answers every thumb asked (a 320x180 one), as the screens draw
        let served = d.cmds('thumb').length;
        const serve = async () => {
            await sleep(25);
            d.cmds('thumb').slice(served).forEach((x) => d.send({ ev: 'thumb', id: x.id, w: 320, h: 180, rgba: Buffer.alloc(320 * 180 * 4, 60).toString('base64') }));
            served = d.cmds('thumb').length;
            await sleep(25);
        };
        await sleep(100);
        await drawn(); await serve(); await drawn();
        assert.ok(texts.indexOf('Shelf 0') >= 0, 'titled shelves: ' + texts.slice(0, 20).join('|'));
        const at = (re) => disp.pageTargets.find((x) => re.test(x.key));
        const view = { x0: 0, x1: 1600, y0: 38, y1: 520 + (disp.place.extra || 0) };
        const inView = (t) => t.x >= view.x0 && t.x + t.w <= view.x1 && t.y >= view.y0 - 12 && t.y + t.h <= view.y1 + 12;
        // the chevron: Shelf 0 (row 0) turned by four
        const inX = (t) => t && t.x >= view.x0 && t.x + t.w <= view.x1;
        assert.ok(!inX(at(/^h:0:h0_4$/)), 'the 5th tile not whole at first');
        at(/^h:0:>$/).run();
        await drawn();
        assert.ok(inX(at(/^h:0:h0_4$/)) && at(/^h:0:<$/) && !at(/^h:0:h0_2$/), 'the arrow turned the shelf by four (and the back arrow shows)');
        at(/^h:0:<$/).run();
        await drawn();
        // the controller through every video of every shelf, as turning the knob would: each brought into view
        const ids = new Set();
        for (const v of vids) {
            const t = at(new RegExp('^h:\\d+:' + v.id + '$'));
            assert.ok(t, 'a target for ' + v.id + ' next to the one before: ' + disp.pageTargets.map((x) => x.key));
            disp._focus({ k: 'tgt:' + t.key, tgt: t });
            await drawn(); await serve(); await drawn();
            const t2 = disp.pageTargets.find((x) => x.key === t.key);
            assert.ok(t2 && inView(t2), v.id + ' brought into view: ' + JSON.stringify(t2));
            const pics = frame().pics;
            assert.ok(pics.every(POOL) && new Set(pics).size === pics.length && pics.length <= 56, 'pictures from the pool, each once: ' + pics);
            ids.add(v.id);
        }
        const all = new Set(frame().all);
        assert.ok([...all].every(POOL) && all.size <= 56 && ids.size > 56, 'over ' + ids.size + ' videos drawn, ' + all.size + ' picture ids reused: ' + [...all].sort((a, b) => a - b));
        assert.ok(disp.pageTargets.some((x) => /^h:\d+:w1$/.test(x.key)), 'Watch later is the last shelf');
        console.log('ok   Home shelves: arrows, the controller scrolls any tile into view, the picture pool (' + all.size + ' ids)');
        // the rail: Subscriptions
        at(/^rail:subs$/).run();
        await until(() => d.cmds('feed').slice(-1)[0].which === 'subs', 2000, 'the rail opens Subscriptions');
        await until(() => d.cmds('channels').length, 2000, 'and asks for the channels');
        d.send({ ev: 'channels', items: [{ id: 'UCdemo000000000000000001', title: 'Demo Detailing', handle: '@demo' }, { id: 'UCdemo000000000000000002', title: 'Élise Atelier', handle: '@elise' }] });
        for (let k = 0; k < 100 && !disp.pageTargets.some((x) => x.key === 's:0:UCdemo000000000000000002'); k++) { await sleep(20); await hu.loopFn(); }
        assert.ok(disp.pageTargets.some((x) => x.key === 's:0:UCdemo000000000000000002'), 'the channels row: ' + disp.pageTargets.map((x) => x.key).slice(0, 12));
        assert.ok(disp.pageTargets.some((x) => x.key === 's:0:::find'), 'Search channels first');
        disp.onPageFocus('s:0:UCdemo000000000000000002');
        disp.pageTargets.find((x) => x.key === 's:0:UCdemo000000000000000002').run();
        await lastIs(d, { cmd: 'channel', id: 'UCdemo000000000000000002' }, 'a channel opens its page');
        assert.ok(disp.onBack(false) === false, 'on a channel, pushed left moves along the page first');
        assert.ok(disp.onBack(true) === true, 'pushed left at its edge: back');
        await hu.loopFn();
        assert.ok(disp.pageTargets.some((x) => x.key === 's:0:UCdemo000000000000000002'), 'back on Subscriptions');
        assert.strictEqual(disp.focusKey, 'tgt:s:0:UCdemo000000000000000002', 'on the channel it opened');
        console.log('ok   Subscriptions: the channels row (Search channels, then A-Z); a channel opens its page, back at its edge');
        // a channel's page: Hide this channel first; hidden, its videos leave Subscriptions (members-only ones too, a setting)
        d.send({ ev: 'feed', which: 'subs', items: [{ id: 'HHHHHHHHHH1', title: 'From Elise', channel: 'Élise Atelier', duration_s: 90 },
            { id: 'HHHHHHHHHH2', title: 'Perk', channel: 'Other', duration_s: 90, members: true }, { id: 'HHHHHHHHHH3', title: 'Free', channel: 'Other', duration_s: 90 }], shelves: [] });
        disp.onPageFocus('s:0:UCdemo000000000000000002');
        disp.pageTargets.find((x) => x.key === 's:0:UCdemo000000000000000002').run();
        d.send({ ev: 'channel', id: 'UCdemo000000000000000002', items: [{ id: 'HHHHHHHHHH1', title: 'From Elise', channel: 'Élise Atelier', duration_s: 90 }] });
        await sleep(100); await hu.loopFn();
        const hide = disp.pageTargets.find((x) => /^c:0:::hide$/.test(x.key));
        assert.ok(hide, 'Hide this channel on its page: ' + disp.pageTargets.map((x) => x.key));
        assert.ok(disp.pageTargets.some((x) => x.key === 'c:0:HHHHHHHHHH1'), 'its videos still on its own page');
        hide.run();
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'hidden.json'), 'utf8')), ['Élise Atelier'], 'kept in hidden.json');
        disp.onBack(true); await hu.loopFn();
        const subKeys = disp.pageTargets.map((x) => x.key).filter((k) => /HHHHHHHHHH/.test(k));
        assert.deepStrictEqual(subKeys.map((k) => k.slice(-1)), ['3'], 'Subscriptions: the hidden channel\'s and the members-only videos gone: ' + subKeys);
        disp.onPageFocus('s:0:UCdemo000000000000000002');
        disp.pageTargets.find((x) => x.key === 's:0:UCdemo000000000000000002').run();
        await hu.loopFn();
        disp.pageTargets.find((x) => /^c:0:::hide$/.test(x.key)).run();          // Show this channel
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'hidden.json'), 'utf8')), [], 'shown again');
        disp.onBack(true); await hu.loopFn();
        console.log('ok   Hide this channel (its page), hidden from Subscriptions; members-only videos hidden by default');
        // the controller resting ~1 s on a known video: its stream lookup asked once; a pass over one: nothing
        const rq = d.cmds('search').slice(-1)[0].q;
        d.send({ ev: 'results', q: rq, items: [{ id: 'ABCDEFGHIJK', title: 'Saved' }, { id: 'ZYXWVUTSRQP', title: 'Other' }] });
        await sleep(100);
        disp.onPageFocus('r:0:ZYXWVUTSRQP');
        await sleep(300);
        disp.onPageFocus('r:0:ABCDEFGHIJK');
        await sleep(1300);
        assert.deepStrictEqual(d.cmds('prefetch'), [{ cmd: 'prefetch', id: 'ABCDEFGHIJK' }], 'only the rested-on one');
        console.log('ok   prefetch: a video the controller rests on 1 s is looked up ahead');
        // autoplay: a tile played from a row; when it ends, the next one in that row plays after 5 s
        hu.handlers.BTN_RESULTS();
        let tile = null;
        for (let k = 0; k < 100 && !(tile = at(/^r:\d+:ABCDEFGHIJK$/)); k++) { await sleep(20); await hu.loopFn(); }
        assert.ok(tile, 'the result on its page: ' + disp.pageTargets.map((x) => x.key).slice(0, 10));
        tile.run();
        await until(() => (d.cmds('play').slice(-1)[0] || {}).id === 'ABCDEFGHIJK', 2000, 'played');
        d.send({ ev: 'state', state: 'playing', id: 'ABCDEFGHIJK' });
        d.send({ ev: 'state', state: 'ended', id: 'ABCDEFGHIJK' });
        await sleep(100); await hu.loopFn();
        assert.ok(!d.cmds('play').some((x) => x.id === 'ZYXWVUTSRQP'), 'not at once');
        for (let k = 0; k < 40 && !d.cmds('play').some((x) => x.id === 'ZYXWVUTSRQP'); k++) { await sleep(200); await hu.loopFn(); }
        assert.ok(d.cmds('play').some((x) => x.id === 'ZYXWVUTSRQP'), 'the next one in the row plays');
        console.log('ok   autoplay: the next video in the row, 5 s after the end');

        // Playlists: a playlist plays on past its grid's row of four; members-only videos left out (the setting's default)
        hu.handlers.BTN_PL();
        await until(() => d.cmds('playlists').length, 2000, 'Playlists asked');
        d.send({ ev: 'playlists', items: [{ id: 'PLtest000001', title: 'Six', count: 6, meta: ['Private'], thumb: 'plvideo0001' }] });
        let pt = null;
        for (let k = 0; k < 100 && !(pt = at(/^p:\d+:PLtest000001$/)); k++) { await sleep(20); await hu.loopFn(); }
        assert.ok(pt, 'the playlist tile: ' + disp.pageTargets.map((x) => x.key).slice(0, 10));
        pt.run();
        await until(() => d.cmds('playlist').length, 2000, 'its videos asked');
        assert.deepStrictEqual(d.cmds('playlist')[0], { cmd: 'playlist', id: 'PLtest000001' });
        const six = Array.from({ length: 6 }, (_, i) => ({ id: 'plvideo000' + (i + 1), title: 'Part ' + (i + 1), channel: 'C', duration_s: 60 }));
        six[1].members = true;
        d.send({ ev: 'playlist', id: 'PLtest000001', title: 'Six', items: six });
        let fifth = null;
        for (let k = 0; k < 100 && !(fifth = at(/^l:\d+:plvideo0005$/)); k++) { await sleep(20); await hu.loopFn(); }
        assert.ok(fifth, 'its videos: ' + disp.pageTargets.map((x) => x.key).slice(0, 10));
        assert.ok(!at(/^l:\d+:plvideo0002$/), 'the members-only one left out');
        await sleep(300); await drawn();   // (a frame redrawn: the app redraws a changed page, else every 250 ms)
        assert.ok(texts.indexOf('5 videos · 1 hidden') >= 0, 'and said so: ' + texts.slice(0, 12).join('|'));
        // shown: 1 3 4 5 | 6 - the 5th ends the first row; the 6th, on the next row, plays after it
        fifth.run();
        await until(() => (d.cmds('play').slice(-1)[0] || {}).id === 'plvideo0005', 2000, 'played');
        d.send({ ev: 'state', state: 'playing', id: 'plvideo0005' });
        d.send({ ev: 'state', state: 'ended', id: 'plvideo0005' });
        for (let k = 0; k < 40 && !d.cmds('play').some((x) => x.id === 'plvideo0006'); k++) { await sleep(200); await hu.loopFn(); }
        assert.ok(d.cmds('play').some((x) => x.id === 'plvideo0006'), 'the next one in the playlist plays, on the next row');
        console.log('ok   playlists: a playlist plays on past its row of four; members-only videos left out');

        // the steering wheel's skip rocker (SteeringWheelPushButton.statusSearchSwitch1: 2 up = next, 1 down = previous,
        // 0 released) in the playlist above (shown: 1 3 4 5 6; 5 was played, 6 came after it): a tap past the end does
        // nothing; previous within 3 s goes to the one before, later back to the start; next goes on again; the same value
        // again is one press, no signal nothing; held, it seeks; while browsing, a skip plays without showing the player
        assert.strictEqual(rockerIface, 'de.bmw.infotainment.controlelements.SteeringWheelPushButton/1', 'the rocker watched');
        const plays = () => d.cmds('play').map((x) => x.id);
        const rock = (v) => rockerH({ operationPushButtonAudioAutomaticTuningSteeringWheel: v });
        const wheel = async (b) => { rock(b === 'next' ? 2 : 1); rock(0); await sleep(80); await hu.loopFn(); };
        const on = async (id, ms) => { d.send({ ev: 'state', state: 'playing', id }); d.send({ ev: 'time', elapsed: ms, total: 60000 }); await sleep(60); };
        await on('plvideo0006', 1000);
        let n0 = plays().length;
        await wheel('next');
        assert.strictEqual(plays().length, n0, 'next at the end of the list: nothing');
        await wheel('prev');
        assert.deepStrictEqual(plays().slice(n0), ['plvideo0005'], 'previous within 3 s: the one before');
        await on('plvideo0005', 5000);
        const nSeek0 = d.cmds('seek').length;
        await wheel('prev');
        assert.deepStrictEqual(d.cmds('seek').slice(nSeek0), [{ cmd: 'seek', ms: 0 }], 'previous 5 s in: back to the start');
        await on('plvideo0005', 500);
        await wheel('prev');
        assert.deepStrictEqual(plays().slice(n0), ['plvideo0005', 'plvideo0004'], 'and again within 3 s: the one before that');
        await on('plvideo0004', 500);
        await wheel('next'); await wheel('next');
        assert.deepStrictEqual(plays().slice(n0), ['plvideo0005', 'plvideo0004', 'plvideo0005', 'plvideo0006'], 'next, next: back through the list');
        await on('plvideo0006', 500);
        const n1 = plays().length;
        rock('SUCHLAUF_ABWAERTS_MENUE_SKIP_LINKS'); rock('SUCHLAUF_ABWAERTS_MENUE_SKIP_LINKS'); rock('SUCHLAUF_ABWAERTS_MENUE_SKIP_LINKS'); rock(3); rock(0);
        await sleep(80); await hu.loopFn();
        assert.deepStrictEqual(plays().slice(n1), ['plvideo0005'], 'a quick press (enum names, the same value again): one step; no signal: nothing');
        await on('plvideo0005', 500);
        await wheel('next');
        // held: it seeks instead (after 600 ms, 10 s a step every 300 ms), one seek once let go, no skip; a "no signal"
        // in between does not end it; held back: as far back, never before the start
        await on('plvideo0006', 10000);
        const nP = plays().length, nS = d.cmds('seek').length;
        rock(2); await sleep(700); rock(3); await sleep(750); rock(0);    // steps at 600, 900, 1200 ms
        await sleep(500); await hu.loopFn();
        let sk = d.cmds('seek').slice(nS);
        assert.strictEqual(plays().length, nP, 'held: no skip');
        assert.ok(sk.length === 1 && sk[0].ms >= 30000 && sk[0].ms <= 50000, 'held next: one seek, 20-40 s on: ' + JSON.stringify(sk));
        await on('plvideo0006', sk[0].ms);
        rock(1); await sleep(1900); rock(0);                                  // 5 steps back: 50 s, past the start
        await sleep(500); await hu.loopFn();
        sk = d.cmds('seek').slice(nS + 1);
        assert.deepStrictEqual([plays().length, sk], [nP, [{ cmd: 'seek', ms: 0 }]], 'held previous: back to the start at most, no skip');
        await on('plvideo0006', 500);
        hu.handlers.BTN_HOME();                                        // browsing, the sound playing on
        await sleep(100); await hu.loopFn();
        await wheel('prev');
        assert.strictEqual(plays().slice(-1)[0], 'plvideo0005', 'while browsing: previous plays');
        await sleep(100); await hu.loopFn();
        assert.ok(disp.pageTargets.some((t) => /^rail:/.test(t.key)) && !disp.pageTargets.some((t) => t.key === 'ov:play'), 'and the page stays: ' + disp.pageTargets.map((t) => t.key).slice(0, 6));
        console.log('ok   steering wheel next / previous: a tap skips through the list (previous to the start after 3 s), held seeks, browsing stays');
    }
    // the wrong clock (secure connections need the correct date): the warning once an app session over the page shown,
    // OK (or any page) closes it; the menu's info line says it while it lasts; nothing from a service that never says
    {
        const WARN = 'Security warning', tgt = (k) => disp.pageTargets.find((x) => x.key === k);
        const MSG = 'The head unit\'s clock looks wrong (it says 2026-10-13). Set the car\'s date and time to connect securely to YouTube.';
        const infos = [], ut = hu.ui.text;
        hu.ui.text = function (n, t) { if (n === 'MAIN_INFO') infos.push(String(t)); return ut.apply(this, arguments); };
        hu.handlers.BTN_HOME();
        await drawn();
        assert.ok(texts.indexOf(WARN) < 0, 'a service that never said clock: no warning');
        d.send({ ev: 'clock', clock: '2026-10-13' });
        await sleep(100); await drawn();
        assert.ok(texts.indexOf(WARN) >= 0, 'the warning: ' + texts.join('|'));
        const at = texts.indexOf(WARN) + 1;
        assert.strictEqual(texts.slice(at, at + 6).join(' ').slice(0, MSG.length), MSG, 'the whole warning, wrapped');
        if (own) {
            assert.ok(tgt('clock:ok'), 'OK to dismiss: ' + keys());
            tgt('clock:ok').run();
        } else hu.handlers.BTN_SUBS();        // (the HMI's own screen: no OK drawn, any page goes on)
        await drawn();
        assert.ok(texts.indexOf(WARN) < 0, 'dismissed');
        if (own) assert.ok(tgt('rail:home'), 'back on the page it showed over: ' + keys());
        d.send({ ev: 'clock', clock: '2026-10-14' });
        await sleep(100); await drawn();
        hu.handlers.BTN_WL(); await drawn();
        assert.ok(texts.indexOf(WARN) < 0, 'once an app session');
        // (the stub never shows MAIN, whose 1 s refresh writes the line: Close, with nothing playing, writes it too)
        hu.handlers.BTN_CLOSE();
        assert.ok(infos.length && infos.slice(-1)[0].indexOf('Wrong clock (2026-10-14) · ') === 0, 'the info line: ' + infos.slice(-1));
        d.send({ ev: 'clock', clock: null });
        await sleep(100);
        hu.handlers.BTN_CLOSE();
        assert.ok(infos.slice(-1)[0].indexOf('Wrong clock') < 0, 'set right: the line goes: ' + infos.slice(-1));
        hu.ui.text = ut;
        console.log('ok   wrong clock: the warning once, OK closes it, the info line while it lasts, nothing from an older service');
    }
    // Send logs to the developer: the menu entry asks first (Send / Cancel), then the code; the error screen's second button
    {
        const ASK = 'Send RideTube\'s recent logs to the developer?', tgt = (k) => disp.pageTargets.find((x) => x.key === k);
        const sends = () => d.cmds('send_logs').length;
        const APP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'jap_ridetube', 'app.json'), 'utf8')).version;
        d.send({ ev: 'hello', service: '0.4.6', caps: ['logs'] });
        await sleep(100);
        hu.handlers.BTN_LOGS();
        await drawn();
        assert.ok(texts.indexOf(ASK) >= 0 && texts.indexOf('Account details and the videos you watched are removed first.') >= 0, texts.join('|'));
        assert.strictEqual(sends(), 0, 'nothing sent before the confirm');
        if (own) {
            assert.ok(tgt('logs:send') && tgt('logs:cancel'), 'Send and Cancel: ' + keys());
            tgt('logs:cancel').run();
            await drawn();
            assert.ok(texts.indexOf(ASK) < 0 && sends() === 0, 'Cancel: back, nothing sent');
            hu.handlers.BTN_LOGS();
            await drawn();
            hu.handlers.BTN_LOGS();             // the menu entry again where Send is drawn: still just the question
            await sleep(50);
            assert.strictEqual(sends(), 0, 'the menu entry pressed twice does not skip Send / Cancel');
            disp.onPageFocus('logs:send'); disp.onScroll(100);   // the controller on Send, a turn: no throw
            await drawn();
            tgt('logs:send').run();
        } else hu.handlers.BTN_LOGS();          // (the HMI's own screen: the menu entry again)
        await until(() => sends() === 1, 2000, 'send_logs sent');
        assert.deepStrictEqual(d.cmds('send_logs')[0], { cmd: 'send_logs', app: APP }, 'with the app\'s version');
        await drawn();
        assert.ok(texts.indexOf('Sending...') >= 0, texts.join('|'));
        d.send({ ev: 'logs_sent', id: 'ABC123' });
        await sleep(100); await drawn();
        assert.ok(texts.indexOf('Sent. Add this code to your GitHub issue:') >= 0 && texts.indexOf('ABC123') >= 0, texts.join('|'));
        // an error from the service: its sentence; an older service: says so, and no playback error from it
        hu.handlers.BTN_LOGS();
        if (own) { await drawn(); tgt('logs:send').run(); } else hu.handlers.BTN_LOGS();
        await until(() => sends() === 2, 2000, 'second report');
        d.send({ ev: 'logs_error', msg: 'busy' });
        await sleep(100); await drawn();
        assert.ok(texts.indexOf('Too many reports right now - try again later') >= 0, texts.join('|'));
        if (own) { tgt('logs:send').run(); await until(() => sends() === 3, 2000, 'Try again sends again'); } else { hu.handlers.BTN_LOGS(); hu.handlers.BTN_LOGS(); await until(() => sends() === 3, 2000, 'again'); }
        d.send({ ev: 'error', msg: 'unknown cmd send_logs' });
        await sleep(100); await drawn();
        assert.ok(texts.indexOf('Sending logs needs a newer jap-ridetube-d tool on the car') >= 0, texts.join('|'));
        if (own) {
            // the player's error screen: Send logs beside Try again opens the same page
            d.send({ ev: 'state', state: 'error', id: 'lib1' });
            d.send({ ev: 'error', msg: 'fetch: audio failed at 99 %' });
            hu.handlers.BTN_NOW();
            await sleep(100); await drawn();
            assert.ok(tgt('ov:play') && tgt('ov:logs') && texts.indexOf('Send logs') >= 0 && texts.indexOf('Try again') >= 0, 'Try again and Send logs: ' + keys());
            tgt('ov:logs').run();
            await drawn();
            assert.ok(texts.indexOf(ASK) >= 0 && tgt('logs:send'), 'the logs page asks');
            tgt('logs:cancel').run();
            await drawn();
            assert.ok(tgt('ov:logs'), 'Cancel: back on the error screen');
            d.send({ ev: 'state', state: 'idle' });
        }
        console.log('ok   send logs: asked first, Cancel sends nothing, Sending..., the code; the service\'s errors; the error screen\'s button');
    }
    if (own) await wp5Frames({ hu, d, disp, keys, drawn, texts, wp5, rock: (v) => rockerH({ operationPushButtonAudioAutomaticTuningSteeringWheel: v }), speed: (v) => speedH({ speedVehicleCentreOfGravity: v }) });
    else console.log('skip WP5 frames (the stub does not run the screen)');
    if (own) await wp7Frames({ hu, d, disp, drawn, texts, file, hmiLang, speed: (v) => speedH({ speedVehicleCentreOfGravity: v }) });
    Recorder.prototype.text = ot; Recorder.prototype.fillRect = of;
    d.server.close();
}

function extrasModel() {
    const m = new Model(() => true);
    m.onMsg({ ev: 'positions', items: [{ id: 'AAAAAAAAAAA', ms: 60000, total: 600000, done: false, title: 'Half' }, { id: 'BBBBBBBBBBB', ms: 590000, total: 600000, done: true, title: 'Seen' },
        { id: 'CCCCCCCCCCC', ms: 5000, total: 600000, done: false, title: 'Barely' }, { id: 'bad' }] });
    assert.deepStrictEqual(m.resume.map((r) => r.id), ['AAAAAAAAAAA'], 'Continue watching: started, not finished');
    assert.deepStrictEqual(Object.keys(m.pos).sort(), ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'], 'every position for the bars');
    assert.ok(m._known('AAAAAAAAAAA'), 'its thumb can be asked');
    m.onMsg({ ev: 'state', state: 'playing', id: 'AAAAAAAAAAA', title: 'Half' });
    m.onMsg({ ev: 'extras', id: 'AAAAAAAAAAA', chapters: [[0, 'Intro'], [30000, 'Main'], 'x'], segments: [[10000, 20000, 'sponsor'], [5, 1]] });
    assert.strictEqual(m.extras.chapters.length, 2); assert.strictEqual(m.extras.segments.length, 1);
    m.onMsg({ ev: 'time', elapsed: 31000, total: 600000 });
    assert.strictEqual(m.chapter(), 'Main');
    m.onMsg({ ev: 'skipped', category: 'sponsor', ms: 10000 });
    assert.strictEqual(m.toast.text, 'Skipped sponsor · 0:10');
    m.onMsg({ ev: 'state', state: 'preparing', id: 'DDDDDDDDDDD' });
    m.onMsg({ ev: 'retry', id: 'DDDDDDDDDDD', n: 2, msg: 'boom' });
    assert.strictEqual(m.retry, 2, 'the network lost: trying again (2)');
    m.onMsg({ ev: 'state', state: 'playing', id: 'DDDDDDDDDDD' });
    assert.strictEqual(m.retry, 0, 'playing: no more retry note');
    console.log('ok   extras: Continue watching, positions, chapters, the skipped toast');
}

// the log report's states: one at a time, the service's answers, an older service, no answer, the service gone
function logsModel() {
    const sent = [];
    let up = true;
    const m = new Model((o) => { if (!up) return false; sent.push(o); return true; });
    m.connected = true;
    m.askLogs(); assert.deepStrictEqual(m.logs, { state: 'confirm' });
    m.dropLogs(); assert.strictEqual(m.logs, null);
    assert.ok(m.sendLogs('0.3.12')); assert.deepStrictEqual(sent.pop(), { cmd: 'send_logs', app: '0.3.12' });
    assert.ok(!m.sendLogs('0.3.12') && !sent.length, 'one at a time');
    m.askLogs(); m.dropLogs(); assert.strictEqual(m.logs.state, 'sending', 'not dropped while on its way');
    m.onMsg({ ev: 'logs_sent', id: 'ABC123' }); assert.deepStrictEqual(m.logs, { state: 'sent', code: 'ABC123' });
    m.onMsg({ ev: 'logs_sent', id: 'XYZ999' }); assert.strictEqual(m.logs.code, 'ABC123', 'an answer nobody waits for: ignored');
    [['closed', 'closed'], ['busy', 'busy'], ['offline', 'offline'], ['failed', 'failed'], ['<raw relay text>', 'failed']].forEach(([msg, want]) => {
        m.sendLogs('0.3.12'); m.onMsg({ ev: 'logs_error', msg }); assert.deepStrictEqual(m.logs, { state: 'error', msg: want }, msg);
    });
    m.sendLogs('0.3.12'); m.onMsg({ ev: 'logs_sent', id: '<b>x</b>' }); assert.deepStrictEqual(m.logs, { state: 'error', msg: 'failed' }, 'an odd code is not shown');
    m.sendLogs('0.3.12'); m.onMsg({ ev: 'error', msg: 'unknown cmd send_logs' });
    assert.deepStrictEqual([m.logs.msg, m.error], ['old', null], 'an older service: said on the page, not a playback error');
    m.sendLogs('0.3.12');
    assert.ok(!m.checkLogs(Date.now() + 1000, 45000) && m.checkLogs(Date.now() + 46000, 45000) && m.logs.msg === 'failed', 'no answer in 45 s: failed');
    m.sendLogs('0.3.12'); m.setConnected(false); assert.deepStrictEqual(m.logs, { state: 'error', msg: 'failed' }, 'the service gone');
    up = false; assert.ok(!m.sendLogs('0.3.12') && m.logs.msg === 'failed', 'not connected: not sent');
    console.log('ok   log report states: one at a time, closed / busy / offline / failed, an older service, no answer');
}

function channelSearch() {
    const m = new Model(() => true);
    m.auth.state = 'signed_in';
    m.loadChannels();
    m.onMsg({ ev: 'channels', items: [{ id: 'UCdemo000000000000000001', title: 'Demo Detailing', handle: '@demo_detailing' },
        { id: 'UCdemo000000000000000002', title: 'Élise Atelier', handle: '@eliseatelier' }, { id: 'UCdemo000000000000000003', title: 'Arcadia', handle: '@arcadia' }, { id: 'bad', title: 'x' }] });
    const ids = (q) => m.findChannels(q).map((c) => c.title);
    assert.deepStrictEqual(ids(''), ['Demo Detailing', 'Élise Atelier', 'Arcadia'], 'all, a bad id dropped');
    assert.deepStrictEqual(ids('e'), ['Élise Atelier'], 'one letter: names starting with it, accents aside');
    assert.deepStrictEqual(ids('A'), ['Arcadia'], 'case aside');
    assert.deepStrictEqual(ids('atelier'), ['Élise Atelier'], 'a word: names holding it');
    assert.deepStrictEqual(ids('ar'), ['Arcadia'], 'two letters: held, not only at the start');
    assert.deepStrictEqual(ids('demo_d'), ['Demo Detailing'], 'the @handle too');
    console.log('ok   channel search: a letter = the names starting with it, a word = the names (or handles) holding it');
}

// ======== WP0 foundations: hello and the caps
async function helloCaps() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-hello-'));
    const sock = path.join(dir, 'ctl.sock');
    const d = await fakeDaemon(sock);
    const ctl = new Ctl(sock, quiet);
    const m = new Model((o) => ctl.send(o), { app: '0.4.0', lang: 'zh', region: 'CN' });
    ctl.on('up', () => m.setConnected(true)).on('down', () => m.setConnected(false)).on('msg', (x) => m.onMsg(x));
    ctl.connect();
    await until(() => d.cmds('hello').length, 2000, 'hello on connect');
    assert.deepStrictEqual(d.got.map((x) => x.cmd).slice(0, 4), ['hello', 'status', 'auth_status', 'positions'], 'hello first (an old service answers it unknown and goes on)');
    assert.deepStrictEqual(d.cmds('hello')[0], { cmd: 'hello', app: '0.4.0', lang: 'zh', region: 'CN' });
    // an old service: unknown cmd hello = no caps, not an error, a search in flight goes on
    assert.ok(m.search('old service'));
    d.send({ ev: 'error', msg: 'unknown cmd hello' });
    await sleep(50);
    assert.deepStrictEqual([m.caps, m.error, m.searching, m.can('related')], [[], null, true, false], 'old service: no caps, nothing shown');
    // a 0.4.0 service: the caps it lists (strings only); a frozen command it has not built is not an error on screen
    d.send({ ev: 'hello', service: '0.4.0', caps: ['related', 'hist', 7, null] });
    await until(() => m.caps.length, 2000, 'caps');
    assert.deepStrictEqual(m.caps, ['related', 'hist']);
    assert.ok(m.can('related') && m.can('hist') && !m.can('health'));
    d.send({ ev: 'error', cmd: 'health', msg: 'not implemented health' });
    await sleep(50);
    assert.deepStrictEqual([m.error, m.searching], [null, true], 'not implemented: nothing shown');
    // a later package's event reaches its ev_<name> method; an event nobody handles changes nothing
    const rev = m.rev, got = [];
    m.ev_related = (x) => got.push(x.id);
    d.send({ ev: 'related', id: 'abcdefghijk', items: [] });
    d.send({ ev: 'nobody' });
    await until(() => got.length, 2000, 'ev_related');
    await sleep(50);
    assert.deepStrictEqual([got, m.rev], [['abcdefghijk'], rev + 1], 'handled once, one change');
    // the wrong clock: hello's clock (a date only), clock events after it; an old service or one with the clock right: none
    assert.strictEqual(m.clock, null, 'no clock from a 0.4.0 hello without it');
    d.send({ ev: 'hello', service: '0.4.0', caps: ['related', 'hist'], clock: '2026-10-13' });
    await until(() => m.clock, 2000, 'hello clock');
    assert.deepStrictEqual([m.clock, m.caps], ['2026-10-13', ['related', 'hist']]);
    for (const [x, want] of [['2026-10-14', '2026-10-14'], [null, null], ['2026-10-15', '2026-10-15'], ['<b>bad</b>', null], [20261013, null]]) {
        d.send({ ev: 'clock', clock: x });
        await until(() => m.clock === want, 2000, 'clock ' + x);
    }
    d.send({ ev: 'clock', clock: '2026-10-13' });
    await until(() => m.clock, 2000, 'clock again');
    d.conn.destroy();
    await until(() => !m.connected, 2000, 'down');
    assert.deepStrictEqual(m.caps, [], 'the service gone: no caps until it says again');
    assert.strictEqual(m.clock, null, 'nor a clock');
    ctl.close();
    d.server.close();
    console.log('ok   hello: sent on connect with the build language; an old service = no caps; caps gate; ev_<name> hook');
}

// ======== WP5 app 0.4.0: History, the health check, watch-next, the wheel's next, the resume notice, lists and Shorts
function wp5Model() {
    const sent = [];
    const m = new Model((o) => { sent.push(o); return true; });
    m.connected = true; m.auth.state = 'signed_in';
    // old service: nothing new is asked
    assert.ok(!m.loadRelated('AAAAAAAAAAA') && !m.runHealth() && !sent.length, 'no caps: no related, no health');
    m.onMsg({ ev: 'hello', service: '0.4.0', caps: ['related', 'health', 'hist'] });
    // lists: 100 a feed or a playlist, 100 results
    const n = (k) => Array.from({ length: k }, (_, i) => ({ id: ('v' + i + 'xxxxxxxxxx').slice(0, 11) }));
    m.feed('hist'); assert.deepStrictEqual(sent.pop(), { cmd: 'feed', which: 'hist' }, 'History is a feed');
    m.onMsg({ ev: 'feed', which: 'hist', items: n(130) }); assert.strictEqual(m.feeds.hist.items.length, 100, 'History: at most 100');
    m.q = 'q'; m.onMsg({ ev: 'results', q: 'q', items: n(130) }); assert.strictEqual(m.results.length, 100, 'results: at most 100');
    m.openPlaylist('PLaaaaaaaaaa'); m.onMsg({ ev: 'playlist', id: 'PLaaaaaaaaaa', items: n(130) }); assert.strictEqual(m.plist.items.length, 100, 'a playlist: at most 100');
    m.onMsg({ ev: 'feed', which: 'hist', items: [{ id: 'SHORT000001', short: true }] }); assert.strictEqual(m.feeds.hist.items[0].short, true, 'short:true kept (main.js filters)');
    const shorts = n(120).map((r) => Object.assign({ short: true }, r));
    m.onMsg({ ev: 'feed', which: 'hist', items: shorts.slice(0, 90).concat(n(5)) });
    assert.deepStrictEqual([m.feeds.hist.items.length, m.feeds.hist.items.filter((r) => !r.short).length], [95, 5], 'Shorts never push videos past the cap');
    m.onMsg({ ev: 'feed', which: 'hist', items: shorts.concat(n(130)) });
    assert.deepStrictEqual([m.feeds.hist.items.filter((r) => r.short).length, m.feeds.hist.items.filter((r) => !r.short).length], [100, 100], 'at most 100 of each');
    // related: asked once per id, another id's late answer ignored, its videos known; an error ends it; no answer in 15 s
    let told = 0;
    m.onRelated = () => told++;
    assert.ok(m.loadRelated('AAAAAAAAAAA') && !m.loadRelated('AAAAAAAAAAA') && !m.loadRelated('bad'), 'asked once, a bad id never');
    assert.deepStrictEqual(sent.pop(), { cmd: 'related', id: 'AAAAAAAAAAA' });
    m.onMsg({ ev: 'related', id: 'ZZZZZZZZZZZ', items: [{ id: 'XXXXXXXXXXX' }] });
    assert.ok(m.related.loading && !told, "another video's answer ignored");
    m.onMsg({ ev: 'related', id: 'AAAAAAAAAAA', items: [{ id: 'RRRRRRRRRRR', title: 'Next' }, { bad: 1 }] });
    assert.deepStrictEqual([m.related.loading, m.related.items.map((x) => x.id), told, !!m.item('RRRRRRRRRRR')], [false, ['RRRRRRRRRRR'], 1, true], 'its videos, told once, known');
    m.loadRelated('BBBBBBBBBBB'); m.onMsg({ ev: 'related', id: 'BBBBBBBBBBB', error: 'feed offline' });
    assert.deepStrictEqual([m.related.error, m.error], ['feed offline', null], 'an error is the list\'s, not playback\'s');
    m.loadRelated('CCCCCCCCCCC');
    assert.ok(!m.checkFeeds(Date.now() + 1000, 15000) && m.checkFeeds(Date.now() + 16000, 15000) && /No answer/.test(m.related.error), 'no answer in 15 s');
    // health: rows as they come (a key again replaces its row), done; one run at a time; a minute per row
    assert.ok(m.runHealth() && !m.runHealth(), 'one run at a time');
    assert.deepStrictEqual(sent.pop(), { cmd: 'health' });
    m.onMsg({ ev: 'health', key: 'dns', ok: true, text: 'ok' }); m.onMsg({ ev: 'health', key: 'tls', ok: false, text: 'timeout' });
    m.onMsg({ ev: 'health', key: 'dns', ok: false, text: 'no answer' }); m.onMsg({ ev: 'health', ok: true });
    assert.ok(!m.checkFeeds(Date.now() + 30000, 15000) && m.health.loading, 'a slow check: still waiting at 30 s');
    m.onMsg({ ev: 'health', done: true });
    assert.deepStrictEqual([m.health.loading, m.health.items], [false, [{ key: 'dns', ok: false, text: 'no answer' }, { key: 'tls', ok: false, text: 'timeout' }]], 'two rows, done');
    m.onMsg({ ev: 'health', key: 'late', ok: true, text: '' }); assert.strictEqual(m.health.items.length, 2, 'a row after done: ignored');
    m.runHealth(); assert.ok(m.checkFeeds(Date.now() + 61000, 15000) && /No answer/.test(m.health.error), 'no row for a minute: an error');
    // the resume notice: a fresh play whose first tick is past 10 s; not a quality change's restart; Start over seeks to 0
    m.play('RRRRRRRRRRR', '1x1', false);
    m.onMsg({ ev: 'state', state: 'playing', id: 'RRRRRRRRRRR' }); m.onMsg({ ev: 'time', elapsed: 754000, total: 1200000 });
    const now = Date.now(), r = m.resumedNow(now);
    assert.ok(r && r.ms === 754000 && r.until - now <= 5000 && r.until - now > 4000 && !m.resumedNow(now + 5100), 'resumed at 12:34, shown 5 s');
    m.startOver(); assert.deepStrictEqual([sent.pop(), m.resumedNow(now)], [{ cmd: 'seek', ms: 0 }, null], 'Start over: seek 0, the notice gone');
    m.quality('480'); m.onMsg({ ev: 'state', state: 'preparing', id: 'RRRRRRRRRRR' }); m.onMsg({ ev: 'state', state: 'playing', id: 'RRRRRRRRRRR' });
    m.onMsg({ ev: 'time', elapsed: 300000, total: 1200000 });
    assert.strictEqual(m.resumedNow(Date.now()), null, 'a quality change goes on from where it was: no notice');
    m.play('AAAAAAAAAAA', '1x1', false); m.onMsg({ ev: 'state', state: 'playing', id: 'AAAAAAAAAAA' }); m.onMsg({ ev: 'time', elapsed: 900, total: 60000 });
    m.onMsg({ ev: 'time', elapsed: 20000, total: 60000 });
    assert.strictEqual(m.resumedNow(Date.now()), null, 'from the start: no notice (later ticks never count)');
    console.log('ok   WP5 model: 100-item lists, related once per id, health rows, the resume notice');
}

// before the app starts: what the menu entries are told (visible), the speller (ctx.app read only by spell)
function wp5Spies(hu) {
    const o = { visible: [], spells: 0 };
    const v = hu.ui.visible;
    hu.ui.visible = (n, on) => { if (/^BTN_(HIST|HEALTH)$/.test(n)) o.visible.push([n, on]); return v(n, on); };
    Object.defineProperty(hu.ctx, 'app', { configurable: true, get() { o.spells++; return { usecase: null }; } });
    return o;
}

async function wp5Frames(x) {
    const { hu, d, disp, keys, drawn, texts, wp5, rock, speed } = x;
    const tgt = (k) => disp.pageTargets.find((t) => (k instanceof RegExp ? k.test(t.key) : t.key === k));
    const plays = () => d.cmds('play').map((p) => p.id);
    const railOk = () => {
        const r = disp.pageTargets.filter((t) => /^rail:/.test(t.key));
        r.forEach((t, i) => { if (i) assert.ok(r[i - 1].y + r[i - 1].h <= t.y + 1, 'rail targets do not overlap: ' + JSON.stringify(r.map((q) => [q.key, q.y, q.h]))); });
        return r.map((t) => t.key);
    };
    const parked = () => speed(0);
    const wheel = async () => { rock(2); rock(0); await sleep(80); };
    // an old service (no hello answer): no rail entry, the menu entries hidden, their handlers send nothing
    d.send({ ev: 'state', state: 'idle' });
    hu.handlers.BTN_HOME();
    await sleep(100); await drawn();
    assert.ok(railOk().indexOf('rail:hist') < 0, 'old service: no History on the rail');
    assert.deepStrictEqual(wp5.visible.filter((v) => v[1]), [], 'old service: the menu entries never shown');
    assert.ok(wp5.visible.some((v) => v[0] === 'BTN_HIST') && wp5.visible.some((v) => v[0] === 'BTN_HEALTH'), 'and hidden: ' + JSON.stringify(wp5.visible));
    hu.handlers.BTN_HIST(); hu.handlers.BTN_HEALTH();
    await sleep(100);
    assert.deepStrictEqual([d.cmds('feed').filter((f) => f.which === 'hist').length, d.cmds('health').length, d.cmds('related').length], [0, 0, 0], 'old service: nothing new asked');
    console.log('ok   WP5 old service: no History, no Health check, nothing new asked');
    // a 0.4.0 service
    d.send({ ev: 'hello', service: '0.4.0', caps: ['health', 'related', 'hist'] });
    await sleep(100); await drawn();
    assert.deepStrictEqual(wp5.visible.slice(-2), [['BTN_HIST', true], ['BTN_HEALTH', true]], 'the menu entries shown');
    assert.deepStrictEqual(railOk(), ['rail:search', 'rail:home', 'rail:subs', 'rail:wl', 'rail:network', 'rail:pl', 'rail:hist'], 'History on the rail');
    // History: a feed page; a Short hidden unless the setting shows them
    tgt('rail:hist').run();
    await until(() => d.cmds('feed').slice(-1)[0].which === 'hist', 2000, 'History asked');
    d.send({ ev: 'feed', which: 'hist', items: [{ id: 'HIST0000001', title: 'Watched one', channel: 'C', duration_s: 60 }, { id: 'SHORT000001', title: 'A short', channel: 'C', duration_s: 30, short: true },
        { id: 'HIST0000002', title: 'Watched two', channel: 'C', duration_s: 60 }] });
    await sleep(100); await drawn();
    assert.ok(tgt(/^h:0:HIST0000001$/) && tgt(/^h:0:HIST0000002$/) && !tgt(/SHORT000001/), 'History tiles, the Short left out: ' + keys());
    assert.ok(texts.indexOf('History') >= 0, 'titled History: ' + texts.slice(0, 12).join('|'));
    hu.ctx.settings.set('shorts', true);
    await sleep(300); await drawn();                       // (a setting redraws within 250 ms)
    assert.ok(tgt(/^h:0:SHORT000001$/), 'Show Shorts on: the Short shows');
    hu.ctx.settings.set('shorts', false);
    console.log('ok   WP5 History page (rail), Shorts only with the setting');
    // a live tile (live:true): a red LIVE tag where the length goes; a tap or a rest on it asks nothing, a note says why
    {
        const { Recorder } = require(path.join(hu.kitDir, 'record'));
        const rr = [], orr = Recorder.prototype.roundRect;
        Recorder.prototype.roundRect = function (x, y, w, h, r, c) { rr.push(c); return orr.apply(this, arguments); };
        d.send({ ev: 'feed', which: 'hist', items: [{ id: 'HIST0000001', title: 'Watched one', channel: 'C', duration_s: 60 }, { id: 'LIVE0000001', title: 'On air', channel: 'C', duration_s: null, live: true }] });
        await sleep(100); rr.length = 0; await drawn();
        assert.ok(texts.indexOf('LIVE') >= 0 && rr.indexOf('#cc0000') >= 0, 'the red LIVE tag: ' + texts.slice(0, 12).join('|'));
        assert.ok(texts.indexOf('1:00') >= 0, 'the other tile keeps its length');
        const nPlay = d.cmds('play').length, nPre = d.cmds('prefetch').length;
        disp.onPageFocus('h:0:LIVE0000001');
        await sleep(1300);
        tgt(/^h:0:LIVE0000001$/).run();
        await sleep(100); await drawn();
        assert.deepStrictEqual([d.cmds('play').length, d.cmds('prefetch').length], [nPlay, nPre], 'no play, no prefetch for a live video');
        assert.ok(texts.indexOf("Live videos can't be played yet") >= 0 && tgt(/^h:0:LIVE0000001$/), 'the note, the page stays: ' + texts.join('|'));
        tgt(/^h:0:HIST0000001$/).run();
        await until(() => d.cmds('play').length === nPlay + 1, 2000, 'a normal tile still plays');
        d.send({ ev: 'state', state: 'idle' });
        hu.handlers.BTN_LIST();
        Recorder.prototype.roundRect = orr;
        console.log('ok   live tile: red LIVE tag, a tap shows the note and asks nothing');
    }
    // the health check: run on opening, rows as they come, Run again
    hu.handlers.BTN_HEALTH();
    await until(() => d.cmds('health').length === 1, 2000, 'health asked');
    await drawn();
    assert.ok(texts.indexOf('Checking...') >= 0 && !tgt('health:run'), 'checking: ' + texts.join('|'));
    // (WP4's keys, in the order the probes end; shown in the service's order; "unknown" is not a failure)
    const HK = ['service', 'node', 'node22', 'python', 'ytdlp', 'uid', 'lease', 'dns', 'tls', 'free', 'audio', 'socket'];
    d.send({ ev: 'health', key: 'socket', ok: false, text: 'lock state unknown' });
    d.send({ ev: 'health', key: 'tls', ok: false, text: 'not checked: timeout' });
    HK.filter((k) => k !== 'socket' && k !== 'tls').reverse().forEach((k) => d.send({ ev: 'health', key: k, ok: true, text: k + ' fine' }));
    d.send({ ev: 'health', done: true });
    await sleep(100); await drawn();
    ['Health check', '1 check failed', 'not checked: timeout', 'lock state unknown', 'Run again'].forEach((t) => assert.ok(texts.indexOf(t) >= 0, t + ': ' + texts.join('|')));
    assert.deepStrictEqual(texts.filter((t) => HK.indexOf(t) >= 0), HK, 'all 12 rows drawn, in the service\'s order');
    tgt('health:run').run();
    await until(() => d.cmds('health').length === 2, 2000, 'Run again asks again');
    d.send({ ev: 'health', done: true });
    console.log('ok   WP5 health check page: rows ok / failed, Run again');
    // the resume notice: a video the service resumes at 12:34; Start over goes back to 0
    const q = d.cmds('search').slice(-1)[0].q;
    d.send({ ev: 'positions', items: [{ id: 'RESUME00001', ms: 754000, total: 1200000, done: false, title: 'Long one' }] });
    d.send({ ev: 'results', q, items: [{ id: 'RESUME00001', title: 'Long one', channel: 'C', duration_s: 1200 }] });
    await sleep(100);
    hu.handlers.BTN_RESULTS(); await drawn();
    tgt(/^r:\d+:RESUME00001$/).run();
    await until(() => plays().slice(-1)[0] === 'RESUME00001', 2000, 'played');
    parked();
    d.send({ ev: 'state', state: 'playing', id: 'RESUME00001', title: 'Long one' }); d.send({ ev: 'time', elapsed: 754000, total: 1200000 });
    await sleep(100); await drawn();
    assert.ok(texts.indexOf('Resumed at 12:34 · Start over') >= 0 && tgt('ov:resume'), 'the notice: ' + keys());
    tgt('ov:resume').run();
    await lastIs(d, { cmd: 'seek', ms: 0 }, 'Start over seeks to 0');
    await drawn();
    assert.ok(!tgt('ov:resume'), 'and the notice goes');
    console.log('ok   WP5 resume notice: Resumed at 12:34 · Start over, a press seeks to 0');
    // the wheel's next, first match wins: an asked segment; the list's next; the next chapter; the first related video
    d.send({ ev: 'results', q, items: [{ id: 'WHEEL000001', title: 'One', channel: 'C', duration_s: 600 }, { id: 'WHEEL000002', title: 'Two', channel: 'C', duration_s: 600 }] });
    await sleep(100);
    hu.handlers.BTN_RESULTS(); await drawn();
    tgt(/^r:\d+:WHEEL000001$/).run();
    await until(() => plays().slice(-1)[0] === 'WHEEL000001', 2000, 'played');
    const on = async (id, ms, extras) => { parked(); d.send({ ev: 'state', state: 'playing', id }); d.send({ ev: 'time', elapsed: ms, total: 600000 }); if (extras) d.send(Object.assign({ ev: 'extras', id }, extras)); await sleep(80); await drawn(); };
    await on('WHEEL000001', 20000, { chapters: [[0, 'A'], [300000, 'B']], segments: [[10000, 60000, 'outro']] });
    let nP = plays().length, nS = d.cmds('seek').length;
    await wheel();
    assert.deepStrictEqual([plays().length, d.cmds('seek').slice(nS)], [nP, [{ cmd: 'seek', ms: 60000 }]], 'in an asked segment (end cards): skipped, before the list and the chapter');
    await on('WHEEL000001', 61000, { chapters: [[0, 'A'], [300000, 'B']], segments: [] });
    await wheel();
    assert.deepStrictEqual(plays().slice(nP), ['WHEEL000002'], 'a video in the list: it plays, before the next chapter');
    await on('WHEEL000002', 40000, { chapters: [[0, 'A'], [90000, 'B']], segments: [] });
    nP = plays().length; nS = d.cmds('seek').length;
    await wheel();
    assert.deepStrictEqual([plays().length, d.cmds('seek').slice(nS)], [nP, [{ cmd: 'seek', ms: 90000 }]], 'the list done: the next chapter');
    await on('WHEEL000002', 95000);
    await wheel();
    await lastIs(d, { cmd: 'related', id: 'WHEEL000002' }, 'no later chapter: related asked');
    assert.strictEqual(plays().length, nP, 'nothing played before it comes');
    d.send({ ev: 'related', id: 'WHEEL000002', items: [{ id: 'WHEEL000002', title: 'Itself' }, { id: 'WHEEL000001', title: 'Just played' }, { id: 'SHORT000002', title: 'Short', short: true }, { id: 'RELATED0001', title: 'Related', channel: 'R' }] });
    await until(() => plays().length > nP, 2000, 'the related video plays when it comes (no frame needed)');
    assert.deepStrictEqual(plays().slice(nP), ['RELATED0001'], 'the first worth playing: not itself, not the one before, not a Short');
    console.log('ok   WP5 steering wheel next: segment, list, chapter, related - first match wins');
    // watch-next: a video ends with the list done -> related asked, its first video after 5 s
    await on('RELATED0001', 1000);
    hu.handlers.BTN_HOME(); await sleep(50); await drawn();     // browsing while it plays: History and Playing fit
    assert.deepStrictEqual(railOk().slice(-2), ['rail:hist', 'rail:player'], 'the rail with History and Playing');
    tgt('rail:player').run(); await drawn();
    d.send({ ev: 'state', state: 'ended', id: 'RELATED0001' });
    await sleep(80); await drawn();
    await lastIs(d, { cmd: 'related', id: 'RELATED0001' }, 'the list ends: related asked');
    d.send({ ev: 'related', id: 'RELATED0001', items: [{ id: 'WHEEL000002', title: 'Seen' }, { id: 'RELNEXT0001', title: 'Watch next' }] });
    await sleep(100); await drawn();
    assert.ok(texts.some((t) => /^Up next in \d s: Watch next$/.test(t)), 'up next shown: ' + texts.join('|'));
    nP = plays().length;
    for (let k = 0; k < 40 && plays().length === nP; k++) { await sleep(200); await hu.loopFn(); }
    assert.deepStrictEqual(plays().slice(nP), ['RELNEXT0001'], 'and it plays after 5 s');
    console.log('ok   WP5 watch-next: the list done, the first related video plays after 5 s');
    // nothing new opens the speller while moving (or at all)
    speed(50 * 64);
    const sp = wp5.spells;
    d.send({ ev: 'state', state: 'playing', id: 'RELNEXT0001' }); d.send({ ev: 'time', elapsed: 1000, total: 600000 });
    hu.handlers.BTN_HIST(); await drawn(); hu.handlers.BTN_HEALTH(); await drawn();
    d.send({ ev: 'health', done: true }); await sleep(50); await drawn();
    tgt('health:run').run(); d.send({ ev: 'health', done: true });
    tgt('rail:hist').run(); await drawn();
    await wheel(); await sleep(100);
    assert.strictEqual(wp5.spells, sp, 'no text entry opened while moving');
    d.send({ ev: 'state', state: 'idle' }); parked();
    console.log('ok   WP5 nothing new opens text entry while moving');
}

// ======== WP7 Language: the Language setting switches the whole app at run time
async function wp7Frames(x) {
    const { hu, d, disp, drawn, texts, file, hmiLang, speed } = x;
    const tgt = (k) => disp.pageTargets.find((t) => t.key === k);
    const set = hu.ctx.settings, ver = require('../../apps/jap_ridetube/app.json').version;
    d.send({ ev: 'hello', service: '0.4.6', caps: ['health', 'related', 'hist', 'playlists', 'logs'] });
    speed(0);
    d.send({ ev: 'state', state: 'idle' });
    d.send({ ev: 'auth', state: 'signed_in' });
    hu.handlers.BTN_HOME(); await sleep(300); await drawn();      // (an unchanged page redraws after 250 ms)
    const before = texts.slice(), size0 = fs.statSync(file).size;
    // English chosen: the same as Auto in the stub (no HMI language there): nothing changes, no second hello
    const nHello = d.cmds('hello').length;
    set.set('language', 'en'); await sleep(300); await drawn();
    assert.deepStrictEqual([texts, d.cmds('hello').length], [before, nHello], 'English chosen: the same page, no hello');
    // Русский: hello again with ru / RU before the page's feed is asked again; the drawn page in Russian
    const n0 = d.got.length, hmi = {}, ot = hu.ui.text;
    hu.ui.text = function (n, t) { hmi[n] = t; return ot.apply(this, arguments); };
    set.set('language', 'ru');
    await until(() => d.cmds('hello').length > nHello, 2000, 'hello again');
    assert.deepStrictEqual(d.cmds('hello').slice(-1)[0], { cmd: 'hello', app: ver, lang: 'ru', region: 'GB' }, 'hello: ru, the country still the car\'s (en_GB)');
    // Home was on its way (asked in English): its answer comes, then Home is asked again in Russian
    await sleep(50);
    assert.ok(!d.got.slice(n0).some((m) => m.cmd === 'feed'), 'not asked twice while on its way');
    d.send({ ev: 'feed', which: 'home', items: [] });
    await until(() => d.got.slice(n0).some((m) => m.cmd === 'feed' && m.which === 'home'), 2000, 'Home asked again');
    const after = d.got.slice(n0).map((m) => m.cmd);
    assert.ok(after.indexOf('hello') < after.indexOf('feed'), 'hello first, then the feed: ' + after);
    const RU_FEED = [{ id: 'RUSVIDEO001', title: 'Новости дня', channel: 'Первый канал', duration_s: 300, meta: ['3 тыс. просмотров'] }];
    ['home', 'subs', 'wl', 'hist'].forEach((w) => d.send({ ev: 'feed', which: w, items: RU_FEED }));
    // every page: no English word of the catalog left (names and the fake service's own text aside)
    const words = new Set();
    rideTubeWords().forEach((w) => words.add(w));
    const seen = [];
    const english = () => texts.filter((t) => t.split(/[^A-Za-z]+/).some((w) => words.has(w.toLowerCase())));
    const page = async (what, open) => { await open(); await sleep(300); await drawn(); seen.push(what + ': ' + texts.join(' | ')); assert.deepStrictEqual(english(), [], what + ' in Russian: ' + texts.join(' | ')); };
    hu.ui.text = ot;
    assert.deepStrictEqual([hmi.BTN_S1, hmi.BTN_S3, hmi.BTN_PLAY, hmi.BTN_ACCOUNT, hmi.MAIN_INFO], ['News', 'Музыка', 'Смотреть', 'Выйти', 'Найдите видео или выберите недавний запрос ниже'],
        'the HMI menu\'s own texts again in Russian (the recent searches as typed, then the suggestions): ' + JSON.stringify(hmi));
    await page('home', async () => hu.handlers.BTN_HOME());
    assert.ok(texts.indexOf('Главная') >= 0 && texts.indexOf('Позже') >= 0 && texts.indexOf('Подписки') >= 0, 'the rail in Russian, the short Позже: ' + texts.join('|'));
    await page('subs', async () => hu.handlers.BTN_SUBS());
    await page('wl', async () => hu.handlers.BTN_WL());
    await page('pl', async () => { hu.handlers.BTN_PL(); d.send({ ev: 'playlists', items: [{ id: 'PLru', title: 'Мой плейлист', count: 5 }] }); });
    assert.ok(texts.indexOf('5 видео') >= 0 && texts.indexOf('1 плейлист') >= 0, 'counts in Russian: ' + texts.join('|'));
    await page('hist', async () => hu.handlers.BTN_HIST());
    await page('health', async () => { hu.handlers.BTN_HEALTH(); d.send({ ev: 'health', key: 'dns', ok: false, text: 'нет ответа' }); d.send({ ev: 'health', key: 'tls', ok: false, text: 'нет ответа' }); d.send({ ev: 'health', done: true }); });
    assert.ok(texts.indexOf('2 проверки не пройдены') >= 0, 'few: ' + texts.join('|'));
    await page('logs', async () => hu.handlers.BTN_LOGS());
    await page('logs cancel', async () => tgt('logs:cancel').run());
    await page('player', async () => { d.send({ ev: 'state', state: 'playing', id: 'RUSVIDEO001', title: 'Новости дня' }); d.send({ ev: 'time', elapsed: 1000, total: 300000 }); hu.handlers.BTN_NOW(); await sleep(300); await hu.loopFn(); });
    await page('signed out', async () => { d.send({ ev: 'state', state: 'idle' }); d.send({ ev: 'auth', state: 'code', code: 'ABC-DEF', url: 'https://www.google.com/device' }); hu.handlers.BTN_HOME(); });
    assert.ok(texts.indexOf('Введите этот код на телефоне') >= 0, 'the sign-in card: ' + texts.join('|'));
    // the rail's labels fit the 90 px under their icon (bold, the page lit)
    const { Canvas } = require(path.join(hu.kitDir, 'canvas'));
    const cv = new Canvas(200, 40);
    ['Главная', 'Подписки', 'Позже', 'Плейлисты', 'История', 'Играет', 'Поиск'].forEach((l) => assert.ok(cv.textWidth(l, 18, { literal: true, font: 'bold' }) <= 90, l + ' fits the rail'));
    // back to English: the same page as before, hello en without a region
    d.send({ ev: 'auth', state: 'signed_in' });
    set.set('language', 'en');
    await until(() => d.cmds('hello').slice(-1)[0].lang === 'en', 2000, 'hello en');
    assert.deepStrictEqual(d.cmds('hello').slice(-1)[0], { cmd: 'hello', app: ver, lang: 'en', region: 'GB' }, 'hello: en, the car\'s GB');
    hu.handlers.BTN_HOME(); await sleep(300); await drawn();
    assert.ok(texts.indexOf('Home') >= 0 && texts.indexOf('Watch later') >= 0 && texts.indexOf('Subs') >= 0 && !texts.some((t) => /[\u0400-\u04ff]/.test(t) && !/Новости|Первый|просмотров/.test(t)), 'English again: ' + texts.join('|'));
    // Auto: follows the car's language, at the switch and when the car changes it (one listener, from the start)
    assert.strictEqual(hmiLang.fns.length, 1, 'one languageChanged listener');
    hmiLang.now = 'ru_RU'; set.set('language', 'auto');
    await until(() => d.cmds('hello').slice(-1)[0].lang === 'ru', 2000, 'Auto: hello ru');
    assert.deepStrictEqual(d.cmds('hello').slice(-1)[0], { cmd: 'hello', app: ver, lang: 'ru', region: 'RU' }, 'Auto on a Russian car: ru, RU');
    hmiLang.now = 'en_GB'; hmiLang.fns[0]('en_GB');
    await until(() => d.cmds('hello').slice(-1)[0].lang === 'en', 2000, 'Auto: hello en');
    assert.deepStrictEqual(d.cmds('hello').slice(-1)[0], { cmd: 'hello', app: ver, lang: 'en', region: 'GB' }, 'Auto after the car went English: en, GB');
    hmiLang.now = 'de_DE'; hmiLang.fns[0]('de_DE');
    await until(() => d.cmds('hello').slice(-1)[0].lang === 'de', 2000, 'Auto: hello de');
    assert.deepStrictEqual(d.cmds('hello').slice(-1)[0], { cmd: 'hello', app: ver, lang: 'de', region: 'DE' }, 'Auto on a German car: YouTube in German for Germany');
    hu.handlers.BTN_HOME(); await sleep(300); await drawn();
    assert.ok(texts.indexOf('Home') >= 0, 'no German catalog: the app itself stays English: ' + texts.join('|'));
    hmiLang.now = 'en_GB'; hmiLang.fns[0]('en_GB');
    await until(() => d.cmds('hello').slice(-1)[0].lang === 'en', 2000, 'Auto: hello en again');
    set.set('language', 'en'); hmiLang.now = 'ru_RU'; hmiLang.fns[0]('ru_RU'); await sleep(100);
    assert.deepStrictEqual([d.cmds('hello').slice(-1)[0].lang, d.cmds('hello').slice(-1)[0].region], ['en', 'RU'], 'English chosen: the car\'s language is ignored, its country is not');
    assert.strictEqual(hmiLang.fns.length, 1, 'still one listener');
    hmiLang.now = 'en_GB';
    assert.ok(fs.statSync(file).size > size0, 'frames went on');
    console.log('ok   WP7 Language: Русский redraws every page in Russian, hello ru then the feed again; English again as before; Auto follows the car; the country always from the car');
}
// the English words of RideTube's strings (tests/test_runtime.js's list): none may show while Russian is chosen
function rideTubeWords() {
    const ru = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'runtime', 'locales', 'ru.json'), 'utf8'));
    const keep = /^(ridetube|youtube|jap|ridetube|mgu|store|render|gpu|sponsorblock|sponsor|ajay|app|github|wi|fi|shorts|google|com|device|cc|by|nc|sa|p|s|v|query|name|count|percent|title|seconds|time|date|soc|limit|error|www|https|ok)$/;
    const out = new Set();
    Object.keys(ru).forEach((k) => k.split(/[^A-Za-z]+/).forEach((w) => { w = w.toLowerCase(); if (w.length > 1 && !keep.test(w)) out.add(w); }));
    return out;
}

clientAndModel().then(helloCaps).then(wp5Model).then(appFrames).then(logsModel).then(channelSearch).then(extrasModel).then(() => process.exit(0), (e) => { console.error('FAIL', e); process.exit(1); });
