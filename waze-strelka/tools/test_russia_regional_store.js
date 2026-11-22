'use strict';

const assert = require('assert');
const crypto = require('crypto');
const events = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const files = '../native/marku-kaluga-cameras/files/';
const db = require(files + 'russia-regional-store');
const info = require(files + 'camera-info');
const guidance = require(files + 'vehicle-guidance');
const presentation = require(files + 'alert-card').presentation;
const service = require(files + 'marku-kaluga-cameras');
const warning = require(files + 'warning-policy');

const sourcePath = path.resolve(__dirname, files, 'russia-camera-baseline.json');
const manifest = require('../data/russia/manifest-regions-v2.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const baseline = db.load(sourcePath);
const packs = Object.keys(baseline.regions).map(code => baseline.regions[code]);
const count = key => packs.reduce((sum, p) => sum + p[key], 0);
assert.strictEqual(packs.length, 84);
assert.deepStrictEqual(packs.filter(p => p.count === 0).map(p => p.region), ['RU-CHU', 'RU-SE', 'RU-TY']);
assert.strictEqual(count('count'), 11172);
assert.strictEqual(count('withCameraLimit'), 5328);
assert.strictEqual(count('withDirection'), 1466);
assert.strictEqual(count('withConditionalTag'), 9);
assert.strictEqual(count('withApproachDirection'), 0);
assert.strictEqual(count('withApproachLimit'), 0);
assert.strictEqual(db.validateManifest(manifest, baseline.regions).regions.length, 80);
for (const entry of manifest.regions) {
    const filename = path.basename(entry.artifact.url);
    const bytes = fs.readFileSync(path.join(__dirname, '../data/russia', filename));
    assert.strictEqual(sha(bytes), entry.artifact.sha256);
    assert.strictEqual(bytes.length, entry.artifact.size);
    assert.deepStrictEqual(db.validatePackage(JSON.parse(bytes), entry), baseline.regions[entry.region]);
}
assert.throws(() => db.validateManifest(Object.assign({}, manifest, {
    regions: [Object.assign({}, manifest.regions[0], {
        artifact: Object.assign({}, manifest.regions[0].artifact, { url: manifest.regions[0].artifact.url.replace('raw.githubusercontent.com', 'example.org') })
    })]
}), baseline.regions), /REGION_ARTIFACT_URL/);

const region = 'RU-NVS';
const original = baseline.regions[region];
const pack = Object.assign({}, original, { version: '2026.9.21.1', records: original.records.slice(1) });
pack.count--;
if (original.records[0][4] !== null) pack.withCameraLimit--;
if (original.records[0][5] !== null) {
    const r = original.records[0];
    const facing = require(files + 'camera-orientation').describe({ id: 'osm:node:' + r[0],
        sourceUrl: 'https://www.openstreetmap.org/node/' + r[0], rawDirection: r[5] });
    if (facing.state === 'mapped') pack.withDirection--;
}
if (original.records[0][6] !== null) pack.withConditionalTag--;
const packBytes = Buffer.from(JSON.stringify(pack));
const oldEntry = manifest.regions.find(entry => entry.region === region);
const entry = Object.assign({}, pack, { records: undefined, artifact: {
    url: oldEntry.artifact.url.replace('-2026.9.21.json', '-2026.9.21.1.json'),
    size: packBytes.length, sha256: sha(packBytes)
} });
const manifestBytes = Buffer.from(JSON.stringify(Object.assign({}, manifest, {
    regions: manifest.regions.map(published => published.region === region ? entry : published)
})));

function location(raw, eastM, utc, speedKmh) {
    const lon = raw[2] + eastM / (111320 * Math.cos(raw[1] * Math.PI / 180));
    return { lat: raw[1], lon: lon, timeMs: utc, motionTimeMs: utc, accuracyM: 5, headingDeg: 90, speedKmh: speedKmh, source: 'gpsd' };
}
function firstFrame(socketPath) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);
        let line = '';
        socket.on('error', reject);
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
            line += chunk;
            const end = line.indexOf('\n');
            if (end >= 0) {
                socket.destroy();
                resolve({ bytes: Buffer.byteLength(line.slice(0, end)), state: JSON.parse(line.slice(0, end)).state });
            }
        });
    });
}
function cleanup(dir) {
    fs.readdirSync(dir).forEach(name => {
        const file = path.join(dir, name);
        if (fs.lstatSync(file).isDirectory()) cleanup(file);
        else fs.unlinkSync(file);
    });
    fs.rmdirSync(dir);
}
async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strelka-russia-'));
    let regional, app, fetches = 0, downloads = 0, delayTransfer = false, completeTransfer;
    const options = { dataDir: dir, snapshot: sourcePath, fetchManifest() {
        fetches++;
        return Promise.resolve(manifestBytes);
    }, download(artifact, transport) {
        downloads++;
        transport.allow(artifact.url);
        assert(transport.dir.endsWith('regional-cameras'));
        if (delayTransfer) return new Promise(resolve => { completeTransfer = resolve; });
        return Promise.resolve(packBytes);
    } };
    try {
        regional = db.createRegionalStore(options);
        assert.strictEqual(fetches, 0, 'Bundled offline startup must never request the network');
        assert.strictEqual(fs.existsSync(path.join(dir, 'regional-cameras')), false, 'Read-only use needs no new directory');
        const status = () => regional.status().regions.find(r => r.region === region);
        assert.strictEqual(status().status, 'bundled');
        assert.strictEqual((await regional.run('regional-list')).phase, 'listed');
        assert.strictEqual(status().status, 'available');
        assert.strictEqual(downloads, 0, 'Listing is manifest-only');
        const pending = regional.run('regional-download', region);
        await regional.run('regional-rollback', region).then(
            () => assert.fail('A concurrent rollback must be rejected'),
            error => assert(/REGION_BUSY/.test(error.message))
        );
        assert.strictEqual((await pending).phase, 'updated');
        assert.strictEqual(status().currentVersion, pack.version);
        assert.strictEqual(status().canRollback, true);
        regional.close();
        regional = db.createRegionalStore(options);
        assert.strictEqual(status().currentVersion, pack.version, 'Installed region survives offline restart');
        assert.strictEqual((await regional.run('regional-rollback', region)).phase, 'rolled-back');
        assert.strictEqual(status().currentVersion, original.version);
        assert.strictEqual(fetches, 1);
        assert.strictEqual(downloads, 1);

        await regional.run('regional-download', region);
        regional.close();
        const regionPath = path.join(dir, 'regional-cameras', 'region-' + region + '.json');
        const saved = JSON.parse(fs.readFileSync(regionPath));
        // A valid-looking changed position must still fail the persistent digest.
        saved.active.records[0][1] += 0.001;
        fs.writeFileSync(regionPath, JSON.stringify(saved));
        regional = db.createRegionalStore(options);
        assert.strictEqual(regional.status().errorCode, 'REGION_LOCAL_RECOVERED');
        assert.strictEqual(status().currentVersion, original.version);
        regional.close();
        regional = null;

        const official = require('../data/camera-database-2026.11.21.1.json');
        const tulskayaId = 'gibdd:ru-klu:f6d3371c82091721';
        const tula = official.records.find(r => r.id === tulskayaId);
        assert(tula, 'Use the real official catalog camera');
        const tulaDetail = info.createDescriber(official.records)(tula);
        assert.strictEqual(tulaDetail.approachLimitEvidence.status, 'historical');
        assert.strictEqual(tulaDetail.approachLimitEvidence.valueKmh, 40);
        assert.deepStrictEqual(tulaDetail.approachLimitEvidence.ways, [23971863, 133739860]);
        assert.strictEqual(tulaDetail.cameraLimitKmh, null);
        assert.strictEqual(tulaDetail.limitReference, null);
        assert(!official.zones.some(z => z.id === tulskayaId && Number.isFinite(z.limit)));
        assert.strictEqual(info.describe(Object.assign({}, tula, { id: 'other-location' })).approachLimitEvidence, null);

        const razinNorth = [[54.51073, 36.273906], [54.51065, 36.273955], [54.51056, 36.274007]];
        const razinSouth = [[54.51004, 36.274666], [54.51013, 36.274616], [54.51022, 36.274566]];
        const tulaEast = [[54.510571, 36.27512], [54.510543, 36.274983], [54.510516, 36.274846]];
        const trace = (coordinates, headingDeg) => {
            const tracker = guidance.createGuidance({ zones: [], records: [tula] });
            return coordinates.map(([lat, lon], i) => {
                const timeMs = Date.UTC(2026, 10, 22, 10, 0, i);
                return tracker.evaluate({ lat, lon, timeMs, headingDeg, speedKmh: 40, accuracyM: 3 }, timeMs, true);
            }).filter(Boolean);
        };
        const approaches = [trace(razinNorth, 162), trace(razinSouth, 342), trace(tulaEast, 254)];
        approaches.forEach(alerts => {
            assert(alerts.some(alert => alert.id === tulskayaId && alert.approachLimitEvidence.status === 'historical'));
        });
        approaches.concat([trace(razinNorth.slice().reverse(), 342), trace(razinSouth.slice().reverse(), 162)])
            .forEach(alerts => alerts.forEach(alert => assert.strictEqual(presentation(alert).limit, null)));


        const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\strelka-russia-' + process.pid : path.join(dir, 'ctl.sock');
        const gps = new events.EventEmitter();
        gps.start = gps.close = () => {};
        let now = Date.UTC(2026, 10, 22, 12, 0), fix = null, rendered = null;
        gps.current = () => fix;
        gps.referenceClock = { now: () => now, snapshot: () => ({
            referenceEpoch: 0, referenceUtcMs: now, systemWallMs: now, referenceSource: 'system'
        }) };
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ outputs: { cluster: true, hud: true } }));
        await new Promise((resolve, reject) => {
            app = service.start({ dataDir: dir, socket: socketPath, gps, onListening: resolve, onError: reject,
                regionalStoreFactory: injected => db.createRegionalStore(Object.assign({}, injected,
                    { fetchManifest: options.fetchManifest, download: options.download })),
                display: { update: (alert, outputs) => { rendered = { alert, outputs }; }, status: () => 'ready', close() {} },
                dimmer: { update() {}, status: () => 'off', close() {} } });
        });
        const frame = await firstFrame(socketPath);
        assert.strictEqual(frame.state.regionalDatabase.regions.length, 84);
        assert(frame.bytes < 65536, 'Real status must fit the control receive window: ' + frame.bytes);
        assert.strictEqual(frame.state.database.state, 'ready', frame.state.databaseUpdate.message);
        assert.deepStrictEqual(frame.state.database.nationalOsm, { sourceRecords: 11172, additionalRecords: 9677 });
        assert(frame.state.regionalDatabase.regions.some(item => item.region === region && item.count === original.count));
        const camera = original.records.find(r => r[0] === 653112132);
        for (const m of [-205, -180, -155]) {
            now += 1000;
            fix = location(camera, m, now, 90);
            app.tick();
        }
        assert(rendered.alert, 'Bundled federal point should warn offline outside Kaluga/Moscow');
        assert.strictEqual(rendered.alert.id, 'osm:node:' + camera[0]);
        assert.deepStrictEqual(rendered.outputs, { hud: true, cluster: true });
        assert.strictEqual(rendered.alert.cameraLimitKmh, 60);
        assert.strictEqual(rendered.alert.limitKmh, null);
        assert.strictEqual(rendered.alert.limitReference, null);
        assert.strictEqual(rendered.alert.roadConfirmed, false);
        assert.strictEqual(warning.evaluate(rendered.alert, fix, now, {}).soundExceeded, false);
        assert.throws(() => app.command({ cmd: 'regional-download', region }), /остановитесь/);
        assert.strictEqual(app.state().commandResult.phase, 'error');

        async function regionalCommand(cmd, expected) {
            app.command({ cmd, region });
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(app.state().regionalDatabase.phase, expected);
            assert.strictEqual(app.state().commandResult.phase, 'finished');
        }

        await regionalCommand('regional-list', 'listed');
        const activeFrame = await firstFrame(socketPath);
        assert(activeFrame.bytes < 65536, 'Catalog and live warning must fit the control window: ' + activeFrame.bytes);
        now += 1000;
        fix = location(camera, -155, now, 0);
        app.tick();
        const countBeforeInstall = app.state().database.count;
        delayTransfer = true;
        app.command({ cmd: 'regional-download', region });
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(app.state().regionalDatabase.phase, 'downloading');
        now += 1000;
        fix = location(camera, -150, now, 18);
        app.tick();
        completeTransfer(packBytes);
        delayTransfer = false;
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(app.state().regionalDatabase.errorCode, 'REGION_PARK_REQUIRED');
        assert.strictEqual(app.state().database.count, countBeforeInstall);

        now += 1000;
        fix = location(camera, -150, now, 0);
        app.tick();
        await regionalCommand('regional-download', 'updated');
        assert.strictEqual(app.state().database.count, countBeforeInstall - 1);
        assert.deepStrictEqual(app.state().database.nationalOsm, { sourceRecords: 11171, additionalRecords: 9676 });
        await regionalCommand('regional-rollback', 'rolled-back');
        assert.strictEqual(app.state().database.count, countBeforeInstall);
        console.log('PASS national OSM import, 80 offline packages, one-region update/restart/rollback/recovery, actual official Kaluga evidence and regional warning; socket payload ' + frame.bytes + '/' + activeFrame.bytes + ' bytes');
    } finally {
        if (app) app.close();
        if (regional) regional.close();
        cleanup(dir);
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
