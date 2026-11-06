'use strict';

/**
 * Read-only ECU discovery over the MGU's InternalTasu SOME/IP service.
 *
 * The TASU envelope and signals transport API follow the MIT-licensed
 * cauliflowermossgrape/idrive7-apps kit/runtime/diag.js and signals.js:
 * https://github.com/cauliflowermossgrape/idrive7-apps
 * Copyright (c) 2026 cauliflowermossgrape. Only functional UDS 22 F1 50 is
 * implemented here. No VIN or other identifiers are requested or logged.
 *
 * Pass ctx.signals from the idrive7-apps OAP runtime, or a compatible fake in
 * tests. The app manifest must declare sendTasuRequest/sendTasuResponse.
 */

const IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const INSTANCE = 'SystemFunctionsInternalTasuInst1';
const SOURCE = 0xF2;
const FUNCTIONAL = 0xDF;
const SID = 0x22;
const DID = [0xF1, 0x50];

function byteHex(value) {
    return ('0' + value.toString(16).toUpperCase()).slice(-2);
}

function bytes(value) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) {
        return Array.prototype.slice.call(value);
    }
    if (value && value.data) return bytes(value.data);
    return [];
}

function discoveryRequest() {
    // This function is the complete outbound UDS allowlist. It takes no input.
    return {
        sourceAddress: SOURCE,
        targetAddress: FUNCTIONAL,
        serviceID: SID,
        subroutineID: 0,
        udsDataLength: DID.length,
        udsData: Buffer.from(DID),
        deadlockTime: 0,
    };
}

function acceptedVerdict(result) {
    let value = result;
    if (result && typeof result === 'object') {
        if (result.TasuErrorEnum !== undefined) value = result.TasuErrorEnum;
        else if (result.errorCode !== undefined) value = result.errorCode;
        else return false;
    }
    return value === undefined || value === null || value === 0 || value === 1 ||
        value === '0' || value === '1' || value === 'NO_ERROR' || value === 'REQUEST_PENDING';
}

function ecuReply(event) {
    if (!event || (event.errorCode !== undefined && event.errorCode !== 0 &&
        event.errorCode !== 'NO_ERROR')) return null;
    const frame = bytes(event.udsResponse !== undefined ? event.udsResponse : event);
    if (frame.length < 15 || frame[2] === 0x7F) return null;
    const address = frame[6];
    if (!Number.isInteger(address) || address < 0 || address > 0xFE ||
        address === FUNCTIONAL || address === SOURCE) return null;
    if (frame[9] !== 0x62 || frame[10] !== DID[0] || frame[11] !== DID[1]) return null;
    return { address: address, sgbd: byteHex(frame[12]) + byteHex(frame[13]) + byteHex(frame[14]) };
}

function positiveMs(value, fallback) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

class ReadOnlyDiagnostics {
    constructor(signals, options) {
        this._signals = signals || require('./someip_signals').createSomeipSignals();
        this._options = options || {};
        this._proxy = null;
        this._initializing = null;
        this._scanning = null;
        this._active = null;
        this._closed = false;
        this._available = false;
    }

    async _init() {
        if (this._proxy) return;
        if (this._initializing) return this._initializing;
        const signals = this._signals;
        if (!signals || typeof signals.proxy !== 'function' ||
            typeof signals.on !== 'function' || typeof signals.call !== 'function') {
            throw new Error('TASU transport is not configured');
        }
        this._initializing = (async () => {
            const proxy = await signals.proxy(IFACE, INSTANCE);
            if (!proxy) throw new Error('TASU proxy unavailable');
            if (this._closed) {
                if (proxy && typeof proxy.shutdown === 'function') await proxy.shutdown();
                return;
            }
            this._proxy = proxy;
            try {
                // Subscribe before a request can leave: a fast ECU can answer during call().
                await signals.on(proxy, 'sendTasuResponse', (event) => this._onResponse(event));
                this._available = typeof proxy.isAvailable !== 'function' || !!proxy.isAvailable();
                if (typeof signals.onAvailable === 'function') {
                    await signals.onAvailable(proxy, (available) => {
                        if (!this._closed) this._available = !!available;
                    });
                }
            } catch (error) {
                this._proxy = null;
                this._available = false;
                if (typeof proxy.shutdown === 'function') await proxy.shutdown();
                throw error;
            }
        })();
        try { await this._initializing; }
        finally { this._initializing = null; }
    }

    _onResponse(event) {
        const active = this._active;
        if (!active || this._closed) return;
        if (event && event.errorCode !== undefined && event.errorCode !== 0 &&
            event.errorCode !== 'NO_ERROR') {
            active.finish('TASU response error');
            return;
        }
        const frame = bytes(event && (event.udsResponse !== undefined ? event.udsResponse : event));
        if (frame.length >= 5 && frame[2] === 0x7F) {
            active.finish('TASU transport rejected discovery');
            return;
        }
        const ecu = ecuReply(event);
        if (!ecu || active.ecus.has(ecu.address)) return;
        active.ecus.set(ecu.address, ecu.sgbd);
        clearTimeout(active.idleTimer);
        active.idleTimer = setTimeout(() => active.finish(null), active.idleMs);
    }

    /** Discover ECUs with one fixed, read-only functional request. */
    scan() {
        if (this._scanning) return this._scanning;
        if (this._closed) return Promise.resolve({ available: false, ecus: [], error: 'Diagnostics closed' });
        this._scanning = this._runScan().then(
            (result) => { this._scanning = null; return result; },
            (error) => { this._scanning = null; return { available: this._available, ecus: [], error: String(error.message || error) }; }
        );
        return this._scanning;
    }

    async _runScan() {
        try { await this._init(); }
        catch (error) { return { available: false, ecus: [], error: String(error.message || error) }; }
        if (this._closed) return { available: false, ecus: [], error: 'Diagnostics closed' };
        if (!this._available) return { available: false, ecus: [], error: 'TASU service unavailable' };

        const timeoutMs = positiveMs(this._options.timeoutMs, 15000);
        const idleMs = Math.min(positiveMs(this._options.idleMs, 3000), timeoutMs);
        const callTimeoutMs = positiveMs(this._options.callTimeoutMs, 8000);
        return new Promise((resolve) => {
            const active = {
                ecus: new Map(), idleMs: idleMs, idleTimer: null, hardTimer: null,
                finish: null,
            };
            let finished = false;
            active.finish = (error) => {
                if (finished) return;
                finished = true;
                clearTimeout(active.idleTimer);
                clearTimeout(active.hardTimer);
                if (this._active === active) this._active = null;
                const ecus = Array.from(active.ecus, ([address, sgbd]) => ({ address: address, sgbd: sgbd }))
                    .sort((a, b) => a.address - b.address);
                resolve({
                    available: !this._closed && this._available,
                    ecus: ecus,
                    error: error || (ecus.length ? null : 'No ECU identification responses'),
                });
            };
            this._active = active;
            active.hardTimer = setTimeout(() => active.finish('Discovery timed out'), timeoutMs);
            Promise.resolve().then(() => this._signals.call(
                this._proxy, 'sendTasuRequest', discoveryRequest(), callTimeoutMs
            )).then((verdict) => {
                if (!acceptedVerdict(verdict)) active.finish('TASU transport refused discovery');
            }, () => active.finish('TASU request failed'));
        });
    }

    /** Release the proxy and stop an in-flight scan. */
    async close() {
        if (this._closed) return;
        this._closed = true;
        this._available = false;
        if (this._active) this._active.finish('Diagnostics closed');
        const proxy = this._proxy;
        this._proxy = null;
        if (proxy && typeof proxy.shutdown === 'function') await proxy.shutdown();
    }
}

module.exports = { ReadOnlyDiagnostics, DiagnosticProbe: ReadOnlyDiagnostics };
