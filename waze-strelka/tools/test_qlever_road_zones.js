"use strict";
const assert = require("assert");
const zones = require("../native/marku-kaluga-cameras/files/qlever-road-zones.json");
const baseline = require("../native/marku-kaluga-cameras/files/russia-camera-baseline.json");
const guidance = require("../native/marku-kaluga-cameras/files/vehicle-guidance");
const card = require("../native/marku-kaluga-cameras/files/alert-card");

const catalog = new Map();
baseline.regions.forEach(region => region.records.forEach(row => catalog.set("osm:node:" + row[0], row)));
assert(zones.zones.length > 0);
assert.strictEqual(zones.sourceTimestamp, baseline.sourceTimestamp);
assert.strictEqual(zones.sourceSnapshot, baseline.sourceSnapshot);
for (const zone of zones.zones) {
    const point = catalog.get(zone.id);
    assert(point && point[1] === zone.lat && point[2] === zone.lon);
    assert.strictEqual(zone.limit, null);
    const anchors = zone.roads.filter(road => road.cam >= 0);
    assert.strictEqual(anchors.length, 1);
    assert.strictEqual(anchors[0].id, zone.roadMapLimitSource.wayId);
    assert(anchors[0].cam > 0 && anchors[0].cam < anchors[0].pts.length - 1);
    assert(Math.hypot.apply(Math, anchors[0].pts[anchors[0].cam]) <= 0.25);
    assert(zone.coverageRadiusM <= 350);
}

// Astrakhan, OSM camera node and real trunk geometry plus all mapped competing ways.
const zone = zones.zones.find(candidate => candidate.id === "osm:node:9310974590");
const road = zone.roads.find(candidate => candidate.cam >= 0);
const crossing = zone.roads.find(candidate => candidate.id === 1455214082);
const record = {
    id: zone.id, type: "speed", controls: ["speed"],
    position: { lat: zone.lat, lon: zone.lon },
    providerId: "osm-russia", sourcePublishedAt: baseline.sourceTimestamp,
    limitKmh: zone.roadMapLimitKmh
};
const time = 10000;
function make(target = record) {
    return guidance.createGuidance({ zones: [], records: [target], nearby: false });
}
function sample(tracker, x, y, step, options = {}) {
    const t = time + step * 1000;
    const lon = zone.lon + x / (111320 * Math.cos(zone.lat * Math.PI / 180));
    const lat = zone.lat + y / 111320;
    return tracker.evaluate(Object.assign({ lat, lon, speedKmh: 72, headingDeg: 90, accuracyM: 5, timeMs: t }, options), t, true);
}
function interpolate(a, b, x) {
    return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
}
const before = road.pts[road.cam - 1], farther = road.pts[road.cam - 2];
function approach(tracker, options) {
    for (let i = 0; i < 3; i++) {
        const x = -160 + i * 10;
        const alert = sample(tracker, x, interpolate(farther, before, x), i, options);
        if (i === 2) return alert;
    }
}
const actual = make();
const matched = approach(actual);
assert(matched && matched.roadConfirmed && matched.way === road.id);
assert.strictEqual(matched.roadMapLimitKmh, 90);
assert.strictEqual(matched.limitKmh, null);
assert.deepStrictEqual(matched.roadMapLimitSource, zone.roadMapLimitSource);
assert.strictEqual(approach(make(), { accuracyM: 12 }), null);
assert.strictEqual(approach(make(), { headingDeg: 270 }), null);
assert.strictEqual(approach(make(Object.assign({}, record, { sourcePublishedAt: "2025-01-01T00:00:00Z" }))), null);
assert.strictEqual(approach(make(Object.assign({}, record, { providerId: "osm-moscow" }))), null);
assert.strictEqual(make(Object.assign({}, record, { position: { lat: record.position.lat + 0.001, lon: record.position.lon } })).count, 0);
const elsewhere = make();
const away = [-70, -60, -50];
away.forEach((x, index) => {
    assert.strictEqual(sample(elsewhere, x, interpolate(crossing.pts[0], crossing.pts[1], x), index), null);
});
const rejected = sample(actual, -70, interpolate(crossing.pts[0], crossing.pts[1], -70), 6);
assert(rejected && !rejected.roadMapLimitSource, "on a fresh wrong-road sample, preserve the card without its old map limit");
const repeated = sample(actual, -70, interpolate(crossing.pts[0], crossing.pts[1], -70), 6);
assert(repeated && !repeated.roadMapLimitSource, "a routine tick must not restore the old road limit");

const aboveMap = Object.assign({}, matched, {
    speedKmh: 110, overspeed: true, speedWarning: { flashActive: true, flashPhase: true }
});
const model = card.presentation(aboveMap);
assert.strictEqual(model.limit, 90);
assert.strictEqual(model.limitScope, "map");
assert.strictEqual(model.overspeed, false);
assert.strictEqual(model.flashActive, false);
for (const target of ["hud", "cluster"]) {
    assert.notDeepStrictEqual(card.card(aboveMap, target), card.card(Object.assign({}, aboveMap, { roadMapLimitSource: null }), target));
}
for (const bad of [
    { provider: "navigation" }, { wayId: road.id + 1 }, { tag: "maxspeed:conditional" },
    { sourceTimestamp: "yesterday" }, { sourceTimestamp: "2026-21-09T00:00:00Z" }
]) {
    const changed = Object.assign({}, aboveMap, { roadMapLimitSource: Object.assign({}, aboveMap.roadMapLimitSource, bad) });
    assert.strictEqual(card.presentation(changed).limit, null);
}
assert.strictEqual(card.presentation(Object.assign({}, aboveMap, { roadConfirmed: false })).limit, null);
assert.strictEqual(card.presentation(Object.assign({}, aboveMap, { limitKmh: 80 })).limitScope, "conflict");
async function atlasStatusOverSocket() {
    const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
    const EventEmitter = require('events');
    const service = require('../native/marku-kaluga-cameras/files/marku-kaluga-cameras');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strelka-atlas-wire-'));
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\strelka-atlas-' + process.pid : path.join(dir, 'ctl.sock');
    const gps = new EventEmitter();
    let fix = null, app;
    gps.start = gps.close = () => {};
    gps.current = () => fix;
    function status() {
        return new Promise((resolve, reject) => {
            const sock = net.createConnection(socket);
            let line = '';
            sock.setEncoding('utf8');
            sock.setTimeout(4000, () => sock.destroy(new Error('No status frame')));
            sock.on('error', reject);
            sock.on('data', bytes => {
                line += bytes;
                const nl = line.indexOf('\n');
                if (nl < 0) return;
                sock.destroy();
                try {
                    assert(Buffer.byteLength(line.slice(0, nl), 'utf8') < 131072, 'Full frame fits the live control client');
                    const message = JSON.parse(line.slice(0, nl));
                    assert.strictEqual(message.ev, 'status');
                    resolve(message.state);
                } catch (error) { reject(error); }
            });
        });
    }
    try {
        await new Promise((resolve, reject) => {
            app = service.start({ dataDir: dir, socket, gps, guidance: make(), onListening: resolve, onError: reject,
                storeFactory: ({ initial }) => ({ current: () => initial, status: () => ({ phase: 'idle' }), close() {} }),
                display: { update() {}, status: () => 'off', close() {} }, dimmer: { update() {}, status: () => 'off', close() {} } });
        });
        assert.deepStrictEqual((await status()).atlasMap, { origin: null, roads: [], camera: null });
        const start = Date.now() - 1500;
        for (let i = 0; i < 3; i++) {
            const x = -160 + i * 10, y = interpolate(farther, before, x);
            fix = { lat: zone.lat + y / 111320, lon: zone.lon + x / (111320 * Math.cos(zone.lat * Math.PI / 180)),
                source: 'bmw-nmea', timeMs: start + i * 700, motionTimeMs: start + i * 700, headingDeg: 90, speedKmh: 60, accuracyM: 5 };
            app.tick();
        }
        const state = await status(), map = state.atlasMap;
        assert.strictEqual(state.alert.id, zone.id);
        assert.deepStrictEqual(map.origin, { lat: fix.lat, lon: fix.lon });
        assert.deepStrictEqual(map.camera, { lat: zone.lat, lon: zone.lon });
        assert.strictEqual(map.source, 'OpenStreetMap');
        assert(map.roads.length > 0 && map.roads.length <= 30);
        assert(map.roads.reduce((n, r) => n + r.points.length, 0) <= 192);
        assert(Buffer.byteLength(JSON.stringify(map), 'utf8') < 8192);
        const cameraVertex = pt => Math.abs(pt[0] - zone.lat) < 0.000001 && Math.abs(pt[1] - zone.lon) < 0.000001;
        assert(map.roads.some(r => r.current && r.points.some(cameraVertex)), 'The actual matched OSM way reaches the real camera');
        assert(map.roads.every(r => r.points.length >= 2 && r.points.length <= 64));
        fix = null; app.tick();
        const held = (await status()).atlasMap;
        assert.deepStrictEqual(held.roads, []); assert.strictEqual(held.origin, null);
        assert.deepStrictEqual(held.camera, map.camera, 'Bounded display hold still identifies its actual camera');
        // End the alert before moving the fixture across regions; guidance
        // correctly rejects such an instantaneous jump within an active trip.
        app.command({ cmd: 'disable' });
        fix = { lat: 60, lon: 39, accuracyM: 5, headingDeg: 90, speedKmh: 60, source: 'bmw-nmea', timeMs: Date.now(), motionTimeMs: Date.now() };
        app.tick();
        const uncovered = (await status()).atlasMap;
        assert.deepStrictEqual(uncovered.origin, { lat: 60, lon: 39 });
        assert.deepStrictEqual(uncovered.roads, []); assert.strictEqual(uncovered.camera, null);
    } finally {
        if (app) app.close();
        fs.readdirSync(dir).forEach(file => fs.unlinkSync(path.join(dir, file)));
        fs.rmdirSync(dir);
    }
}
atlasStatusOverSocket().then(() => console.log('QLever road maps and Atlas status socket: real matched OSM shape, bounded frame, GPS loss, uncovered position, HUD and cluster PASS'))
    .catch(error => { console.error(error.stack); process.exitCode = 1; });
