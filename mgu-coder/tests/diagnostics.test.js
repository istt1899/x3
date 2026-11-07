'use strict';

const assert = require('assert');
const { ReadOnlyDiagnostics, DiagnosticProbe, ERROR_CODES } = require('../native/apps/marku_x3_coding/diagnostics');
const { createSomeipSignals } = require('../native/apps/marku_x3_coding/someip_signals');

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
            if (options && options.proxyError) return Promise.reject(new Error(options.proxyError));
            return Promise.resolve(proxy);
        },
        on: (p, name, callback) => {
            assert.strictEqual(p, proxy);
            assert.strictEqual(name, 'sendTasuResponse');
            if (options && options.subscribeError) return Promise.reject(new Error(options.subscribeError));
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

function expected(available, error, technicalError, ecus) {
    return { available: available, ecus: ecus || [], error: error || null, technicalError: technicalError || null };
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
    assert.deepStrictEqual(result, expected(true, null, null,
        [{ address: 0x01, sgbd: '0F2040' }, { address: 0x12, sgbd: '0F26E8' }]));
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

async function setupAndAvailabilityFailures() {
    const missing = new ReadOnlyDiagnostics({});
    assert.deepStrictEqual(await missing.scan(), expected(false, ERROR_CODES.TRANSPORT_SETUP_FAILED,
        'TASU transport is not configured'));
    await missing.close();

    const failedProxy = fake({ proxyError: 'native proxy secret' });
    const proxyProbe = new ReadOnlyDiagnostics(failedProxy.signals);
    assert.deepStrictEqual(await proxyProbe.scan(), expected(false, ERROR_CODES.TRANSPORT_SETUP_FAILED,
        'native proxy secret'));
    assert.strictEqual(failedProxy.state.calls.length, 0);
    await proxyProbe.close();

    const failedSubscription = fake({ subscribeError: 'native subscribe secret' });
    const subscriptionProbe = new ReadOnlyDiagnostics(failedSubscription.signals);
    assert.deepStrictEqual(await subscriptionProbe.scan(), expected(false, ERROR_CODES.RESPONSE_SUBSCRIBE_FAILED,
        'native subscribe secret'));
    assert.strictEqual(failedSubscription.state.shutdowns, 1);
    assert.strictEqual(failedSubscription.state.calls.length, 0);
    await subscriptionProbe.close();

    const unavailable = fake({ available: false });
    const a = new ReadOnlyDiagnostics(unavailable.signals);
    assert.deepStrictEqual(await a.scan(), expected(false, ERROR_CODES.SERVICE_UNAVAILABLE));
    assert.strictEqual(unavailable.state.calls.length, 0);
    await a.close();
}

async function emptyAndTimeout() {
    const empty = fake();
    const a = new ReadOnlyDiagnostics(empty.signals, { timeoutMs: 25, idleMs: 5 });
    assert.deepStrictEqual(await a.scan(), expected(true, ERROR_CODES.SCAN_EMPTY));
    assert.strictEqual(empty.state.calls.length, 1);
    await a.close();

    const silent = fake();
    silent.signals.call = () => new Promise(() => {});
    const b = new ReadOnlyDiagnostics(silent.signals, { timeoutMs: 25, idleMs: 5 });
    assert.deepStrictEqual(await b.scan(), expected(true, ERROR_CODES.SCAN_TIMEOUT));
    await b.close();

    const pending = fake({ onCall: () => Promise.resolve({ TasuErrorEnum: 'REQUEST_PENDING' }) });
    const c = new ReadOnlyDiagnostics(pending.signals, { timeoutMs: 25, idleMs: 5 });
    assert.deepStrictEqual(await c.scan(), expected(true, ERROR_CODES.SCAN_TIMEOUT));
    await c.close();

    // Upstream accepts numeric 1/"1" as transport verdicts, but their exact
    // meaning is not established here. Neither confirms a completed request.
    for (const verdict of [1, '1', { TasuErrorEnum: 1 }, { errorCode: '1' },
        { errorCode: 'REQUEST_PENDING' }, undefined]) {
        const setup = fake({ onCall: () => Promise.resolve(verdict) });
        const probe = new ReadOnlyDiagnostics(setup.signals, { timeoutMs: 25, idleMs: 5 });
        assert.deepStrictEqual(await probe.scan(), expected(true, ERROR_CODES.SCAN_TIMEOUT));
        assert.strictEqual(setup.state.calls.length, 1);
        await probe.close();
    }

    for (const verdict of [0, '0', { errorCode: 0 }, { errorCode: 'NO_ERROR' }]) {
        const setup = fake({ onCall: () => Promise.resolve(verdict) });
        const probe = new ReadOnlyDiagnostics(setup.signals, { timeoutMs: 25, idleMs: 5 });
        assert.deepStrictEqual(await probe.scan(), expected(true, ERROR_CODES.SCAN_EMPTY));
        await probe.close();
    }
}

async function rejectionFailures() {
    const responseError = fake({ onCall: (state) => {
        state.response({ errorCode: 'SECRET_TASU_STATUS', udsResponse: Buffer.alloc(0) });
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    } });
    const a = new ReadOnlyDiagnostics(responseError.signals);
    assert.deepStrictEqual(await a.scan(), expected(true, ERROR_CODES.RESPONSE_ERROR, 'SECRET_TASU_STATUS'));
    await a.close();

    const transportReject = fake({ onCall: (state) => {
        state.response({ udsResponse: Buffer.from([0, 0, 0x7F, 0, 0x31]) });
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    } });
    const b = new ReadOnlyDiagnostics(transportReject.signals);
    assert.deepStrictEqual(await b.scan(), expected(true, ERROR_CODES.TRANSPORT_REJECTED, 'TASU reject 31'));
    await b.close();

    const rejected = fake({ onCall: () => Promise.resolve({ TasuErrorEnum: 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED' }) });
    const c = new ReadOnlyDiagnostics(rejected.signals, { timeoutMs: 100 });
    assert.deepStrictEqual(await c.scan(), expected(true, ERROR_CODES.REQUEST_REFUSED,
        'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED'));
    await c.close();

    const errorCodeRefused = fake({ onCall: () => Promise.resolve({ errorCode: 'NATIVE_REFUSAL' }) });
    const errorCodeProbe = new ReadOnlyDiagnostics(errorCodeRefused.signals);
    assert.deepStrictEqual(await errorCodeProbe.scan(), expected(true, ERROR_CODES.REQUEST_REFUSED,
        'NATIVE_REFUSAL'));
    await errorCodeProbe.close();

    const failed = fake({ onCall: () => Promise.reject(new Error('native send secret')) });
    const d = new ReadOnlyDiagnostics(failed.signals);
    assert.deepStrictEqual(await d.scan(), expected(true, ERROR_CODES.REQUEST_FAILED, 'native send secret'));
    await d.close();

    const unknown = new ReadOnlyDiagnostics(fake().signals);
    unknown._runScan = () => Promise.reject(new Error('unknown vehicle identifier secret'));
    assert.deepStrictEqual(await unknown.scan(), expected(false, ERROR_CODES.UNKNOWN_ERROR,
        'unknown vehicle identifier secret'));
    await unknown.close();
}

async function closed() {
    const pending = fake({ onCall: () => new Promise(() => {}) });
    const b = new ReadOnlyDiagnostics(pending.signals, { timeoutMs: 100 });
    const scan = b.scan();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await b.close();
    assert.deepStrictEqual(await scan, expected(false, ERROR_CODES.SCAN_CLOSED));
    assert.strictEqual(pending.state.shutdowns, 1);
    assert.deepStrictEqual(await b.scan(), expected(false, ERROR_CODES.SCAN_CLOSED));

    const beforeSend = fake();
    const probe = new ReadOnlyDiagnostics(beforeSend.signals, { timeoutMs: 100 });
    let current = null;
    Object.defineProperty(probe, '_active', {
        configurable: true,
        get: () => current,
        set: (value) => {
            current = value;
            // This queues close() after active exists and before the queued
            // Promise.then that would otherwise call the native transport.
            if (value) Promise.resolve().then(() => probe.close());
        },
    });
    assert.deepStrictEqual(await probe.scan(), expected(false, ERROR_CODES.SCAN_CLOSED));
    assert.strictEqual(beforeSend.state.calls.length, 0, 'no request after close before deferred send');
    assert.strictEqual(beforeSend.state.shutdowns, 1);
}

async function refusedAndClosed() {
    // Kept as a named regression boundary for older test runners.
    await rejectionFailures();
    await closed();
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

async function nativeQueuedSendCancelledOnClose() {
    let sends = 0;
    let shutdowns = 0;
    const proxy = {
        init: () => Promise.resolve(),
        isAvailable: () => true,
        subscribe: () => Promise.resolve(),
        subscribeToAvailability: (callback) => { callback(true); return Promise.resolve(); },
        callMethod: () => { sends++; return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' }); },
        shutdown: () => { shutdowns++; return Promise.resolve(); },
    };
    const signals = createSomeipSignals({
        someip: { buildProxy: () => Promise.resolve(proxy) },
        config: { test: true },
    });
    const nativeCall = signals.call.bind(signals);
    let closePromise;
    let probe;
    signals.call = (...args) => {
        const queued = nativeCall(...args);
        // The transport has queued its setImmediate send. Close in a microtask
        // after that queueing but before native callMethod can run.
        closePromise = Promise.resolve().then(() => probe.close());
        return queued;
    };
    probe = new ReadOnlyDiagnostics(signals, { timeoutMs: 100 });
    assert.deepStrictEqual(await probe.scan(), expected(false, ERROR_CODES.SCAN_CLOSED));
    assert(closePromise, 'the native send must have been queued');
    await closePromise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(shutdowns, 1);
    assert.strictEqual(sends, 0, 'queued native send must be cancelled before close completes');
}

async function main() {
    await successAndAllowlist();
    await setupAndAvailabilityFailures();
    await emptyAndTimeout();
    await refusedAndClosed();
    await nativeSomeipAdapter();
    await nativeQueuedSendCancelledOnClose();
    process.stdout.write('diagnostics.test.js: OK\n');
}

main().catch((error) => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
