'use strict';

const assert = require('assert');
const { ReadOnlyDiagnostics, DiagnosticProbe } = require('../apps/marku_x3_coding/src/diagnostics');
const { createSomeipSignals } = require('../apps/marku_x3_coding/src/someip_signals');

const IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const INSTANCE = 'SystemFunctionsInternalTasuInst1';

function frame(address, uds) {
    return { errorCode: 'NO_ERROR', udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, address, 0, 0].concat(uds)) };
}

function fake(options) {
    const state = { calls: [], subscribed: false, shutdowns: 0, response: null };
    const proxy = {
        isAvailable: () => options && options.available === false ? false : true,
        shutdown: () => { state.shutdowns++; return Promise.resolve(); },
    };
    const signals = {
        proxy: (iface, instance) => {
            assert.strictEqual(iface, IFACE);
            assert.strictEqual(instance, INSTANCE);
            return Promise.resolve(proxy);
        },
        on: (p, name, callback) => {
            assert.strictEqual(p, proxy);
            assert.strictEqual(name, 'sendTasuResponse');
            state.subscribed = true;
            state.response = callback;
            return Promise.resolve();
        },
        onAvailable: (p, callback) => {
            assert.strictEqual(p, proxy);
            callback(!(options && options.available === false));
            return Promise.resolve();
        },
        call: (p, method, request, timeout) => {
            assert.strictEqual(p, proxy);
            assert.strictEqual(method, 'sendTasuRequest');
            assert.strictEqual(state.subscribed, true, 'response subscription must precede send');
            assert(timeout > 0);
            state.calls.push(request);
            if (options && options.onCall) return options.onCall(state);
            return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
        },
    };
    return { signals, state };
}

async function successAndAllowlist() {
    const setup = fake({
        onCall: (state) => {
            // Synchronous responses prove that subscription was installed first.
            state.response(frame(0x12, [0x62, 0xF1, 0x50, 0x0F, 0x26, 0xE8]));
            state.response(frame(0x01, [0x62, 0xF1, 0x50, 0x0F, 0x20, 0x40]));
            state.response(frame(0x12, [0x62, 0xF1, 0x50, 0xAA, 0xAA, 0xAA])); // duplicate
            state.response(frame(0x10, [0x62, 0xF1, 0x90, 0x00, 0x00, 0x00])); // other DID
            state.response(frame(0x11, [0x59, 0x02, 0x00, 0x00, 0x00]));       // other SID
            state.response(frame(0xDF, [0x62, 0xF1, 0x50, 0x00, 0x00, 0x00])); // functional address
            state.response(frame(0xF2, [0x62, 0xF1, 0x50, 0x00, 0x00, 0x00])); // tester address
            state.response(frame(0x13, [0x7F, 0x22, 0x78]));                  // pending
            state.response(frame(0x14, [0x62, 0xF1, 0x50, 0x0F]));             // short
            return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
        },
    });
    const diagnostics = new ReadOnlyDiagnostics(setup.signals, { idleMs: 5, timeoutMs: 100 });
    const result = await diagnostics.scan();
    assert.deepStrictEqual(result, {
        available: true,
        ecus: [{ address: 0x01, sgbd: '0F2040' }, { address: 0x12, sgbd: '0F26E8' }],
        error: null,
    });
    assert.strictEqual(setup.state.calls.length, 1);
    const request = setup.state.calls[0];
    assert.deepStrictEqual(Object.keys(request).sort(), [
        'deadlockTime', 'serviceID', 'sourceAddress', 'subroutineID',
        'targetAddress', 'udsData', 'udsDataLength',
    ].sort());
    assert.strictEqual(request.sourceAddress, 0xF2);
    assert.strictEqual(request.targetAddress, 0xDF);
    assert.strictEqual(request.serviceID, 0x22);
    assert.strictEqual(request.subroutineID, 0);
    assert.strictEqual(request.udsDataLength, 2);
    assert.deepStrictEqual(Array.from(request.udsData), [0xF1, 0x50]);
    assert.strictEqual(request.deadlockTime, 0);
    assert.strictEqual(typeof diagnostics.send, 'undefined');
    assert.strictEqual(typeof diagnostics.request, 'undefined');
    await diagnostics.close();
    assert.strictEqual(setup.state.shutdowns, 1);
}

async function unavailableAndTimeout() {
    const unavailable = fake({ available: false });
    const a = new ReadOnlyDiagnostics(unavailable.signals);
    assert.deepStrictEqual(await a.scan(), { available: false, ecus: [], error: 'TASU service unavailable' });
    assert.strictEqual(unavailable.state.calls.length, 0);
    await a.close();

    const silent = fake();
    const b = new ReadOnlyDiagnostics(silent.signals, { timeoutMs: 12, idleMs: 5 });
    assert.deepStrictEqual(await b.scan(), { available: true, ecus: [], error: 'Discovery timed out' });
    assert.strictEqual(silent.state.calls.length, 1);
    await b.close();
}

async function refusedAndClosed() {
    const rejected = fake({ onCall: () => Promise.resolve({ TasuErrorEnum: 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED' }) });
    const a = new ReadOnlyDiagnostics(rejected.signals, { timeoutMs: 100 });
    assert.deepStrictEqual(await a.scan(), { available: true, ecus: [], error: 'TASU transport refused discovery' });
    await a.close();

    const pending = fake({ onCall: () => new Promise(() => {}) });
    const b = new ReadOnlyDiagnostics(pending.signals, { timeoutMs: 100 });
    const scan = b.scan();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await b.close();
    assert.deepStrictEqual(await scan, { available: false, ecus: [], error: 'Diagnostics closed' });
    assert.strictEqual(pending.state.shutdowns, 1);
    assert.deepStrictEqual(await b.scan(), { available: false, ecus: [], error: 'Diagnostics closed' });
}

async function nativeSomeipAdapter() {
    const calls = [];
    const proxy = {
        init: () => { calls.push('init'); return Promise.resolve(); },
        isAvailable: () => true,
        subscribeToAvailability: (callback) => { callback(true); calls.push('availability'); return Promise.resolve(); },
        subscribe: (entry) => { calls.push(entry.name); return Promise.resolve(); },
        callMethod: (method, request, timeoutMs) => {
            calls.push(method);
            assert.strictEqual(request.serviceID, 0x22);
            assert.strictEqual(request.targetAddress, 0xDF);
            assert.deepStrictEqual(Array.from(request.udsData), [0xF1, 0x50]);
            assert.strictEqual(timeoutMs, 8000);
            return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
        },
        shutdown: () => Promise.resolve(),
    };
    const native = { buildProxy: (config, instance) => {
        calls.push('build');
        assert.deepStrictEqual(config, { test: true });
        assert.strictEqual(instance, INSTANCE);
        return Promise.resolve(proxy);
    } };
    const signals = createSomeipSignals({ someip: native, config: { test: true } });
    const built = await signals.proxy(IFACE, INSTANCE);
    assert.strictEqual(built, proxy);
    await signals.on(built, 'sendTasuResponse', () => {});
    let available = false;
    await signals.onAvailable(built, (value) => { available = value; });
    assert.strictEqual(available, true);
    const request = {
        sourceAddress: 0xF2, targetAddress: 0xDF, serviceID: 0x22,
        subroutineID: 0, udsDataLength: 2, udsData: Buffer.from([0xF1, 0x50]), deadlockTime: 0,
    };
    await signals.call(built, 'sendTasuRequest', request, 8000);
    assert.deepStrictEqual(calls, ['build', 'init', 'sendTasuResponse', 'availability', 'sendTasuRequest']);
    request.serviceID = 0x2E;
    let blocked = false;
    try { await signals.call(built, 'sendTasuRequest', request); }
    catch (error) { blocked = /Only read-only UDS/.test(error.message); }
    assert.strictEqual(blocked, true);
    assert.strictEqual(calls.length, 5, 'unsafe request must never reach native SOME/IP');
    assert.strictEqual(typeof new DiagnosticProbe().scan, 'function');
}

async function main() {
    await successAndAllowlist();
    await unavailableAndTimeout();
    await refusedAndClosed();
    await nativeSomeipAdapter();
    process.stdout.write('diagnostics.test.js: OK\n');
}

main().catch((error) => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
