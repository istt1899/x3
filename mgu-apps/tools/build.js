// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { writePublishCatalog } = require('./catalog.js');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const PUBLISH = path.join(ROOT, 'dist', 'publish', 'mgu-five-apps');
const MGU_STORE = process.env.MGU_STORE || path.join(REPO, '..', 'sources', 'mgu-store');

function run(command, args, options = {}) {
  cp.execFileSync(command, args, { stdio: 'inherit', windowsHide: true, cwd: ROOT, ...options });
}

function main() {
  fs.mkdirSync(PUBLISH, { recursive: true });
  run(process.env.PYTHON || 'python', [path.join(__dirname, 'build.py')], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  });
  const hu = path.join(MGU_STORE, 'deploy', 'hu');
  if (!fs.existsSync(hu)) throw new Error('MGU_STORE is required to pack marku-home-bridge: ' + hu);
  run(process.execPath, [hu, 'artifact', path.join(ROOT, 'native', 'marku-home-bridge'), '--out', PUBLISH], {
    env: { ...process.env, MGU_STORE }
  });
  const components = [
    ['marku_x3_health', 'app', 'Здоровье X3', 'CBS, 12 В, read-only обнаружение ECU и локальная история', {'mgu-deploy': '0.7.11'}],
    ['marku_x3_warm', 'app', 'Тёплый старт', 'Прогрев масла/ОЖ и рекомендация климата без записи в блоки', {'mgu-deploy': '0.7.11'}],
    ['marku_daily_hud', 'app', 'Только важное', 'Один слой отклонений через cluster-render; по умолчанию выключен', {'cluster-render': '0.4.0', 'mgu-deploy': '0.7.11'}],
    ['marku_x3_home', 'app', 'X3 ↔ Дом', 'Allowlist-сцены Home Assistant и ручная телеметрия через локальный bridge', {'marku-home-bridge': '0.1.0', 'mgu-deploy': '0.7.11'}],
    ['marku-home-bridge', 'tool', 'X3 Home bridge', 'Локальный bridge с pairing и запретом произвольных команд Home Assistant', {'jap-node22': '22.23.4', 'mgu-deploy': '0.7.11', 'mgu-uplink': '0.7.3'}],
    ['marku_x3_trips', 'app', 'Поездки и расходы', 'Локальные поездки, категории, топливо и CSV без геолокации', {'mgu-deploy': '0.7.11'}]
  ];
  const crypto = require('crypto');
  const catalog = { schema: 2, components: components.map(([id, kind, title, description, requires]) => {
    const name = `${id}@0.1.0.tgz`;
    const bytes = fs.readFileSync(path.join(PUBLISH, name));
    const component = { id, kind, version: '0.1.0', title, description, requires, uninstallable: true, mguHmi: ['ID7'],
      artifact: { name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), url: name } };
    if (id === 'marku-home-bridge') Object.assign(component, { internet: true, uids: [5000] });
    return component;
  }) };
  const evidenceFile = path.join(PUBLISH, 'build-evidence.json');
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  const bridgeBytes = fs.readFileSync(path.join(PUBLISH, 'marku-home-bridge@0.1.0.tgz'));
  evidence.bridge = { id: 'marku-home-bridge', version: '0.1.0', artifact: 'marku-home-bridge@0.1.0.tgz',
    sha256: crypto.createHash('sha256').update(bridgeBytes).digest('hex'), writeCapable: 'home-assistant-allowlist-only' };
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
  fs.writeFileSync(path.join(PUBLISH, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  writePublishCatalog();
  console.log('MGU five apps package set: ' + PUBLISH);
}

try { main(); } catch (error) { console.error('build: ' + error.message); process.exitCode = 1; }
