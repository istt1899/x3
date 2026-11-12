// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const PUBLISH = path.join(ROOT, 'dist', 'publish', 'mgu-five-apps');
const REPOSITORY = 'istt1899/x3';
const NEW_IDS = ['marku_x3_health', 'marku_x3_warm', 'marku_daily_hud', 'marku_x3_home', 'marku-home-bridge', 'marku_x3_trips'];

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function serialize(catalog) { return JSON.stringify(catalog, null, 2) + '\n'; }

function validateComponent(component) {
  if (!component || !/^[A-Za-z0-9_-]+$/.test(component.id) || !/^\d+\.\d+\.\d+$/.test(component.version)) {
    throw new Error('Invalid component id/version: ' + (component && component.id));
  }
  const artifact = component.artifact;
  const name = `${component.id}@${component.version}.tgz`;
  if (!artifact || artifact.name !== name) throw new Error('Unexpected artifact name for ' + component.id);
  const file = path.join(PUBLISH, name);
  const stat = fs.lstatSync(file);
  const bytes = fs.readFileSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.size || sha256(bytes) !== artifact.sha256) {
    throw new Error('Archive size/SHA mismatch: ' + name);
  }
}

function loadNewComponents() {
  const file = path.join(PUBLISH, 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (catalog.schema !== 2 || !Array.isArray(catalog.components)) throw new Error('Invalid new catalog: ' + file);
  if (catalog.components.length !== NEW_IDS.length) throw new Error('Expected exactly six new components');
  catalog.components.forEach(validateComponent);
  return catalog.components;
}

function writePublishCatalog() {
  const incoming = loadNewComponents();
  const rootFile = path.join(REPO, 'catalog.json');
  const rootCatalog = JSON.parse(fs.readFileSync(rootFile, 'utf8'));
  if (rootCatalog.schema !== 2 || !Array.isArray(rootCatalog.components)) throw new Error('Invalid root catalog');
  const existing = rootCatalog.components.filter((component) => !NEW_IDS.includes(component.id));
  const withUrls = incoming.map((component) => JSON.parse(JSON.stringify(component)));
  withUrls.forEach((component) => {
    component.artifact.url = `https://github.com/${REPOSITORY}/releases/download/${component.id}@${component.version}/${component.artifact.name}`;
  });
  const merged = { schema: 2, components: existing.concat(withUrls) };
  const ids = new Set();
  merged.components.forEach((component) => {
    if (ids.has(component.id)) throw new Error('Duplicate component in merged catalog: ' + component.id);
    ids.add(component.id);
  });
  const githubBytes = Buffer.from(serialize(merged), 'utf8');
  const usb = { schema: 2, components: incoming.map((component) => {
    const item = JSON.parse(JSON.stringify(component));
    item.artifact.url = item.artifact.name;
    return item;
  }) };
  fs.writeFileSync(rootFile, githubBytes);
  fs.writeFileSync(path.join(PUBLISH, 'catalog.github.json'), githubBytes);
  fs.writeFileSync(path.join(PUBLISH, 'catalog.json'), Buffer.from(serialize(usb), 'utf8'));
  return { output: path.join(PUBLISH, 'catalog.github.json'), sha256: sha256(githubBytes), components: merged.components.length };
}

if (require.main === module) {
  try {
    const result = writePublishCatalog();
    console.log(`${result.output} sha256=${result.sha256} components=${result.components}`);
  } catch (error) {
    console.error('catalog: ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = { NEW_IDS, loadNewComponents, writePublishCatalog, serialize };
