// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const service = require('../native/marku-kaluga-cameras/files/marku-kaluga-cameras');
const { GpsProvider } = require('../native/marku-kaluga-cameras/files/gps-source');
const { CameraControl } = require('../apps/marku_kaluga_cameras/src/control');
const { BmwSpeedBridge } = require('../apps/marku_kaluga_cameras/src/bmw_speed_bridge');
const view = require('../apps/marku_kaluga_cameras/src/diagnostics_view');

const wrongWall = Date.parse('2179-06-05T21:03:27.000Z');
const actualUtc = Date.parse('2026-11-20T07:08:23.000Z');
const second = 1000;

function oldYear(utc) {
    const date = new Date(utc);
    date.setUTCFullYear(1983);
    return date.getTime();
}

function sentence(body) {
    let checksum = 0;
    for (const ch of body) checksum ^= ch.charCodeAt(0);
    return '$' + body + '*' + ('0' + checksum.toString(16)).slice(-2).toUpperCase();
}

function packet(utc, speedKmh, rmcPosition) {
    const date = new Date(utc);
    const pad = value => ('0' + value).slice(-2);
    const time = pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + '.000';
    const day = pad(date.getUTCDate()) + pad(date.getUTCMonth() + 1) + String(date.getUTCFullYear()).slice(-2);
    const position = '5400.0000,N,03600.0000,E';
    return [
        sentence(`GNRMC,${time},A,${rmcPosition || position},${speedKmh / 1.852},90,${day},,,A`),
        sentence(`GNGGA,${time},${position},1,10,0.8,150,M,0,M,,`),
        sentence(`GNGST,${time},1,1,1,0,3,4,6`)
    ].join('\r\n');
}

async function until(check) {
    const started = Date.now();
    while (!check()) {
        assert(Date.now() - started < 4500, 'timed out waiting for vehicle speed state');
        await new Promise(resolve => setTimeout(resolve, 15));
    }
}

async function run(label, rtcOffsetMs, test, wallAtStart = wrongWall) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'strelka-x6-'));
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\strelka-x6-' + process.pid + '-' + label : path.join(dir, 'ctl.sock');
    let elapsed = 0, frozenRtc = null, networkAvailable = false;
    const mono = () => elapsed;
    const utc = () => actualUtc + elapsed;
    const rtcNow = () => rtcOffsetMs === null ? NaN : Math.floor((utc() + rtcOffsetMs) / second) * second;
    const gps = new GpsProvider({ now: () => wallAtStart + elapsed, monotonicNow: mono, nmeaPort: 0, port: 1,
        createNetworkUtc: () => ({now: () => networkAvailable ? utc() : null, close() {}}),
        readRtc: () => frozenRtc === null ? rtcNow() : frozenRtc });
    let app, shown, bootOffset = 0;
    const controls = [];
    try {
        await new Promise((resolve, reject) => {
            app = service.start({ dataDir: dir, socket, gps, monotonicNow: mono, onListening: resolve, onError: reject,
                bootSec: () => Math.floor(os.uptime()) + bootOffset,
                database: path.join(dir, 'no-camera-database.json'), guidance: { evaluate: () => null },
                display: { update: alert => { shown = alert; }, status: () => 'ready', close() {},
                    diagnostics: () => ({ connection: 'ready', hud: { target: 'shown', state: 'shown', rendering: 'verified' } }) },
                dimmer: { update() {}, status: () => 'off', close() {} } });
        });
        const state = () => app.state();
        const command = (cmd, payload) => app.command(Object.assign({cmd}, payload));
        const tick = (ms, sampleMs = second) => {
            for (let remaining = ms; remaining > 0;) {
                const step = Math.min(sampleMs, remaining);
                elapsed += step;
                remaining -= step;
                app.tick();
            }
        };
        const feed = (time, speedKmh = 0, position) => command('vehicle-nmea', {data: packet(time, speedKmh, position)});
        const control = async () => {
            const client = new CameraControl({path: socket});
            controls.push(client);
            client.open();
            await until(() => client.state);
            return client;
        };
        await test({ state, command, tick, feed, utc, control, expireBoot: () => { bootOffset += 3; app.tick(); },
            freezeRtc: () => { frozenRtc = rtcNow(); }, setNetwork: enabled => { networkAvailable = enabled; }, shown: () => shown });
    } finally {
        controls.forEach(client => client.close());
        if (app) app.close();
        else gps.close();
        fs.readdirSync(dir).forEach(file => fs.unlinkSync(path.join(dir, file)));
        fs.rmdirSync(dir);
    }
}

function rejectPreview(state, command, code) {
    const policy = state().actions.displayTest;
    assert.strictEqual(policy.code, code);
    assert.throws(() => command('display-test', {target:'hud'}), error => error.message === policy.reason);
    assert.strictEqual(state().commandResult.phase, 'error');
    assert.strictEqual(state().displayTest.active, false);
}

async function main() {
    await run('missing-rmc-utc', null, async ({ state, command, tick, control, shown }) => {
        command('outputs', {cluster:false, hud:true});
        command('gps-reset');
        const noRmcTime = sentence('GNRMC,,V,,,,,,,,,,N');
        command('vehicle-nmea', {data:noRmcTime});
        tick(316, 316);
        assert.strictEqual(state().clock.referenceSource, 'system');
        assert.strictEqual(state().clock.issue, 'SOURCE_UTC_UNKNOWN');
        assert.strictEqual(state().clock.sourceUtcMs, null);
        assert.strictEqual(state().gpsInput.lastPacketAgeMs, 316);
        assert.strictEqual(state().gpsInput.nmeaTiming.pairReason, 'INVALID_RMC');
        assert.strictEqual(state().gpsFix, null);
        assert.strictEqual(state().alert, null);
        rejectPreview(state, command, 'STATIONARY_UNKNOWN');

        const vehicle = await control();
        vehicle.send({cmd:'vehicle-speed', raw:0, sampledAtBootSec:Math.floor(os.uptime())});
        await until(() => state().vehicleMotion.code === 'READY');
        assert.strictEqual(state().actions.displayTest.code, 'READY');
        command('display-test', {target:'hud'});
        assert.strictEqual(shown().test, true);
        command('vehicle-nmea', {data:noRmcTime});
        assert.strictEqual(state().displayTest.active, true);
        assert.strictEqual(state().gpsFix, null);
        assert.strictEqual(state().alert, null);

        vehicle.send({cmd:'vehicle-speed', raw:65, sampledAtBootSec:Math.floor(os.uptime())});
        await until(() => state().displayTest.stoppedReason === 'MOVING');
        assert.strictEqual(shown(), null);
    }, Date.parse('2026-11-22T16:00:47.000Z'));

    await run('offline-display', null, async ({ state, command, tick, feed, utc, control, expireBoot, shown }) => {
        command('outputs', {cluster:false, hud:true});
        feed(oldYear(utc()));
        tick(second);
        feed(oldYear(utc()));
        assert.strictEqual(state().clock.serviceWallMs, wrongWall + second);
        assert.strictEqual(state().clock.issue, 'UTC_MISMATCH');
        rejectPreview(state, command, 'STATIONARY_UNKNOWN');

        const source = await control(), ui = await control();
        let raw = 0, failRead = false, builds = 0;
        const bridge = new BmwSpeedBridge({
            buildAndInitTypedProxy(iface, instance) {
                builds++;
                assert.strictEqual(iface, 'de.bmw.infotainment.vehicle.Vehicle2');
                assert.strictEqual(instance, '1');
                return Promise.resolve({statusCarSpeed2: {
                    getValue: () => failRead ? Promise.reject(new Error('no BMW response')) :
                        Promise.resolve({speedVehicleCentreOfGravity: raw})
                }});
            }
        }, source);
        try {
            bridge.start();
            await until(() => ui.state.vehicleMotion.code === 'READY');
            assert.strictEqual(ui.state.actions.displayTest.code, 'READY');
            assert.strictEqual(ui.state.gpsFix, null);
            assert.strictEqual(ui.state.alert, null);
            const motionRow = view.photoRows(view.capture(ui.state, '0.9.8'), true, 'hud')[5];
            assert(motionRow.replace(',', '.').includes('0.0 км/ч BMW'));
            ui.send({cmd:'display-test', target:'hud'});
            await until(() => ui.state.displayTest.active);
            assert.strictEqual(shown().test, true);
            assert.strictEqual(ui.state.alert, null);

            raw = 65;
            await until(() => ui.state.displayTest.stoppedReason === 'MOVING');
            assert.strictEqual(shown(), null);
            assert.strictEqual(ui.state.actions.displayTest.code, 'MOVING');
            raw = 65535;
            await until(() => ui.state.vehicleMotion.code === 'INVALID');
            rejectPreview(state, command, 'STATIONARY_UNKNOWN');
            const fakeSample = {cmd:'vehicle-speed', raw:0, sampledAtBootSec:Math.floor(os.uptime())};
            ui.send(fakeSample);
            await until(() => ui.commandError === 'VEHICLE_SPEED_SOURCE_INVALID');
            raw = 0;
            await until(() => state().actions.displayTest.code === 'READY');
            command('calibration-test', {target:'hud'});
            failRead = true;
            await until(() => ui.state.displayTest.stoppedReason === 'STATIONARY_UNKNOWN');
            assert.strictEqual(shown(), null);
            failRead = false;
            await until(() => state().actions.displayTest.code === 'READY');
            bridge.stop();
            source.send(Object.assign({}, fakeSample, {sampledAtBootSec:Math.floor(os.uptime()) - 2}));
            await until(() => source.commandError === 'VEHICLE_SPEED_STALE');
            assert.strictEqual(state().actions.displayTest.code, 'READY', 'delayed data do not replace the current sample');
            assert.strictEqual(builds, 1);
            command('display-test', {target:'hud'});
            expireBoot();
            await until(() => ui.state.vehicleMotion.code === 'NO_SIGNAL' && !ui.state.displayTest.active);
            assert.strictEqual(shown(), null);
            assert.strictEqual(ui.state.gpsFix, null);
        } finally {
            bridge.stop();
        }
    });

    await run('rtc', 0, ({ state, command, tick, feed, utc, freezeRtc, shown }) => {
        command('outputs', {cluster:false, hud:true});
        const frozen = utc();
        feed(frozen);
        assert.strictEqual(state().clock.serviceWallMs, wrongWall);
        assert.strictEqual(state().clock.sourceUtcMs, frozen);
        assert.strictEqual(state().clock.issue, 'UTC_MISMATCH');
        command('gps-reset');
        assert.strictEqual(state().clock.admissionAfterUtcMs, wrongWall + 500);
        tick(14 * second, 100);
        feed(frozen);
        assert.strictEqual(state().clock.referenceSource, 'system', 'Ticking RTC plus frozen RMC cannot activate RTC');
        assert.strictEqual(state().gpsInput.lastPacketAgeMs, 0, 'Transport can be fresh while RMC is frozen');
        assert.strictEqual(state().gpsFix, null);
        rejectPreview(state, command, 'STATIONARY_UNKNOWN');

        const invalidRmcPosition = '9900.0000,N,03600.0000,E';
        tick(second, 100);
        feed(utc(), 0, invalidRmcPosition);
        tick(second, 100);
        feed(utc(), 0, invalidRmcPosition);
        tick(100, 100);
        assert.strictEqual(state().clock.referenceSource, 'system', 'An invalid RMC position cannot corroborate a ticking RTC');

        tick(second, 100);
        feed(utc());
        assert.strictEqual(state().clock.referenceSource, 'system', 'One RMC jump from old data cannot establish progression');
        tick(second, 100);
        feed(utc());
        tick(100, 100);
        assert.strictEqual(state().clock.referenceSource, 'rtc');
        assert(Math.abs(state().clock.referenceUtcMs - utc()) < 150);
        assert(state().clock.admissionAfterUtcMs < utc() + second, 'RTC transition replaces the wrong-century reset cutoff');
        assert.strictEqual(state().gpsFix, null);
        tick(second, 100);
        const first = utc();
        feed(first);
        feed(first);
        rejectPreview(state, command, 'STATIONARY_UNKNOWN');
        tick(second, 100);
        feed(utc());
        assert.strictEqual(state().gpsFix.source, 'bmw-nmea');
        assert.strictEqual(state().gpsFix.speedKmh, 0);
        assert.strictEqual(state().actions.displayTest.code, 'READY');
        command('display-test', {target:'hud'});
        assert.strictEqual(shown().test, true);
        freezeRtc();
        tick(second, 100);
        feed(utc());
        tick(second, 100);
        feed(utc());
        assert.strictEqual(state().clock.referenceSource, 'system', 'Advancing RMC cannot sustain a frozen RTC');
        assert.strictEqual(shown(), null);
        rejectPreview(state, command, 'STATIONARY_UNKNOWN');
    });

    await run('rtc-disagreement', -24 * 60 * 60 * second, ({ state, command, tick, feed, utc }) => {
        command('outputs', {cluster:false, hud:true});
        feed(utc());
        for (let i = 0; i < 4; i++) {
            tick(second, 100);
            feed(utc());
        }
        tick(100, 100);
        assert.strictEqual(state().clock.referenceSource, 'system', 'Yesterday’s advancing RTC cannot corroborate current RMC');
        rejectPreview(state, command, 'STATIONARY_UNKNOWN');
    });

    await run('network', null, ({ state, command, tick, feed, utc, setNetwork, shown }) => {
        assert.deepStrictEqual(state().outputs, {cluster:false, hud:false});
        command('outputs', {cluster:false, hud:true});
        const frozen = utc() - 14 * second;
        feed(frozen);
        command('gps-reset');
        assert.strictEqual(state().clock.admissionAfterUtcMs, wrongWall + 500);
        setNetwork(true);
        tick(16 * second);
        feed(frozen);
        assert.strictEqual(state().clock.referenceState, 'waiting');
        rejectPreview(state, command, 'STATIONARY_UNKNOWN');
        feed(utc());
        tick(second); feed(utc());
        assert.strictEqual(state().clock.referenceSource, 'network');
        assert.strictEqual(state().clock.referenceUtcMs, utc());
        assert.strictEqual(state().clock.admissionAfterUtcMs, utc() + 500);
        assert.strictEqual(state().gpsFix, null);
        assert.throws(() => command('gps-clock-confirm', {targetUtcMs:utc()}), /Unsupported command/);
        rejectPreview(state, command, 'STATIONARY_UNKNOWN');

        tick(second);
        const first = utc();
        feed(first);
        feed(first);
        rejectPreview(state, command, 'STATIONARY_UNKNOWN');
        tick(second);
        feed(utc());
        assert.strictEqual(state().gpsFix.speedKmh, 0);
        assert.strictEqual(state().actions.displayTest.code, 'READY');
        command('display-test', {target:'hud'});
        assert.strictEqual(state().displayTest.result.phase, 'unconfirmed');
        assert.strictEqual(shown().test, true);

        tick(second);
        feed(utc(), 20);
        assert.strictEqual(state().displayTest.stoppedReason, 'MOVING');
        assert.strictEqual(shown(), null);
        rejectPreview(state, command, 'MOVING');
        tick(second);
        const stationary = utc();
        feed(stationary);
        command('display-test', {target:'hud'});
        tick(3 * second + 1);
        feed(stationary);
        assert.strictEqual(state().displayTest.stoppedReason, 'STATIONARY_UNKNOWN');
        assert.strictEqual(shown(), null);
        rejectPreview(state, command, 'STATIONARY_UNKNOWN');

        tick(second); feed(utc());
        command('display-test', {target:'hud'});
        assert.strictEqual(shown().test, true);
        setNetwork(false);
        tick(second);
        assert.strictEqual(state().clock.referenceState, 'waiting');
        assert.strictEqual(state().gpsFix, null);
        assert.strictEqual(state().displayTest.active, false);
        assert.strictEqual(shown(), null);
        rejectPreview(state, command, 'STATIONARY_UNKNOWN');
    });
    for (const {source, rtcOffset} of [{source:'rtc', rtcOffset:0}, {source:'network', rtcOffset:null}]) {
        await run('mixed-rmc-' + source, rtcOffset, ({state, command, tick, feed, utc, setNetwork, shown}) => {
            command('outputs', {cluster:false, hud:true});
            setNetwork(true);
            const frozen = utc();
            for (let i = 0; i < 6; i++) {
                feed(i % 2 ? oldYear(frozen) : frozen);
                tick(second, 100);
            }
            assert.strictEqual(state().clock.referenceState, 'waiting');
            assert.strictEqual(state().clock.referenceCandidate, source);
            rejectPreview(state, command, 'STATIONARY_UNKNOWN');

            for (let i = 0; i < 5; i++) {
                feed(i % 2 ? oldYear(utc()) : utc(), i < 3 ? 25 : 0);
                tick(100, 100);
                feed(oldYear(frozen));
                tick(900, 100);
            }
            assert.strictEqual(state().clock.referenceSource, source, 'stale interleaved packets must not prevent corroboration');
            assert.strictEqual(state().gpsFix.speedKmh, 0);
            command('display-test', {target:'hud'});
            assert.strictEqual(shown().test, true);
            feed(oldYear(utc()), 25);
            assert.strictEqual(shown(), null);
            rejectPreview(state, command, 'MOVING');
            const last = utc();
            tick(3100, 100);
            feed(last);
            feed(oldYear(last));
            rejectPreview(state, command, 'STATIONARY_UNKNOWN');
        });
        await run('calendar-' + source, rtcOffset, ({state, command, tick, feed, utc, setNetwork, shown}) => {
            command('outputs', {cluster:false, hud:true});
            setNetwork(true);
            const yesterday = 86400 * second;
            feed(oldYear(utc() - yesterday));
            for (let i = 0; i < 6; i++) {
                tick(second, 100);
                feed(oldYear(utc() - yesterday));
            }
            assert.strictEqual(state().clock.referenceState, 'waiting', 'Matching time on the wrong day cannot establish the reference');
            rejectPreview(state, command, 'STATIONARY_UNKNOWN');
            for (let i = 0; i < 4; i++) {
                tick(second, 100);
                feed(oldYear(utc()));
            }
            assert.strictEqual(state().clock.referenceSource, source);
            assert.strictEqual(state().clock.rawSourceUtc, new Date(oldYear(utc())).toISOString());
            assert.strictEqual(state().clock.sourceUtcMs, utc());
            assert.strictEqual(state().clock.issue, 'NONE');
            assert.strictEqual(state().gpsFix.speedKmh, 0);
            command('display-test', {target:'hud'});
            assert.strictEqual(shown().test, true);
            tick(second, 100);
            feed(oldYear(utc()), 20);
            assert.strictEqual(state().displayTest.stoppedReason, 'MOVING');
            assert.strictEqual(shown(), null);
            tick(second, 100);
            const stopped = utc();
            feed(oldYear(stopped));
            command('display-test', {target:'hud'});
            tick(3001, 100);
            feed(oldYear(stopped));
            assert.strictEqual(shown(), null);
            rejectPreview(state, command, 'STATIONARY_UNKNOWN');
        });
    }
    console.log('PASS X6 missing RMC UTC, clock mismatch, reset cutoff, RTC/RMC progression, BMW calendar correction and HUD safety gates');
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
