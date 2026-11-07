'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Host harness, including the head unit's Node 8 runtime.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { Gateway, DaemonPlayer, createYouTubeProvider } = require('./gateway');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function removeTemp(root, dir) {
    const relative = path.relative(root, dir);
    if (relative === '..' || relative.indexOf('..' + path.sep) === 0 || path.isAbsolute(relative)) throw new Error('temp cleanup escapes test root');
    fs.readdirSync(dir).forEach((name) => {
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        if (stat.isDirectory() && !stat.isSymbolicLink()) removeTemp(root, file); else fs.unlinkSync(file);
    });
    fs.rmdirSync(dir);
}
async function until(test, message) {
    const end = Date.now() + 1500;
    while (!test()) { if (Date.now() > end) throw new Error('timeout: ' + message); await delay(5); }
}
class FakePlayer {
    constructor() { this.events = []; this.sinks = []; this.running = false; this.configs = []; this.retireGate = null; this.qualities = []; }
    start() { this.events.push('start'); }
    async retire() {
        this.events.push('retire');
        if (this.retireGate) { const gate = this.retireGate; this.retireGate = null; await gate.promise; }
        await delay(5);
        this.running = false;
    }
    configure(context, emit) {
        assert.strictEqual(this.running, false, 'never configure while another decoder is alive');
        this.context = context; this.emit = emit; this.configs.push(context); this.sinks.push(emit);
    }
    play(message) {
        this.running = true;
        this.events.push('play:' + this.context.providerId);
        this.emit({ ev: 'state', state: 'preparing', id: message.id });
        return new Promise(() => {}); // download deliberately never finishes; STOP must still work
    }
    command(cmd, message) {
        this.events.push(cmd);
        if (cmd === 'video') this.videoOn = message.on;
        if (cmd === 'quality') { this.qualities.push(message.quality); return new Promise(() => {}); }
    }
    status() { return { state: this.running ? 'preparing' : 'idle', id: this.context && this.context.id }; }
    close() { this.events.push('close'); }
}
async function client(socketPath) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);
        const result = { socket, messages: [], send: (message) => socket.write(JSON.stringify(message) + '\n') };
        let data = '';
        socket.on('error', reject);
        socket.on('data', (chunk) => {
            data += chunk;
            let i;
            while ((i = data.indexOf('\n')) >= 0) { result.messages.push(JSON.parse(data.slice(0, i))); data = data.slice(i + 1); }
        });
        socket.on('connect', () => resolve(result));
    });
}
function adapter(id, gates) {
    return {
        id,
        search: async (q, ctx) => {
            assert.strictEqual(ctx.proxyPolicy, id === 'youtube' ? 'youtube' : 'direct');
            if (gates.search) await gates.search.promise;
            return { items: [{ id: id === 'youtube' ? 'abcdefghijk' : id === 'vk' ? '-123_456' : 'a'.repeat(32),
                title: q, channel: id, duration_s: 30, access_token: 'must-not-cross', url: 'private URL' }] };
        },
        feed: async () => ({ items: [] }),
        auth: async () => ({ state: 'code', code: '123456', url: 'https://example.test/device', access_token: 'secret', private: { refresh: 'secret' } }),
        status: async () => ({ state: 'signed_out' }), signOut: async () => ({ state: 'signed_out' }),
        thumb: async () => null,
        preparePlayback: async (videoId, ctx) => {
            if (gates.prepare) await gates.prepare.promise;
            return { id: videoId, cacheDir: ctx.cacheDir, fetcher: ['python', 'fetch.py', '--provider', id] };
        },
        refreshPlayback: async (videoId, ctx) => {
            gates.refreshes = (gates.refreshes || 0) + 1;
            assert.strictEqual(ctx.providerId, id);
            assert.ok(videoId && videoId !== 'undefined', 'quality refresh knows the current video ID');
            if (gates.refreshFn) return gates.refreshFn(videoId, ctx);
            if (gates.refresh) await gates.refresh.promise;
            if (gates.refreshError) throw gates.refreshError;
        }
    };
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-gateway-'));
    const gates = { youtube: {}, vk: {}, rutube: {} }, player = new FakePlayer();
    const sockets = {};
    ['youtube', 'vk', 'rutube'].forEach((id) => {
        sockets[id] = process.platform === 'win32' ? '\\\\.\\pipe\\mgu-media-' + process.pid + '-' + Date.now() + '-' + id : path.join(tmp, id + '.sock');
    });
    const gateway = new Gateway({ providers: ['youtube', 'vk', 'rutube'].map((id) => adapter(id, gates[id])),
        player, stateDir: path.join(tmp, 'state'), cacheDir: path.join(tmp, 'cache'), sockets });
    await gateway.start();
    const youtube = await client(sockets.youtube), vk = await client(sockets.vk), rutube = await client(sockets.rutube);
    youtube.send({ cmd: 'play', id: 'abcdefghijk' });
    await until(() => player.events.indexOf('play:youtube') >= 0, 'YouTube play');
    const firstSink = player.sinks[0];
    const firstRetires = player.events.filter((e) => e === 'retire').length;

    vk.send({ cmd: 'search', q: 'query', provider: 'youtube' });
    vk.send({ cmd: 'auth' });
    vk.send({ cmd: 'pause' });
    vk.send({ cmd: 'video', on: false });
    await until(() => vk.messages.some((m) => m.ev === 'auth'), 'VK auth');
    assert.strictEqual(player.events.filter((e) => e === 'retire').length, firstRetires, 'browsing never steals the player');
    assert.strictEqual(player.events.indexOf('pause'), -1, 'non-owner cannot pause playback');
    const result = vk.messages.find((m) => m.ev === 'results');
    assert.strictEqual(result.items[0].channel, 'vk', 'provider comes from socket, not client payload');
    assert.strictEqual(result.items[0].access_token, undefined);
    assert.strictEqual(result.items[0].url, undefined);
    const auth = vk.messages.find((m) => m.ev === 'auth');
    assert.strictEqual(auth.access_token, undefined); assert.strictEqual(auth.private, undefined);
    assert.strictEqual(youtube.messages.some((m) => m.ev === 'auth' || m.ev === 'results'), false, 'query/account events do not follow playback owner');

    player.retireGate = deferred();
    const retirement = player.retireGate;
    vk.send({ cmd: 'play', id: '-123_456' });
    await until(() => player.events.filter((e) => e === 'retire').length > firstRetires, 'switch retirement');
    assert.strictEqual(player.configs.length, 1, 'new decoder waits for retirement');
    youtube.socket.destroy(); // old owner disappearing must not cancel the requested VK play
    retirement.resolve();
    await until(() => player.events.indexOf('play:vk') >= 0, 'VK play after old client close');
    assert.strictEqual(gateway.owner.providerId, 'vk');
    assert.strictEqual(player.videoOn, false, 'pre-play video-off decision survives the owner switch');
    const beforeLate = vk.messages.length;
    firstSink({ ev: 'time', elapsed: 999, total: 999 });
    await delay(15);
    assert.strictEqual(vk.messages.length, beforeLate, 'late events from previous epoch are dropped');

    vk.send({ cmd: 'stop' });
    await until(() => gateway.owner === null, 'STOP while download is pending');
    assert.strictEqual(player.running, false);

    gates.rutube.prepare = deferred();
    const preparing = gates.rutube.prepare;
    rutube.send({ cmd: 'play', id: 'a'.repeat(32) });
    await until(() => gateway.pendingPlay && gateway.pendingPlay.session.providerId === 'rutube', 'pending RUTUBE');
    rutube.send({ cmd: 'stop' });
    await until(() => gateway.pendingPlay === null, 'STOP cancels unresolved prepare');
    preparing.resolve();
    await delay(20);
    assert.strictEqual(player.events.indexOf('play:rutube'), -1);
    rutube.send({ cmd: 'play', id: '../proxy.json' });
    await until(() => rutube.messages.some((m) => m.ev === 'error'), 'invalid path rejected');

    gates.vk.search = deferred();
    vk.send({ cmd: 'search', q: 'late search' });
    gates.rutube.prepare = null;
    rutube.send({ cmd: 'play', id: 'a'.repeat(32) });
    await until(() => player.events.indexOf('play:rutube') >= 0, 'RUTUBE play');
    gates.vk.search.resolve();
    await until(() => vk.messages.some((m) => m.ev === 'results' && m.q === 'late search'), 'late VK query routed to VK');
    assert.strictEqual(rutube.messages.some((m) => m.ev === 'results'), false);
    const olderRefresh = deferred(), newerRefresh = deferred();
    let refreshCount = 0;
    gates.rutube.refreshFn = () => ++refreshCount === 1 ? olderRefresh.promise : newerRefresh.promise;
    rutube.send({ cmd: 'quality', quality: 360 });
    rutube.send({ cmd: 'quality', quality: 480 });
    await until(() => refreshCount === 2, 'both quality URLs refresh outside playback queue');
    newerRefresh.resolve();
    await until(() => player.qualities.length === 1, 'latest quality request');
    olderRefresh.resolve();
    await delay(20);
    assert.deepStrictEqual(player.qualities, [480], 'an older resolve cannot replace the latest quality');
    gates.rutube.refreshFn = null;
    rutube.send({ cmd: 'stop' });
    await until(() => gateway.owner === null, 'STOP does not wait for quality download');

    rutube.send({ cmd: 'play', id: 'a'.repeat(32) });
    await until(() => gateway.owner && gateway.owner.providerId === 'rutube', 'play before pending refresh');
    gates.rutube.refresh = deferred();
    const pendingRefresh = gates.rutube.refresh, beforeRefresh = gates.rutube.refreshes;
    rutube.send({ cmd: 'quality', quality: 360 });
    await until(() => gates.rutube.refreshes > beforeRefresh, 'pending quality URL refresh');
    rutube.send({ cmd: 'stop' });
    await until(() => gateway.owner === null, 'STOP does not wait for network refresh');
    pendingRefresh.resolve();
    await delay(20);
    assert.deepStrictEqual(player.qualities, [480], 'a quality refresh completing after STOP cannot restart playback');
    gates.rutube.refresh = null;

    await gateway.close();
    assert.strictEqual(player.events[player.events.length - 1], 'close');

    // Real bridge: wait for actual decoder exit and retire warm/extraction processes.
    const bridge = new DaemonPlayer({ noSetuid: true, stateDir: path.join(tmp, 'uid-state'), cacheDir: path.join(tmp, 'yt-cache'), log: () => {} });
    function child() {
        const c = new EventEmitter(); c.exitCode = null; c.signalCode = null;
        c.kill = () => { setTimeout(() => { c.exitCode = 0; c.emit('exit', 0); }, 15); };
        return c;
    }
    const decoder = child(), spare = child(), extracting = child();
    bridge.engine.child = decoder; bridge.engine.spare = { child: spare }; bridge.engine.extracting = { child: extracting };
    bridge.engine.stop = async () => { bridge.engine.child = null; decoder.kill(); };
    const retiring = bridge.retire();
    const context = { providerId: 'vk', id: '-123_456', cacheDir: path.join(tmp, 'vk-cache'), fetcher: ['python', 'fetch.py'], proxyPolicy: 'direct' };
    assert.throws(() => bridge.configure(context, () => {}), /retired/);
    await retiring;
    assert.strictEqual(decoder.exitCode, 0); assert.strictEqual(spare.exitCode, 0); assert.strictEqual(extracting.exitCode, 0);
    bridge.configure(context, () => {});
    assert.strictEqual(bridge.engine.opts.stateDir, path.join(tmp, 'uid-state'), 'root UID state never follows provider');
    assert.deepStrictEqual(bridge.engine.proxyArgs(), ['--lease', '/run/mgu-uplink/lease.json'], 'direct providers receive DNS context but cannot inherit the YouTube proxy');
    ['ytdlp', 'thumbs', 'jobs', 'ytc', 'runtime-tools', 'network-builtin', 'a'.repeat(32)].forEach((name) => fs.mkdirSync(path.join(context.cacheDir, name)));
    bridge.engine.prune();
    assert.ok(fs.existsSync(path.join(context.cacheDir, 'ytdlp')));
    assert.ok(fs.existsSync(path.join(context.cacheDir, 'thumbs')));
    ['jobs', 'ytc', 'runtime-tools', 'network-builtin'].forEach((name) => assert.ok(fs.existsSync(path.join(context.cacheDir, name)), 'private helper directory survives pruning: ' + name));
    assert.strictEqual(fs.existsSync(path.join(context.cacheDir, 'a'.repeat(32))), false, 'generic media cache prunes videos, not helper directories');
    const yt = createYouTubeProvider({ noSetuid: true, stateDir: path.join(tmp, 'yt-state'), cacheDir: path.join(tmp, 'yt-cache'), log: () => {} });
    assert.strictEqual(yt.daemon.server, undefined, 'query adapter never starts a socket or SOME/IP');
    assert.strictEqual(yt.daemon.opts.proxyPolicy, 'youtube');
    let invalid = null;
    try { await yt.preparePlayback('-123_456'); } catch (error) { invalid = error; }
    assert.ok(invalid && /YouTube/.test(invalid.message));
    await yt.close();

    // Use the real core for refresh failure and a quality/provider-switch race.
    // The core clears child on quit, before the operating system reports exit.
    const qualityCache = path.join(tmp, 'quality-cache');
    fs.mkdirSync(qualityCache);
    const qualityBridge = new DaemonPlayer({ noSetuid: true, stateDir: path.join(tmp, 'quality-state'),
        cacheDir: qualityCache, log: () => {} });
    const vkCache = path.join(qualityCache, 'vk');
    qualityBridge.configure({ providerId: 'vk', id: '-123_456', cacheDir: vkCache,
        fetcher: ['python', 'fetch.py'], proxyPolicy: 'direct' }, () => {});
    const oldCache = path.join(vkCache, '-123_456');
    fs.mkdirSync(oldCache);
    const oldMedia = path.join(oldCache, 'video.h264');
    fs.writeFileSync(oldMedia, 'old playable media');
    function controlledDecoder() {
        const c = new EventEmitter(); c.exitCode = null; c.signalCode = null;
        c.stdin = { write: () => {}, end: () => {} }; c.kill = () => true;
        return c;
    }
    const oldDecoder = controlledDecoder(), engine = qualityBridge.engine;
    engine.child = oldDecoder;
    engine.cur = { id: '-123_456', dir: oldCache, height: 720, rect: '640x360', fill: false };
    engine.prune = () => {}; // Keep the old cache so the destructive requality path is observable.
    engine.audio.release = () => Promise.resolve();
    engine.stopFetch = () => Promise.resolve();
    const qualityGates = { refreshError: new Error('refresh failed') };
    const realGateway = new Gateway({ player: qualityBridge,
        providers: [adapter('vk', qualityGates), adapter('rutube', {})],
        stateDir: path.join(tmp, 'quality-state'), cacheDir: qualityCache });
    const replies = [], write = (line) => replies.push(JSON.parse(line));
    const vkSession = { id: 1, providerId: 'vk', closed: false, socket: { write }, videoOn: false };
    const rtSession = { id: 2, providerId: 'rutube', closed: false, socket: { write }, videoOn: false };
    realGateway.owner = { session: vkSession, providerId: 'vk', id: '-123_456', epoch: 1, qualityTicket: 0 };
    await realGateway.dispatch(vkSession, { cmd: 'quality', quality: 360 });
    assert.ok(replies.some((m) => m.ev === 'error' && /refresh failed/.test(m.msg)));
    assert.strictEqual(engine.child, oldDecoder, 'failed resolve leaves the old decoder playing');
    assert.strictEqual(engine.cur.id, '-123_456');
    assert.strictEqual(fs.readFileSync(oldMedia, 'utf8'), 'old playable media', 'failed resolve must not delete playable media');

    qualityGates.refreshError = null;
    const releaseOldQuality = deferred();
    let releaseCount = 0, qualityWork;
    engine.audio.release = () => ++releaseCount === 1 ? releaseOldQuality.promise : Promise.resolve();
    const requality = engine.requality;
    engine.requality = (height) => { qualityWork = requality.call(engine, height); return qualityWork; };
    let nextPlay = false;
    qualityBridge.play = () => { nextPlay = true; };
    await realGateway.dispatch(vkSession, { cmd: 'quality', quality: 360 });
    await until(() => engine.child === null, 'quality clears the active decoder reference');
    assert.ok(qualityBridge.retiring.has(oldDecoder), 'detached decoder stays registered until actual exit');
    const providerSwitch = realGateway.dispatch(rtSession, { cmd: 'play', id: 'b'.repeat(32) });
    await delay(20);
    assert.strictEqual(nextPlay, false, 'provider switch waits for the decoder released by quality');
    assert.strictEqual(engine.opts.providerId, 'vk');
    oldDecoder.exitCode = 0; oldDecoder.emit('exit', 0);
    await providerSwitch;
    await until(() => nextPlay, 'next provider starts after the old decoder exits');
    assert.strictEqual(engine.opts.providerId, 'rutube');
    assert.strictEqual(qualityBridge.retiring.size, 0);
    releaseOldQuality.resolve();
    await qualityWork;
    assert.ok(fs.existsSync(oldMedia), 'late old quality cannot remove the previous provider cache');

    // failPlayback also clears child outside retire(), including close-only exits.
    const failedDecoder = controlledDecoder();
    engine.child = failedDecoder;
    await engine.failPlayback('test media failure');
    assert.ok(qualityBridge.retiring.has(failedDecoder));
    let faultRetired = false;
    const retireFault = qualityBridge.retire().then(() => { faultRetired = true; });
    await delay(20);
    assert.strictEqual(faultRetired, false, 'fault recovery waits for the detached writer too');
    failedDecoder.emit('close', 1, null);
    await retireFault;
    failedDecoder.emit('exit', 1); // Clear the core's delayed SIGKILL timer.
    assert.strictEqual(qualityBridge.retiring.size, 0, 'close-only helper cannot leave retirement stuck');
    await realGateway.close();

    // A stop may arrive while play is still awaiting its internal audio release.
    // The old continuation must not start a fetch after the gateway has retired it.
    const Daemon = require('../core/native/jap-ridetube-d/ytd.js').Daemon;
    const pendingStop = deferred();
    const d = new Daemon({ noSetuid: true, cacheDir: path.join(tmp, 'pending'), fetchRetryMs: [], log: () => {} });
    d.audio.release = () => pendingStop.promise;
    d.stopFetch = () => Promise.resolve();
    let fetches = 0;
    d.fetchVideo = async () => { fetches++; throw new Error('must not fetch after STOP'); };
    const oldPlay = d.play('abcdefghijk', '640x360', false);
    const stopped = d.stop('idle');
    pendingStop.resolve();
    await Promise.all([oldPlay, stopped]);
    assert.strictEqual(fetches, 0, 'a retired play cannot resume after its internal stop');

    const qualityStop = deferred(), oldDir = path.join(tmp, 'old-quality');
    fs.mkdirSync(oldDir);
    d.cur = { id: 'abcdefghijk', dir: oldDir, height: 720, rect: '640x360', fill: false };
    d.audio.release = () => qualityStop.promise;
    const changingQuality = d.requality(360);
    const cancelQuality = d.stop('idle');
    qualityStop.resolve();
    await Promise.all([changingQuality, cancelQuality]);
    assert.ok(fs.existsSync(oldDir), 'retired quality request cannot remove cache/start an old play');
    removeTemp(tmp, tmp);
    console.log('ok: three sockets, query/account isolation, exclusive playback epochs, cancellation, helper retirement and proxy policy');
})().catch((error) => { console.error(error); process.exit(1); });
