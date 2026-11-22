'use strict';
// The national ODbL point map is separate from the curated local data and its
// approach geometry. Values from this source describe camera tags.
var fs = require('fs'), path = require('path'), crypto = require('crypto');
var URL = require('url').URL;
var disk = require('./database-store');
var download = require('./database-download'), orientation = require('./camera-orientation');

var BASE = 'https://raw.githubusercontent.com/istt1899/x3/';
var DATAPATH = 'waze-strelka/data/russia/';
var MANIFEST = BASE + 'main/' + DATAPATH + 'manifest-regions-v2.json';
var LICENSE = 'https://opendatacommons.org/licenses/odbl/1-0/';
var ATTRIBUTION = '© OpenStreetMap contributors';
var MAX_SIZE = 4 * 1024 * 1024, MAX_MANIFEST = 128 * 1024, MAX_COUNT = 40000;
var UNASSIGNED = 'RU-UNASSIGNED';
var TYPES = ['speed', 'redlight', 'average', 'camera', 'mobile'];

function fail(code) { throw Object.assign(new Error(code), { code: code }); }
function obj(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function number(value, max) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function optionalTag(value) {
  return value === null || typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}
function cameraId(number) { return 'osm:node:' + number; }
function cameraUrl(number) { return 'https://www.openstreetmap.org/node/' + number; }
function mappedFacing(row) {
  return orientation.describe({ id: cameraId(row[0]), sourceUrl: cameraUrl(row[0]), rawDirection: row[5] }).state === 'mapped';
}
function snapshotUrl(utc) { return 'https://planet.openstreetmap.org/pbf/planet-' + utc.slice(2, 10).replace(/-/g, '') + '.osm.pbf'; }
function passport(value) {
  if (!obj(value) || !(value.region === UNASSIGNED || /^RU-[A-Z]{2,3}$/.test(value.region || '')) ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 || /[\x00-\x1f\x7f]/.test(value.name) ||
      !/^\d{1,4}\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(value.version || '') ||
      !timestamp(value.sourceTimestamp) || !number(value.count, MAX_COUNT) || !number(value.withCameraLimit, value.count) ||
      value.sourceSnapshot !== snapshotUrl(value.sourceTimestamp) || value.license !== LICENSE || value.attribution !== ATTRIBUTION ||
      !number(value.withDirection, value.count) || !number(value.withConditionalTag, value.count) ||
      value.withApproachLimit !== 0 || value.withApproachDirection !== 0 || value.conflictCount !== null) fail('REGION_PASSPORT');
  return value;
}
function validatePackage(value, expected) {
  passport(value);
  if (value.schema !== 1 || !Array.isArray(value.records) || value.records.length !== value.count) fail('REGION_PACKAGE');
  if (expected && ['region', 'name', 'version', 'sourceTimestamp', 'count', 'withCameraLimit', 'withDirection', 'withConditionalTag'].some(function (key) {
    return expected[key] !== value[key];
  })) fail('REGION_PACKAGE_MISMATCH');
  var lastId = 0, limits = 0, facing = 0, conditional = 0;
  value.records.forEach(function (row) {
    if (!Array.isArray(row) || row.length !== 8 || !Number.isSafeInteger(row[0]) || row[0] <= lastId ||
        !Number.isFinite(row[1]) || row[1] < 40 || row[1] > 83 || !Number.isFinite(row[2]) ||
        !(row[2] >= 18 && row[2] <= 180 || row[2] >= -180 && row[2] <= -165) || TYPES.indexOf(row[3]) < 0 ||
        !(row[4] === null || number(row[4], 180) && row[4] >= 5) || !row.slice(5).every(optionalTag)) fail('REGION_RECORD');
    lastId = row[0];
    if (row[4] !== null) limits++;
    if (row[5] && mappedFacing(row)) facing++;
    if (row[6]) conditional++;
  });
  if (limits !== value.withCameraLimit || facing !== value.withDirection || conditional !== value.withConditionalTag) fail('REGION_EVIDENCE_COUNTS');
  return value;
}
function metadata(value) {
  if (!obj(value) || value.schema !== 2 || value.country !== 'RU' || value.license !== LICENSE || value.attribution !== ATTRIBUTION ||
      value.source !== 'https://qlever.dev/api/osm-planet' || value.sourceMethod !== value.source + '?cmd=stats' ||
      value.boundaries !== 'https://www.geoboundaries.org/api/current/gbOpen/RUS/' ||
      !timestamp(value.generatedAt) || !timestamp(value.sourceTimestamp) || value.generatedAt < value.sourceTimestamp ||
      value.sourceSnapshot !== snapshotUrl(value.sourceTimestamp) || !/^[a-f0-9]{64}$/.test(value.countryBoundarySha256 || '') ||
      !/^[a-f0-9]{64}$/.test(value.sourceSha256 || '') || !/^[a-f0-9]{64}$/.test(value.boundariesSha256 || '') ||
      !Array.isArray(value.regions) || value.regions.length > 90) fail('REGION_METADATA');
  return value;
}
function allowManifest(value) { if (value !== MANIFEST) fail('REGION_MANIFEST_URL'); }
function artifactUrl(entry, url) {
  var parsed;
  try { parsed = new URL(url); } catch (e) { fail('REGION_ARTIFACT_URL'); }
  var segments = parsed.pathname.split('/');
  var expected = BASE + segments[3] + '/' + DATAPATH + 'camera-region-' + entry.region + '-' + entry.version + '.json';
  if (!/^[a-f0-9]{40}$/.test(segments[3] || '') || url !== expected) fail('REGION_ARTIFACT_URL');
}
function validateManifest(value, known) {
  metadata(value);
  var ids = Object.create(null);
  value.regions.forEach(function (entry) {
    passport(entry);
    if (!entry.count || ids[entry.region] || entry.region === UNASSIGNED || !known[entry.region] ||
        entry.sourceTimestamp !== value.sourceTimestamp || !obj(entry.artifact) || !number(entry.artifact.size, MAX_SIZE) ||
        entry.artifact.size < 2 || !/^[a-f0-9]{64}$/.test(entry.artifact.sha256 || '')) fail('REGION_MANIFEST');
    artifactUrl(entry, entry.artifact.url);
    ids[entry.region] = true;
  });
  return value;
}
function read(file, max) {
  var stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > max) fail('REGION_STORAGE');
  return disk.parse(fs.readFileSync(file), max);
}
function load(file) {
  var value = metadata(read(file, MAX_SIZE)), ids = Object.create(null), regions = Object.create(null), count = 0;
  if (!value.regions.length) fail('REGION_EMPTY');
  value.regions.forEach(function (pack) {
    validatePackage(pack);
    if (regions[pack.region] || value.sourceTimestamp !== pack.sourceTimestamp) fail('REGION_DUPLICATE');
    regions[pack.region] = pack;
    pack.records.forEach(function (r) {
      if (ids[r[0]] || ++count > MAX_COUNT) fail('REGION_DUPLICATE');
      ids[r[0]] = true;
    });
  });
  if (!count) fail('REGION_EMPTY');
  return { metadata: value, regions: regions };
}
function compare(a, b) {
  var av = a.split('.').map(Number), bv = b.split('.').map(Number);
  for (var n = 0; n < 4; n++) {
    var d = (av[n] || 0) - (bv[n] || 0);
    if (d) return d;
  }
  return 0;
}
function merge(bundle, packs) {
  var records = bundle.records.slice(), used = Object.create(null), sourceRecords = 0;
  records.forEach(function (record) { used[record.id] = true; });
  packs.slice().sort(function (a, b) { return compare(b.version, a.version); }).forEach(function (pack) {
    sourceRecords += pack.count;
    pack.records.forEach(function (r) {
      var id = cameraId(r[0]);
      if (used[id]) return;
      used[id] = true;
      var control = r[3] === 'mobile' ? 'camera' : r[3];
      records.push({ id: id, position: { lat: r[1], lon: r[2] }, type: control,
        controls: control === 'camera' ? [] : [control], mappedCameraKind: r[3], providerId: 'osm-russia',
        sourceUrl: cameraUrl(r[0]), sourcePublishedAt: pack.sourceTimestamp, rawDirection: r[5], rawEnforcement: r[7],
        cameraLimitConditional: r[6],
        dataRegion: pack.region, provenance: 'OpenStreetMap', limitKmh: r[4] });
    });
  });
  var regions = (bundle.regions || [bundle.region]).slice();
  packs.forEach(function (pack) {
    if (pack.count && pack.region !== UNASSIGNED && regions.indexOf(pack.region) < 0) regions.push(pack.region);
  });
  return Object.assign({}, bundle, { records: records, regions: regions,
    nationalOsm: { sourceRecords: sourceRecords, additionalRecords: records.length - bundle.records.length } });
}

function createRegionalStore(options) {
  var base = load(options.snapshot), downloaded = Object.create(null), available = Object.create(null);
  var dir = path.join(options.dataDir, 'regional-cameras'), requests = [], busy = null, closed = false, selectedRegion = null;
  var phase = 'idle', errorCode = null;
  function safeStorage(create) {
    if (create) {
      try { fs.mkdirSync(dir, 448); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    try { if (!fs.lstatSync(dir).isDirectory()) fail('REGION_STORAGE'); }
    catch (e) { if (create || e.code !== 'ENOENT') throw e; }
  }
  var storageReadable = true;
  try { safeStorage(false); }
  catch (e) { storageReadable = false; errorCode = 'REGION_STORAGE'; }
  function envelopePackage(value, sha256, region) {
    if (!value) return null;
    var baseline = base.regions[region];
    validatePackage(value);
    if (value.region !== region || value.sourceTimestamp < baseline.sourceTimestamp || digest(value) !== sha256 ||
        (value.version === baseline.version ? digest(value) !== digest(baseline) : compare(value.version, baseline.version) < 0)) fail('REGION_STORAGE');
    return value;
  }
  function file(region) { return path.join(dir, 'region-' + region + '.json'); }
  function current(region) { return downloaded[region] ? downloaded[region].active : base.regions[region]; }
  function currentPacks() { return Object.keys(base.regions).map(current); }
  if (storageReadable) Object.keys(base.regions).forEach(function (region) {
    try {
      var version = read(file(region), 2 * MAX_SIZE);
      if (!obj(version) || version.schema !== 1 || version.region !== region) fail('REGION_STORAGE');
      var previous = null;
      try { previous = envelopePackage(version.previous, version.previousSha256, region); }
      catch (e) { errorCode = 'REGION_LOCAL_RECOVERED'; }
      try {
        if (!envelopePackage(version.active, version.activeSha256, region)) fail('REGION_STORAGE');
        downloaded[region] = version;
        if (!previous) {
          downloaded[region].previous = null;
          downloaded[region].previousSha256 = null;
        }
      } catch (e) {
        errorCode = 'REGION_LOCAL_RECOVERED';
        if (previous) downloaded[region] = makeEnvelope(region, previous, null);
      }
    } catch (e) { if (e.code !== 'ENOENT') errorCode = 'REGION_LOCAL_RECOVERED'; }
  });
  function status() {
    return {
      phase: phase, errorCode: errorCode, selectedRegion: selectedRegion,
      source: base.metadata.source, sourceMethod: base.metadata.sourceMethod, attribution: ATTRIBUTION,
      license: LICENSE, sourceTimestamp: base.metadata.sourceTimestamp, completeCoverage: false,
      regions: Object.keys(base.regions).map(function (id) {
        var p = current(id), incoming = available[id];
        var newer = incoming && incoming.sourceTimestamp >= p.sourceTimestamp && compare(incoming.version, p.version) > 0;
        return { region: id, name: p.name, count: p.count, withCameraLimit: p.withCameraLimit, withDirection: p.withDirection,
          withApproachLimit: p.withApproachLimit, withApproachDirection: p.withApproachDirection,
          withConditionalTag: p.withConditionalTag, conflictCount: p.conflictCount,
          sourceTimestamp: p.sourceTimestamp, currentVersion: p.version, availableVersion: incoming ? incoming.version : null,
          canRollback: !!(downloaded[id] && downloaded[id].previous),
          status: newer ? 'available' : p.count === 0 ? 'no-records' : downloaded[id] ? 'installed' : 'bundled' };
      })
    };
  }
  function emit(next, error) {
    phase = next; errorCode = error || null;
    if (!closed && options.onStatus) options.onStatus(status());
  }
  function ensureOpen() { if (closed) fail('REGION_CLOSED'); }
  function refresh() {
    return (options.fetchManifest || function () { return disk.fetchBounded(MANIFEST, MAX_MANIFEST, requests, 0, allowManifest); })()
      .then(function (buffer) {
        ensureOpen();
        var manifest = validateManifest(disk.parse(buffer, MAX_MANIFEST), base.regions), next = Object.create(null);
        manifest.regions.forEach(function (entry) { next[entry.region] = entry; });
        available = next;
      });
  }
  function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  function makeEnvelope(region, active, previous) {
    return { schema: 1, region: region, active: active, previous: previous,
      activeSha256: digest(active), previousSha256: previous ? digest(previous) : null };
  }
  function transact(region, next, previous) {
    ensureOpen();
    var before = downloaded[region], envelope = makeEnvelope(region, next, previous);
    var target = file(region), old = before ? Buffer.from(JSON.stringify(before)) : null;
    try {
      disk.writeAtomic(target, Buffer.from(JSON.stringify(envelope)));
      ensureOpen();
      downloaded[region] = envelope;
      if (options.onChange) options.onChange(currentPacks());
    } catch (e) {
      if (before) downloaded[region] = before;
      else delete downloaded[region];
      // An fsync failure can happen after rename. Keep disk and memory aligned
      // with the old validated package even on a consumer/validation failure.
      try {
        if (old) disk.writeAtomic(target, old);
        else if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch (restoreError) { fail('REGION_RESTORE_FAILED'); }
      throw e;
    }
  }
  function install(region) {
    var incoming = available[region], active = current(region);
    if (!incoming) fail('REGION_NOT_PUBLISHED');
    if (incoming.sourceTimestamp < active.sourceTimestamp || compare(incoming.version, active.version) < 0) fail('REGION_DOWNGRADE');
    if (incoming.version === active.version) return 'current';
    safeStorage(true);
    emit('downloading');
    var transport = options.download || download;
    return transport(incoming.artifact, {
      dir: dir, requests: requests, timeout: 15000, ensureOpen: ensureOpen, allow: artifactUrl.bind(null, incoming)
    }).then(function (bytes) {
      var pack = validatePackage(disk.parse(bytes, MAX_SIZE), incoming);
      if (options.beforeInstall) options.beforeInstall();
      emit('installing');
      transact(region, pack, active);
      return 'updated';
    });
  }
  function run(cmd, region) {
    if (closed || busy) return Promise.reject(Object.assign(new Error('REGION_BUSY'), { code: 'REGION_BUSY' }));
    if (cmd !== 'regional-list' && (!base.regions[region] || region === UNASSIGNED)) return Promise.reject(Object.assign(new Error('REGION_UNKNOWN'), { code: 'REGION_UNKNOWN' }));
    if (cmd !== 'regional-list') selectedRegion = region;
    var operation = Promise.resolve().then(function () {
      ensureOpen();
      if (cmd === 'regional-list') { emit('checking'); return refresh().then(function () { return 'listed'; }); }
      if (cmd === 'regional-download') {
        if (available[region]) return install(region);
        emit('checking');
        return refresh().then(function () { return install(region); });
      }
      if (cmd === 'regional-rollback') {
        var entry = downloaded[region];
        if (!entry || !entry.previous) fail('REGION_NO_PREVIOUS');
        transact(region, entry.previous, null);
        return 'rolled-back';
      }
      fail('REGION_UNKNOWN');
    });
    busy = operation.then(function (result) {
      busy = null; emit(result); return status();
    }, function (e) {
      busy = null; emit('error', /^[A-Z0-9_]+$/.test(e.code || '') ? e.code : 'REGION_UPDATE'); return status();
    });
    return busy;
  }
  return { status: status, current: currentPacks, run: run, close: function () {
    closed = true;
    requests.slice().forEach(function (req) { req.destroy(Object.assign(new Error('REGION_CLOSED'), { code: 'REGION_CLOSED' })); });
  } };
}

module.exports = { load: load, merge: merge, validateManifest: validateManifest, validatePackage: validatePackage,
  createRegionalStore: createRegionalStore, MANIFEST_URL: MANIFEST };
