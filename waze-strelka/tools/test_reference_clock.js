'use strict';

const assert = require('assert');
const { createReferenceClock } = require('../native/marku-kaluga-cameras/files/reference-clock');

const wrongWall = Date.UTC(2179, 10, 19, 12);
const rmcMinute = Date.UTC(2026, 10, 19, 12);
const nextMinute = rmcMinute + 60000;

function fixture(initialWall = wrongWall) {
    let wall = initialWall, mono = 0;
    const clock = createReferenceClock({ wallNow: () => wall, monotonicNow: () => mono });
    return {
        clock,
        advance(ms) {
            while (ms > 0) {
                const step = Math.min(ms, 1000);
                wall += step;
                mono += step;
                clock.now();
                ms -= step;
            }
        },
        setWall(value) { wall = value; },
        shiftWall(ms) { wall += ms; },
        jump(ms) { wall += ms; mono += ms; }
    };
}

function calibrate(f) {
    f.clock.observeRmc(rmcMinute);
    assert.strictEqual(f.clock.snapshot().calibrationTargetUtcMs, nextMinute);
    f.advance(60000);
    assert.strictEqual(f.clock.confirm(nextMinute), true);
}

{
    const f = fixture(rmcMinute);
    f.clock.observeRmc(rmcMinute);
    assert.strictEqual(f.clock.snapshot().calibrationTargetUtcMs, null);
    assert.strictEqual(f.clock.now(), rmcMinute);
    assert.strictEqual(f.clock.confirm(nextMinute), false);
}

{
    const f = fixture();
    [null, NaN, rmcMinute + 0.1, Date.UTC(2019, 11, 31), wrongWall].forEach(value => {
        f.clock.observeRmc(value);
        assert.strictEqual(f.clock.snapshot().calibrationTargetUtcMs, null);
    });
    f.clock.observeRmc(rmcMinute);
    f.advance(60000);
    assert.strictEqual(f.clock.confirm(nextMinute), false, 'Requires an offered minute');
    assert.strictEqual(f.clock.now(), wrongWall + 60000);
}

{
    const f = fixture();
    const staleRmc = rmcMinute + 30000;
    f.clock.observeRmc(staleRmc);
    assert.strictEqual(f.clock.snapshot().calibrationTargetUtcMs, nextMinute);
    f.advance(16000);
    f.clock.observeRmc(staleRmc);
    f.clock.observeRmc(rmcMinute + 330000);
    assert.strictEqual(f.clock.snapshot().calibrationTargetUtcMs, nextMinute);
    assert.strictEqual(f.clock.now(), wrongWall + 16000, 'RMC only suggests a minute');
    assert.strictEqual(f.clock.confirm(nextMinute + 60000), false);
    assert.strictEqual(f.clock.confirm(nextMinute), true, 'Allows an independently verified minute with 14s-old RMC');
    assert.strictEqual(f.clock.confirm(nextMinute), false, 'Prevents extending an existing calibration');
    f.advance(250);
    assert.strictEqual(f.clock.now(), nextMinute + 250);
    const status = f.clock.snapshot();
    assert.strictEqual(status.referenceSource, 'phone');
    assert.strictEqual(status.generation, 1);
    assert.strictEqual(status.calibrationTargetUtcMs, null);
    assert.strictEqual(status.referenceExpiresInMs, 3600000 - 250);
}

{
    const f = fixture();
    f.clock.observeRmc(rmcMinute);
    assert.strictEqual(f.clock.snapshot().calibrationTargetUtcMs, nextMinute);
    f.advance(29999);
    assert.strictEqual(f.clock.confirm(nextMinute), false, 'Rejects confirmation more than 30s early');
    f.advance(40002);
    assert.strictEqual(f.clock.snapshot().calibrationTargetUtcMs, nextMinute + 60000);
    assert.strictEqual(f.clock.confirm(nextMinute), false, 'Retired offers cannot extend the confirmation window');
    f.advance(5000);
    assert.strictEqual(f.clock.confirm(nextMinute + 60000), false, 'Rejects early confirmation of a renewed offer');
}

{
    const f = fixture();
    f.clock.observeRmc(rmcMinute + 50001);
    assert.strictEqual(f.clock.snapshot().calibrationTargetUtcMs, nextMinute + 60000);
}

{
    const f = fixture();
    f.clock.observeRmc(rmcMinute + 15000);
    const rendered = f.clock.snapshot().calibrationTargetUtcMs;
    f.advance(55000);
    assert.strictEqual(f.clock.snapshot().calibrationTargetUtcMs, rendered);
    assert.strictEqual(f.clock.confirm(rendered), true, 'A rendered offer remains valid through the actuation window');
}

[
    [f => f.jump(5001), 'SERVICE_PAUSE'],
    [f => f.jump(-1), 'MONOTONIC_CLOCK_JUMP'],
    [f => f.shiftWall(251), 'WALL_CLOCK_JUMP'],
    [f => f.setWall(nextMinute), 'WALL_CLOCK_JUMP'],
    [f => {
        f.shiftWall(150);
        f.advance(1000);
        assert.strictEqual(f.clock.snapshot().referenceSource, 'phone');
        f.shiftWall(101);
    }, 'WALL_CLOCK_JUMP'],
    [f => {
        f.advance(3600000 - 1);
        assert.strictEqual(f.clock.snapshot().referenceExpiresInMs, 1);
        f.advance(1);
    }, 'REFERENCE_EXPIRED']
].forEach(([discontinue, reason]) => {
    const f = fixture();
    calibrate(f);
    discontinue(f);
    const status = f.clock.snapshot();
    assert.strictEqual(status.referenceSource, 'system');
    assert.strictEqual(status.calibrationTargetUtcMs, null);
    assert.strictEqual(status.lastDiscontinuity, reason);
    assert.strictEqual(status.generation, 2);
    assert.strictEqual(f.clock.now(), status.systemWallMs);
    assert.strictEqual(f.clock.confirm(nextMinute), false);
});

{
    const original = fixture();
    calibrate(original);
    const fresh = fixture(original.clock.snapshot().systemWallMs);
    assert.strictEqual(fresh.clock.snapshot().referenceSource, 'system');
    assert.strictEqual(fresh.clock.confirm(nextMinute), false);
}

console.log('reference clock tests passed');
