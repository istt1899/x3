'use strict';
// 0.9.0: Moscow and Moscow oblast coverage from every reachable source.
// Pins the multi-region data contract: OSC region whitelist, the Moscow OSM
// merge, dedup honesty and per-region attribution.
const assert = require('assert'), fs = require('fs'), path = require('path');
const base = path.join(__dirname, '../native/marku-kaluga-cameras/files');
const bundle = require('./build-camera-database').bundle();
const regionOsm = require(path.join(base, 'region-osm'));
const osc = require(path.join(base, 'openspeedcam-data'));
const { createGuidance } = require(path.join(base, 'vehicle-guidance'));

assert.strictEqual(bundle.version, '2026.11.27.1');
assert(Array.isArray(bundle.regions) && bundle.regions.indexOf('RU-MOW') >= 0, 'the bundle declares the Moscow region');
assert(bundle.records.length > 10000, 'Moscow coverage is real: ' + bundle.records.length + ' records');

// Per-region attribution on every community record; the Kaluga base carries
// no region field and stays the home region.
const byRegion = {};
bundle.records.forEach(r => { const region = r.region || 'RU-KLU'; byRegion[region] = (byRegion[region] || 0) + 1; });
assert(byRegion['RU-MOW'] > 5000, 'Moscow city: ' + byRegion['RU-MOW']);
assert(byRegion['RU-MOS'] > 4000, 'Moscow oblast: ' + byRegion['RU-MOS']);
assert(byRegion['RU-KLU'] > 400, 'Kaluga stays covered: ' + byRegion['RU-KLU']);
assert.strictEqual(byRegion['RU-KLU'] + byRegion['RU-MOW'] + byRegion['RU-MOS'], bundle.records.length, 'every record has exactly one region');

// The Moscow OSM merge: idempotent and honest about the ledger.
const moscowSnapshot = regionOsm.load(path.join(base, 'moscow-osm.json'));
assert.strictEqual(moscowSnapshot.region, 'RU-MOW');
assert(moscowSnapshot.records.length > 1000, 'Moscow OSM snapshot: ' + moscowSnapshot.records.length);
const mergedTwice = regionOsm.merge(regionOsm.merge(bundle, moscowSnapshot), moscowSnapshot);
assert.strictEqual(mergedTwice.records.length, bundle.records.length, 'a second merge adds nothing');
assert(mergedTwice.regionalSources.length >= bundle.regionalSources.length, 'merge provenance is kept');

// Relevance: no neighbouring-region leakage, positions inside the union box,
// and the OSC snapshot rejects out-of-region points.
const snapshot = JSON.parse(fs.readFileSync(path.join(base, 'openspeedcam-central.json'), 'utf8'));
assert(snapshot.regions.indexOf('RU-MOW') >= 0 && snapshot.regions.indexOf('RU-MOS') >= 0);
snapshot.records.forEach(r => {
    assert(r.position.lat >= 53 && r.position.lat <= 57.3 && r.position.lon >= 33 && r.position.lon <= 40.6, 'inside the union box: ' + r.id);
});
assert(snapshot.excluded.some(e => e.reason === 'other-region'), 'neighbouring regions are audited, not imported');
const validated = osc.validateSnapshot(snapshot);
assert.strictEqual(validated.records.length, snapshot.records.length);

// A real point from the source was excluded as other-region because of casing.
const restoredId = 'osc:6a807622a79ee00eafa4a8e8';
const restored = bundle.records.find(r => r.id === restoredId);
assert(restored && restored.region === 'RU-KLU' && restored.limitKmh === 60);
// Restored source fields reach the same limit selector and optics renderer used
// on the vehicle. The bundled map supplement claims no legal speed.
const info = require(path.join(base, 'camera-info'));
const display = require(path.join(base, 'display-limit'));
const card = require(path.join(base, 'alert-card'));
const capture = require(path.join(base, 'capture-data'));
const describe = info.createDescriber(bundle.records);
const moscow = new Map(moscowSnapshot.records.map(r => [r.id,r]));
const visibleReferences = moscowSnapshot.records.filter(r => display.select(Object.assign({id:r.id},describe(r))).scope === 'camera');
assert.strictEqual(visibleReferences.length,589);
assert.strictEqual(moscowSnapshot.records.filter(r => {
    const direction = capture.captureFor(r);
    return direction && direction.source === 'osm-direction';
}).length,133);
moscowSnapshot.records.filter(r => r.cameraLimitConditional).forEach(r => {
    assert.strictEqual(display.select(Object.assign({id:r.id},describe(r))).value,null);
});
const research = require(path.join(base,'moscow-road-zones.json'));
assert.strictEqual(research.zones.length,35);
assert.strictEqual(research.zones.filter(z=>z.roadMapLimitSource).length,19);
for (const z of research.zones) {
    const r = moscow.get(z.id);
    assert.strictEqual(z.limit,null);
    assert.deepStrictEqual([z.lat,z.lon,z.osmVersion,z.facing],[r.position.lat,r.position.lon,r.osmVersion,r.rawDirection]);
    const anchors = z.roads.filter(road=>road.cam>=0);
    assert.strictEqual(anchors.length,1);
    assert.deepStrictEqual(anchors[0].pts[anchors[0].cam],[0,0]);
    if(z.roadMapLimitSource){
        assert(!r.cameraLimitConditional);
        assert.strictEqual(z.roadMapLimitSource.wayId,anchors[0].id);
    }
}
const zone = research.zones.find(z=>z.id==='osm:node:5588454426');
const record = bundle.records.find(r=>r.id===zone.id);
const way = zone.roads.find(r=>r.cam>=0);
const [east,north] = way.pts[way.cam-1];
const course = (Math.atan2(-east,-north)*180/Math.PI+360)%360;
function replay(overrides, recordOverride) {
    const tracker = createGuidance({zones:[],records:[Object.assign({},record,recordOverride)],nearby:false});
    const scale = 111320*Math.cos(zone.lat*Math.PI/180);
    let last;
    [.8,.66,.52].forEach((ratio,i)=>{
        const t=10000+i*1000;
        last=tracker.evaluate(Object.assign({lat:zone.lat+north*ratio/111320,lon:zone.lon+east*ratio/scale,
            speedKmh:85,headingDeg:course,accuracyM:4,timeMs:t},overrides),t,true);
    });
    return last;
}
const matched=replay();
assert(matched && matched.mappedApproach && matched.roadConfirmed);
assert.strictEqual(matched.way,way.id);
assert.strictEqual(matched.limitKmh,null);
assert.strictEqual(display.select(matched).value,60);
assert.strictEqual(display.select(matched).scope,'map');
assert.strictEqual(display.select(Object.assign({},matched,{gpsHeld:true})).value,null);
assert.strictEqual(card.presentation(Object.assign({},matched,{captureClass:'front'})).direction,'unknown');
assert.strictEqual(replay({accuracyM:11}),null);
assert.strictEqual(replay({headingDeg:(course+180)%360}),null);
assert.strictEqual(replay(null,{osmVersion:record.osmVersion+1}),null);
assert.strictEqual(replay({lon:zone.lon+.0005}),null);
const { pathToFileURL } = require('url');
const raw = require('../data/source-snapshots/osc-moscow-raw-2026-11-18.json');
const rawRestored = raw.find(point => 'osc:' + point._id === restoredId);
assert.strictEqual(rawRestored.region, 'Калужская Область');

// Guidance sees Moscow cameras: a synthetic approach to a Moscow OSC point
// produces an honest nearby notice for an unanchored community point.

const mowRecord = bundle.records.find(r => r.region === 'RU-MOW' && /^osc:/.test(r.id));
assert(mowRecord, 'a Moscow community record exists');
const g = createGuidance({ zones: [], records: [mowRecord], nearby: true });
const approach = { lat: mowRecord.position.lat - 200 / 111320, lon: mowRecord.position.lon, timeMs: 1000, speedKmh: 36, headingDeg: 0, accuracyM: 5 };
const notice = g.evaluate(approach, 1000, true);
assert(notice && notice.id === mowRecord.id, 'a Moscow camera warns in nearby mode');
assert.strictEqual(notice.roadConfirmed, false);
import(pathToFileURL(path.join(__dirname, 'import-openspeedcam.mjs')).href).then(({ normalizeSnapshot }) => {
    const normalized = normalizeSnapshot(raw, snapshot);
    assert.deepStrictEqual(normalized, snapshot, 'the committed snapshot matches the offline import');
    const spaced = normalizeSnapshot([Object.assign({}, rawRestored, { region: '  КАЛУЖСКАЯ ОБЛАСТЬ  ' })], snapshot);
    assert.strictEqual(spaced.records[0].region, 'RU-KLU');
    console.log('PASS moscow region: OSC whitelist (MOW ' + byRegion['RU-MOW'] + ', MOS ' + byRegion['RU-MOS'] + '), OSM merge ' + moscowSnapshot.records.length + ', idempotent merge, no neighbour leakage, nearby warnings work; total ' + bundle.records.length);
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
