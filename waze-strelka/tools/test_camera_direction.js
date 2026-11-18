'use strict';
// 0.8.7 camera direction: source parsers, the normalized capture field, the
// driver-relative classifier and the real rebuilt coverage numbers.
const assert = require('assert'), fs = require('fs'), path = require('path');
const base = path.join(__dirname, '../native/marku-kaluga-cameras/files');
const capture = require(path.join(base, 'capture-data'));
const info = require(path.join(base, 'camera-info'));

// --- source parsers -------------------------------------------------------
// OSM direction / camera:direction on the camera node.
let r = { id: 'osm:node:10701120297', type: 'speed', controls: ['speed'], position: { lat: 54, lon: 36 },
    sourceUrl: 'https://www.openstreetmap.org/node/10701120297', rawDirection: '271' };
assert.deepStrictEqual(capture.captureFor(r), { side: 'unknown', facingDeg: 271, flowDeg: null, source: 'osm-direction', verified: true });
r = Object.assign({}, r, { rawDirection: 'N' });
assert.strictEqual(capture.captureFor(r).facingDeg, 0, 'cardinal N is 0°');
// OSM enforcement relation: from→to geometry is the monitored flow.
r = { id: 'osm:node:3000000001', type: 'speed', controls: ['speed'], position: { lat: 54, lon: 36 },
    sourceUrl: 'https://www.openstreetmap.org/node/3000000001',
    enforcementRelations: [{ id: 10391681, members: [
        { type: 'node', ref: 1, role: 'from', position: { lat: 54, lon: 36.0 } },
        { type: 'node', ref: 2, role: 'to', position: { lat: 54, lon: 36.01 } }] }] };
const rel = capture.captureFor(r);
assert.strictEqual(rel.source, 'osm-relation');
assert.strictEqual(rel.flowDeg, 90, 'from→to east gives a 90° monitored flow');
assert.strictEqual(rel.facingDeg, 270, 'lens assumed against the flow and marked unverified');
assert.strictEqual(rel.verified, false);
// Junction relation with several from members is ambiguous: no direction.
r.enforcementRelations[0].members.push({ type: 'node', ref: 3, role: 'from', position: { lat: 54.001, lon: 36 } });
assert.strictEqual(capture.captureFor(r), null, 'a junction-wide relation yields no direction');
// OpenSpeedcam: community azimuth of the monitored flow, unverified.
r = { id: 'osc:619c87ee2aff727eb541eb5b', type: 'speed', controls: ['speed'], position: { lat: 54.5, lon: 36.3 },
    provenance: 'OpenSpeedcam', sourceUrl: 'https://openspeedcam.net/?point=619c87ee2aff727eb541eb5b', rawDirection: '271' };
const osc = capture.captureFor(r);
assert.deepStrictEqual(osc, { side: 'unknown', facingDeg: 91, flowDeg: 271, source: 'openspeedcam', verified: false });
// ГИБДД: direction lives in the operating-conditions text.
assert.strictEqual(capture.gibddSide('Круглосуточно Встречное/ попутное'), 'both');
assert.strictEqual(capture.gibddSide('при движении в попутном направлении'), 'rear');
assert.strictEqual(capture.gibddSide('08.00-17.00 при движении во встречном направлении'), 'front');
assert.strictEqual(capture.gibddSide('Круглосуточно'), 'unknown');
r = { id: 'gibdd:ru-klu:0202c46650afa9dd', type: 'speed', controls: ['speed'], position: { lat: 54, lon: 36 },
    provenance: 'Госавтоинспекция', operatingConditions: 'Круглосуточно Встречное/ попутное' };
assert.deepStrictEqual(capture.captureFor(r), { side: 'both', facingDeg: null, flowDeg: null, source: 'gibdd-text', verified: true });
// Owner reports: optional explicit direction.
r = { id: 'reported:test:dir', type: 'camera', controls: [], position: { lat: 54, lon: 36 }, provenance: 'owner-report', captureSide: 'front' };
assert.deepStrictEqual(capture.captureFor(r), { side: 'front', facingDeg: null, flowDeg: null, source: 'owner', verified: true });
r = Object.assign({}, r, { captureSide: undefined, facingDeg: 270 });
assert.strictEqual(capture.captureFor(r).facingDeg, 270);
assert.strictEqual(capture.captureFor({ id: 'reported:test:none', type: 'camera', controls: [], position: { lat: 54, lon: 36 }, provenance: 'owner-report' }), null);

// --- driver-relative classifier ------------------------------------------
assert.strictEqual(capture.classify({ side: 'unknown', facingDeg: 270, flowDeg: null, source: 'osm-direction', verified: true }, 90), 'front', 'facing against the course is «в лицо»');
assert.strictEqual(capture.classify({ side: 'unknown', facingDeg: 90, flowDeg: null, source: 'osm-direction', verified: true }, 90), 'rear', 'facing along the course shoots the rear plate');
assert.strictEqual(capture.classify({ side: 'unknown', facingDeg: 0, flowDeg: null, source: 'osm-direction', verified: true }, 90), 'cross', 'a perpendicular camera does not watch our stream');
assert.strictEqual(capture.classify({ side: 'both', facingDeg: null, flowDeg: null, source: 'gibdd-text', verified: true }, 90), 'both');
assert.strictEqual(capture.classify(null, 90), 'unknown', 'no data → honest unknown');
assert.strictEqual(capture.classify({ side: 'unknown', facingDeg: null, flowDeg: 90, source: 'osm-relation', verified: false }, 90), 'front', 'monitored flow along the course photographs head-on');
assert.strictEqual(capture.classify({ side: 'unknown', facingDeg: null, flowDeg: 270, source: 'openspeedcam', verified: false }, 90), 'rear', 'driving with the monitored stream behind means a rear capture');

// --- describe carries capture ---------------------------------------------
const described = info.describe({ id: 'osm:node:10701120297', type: 'speed', controls: ['speed'], position: { lat: 54, lon: 36 },
    sourceUrl: 'https://www.openstreetmap.org/node/10701120297', rawDirection: 'E' });
assert.strictEqual(described.capture.facingDeg, 90);
assert.strictEqual(described.capture.source, 'osm-direction');

// --- rebuilt coverage on the shipped bundle --------------------------------
const bundle = require('./build-camera-database').bundle();
assert.strictEqual(bundle.version, '2026.11.19.1', 'the rebuilt database carries the new version');
const cov = require(path.join(base, 'database-coverage')).summarize(bundle.records, bundle.zones);
assert.strictEqual(cov.sourceRecords, 14200);
assert(cov.facingKnown > 100, 'facingKnown grew far beyond the old OSM-only 20: ' + cov.facingKnown);
assert(cov.captureSideKnown >= 150, 'captureSideKnown grew beyond the old 0: ' + cov.captureSideKnown);
const oscRecord = bundle.records.find(x => x.id === 'osc:619c87ee2aff727eb541eb5b');
const oscCapture = info.describe(oscRecord).capture;
assert(oscCapture && oscCapture.flowDeg === 271, 'the photographed OSC point now carries its direction');
// Guidance consumes it: the «в лицо» / «в спину» / cross gating is covered by
// test_nearby_mode.js; here we only pin the data contract.
console.log('PASS camera direction: OSM direction/relation, OpenSpeedcam flow, ГИБДД text, owner reports, driver-relative classifier, describe/coverage integration; facingKnown ' + cov.facingKnown + ' (was 20), captureSideKnown ' + cov.captureSideKnown + ' (was 0)');
