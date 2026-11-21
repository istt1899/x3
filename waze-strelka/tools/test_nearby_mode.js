'use strict';
// 0.8.6 nearby mode: the owner's contract, synthetic engine replays only.
// Covered: approach/hold/pass without flicker, owner cameras, behind/facing
// rejection, stationary admission ban, road priority, boundary noise, zones.
const assert = require('assert');
const engine = require('../native/marku-kaluga-cameras/files/vehicle-guidance');
const preferences = require('../native/marku-kaluga-cameras/files/alert-preferences');
const captureData = require('../native/marku-kaluga-cameras/files/capture-data');
const cos = Math.cos(54 * Math.PI / 180);
function position(x, y) { return { lat: 54 + (y || 0) / 111320, lon: 36 + x / (111320 * cos) }; }
function fix(x, t, extra) { return Object.assign(position(x, 0), { timeMs: t, accuracyM: 5, speedKmh: 36, headingDeg: 90 }, extra); }
function record(id, x, y, controls, extra) { return Object.assign({ id, position: position(x || 0, y || 0), type: 'speed', controls: controls || ['speed'], limitKmh: 60 }, extra || {}); }
function zone(id, x) { return Object.assign({ id, travel: [90], limit: 60 }, position(x || 0, 0), { roads: [{ id: 'road-' + id, dir: 0, cam: 1, pts: [[-1600, 0], [0, 0], [300, 0]] }] }); }
function step(g, x, t, prefs, extra) { return g.evaluate(fix(x, t, extra), t, true, prefs); }
function checkId(value, id, message) { assert(value && value.id === id, message || 'Expected camera ' + id); return value; }

// 2. A zone-less camera warns in advance, holds through the pass and clears.
{
    const g = engine.createGuidance({ zones: [], records: [record('n', 0, 0)], nearby: true });
    assert.strictEqual(step(g, -1200, 1000), null, 'Beyond the warning distance no notice');
    checkId(step(g, -400, 2000), 'n', 'The warning appears in advance inside the distance');
    let seen = null;
    for (let x = -380, t = 3000; x <= 0; x += 20, t += 1000) seen = checkId(step(g, x, t), 'n', 'Notice lost at ' + x + ' m');
    assert.strictEqual(seen.roadConfirmed, false, 'A zone-less camera stays an honest nearby notice');
    assert.strictEqual(step(g, 20, 42000), null, 'The warning clears right after the pass');
    assert.strictEqual(g.diagnostic().lastClear.reason, 'BEHIND');
}
// 2b. Passing does not resurrect: standing near the passed camera stays silent.
{
    const g = engine.createGuidance({ zones: [], records: [record('n', 0, 0)], nearby: true });
    for (let x = -200, t = 1000; x <= 0; x += 20, t += 1000) step(g, x, t);
    assert.strictEqual(step(g, 20, 12000), null);
    assert.strictEqual(step(g, 25, 13000, null, { speedKmh: 0, headingDeg: null }), null, 'A passed camera never returns at a stop');
}
// 3. The owner's reported camera warns even with every type switch off.
{
    const owner = record('reported:test:1', 0, 0, [], { provenance: 'owner-report', positionKind: 'intersection', reportStatus: 'unverified' });
    assert.strictEqual(preferences.matches(owner, preferences.normalize()), true, 'Owner reports bypass type switches');
    const off = { cameraTypes: {} };
    Object.keys(preferences.DEFAULTS.cameraTypes).forEach(type => { off.cameraTypes[type] = false; });
    assert.strictEqual(preferences.matches(owner, preferences.normalize(off)), true, 'Even with all types off the owner camera matches');
    const g = engine.createGuidance({ zones: [], records: [owner], nearby: true });
    const notice = step(g, -150, 1000, off);
    checkId(notice, 'reported:test:1', 'The owner camera warns in nearby mode');
    assert.strictEqual(notice.confidence, 'nearby');
}
// 4. Direction classes: facing our course shoots the rear plate (warn),
// facing against us is «в лицо» (warn), a verified cross-road camera does not
// warn at all, and an unknown direction warns honestly.
{
    const behind = engine.createGuidance({ zones: [], records: [record('n', 0, 0)], nearby: true });
    assert.strictEqual(step(behind, 300, 1000, null, { headingDeg: 90 }), null, 'A camera behind the course is not a candidate');
    assert.strictEqual(behind.diagnostic().nearestReject, 'BEHIND');
    const mk = dir => engine.createGuidance({ zones: [], records: [record('osm:node:10701120297', 0, 0, ['speed'],
        { sourceUrl: 'https://www.openstreetmap.org/node/10701120297', rawDirection: dir })], nearby: true });
    const at = (g, extra) => step(g, -200, 1000, null, Object.assign({ headingDeg: 90 }, extra));
    const rearAlert = at(mk('E'));
    assert.strictEqual(captureData.classify(rearAlert.capture, 90), 'rear', 'A camera facing along our course shoots the rear plate and warns');
    assert.strictEqual(captureData.classify(at(mk('W')).capture, 90), 'front', 'A camera facing against our course is «в лицо»');
    const cross = mk('N');
    assert.strictEqual(at(cross), null, 'A verified camera looking across the road does not warn');
    assert.strictEqual(cross.diagnostic().nearestReject, 'DIRECTION');
    const inferred = engine.createGuidance({ zones: [], records: [record('inferred', 0, 0, ['speed'],
        { capture: { source: 'osm-relation', verified: false, side: 'unknown', facingDeg: 0 } })], nearby: true });
    assert.strictEqual(checkId(at(inferred), 'inferred').roadConfirmed, false,
        'An inferred lens direction cannot veto a nearby notice or create a confirmed road match');
    checkId(at(mk('N;W')), 'osm:node:10701120297', 'A mapped direction matching the road admits a nearby notice');
    assert.strictEqual(at(mk('N;S')), null, 'A camera with only verified cross-road azimuths still does not warn');
}
// 5. Standing still never admits a new nearby warning.
{
    const g = engine.createGuidance({ zones: [], records: [record('n', 0, 0)], nearby: true });
    const standing = step(g, -40, 1000, null, { speedKmh: 0, headingDeg: null });
    assert.strictEqual(standing, null, 'No new nearby warning at a standstill');
    assert.strictEqual(g.diagnostic().nearestReject, 'STATIONARY');
}
// 6. A confirmed road warning wins over any nearby candidate.
{
    const g = engine.createGuidance({ zones: [zone('r', 0)], records: [record('r', 0, 0), record('n', 30, 0)], nearby: true });
    step(g, -300, 1000);
    const road = checkId(step(g, -280, 2000), 'r', 'The road candidate confirms on the second sample');
    assert.strictEqual(road.roadConfirmed, true);
    for (let x = -260, t = 3000; x <= 0; x += 20, t += 1000) {
        const alert = step(g, x, t);
        assert(alert && alert.id === 'r' && alert.roadConfirmed, 'Road keeps priority over the nearby camera at ' + x);
    }
}
// 7. GPS noise of ±10 m at the boundary does not flicker the warning, and
// alternating grow/shrink never reaches the three-sample recede exit.
{
    const g = engine.createGuidance({ zones: [], records: [record('n', 0, 0)], nearby: true });
    checkId(step(g, -220, 1000), 'n');
    let t = 2000;
    for (let i = 0; i < 10; i++) {
        checkId(step(g, -220 + (i % 2 ? 9 : -9), t), 'n', 'Noise must not flicker the warning');
        t += 1000;
    }
    assert.strictEqual(g.diagnostic().mode, 'nearby');
}
// 7b. Anti-flicker floor: right after the card appears, three quick distance
// growths (noise, a turn) may not withdraw it; passing (BEHIND) still clears.
{
    const g = engine.createGuidance({ zones: [], records: [record('n', 0, 0)], nearby: true });
    checkId(step(g, -220, 1000), 'n');
    checkId(step(g, -230, 1500), 'n');
    checkId(step(g, -240, 2000), 'n');
    checkId(step(g, -250, 2500), 'n', 'the three-second show floor keeps the card through quick recession noise');
    assert.strictEqual(g.diagnostic().mode, 'nearby');
    // After the floor expires the same recession releases it honestly.
    assert.strictEqual(step(g, -300, 6000), null, 'past the floor the release applies');
    assert.strictEqual(g.diagnostic().lastClear.reason, 'RECEEDING');
    const pass = engine.createGuidance({ zones: [], records: [record('n', 0, 0)], nearby: true });
    checkId(step(pass, -50, 1000), 'n');
    assert.strictEqual(step(pass, 30, 1500), null, 'passing the camera clears inside the floor');
    assert.strictEqual(pass.diagnostic().lastClear.reason, 'BEHIND');
}
// 8. The 19 road zones still work unchanged with nearby mode enabled.
{
    const g = engine.createGuidance({ zones: [zone('r', 0)], records: [record('r', 0, 0)], nearby: true });
    step(g, -300, 1000);
    const road = step(g, -280, 2000);
    assert(road && road.roadConfirmed === true && road.confidence === 'road', 'Road confirmation is unchanged');
    assert.strictEqual(g.diagnostic().zoneCount, 1);
}
console.log('PASS nearby mode 0.8.6: advance/hold/pass without flicker, no resurrection at a stop, owner cameras with all types off, behind/facing rejection, stationary ban, road priority, ±10 m boundary noise, road zones unchanged; synthetic only');
