'use strict';
// 0.8.7 remote audio channel: without an in-process adapter the service
// publishes audioRequest in its status; the HMI answers with 'audio-played';
// the state stays honest (unavailable until a confirmed playback, error with
// the HMI's reason on refusal).
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), EventEmitter = require('events');
const base = path.join(__dirname, '../native/marku-kaluga-cameras/files');
const service = require(path.join(base, 'marku-kaluga-cameras'));
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'strelka-remote-audio-'));
const dir = path.join(root, 'data');
fs.mkdirSync(dir);
const socket = process.platform === 'win32' ? '\\\\.\\pipe\\remote-audio-' + process.pid : path.join(dir, 'ctl.sock');
const gps = new EventEmitter();
gps.start = gps.close = function () {};
function stationaryFix() {
    const now = Date.now();
    return { speedKmh: 0, timeMs: now, motionTimeMs: now };
}
// Emulate a continuing stationary GPS feed while the service assembles its database.
gps.current = () => Object.assign({ lat: 54, lon: 36, accuracyM: 5, headingDeg: 90 }, stationaryFix());
gps.motionFixes = () => [Object.assign({ source: 'bmw-nmea' }, stationaryFix())];
let app, client, states = [], buf = '';
function until(fn, label) { return new Promise((resolve, reject) => { const t0 = Date.now(); (function poll() { if (fn()) return resolve(); if (Date.now() - t0 > 5000) return reject(new Error(label || 'timeout')); setTimeout(poll, 10); })(); }); }
(async () => {
    await new Promise((resolve, reject) => {
        app = service.start({ dataDir: dir, socket, gps,
            guidance: { evaluate: () => ({ id: 'A', type: 'speed', controls: ['speed'], roadConfirmed: true, limitKmh: 60, distanceM: 100 }) },
            database: path.join(base, 'kaluga-speed.json'),
            display: { update: function () {}, status: function () { return 'off'; }, close: function () {} },
            dimmer: { update: function () {}, status: function () { return 'off'; }, close: function () {} },
            onListening: resolve, onError: reject });
    });
    client = net.connect(socket);
    client.setEncoding('utf8');
    client.on('data', bytes => { buf += bytes; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.ev === 'status') states.push(m.state); } });
    await until(() => states.length > 0, 'first status');
    const fresh = () => states[states.length - 1];
    // Channel starts unconfirmed and honest.
    assert.strictEqual(fresh().audio.available, false, 'no fake success before a confirmed playback');
    assert(/не подтверждён/.test(fresh().audio.reason));
    // The test command surfaces a request for the HMI to play.
    client.write(JSON.stringify({ requestId: 't1', cmd: 'audio-test' }) + '\n');
    await until(() => fresh().audioRequest && fresh().audioRequest.test === true, 'audio request published');
    const req = fresh().audioRequest;
    assert(Number.isInteger(req.seq) && req.seq > 0, 'the request carries a sequence number');
    // The HMI confirms: the channel becomes available with a played outcome.
    client.write(JSON.stringify({ cmd: 'audio-played', seq: req.seq, played: true }) + '\n');
    await until(() => fresh().audio.available === true && fresh().audio.phase === 'played', 'confirmed playback');
    // A refusal is reported with its reason and never fakes success.
    client.write(JSON.stringify({ requestId: 't2', cmd: 'audio-test' }) + '\n');
    await until(() => fresh().audioRequest && fresh().commandResult && fresh().commandResult.requestId === 't2', 'second request');
    const req2 = fresh().audioRequest;
    client.write(JSON.stringify({ cmd: 'audio-played', seq: req2.seq, played: false, reason: 'Гонг занят навигацией' }) + '\n');
    await until(() => fresh().audio.phase === 'error', 'refusal becomes an error state');
    assert(/навигацией/.test(fresh().audio.reason), 'the HMI reason reaches the status');
    // Validation: garbage is rejected without touching the channel.
    assert.throws(() => app.command({ cmd: 'audio-played', seq: 'x', played: true }), /AUDIO_SEQ_INVALID/);
    assert.throws(() => app.command({ cmd: 'audio-played', seq: 5, played: 'yes' }), /AUDIO_PLAYED_INVALID/);
    console.log('PASS remote audio: unconfirmed start, audioRequest publication, audio-played confirmation and refusal with reason, strict validation; real control socket');
})().then(close, e => { close(); console.error(e.stack); process.exitCode = 1; });
function close() {
    if (client) client.destroy();
    if (app) app.close();
}
