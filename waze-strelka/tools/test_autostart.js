'use strict';
// 0.8.6 autostart: the app package must declare mguAppStartType autostart so
// mgu-deploy lists it with -appStartType autostart; the BMW GPS bridge then
// starts at the head-unit boot without opening the app. Versions must agree.
const assert = require('assert'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const appDir = path.join(ROOT, 'apps', 'marku_kaluga_cameras');
const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'mgu-app.json'), 'utf8'));
assert.strictEqual(manifest.version, '0.8.7');
assert.strictEqual(manifest.tree, 'marku_kaluga_cameras@0.8.7');
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, manifest.tree, 'package.json'), 'utf8'));
assert.strictEqual(pkg.version, '0.8.7');
assert.strictEqual(pkg.mguAppStartType, 'autostart', 'The app must start at the head-unit boot for the GPS bridge');
const release = JSON.parse(fs.readFileSync(path.join(appDir, 'release.json'), 'utf8'));
assert.strictEqual(release.requires['marku-kaluga-cameras'], '0.8.7');
const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.strictEqual(root.version, '0.8.7');
const component = JSON.parse(fs.readFileSync(path.join(ROOT, 'native', 'marku-kaluga-cameras', 'component.json'), 'utf8'));
assert.strictEqual(component.version, '0.8.7');
const service = fs.readFileSync(path.join(ROOT, 'native', 'marku-kaluga-cameras', 'files', 'marku-kaluga-cameras.js'), 'utf8');
assert(/serviceVersion: '0\.8\.7'/.test(service), 'serviceVersion must be 0.8.7');
// The deploy tool accepts only these values; keep the declaration loadable.
const deploy = fs.readFileSync(path.join(ROOT, 'tools', 'upstream', 'mgu-deploy.js'), 'utf8');
assert(/var START_TYPES = \['autostart', 'lum', 'manually'\];/.test(deploy), 'upstream START_TYPES unchanged');
// Old released trees keep their history untouched; autostart arrived in 0.8.6.
for (const v of ['0.8.2', '0.8.3', '0.8.4', '0.8.5']) {
    const old = JSON.parse(fs.readFileSync(path.join(appDir, 'marku_kaluga_cameras@' + v, 'package.json'), 'utf8'));
    assert.strictEqual(old.version, v);
    assert.strictEqual(old.mguAppStartType, undefined, 'Released trees are immutable');
}
for (const v of ['0.8.6', '0.8.7']) {
    const rel = JSON.parse(fs.readFileSync(path.join(appDir, 'marku_kaluga_cameras@' + v, 'package.json'), 'utf8'));
    assert.strictEqual(rel.version, v);
    assert.strictEqual(rel.mguAppStartType, 'autostart', v + ' ships autostart');
}
console.log('PASS autostart 0.8.7: mguAppStartType autostart declared, versions agree across app/service/catalog, deploy accepts the value, old trees untouched');
