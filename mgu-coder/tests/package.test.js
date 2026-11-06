'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readManifest } = require('../tools/upstream/oap_link');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'marku_x3_coding');
const TREE = path.join(APP, 'marku_x3_coding@0.1.0');
const PUB = path.join(ROOT, 'dist', 'publish', 'x3-coding');
const m = readManifest(APP);
assert.strictEqual(m.id, 'marku_x3_coding');
assert(m.modules.includes('src/diagnostics.js'));
assert(m.modules.includes('src/someip_signals.js'));

const manifest = JSON.parse(fs.readFileSync(path.join(TREE, 'manifest.json'), 'utf8'));
const tasu = manifest.proxies['com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu'];
assert.deepStrictEqual(tasu.methods, ['sendTasuRequest']);
assert.deepStrictEqual(tasu.broadcasts, ['sendTasuResponse']);
assert.strictEqual(tasu.instances, 'SystemFunctionsInternalTasuInst1');

const ui = JSON.parse(fs.readFileSync(path.join(TREE, 'rhmiData', 'uiDescriptions', 'ID7', 'uiDescription.json'), 'utf8'));
const names = Object.values(ui.containers['1'].components).map((component) => component.name);
for (const name of ['codingTitle', 'codingScan', 'codingSlot1', 'codingSlot5',
  'codingPrev', 'codingNext', 'codingBack', 'detailStatus']) assert(names.includes(name));
assert(fs.statSync(path.join(TREE, 'rhmiData', 'variantGroups', 'Common', 'images', 'x3_coding.png')).size > 500);

const catalog = JSON.parse(fs.readFileSync(path.join(PUB, 'catalog.json'), 'utf8'));
const entry = catalog.components[0];
assert.strictEqual(entry.id, m.id);
assert(/запись кодировок отключена/.test(entry.description));
const artifact = fs.readFileSync(path.join(PUB, entry.artifact.name));
assert.strictEqual(entry.artifact.size, artifact.length);
assert.strictEqual(entry.artifact.sha256, crypto.createHash('sha256').update(artifact).digest('hex'));

console.log('package.test.js: OK');
