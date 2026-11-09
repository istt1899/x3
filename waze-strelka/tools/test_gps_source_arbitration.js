'use strict';
// Real BMW RMC/GGA/GST and GPSD TPV decoders: a partial newer position must
// not hide usable BMW data, and contradictory motion must stop the preview.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { GpsProvider } = require('../native/marku-kaluga-cameras/files/gps-source');
const policy = require('../native/marku-kaluga-cameras/files/action-policy');
const service = require('../native/marku-kaluga-cameras/files/marku-kaluga-cameras');
const diagnostics = require('../apps/marku_kaluga_cameras/src/diagnostics_view');
let now = Date.now();

function pad(n, width) { return String(n).padStart(width || 2, '0'); }
function sentence(body) {
    let sum = 0; for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
    return '$' + body + '*' + pad(sum.toString(16), 2);
}
function epoch(ms) {
    const d = new Date(ms);
    return { time: pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + '.' + pad(d.getUTCMilliseconds(), 3),
        date: pad(d.getUTCDate()) + pad(d.getUTCMonth() + 1) + String(d.getUTCFullYear()).slice(-2) };
}
function nmeaSentences(speedKnots, at, latSigma, lonSigma) {
    const t = epoch(at);
    latSigma = latSigma === undefined ? 3 : latSigma;
    lonSigma = lonSigma === undefined ? 4 : lonSigma;
    return [
        sentence('GNRMC,' + t.time + ',A,5451.000,N,03610.000,E,' + (speedKnots === null ? '' : speedKnots) + ',90,' + t.date + ',,,A'),
        sentence('GNGGA,' + t.time + ',5451.000,N,03610.000,E,1,10,0.8,150,M,0,M,,'),
        sentence('GNGST,' + t.time + ',1,1,1,0,' + latSigma + ',' + lonSigma + ',6')
    ];
}
function feedBmw(gps, speedKnots, at, latSigma, lonSigma) {
    gps.inputNmea(nmeaSentences(speedKnots, at, latSigma, lonSigma).join('\r\n'));
}
function feedNmea(gps, speedKnots, at) { nmeaSentences(speedKnots, at).forEach(line => gps.decoder.line(line)); }
function feedGpsd(gps, speed, at) {
    gps.decoder.json({ class: 'TPV', mode: 3, time: new Date(at).toISOString(),
        lat: 54.85, lon: 36.17, epx: 3, epy: 4, speed: speed, track: 90 });
}
function provider() { return new GpsProvider({ now: () => now, nmeaPort: 0 }); }
function decision(gps) {
    return policy.policies({ capabilities: { displayTest: true }, outputs: { cluster: true } },
        gps.current(now), now, gps.motionFixes(now)).displayTest;
}
function remove(dir) {
    fs.readdirSync(dir).forEach(name => {
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        if (stat.isDirectory() && !stat.isSymbolicLink()) remove(file); else fs.unlinkSync(file);
    });
    fs.rmdirSync(dir);
}

async function main() {
    let gps = provider();
    feedBmw(gps, 0, now - 300); feedGpsd(gps, null, now - 100);
    assert.strictEqual(gps.current(now).source, 'bmw-nmea', 'newer GPSD without speed cannot hide complete BMW position');
    assert.strictEqual(decision(gps).code, 'READY', 'fresh BMW standstill permits a preview despite partial GPSD');
    assert.strictEqual(gps.motionFixes(now).length, 2);

    let external = provider();
    feedNmea(external, 0, now - 300); feedGpsd(external, null, now - 100);
    assert.strictEqual(external.decoder.current(now).source, 'nmea', 'partial GPSD cannot eclipse complete external NMEA inside one decoder');
    assert.strictEqual(external.current(now).source, 'nmea');
    assert.strictEqual(decision(external).code, 'READY');

    let partial = provider();
    feedBmw(partial, 0, now - 900);
    partial.inputNmea(nmeaSentences(null, now - 100).slice(0, 2).join('\r\n'));
    assert.strictEqual(partial.bmwDecoder.last['bmw-nmea'].speedKmh, null);
    assert.strictEqual(partial.current(now).speedKmh, 0, 'current retains its prior complete BMW epoch');
    assert.strictEqual(partial.motionFixes(now)[0].speedKmh, 0, 'stationary motion uses the same source complete epoch');
    assert.strictEqual(decision(partial).code, 'READY');
    let closeEpoch = provider();
    feedBmw(closeEpoch, 0, now - 300);
    closeEpoch.inputNmea(nmeaSentences(null, now - 100).slice(0, 2).join('\r\n'));
    assert.strictEqual(closeEpoch.current(now).speedKmh, 0,
        'a nearby RMC without speed cannot replace the last road-ready complete epoch');
    assert.strictEqual(decision(closeEpoch).code, 'READY');

    let poorAccuracy = provider();
    feedBmw(poorAccuracy, 0, now - 300, 3, 9.2);
    assert(poorAccuracy.current(now).accuracyM > 19 && poorAccuracy.current(now).accuracyM < 20);
    poorAccuracy.inputNmea(nmeaSentences(null, now - 100).slice(0, 2).join('\r\n'));
    assert.strictEqual(poorAccuracy.current(now).speedKmh, null, 'road-ready complete does not retain low-accuracy fix');
    assert.strictEqual(poorAccuracy.motionFixes(now)[0].speedKmh, 0,
        'stationary preview retains fresh motion from a low-accuracy BMW fix');
    assert.strictEqual(decision(poorAccuracy).code, 'READY');

    let rejected = provider();
    feedBmw(rejected, 0, now - 3001); feedGpsd(rejected, 0, now + 501);
    assert.strictEqual(rejected.current(now), null, 'stale and future source UTC remains rejected');
    assert.deepStrictEqual(rejected.motionFixes(now), []);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x6-camera-gps-'));
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\x6-camera-gps-' + process.pid : path.join(dir, 'ctl.sock');
    let app, lastGuidanceFix, forceAlert = false;
    gps.start = gps.close = () => {};
    try {
        await new Promise((resolve, reject) => {
            app = service.start({ dataDir: dir, socket: socket, gps: gps,
                storeFactory: o => ({ current: () => o.initial, status: () => ({ phase: 'idle' }), close: () => {} }),
                guidance: { evaluate: fix => { lastGuidanceFix = fix; return forceAlert ?
                    { id: 'low-accuracy-proof', type: 'speed', distanceM: 150, limitKmh: 60, roadConfirmed: true } : null; },
                    diagnostic: () => ({}) },
                display: { update: () => {}, status: () => 'ready',
                    diagnostics: () => ({ connection: 'ready', map: { state: 'shown' } }), close: () => {} },
                dimmer: { update: () => {}, status: () => 'off', close: () => {} },
                onListening: resolve, onError: reject });
        });
        assert(app.state().database.count > 0, 'test must run against a loaded camera bundle');
        app.command({ cmd: 'outputs', cluster: true, hud: false });
        assert.strictEqual(app.state().actions.displayTest.code, 'READY');
        app.command({ cmd: 'display-test', target: 'map' });
        assert.strictEqual(app.state().displayTest.active, true);

        now = Date.now();
        feedGpsd(gps, 0, now - 100); feedBmw(gps, 11, now - 300);
        assert.strictEqual(gps.current(now).source, 'gpsd', 'both complete positions retain newest-source selection');
        app.tick();
        assert.strictEqual(app.state().gpsMotion.conflict, true);
        assert.strictEqual(app.state().actions.displayTest.code, 'MOTION_CONFLICT');
        assert(/^GPSD выбран • скорости GPSD 0\.0, BMW 20\.4 км\/ч • КОНФЛИКТ/.test(app.state().gps),
            'GPS page text identifies the selected source and both motion readings');
        assert.strictEqual(app.state().gps.indexOf('54.85'), -1, 'GPS status text must not disclose coordinates');
        const report = diagnostics.capture(app.state(), '0.8.0', Date.now());
        const gpsPage = diagnostics.reportPage(report, app.state(), '0.8.0', 1, 0);
        let rows = [];
        for (let block = 0; block < gpsPage.blocks; block++) {
            const rendered = diagnostics.reportPage(report, app.state(), '0.8.0', 1, block);
            for (let row = 1; row <= 10; row++) rows.push(rendered.rows['row' + row]);
        }
        const pageText = rows.join(' ');
        assert(pageText.indexOf('GPSD выбран') >= 0 && pageText.indexOf('BMW 20.4') >= 0 &&
            pageText.indexOf('КОНФЛИКТ') >= 0, 'GPS diagnostics page must expose source choice, both speeds and conflict');
        assert.strictEqual(app.state().displayTest.active, false, 'conflicting motion withdraws a visible preview');
        assert.strictEqual(app.state().displayTest.stoppedReason, 'MOTION_CONFLICT');
        assert.strictEqual(lastGuidanceFix, null, 'road guidance cannot use a stopped fix while BMW reports motion');
        assert.throws(() => app.command({ cmd: 'display-test', target: 'map' }), /Источники скорости расходятся/);

        now = Date.now();
        gps.decoder.invalidate('gpsd', 'test source withdrawal');
        gps.bmwDecoder.resetEpoch(now - 1200);
        feedBmw(gps, 0, now - 900);
        gps.inputNmea(nmeaSentences(11, now - 100).slice(0, 2).join('\r\n'));
        assert.strictEqual(gps.current(now).speedKmh, 0, 'road position retains its prior complete epoch');
        assert.strictEqual(gps.motionFixes(now)[0].speedKmh, 20.372, 'preview sees the newest same-source motion');
        app.tick();
        assert.strictEqual(app.state().gpsMotion.conflict, false, 'successive epochs of one source are not a preview conflict');
        assert.strictEqual(app.state().gpsMotion.roadMismatch, true);
        assert.strictEqual(app.state().actions.displayTest.code, 'MOVING');
        assert.strictEqual(lastGuidanceFix, null, 'real guidance cannot use an old stopped speed against newer moving NMEA');
        assert.strictEqual(app.state().speedWarning.reason, 'MOTION_EPOCH_MISMATCH');
        assert(app.state().gps.indexOf('РАЗНЫЕ ЭПОХИ') >= 0, 'GPS diagnostics explains the road gate');

        now = Date.now();
        gps.bmwDecoder.resetEpoch(now - 1200);
        forceAlert = true;
        feedBmw(gps, 0, now - 300, 3, 9.2);
        app.tick();
        assert(app.state().gpsFix.accuracyM > 15, 'service receives the BMW position with about 19.4 m accuracy');
        assert(lastGuidanceFix, 'guidance was offered the low-accuracy position for diagnostics');
        assert.strictEqual(app.state().alert, null, 'native road gate rejects a low-accuracy camera alert');
        gps.inputNmea(nmeaSentences(null, now - 100).slice(0, 2).join('\r\n'));
        app.tick();
        assert.strictEqual(app.state().actions.displayTest.code, 'READY',
            'service preview remains available from fresh BMW standstill despite low accuracy and missing new speed');
        assert.strictEqual(app.state().gpsMotion.state, 'stopped');
        assert(/^Для теста скорость BMW 0\.0 км\/ч \(UTC \d{4}-\d{2}-\d{2}T/.test(app.state().gps),
            'GPS page explains which fresh BMW speed permits a preview');
        assert.strictEqual(app.state().alert, null, 'partial new epoch cannot enable a road alert');
        forceAlert = false;

        now += 3001;
        feedGpsd(gps, null, now - 100);
        assert.strictEqual(gps.current(now).source, 'gpsd', 'stale complete BMW fix cannot override fresh partial GPSD');
        assert.strictEqual(decision(gps).code, 'STATIONARY_UNKNOWN', 'old motion never permits a test');
        console.log('PASS GPS source arbitration: complete BMW fix, fresh motion consensus, conflict stop, stale fallback');
    } finally {
        if (app) app.close();
        remove(dir);
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
