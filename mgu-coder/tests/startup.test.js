'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EventEmitter = require('events');
const appRoot = path.join(__dirname, '..', 'apps', 'marku_x3_coding');
const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'mgu-app.json'), 'utf8'));
const description = JSON.parse(fs.readFileSync(path.join(appRoot, manifest.tree, 'rhmiData', 'application.json'), 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(appRoot, manifest.tree, 'config', 'base.json'), 'utf8'));
// Reproduce SDK donors that disable conditional RHMI/entry-point loading.
const sdkConfig = Object.assign({ rhmiLoadingEnabled: false, entryPointLoadingEnabled: false }, config);
const calls = [], warnings = [];
let app;
let openCount = 0;
class OnlineApp extends EventEmitter {
  constructor() {
    super();
    this.appDescription = description;
    const state = new EventEmitter();
    state.updateResources = () => Promise.resolve();
    const component = () => Object.assign(new EventEmitter(), {
      // Model a synchronous SDK rendering failure and a component without
      // setEnabled: neither may prevent registering the launcher tile.
      setValue: () => { throw new Error('render failure fixture'); },
      setProperty: (name) => { calls.push(name); return Promise.resolve(); }
    });
    this.rhmiApplication = Object.assign(new EventEmitter(), {
      getByName: name => name === 'ST_OnlineApps_MarkuX3Coding' ? state : component(),
      mapEntryState: () => { calls.push('map'); return Promise.resolve(); },
      openEntryState: () => {
        openCount++;
        return openCount <= 2 ? Promise.reject(new Error('INVALID_UUID')) : Promise.resolve();
      }
    });
    if (!sdkConfig.rhmiLoadingEnabled) this.rhmiApplication = null;
  }
  start() { app = this; return Promise.resolve(); }
  initialized() { calls.push('initialized'); return Promise.resolve(); }
  registerActive() { calls.push('active'); return Promise.resolve(); }
  getEntryPoints() {
    if (!sdkConfig.entryPointLoadingEnabled) return [];
    return [{ getDescription: () => description.application.entryPoints[0],
      init: () => { calls.push('entry-init'); return Promise.resolve(); },
      entryPoint: { setText: () => Promise.resolve(), setIcon: () => Promise.resolve() },
      setAvailability: value => { calls.push(value); return Promise.resolve(); } }];
  }
}
const logger = { warn: message => warnings.push(message), error: message => { throw new Error(message); } };
vm.runInNewContext(fs.readFileSync(path.join(appRoot, 'src', 'coding_app.js'), 'utf8'), {
  require: name => {
    if (name === 'oap-sdk/src/core/OnlineApp.js') return OnlineApp;
    if (name === 'oap-sdk/src/logging/logging') return { getSDKLogger: () => logger };
    if (name === './diagnostics.js') return { DiagnosticProbe: class {} };
    return require(path.join(appRoot, 'src', name));
  }, process, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30)), clearTimeout
});
const uuid = description.application.entryPoints[0].uuid;
app.emit('entryPointExecute', uuid);
assert.strictEqual(openCount, 0, 'an early tile tap must wait for initialization');
app.appInitialized().then(() => new Promise(resolve => setImmediate(resolve))).then(() => {
  assert.strictEqual(openCount, 3, 'early tap must be replayed and transient INVALID_UUID retried');
  assert(calls.includes('ENABLED'), 'startup must register and enable the tile despite render errors');
  assert(calls.indexOf('ENABLED') < calls.indexOf('initialized'));
  assert(calls.includes('Enabled'), 'components without setEnabled must use the property API');
  assert(warnings.some(message => message.includes('render failure fixture')));
  assert.strictEqual(description.application.entryPoints.length, 1);
  assert.strictEqual(description.application.entryPoints[0].insertionStateId, 20974,
    'use the same installed-app menu anchor as working VK/RUTUBE');
  assert.strictEqual(description.application.entryPoints[0].private, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(appRoot, manifest.tree,
    'rhmiData', 'variantGroups', 'Common', 'texts', 'ru_RU.json'), 'utf8'))
    .SID_MARKU_X3_CODING_TITLE, 'Bimmer Code');
  return Promise.all([app.openEntry(uuid), app.openEntry(uuid)]);
}).then(() => {
  assert.strictEqual(openCount, 4, 'duplicate taps must share one opening request');
  const foreground = new app.constructor();
  foreground.startReason = 'ENTRY_POINT';
  return foreground.appInitialized();
}).then(() => {
  assert.strictEqual(openCount, 5, 'cold tile launch must open its entry even if the SDK has no last UUID');
  console.log('startup.test.js: OK');
}).catch(error => { console.error(error); process.exitCode = 1; });
