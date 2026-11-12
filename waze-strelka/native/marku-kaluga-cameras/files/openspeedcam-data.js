'use strict';
// Append a separately attributed OpenSpeedcam community layer. Community
// points are never spatially merged into OSM/official records and never
// overwrite their facts; a point near an existing record is skipped and
// counted in the audit. Mobile and hazard kinds are absent by import policy.
var CONTROLS = ['speed', 'redlight', 'average', 'stopline', 'belt', 'phone', 'lane', 'pedestrian', 'signs_marking', 'road_position'];
var KINDS = ['static_cam', 'speed_cam', 'control_cam_red', 'video_control', 'dummy', 'stationary_porst_dps'];
function fail(code, message) { var e = new Error(message || code); e.code = code; throw e; }
function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v, max) { return typeof v === 'string' && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v); }
function date(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) && isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19); }
function pointUrl(id) { return 'https://openspeedcam.net/?point=' + id.slice(4); }
function oscSource(v) { return typeof v === 'string' && /^https:\/\/openspeedcam\.net\/\?point=[a-f0-9]{24}$/.test(v); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function inspect(v, depth, budget) {
  if (++budget.count > 350000 || depth > 24) fail('OSC_COMPLEXITY');
  if (typeof v === 'string' && !text(v, 8192)) fail('OSC_TEXT');
  if (typeof v === 'number' && !isFinite(v)) fail('OSC_NUMBER');
  if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { if (['__proto__', 'prototype', 'constructor'].indexOf(k) >= 0) fail('OSC_KEY'); inspect(v[k], depth + 1, budget); });
}
function validateSnapshot(snapshot) {
  if (!object(snapshot)) fail('OSC_SCHEMA');
  inspect(snapshot, 0, { count: 0 });
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 8 * 1024 * 1024) fail('OSC_SIZE');
  if (snapshot.schema !== 1 || snapshot.kind !== 'openspeedcam-snapshot' || snapshot.source !== 'OpenSpeedcam' ||
      snapshot.region !== 'RU-KLU' || snapshot.sourceUrl !== 'https://openspeedcam.net/' || !date(snapshot.retrievedAt) ||
      !/^[a-f0-9]{64}$/.test(snapshot.rawSha256 || '') || !Number.isInteger(snapshot.rawBytes) ||
      !Array.isArray(snapshot.records) || snapshot.records.length > 20000 || !Array.isArray(snapshot.excluded)) fail('OSC_SCHEMA');
  if (!object(snapshot.counts) || snapshot.counts.imported !== snapshot.records.length ||
      snapshot.counts.excluded !== snapshot.excluded.length) fail('OSC_AUDIT');
  var ids = Object.create(null);
  snapshot.records.forEach(function (r) {
    if (!object(r) || !/^osc:[a-f0-9]{24}$/.test(r.id || '') || ids[r.id]) fail('OSC_ID'); ids[r.id] = true;
    if (KINDS.indexOf(r.kind) < 0 || !object(r.position) || !Number.isFinite(r.position.lat) || !Number.isFinite(r.position.lon) ||
        r.position.lat < 53 || r.position.lat > 56 || r.position.lon < 33 || r.position.lon > 38) fail('OSC_RECORD');
    if (r.limitKmh !== null && (!Number.isInteger(r.limitKmh) || r.limitKmh < 5 || r.limitKmh > 180)) fail('OSC_LIMIT');
    if (r.dirType !== null && [0, 1, 2].indexOf(r.dirType) < 0) fail('OSC_DIRECTION');
    if (r.comment !== null && !text(r.comment, 250)) fail('OSC_TEXT');
    if (!object(r.flags)) fail('OSC_FLAGS');
  });
  return clone(snapshot);
}
function controlsFor(r) {
  var controls = [];
  function add(c) { if (CONTROLS.indexOf(c) >= 0 && controls.indexOf(c) < 0) controls.push(c); }
  if (r.kind === 'static_cam' || r.kind === 'speed_cam') add('speed');
  if (r.kind === 'control_cam_red') {
    add('redlight');
    if (r.flags.stopLine || r.flags.stopCrossroad) add('stopline');
    if (r.flags.bSpeed) add('speed');
  }
  if ((r.kind === 'static_cam' || r.kind === 'speed_cam') && (r.subType === 'chord' || r.subType === 'autodoria')) add('average');
  if (r.flags.rows) add('lane');
  if (r.flags.pedestrians) add('pedestrian');
  if (r.flags.markings) add('signs_marking');
  if (r.flags.overtaking) add('road_position');
  return controls;
}
function toRecord(r) {
  var controls = controlsFor(r);
  var type = controls.indexOf('redlight') >= 0 ? 'redlight' : controls.indexOf('speed') >= 0 ? 'speed' : 'camera';
  var description = r.comment;
  if (r.kind === 'dummy') description = (description ? description + '. ' : '') + 'Муляж камеры';
  if (r.kind === 'stationary_porst_dps') description = (description ? description + '. ' : '') + 'Стационарный пост ДПС';
  return { id: r.id, type: type, controls: controls, position: clone(r.position),
    limitKmh: controls.indexOf('speed') >= 0 ? r.limitKmh : null,
    directionKnown: r.dirType === 1 && r.directionDeg !== null,
    rawDirection: r.dirType === 1 && r.directionDeg !== null ? String(r.directionDeg) : null,
    description: description, provenance: 'OpenSpeedcam', positionKind: 'community-point',
    sourceUrl: pointUrl(r.id), positionSourceUrl: pointUrl(r.id),
    sourceCreatedAt: r.created, sourceRating: r.rating, sourceKind: r.kind,
    hardwareModel: null, captureSide: 'unknown', bearingDeg: null };
}
function distanceM(a, b) {
  var x = (b.lon - a.lon) * 111320 * Math.cos((a.lat + b.lat) * Math.PI / 360), y = (b.lat - a.lat) * 111320;
  return Math.sqrt(x * x + y * y);
}
function augment(database, snapshotData) {
  if (!object(database) || database.region !== 'RU-KLU' || !Array.isArray(database.records) || database.records.length > 20000) fail('OSC_DATABASE');
  var snapshot = validateSnapshot(snapshotData), result = clone(database), ids = Object.create(null);
  result.records.forEach(function (r) { if (!r || !text(r.id, 128) || ids[r.id]) fail('OSC_DATABASE_ID'); ids[r.id] = true; });
  var basePositions = result.records.map(function (r) { return r.position; }), addedPositions = [];
  var accepted = 0, audit = { nearExistingRecord: [], nearCommunityPoint: [] };
  snapshot.records.forEach(function (r) {
    if (ids[r.id]) fail('OSC_DUPLICATE_SOURCE');
    if (basePositions.some(function (p) { return distanceM(p, r.position) <= 60; })) { audit.nearExistingRecord.push(r.id); ids[r.id] = true; return; }
    if (addedPositions.some(function (p) { return distanceM(p, r.position) <= 15; })) { audit.nearCommunityPoint.push(r.id); ids[r.id] = true; return; }
    ids[r.id] = true;
    var record = toRecord(r);
    result.records.push(record); addedPositions.push(record.position); accepted++;
  });
  if (result.records.length > 20000) fail('OSC_DATABASE_SIZE');
  // The speed-limit evidence ledger counts every bundle record; keep its
  // totals honest for the appended community layer (no OSM limit evidence).
  if (object(result.speedLimitMetadata) && object(result.speedLimitMetadata.counts)) {
    var counts = result.speedLimitMetadata.counts;
    if (Number.isInteger(counts.unresolved) && Number.isInteger(counts.existingNumeric)) {
      result.records.slice(result.records.length - accepted).forEach(function (r) {
        if (r.limitKmh != null) counts.existingNumeric++; else counts.unresolved++;
      });
    }
  }
  result.openSpeedcamCount = accepted;
  result.sourceMetadata = object(result.sourceMetadata) ? result.sourceMetadata : {};
  var providers = result.sourceMetadata.providers;
  if (providers !== undefined && !Array.isArray(providers)) fail('OSC_PROVIDER_METADATA');
  providers = providers || [];
  if (providers.some(function (p) { return !object(p) || p.id === 'openspeedcam-community'; })) fail('OSC_DUPLICATE_PROVIDER');
  var exclusionCounts = {};
  snapshot.excluded.forEach(function (e) { var key = e.reason + ':' + e.kind; exclusionCounts[key] = (exclusionCounts[key] || 0) + 1; });
  providers.push({ id: 'openspeedcam-community', title: 'OpenSpeedcam — пользовательская база точек', sourceUrl: snapshot.sourceUrl,
    retrievedAt: snapshot.retrievedAt, rawSha256: snapshot.rawSha256, reuse: clone(snapshot.reuse),
    fetchedPoints: snapshot.counts.fetched, acceptedPositionRecords: accepted, excludedPoints: snapshot.excluded.length,
    exclusionCounts: exclusionCounts,
    nearExistingRecord: audit.nearExistingRecord.length, nearCommunityPoint: audit.nearCommunityPoint.length,
    countUnit: 'community point positions; not a deduplicated count of physical devices' });
  result.sourceMetadata.providers = providers;
  result.sourceMetadata.countUnit = 'source-position-records';
  result.sourceMetadata.physicalDeviceCount = null;
  result.licence = (result.licence ? result.licence + '; ' : '') + 'OpenSpeedcam: открытая пользовательская база, атрибуция openspeedcam.net';
  result.source = result.displaySource = (database.displaySource || database.source) + ' + OpenSpeedcam';
  return result;
}
module.exports = { augment: augment, validateSnapshot: validateSnapshot, controlsFor: controlsFor };
