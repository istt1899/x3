// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// BMW navigation is a lower-trust fallback: it may supply road guidance only
// when the primary GNSS stream has no fresh road-ready fix. The native service
// remains the validation boundary for every navigation payload.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const service = require('../native/marku-kaluga-cameras/files/marku-kaluga-cameras');
const { GpsProvider } = require('../native/marku-kaluga-cameras/files/gps-source');
const { CameraControl } = require('../apps/marku_kaluga_cameras/src/control');

let now = Date.now();
function provider() { return new GpsProvider({ now: () => now, nmeaPort: 0, port: 1 }); }
function pad(value, width) { return String(value).padStart(width || 2, '0'); }
function sentence(body) {
    let checksum = 0;
    for (let i = 0; i < body.length; i++) checksum ^= body.charCodeAt(i);
    return '$' + body + '*' + pad(checksum.toString(16));
}
function sourceTime(ms) {
    const date = new Date(ms);
    return {
        time: pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + '.000',
        day: pad(date.getUTCDate()) + pad(date.getUTCMonth() + 1) + String(date.getUTCFullYear()).slice(-2)
    };
}
function feedJammedBmw(gps, at) {
    const t = sourceTime(at);
    gps.inputNmea([
        sentence('GNRMC,' + t.time + ',V,5451.000,N,03610.000,E,,,' + t.day + ',,,N'),
        sentence('GNGGA,' + t.time + ',5451.000,N,03610.000,E,0,00,99.9,,M,,M,,')
    ].join('\r\n'));
}
function feedRoadReadyBmw(gps, at) {
    const t = sourceTime(at);
    gps.inputNmea([
        sentence('GNRMC,' + t.time + ',A,5451.000,N,03610.000,E,20,90,' + t.day + ',,,A'),
        sentence('GNGGA,' + t.time + ',5451.000,N,03610.000,E,1,10,0.8,150,M,0,M,,'),
        sentence('GNGST,' + t.time + ',1,1,1,0,3,4,6')
    ].join('\r\n'));
}
function navigationFix(at, patch) {
    return Object.assign({ lat: 54.85, lon: 36.17, speedKmh: 60, headingDeg: 90,
        accuracyM: 8, timeMs: at, timeOrigin: 'source' }, patch || {});
}
function until(test, timeout) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            try {
                if (test()) { clearInterval(timer); resolve(); }
                else if (Date.now() - started > (timeout || 3000)) { clearInterval(timer); reject(new Error('navigation fallback wait timed out')); }
            } catch (error) { clearInterval(timer); reject(error); }
        }, 10);
    });
}
function removeTree(dir) {
    fs.readdirSync(dir).forEach((name) => {
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        if (stat.isDirectory() && !stat.isSymbolicLink()) removeTree(file);
        else fs.unlinkSync(file);
    });
    fs.rmdirSync(dir);
}

async function main() {
    let gps = provider();
    feedJammedBmw(gps, now - 300);
    assert.strictEqual(gps.current(now), null, 'jammed BMW NMEA must not create a fix');
    assert.strictEqual(gps.inputNavigation(navigationFix(now - 100)), true);
    assert.strictEqual(gps.current(now).source, 'bmw-navigation');
    assert.strictEqual(gps.current(now).fallback, true);
    assert(gps.motionFixes(now).some(item => item.source === 'bmw-navigation' && item.speedKmh === 60));
    let diagnostics = gps.diagnostics(now);
    assert.strictEqual(diagnostics.gpsNavigation.state, 'ready');
    assert.strictEqual(diagnostics.gpsNavigation.accepted, 1);
    assert(/запасной режим/.test(gps.description(gps.current(now), now)));

    now += 3001;
    assert.strictEqual(gps.current(now), null, 'navigation fallback expires after 3 seconds');
    assert.strictEqual(gps.inputNavigation(navigationFix(now - 3001)), false, 'stale navigation time is rejected');
    assert.strictEqual(gps.inputNavigation(navigationFix(now - 100, { accuracyM: 16 })), false, 'navigation accuracy above 15 m is rejected');
    assert.strictEqual(gps.inputNavigation(navigationFix(now - 100, { spoofed: true })), false, 'unknown navigation fields are rejected');
    assert.strictEqual(gps.inputNavigation(navigationFix(now - 100, { headingDeg: 360 })), false, 'invalid navigation heading is rejected');
    assert.strictEqual(gps.diagnostics(now).gpsNavigation.rejected, 4);

    let primary = provider();
    feedRoadReadyBmw(primary, now - 100);
    assert.strictEqual(primary.inputNavigation(navigationFix(now - 200)), true);
    assert.strictEqual(primary.current(now).source, 'bmw-nmea', 'road-ready GNSS must retain priority over navigation');
    assert(primary.motionFixes(now).every(item => item.source !== 'bmw-navigation'), 'navigation speed must not conflict with road-ready GNSS');
    let expiredPrimary = provider();
    feedRoadReadyBmw(expiredPrimary, now - 4000);
    assert.strictEqual(expiredPrimary.inputNavigation(navigationFix(now - 100)), true);
    assert.strictEqual(expiredPrimary.current(now).source, 'bmw-navigation', 'fresh navigation must return after GNSS expires');
    assert(expiredPrimary.motionFixes(now).some(item => item.source === 'bmw-navigation'), 'navigation motion must return after GNSS expires');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-navigation-fallback-'));
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\bmw-navigation-fallback-' + process.pid : path.join(dir, 'ctl.sock');
    let app = null, client = null, guidanceFix = null;
    try {
        await new Promise((resolve, reject) => {
            app = service.start({ dataDir: dir, socket, gps,
                guidance: { evaluate: fix => { guidanceFix = fix; return fix ? { id: 'navigation-fallback-proof', type: 'speed',
                        title: 'Навигационный тест', description: 'Проверка запасного режима', controls: ['speed'],
                        distanceM: 150, limitKmh: 60, roadConfirmed: true, confidence: 'road' } : null; },
                    diagnostic: () => ({}) },
                display: { update: () => {}, status: () => 'ready', diagnostics: () => ({ connection: 'ready' }), close: () => {} },
                dimmer: { update: () => {}, status: () => 'off', close: () => {} },
                onListening: resolve, onError: reject });
        });
        client = new CameraControl({ path: socket, retryMs: 50 });
        client.open();
        await until(() => client.state);
        now = Date.now();
        feedJammedBmw(gps, now - 300);
        const acceptedBeforeService = gps.navigation.accepted;
        client.send({ cmd: 'vehicle-context', navigation: { source: 'bmw-navigation', state: 'ready', observedAtMs: now,
            fix: navigationFix(now - 100) } });
        await until(() => app.state().gpsFix && app.state().gpsFix.source === 'bmw-navigation');
        assert(guidanceFix && guidanceFix.source === 'bmw-navigation', 'road guidance must receive the fallback fix');
        assert.strictEqual(app.state().alert && app.state().alert.id, 'navigation-fallback-proof');
        assert.strictEqual(app.state().gpsNavigation.accepted, acceptedBeforeService + 1);
        assert(/Навигация BMW/.test(app.state().gps));

        client.send({ cmd: 'vehicle-context', navigation: { source: 'bmw-navigation', state: 'partial',
            reason: 'Навигация BMW дала позицию без явной точности в метрах', observedAtMs: Date.now(), fix: null } });
        await until(() => app.state().gpsFix === null && app.state().alert === null);
        assert.strictEqual(app.state().gpsNavigation.state, 'unavailable');
    } finally {
        if (client) client.close();
        if (app) app.close();
        removeTree(dir);
    }
    console.log('PASS BMW navigation fallback: strict boundary validation, GNSS priority, 3-second expiry and service IPC alert path');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
