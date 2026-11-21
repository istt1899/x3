'use strict';
// Synthetic source-fix replays against the real engine, without an SDK stub,
// head unit, network service, or claims about coverage of the shipped map.
const assert = require('assert');
const engine = require('../native/marku-kaluga-cameras/files/vehicle-guidance');
const preferences = require('../native/marku-kaluga-cameras/files/alert-preferences');
const cos = Math.cos(54 * Math.PI / 180);
function position(x, y) { return {lat: 54 + (y || 0) / 111320, lon: 36 + x / (111320 * cos)}; }
function fix(x, t, extra) { return Object.assign(position(x, 0), {timeMs: t, accuracyM: 5, speedKmh: 72, headingDeg: 90}, extra); }
function record(id, x, y, controls) { return {id, position: position(x || 0, y || 0), type: 'speed', controls: controls || ['speed'], limitKmh: 60}; }
function zone(id, x, roads) { return Object.assign({id, travel: [90], limit: 60}, position(x || 0, 0), {roads: roads || [{id: 'road-' + id, dir: 0, cam: 1, pts: [[-1600, 0], [0, 0], [300, 0]]}]}); }
function create(options) { return engine.createGuidance(Object.assign({zones: [zone('a')], records: [record('a')], nearby: false}, options)); }
function step(g, x, t, prefs, extra) { return g.evaluate(fix(x, t, extra), t, true, prefs); }
function admitted(options) { const g = create(options); assert.strictEqual(step(g, -520, 1000), null); assert(step(g, -500, 2000)); return g; }
function checkId(value, id, message) { assert(value && value.id === id, message || 'Expected camera ' + id); return value; }

// Every selectable distance really reaches the engine, independently of speed.
for (let range = 50; range <= 1000; range += 50) {
    const g = create(), prefs = {warningDistanceM: range};
    assert.strictEqual(step(g, -range - 10, 1000, prefs, {speedKmh: 36}), null);
    assert.strictEqual(step(g, -range, 2000, prefs, {speedKmh: 36}), null);
    const alert = step(g, -range + 10, 3000, prefs, {speedKmh: 36});
    assert(alert && alert.distanceM <= range && alert.roadConfirmed, 'Selected range ' + range + ' m was not applied');
}
const longRange = create(); step(longRange, -1000, 1000, null, {speedKmh: 36});
assert(step(longRange, -990, 2000, null, {speedKmh: 36}).distanceM > 600, 'Default is 1000 m, without the old speed-dependent 600 m ceiling');

// Source-valid 1000 -> 0 highway approach, including a frozen distance and
// small GNSS recession. Confirmation is an entry condition, not a per-fix gate.
const highway = create(); assert.strictEqual(step(highway, -1000, 1000), null);
let clock = 1000;
for (let metres = 980; metres >= 0; metres -= 20) {
    clock += 1000; checkId(step(highway, -metres, clock), 'a', 'Highway warning disappeared at ' + metres + ' m');
    if (metres === 500) {
        clock += 1000; checkId(step(highway, -501, clock), 'a', 'One-metre distance recession must not remove a verified approach');
        clock += 1000; checkId(step(highway, -501, clock), 'a', 'A fresh constant-distance fix must retain a verified approach');
    }
}
assert.strictEqual(highway.diagnostic().reason, 'TRACKING_APPROACH');
clock += 1000; checkId(step(highway, 5, clock), 'a', 'One fix beyond the camera does not confirm passage');
assert.strictEqual(highway.diagnostic().holdReason, 'CAMERA_PASSED');
checkId(highway.evaluate(fix(5, clock), clock + 100, true), 'a', 'Repeating that fix cannot confirm passage');
clock += 1000; assert.strictEqual(step(highway, 20, clock), null, 'A second progressing fix confirms passage');
assert.strictEqual(highway.diagnostic().lastClear.reason, 'CAMERA_PASSED');
const passedTransition = highway.diagnostic().transition;
clock += 1000; step(highway, 40, clock);
assert.deepStrictEqual(highway.diagnostic().transition, passedTransition, 'WAITING ticks must preserve the reason for withdrawal');

// Cumulative recession has a fixed bound relative to the closest source fix.
const recoil = admitted(); checkId(step(recoil, -491, 3000), 'a'); checkId(step(recoil, -496, 4000), 'a');
checkId(step(recoil, -503, 5000), 'a');
assert.strictEqual(recoil.diagnostic().holdReason, 'APPROACH_LOST');
assert.strictEqual(step(recoil, -508, 6000), null); assert.strictEqual(recoil.diagnostic().lastClear.reason, 'APPROACH_LOST');
const jump = admitted();
assert.strictEqual(Math.round(checkId(step(jump, -200, 3000), 'a').displayDistanceM), 500);
assert.strictEqual(jump.diagnostic().holdReason, 'POSITION_JUMP');
assert.strictEqual(jump.diagnostic().lastClear, null);
assert.strictEqual(Math.round(checkId(step(jump, -460, 4000), 'a').displayDistanceM), 460);

// Slow traffic uses current valid heading for tracking only; new admission
// still requires >=8 km/h. Fresh stopped fixes use the bounded prior anchor.
const slow = create(); step(slow, -190, 1000, null, {speedKmh: 36}); checkId(step(slow, -175, 2000, null, {speedKmh: 36}), 'a');
checkId(step(slow, -174, 3000, null, {speedKmh: 5}), 'a');
checkId(step(slow, -173, 4000, null, {speedKmh: 3}), 'a');
assert(checkId(step(slow, -173, 5000, null, {speedKmh: 0, headingDeg: null}), 'a').stopped);
checkId(step(slow, -174, 6000, null, {speedKmh: 5, headingDeg: 270}), 'a');
assert.strictEqual(step(slow, -175, 7000, null, {speedKmh: 5, headingDeg: 270}), null, 'A confirmed turn ends road tracking even while creeping');
const notAdmittedSlow = create(); step(notAdmittedSlow, -200, 1000, null, {speedKmh: 5});
assert.strictEqual(step(notAdmittedSlow, -199, 2000, null, {speedKmh: 5}), null);

// Reproduce the driver's 180 m → blank → 160 m, with a lateral BMW fix
// shift at the light and a held distance while stopped or on a duplicate.
const light = create();
assert.strictEqual(step(light, -200, 1000), null);
assert.strictEqual(Math.round(checkId(step(light, -180, 2000), 'a').displayDistanceM), 180);
const parked = {lat: position(0, 7).lat, speedKmh: 0, headingDeg: null};
assert.strictEqual(Math.round(checkId(step(light, -181, 3000, null, parked), 'a').displayDistanceM), 180);
assert.strictEqual(light.diagnostic().reason, 'STOPPED_APPROACH');
assert.strictEqual(Math.round(checkId(step(light, -189, 4000, null, parked), 'a').displayDistanceM), 180);
assert.strictEqual(Math.round(checkId(step(light, -179, 5000, null, {speedKmh: 2, headingDeg: null}), 'a').displayDistanceM), 179);
assert.strictEqual(Math.round(checkId(step(light, -160, 6000), 'a').displayDistanceM), 160);
assert.strictEqual(Math.round(checkId(light.evaluate(fix(-154, 6000), 6100, true), 'a').displayDistanceM), 160);
assert.strictEqual(Math.round(checkId(step(light, -162, 7000), 'a').displayDistanceM), 160);

// Geometry still prevents admission and confirms withdrawal after repeated deviation.
const offRoadPoint = {lat: position(0, 7).lat};
const offRoad = admitted(); checkId(step(offRoad, -480, 3000, null, offRoadPoint), 'a');
assert.strictEqual(step(offRoad, -460, 4000, null, offRoadPoint), null); assert.strictEqual(offRoad.diagnostic().lastClear.reason, 'OFF_ROAD');
const turn = admitted(); checkId(step(turn, -505, 3000, null, {speedKmh: 18, headingDeg: 270}), 'a');
assert.strictEqual(step(turn, -510, 4000, null, {speedKmh: 18, headingDeg: 270}), null); assert.strictEqual(turn.diagnostic().lastClear.reason, 'HEADING_MISMATCH');
const roads = [{id: 1, dir: 0, cam: 1, pts: [[-1600, 0], [0, 0], [300, 0]]}, {id: 2, dir: 0, cam: -1, pts: [[-1600, 25], [300, 25]]}];
const ambiguous = create({zones: [zone('a', 0, roads)]}); step(ambiguous, -200, 1000, null, {accuracyM: 10});
assert(step(ambiguous, -180, 2000, null, {accuracyM: 10}));
const ambiguousPoint = {accuracyM: 10, lat: position(0, 9).lat};
checkId(step(ambiguous, -170, 3000, null, ambiguousPoint), 'a');
assert.strictEqual(step(ambiguous, -150, 4000, null, ambiguousPoint), null); assert.strictEqual(ambiguous.diagnostic().lastClear.reason, 'AMBIGUOUS_ROAD');
const wrongWayRoads = [roads[0], {id: 2, dir: 0, cam: -1, pts: [[-1600, 40], [300, 40]]}];
const wrongRoad = admitted({zones: [zone('a', 0, wrongWayRoads)]});
const wrongPoint = {lat: position(0, 40).lat};
checkId(step(wrongRoad, -480, 5000, null, wrongPoint), 'a');
assert.strictEqual(step(wrongRoad, -460, 6000, null, wrongPoint), null); assert.strictEqual(wrongRoad.diagnostic().lastClear.reason, 'CAMERA_WAY_MISSING');

// The mapped adjacent road takes precedence over the proximity shortcut,
// even when its separation would otherwise fit the admission corridor.
const parallelRoads = [roads[0], {id: 3, dir: 0, cam: -1, pts: [[-500, 16], [300, 16]]}];
const parallel = create({nearby: true, zones: [zone('a', 0, parallelRoads)]});
const parallelFix = {lat: position(0, 16).lat};
for (let t = 1; t <= 12; t++) {
    assert.strictEqual(step(parallel, -215 + t * 20, t * 1000, null, parallelFix), null);
    assert.strictEqual(parallel.diagnostic().reason, 'CAMERA_WAY_MISSING');
}
assert.strictEqual(step(parallel, 25, 13000, null, Object.assign({}, parallelFix, {speedKmh: 0, headingDeg: null})), null);
const correctRoad = create({nearby: true, zones: [zone('a', 0, parallelRoads)]});
step(correctRoad, -200, 1000);
assert(checkId(step(correctRoad, -180, 2000), 'a').roadConfirmed);
checkId(step(correctRoad, -160, 3000, null, parallelFix), 'a');
assert.strictEqual(step(correctRoad, -140, 4000, null, parallelFix), null, 'A confirmed lane change to a mapped parallel road withdraws the alert');
const unzonedParallel = create({nearby: true, zones: []});
for (let t = 1; t <= 12; t++) {
    assert.strictEqual(step(unzonedParallel, -240 + t * 20, t * 1000, null, {lat: position(0, 28).lat}), null);
}

const accuracy = create(); assert.strictEqual(step(accuracy, -520, 1000), null);
assert.strictEqual(step(accuracy, -500, 2000, null, {accuracyM: 15.001}), null, 'Admission quality remains 15 m');
assert.strictEqual(accuracy.diagnostic().gpsReason, 'ACCURACY_EXCEEDS_15M');
const retainedQuality = admitted();
checkId(step(retainedQuality, -480, 3000, null, {accuracyM: 20}), 'a', 'A confirmed approach survives brief 20 m GNSS quality');
checkId(step(retainedQuality, -460, 4000, null, {accuracyM: 30}), 'a', 'Retention quality bound is 30 m');
assert.strictEqual(step(retainedQuality, -440, 5000, null, {accuracyM: 30.001}), null, 'Quality worse than the retention bound withdraws');
assert.strictEqual(retainedQuality.diagnostic().lastClear.gpsReason, 'ACCURACY_EXCEEDS_30M');
retainedQuality.evaluate(null, 6000, true); assert.strictEqual(retainedQuality.diagnostic().lastClear.gpsReason, 'ACCURACY_EXCEEDS_30M', 'Later missing fixes cannot erase the original quality failure');
const noNewLowQuality = create(); assert.strictEqual(step(noNewLowQuality, -480, 3000, null, {accuracyM: 20}), null,
    'Degraded quality cannot admit a new approach without the confirmed retention window');
assert.strictEqual(noNewLowQuality.diagnostic().gpsReason, 'ACCURACY_EXCEEDS_15M');
const expiry = admitted(), valid = fix(-500, 2000); assert.strictEqual(expiry.evaluate(valid, 5001, true), null);
assert.strictEqual(expiry.diagnostic().lastClear.gpsReason, 'UTC_EXPIRED');
assert.strictEqual(expiry.evaluate(valid, 5500, true), null);
const future = admitted(); assert.strictEqual(future.evaluate(fix(-480, 4000), 3499, true), null); assert.strictEqual(future.diagnostic().lastClear.gpsReason, 'UTC_FUTURE');
const replay = admitted();
assert.strictEqual(Math.round(checkId(replay.evaluate(fix(-510, 1000), 2100, true), 'a').displayDistanceM), 500);
assert.strictEqual(replay.diagnostic().holdReason, 'GPS_REPLAY');
assert.strictEqual(Math.round(checkId(replay.evaluate(fix(-509, 1000), 2200, true), 'a').displayDistanceM), 500,
    'A rejected replay cannot change the accepted position');
assert.strictEqual(Math.round(checkId(step(replay, -480, 3000), 'a').displayDistanceM), 480);

// Repeated UTC never confirms an approach. Small position/quality refreshes
// are allowed against the immutable first position, not a moving baseline.
const duplicate = create(), first = fix(-200, 1000); duplicate.evaluate(first, 1000, true);
for (let now = 1100; now <= 2900; now += 100) assert.strictEqual(duplicate.evaluate(first, now, true), null);
const source = create(); step(source, -190, 1000, null, {speedKmh: 36}); checkId(step(source, -175, 2000, null, {speedKmh: 36}), 'a');
for (const x of [-172, -169, -166]) {
    const sameTime = checkId(source.evaluate(fix(x, 2000, {speedKmh: 36}), 2100, true), 'a');
    assert.strictEqual(Math.round(sameTime.displayDistanceM), 175);
}
assert.strictEqual(Math.round(checkId(source.evaluate(fix(-163, 2000, {speedKmh: 36}), 2200, true), 'a').displayDistanceM), 175);
assert.strictEqual(source.diagnostic().holdReason, 'GPS_REPLAY');
const hugeSameTime = admitted();
assert.strictEqual(Math.round(checkId(hugeSameTime.evaluate(fix(-5, 2000), 2100, true), 'a').displayDistanceM), 500);
assert.strictEqual(hugeSameTime.diagnostic().lastClear, null);

// Settings are always rechecked, including on the same source timestamp.
const settings = admitted(); assert.strictEqual(settings.evaluate(fix(-500, 2000), 2100, true, {warningDistanceM: 450}), null);
assert.strictEqual(settings.diagnostic().lastClear.reason, 'OUT_OF_RANGE');
assert.strictEqual(settings.evaluate(fix(-500, 2000), 2200, true), null, 'Enlarging range cannot manufacture another approach sample');
assert.strictEqual(step(settings, -480, 3000), null); assert(step(settings, -460, 4000));
assert.strictEqual(settings.evaluate(fix(-460, 4000), 4100, false), null); assert.strictEqual(settings.diagnostic().lastClear.reason, 'DISABLED');
const filterKeys = Object.keys(preferences.DEFAULTS.cameraTypes);
filterKeys.forEach(type => {
    const r = record('a'); if (type === 'other') { r.type = 'generic'; r.controls = []; } else { r.type = type; r.controls = [type]; }
    const g = admitted({records: [r]}), types = {}; types[type] = false;
    assert.strictEqual(g.evaluate(fix(-500, 2000), 2100, true, {cameraTypes: types}), null, type + ' filter must withdraw immediately');
    assert.strictEqual(g.diagnostic().lastClear.reason, 'TYPE_DISABLED');
});

// Independent road candidates allow direct hand-off to the next camera,
// without an empty frame or carrying the old way/sign into the new record.
const nextCamera = create({zones: [zone('a'), zone('b', 20)], records: [record('a'), record('b', 20, 0, ['redlight'])]});
step(nextCamera, -60, 1000); checkId(step(nextCamera, -40, 2000), 'a'); checkId(step(nextCamera, -20, 3000), 'a'); checkId(step(nextCamera, 0, 4000), 'a');
checkId(step(nextCamera, 5, 5000), 'a');
const handed = checkId(step(nextCamera, 10, 6000), 'b');
assert.strictEqual(handed.way, 'road-b'); assert.deepStrictEqual(handed.controls, ['redlight']);
assert.strictEqual(nextCamera.diagnostic().transition.reason, 'SWITCHED');
const passFallback = admitted({nearby: true}); step(passFallback, -480, 3000);
// Use plausible, continuous approach fixes rather than a jump to the camera.
for (let x = -460, t = 4000; x <= 0; x += 20, t += 1000) step(passFallback, x, t);
checkId(step(passFallback, 5, 28000), 'a');
assert.strictEqual(step(passFallback, 10, 29000), null);
assert.strictEqual(step(passFallback, 10, 30000, null, {speedKmh: 0, headingDeg: null}), null, 'Proximity fallback must not resurrect a passed camera at a stop');

// Nearby (zone-less) entry and exit follow the 0.8.6 contract: motion plus the
// 40° ahead cone admit; the camera behind, the release margin, or three
// consecutive growing distances release. Lateral drift inside the cone keeps.
const vicinity = create({zones: [], nearby: true});
checkId(step(vicinity, -68, 1000, null, {lat: position(0, 16).lat}), 'a');
checkId(step(vicinity, -48, 2000, null, {lat: position(0, 19).lat}), 'a', 'Lateral jitter inside the cone keeps the warning');
assert.strictEqual(vicinity.diagnostic().reason, 'NEARBY_TRACKING');
const vicinityLat = {lat: position(0, 16).lat};
for (let x = -28, t = 3000; x <= 12; x += 20, t += 1000) checkId(step(vicinity, x, t, null, vicinityLat), 'a');
assert.strictEqual(vicinity.diagnostic().holdReason, 'BEHIND');
assert.strictEqual(step(vicinity, 32, 6000, null, vicinityLat), null, 'A genuine pass ends the warning');
assert.strictEqual(vicinity.diagnostic().lastClear.reason, 'BEHIND');
const recede = create({zones: [], nearby: true});
checkId(step(recede, -200, 1000, null, {accuracyM: 8}), 'a');
checkId(step(recede, -205, 2000, null, {accuracyM: 8}), 'a', 'One growing sample keeps the warning');
checkId(step(recede, -210, 3000, null, {accuracyM: 8}), 'a', 'Two growing samples keep the warning');
assert.strictEqual(step(recede, -213, 4000, null, {accuracyM: 8}), null, 'Three consecutive growing samples release it');
assert.strictEqual(recede.diagnostic().lastClear.reason, 'RECEEDING');
const angular = create({zones: [], nearby: true});
checkId(step(angular, -220, 1000, null, {headingDeg: 86}), 'a');
checkId(step(angular, -200, 2000, null, {headingDeg: 86}), 'a');
checkId(step(angular, -180, 3000, null, {headingDeg: 84}), 'a');
checkId(step(angular, -160, 4000, null, {headingDeg: 80}), 'a', 'A course inside the 40° cone keeps the warning');

// Small lateral shifts change which record is nearest. The displayed ID and
// its control metadata remain stable, including when the records differ.
function nearbyPair(controls) { return create({zones: [], nearby: true, records: [record('a', 0, -10), record('b', 0, 10, controls)]}); }
const pair = nearbyPair(); step(pair, -520, 1000, null, {lat: position(0, -4).lat}); checkId(step(pair, -500, 2000, null, {lat: position(0, -4).lat}), 'a');
checkId(step(pair, -480, 3000, null, {lat: position(0, 4).lat}), 'a');
const different = nearbyPair(['redlight']); step(different, -520, 1000, null, {lat: position(0, -4).lat}); checkId(step(different, -500, 2000, null, {lat: position(0, -4).lat}), 'a');
assert.deepStrictEqual(checkId(step(different, -480, 3000, null, {lat: position(0, 4).lat}), 'a').controls, ['speed']);
const redlight = nearbyPair(['redlight']);
assert.deepStrictEqual(checkId(step(redlight, -480, 1000, null, {lat: position(0, 4).lat}), 'b').controls, ['redlight']);
// Source ways 137476266 (Tsiolkovskogo) and 87083178 (Kaluga-Bor).
// The saved database has the point but no road for it. A direct bearing to
// the Kaluga-Bor point overlaps the Tsiolkovskogo heading for a full block.
const borPoint = {id: 'osc:5fcb5bcc64b9477303d56055', type: 'camera', sourceKind: 'dummy',
    position: {lat: 54.50972, lon: 36.22774}};
function kalugaSegment(a, b) {
    const guidance = create({zones: [], records: [borPoint]});
    const dx = (b[1] - a[1]) * 111320 * Math.cos(borPoint.position.lat * Math.PI / 180);
    const dy = (b[0] - a[0]) * 111320;
    const length = Math.hypot(dx, dy), headingDeg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    const frames = [];
    for (let metres = 0, timeMs = 1000; metres <= length; metres += 5, timeMs += 1000) {
        const fraction = metres / length;
        const sample = {lat: a[0] + (b[0] - a[0]) * fraction, lon: a[1] + (b[1] - a[1]) * fraction,
            timeMs, accuracyM: 6, headingDeg, speedKmh: 18};
        frames.push(guidance.evaluate(sample, timeMs, true, {warningDistanceM: 850}));
    }
    return frames;
}
assert(kalugaSegment([54.51408, 36.236653], [54.513677, 36.2358323]).every(frame => !frame),
    'Tsiolkovskogo must not warn about the point on Kaluga-Bor');
const onBor = kalugaSegment([54.5103182, 36.2245832], [54.5096678, 36.2280282]);
const firstBorAlert = onBor.findIndex(frame => frame !== null);
assert(firstBorAlert > 0, 'The mapped Kaluga-Bor approach must still warn');
const firstClearOnBor = onBor.findIndex((frame, i) => i > firstBorAlert && frame === null);
assert(firstClearOnBor > firstBorAlert);
assert(onBor.slice(firstBorAlert, firstClearOnBor).every(frame => frame && frame.id === borPoint.id && frame.roadConfirmed));
assert(onBor[firstClearOnBor - 1].distanceM < 6);
assert(onBor.slice(firstClearOnBor).every(frame => !frame), 'The Kaluga-Bor warning must stay cleared after passing');
console.log('PASS warning continuity: 20 distances/default 1000, stop and pass replays, bounded jitter and withdrawal, independent cameras, parallel roads, and mapped Tsiolkovskogo and Kaluga-Bor approaches');
