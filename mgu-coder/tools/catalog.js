// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

// Generate the GitHub Releases catalog from the USB catalog. The input stays
// relative so mgu-install can copy its archive from the same local directory.
// No network access or release state is involved in this transformation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PUBLISH = path.join(ROOT, 'dist', 'publish', 'x3-coding');
const DEFAULT_REPOSITORY = 'istt1899/x3';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateRepository(repository) {
  assert(typeof repository === 'string' &&
    /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository) &&
    !/[\/]\.{1,2}$/.test(repository), 'invalid GitHub owner/repository');
  return repository;
}

function validateUsbCatalog(catalog) {
  assert(catalog && catalog.schema === 2 && Array.isArray(catalog.components) &&
    catalog.components.length > 0, 'expected nonempty schema-2 USB catalog');
  const seen = new Set();
  for (const component of catalog.components) {
    assert(component && typeof component.id === 'string' &&
      /^[A-Za-z0-9_-]+$/.test(component.id), 'invalid component id');
    assert(typeof component.version === 'string' &&
      /^\d+\.\d+\.\d+$/.test(component.version), 'invalid component version');
    const tag = `${component.id}@${component.version}`;
    assert(!seen.has(tag), 'duplicate component tag: ' + tag);
    seen.add(tag);
    const artifact = component.artifact;
    assert(artifact && artifact.name === `${tag}.tgz`, 'unexpected artifact name: ' + tag);
    assert(artifact.url === artifact.name, 'USB artifact URL must be the relative archive name: ' + tag);
    assert(Number.isSafeInteger(artifact.size) && artifact.size > 0, 'invalid artifact size: ' + tag);
    assert(typeof artifact.sha256 === 'string' && /^[0-9a-f]{64}$/.test(artifact.sha256),
      'invalid artifact SHA-256: ' + tag);
  }
  return catalog;
}

function toPublishCatalog(usbCatalog, repository = DEFAULT_REPOSITORY) {
  validateRepository(repository);
  validateUsbCatalog(usbCatalog);
  // JSON clone also guarantees the source catalog is not changed in memory.
  const catalog = JSON.parse(JSON.stringify(usbCatalog));
  for (const component of catalog.components) {
    const tag = `${component.id}@${component.version}`;
    component.artifact.url =
      `https://github.com/${repository}/releases/download/${tag}/${component.artifact.name}`;
  }
  return catalog;
}

function serializeCatalog(catalog) {
  return Buffer.from(JSON.stringify(catalog, null, 2) + '\n', 'utf8');
}

function assertArchiveHashes(usbCatalog, archiveDirectory) {
  for (const component of usbCatalog.components) {
    const artifact = component.artifact;
    const file = path.join(archiveDirectory, artifact.name);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'archive must be a regular file: ' + file);
    const bytes = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    assert(bytes.length === artifact.size && hash === artifact.sha256,
      'archive size or SHA-256 differs from USB catalog: ' + artifact.name);
  }
}

function writePublishCatalog({
  input = path.join(PUBLISH, 'catalog.json'),
  output = path.join(PUBLISH, 'catalog.github.json'),
  repository = DEFAULT_REPOSITORY
} = {}) {
  input = path.resolve(input);
  output = path.resolve(output);
  assert(input !== output, 'publish catalog must not overwrite USB catalog');
  const usbCatalog = JSON.parse(fs.readFileSync(input, 'utf8'));
  const publishCatalog = toPublishCatalog(usbCatalog, repository);
  assertArchiveHashes(usbCatalog, path.dirname(input));
  const bytes = serializeCatalog(publishCatalog);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, bytes);
  return { output, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    assert(['--input', '--output', '--repo'].includes(flag) && argv[i + 1] !== undefined &&
      !argv[i + 1].startsWith('--'), 'usage: node tools/catalog.js [--input FILE] [--output FILE] [--repo OWNER/REPO]');
    options[flag === '--repo' ? 'repository' : flag.slice(2)] = argv[i + 1];
  }
  return options;
}

if (require.main === module) {
  try {
    const result = writePublishCatalog(parseArgs(process.argv.slice(2)));
    console.log(`${result.output} sha256=${result.sha256}`);
  } catch (error) {
    console.error('catalog: ' + error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_REPOSITORY, validateUsbCatalog, toPublishCatalog, serializeCatalog,
  assertArchiveHashes, writePublishCatalog
};
