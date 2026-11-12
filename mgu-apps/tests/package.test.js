// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const PUBLISH = path.join(ROOT, 'dist', 'publish', 'mgu-five-apps');
const IDS = ['marku_x3_health', 'marku_x3_warm', 'marku_daily_hud', 'marku_x3_home', 'marku-home-bridge', 'marku_x3_trips'];

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function main() {
  for (const id of IDS) {
    const file = path.join(PUBLISH, `${id}@0.1.0.tgz`);
    assert(fs.existsSync(file), `missing ${file}`);
    const files = cp.execFileSync('tar', ['--force-local', '-tzf', file], { encoding: 'utf8' }).trim().split(/\r?\n/);
    assert(files.length > 0);
    const catalog = JSON.parse(fs.readFileSync(path.join(PUBLISH, 'catalog.json'), 'utf8'));
    const component = catalog.components.find((item) => item.id === id);
    assert(component, `catalog component ${id}`);
    const bytes = fs.readFileSync(file);
    assert.strictEqual(component.artifact.size, bytes.length);
    assert.strictEqual(component.artifact.sha256, sha256(bytes));
  }
  const evidence = JSON.parse(fs.readFileSync(path.join(PUBLISH, 'build-evidence.json'), 'utf8'));
  assert.strictEqual(evidence.vehicleRuntimeTested, false);
  assert.strictEqual(evidence.sdkIncluded, false);
  assert.strictEqual(evidence.writeCapable, false);
  const rootCatalog = JSON.parse(fs.readFileSync(path.join(REPO, 'catalog.json'), 'utf8'));
  const githubCatalog = JSON.parse(fs.readFileSync(path.join(PUBLISH, 'catalog.github.json'), 'utf8'));
  assert.deepStrictEqual(rootCatalog, githubCatalog);
  IDS.forEach((id) => assert(rootCatalog.components.some((component) => component.id === id), `root catalog ${id}`));
  const oldCatalog = JSON.parse(cp.execFileSync('git', ['show', 'HEAD:catalog.json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  oldCatalog.components.forEach((old) => {
    const current = rootCatalog.components.find((component) => component.id === old.id);
    assert(current, `preserved component ${old.id}`);
    if (!IDS.includes(old.id)) assert.deepStrictEqual(current, old, `unchanged component ${old.id}`);
  });
  for (const id of ['marku_x3_health', 'marku_x3_warm', 'marku_daily_hud', 'marku_x3_trips']) {
    const dir = path.join(ROOT, 'apps', id);
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      assert(!/signals\.set\(|\.setValue\(|ClearDiagnostic|0x14|0x2E/i.test(source), `write-capable call in ${id}/${file}`);
      cp.execFileSync(process.execPath, ['--check', path.join(dir, file)], { stdio: 'pipe' });
    }
  }
  const bridgeSource = fs.readFileSync(path.join(ROOT, 'native', 'marku-home-bridge', 'home_bridge.js'), 'utf8');
  assert(!/github_pat_|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}/.test(bridgeSource), 'hardcoded credential');
  console.log('package.test.js: OK');
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
