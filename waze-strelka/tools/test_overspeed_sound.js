'use strict';
// 0.8.7 overspeed sound: owner's scenario — camera 60, GPS 90, threshold +20
// must ring; 75 must not; repeat on the interval; 3 km/h hysteresis; unknown
// limit and disabled sound stay silent; a camera-appearance signal is optional.
const assert = require('assert');
const policy = require('../native/marku-kaluga-cameras/files/warning-policy');
const { createAudio } = require('../native/marku-kaluga-cameras/files/warning-audio');
function defer() { var a, b, p = new Promise((x, y) => { a = x; b = y; }); return { promise: p, resolve: a, reject: b }; }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
const now = 200000;
function fix(t, s) { return { lat: 54, lon: 36, accuracyM: 5, timeMs: t, motionTimeMs: t, speedKmh: s }; }
function alert(id, extra) { return Object.assign({ id: id, sign: 1, roadConfirmed: true, limitKmh: 60, distanceM: 250 }, extra || {}); }

// Policy: the boundary arithmetic and eligibility.
const road = alert('a');
assert.strictEqual(policy.evaluate(road, fix(now, 90), now, {}).soundExceeded, true, '60 +20: 90 rings');
assert.strictEqual(policy.evaluate(road, fix(now, 80), now, {}).soundExceeded, false, 'exactly the boundary is silent');
assert.strictEqual(policy.evaluate(road, fix(now, 75), now, {}).soundExceeded, false, '75 is below the threshold');
assert.strictEqual(policy.evaluate(road, fix(now, 90), now, { soundEnabled: false }).soundExceeded, false, 'disabled sound never rings');
assert.strictEqual(policy.evaluate(alert('b', { limitKmh: null }), fix(now, 90), now, {}).soundExceeded, false, 'unknown limit → no sound');
// The owner's scenario works for an honest nearby notice with a known reference.
const nearby = alert('n', { roadConfirmed: false, limitKmh: null, limitReference: { state: 'known', valueKmh: 60 } });
const nr = policy.evaluate(nearby, fix(now, 90), now, {});
assert.strictEqual(nr.soundEligible, true, 'nearby with a known reference limit is sound-eligible');
assert.strictEqual(nr.soundExceeded, true);
assert.strictEqual(nr.reason, 'ROAD_UNCONFIRMED', 'visual semantics stay honest for nearby');
// Control distance: beyond it — silent.
assert.strictEqual(policy.evaluate(alert('far', { distanceM: 900 }), fix(now, 90), now, {}).soundExceeded, false, 'beyond the control distance no sound');
assert.strictEqual(policy.evaluate(alert('in', { distanceM: 300 }), fix(now, 90), now, { soundDistanceM: 200 }).soundExceeded, false, 'a tighter control distance applies');
assert.strictEqual(policy.evaluate(alert('in', { distanceM: 150 }), fix(now, 90), now, { soundDistanceM: 200 }).soundExceeded, true);

// Scheduler: repeat on the interval, hysteresis 3 km/h, appear signal.
(async () => {
    const calls = [], queue = [];
    const a = createAudio({ play: q => { calls.push(q); const d = defer(); queue.push(d); return d.promise; } }, { timeoutMs: 30 });
    a.configure({ soundEnabled: true, soundOffsetKmh: 20, soundRepeatSec: 3, soundOnCameraAppear: false });
    a.update(alert('A'), fix(now, 90), now); await wait(1);
    assert.strictEqual(calls.length, 1, 'first overspeed rings once');
    queue[0].resolve({ played: true }); await wait(1);
    a.update(alert('A'), fix(now + 1000, 90), now + 1000); await wait(1);
    assert.strictEqual(calls.length, 1, 'inside the interval no repeat');
    a.update(alert('A'), fix(now + 3100, 90), now + 3100); await wait(1);
    assert.strictEqual(calls.length, 2, 'the repeat fires on the 3 s interval');
    queue[1].resolve({ played: true }); await wait(1);
    // Hysteresis: 79 (boundary 80) keeps the latch; 77 (boundary-3) drops it.
    a.update(alert('A'), fix(now + 3200, 79), now + 3200); await wait(1);
    a.update(alert('A'), fix(now + 3300, 82), now + 3300); await wait(1);
    assert.strictEqual(calls.length, 2, 'no new episode above boundary-3');
    a.update(alert('A'), fix(now + 3400, 77), now + 3400); await wait(1);
    a.update(alert('A'), fix(now + 3500, 82), now + 3500); await wait(1);
    assert.strictEqual(calls.length, 3, 'below boundary-3 re-arms a new episode');
    queue[2].resolve({ played: true }); await wait(1);
    // Appearance signal: enabling it rings once when a new camera appears,
    // regardless of overspeed.
    a.configure({ soundEnabled: true, soundOffsetKmh: 20, soundRepeatSec: 3, soundOnCameraAppear: true });
    a.update(alert('B', { limitKmh: 60 }), fix(now + 4000, 40), now + 4000); await wait(1);
    assert.strictEqual(calls.length, 4, 'a new camera appearance rings once by setting');
    assert.strictEqual(calls[3].kind, 'appear');
    queue[3].resolve({ played: true }); await wait(1);
    a.close();
    // Unknown limit through the scheduler: no ring.
    const silent = [];
    const b = createAudio({ play: q => { silent.push(q); return Promise.resolve({ played: true }); } });
    b.configure({ soundEnabled: true, soundOffsetKmh: 20, soundRepeatSec: 5, soundOnCameraAppear: false });
    b.update(alert('U', { limitKmh: null }), fix(now, 90), now); await wait(1);
    assert.strictEqual(silent.length, 0, 'unknown limit stays silent end to end');
    b.close();
    console.log('PASS overspeed sound: 60/+20 rings at 90 not at 75, nearby reference limit, control distance, 3 s repeat, 3 km/h hysteresis, appear signal, unknown limit silent; policy + scheduler');
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
