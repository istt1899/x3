'use strict';

// Exercise the same upstream linker used on MGU. The synthetic browserify
// donor supplies only module names; no BMW SDK or app code is executed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const link = require('../tools/upstream/oap_link');

const APP = path.join(__dirname, '..', 'apps', 'marku_x3_coding');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-linker-test-'));

function syntheticDonor(sdkNames) {
  // This is the standard unminified browserify prelude shape accepted by
  // oap_link's real splitBundle parser. Entry array [] prevents execution.
  const prelude = '(function(){function r(e,n,t){function o(i){if(!n[i]){' +
    'if(!e[i])throw Error("missing module "+i);var m=n[i]={exports:{}};' +
    'e[i][0](function(name){return o(e[i][1][name])},m,m.exports)}' +
    'return n[i].exports}for(var i=0;i<t.length;i++)o(t[i]);return o}' +
    'return r})()';
  const deps = Object.fromEntries(sdkNames.map((name, index) => [name, index + 2]));
  const modules = ['1:[function(require,module,exports){},' + JSON.stringify(deps) + ']'];
  sdkNames.forEach((_, index) => {
    modules.push((index + 2) + ':[function(require,module,exports){},{}]');
  });
  return prelude + '({' + modules.join(',') + '},{},[]);\n';
}

function unpackSource(archive, destination) {
  for (const member of link.untar(fs.readFileSync(archive))) {
    assert(!path.isAbsolute(member.name) && !member.name.split('/').includes('..'),
      'source archive must contain safe relative paths');
    const file = path.join(destination, ...member.name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, member.data);
  }
}

try {
  const manifest = link.readManifest(APP);
  const sourceArchive = path.join(temporary, 'source.tgz');
  const staged = path.join(temporary, 'source');
  const donor = path.join(temporary, 'synthetic-donor.js');
  link.packSource(APP, sourceArchive);
  unpackSource(sourceArchive, staged);
  fs.writeFileSync(donor, syntheticDonor(manifest.sdk));

  const built = path.join(temporary, 'linked.tgz');
  const result = link.build(staged, built, { donors: [donor], epoch: 1700000000 });
  assert.equal(result.id, manifest.id);
  assert.equal(result.version, manifest.version);
  assert.equal(result.moduleCount, manifest.sdk.length + manifest.modules.length);
  const members = link.untar(fs.readFileSync(built));
  const bundle = members.find(member => member.name === 'javascript/app.js');
  assert(bundle, 'real linker must write javascript/app.js');
  assert(bundle.data.toString('utf8').includes('"./diagnostics.js":'),
    'linked bundle must map the exact diagnostics.js app module');

  // Reproduce the 0.1.1 failure using a copy of the packaged source. The
  // linker has no Node-style extension search for app module requires.
  const entryFile = path.join(staged, 'src', 'coding_app.js');
  const fixedEntry = fs.readFileSync(entryFile, 'utf8');
  assert(fixedEntry.includes("require('./diagnostics.js')"),
    'fixture requires the corrected diagnostics import');
  fs.writeFileSync(entryFile,
    fixedEntry.replace("require('./diagnostics.js')", "require('./diagnostics')"));
  assert.throws(() => link.build(staged, path.join(temporary, 'broken.tgz'),
    { donors: [donor], epoch: 1700000000 }),
  /src[\\/]coding_app\.js requires "\.\/diagnostics": not an app module/);

  console.log('linker.test.js: OK');
} finally {
  // Resolve and constrain the recursive deletion to this exact test folder.
  const real = fs.realpathSync(temporary);
  const tempRoot = fs.realpathSync(os.tmpdir());
  assert(real.startsWith(tempRoot + path.sep) && path.basename(real).startsWith('x3-linker-test-'));
  fs.rmSync(real, { recursive: true, force: true });
}
