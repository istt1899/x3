'use strict';

/**
 * Minimal OAP SOME/IP adapter for the read-only TASU discovery probe.
 * Adapted from the MIT-licensed signals.js transport pattern in
 * https://github.com/cauliflowermossgrape/idrive7-apps
 * Copyright (c) 2026 cauliflowermossgrape.
 *
 * Usage in the OAP app:
 *   const { DiagnosticProbe } = require('./diagnostics');
 *   const probe = new DiagnosticProbe(); // creates this adapter automatically
 *   const result = await probe.scan();
 *   await probe.close();               // shuts down the native proxy
 *
 * The installed app's someipInterfaces config is generated from its manifest.
 * This adapter does not load a car identifier and exposes no write-capable API.
 */

const fs = require('fs');
const path = require('path');

const IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const INSTANCE = 'SystemFunctionsInternalTasuInst1';
const CONFIG_NAME = IFACE.replace(/\./g, '_') + '.json';

function isDiscovery(request) {
    if (!request || typeof request !== 'object') return false;
    const keys = Object.keys(request).sort();
    const allowed = [
        'deadlockTime', 'serviceID', 'sourceAddress', 'subroutineID',
        'targetAddress', 'udsData', 'udsDataLength',
    ].sort();
    if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) return false;
    const data = request.udsData;
    return request.sourceAddress === 0xF2 && request.targetAddress === 0xDF &&
        request.serviceID === 0x22 && request.subroutineID === 0 &&
        request.udsDataLength === 2 && request.deadlockTime === 0 &&
        (Buffer.isBuffer(data) || data instanceof Uint8Array) &&
        data.length === 2 && data[0] === 0xF1 && data[1] === 0x50;
}

class SomeipSignals {
    constructor(options) {
        this._options = options || {};
        this._native = this._options.someip || null;
        this._chain = Promise.resolve();
        this._cancelled = new WeakSet();
    }

    _tick(action) {
        // The OAP native binding can deadlock when called inline beside SDK
        // traffic; defer each operation to a fresh tick and serialize them.
        const run = () => new Promise((resolve, reject) => setImmediate(() => {
            try { Promise.resolve(action()).then(resolve, reject); }
            catch (error) { reject(error); }
        }));
        const task = this._chain.then(run, run);
        this._chain = task.catch(() => {});
        return task;
    }

    _config() {
        if (this._options.config) return this._options.config;
        const roots = [];
        if (this._options.appRoot) roots.push(path.resolve(this._options.appRoot));
        else {
            let dir = __dirname;
            for (let i = 0; i < 7; i++) {
                roots.push(dir);
                const parent = path.dirname(dir);
                if (parent === dir) break;
                dir = parent;
            }
        }
        for (const root of roots) {
            try {
                return JSON.parse(fs.readFileSync(path.join(root, 'someipInterfaces', CONFIG_NAME), 'utf8'));
            } catch (_) { /* try the next app-home candidate */ }
        }
        throw new Error('TASU SOME/IP config missing');
    }

    async proxy(iface, instance) {
        if (iface !== IFACE || instance !== INSTANCE) throw new Error('Only InternalTasu is allowed');
        let native = this._native;
        if (!native) {
            // MGU firmware stores the native binding here. The Store source
            // linker only accepts app modules, SDK modules and Node builtins;
            // load the system binding explicitly through Node's main module.
            const nativePath = '/usr/lib/someip.node';
            if (!fs.existsSync(nativePath) || !process.mainModule ||
                typeof process.mainModule.require !== 'function') {
                throw new Error('OAP SOME/IP module unavailable');
            }
            try { native = process.mainModule.require(nativePath); }
            catch (_) { throw new Error('OAP SOME/IP module unavailable'); }
        }
        if (!native || typeof native.buildProxy !== 'function') throw new Error('OAP SOME/IP module unavailable');
        const config = this._config();
        return this._tick(async () => {
            const proxy = await native.buildProxy(config, String(instance));
            await proxy.init();
            return proxy;
        });
    }

    on(proxy, eventName, callback) {
        if (eventName !== 'sendTasuResponse' || typeof callback !== 'function') {
            return Promise.reject(new Error('Only TASU discovery responses are allowed'));
        }
        return this._tick(() => proxy.subscribe({ name: eventName, onReceive: (value) => {
            try { callback(value); } catch (_) { /* native event boundary */ }
        } }));
    }

    onAvailable(proxy, callback) {
        if (typeof callback !== 'function') return Promise.reject(new Error('Availability callback required'));
        return this._tick(() => {
            if (typeof proxy.subscribeToAvailability === 'function') {
                try { return proxy.subscribeToAvailability((available) => callback(!!available)); }
                catch (_) { /* older binding: use isAvailable below */ }
            }
        }).then(() => {
            if (typeof proxy.isAvailable === 'function') callback(!!proxy.isAvailable());
        });
    }

    cancel(proxy) {
        if (proxy && (typeof proxy === 'object' || typeof proxy === 'function')) {
            this._cancelled.add(proxy);
        }
    }

    call(proxy, method, params, timeoutMs) {
        if (method !== 'sendTasuRequest' || !isDiscovery(params)) {
            return Promise.reject(new Error('Only read-only UDS 22 F1 50 to 0xDF is allowed'));
        }
        const request = {
            sourceAddress: 0xF2, targetAddress: 0xDF, serviceID: 0x22,
            subroutineID: 0, udsDataLength: 2, udsData: Buffer.from([0xF1, 0x50]), deadlockTime: 0,
        };
        const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 8000;
        if (this._cancelled.has(proxy)) return Promise.reject(new Error('TASU proxy closed'));
        return this._tick(() => {
            if (this._cancelled.has(proxy)) throw new Error('TASU proxy closed');
            return proxy.callMethod(method, request, ms);
        });
    }
}

function createSomeipSignals(options) { return new SomeipSignals(options); }

module.exports = { SomeipSignals, createSomeipSignals };
