// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const service = require('../native/marku-kaluga-cameras/files/marku-kaluga-cameras');
const { GpsProvider } = require('../native/marku-kaluga-cameras/files/gps-source');

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

async function run(label, rtcOffsetMs, test) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'strelka-x6-'));
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\strelka-x6-' + process.pid + '-' + label : path.join(dir, 'ctl.sock');
    let elapsed = 0, frozenRtc = null, networkAvailable = false;
    const mono = () => elapsed;
    const utc = () => actualUtc + elapsed;
    const rtcNow = () => rtcOffsetMs === null ? NaN : Math.floor((utc() + rtcOffsetMs) / second) * second;
    const gps = new GpsProvider({ now: () => wrongWall + elapsed, monotonicNow: mono, nmeaPort: 0, port: 1,
        createNetworkUtc: () => ({now: () => networkAvailable ? utc() : null, close() {}}),
        readRtc: () => frozenRtc === null ? rtcNow() : frozenRtc });
    let app, shown;
    try {
        await new Promise((resolve, reject) => {
            app = service.start({ dataDir: dir, socket, gps, monotonicNow: mono, onListening: resolve, onError: reject,
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
        await test({ state, command, tick, feed, utc, freezeRtc: () => { frozenRtc = rtcNow(); }, setNetwork: enabled => { networkAvailable = enabled; }, shown: () => shown });
    } finally {
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
        assert.strictEqual(state().displayTest.result.phase, 'shown');
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
    console.log('PASS X6 clock mismatch, reset cutoff, RTC/RMC progression, BMW calendar correction and HUD safety gates');
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
