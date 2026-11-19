'use strict';
// Reproducible command-sequence tests against the real daemon and Unix control socket.
// From marilykinson-glitch/ridetube (tools/test_sequences.js), with the stop-then-quality case added.
// Run: node tools/test_sequences.js --seed 12345 --cases 12
// A failure exits 1 and records its seed, timing profile, commands and final state.
// The real daemon, real child-process lifecycle and real socket are exercised.
// BMW, YouTube downloads and video decoding use the existing host-test fixtures.
// Clock values are held steady between explicit seeks so position checks do not
// depend on CPU speed. This does not validate physical audio output or decoding.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { createHash } = require('crypto');
process.env.PATH = path.dirname(process.execPath) + path.delimiter + process.env.PATH;
const { Daemon } = require('../native/jap-ridetube-d/ytd');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const videos = ['SEQVIDEO001', 'SEQVIDEO002'];
if (process.argv.includes('--help')) {
    console.log('node tools/test_sequences.js [--seed 12345] [--cases 12] [--scenario NAME] [--delay 0|80] [--out PATH]');
    process.exit(0);
}
const argumentsOf = new Map();
for (let i = 2; i < process.argv.length; i += 2) argumentsOf.set(process.argv[i], process.argv[i + 1]);
const seed = Number(argumentsOf.get('--seed') || 12345);
const cases = Number(argumentsOf.get('--cases') || 12);
assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, '--seed must be an unsigned 32-bit integer');
assert.ok(Number.isInteger(cases) && cases >= 0 && cases <= 1000, '--cases must be 0..1000');
for (const key of argumentsOf.keys()) assert.ok(['--seed', '--cases', '--out', '--scenario', '--delay'].includes(key), 'unknown option ' + key);
const selectedScenario = argumentsOf.get('--scenario');
const selectedDelay = argumentsOf.has('--delay') ? Number(argumentsOf.get('--delay')) : null;
assert.ok(selectedDelay === null || [0, 80].includes(selectedDelay), '--delay must be 0 or 80');
let randomState = seed;
function random(n) {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState % n;
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-sequences-'));
const sourceDir = path.join(root, 'src-gen');
fs.mkdirSync(sourceDir);
for (const file of ['org_genivi_am_commandinterface_CommandControl.json', 'de_bmw_infotainment_entertainment_mediaplayer_MediaPlayer.json']) {
    fs.writeFileSync(path.join(sourceDir, file), JSON.stringify({ name: file }));
}
const fakeDecoder = path.join(__dirname, '../native/jap-ridetube-d/test/fake_ytdec.js');
const fakeFetcher = path.join(__dirname, '../native/jap-ridetube-d/test/fake_ytfetch.js');
fs.chmodSync(fakeDecoder, 0o755);
process.env.FAKE_YTDEC_LOG = path.join(root, 'decoder.log');

async function waitFor(predicate, description, timeout = 7000) {
    const end = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > end) throw new Error('timeout: ' + description);
        await sleep(10);
    }
}

function makeScenario(name, commands, gap = 0) {
    return { name, steps: commands.map((command) => ({ command, gap })) };
}
const fixed = [
    makeScenario('pause-resume', [{ cmd: 'pause' }, { cmd: 'resume' }], 150),
    makeScenario('seek-only', [{ cmd: 'seek', ms: 5000 }], 150),
    makeScenario('fill-only', [{ cmd: 'fill', on: true }, { cmd: 'fill', on: false }], 150),
    makeScenario('paused-quality', [{ cmd: 'pause' }, { cmd: 'quality', quality: '480' }], 150),
    makeScenario('seek-quality', [{ cmd: 'seek', ms: 5000 }, { cmd: 'quality', quality: '480' }], 150),
    makeScenario('quality-last-choice', [{ cmd: 'quality', quality: '480' }, { cmd: 'quality', quality: '360' }]),
    makeScenario('quality-stop', [{ cmd: 'quality', quality: '480' }, { cmd: 'stop' }], 30),
    makeScenario('quality-new-video', [{ cmd: 'quality', quality: '480' }, { cmd: 'play', id: videos[1], quality: '720', fill: false, rect: '1280x720' }], 30),
    makeScenario('quality-fill', [{ cmd: 'quality', quality: '480' }, { cmd: 'fill', on: true }], 30),
    makeScenario('quality-seek', [{ cmd: 'quality', quality: '480' }, { cmd: 'seek', ms: 5000 }], 30),
    makeScenario('quality-pause', [{ cmd: 'quality', quality: '480' }, { cmd: 'pause' }], 30),
    makeScenario('seek-fill-stop', [{ cmd: 'seek', ms: 5000 }, { cmd: 'fill', on: true }, { cmd: 'stop' }], 30),
    makeScenario('play-then-stop', [{ cmd: 'play', id: videos[1], quality: '480', fill: true, rect: '1280x720' }, { cmd: 'stop' }], 30),
    makeScenario('stop-then-quality', [{ cmd: 'stop' }, { cmd: 'quality', quality: '480' }], 30),   // quality during the stop's teardown
];
const choices = [
    { cmd: 'pause' }, { cmd: 'resume' }, { cmd: 'stop' },
    { cmd: 'quality', quality: '360' }, { cmd: 'quality', quality: '480' },
    { cmd: 'fill', on: true }, { cmd: 'fill', on: false },
    { cmd: 'seek', ms: 5000 }, { cmd: 'seek', ms: 30000 },
    { cmd: 'play', id: videos[0], quality: '720', fill: false, rect: '1280x720' },
    { cmd: 'play', id: videos[1], quality: '480', fill: true, rect: '1280x720' },
];
const scenarios = fixed.slice();
for (let i = 0; i < cases; i++) {
    const steps = Array.from({ length: 3 + random(5) }, () => ({
        command: Object.assign({}, choices[random(choices.length)]),
        gap: [0, 30, 150][random(3)],
    }));
    scenarios.push({ name: 'generated-' + i, steps });
}

// Desired user state is independent of daemon internals. Every command is sent through
// the public socket, including commands arriving while a previous one awaits BMW.
function apply(expected, command) {
    switch (command.cmd) {
    case 'play': {
        if (expected.id) expected.saved[expected.id] = expected.elapsed;
        const saved = expected.saved[command.id] || 0;
        Object.assign(expected, {
            id: command.id, state: 'playing', height: Number(command.quality),
            fill: command.fill, elapsed: saved > 10000 ? saved : 0,
        });
        break;
    }
    case 'stop':
        if (expected.id) expected.saved[expected.id] = expected.elapsed;
        expected.state = 'idle'; expected.id = null;
        break;
    case 'pause': if (expected.state !== 'idle') expected.state = 'paused'; break;
    case 'resume': if (expected.state !== 'idle') expected.state = 'playing'; break;
    case 'quality': if (expected.state !== 'idle') expected.height = Number(command.quality); break;
    case 'fill': if (expected.state !== 'idle') expected.fill = command.on; break;
    case 'seek': if (expected.state !== 'idle') expected.elapsed = command.ms; break;
    }
}

async function run(scenario, delay) {
    const dir = fs.mkdtempSync(path.join(root, 'case-'));
    const cache = path.join(dir, 'cache');
    fs.mkdirSync(cache);
    const fetchControl = path.join(dir, 'fetch.control');
    fs.writeFileSync(fetchControl, 'done');
    for (const id of videos) {
        const videoDir = path.join(cache, id);
        fs.mkdirSync(videoDir);
        fs.writeFileSync(path.join(videoDir, 'meta.json'), JSON.stringify({ id, duration_s: 600, title: id }));
        for (const name of ['audio.m4a', 'index.bin', 'video.h264', 'thumb.rgba']) fs.writeFileSync(path.join(videoDir, name), 'fixture');
    }
    const media = { elapsed: 0, running: false, connections: [], nextConnection: 1 };
    const subscriptions = {};
    const calls = [];
    const logs = [];
    const events = [];
    const inFlight = new Set();
    const someip = {
        buildProxy: async () => ({
            init: async () => {},
            isAvailable: async () => true,
            subscribe: (s) => { subscriptions[s.name] = s.onReceive; },
            getValue: async () => media.connections.slice(),
            callMethod: async (method, args) => {
                calls.push({ method, args });
                if (delay) await sleep(delay);
                if (method === 'connect') {
                    const id = media.nextConnection++;
                    media.connections.push({ mainConnectionID: id, sourceID: args.sourceID });
                    return { amError: 'E_OK', mainConnectionID: id };
                }
                if (method === 'disconnect') {
                    media.connections = media.connections.filter((c) => c.mainConnectionID !== args.mainConnectionID);
                    return { amError: 'E_OK' };
                }
                if (method === 'playFile') { media.elapsed = 0; media.running = true; }
                if (method === 'sendButtonEvent') media.running = args.button === 'PLAY';
                if (method === 'setTime') media.elapsed = args.newTimeElapsed;
                return { EntError: 'OK' };
            },
        }),
    };
    const daemon = new Daemon({
        someip, srcGen: sourceDir, sock: path.join(dir, 'ctl.sock'), cacheDir: cache,
        logDir: dir, stateDir: path.join(dir, 'state'), noSetuid: true, spare: false,
        resume: true, tickMs: 5000, watchdogMs: 60000, fetchRetryMs: [],
        ytdec: fakeDecoder, fetcher: [process.execPath, fakeFetcher, fetchControl],
        ytRequest: async () => ({ status: 200, body: '{}' }),
        log: (message) => logs.push(message),
    });
    const children = new Set();
    for (const method of ['spawnYtdec', 'spawnFetchUid']) {
        const original = daemon[method].bind(daemon);
        daemon[method] = (...args) => {
            const result = original(...args);
            const child = method === 'spawnYtdec' ? daemon.child : result;
            if (child) children.add(child);
            return result;
        };
    }
    const dispatch = daemon.onLine.bind(daemon);
    daemon.onLine = (line) => {
        const result = dispatch(line);
        if (result && result.then) {
            inFlight.add(result);
            result.then(() => inFlight.delete(result), () => inFlight.delete(result));
        }
        return result;
    };
    let client;
    let ticks;
    let failure;
    const expected = { id: videos[0], state: 'playing', height: 720, fill: false, elapsed: 0, saved: {} };
    const snapshot = () => ({
        state: daemon.state, id: daemon.cur && daemon.cur.id,
        height: daemon.cur && daemon.cur.height, fill: daemon.cur && daemon.cur.fill,
        elapsed: daemon.elapsed, connections: media.connections.length,
        ticking: daemon.ticking, audioRunning: media.running,
    });
    try {
        await daemon.start();
        client = net.connect(daemon.opts.sock);
        await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
        let buffer = '';
        client.on('data', (data) => {
            buffer += data;
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                events.push(JSON.parse(buffer.slice(0, newline)));
                buffer = buffer.slice(newline + 1);
            }
        });
        ticks = setInterval(() => {
            if (media.running && subscriptions.currentItemTime) {
                subscriptions.currentItemTime({ elapsed: media.elapsed, total: 600000 });
            }
        }, 20);
        const send = (command) => client.write(JSON.stringify(command) + '\n');
        send({ cmd: 'play', id: videos[0], quality: '720', fill: false, rect: '1280x720' });
        await waitFor(() => daemon.state === 'playing' && inFlight.size === 0, 'initial playback');
        for (const step of scenario.steps) {
            apply(expected, step.command);
            send(step.command);
            if (step.gap) await sleep(step.gap);
        }
        // Wait for actual asynchronous commands to finish, then a quiet window to catch
        // a stale callback restarting playback after Stop.
        await sleep(100);
        await waitFor(() => inFlight.size === 0, 'commands to settle');
        await sleep(500);
        const actual = snapshot();
        const differences = [];
        for (const key of ['state', 'id', 'height', 'fill', 'elapsed']) {
            if (expected.state === 'idle' && !['state', 'id'].includes(key)) continue;
            const equal = key === 'elapsed' ? Math.abs(actual[key] - expected[key]) < 1000 : actual[key] === expected[key];
            if (!equal) differences.push(key + ': expected ' + expected[key] + ', got ' + actual[key]);
        }
        if (actual.connections > 1) differences.push('multiple audio connections: ' + actual.connections);
        if (expected.state === 'idle' && (daemon.child || daemon.fetcher || actual.connections || actual.audioRunning)) {
            differences.push('resources still active after Stop');
        }
        if (expected.state === 'playing' && (!actual.ticking || !actual.audioRunning || actual.connections !== 1)) {
            differences.push('playing state has no active audio route or clock');
        }
        if (events.some((e) => e.ev === 'error')) differences.push('daemon emitted an error');
        if (differences.length) failure = { differences, expected, actual, events: events.slice(-15), calls: calls.slice(-20), logs: logs.slice(-20) };
    } catch (error) {
        failure = { differences: [error.stack || String(error)], expected, actual: snapshot(), events: events.slice(-15), logs: logs.slice(-20) };
    } finally {
        clearInterval(ticks);
        if (client) client.destroy();
        await sleep(20);
        await Promise.allSettled(Array.from(inFlight));
        const serverClosed = daemon.server && daemon.server.listening
            ? new Promise((resolve) => daemon.server.once('close', resolve)) : Promise.resolve();
        await daemon.close();
        await serverClosed;
        await Promise.all(Array.from(children).map(async (child) => {
            if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
            const exited = new Promise((resolve) => child.once('exit', resolve));
            child.kill('SIGKILL');
            await exited;
        }));
    }
    return {
        name: scenario.name, delay, steps: scenario.steps, passed: !failure, failure,
        reproduce: 'node tools/test_sequences.js --seed ' + seed + ' --cases ' + cases +
            ' --scenario ' + scenario.name + ' --delay ' + delay,
    };
}

async function main() {
    const results = [];
    try {
        const selected = selectedScenario ? scenarios.filter((scenario) => scenario.name === selectedScenario) : scenarios;
        assert.ok(selected.length, 'unknown scenario: ' + selectedScenario);
        for (const delay of selectedDelay === null ? [0, 80] : [selectedDelay]) {
            for (const scenario of selected) {
                const result = await run(scenario, delay);
                results.push(result);
                console.log((result.passed ? 'PASS ' : 'FAIL ') + result.name + ' delay=' + delay +
                    (result.failure ? ' ' + result.failure.differences.join('; ') : ''));
                if (!result.passed) console.log('REPLAY ' + result.reproduce);
            }
        }
    } finally {
        const failed = results.filter((result) => !result.passed);
        const serviceDir = path.join(__dirname, '../native/jap-ridetube-d');
        const report = {
            seed, generatedCases: cases,
            serviceVersion: JSON.parse(fs.readFileSync(path.join(serviceDir, 'component.json'), 'utf8')).version,
            sourceSha256: createHash('sha256').update(fs.readFileSync(path.join(serviceDir, 'ytd.js'))).digest('hex'),
            nodeVersion: process.version,
            profiles: selectedDelay === null ? [0, 80] : [selectedDelay],
            total: results.length, passed: results.length - failed.length, failed: failed.length, results,
        };
        const output = path.resolve(argumentsOf.get('--out') || 'dist/test-sequences/report.json');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
        console.log('seed=' + seed + ' passed=' + report.passed + '/' + report.total + ' report=' + output);
        process.exitCode = failed.length ? 1 : 0;
        fs.rmSync(root, { recursive: true, force: true });
    }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
