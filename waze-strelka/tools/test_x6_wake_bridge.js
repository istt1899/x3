// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BmwGpsBridge } = require('../apps/marku_kaluga_cameras/src/bmw_gps_bridge');
const { BmwNavigationBridge, NAV, GONG } = require('../apps/marku_kaluga_cameras/src/bmw_navigation_bridge');
const { GpsProvider } = require('../native/marku-kaluga-cameras/files/gps-source');
const service = require('../native/marku-kaluga-cameras/files/marku-kaluga-cameras');

const wallAtWake = Date.parse('2179-06-05T21:03:27.000Z');
const noRmcUtc = '$GNRMC,,V,,,,,,,,,,N*4D';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, description) {
    const deadline = Date.now() + 3500;
    while (!check()) {
        assert(Date.now() < deadline, description);
        await delay(10);
    }
}

function location(longitude, street) {
    return {
        status: 'ON_ROAD', position: { latitude: 54.5, longitude }, speedKmh: 32, headingDeg: 90,
        horizontalAccuracyM: 8, textDescription: { textDescriptorList: { STREET: { orthography: street } } }
    };
}

async function main() {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'strelka-wake-'));
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\strelka-wake-' + process.pid : path.join(dir, 'ctl.sock');
    let elapsed = 0;
    const monotonicNow = () => elapsed;
    const bootSec = () => 100 + elapsed / 1000;
    const wallNow = () => wallAtWake + elapsed;
    const gps = new GpsProvider({ now: wallNow, monotonicNow, bootSec, nmeaPort: 0, port: 1,
        readRtc: () => NaN, createNetworkUtc: () => ({ now: () => null, close() {} }) });

    let navEvent, nmeaEvent, resolveGetter, getterCalls = 0;
    const cached = location(36.9, 'Улица из кэша');
    const initial = location(36.8, 'Улица из начального события');
    const builders = {
        buildAndInitTypedProxy(iface, instance) {
            if (iface === NAV) {
                assert.strictEqual(instance, 'Main_Instance');
                return Promise.resolve({ currentLocation: {
                    subscribe(callback) { navEvent = callback; callback(initial); },
                    getValue() {
                        ++getterCalls;
                        if (getterCalls === 1) return Promise.resolve(cached);
                        return new Promise(resolve => { resolveGetter = resolve; });
                    }
                } });
            }
            if (iface === GONG) return Promise.resolve({ getAllSampleSets: () => ({ listSampleNames: [] }) });
            assert.strictEqual(iface, 'de.bmw.infotainment.SatellitePositioning');
            return Promise.resolve({ updatePosition: { subscribe(callback) { nmeaEvent = callback; } } });
        }
    };
    const nmea = new BmwGpsBridge({ builders, now: wallNow, controlOptions: { path: socket } });
    const control = nmea.control;
    const nav = new BmwNavigationBridge({ builders, control, now: wallNow, bootSec, pollMs: 20 });
    let app;
    try {
        await new Promise((resolve, reject) => {
            app = service.start({ dataDir: dir, socket, gps, monotonicNow, onListening: resolve, onError: reject,
                database: path.join(dir, 'no-camera-database.json'), guidance: { evaluate: () => null },
                display: { update() {}, status: () => 'ready', close() {} },
                dimmer: { update() {}, status: () => 'off', close() {} } });
        });
        nmea.start();
        nav.start();
        await until(() => control.state && nmeaEvent && navEvent && resolveGetter, 'BMW getters and subscriptions did not settle');
        assert.strictEqual(nav.status().street.name, 'Улица из кэша');
        nmeaEvent({ nmeaString: noRmcUtc });
        await until(() => app.state().gpsInput.lastPacketAgeMs !== null, 'missing-UTC RMC did not reach native');
        assert.strictEqual(app.state().gpsInput.nmeaTiming.pairReason, 'INVALID_RMC');
        assert.strictEqual(app.state().clock.referenceState, 'waiting');
        assert.strictEqual(app.state().clock.sourceUtcMs, null);
        assert.strictEqual(app.state().gpsNavigation.updates, 0, 'the initial field event and cached getter must not carry coordinates');
        assert.strictEqual(app.state().gpsFix, null);

        elapsed = 1250;
        navEvent(location(36.2, 'Живая улица'));
        elapsed += 200;
        await until(() => app.state().gpsNavigation.accepted === 1, 'first live BMW navigation fix did not reach native');
        const first = app.state().gpsFix;
        assert.strictEqual(first.source, 'bmw-navigation');
        assert.strictEqual(first.lon, 36.2);
        assert.strictEqual(first.timeOrigin, 'receipt');
        assert.strictEqual(first.sampledAtBootSec, 101.25);
        assert.strictEqual(app.state().gpsNavigation.sampleAgeMs, 200, 'native must retain the original sample age');

        resolveGetter(cached);
        await until(() => getterCalls >= 3, 'late SDK getter did not settle');
        assert.strictEqual(app.state().gpsNavigation.updates, 1, 'late getter must not replace a live position');
        assert.strictEqual(nav.status().street.name, 'Живая улица');

        control.close();
        elapsed = 2200;
        navEvent(location(36.3, 'Позиция без соединения'));
        control.open();
        await until(() => control.state, 'CameraControl did not reconnect');
        assert.strictEqual(app.state().gpsNavigation.updates, 1, 'reconnect must not replay any live positions');
        assert.strictEqual(app.state().gpsFix.lon, 36.2);

        elapsed = 4251;
        app.tick();
        assert.strictEqual(app.state().gpsFix, null, 'the original fix must expire on the boot clock');

        navEvent(location(36.4, 'Новая живая улица'));
        await until(() => app.state().gpsNavigation.accepted === 2, 'new callback after reconnect did not reach native');
        assert.strictEqual(app.state().gpsFix.lon, 36.4);
        navEvent({ status: 'OFF_ROAD' });
        await until(() => app.state().gpsFix === null, 'a live OFF_ROAD notification did not clear the fallback');
    } finally {
        nav.stop();
        nmea.stop();
        if (app) app.close();
        else gps.close();
        fs.readdirSync(dir).forEach(file => fs.unlinkSync(path.join(dir, file)));
        fs.rmdirSync(dir);
    }
}

main().then(() => console.log('PASS X6 wake: BMW callbacks via CameraControl, cached and disconnected fixes never replay, native boot age preserved'),
    error => { console.error(error.stack); process.exitCode = 1; });
