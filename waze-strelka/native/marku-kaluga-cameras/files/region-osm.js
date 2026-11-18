'use strict';
// 0.9.0: merge additional regional OSM camera snapshots into the working
// database. The home Kaluga snapshot (kaluga-speed.json) stays the base its
// road zones are pinned to; a regional snapshot adds its own records with
// region attribution. Merging is idempotent: already-present ids are kept
// from the base and counted.
function fail(code, message) { var e = new Error(message || code); e.code = code; throw e; }
function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
var REGIONS = ['RU-MOW'];
var BOUNDS = { latMin: 53, latMax: 57.3, lonMin: 33, lonMax: 40.6 };

function load(file, fs) {
    var fsImpl = fs || require('fs');
    var snapshot;
    try { snapshot = JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
    catch (e) { fail('REGION_READ', 'Cannot read regional snapshot: ' + e.message); }
    if (!object(snapshot) || snapshot.schemaVersion !== 1 || snapshot.source !== 'OpenStreetMap' ||
        REGIONS.indexOf(snapshot.region) < 0 || !/^[a-f0-9]{32}$/.test(snapshot.pbfMd5 || '') ||
        typeof snapshot.providerUrl !== 'string' || !Array.isArray(snapshot.records) ||
        !snapshot.records.length || snapshot.records.length > 20000) fail('REGION_SCHEMA');
    var ids = Object.create(null);
    snapshot.records.forEach(function (r) {
        if (!object(r) || !/^osm:node:[0-9]+$/.test(r.id || '') || ids[r.id]) fail('REGION_ID');
        ids[r.id] = true;
        if (!object(r.position) || !Number.isFinite(r.position.lat) || !Number.isFinite(r.position.lon) ||
            r.position.lat < BOUNDS.latMin || r.position.lat > BOUNDS.latMax ||
            r.position.lon < BOUNDS.lonMin || r.position.lon > BOUNDS.lonMax) fail('REGION_POSITION');
        if (['speed', 'redlight', 'average', 'camera'].indexOf(r.type) < 0) fail('REGION_TYPE');
        if (!Array.isArray(r.controls) || !r.controls.length) fail('REGION_CONTROLS');
        if (snapshot.region === 'RU-MOW' && typeof r.inMoscowCity !== 'boolean') fail('REGION_FLAG');
    });
    return snapshot;
}

function merge(database, snapshot) {
    if (!object(database) || database.region !== 'RU-KLU' || !Array.isArray(database.records)) fail('REGION_DATABASE');
    if (!object(snapshot)) return database;
    var existing = Object.create(null), added = 0, skipped = 0;
    database.records.forEach(function (r) { existing[r.id] = true; });
    var records = database.records.slice();
    snapshot.records.forEach(function (r) {
        if (existing[r.id]) { skipped++; return; }
        existing[r.id] = true;
        records.push(JSON.parse(JSON.stringify(r)));
        added++;
    });
    var regions = Array.isArray(database.regions) ? database.regions.slice() : ['RU-KLU'];
    if (regions.indexOf(snapshot.region) < 0) regions.push(snapshot.region);
    var result = Object.assign({}, database, { records: records, regions: regions });
    // The speed-limit evidence ledger counts every bundle record; keep its
    // totals honest for the merged regional records (same rule the OSC layer
    // uses: a numeric source limit is existingNumeric, everything else unresolved).
    if (object(database.speedLimitMetadata) && object(database.speedLimitMetadata.counts)) {
        var counts = database.speedLimitMetadata.counts;
        if (Number.isInteger(counts.unresolved) && Number.isInteger(counts.existingNumeric)) {
            var addedRecords = records.slice(database.records.length);
            counts.unresolved += addedRecords.filter(function (r) { return r.limitKmh == null; }).length;
            counts.existingNumeric += addedRecords.filter(function (r) { return r.limitKmh != null; }).length;
        }
    }
    result.regionalSources = (database.regionalSources || []).concat([{
        region: snapshot.region, sourceTimestamp: snapshot.sourceTimestamp || null,
        providerUrl: snapshot.providerUrl, pbfMd5: snapshot.pbfMd5,
        records: added, alreadyPresent: skipped }]);
    return result;
}

module.exports = { load: load, merge: merge, REGIONS: REGIONS };
