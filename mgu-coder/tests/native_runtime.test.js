'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { untar } = require('../tools/upstream/oap_link');
function mkdir(directory) {
    if (fs.existsSync(directory)) return;
    mkdir(path.dirname(directory));
    fs.mkdirSync(directory);
}
function removeTemporary(directory) {
    fs.readdirSync(directory).forEach(name => {
        const file = path.join(directory, name);
        if (fs.lstatSync(file).isDirectory()) removeTemporary(file);
        else fs.unlinkSync(file);
    });
    fs.rmdirSync(directory);
}

const archive = path.join(__dirname, '..', 'dist', 'publish', 'x3-coding',
    'marku_x3_coding@' + require('../package.json').version + '.tgz');

async function exerciseRuntime() {
    const originalCwd = process.cwd();
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-native-runtime-'));
    try {
        const appRoot = path.join(temporary, 'oap_test');
        const packageRoot = path.join(appRoot, 'source');
        for (const member of untar(fs.readFileSync(archive))) {
            assert(member.name.startsWith('package/'), 'expected flat npm package');
            const target = path.resolve(packageRoot, member.name.slice('package/'.length));
            assert(target.startsWith(packageRoot + path.sep), 'unsafe archive path');
            mkdir(path.dirname(target));
            fs.writeFileSync(target, member.data);
        }
        const jsRoot = path.join(packageRoot, 'javascript');
        const appFile = path.join(jsRoot, 'app.js');
        const kitFile = path.join(jsRoot, 'kit', 'mgu.js');
        assert(fs.existsSync(appFile) && fs.existsSync(kitFile),
            'the flat package must contain its entry and real App Kit runtime');
        fs.mkdirSync(path.join(appRoot, 'data'));
        mkdir(path.join(appRoot, 'rhmiData', 'resources'));
        fs.copyFileSync(path.join(packageRoot, 'rhmiData', 'application.json'),
            path.join(appRoot, 'rhmiData', 'application.json'));
        process.chdir(path.join(appRoot, 'data'));

        const description = JSON.parse(fs.readFileSync(path.join(packageRoot, 'rhmiData', 'application.json'), 'utf8'));
        const uiDescription = JSON.parse(fs.readFileSync(path.join(packageRoot,
            'rhmiData', 'uiDescriptions', 'ID7', 'uiDescription.json'), 'utf8'));
        const uuid = description.application.entryPoints[0].uuid;
        const events = [];
        const components = Object.create(null);
        const states = Object.create(null);
        const dynamicText = Object.create(null);
        let initialized = false;
        let opened;
        const didOpen = new Promise((resolve) => { opened = resolve; });
        for (const container of Object.values(uiDescription.containers)) {
            const state = Object.assign(new EventEmitter(), {
                name: container.name,
                getId: () => Number(container.id || 1),
                updateResources: () => { events.push('resources:' + container.name); return Promise.resolve(); },
            });
            states[container.name] = state;
            components[container.name] = state;
            for (const component of Object.values(container.components || {})) {
                components[component.name] = Object.assign(new EventEmitter(), {
                    setValue: (row, cell, value, type) => {
                        assert(Number.isInteger(row) && row >= 0);
                        assert.strictEqual(cell, 'Text');
                        assert(type === 'Text' || type === 'StringId');
                        dynamicText[component.name] = value;
                        return Promise.resolve();
                    },
                    setProperty: (property, value, type) => {
                        assert(property === 'Visible' || property === 'Enabled');
                        assert.strictEqual(type, 'UInt');
                        return Promise.resolve();
                    },
                    getStringBundle: () => ({ setStrings: (values) => {
                        assert(Object.keys(values).length > 0);
                        return Promise.resolve();
                    } }),
                });
            }
        }
        const mappings = Object.create(null);
        const rhmi = Object.assign(new EventEmitter(), {
            getByName: (name) => components[name] || null,
            mapEntryState: (entry, state) => {
                assert.strictEqual(entry, uuid);
                assert.strictEqual(state, states.MAIN);
                mappings[entry] = state;
                events.push('map');
                return Promise.resolve();
            },
            openEntryState: (entry) => {
                assert.strictEqual(mappings[entry], states.MAIN);
                assert(initialized, 'App Kit must notify OnlineApp before opening the entry');
                assert(events.includes('resources:MAIN'), 'MAIN resources must load before opening');
                assert(events.includes('resources:DETAIL'), 'DETAIL resources must load before opening');
                events.push('open');
                opened();
                return Promise.resolve();
            },
            openState: (name) => { assert(states[name]); events.push('open:' + name); return Promise.resolve(); },
            closeState: (name) => { assert(states[name]); events.push('close:' + name); return Promise.resolve(); },
        });
        class OnlineApp extends EventEmitter {
            constructor() {
                super();
                this.rhmiApplication = null;
                this.startReason = 'ENTRY_POINT';
                this.appDescription = description;
            }
            start() { events.push('start'); this.rhmiApplication = rhmi; return Promise.resolve(); }
            initialized() { initialized = true; events.push('initialized'); return Promise.resolve(); }
            registerActive() { events.push('active'); return Promise.resolve(); }
            registerInactive() { events.push('inactive'); return Promise.resolve(); }
            registerHmiVisible() { return Promise.resolve(); }
            unregisterHmiVisible() { return Promise.resolve(); }
            getLastExecutedEntryPointUuid() { return uuid; }
        }
        const sdkLog = { info() {}, warn() {}, error() {}, debug() {} };
        const original = Module._load;
        Module._load = function (request) {
            if (request === 'oap-sdk') return { OnlineApp, logging: { getSDKLogger: () => sdkLog } };
            return original.apply(this, arguments);
        };
        try {
            require(appFile);
            await Promise.race([didOpen, new Promise((_, reject) => setTimeout(
                () => reject(new Error('real App Kit runtime did not open the entry')), 1500))]);
            await new Promise((resolve) => setImmediate(resolve));
        } finally { Module._load = original; }

        assert(events.indexOf('start') < events.indexOf('map'));
        assert(events.indexOf('map') < events.indexOf('initialized'));
        assert(events.indexOf('resources:MAIN') < events.indexOf('initialized'));
        assert(events.indexOf('initialized') < events.indexOf('open'));
        assert(Object.prototype.hasOwnProperty.call(dynamicText, 'codingSlot1'),
            'the real runtime must render the first catalog entry');
        // The SDK stand-in deliberately never emits an "initialized" event.
        process.stdout.write(JSON.stringify({ events, rendered: Object.keys(dynamicText).length }) + '\n');
    } finally {
        process.chdir(originalCwd);
        const resolved = fs.realpathSync(temporary);
        const tempRoot = fs.realpathSync(os.tmpdir());
        assert(resolved.startsWith(tempRoot + path.sep) &&
            path.basename(resolved).startsWith('x3-native-runtime-'));
        removeTemporary(resolved);
    }
}

if (process.argv[2] === '--child') {
    exerciseRuntime().catch((error) => { console.error(error); process.exitCode = 1; });
} else {
    assert(fs.existsSync(archive), 'run the native package build before this test');
    const executable = process.env.MGU_NODE8 || process.execPath;
    const run = childProcess.spawnSync(executable, [__filename, '--child'], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    });
    assert.strictEqual(run.status, 0, run.stderr || String(run.error));
    const lines = run.stdout.trim().split(/\r?\n/);
    const evidence = JSON.parse(lines[lines.length - 1]);
    assert(evidence.events.includes('open'));
    assert(evidence.rendered > 0);
    console.log('native_runtime.test.js: OK (' + executable + ')');
}
