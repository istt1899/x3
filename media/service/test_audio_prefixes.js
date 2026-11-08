'use strict';
// Complete audio prefixes let VK/RUTUBE start before download completion without
// waiting for the final M4A at every later boundary. No car or Unix socket needed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Events = require('events');
const PassThrough = require('stream').PassThrough;
const Daemon = require('../core/native/jap-ridetube-d/ytd.js').Daemon;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-prefixes-'));
const events = [], calls = [];
const name = (n) => n ? 'audio.head.' + n + '.m4a' : 'audio.head.m4a';
const add = (n) => fs.writeFileSync(path.join(root, name(n)), 'audio ' + n);
const turn = () => new Promise((resolve) => setImmediate(resolve));

function player() {
    const d = Object.create(Daemon.prototype);
    d.opts = { headMarginMs: 1500 };
    d.cur = { id: '-123_456', dir: root, durationMs: 120000 };
    d.gen = 1; d.state = 'playing'; d.ticking = true; d.paused = false;
    d.head = { ms: 8000, n: 0 }; d.nextHead = null; d.headWait = false;
    d.headStop = null; d.switchVideoPaused = false; d.seekSeq = 0;
    d.fullReady = false; d.switching = false; d.buffering = false;
    d.elapsed = 0; d.total = 120000; d.lastTickAt = Date.now();
    d.fetchedMs = Infinity; d.lastTimeEv = 0; d.startAt = null;
    d.log = () => {};
    d.emit = (event) => events.push(event);
    d.toYtdec = (line) => calls.push(['ytdec', line]);
    d.savePos = () => {};
    d.skipSegments = () => false;
    d.waitFirstAudioTick = async () => { calls.push(['first tick']); };
    d.audio = {
        replay: async (file) => { calls.push(['replay', path.basename(file)]); },
        release: async () => { calls.push(['release']); },
        play: async (file) => { calls.push(['play', path.basename(file)]); },
        seek: async (ms) => { calls.push(['seek', ms]); },
        button: async (button) => { calls.push(['button', button]); }
    };
    return d;
}

(async () => {
    const proto = player();
    const fetchDir = path.join(root, 'fetch');
    const child = new Events();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    proto.cur.dir = fetchDir;
    proto.state = 'preparing'; proto.pct = 0; proto.phase = 'connecting';
    proto.ticking = false; proto.fetchedMs = 0;
    proto.opts.startVideoMs = 6000; proto.opts.genericMediaIds = true;
    proto.ytc = () => root; proto.freshInfo = () => false;
    proto.chownFetch = () => {}; proto.spawnJob = () => child;
    const ready = proto.fetchVideo('-123_456', fetchDir);
    const send = (event) => child.stdout.write(JSON.stringify(event) + '\n');
    send({ ev: 'audio_buffer', ms: 4000, target_ms: 8000 });
    await turn();
    assert.strictEqual(proto.pct, 35);
    assert.strictEqual(proto.phase, 'audio');
    send({ ev: 'audio_head', ms: 8000, n: 0 });
    send({ ev: 'video', ms: 6000 });
    assert.deepStrictEqual(await ready, { ms: 8000, n: 0 });
    assert.strictEqual(proto.phase, 'video');
    assert.strictEqual(proto.pct, 99);
    proto.head = proto.nextHead; proto.nextHead = null;
    proto.state = 'playing'; proto.ticking = true;
    send({ ev: 'audio_head', ms: 16000, n: 1 });
    await turn();
    assert.strictEqual(proto.nextHead.n, 1, 'a later prefix reaches the active player');
    proto.fetcher = null; // a newer play or stop retired this fetcher
    send({ ev: 'audio_head', ms: 32000, n: 2 });
    await turn();
    assert.strictEqual(proto.nextHead.n, 1, 'a stale fetcher cannot offer an audio prefix');
    child.stdout.destroy(); child.stderr.destroy();

    for (let n = 0; n <= 3; n++) add(n);
    fs.writeFileSync(path.join(root, 'audio.m4a'), 'complete audio');
    const d = player();
    d.offerHead({ ms: 16000, n: 1 });
    d.onTime({ elapsed: 6800, total: 8000 });
    await turn();
    assert.strictEqual(d.head.n, 1);
    assert.strictEqual(d.headWait, false);
    assert.ok(!fs.existsSync(path.join(root, name(0))), 'old prefix removed after replay');
    d.offerHead({ ms: 32000, n: 2 });
    d.onTime({ elapsed: 14800, total: 16000 });
    await turn();
    assert.strictEqual(d.head.n, 2);
    assert.ok(!fs.existsSync(path.join(root, name(1))));
    d.onTime({ elapsed: 30800, total: 32000 });
    await turn();
    assert.strictEqual(d.headWait, true);
    assert.ok(events.some((event) => event.ev === 'state' && event.buffering), 'buffering is visible');
    assert.strictEqual(calls.filter((call) => call[0] === 'button').length, 1);
    d.offerHead({ ms: 64000, n: 3 });
    await turn();
    assert.strictEqual(d.head.n, 3);
    assert.strictEqual(d.headWait, false);
    assert.ok(!fs.existsSync(path.join(root, name(2))));
    assert.ok(calls.some((call) => call[0] === 'ytdec' && call[1] === 'resume'));
    await d.onFullAudio();
    assert.strictEqual(d.head, null);
    assert.ok(!fs.existsSync(path.join(root, name(3))));
    assert.deepStrictEqual(calls.filter((call) => call[0] === 'replay').map((call) => call[1]),
        [name(1), name(2), 'audio.m4a']);
    assert.ok(calls.some((call) => call[0] === 'play' && call[1] === name(3)),
        'an underrun reconnects before playing the next prefix');
    assert.ok(d.elapsed >= 30800 && d.elapsed < 31800, 'clock stays near underrun point: ' + d.elapsed);
    add(0); add(1);
    const paused = player();
    await paused.pause();
    await paused.seek(12000); // beyond the first 8 s prefix
    assert.strictEqual(paused.headWait, true);
    paused.offerHead({ ms: 16000, n: 1 });
    assert.strictEqual(paused.head.n, 0, 'paused playback does not restart on its own');
    await paused.resume();
    assert.strictEqual(paused.head.n, 1);
    assert.strictEqual(paused.headWait, false);
    assert.strictEqual(paused.stoppedAt, null);
    assert.ok(paused.elapsed >= 12000 && paused.elapsed < 12100);

    const delayed = player();
    const priorReplays = calls.filter((call) => call[0] === 'replay').length;
    let finishStop;
    const stopGate = new Promise((resolve) => { finishStop = resolve; });
    delayed.audio.button = async (button) => { calls.push(['delayed button', button]); await stopGate; };
    delayed.onTime({ elapsed: 6800, total: 8000 });
    await turn();
    delayed.offerHead({ ms: 16000, n: 1 });
    await turn();
    assert.strictEqual(delayed.headWait, true);
    assert.strictEqual(calls.filter((call) => call[0] === 'replay').length, priorReplays,
        'a new prefix must wait for the previous STOP reply');
    finishStop();
    await turn();
    assert.strictEqual(delayed.headWait, false);
    assert.strictEqual(delayed.head.n, 1);
    assert.ok(calls.some((call) => call[0] === 'play' && call[1] === name(1)),
        'a delayed STOP is followed by a fresh audio connection');
    delayed.onPlayerState('PLAYER_STATE_STOP');
    assert.strictEqual(delayed.state, 'playing', 'the old STOP cannot end the new prefix');

    const firstTick = player();
    let finishTick;
    firstTick.waitFirstAudioTick = () => new Promise((resolve) => { finishTick = resolve; });
    firstTick.onTime({ elapsed: 6800, total: 8000 });
    await turn();
    firstTick.offerHead({ ms: 16000, n: 1 });
    await turn();
    assert.strictEqual(typeof finishTick, 'function');
    const seeksBeforeTick = calls.filter((call) => call[0] === 'seek').length;
    await turn();
    assert.strictEqual(calls.filter((call) => call[0] === 'seek').length, seeksBeforeTick,
        'setTime waits for the first tick on a fresh BMW connection');
    finishTick();
    await turn();
    assert.strictEqual(firstTick.headWait, false);
    assert.ok(calls.filter((call) => call[0] === 'seek').length > seeksBeforeTick);

    const raced = player();
    let finishReplay;
    raced.audio.replay = (file) => {
        calls.push(['delayed replay', path.basename(file)]);
        return new Promise((resolve) => { finishReplay = resolve; });
    };
    raced.offerHead({ ms: 16000, n: 1 });
    raced.onTime({ elapsed: 6800, total: 8000 });
    await turn();
    await raced.pause();
    await raced.seek(12000);
    finishReplay();
    await turn();
    assert.strictEqual(raced.elapsed, 12000, 'a seek during replay keeps the new position');
    assert.ok(calls.some((call) => call[0] === 'seek' && call[1] === 12000));
    assert.strictEqual(raced.state, 'paused', 'a pause during replay keeps playback paused');

    const seekRace = player();
    let finishFirstSeek;
    const firstSeekGate = new Promise((resolve) => { finishFirstSeek = resolve; });
    let firstSeek = true;
    seekRace.audio.seek = (ms) => {
        calls.push(['gated seek', ms]);
        if (firstSeek) { firstSeek = false; return firstSeekGate; }
        return Promise.resolve();
    };
    seekRace.offerHead({ ms: 16000, n: 1 });
    seekRace.onTime({ elapsed: 6800, total: 8000 });
    await turn();
    assert.strictEqual(seekRace.switching, true);
    await seekRace.seek(12000);
    finishFirstSeek();
    await turn();
    assert.strictEqual(seekRace.elapsed, 12000);
    const gatedSeeks = calls.filter((call) => call[0] === 'gated seek').map((call) => call[1]);
    assert.strictEqual(gatedSeeks.length, 2);
    assert.ok(gatedSeeks[0] >= 6800 && gatedSeeks[0] < 7800);
    assert.strictEqual(gatedSeeks[1], 12000,
        'a seek while setTime is in flight is applied again to the new file');

    const shortMetadata = player();
    shortMetadata.cur.durationMs = 10000;
    shortMetadata.total = 10000;
    shortMetadata.offerHead({ ms: 16000, n: 1 });
    assert.strictEqual(shortMetadata.total, 16000,
        'observed audio extends an underestimated provider duration');
    console.log('ok: prefix boundaries, delayed STOP/replay, seek/pause races, buffering and full audio');
})().then(() => fs.rmSync(root, { recursive: true, force: true }), (error) => {
    console.error(error);
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(1);
});
