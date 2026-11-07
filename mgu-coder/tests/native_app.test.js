'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const appDir = path.join(__dirname, '..', 'native', 'apps', 'marku_x3_coding');
const mainFile = path.join(appDir, 'main.js');
const spec = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'));
const { FEATURES } = require(path.join(appDir, 'catalog.js'));
const diagnostics = require(path.join(appDir, 'diagnostics.js'));
const names = new Set();
spec.screens.forEach((screen) => screen.items.forEach((item) => names.add(item[1])));

let scanCalls = 0;
let closeCalls = 0;
let resolveScan;
class FakeProbe {
    scan() {
        scanCalls++;
        return new Promise((resolve) => { resolveScan = resolve; });
    }
    close() { closeCalls++; return Promise.resolve(); }
}

function loadStartCallback() {
    let implementation;
    const original = Module._load;
    Module._load = function (request, parent, isMain) {
        if (parent && parent.filename === mainFile && request === './kit/mgu') {
            return { run: (value) => { implementation = value; return Promise.resolve(); } };
        }
        if (parent && parent.filename === mainFile && request === './diagnostics.js') {
            return Object.assign({}, diagnostics, { DiagnosticProbe: FakeProbe });
        }
        return original.apply(this, arguments);
    };
    try { require(mainFile); }
    finally { Module._load = original; }
    assert(implementation && typeof implementation.start === 'function',
        'the native entry must provide an App Kit start callback');
    return implementation.start;
}

async function main() {
    const start = loadStartCallback();
    const app = new EventEmitter();
    const handlers = Object.create(null);
    const text = Object.create(null);
    const visible = Object.create(null);
    const enabled = Object.create(null);
    const transitions = [];
    const warnings = [];
    const ui = {
        onClick: (name, callback) => {
            assert(names.has(name), 'unknown click component ' + name);
            handlers[name] = callback;
        },
        text: (name, value) => {
            assert(names.has(name), 'unknown text component ' + name);
            text[name] = value;
            return Promise.resolve();
        },
        visible: (name, value) => {
            assert(names.has(name), 'unknown visibility component ' + name);
            visible[name] = value;
            return Promise.resolve();
        },
        enabled: (name, value) => {
            assert(names.has(name), 'unknown enabled component ' + name);
            enabled[name] = value;
            return Promise.resolve();
        },
        open: (state) => {
            assert(spec.screens.some((screen) => screen.name === state));
            transitions.push('open:' + state);
            return Promise.resolve();
        },
        close: (state) => {
            assert(spec.screens.some((screen) => screen.name === state));
            transitions.push('close:' + state);
            return Promise.resolve();
        },
    };
    const click = (name) => {
        assert.strictEqual(typeof handlers[name], 'function', 'missing handler for ' + name);
        // Ui.onClick in the real kit invokes the callback in a microtask.
        return Promise.resolve().then(() => handlers[name]({}));
    };

    await start({ app, ui, log: { warn: (message) => warnings.push(message) } });
    assert.strictEqual(scanCalls, 0, 'startup must not touch the diagnostic transport');
    assert.strictEqual(text.codingPage, 'Функции 1–5 из 10');
    assert.strictEqual(visible.codingNext, true);
    assert.strictEqual(visible.codingPrev, false);
    assert.strictEqual(enabled.codingScan, true);
    assert.strictEqual(text.codingSlot1.indexOf(FEATURES[0].title), 0);

    const firstScan = click('codingScan');
    const duplicateScan = click('codingScan');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(scanCalls, 1, 'two taps during a scan must send one discovery request');
    assert.strictEqual(enabled.codingScan, false);
    resolveScan({ available: true, ecus: [{ address: FEATURES[5].address, sgbd: '0F26E8' }],
        error: null, technicalError: null });
    await Promise.all([firstScan, duplicateScan]);
    assert.strictEqual(enabled.codingScan, true);
    assert(text.codingStatus.includes('ответили 1 адресов'));

    await click('codingNext');
    assert.strictEqual(text.codingPage, 'Функции 6–10 из 10');
    assert.strictEqual(visible.codingPrev, true);
    assert.strictEqual(visible.codingNext, false);
    assert.strictEqual(text.codingSlot1.indexOf(FEATURES[5].title), 0);

    await click('codingSlot1');
    assert.strictEqual(transitions[transitions.length - 1], 'open:DETAIL');
    assert.strictEqual(text.detailTitle, FEATURES[5].title);
    assert(text.detailEcu.includes(FEATURES[5].ecu));
    assert(text.detailStatus.includes('ответил; кодировка не прочитана'));
    assert.strictEqual(visible.codingBack, true);
    assert.strictEqual(visible.codingSlot1, false);

    await click('codingBack');
    assert.strictEqual(transitions[transitions.length - 1], 'close:DETAIL',
        'return from detail must pop its state, not push another MAIN');
    assert.strictEqual(text.codingPage, 'Функции 6–10 из 10');
    await click('codingPrev');
    assert.strictEqual(text.codingPage, 'Функции 1–5 из 10');

    app.emit('shutdown');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(closeCalls, 1, 'shutdown must release the diagnostic proxy');
    assert.deepStrictEqual(warnings, []);
    console.log('native_app.test.js: OK');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
