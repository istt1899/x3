// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const { GpsProvider } = require('../native/marku-kaluga-cameras/files/gps-source');

const wall2179 = Date.UTC(2179, 5, 5, 21, 3, 27);
const utc2026 = Date.UTC(2026, 10, 22, 7, 8, 23);

function replay(wallStart) {
    let elapsed = 0, boot = 120.25, network = false;
    const wall = () => wallStart + elapsed;
    const utc = () => utc2026 + elapsed;
    const gps = new GpsProvider({ now: wall, monotonicNow: () => elapsed, bootSec: () => boot,
        readRtc: () => null, createNetworkUtc: () => ({ now: () => network ? utc() : null, close() {} }) });
    return { gps, wall, utc, boot: () => boot, current: () => gps.current(gps.now()), motion: () => gps.motionFixes(gps.now()),
        diagnostics: () => gps.diagnostics(gps.now()).gpsNavigation,
        tick(ms) { elapsed += ms; boot += ms / 1000; },
        advanceBoot(ms) { boot += ms / 1000; },
        network(enabled) { network = enabled; } };
}

function navigation(extra) {
    return Object.assign({ lat: 54.85, lon: 36.17, speedKmh: 36, headingDeg: 90, accuracyM: null,
        accuracySource: 'bmw-road-match', motionDerived: true, timeOrigin: 'receipt' }, extra);
}

function sentence(body) {
    let checksum = 0;
    for (const ch of body) checksum ^= ch.charCodeAt(0);
    return '$' + body + '*' + ('0' + checksum.toString(16)).slice(-2).toUpperCase();
}

function feedBmw(gps, utc, parts) {
    const iso = new Date(utc).toISOString();
    const time = iso.slice(11, 23).replace(/:/g, '');
    const date = iso.slice(8, 10) + iso.slice(5, 7) + iso.slice(2, 4);
    const coordinates = '5451.000,N,03610.000,E';
    const lines = [sentence(`GNRMC,${time},A,${coordinates},20,90,${date},,,A`)];
    if (parts === 'invalid') lines.push(sentence(`GNGGA,${time},${coordinates},0,00,99.9,,M,,M,,`));
    if (parts === 'complete') {
        lines.push(sentence(`GNGGA,${time},${coordinates},1,10,0.8,150,M,0,M,,`));
        lines.push(sentence(`GNGST,${time},1,1,1,0,3,4,6`));
    }
    gps.inputNmea(lines.join('\r\n'));
}

function checkNavigation(state) {
    const fix = state.current();
    assert(fix);
    assert.strictEqual(fix.source, 'bmw-navigation');
    assert.strictEqual(fix.speedKmh, 36);
    assert.deepStrictEqual(state.motion(), [{ source: 'bmw-navigation', timeMs: fix.timeMs, motionTimeMs: fix.timeMs, speedKmh: 36 }]);
    assert.strictEqual(state.diagnostics().state, 'ready');
    return fix;
}

// The engine can use navigation events before absolute UTC has been recovered.
{
    const state = replay(wall2179), gps = state.gps;
    const sample = navigation({ sampledAtBootSec: state.boot() - 0.25 });
    assert.strictEqual(gps.referenceClock.snapshot().referenceState, 'waiting');
    assert.strictEqual(gps.inputNavigation(navigation({ timeMs: state.wall() })), false, 'getter receipt cannot establish current motion');
    assert.strictEqual(gps.inputNavigation(navigation({ timeMs: state.wall(), timeOrigin: 'source' })), false, 'bad wall is not an absolute UTC comparison');
    assert.strictEqual(gps.inputNavigation(Object.assign({}, sample, { accuracyM: 16 })), false, 'boot stamp does not relax the accuracy limit');
    assert.strictEqual(gps.inputNavigation(Object.assign({}, sample, { accuracySource: 'explicit' })), false, 'missing metre accuracy still needs BMW road match');
    assert.strictEqual(gps.inputNavigation(Object.assign({}, sample, { sampledAtBootSec: state.boot() + 0.01 })), false);
    assert.strictEqual(gps.inputNavigation(Object.assign({}, sample, { sampledAtBootSec: state.boot() - 3 })), false);
    assert.strictEqual(gps.inputNavigation(sample), true);
    const fix = checkNavigation(state);
    assert.strictEqual(fix.timeMs, state.wall() - 250);
    assert.strictEqual(fix.timeOrigin, 'receipt');
    assert.strictEqual(state.diagnostics().sampleAgeMs, 250);
    feedBmw(gps, state.utc(), 'invalid');
    assert.strictEqual(checkNavigation(state), fix, 'an unconfirmed satellite fix cannot replace navigation');

    state.tick(2000);
    assert.strictEqual(gps.inputNavigation(Object.assign({}, sample, { speedKmh: 0 })), false, 'duplicate publish must not replace a moving sample');
    assert.strictEqual(gps.inputNavigation(Object.assign({}, sample, { sampledAtBootSec: sample.sampledAtBootSec - 0.25 })), false);
    assert.strictEqual(checkNavigation(state), fix);
    state.advanceBoot(750);
    assert.strictEqual(state.current(), null, 'boot freshness expires even if wall and process clocks do not advance');
    assert.deepStrictEqual(state.motion(), []);
    assert.strictEqual(state.diagnostics().state, 'unavailable');
    gps.close();
}

// A reference transition invalidates the old projected epoch; reset separately
// rejects every event that could have been sampled before the boot boundary.
{
    const state = replay(wall2179), gps = state.gps;
    gps.now();
    state.network(true);
    state.tick(4100);
    feedBmw(gps, state.utc());
    const beforeSwitch = navigation({ sampledAtBootSec: state.boot() });
    assert.strictEqual(gps.inputNavigation(beforeSwitch), true);
    checkNavigation(state);
    state.tick(500);
    feedBmw(gps, state.utc());
    assert.strictEqual(gps.referenceClock.snapshot().referenceSource, 'network');
    assert.strictEqual(state.current(), null, 'the 2179 projection cannot be reused in 2026');
    assert.strictEqual(state.diagnostics().state, 'unavailable');
    assert.strictEqual(gps.inputNavigation(beforeSwitch), false, 'a reference change must not re-admit a published event');

    const buffered = navigation({ sampledAtBootSec: state.boot() });
    gps.resetEpoch(gps.now());
    assert.strictEqual(state.current(), null);
    assert.deepStrictEqual(state.motion(), []);
    state.tick(200);
    assert.strictEqual(gps.inputNavigation(buffered), false, 'an unseen pre-reset event must be rejected too');
    assert.strictEqual(gps.inputNavigation(navigation({ timeMs: state.utc() })), false, 'getter remains gated during priming');
    const duringPriming = navigation({ sampledAtBootSec: state.boot() });
    assert.strictEqual(gps.inputNavigation(duringPriming), true);
    assert.strictEqual(checkNavigation(state).timeMs, state.utc());

    state.tick(400);
    feedBmw(gps, state.utc(), 'complete');
    checkNavigation(state);
    state.tick(500);
    feedBmw(gps, state.utc(), 'complete');
    assert.strictEqual(state.current().source, 'bmw-nmea');
    assert(state.motion().length > 0 && state.motion().every(item => item.source === 'bmw-nmea'));

    state.tick(1900);
    assert.strictEqual(gps.inputNavigation(navigation({ sampledAtBootSec: state.boot() })), true);
    assert.strictEqual(state.current().source, 'bmw-nmea', 'road-ready satellite fix keeps priority');
    state.tick(1200);
    checkNavigation(state);
    state.network(false);
    assert.strictEqual(gps.referenceClock.snapshot().referenceState, 'waiting');
    assert.strictEqual(state.current(), null);
    assert.deepStrictEqual(state.motion(), []);
    gps.close();
}

// A healthy X3 can still accept explicit source UTC and legacy receipt fixes.
{
    const state = replay(utc2026), gps = state.gps;
    assert.strictEqual(gps.inputNavigation(navigation({ timeOrigin: 'source', timeMs: state.utc() - 500 })), true);
    assert.strictEqual(checkNavigation(state).timeMs, state.utc() - 500);
    assert.strictEqual(gps.inputNavigation(navigation({ timeMs: state.utc() })), true);
    assert.strictEqual(checkNavigation(state).timeMs, state.utc());
    gps.close();
}

console.log('PASS X6 wake navigation: boot-sample freshness, reset and replay fences, reference transitions and satellite priority');
