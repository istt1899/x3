'use strict';
const assert = require('assert');
const card = require('../native/marku-kaluga-cameras/files/alert-card');
const policy = require('../native/marku-kaluga-cameras/files/warning-policy');
const capture = require('../native/marku-kaluga-cameras/files/capture-data');

const now = Date.UTC(2026, 10, 8, 12);
const alert = { id: 'render-warning', roadConfirmed: true, limitKmh: 60, distanceM: 70, controls: ['speed', 'redlight'] };
const known = Object.assign({}, alert, { limitKmh: 40, distanceM: 180, speedKmh: 35 });
const limit = { x: 8, y: 5, w: 64, h: 90 };
const distance = { x: 79, y: 38, w: 143, h: 28 };
const speed = { x: 231, y: 29, w: 82, h: 28 };
const header = { x: 106, y: 4, w: 115, h: 24 };
const testLabel = { x: 229, y: 2, w: 82, h: 24 };

function facingAlert(bearings, course) {
    const field = { side: 'unknown', facingDeg: bearings[0], flowDeg: null, source: 'osm-direction', verified: true };
    const geometry = { state: 'mapped', bearingsDeg: bearings };
    return Object.assign({}, known, { capture: field, cameraFacing: geometry, captureClass: capture.classify(field, course, geometry) });
}

function sample(speedKmh, time, options) {
    const fix = { lat: 54, lon: 36, accuracyM: 5, timeMs: time, motionTimeMs: time, speedKmh };
    const decision = policy.evaluate(alert, fix, time, options);
    return Object.assign({}, alert, { speedKmh, overspeed: decision.overspeed, speedWarning: decision });
}
function crop(frame, area) {
    const rows = [];
    for (let y = area.y; y < area.y + area.h; y++) {
        const offset = (y * card.width + area.x) * 4;
        rows.push(frame.subarray(offset, offset + area.w * 4));
    }
    return Buffer.concat(rows);
}
function pixel(frame, x, y) {
    const offset = (y * card.width + x) * 4;
    return Array.from(frame.subarray(offset, offset + 4));
}

const a = sample(80.1, now);
const b = sample(80.1, now + 500);
const model = card.presentation(a);
assert.strictEqual(model.limit, 60);
assert.strictEqual(model.speedText, '>80');
assert.strictEqual(model.overspeed, true);
assert.strictEqual(model.flashActive, true);
assert.notStrictEqual(model.flashPhase, card.presentation(b).flashPhase);

const unknownLimit = Object.assign({}, known, { limitKmh: null });
const referenceOnly = Object.assign({}, unknownLimit, { cameraLimitKmh: 60, limitReference: { state: 'known', valueKmh: 70 }, overspeed: true });
const postedOnly = Object.assign({}, referenceOnly, { postedApproachLimitKmh: 40 });
const stop = Object.assign({}, known, { displayDistanceM: 180, distanceM: 195, speedKmh: 0 });
const held = Object.assign({}, stop, { gpsHeld: true, speedKmh: null });
assert.strictEqual(card.presentation(stop).distance, 180);
assert.strictEqual(card.presentation(stop).speedText, '0');
assert.strictEqual(card.presentation(held).distance, null);
assert.strictEqual(card.presentation(held).distanceStale, true);
assert.strictEqual(card.presentation(referenceOnly).limit, null);
assert.strictEqual(card.presentation(Object.assign({}, known, { limitKmh: 0.1 })).limit, null);
assert.strictEqual(card.presentation(referenceOnly).overspeed, false);
assert.strictEqual(card.presentation(postedOnly).limitScope, 'posted');
assert.strictEqual(card.presentation(postedOnly).overspeed, false);
assert.strictEqual(card.presentation(Object.assign({}, postedOnly, { limitKmh: 50 })).limit, 50);

const front = facingAlert([270], 90), rear = facingAlert([270], 270), both = facingAlert([90, 270], 90);
const cross = facingAlert([0], 90);
const flowEstimate = { side: 'unknown', facingDeg: 270, flowDeg: 90, source: 'osm-relation', verified: false };
const inferred = Object.assign({}, known, { capture: flowEstimate, captureClass: capture.classify(flowEstimate, 90) });
assert.strictEqual(inferred.captureClass, 'front', 'Guidance may infer a direction from the monitored traffic');
assert.strictEqual(card.presentation(inferred).direction, 'unknown', 'A flow estimate cannot draw a confirmed optical direction');
assert.strictEqual(card.presentation(Object.assign({}, known, { captureClass: 'rear' })).direction, 'unknown');
assert.strictEqual(card.presentation(cross).direction, 'unknown');
const intrinsic = { side: 'rear', facingDeg: null, flowDeg: null, source: 'gibdd-text', verified: true };
assert.strictEqual(card.presentation(Object.assign({}, known, {
    capture: intrinsic, captureClass: capture.classify(intrinsic, 90)
})).direction, 'rear', 'An explicitly recorded photographed side requires no invented facing angle');

for (const target of ['map', 'hud']) {
    const draw = value => card.card(value, target);
    const on = draw(a), off = draw(b);
    assert.strictEqual(on.length, 320 * 96 * 4);
    assert.strictEqual(off.length, on.length);
    let changes = 0;
    for (let y = 0; y < card.height; y++) {
        for (let x = 0; x < card.width; x++) {
            const offset = (y * card.width + x) * 4;
            assert.strictEqual(on[offset + 3], off[offset + 3], 'Flash never alters alpha');
            if (on[offset] === off[offset] && on[offset + 1] === off[offset + 1] && on[offset + 2] === off[offset + 2]) continue;
            changes++;
            assert(x >= speed.x && x < speed.x + speed.w && y >= speed.y && y < speed.y + speed.h, 'Only current speed digits may flash');
        }
    }
    assert(changes > 0);

    const teal = [128, 220, 209, 255], neutral = draw(known);
    for (const [input, side, nose, tail] of [
        [front, 'front', true, false], [rear, 'rear', false, true],
        [both, 'both', true, true], [inferred, 'unknown', false, false]
    ]) {
        assert.strictEqual(card.presentation(input).direction, side);
        const picture = draw(input);
        assert.deepStrictEqual(pixel(picture, 210, 21), [244, 247, 250, 255], 'Vehicle stays nose-up for all four states');
        assert.deepStrictEqual(pixel(picture, 214, 19), nose ? teal : pixel(neutral, 214, 19), 'Arrowhead touches the front bumper only for front/both');
        assert.deepStrictEqual(pixel(picture, 214, 60), tail ? teal : pixel(neutral, 214, 60), 'Arrowhead touches the rear bumper only for rear/both');
        assert.deepStrictEqual(pixel(picture, 233, 5), nose ? teal : pixel(neutral, 233, 5), 'Front arrow starts at its camera body');
        assert.deepStrictEqual(pixel(picture, 233, 70), tail ? teal : pixel(neutral, 233, 70), 'Rear arrow starts at its camera body');
        assert(crop(picture, limit).equals(crop(neutral, limit)), 'Changing the lens leaves the approach limit intact');
    }
    assert(draw(cross).equals(neutral) && draw(inferred).equals(neutral), 'Missing and unverified optics share a neutral graphic');
    assert.deepStrictEqual(pixel(neutral, 230, 27), [184, 194, 204, 255], 'Unknown shows a neutral camera beside the vehicle');

    const approaching = draw(known), stopped = draw(stop), waiting = draw(held);
    assert.deepStrictEqual(pixel(approaching, 10, 50), target === 'map' ? [10, 16, 24, 232] : [0, 0, 0, 0], 'Only cluster gets a compact dark background');
    assert.deepStrictEqual(pixel(approaching, 39, 12), [255, 90, 88, 255], 'Confirmed number has a red sign');
    assert.deepStrictEqual(pixel(draw(referenceOnly), 39, 12), [184, 194, 204, 255], 'Unknown limit keeps a neutral sign');
    assert.deepStrictEqual(pixel(draw(postedOnly), 39, 12), [255, 190, 94, 255], 'Qualified posted sign is visibly distinct');
    assert(crop(approaching, limit).equals(crop(stopped, limit)));
    assert(crop(stopped, limit).equals(crop(waiting, limit)), 'GPS hold keeps the current sign and camera card');
    assert(crop(draw(unknownLimit), limit).equals(crop(draw(referenceOnly), limit)), 'Database-only values cannot occupy the sign');
    assert(crop(approaching, distance).equals(crop(stopped, distance)), 'Last confirmed distance stays intact on a stop');
    assert(crop(waiting, distance).equals(crop(draw(Object.assign({}, known, { distanceM: null })), distance)), 'During GPS hold the distance shows a dash');
    assert(!crop(waiting, header).equals(crop(stopped, header)), 'GPS hold marks the header');
    assert(!crop(approaching, speed).equals(crop(stopped, speed)), 'Fresh stationary speed is drawn as zero');
    const tested = draw(Object.assign({}, stop, { test: true }));
    assert(!crop(tested, testLabel).equals(crop(stopped, testLabel)), 'Stationary test carries a visible label');
    assert(crop(tested, limit).equals(crop(stopped, limit)) && crop(tested, distance).equals(crop(stopped, distance)) && crop(tested, speed).equals(crop(stopped, speed)), 'Test label never covers the three numeric slots');
}
const staticA = sample(81, now, { visualFlash: false });
const staticB = sample(81, now + 500, { visualFlash: false });
assert(card.card(staticA, 'map').equals(card.card(staticB, 'map')));
assert(card.presentation(staticA).overspeed);
assert.strictEqual(card.presentation(sample(60.1, now)).speedText, '>60');
assert.strictEqual(card.presentation(sample(80, now)).speedText, '80');
assert.strictEqual(card.presentation(sample(81, now)).speedText, '81');
const highAlert = Object.assign({}, a, { limitKmh: 300, speedKmh: 330.1, speedWarning: { displayBoundaryKmh: 330 } });
assert.strictEqual(card.presentation(highAlert).speedText, '>330');
const badReference = Object.assign({}, a, { roadConfirmed: false, limitKmh: null, cameraLimitKmh: 60 });
assert.strictEqual(card.presentation(badReference).overspeed, false);
assert.strictEqual(card.presentation(badReference).flashActive, false);
console.log('PASS Atlas HUD and cluster pixels: verified front, rear, both and neutral optics, persistent limit, stationary speed, GPS hold, marked test and speed-only flash');
