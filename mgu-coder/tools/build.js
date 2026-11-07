// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

// Host-only source package + MGU Store USB catalog. No car connection here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { packSource, readManifest } = require('./upstream/oap_link');
const prepare = require('./prepare');
const { writePublishCatalog } = require('./catalog');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'marku_x3_coding');
const PUBLISH = path.join(ROOT, 'dist', 'publish', 'x3-coding');
const USB = path.resolve(ROOT, '..', 'output', 'x3-coding-usb');
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

function main() {
  prepare.main();
  const manifest = readManifest(APP);
  if (manifest.id !== 'marku_x3_coding' || manifest.version !== require('../package.json').version) {
    throw new Error('unexpected app identity');
  }
  fs.mkdirSync(PUBLISH, { recursive: true });
  fs.mkdirSync(USB, { recursive: true });
  const filename = manifest.id + '@' + manifest.version + '.tgz';
  const target = path.join(PUBLISH, filename);
  const members = packSource(APP, target);
  if (members.some((name) => /(?:^|\/)(?:oap-sdk|node_modules)(?:\/|$)|javascript\/app\.js$/.test(name))) {
    throw new Error('source package contains linked BMW SDK or built app');
  }
  const artifact = fs.readFileSync(target);
  const release = JSON.parse(fs.readFileSync(path.join(APP, 'release.json'), 'utf8'));
  const catalog = {
    schema: 2,
    components: [{ id: manifest.id, kind: 'app', version: manifest.version,
      title: 'Кодировки X3',
      description: 'Каталог 10 функций G01 и чтение доступных блоков; запись кодировок отключена',
      build: 'unit', requires: release.requires, uninstallable: true, mguHmi: ['ID7'],
      artifact: { name: filename, size: artifact.length, sha256: sha(artifact), url: filename } }]
  };
  fs.writeFileSync(path.join(PUBLISH, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  const published = writePublishCatalog();
  cp.execFileSync(process.execPath, [path.join(__dirname, 'upstream', 'mgu-install.js'),
    'usb-repo', USB, PUBLISH], { stdio: 'inherit', windowsHide: true });
  console.log('Source package: ' + target);
  console.log('MGU Store USB directory: ' + USB);
  console.log('GitHub catalog: ' + published.output + ' sha256=' + published.sha256);
}

try { main(); } catch (err) { console.error('build: ' + err.message); process.exitCode = 1; }
