'use strict';
// Exercises the actual captured OpenSpeedcam snapshot separately from application IDs.
var assert = require('assert'), path = require('path');
var api = require('../native/marku-kaluga-cameras/files/openspeedcam-data');
var store = require('../native/marku-kaluga-cameras/files/database-store');
var snapshot = require('../data/../native/marku-kaluga-cameras/files/openspeedcam-kaluga.json');
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function base() {
  return { region: 'RU-KLU', source: 'OpenStreetMap', osmCount: 1, reportedCount: 0,
    records: [{ id: 'osm:node:1', type: 'speed', controls: ['speed'], position: { lat: 54.5, lon: 36.2 }, limitKmh: 60 }] };
}
function throwsSnap(change, code) {
  var s = clone(snapshot); change(s);
  assert.throws(function () { api.validateSnapshot(s); }, function (e) { return e.code === code; }, code);
}
// The real captured snapshot normalizes deterministically and stays read-only.
var sourceBytes = JSON.stringify(snapshot), databaseBytes = JSON.stringify(base());
var result = api.augment(base(), snapshot);
var snapProvider = result.sourceMetadata.providers.find(function (p) { return p.id === 'openspeedcam-community'; });
assert.strictEqual(result.openSpeedcamCount + snapProvider.nearExistingRecord + snapProvider.nearCommunityPoint, snapshot.records.length);
assert.strictEqual(JSON.stringify(snapshot), sourceBytes);
assert(result.openSpeedcamCount > 100, 'fixture snapshot carries a real community layer');
assert.strictEqual(result.records.length, 1 + result.openSpeedcamCount);
result.records.slice(1).forEach(function (r) {
  assert(/^osc:[a-f0-9]{24}$/.test(r.id));
  assert.strictEqual(r.provenance, 'OpenSpeedcam');
  assert.strictEqual(r.positionKind, 'community-point');
  assert(/^https:\/\/openspeedcam\.net\/\?point=[a-f0-9]{24}$/.test(r.sourceUrl));
  if (r.limitKmh != null) assert(r.controls.indexOf('speed') >= 0, 'numeric limit only with speed control');
});
// Kind mapping and flag-derived controls.
function point(id, kind, extra) {
  return Object.assign({ id: 'osc:' + id, kind: kind, subType: null, position: { lat: 55.0, lon: 37.0 },
    limitKmh: 60, dirType: 1, directionDeg: 90, zoneDistanceM: 300, angleDeg: 20,
    flags: { bSpeed: false, stopLine: false, stopCrossroad: false, rows: false, markings: false, pedestrians: false, overtaking: false, inBack: false },
    comment: null, rating: 1, created: '2026-01-01T00:00:00.000Z', sourceIndex: 1 }, extra || {});
}
var red = point('a'.repeat(24), 'control_cam_red', { flags: { bSpeed: true, stopLine: true, stopCrossroad: false, rows: true, markings: false, pedestrians: true, overtaking: false, inBack: false } });
assert.deepStrictEqual(api.controlsFor(red), ['redlight', 'stopline', 'speed', 'lane', 'pedestrian']);
assert.deepStrictEqual(api.controlsFor(point('b'.repeat(24), 'static_cam', { subType: 'chord' })), ['speed', 'average']);
assert.deepStrictEqual(api.controlsFor(point('c'.repeat(24), 'dummy')), []);
assert.deepStrictEqual(api.controlsFor(point('d'.repeat(24), 'stationary_porst_dps')), []);
assert.deepStrictEqual(api.controlsFor(point('e'.repeat(24), 'video_control', { flags: { bSpeed: false, stopLine: false, stopCrossroad: false, rows: false, markings: true, pedestrians: false, overtaking: true, inBack: false } })), ['signs_marking', 'road_position']);
// Dedupe: a community point near an existing record never duplicates it.
var mini = clone(snapshot);
mini.records = [point('f'.repeat(24), 'static_cam', { position: { lat: 54.5001, lon: 36.2 } }),
  point('0'.repeat(24), 'static_cam', { position: { lat: 55.5, lon: 37.5 } }),
  point('1'.repeat(24), 'static_cam', { position: { lat: 55.50005, lon: 37.5 } })];
mini.counts = { fetched: 3, imported: 3, excluded: 0 }; mini.excluded = [];
var merged = api.augment(base(), mini), provider = merged.sourceMetadata.providers.find(function (p) { return p.id === 'openspeedcam-community'; });
assert.strictEqual(merged.openSpeedcamCount, 1);
assert.strictEqual(provider.nearExistingRecord, 1, 'near an existing record the community point is skipped');
assert.strictEqual(provider.nearCommunityPoint, 1, 'a near-duplicate community point is skipped');
assert.strictEqual(merged.records.length, 2);
// Speed-limit ledger totals stay honest for the appended layer.
var ledger = clone(base());
ledger.speedLimitMetadata = { counts: { existingNumeric: 1, cameraTag: 0, enforcementRelation: 0, sharedRoadNode: 0, addressRoad: 0, unresolved: 0 } };
var withLedger = api.augment(ledger, mini);
assert.strictEqual(withLedger.speedLimitMetadata.counts.existingNumeric, 2);
// Runtime validator accepts the community claim shape and rejects impostors.
function bundleWith(record) {
  return { schema: 1, region: 'RU-KLU', version: '2026.11.12.1', generatedAt: '2026-11-12T12:00:00.000Z', sourceTimestamp: '2026-11-05T00:06:20.000Z',
    source: 'test', records: [record], zones: [] };
}
var good = merged.records[1];
store.validateBundle(bundleWith(good));
[function (r) { r.provenance = 'OpenStreetMap'; },
 function (r) { r.positionKind = 'official-location'; },
 function (r) { r.sourceUrl = 'https://openspeedcam.net/point/' + r.id.slice(4); },
 function (r) { r.sourceUrl = 'https://attacker.example/?point=' + r.id.slice(4); },
 function (r) { r.id = 'osc:' + 'g'.repeat(24); }].forEach(function (change) {
  var bad = clone(good); change(bad);
  assert.throws(function () { store.validateBundle(bundleWith(bad)); }, /DATA_/, 'rejected: ' + change.toString());
});
var renamed = clone(good); renamed.id = 'osm:node:2'; renamed.sourceUrl = 'https://www.openstreetmap.org/node/2';
assert.throws(function () { store.validateBundle(bundleWith(renamed)); }, /DATA_COMMUNITY_CLAIM/, 'OpenSpeedcam provenance needs an osc id');
// Snapshot validation rejects tampering.
throwsSnap(function (s) { s.kind = 'osm-camera-source'; }, 'OSC_SCHEMA');
throwsSnap(function (s) { s.records.push(clone(s.records[0])); s.counts.imported = s.records.length; }, 'OSC_ID');
throwsSnap(function (s) { s.records[0].id = 'gibdd:ru-klu:' + 'a'.repeat(16); }, 'OSC_ID');
throwsSnap(function (s) { s.records[0].position.lat = 60; }, 'OSC_RECORD');
throwsSnap(function (s) { s.records[0].limitKmh = 500; }, 'OSC_LIMIT');
throwsSnap(function (s) { s.counts.imported++; }, 'OSC_AUDIT');
assert.throws(function () { api.augment(result, snapshot); }, function (e) { return e.code === 'OSC_DUPLICATE_PROVIDER' || e.code === 'OSC_DUPLICATE_SOURCE'; });
console.log('test_openspeedcam_data ok');
