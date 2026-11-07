'use strict';
// Fatal faults must trigger systemd Restart=on-failure; operator stops must not.
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function scenario(event, closeFails) {
    let closed = 0, exited = null;
    const processFixture = new EventEmitter();
    processFixture.execPath = process.execPath;
    processFixture.exit = (code) => { exited = code; };
    const gateway = { start: () => Promise.resolve(), close: () => {
        closed++;
        return closeFails ? Promise.reject(new Error('shutdown failed')) : Promise.resolve();
    } };
    const providers = {
        Gateway: function () { return gateway; },
        DaemonPlayer: function () { this.engine = { uid: () => 12345, opts: {} }; },
        createYouTubeProvider: () => ({ id: 'youtube', context: {}, daemon: {}, networkChanged() {} })
    };
    const sandbox = { module: { exports: {} }, __dirname,
        process: processFixture, console: { error() {} },
        require: (name) => name === './gateway' ? providers : name === './python_provider'
            ? { PythonProvider: function () {} } : name === './network_access'
            ? { NetworkAccess: function () { this.cache = (p) => p; } } : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), sandbox);
    await sandbox.module.exports.main();
    processFixture.emit(event, new Error('synthetic fault'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(closed, 1);
    assert.strictEqual(exited, event === 'SIGTERM' || event === 'SIGINT' ? (closeFails ? 1 : 0) : 1);
}
(async () => {
    await scenario('SIGTERM', false);
    await scenario('SIGINT', false);
    await scenario('uncaughtException', false);
    await scenario('unhandledRejection', false);
    await scenario('SIGTERM', true);
    console.log('ok: operator stop is clean; fatal faults and failed shutdown restart the service');
})().catch((error) => { console.error(error); process.exit(1); });
