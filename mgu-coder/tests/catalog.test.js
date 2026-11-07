'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const {
  toPublishCatalog, serializeCatalog, writePublishCatalog
} = require('../tools/catalog');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-catalog-test-'));
try {
  const archive = Buffer.from('reproducible fixture archive bytes\n', 'utf8');
  const name = 'marku_x3_coding@0.1.1.tgz';
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  const input = path.join(temporary, 'catalog.json');
  const output = path.join(temporary, 'catalog.github.json');
  const usbCatalog = {
    schema: 2,
    components: [{
      id: 'marku_x3_coding', kind: 'app', version: '0.1.1',
      artifact: { name, size: archive.length, sha256: digest, url: name }
    }]
  };
  fs.writeFileSync(path.join(temporary, name), archive);
  fs.writeFileSync(input, serializeCatalog(usbCatalog));

  const untouched = JSON.parse(JSON.stringify(usbCatalog));
  const expectedUrl =
    'https://github.com/istt1899/x3/releases/download/marku_x3_coding@0.1.1/marku_x3_coding@0.1.1.tgz';
  const transformed = toPublishCatalog(usbCatalog);
  assert.deepEqual(usbCatalog, untouched, 'conversion must not mutate the USB catalog');
  assert.equal(usbCatalog.components[0].artifact.url, name);
  assert.equal(transformed.components[0].artifact.url, expectedUrl);
  assert.equal(transformed.components[0].artifact.sha256, digest);
  assert.equal(transformed.components[0].artifact.size, archive.length);
  assert.deepEqual(serializeCatalog(transformed), serializeCatalog(toPublishCatalog(usbCatalog)));

  const first = writePublishCatalog({ input, output });
  const firstBytes = fs.readFileSync(output);
  assert.deepEqual(firstBytes, serializeCatalog(transformed));
  assert.equal(first.sha256, crypto.createHash('sha256').update(firstBytes).digest('hex'));
  const second = writePublishCatalog({ input, output });
  assert.deepEqual(fs.readFileSync(output), firstBytes, 'same input must yield identical publish bytes');
  assert.equal(second.sha256, first.sha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(input, 'utf8')), usbCatalog,
    'USB catalog must remain relative after publish generation');

  const cliOutput = path.join(temporary, 'from-cli.json');
  const cli = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'catalog.js'),
    '--input', input, '--output', cliOutput, '--repo', 'istt1899/x3'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(fs.readFileSync(cliOutput), firstBytes);

  assert.throws(() => toPublishCatalog({ ...usbCatalog, components: [
    { ...usbCatalog.components[0], artifact: { ...usbCatalog.components[0].artifact, url: expectedUrl } }
  ] }), /relative archive name/);
  assert.throws(() => toPublishCatalog(usbCatalog, 'invalid/../repo'), /invalid GitHub/);
  fs.writeFileSync(path.join(temporary, name), Buffer.from('tampered'));
  assert.throws(() => writePublishCatalog({ input, output }), /SHA-256 differs/);
  assert.deepEqual(fs.readFileSync(output), firstBytes, 'failed validation must not overwrite publish catalog');

  console.log('catalog.test.js: OK');
} finally {
  // Resolve the deletion target and constrain it to this test's temp prefix.
  const real = fs.realpathSync(temporary);
  const tempRoot = fs.realpathSync(os.tmpdir());
  assert(real.startsWith(tempRoot + path.sep) && path.basename(real).startsWith('x3-catalog-test-'));
  fs.rmSync(real, { recursive: true, force: true });
}
