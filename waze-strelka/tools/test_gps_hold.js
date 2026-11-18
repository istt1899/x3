'use strict';
// 0.8.7: an active card survives a brief GPS loss by honest extrapolation,
// withdraws after five seconds with GPS_LOST, and never admits a new camera
// without a fresh fix.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), EventEmitter = require('events');
const base = path.join(__dirname, '../native/marku-kaluga-cameras/files');
const service = require(path.join(base, 'marku-kaluga-cameras'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strelka-gps-hold-'));
let clock = Date.UTC(2026, 10, 18, 12);
const realNow = Date.now;
Date.now = () => clock;
const gps = new EventEmitter();
gps.start = gps.close = function () {};
gps.fix = { lat: 54.5, lon: 36.2, timeMs: clock, motionTimeMs: clock, accuracyM: 5, speedKmh: 36, headingDeg: 90 };
gps.current = () => gps.fix;
function tick(ms) { clock += ms; app.tick(); }
let app;
(async () => {
    const guidance = require(path.join(base, 'vehicle-guidance')).createGuidance({ zones: [], records: [{
        id: 'hold-nearby', type: 'speed', controls: ['speed'], limitKmh: 60,
        position: { lat: 54.5, lon: 36.2 + 300 / (111320 * Math.cos(54.5 * Math.PI / 180)) } }], nearby: true });
    await new Promise((resolve, reject) => {
        app = service.start({ dataDir: dir, socket: process.platform === 'win32' ? '\\\\.\\pipe\\gps-hold-' + process.pid : path.join(dir, 'ctl.sock'),
            gps, guidance: guidance, database: path.join(base, 'kaluga-speed.json'),
            display: { update: function () {}, status: function () { return 'off'; }, close: function () {} },
            dimmer: { update: function () {}, status: function () { return 'off'; }, close: function () {} },
            onListening: resolve, onError: reject });
    });
    tick(0);
    assert(app.state().alert && app.state().alert.id === 'hold-nearby', 'the approach activates the card');
    assert.strictEqual(app.state().gpsHold.active, false);
    // GPS stream dies: 3 s without a fix — the card holds by extrapolation.
    const last = gps.fix.timeMs;
    tick(1500); gps.fix.timeMs = gps.fix.motionTimeMs = last; tick(1600);
    assert(app.state().alert && app.state().alert.id === 'hold-nearby', 'a 3 s fix loss keeps the active card');
    assert.strictEqual(app.state().gpsHold.active, true, 'hold is explicit in the status');
    assert(app.state().gpsHold.ageMs > 2000 && app.state().gpsHold.ageMs <= 5000, 'hold age is reported, got ' + app.state().gpsHold.ageMs);
    tick(2000);
    assert.strictEqual(app.state().alert, null, 'after five seconds without a fresh fix the card withdraws');
    assert.strictEqual(app.state().gpsHold.reason, 'GPS_LOST');
    assert.strictEqual(app.state().speedWarning.reason, 'GPS_LOST');
    // No new camera may be admitted while the fix is still missing.
    tick(1000);
    assert.strictEqual(app.state().alert, null, 'no new camera without a fresh fix');
    // The fix returns: normal operation resumes.
    gps.fix.timeMs = gps.fix.motionTimeMs = clock;
    app.tick();
    assert(app.state().alert && app.state().alert.id === 'hold-nearby', 'a fresh fix resumes the card');
    assert.strictEqual(app.state().gpsHold.active, false);
    app.close();
    Date.now = realNow;
    fs.readdirSync(dir).forEach(n => fs.unlinkSync(path.join(dir, n))); fs.rmdirSync(dir);
    console.log('PASS gps hold: active card extrapolated through a 3 s fix loss, GPS_LOST withdrawal at 5 s, no new admission without a fix, clean resume; real service process');
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
