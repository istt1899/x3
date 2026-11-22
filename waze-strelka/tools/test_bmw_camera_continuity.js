// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const service = require('../native/marku-kaluga-cameras/files/marku-kaluga-cameras');
const { GpsProvider } = require('../native/marku-kaluga-cameras/files/gps-source');
const { createGuidance } = require('../native/marku-kaluga-cameras/files/vehicle-guidance');
const { presentation } = require('../native/marku-kaluga-cameras/files/alert-card');

const baseUtc = Date.UTC(2026, 10, 21, 9, 39);
const cameraId = 'bmw-continuity-fixture';
const targets = { cluster: true, hud: true };

function position(eastM) {
    return { lat: 54, lon: 36 + eastM / (111320 * Math.cos(54 * Math.PI / 180)) };
}

function sentence(body) {
    let checksum = 0;
    for (const ch of body) checksum ^= ch.charCodeAt(0);
    return '$' + body + '*' + ('0' + checksum.toString(16)).slice(-2).toUpperCase();
}

function timeField(utc) {
    const iso = new Date(utc).toISOString();
    return iso.slice(11, 23).replace(/:/g, '');
}

function coordinate(degrees, digits) {
    const whole = Math.floor(degrees);
    const minutes = ((degrees - whole) * 60).toFixed(7);
    return String(whole).padStart(digits, '0') + minutes.padStart(10, '0');
}

function packet(epochMs, eastM, gstOffsetMs, speedKnots, sourceYear) {
    const p = position(eastM);
    const coords = `${coordinate(p.lat, 2)},N,${coordinate(p.lon, 3)},E`;
    const time = timeField(baseUtc + epochMs);
    return [
        sentence(`GNRMC,${time},A,${coords},${speedKnots},90,2111${String(sourceYear).slice(-2)},,,A`),
        sentence(`GNGGA,${time},${coords},1,10,0.8,150,M,0,M,,`),
        sentence(`GNGST,${timeField(baseUtc + epochMs + gstOffsetMs)},1,1,1,0,2,3,6`)
    ].join('\r\n');
}

async function run(label, check, options = {}) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'strelka-continuity-'));
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\strelka-continuity-' + process.pid + '-' + label : path.join(dir, 'ctl.sock');
    let elapsed = 0, suspended = 0, app;
    const frames = [];
    const trace = [];
    const bootSec = ms => 200 + ms / 1000;
    const mono = () => elapsed - suspended;
    const gps = new GpsProvider({ now: () => (options.wallUtc || baseUtc) + elapsed, monotonicNow: mono,
        bootSec: () => bootSec(elapsed), nmeaPort: 0, port: 1,
        readRtc: () => null, createNetworkUtc: () => ({ now: () => null, close() {} }) });
    const camera = { id: cameraId, type: 'speed', controls: ['speed'], limitKmh: 60, position: position(0) };
    const zones = options.road ? [Object.assign({ id: cameraId, travel: [90], limit: 60,
        roads: [{ id: 'wake-test-road', dir: 0, cam: 1, pts: [[-500, 0], [0, 0], [200, 0]] }] }, camera.position)] : [];
    const guidance = createGuidance({ zones, records: [camera], nearby: !options.road });
    try {
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ outputs: targets }));
        await new Promise((resolve, reject) => {
            app = service.start({
                dataDir: dir, socket, gps, guidance, monotonicNow: mono,
                onListening: resolve, onError: reject,
                storeFactory: ({ initial }) => ({ current: () => initial, status: () => ({ phase: 'idle' }), close() {} }),
                display: {
                    update(alert, outputs) {
                        frames.push({ id: alert ? alert.id : null, distance: alert ? presentation(alert).distance : null, outputs });
                        if (app) {
                            const state = app.state();
                            trace.push({ elapsed, hold: state.gpsHold.reason, reason: state.guidance.reason });
                        } else trace.push(null);
                    },
                    status: () => 'ready', close() {}
                },
                dimmer: { update() {}, status: () => 'off', close() {} }
            });
        });
        const advance = ms => {
            assert(ms >= elapsed, 'test receipt time must advance monotonically');
            elapsed = ms;
        };
        const feed = (sampleMs, eastM, gstOffsetMs = 0, speedKnots = 15.7, sourceYear = 2026) => {
            advance(sampleMs + 600);
            app.command({ cmd: 'vehicle-nmea', data: packet(sampleMs, eastM, gstOffsetMs, speedKnots, sourceYear) });
            assert.strictEqual(app.state().gpsInput.checksumErrors, 0);
            return app.state();
        };
        const tick = ms => {
            advance(ms);
            app.tick();
            return app.state();
        };
        const wakeAfter = ms => {
            suspended += ms;
            return tick(elapsed + ms);
        };
        const navigation = (ms, eastM, sampledMs = ms) => {
            advance(ms);
            app.command({ cmd: 'vehicle-context', navigation: { source: 'bmw-navigation', state: 'ready',
                fix: Object.assign(position(eastM), { timeOrigin: 'receipt', sampledAtBootSec: bootSec(sampledMs),
                    accuracyM: null, accuracySource: 'bmw-road-match', speedKmh: 36, headingDeg: 90 }) } });
            return app.state();
        };
        const frame = () => frames[frames.length - 1];
        check({ feed, tick, wakeAfter, navigation, frame, frames, trace });
    } finally {
        if (app) app.close();
        else gps.close();
        fs.readdirSync(dir).forEach(file => fs.unlinkSync(path.join(dir, file)));
        fs.rmdirSync(dir);
    }
}

function onBoth(distance) {
    return { id: cameraId, distance, outputs: targets };
}

async function main() {
    await run('offset', ({ feed, frame, frames, trace }) => {
        feed(0, -170);
        assert.deepStrictEqual(frame(), onBoth(170));
        const afterEntry = frames.length;
        feed(11000, -80);
        assert.deepStrictEqual(frame(), onBoth(80));
        feed(15000, -49);
        assert.deepStrictEqual(frame(), onBoth(49));

        const weak = feed(17600, -63, 200);
        assert.strictEqual(weak.gpsFix.accuracyM, null);
        assert.strictEqual(weak.gpsInput.nmeaTiming.pairReason, 'GGA_GST_OFFSET');
        assert.strictEqual(weak.gpsHold.reason, 'ACCURACY_MISSING');
        assert.deepStrictEqual(frame(), onBoth(49));
        assert.strictEqual(weak.speedWarning.overspeed, false);

        feed(18400, -80);
        assert.deepStrictEqual(frame(), onBoth(49));
        feed(19200, -79, 0, 0);
        assert.deepStrictEqual(frame(), onBoth(49));
        feed(20200, -72);
        assert.deepStrictEqual(frame(), onBoth(49));
        feed(24200, -35);
        assert.deepStrictEqual(frame(), onBoth(35));
        for (let i = afterEntry; i < frames.length; i++) {
            const rendered = frames[i];
            assert.strictEqual(rendered.id, cameraId, JSON.stringify(trace[i]));
            assert.deepStrictEqual(rendered.outputs, targets);
        }
    });

    await run('hold-pass', ({ feed, tick, frame }) => {
        feed(0, -22);
        assert.deepStrictEqual(frame(), onBoth(22));

        // The old speed/course extrapolation would place this 12 m past the camera.
        const missing = tick(4200);
        assert.strictEqual(missing.gpsFix, null);
        assert.strictEqual(missing.gpsHold.active, true);
        assert.strictEqual(missing.guidance.lastClear, null);
        assert.deepStrictEqual(frame(), onBoth(22));

        feed(4000, -11);
        assert.deepStrictEqual(frame(), onBoth(11));
        const unconfirmed = feed(5500, 6);
        assert.strictEqual(unconfirmed.guidance.lastClear, null);
        assert.deepStrictEqual(frame(), onBoth(11));
        const passed = feed(6500, 14);
        assert.strictEqual(passed.guidance.lastClear.reason, 'BEHIND');
        assert.strictEqual(passed.guidance.lastClear.cameraId, cameraId);
        assert.strictEqual(frame().id, null);
        feed(7500, 22);
        assert.deepStrictEqual(frame(), { id: null, distance: null, outputs: targets });
    });

    await run('offline-wake', ({ feed, wakeAfter, navigation, frame, frames }) => {
        const initial = feed(0, -85, 0, 19.4, 1983);
        assert.strictEqual(initial.gpsFix, null);
        assert.strictEqual(new Date(initial.clock.serviceWallMs).getUTCFullYear(), 2179);
        assert.strictEqual(new Date(initial.clock.sourceUtcMs).getUTCFullYear(), 1983);
        assert.strictEqual(initial.clock.referenceState, 'waiting');
        const generation = initial.gpsReset.generation;

        const awake = wakeAfter(60000);
        assert.strictEqual(awake.gpsReset.phase, 'waiting-new-fix');
        assert(awake.gpsReset.generation > generation);
        assert.strictEqual(navigation(60800, -85, 600).gpsFix, null, 'a buffered pre-wake event remains expired');
        assert.strictEqual(frame().id, null);
        assert.strictEqual(feed(60900, -55, 0, 19.4, 1983).gpsFix, null, 'advancing old-year RMC cannot establish the clock offline');

        const first = navigation(61600, -55);
        assert.strictEqual(first.gpsFix.source, 'bmw-navigation');
        assert.strictEqual(first.gpsFix.accuracyM, null);
        assert.strictEqual(frame().id, null, 'one navigation position does not confirm a road approach');
        const shown = navigation(62600, -45);
        assert.strictEqual(shown.clock.referenceState, 'waiting');
        assert.strictEqual(shown.gpsReset.phase, 'receiving');
        assert.strictEqual(shown.alert && shown.alert.roadConfirmed, true,
            'two live BMW road matches must reach real road guidance and produce a card');
        assert.deepStrictEqual(frame(), onBoth(45));
        const afterEntry = frames.length;
        for (let eastM = -35, ms = 63600; eastM <= -5; eastM += 10, ms += 1000) {
            navigation(ms, eastM);
            assert.deepStrictEqual(frame(), onBoth(-eastM));
        }

        const unconfirmed = navigation(67600, 5);
        assert.strictEqual(unconfirmed.guidance.lastClear, null);
        assert.deepStrictEqual(frame(), onBoth(5));
        const repeat = navigation(67700, 5, 67600);
        assert.strictEqual(repeat.guidance.lastClear, null);
        assert.deepStrictEqual(frame(), onBoth(5));
        const beforeClear = frames.slice(afterEntry);
        assert(beforeClear.every(rendered => rendered.id === cameraId && rendered.outputs.hud && rendered.outputs.cluster));

        const passed = navigation(68600, 15);
        assert.strictEqual(passed.guidance.lastClear.reason, 'CAMERA_PASSED');
        assert.strictEqual(passed.guidance.lastClear.cameraId, cameraId);
        assert.deepStrictEqual(frame(), { id: null, distance: null, outputs: targets });
        navigation(69600, 25);
        assert.strictEqual(frame().id, null, 'the warning stays cleared after passage');
    }, { road: true, wallUtc: Date.UTC(2179, 5, 5, 21, 3, 27) });
    console.log('BMW NMEA camera continuity and offline navigation wake checks passed');
}

main().catch(err => { console.error(err.stack); process.exitCode = 1; });
