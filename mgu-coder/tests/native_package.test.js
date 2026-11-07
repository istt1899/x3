'use strict';

// Host-only integration test of the real MGU module-mode preparation path.
// The donor is a tiny browserify fixture with the SDK's public module names;
// it does not contain BMW code and the app itself is never started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const link = require('../tools/upstream/oap_link');

const ROOT = path.join(__dirname, '..');
const VERSION = require('../package.json').version;
const ARCHIVE = path.join(ROOT, 'dist', 'publish', 'x3-coding', `marku_x3_coding@${VERSION}.tgz`);
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-native-package-test-'));

function donorSource() {
  // Browserify's prelude returns a require function. The empty entry array
  // means no donor module runs while oap_link captures its module map.
  const prelude = '(function(){function r(e,n,t){function o(i){if(!n[i]){' +
    'if(!e[i])throw Error("missing module "+i);var m=n[i]={exports:{}};' +
    'e[i][0](function(name){return o(e[i][1][name])},m,m.exports)}' +
    'return n[i].exports}for(var i=0;i<t.length;i++)o(t[i]);return o}' +
    'return r})()';
  const modules = {
    1: [function(require, module, exports) {}, {
      'oap-sdk/src/core/OnlineApp.js': 2,
      'oap-sdk/src/someip/someipBuilders.js': 3
    }],
    2: [function(require, module, exports) { module.exports = function SyntheticOnlineApp() {}; }, {}],
    3: [function(require, module, exports) { module.exports = { syntheticBuilder: function() {} }; }, {}]
  };
  const entries = Object.keys(modules).map(id => `${id}:[${modules[id][0].toString()},${JSON.stringify(modules[id][1])}]`);
  return prelude + '({' + entries.join(',') + '},{},[]);\n';
}

function unpack(members, destination) {
  for (const member of members) {
    assert(!path.isAbsolute(member.name) && !member.name.split('/').includes('..'),
      'archive member path must be relative and stay inside the package');
    const target = path.join(destination, ...member.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, member.data);
  }
}

function withoutComments(source) {
  let mode = 'code';
  let result = '';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (char === '/' && next === '/') { mode = 'line'; result += '  '; i += 1; }
      else if (char === '/' && next === '*') { mode = 'block'; result += '  '; i += 1; }
      else if (char === '\'' || char === '"') { mode = char; result += char; }
      else if (char === '`') { mode = 'template'; result += ' '; }
      else result += char;
    } else if (mode === 'line') {
      result += char === '\n' ? '\n' : ' ';
      if (char === '\n') mode = 'code';
    } else if (mode === 'block') {
      if (char === '*' && next === '/') { mode = 'code'; result += '  '; i += 1; }
      else result += char === '\n' ? '\n' : ' ';
    } else if (mode === 'template') {
      result += char === '\n' ? '\n' : ' ';
      if (char === '\\') { result += ' '; i += 1; }
      else if (char === '`') mode = 'code';
    } else {
      result += char;
      if (char === '\\') { result += next || ''; i += 1; }
      else if (char === mode) mode = 'code';
    }
  }
  return result;
}

function staticRelativeImports(members, prefix) {
  const files = new Map(members.map(member => [member.name, member.data]));
  let count = 0;
  for (const [file, bytes] of files) {
    if (!file.endsWith('.js') || !file.startsWith(prefix + 'javascript/')) continue;
    const source = withoutComments(bytes.toString('utf8'));
    const re = /\brequire\(\s*(['"])(\.[^'"]+)\1\s*\)/g;
    let match;
    while ((match = re.exec(source))) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2]));
      assert(base !== '..' && !base.startsWith('../') &&
        (!prefix || base.startsWith(prefix)),
      `relative require escapes package: ${file} -> ${match[2]}`);
      const candidates = [base, base + '.js', base + '.json', base + '.node',
        base + '/index.js', base + '/index.json'];
      assert(candidates.some(candidate => files.has(candidate)),
        `unresolved, case-sensitive relative require: ${file} -> ${match[2]}`);
      count += 1;
    }
  }
  return count;
}

function node8Executable() {
  if (process.env.MGU_NODE8) {
    assert(fs.existsSync(process.env.MGU_NODE8), 'MGU_NODE8 executable does not exist');
    return process.env.MGU_NODE8;
  }
  if (/^v8\./.test(process.version)) return process.execPath;
  const local = 'D:\\BMW\\Tools\\node-v8.17.0-win-x64\\node.exe';
  return fs.existsSync(local) ? local : null;
}

function checkNode8(executable, files) {
  if (!executable) {
    console.log('native_package.test.js: Node 8 parse skipped (set MGU_NODE8 to enable)');
    return 0;
  }
  const version = cp.spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(version.status, 0, version.stderr);
  assert(/^v8\./.test(version.stdout.trim()), 'MGU_NODE8 must point to Node 8');
  for (const file of files) {
    const result = cp.spawnSync(executable, ['--check', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
  return files.length;
}

try {
  assert(fs.existsSync(ARCHIVE), `build the current source archive first: ${ARCHIVE}`);
  const original = link.untar(fs.readFileSync(ARCHIVE));
  assert(original.length > 0 && original.every(member => member.name.startsWith('package/')),
    'native source archive must use npm package/ layout');
  const names = new Set(original.map(member => member.name));
  assert(names.has('package/javascript/app.js'), 'native package must have direct javascript/app.js');
  assert(names.has('package/javascript/kit/mgu.js'), 'native package must include the working kit runtime');
  assert(names.has('package/rhmiData/application.json'), 'native package must include RHMI metadata');
  assert(names.has('package/config/base.json'), 'native package must include SDK loading config');
  for (const member of original) {
    if (member.name.startsWith('package/javascript/kit/') && member.name.endsWith('.js')) {
      const relative = member.name.slice('package/javascript/kit/'.length);
      const upstream = path.join(ROOT, '..', 'media', 'core', 'kit', 'runtime', relative);
      assert(member.data.equals(fs.readFileSync(upstream)), 'shipped runtime must match working kit: ' + relative);
    }
  }
  assert(![...names].some(name => name.startsWith('package/node_modules/oap-sdk/')),
    'published source archive must not ship donor SDK code');
  const pkg = JSON.parse(original.find(member => member.name === 'package/package.json').data.toString('utf8'));
  assert.equal(pkg.name, 'marku_x3_coding');
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.main, 'javascript/app.js');
  const appSource = original.find(member => member.name === 'package/javascript/app.js').data.toString('utf8');
  assert(/require\(['"]\.\/kit\/mgu['"]\)/.test(appSource), 'entry must use the kit lifecycle');
  const config = JSON.parse(original.find(member => member.name === 'package/config/base.json').data.toString('utf8'));
  assert.equal(config.rhmiLoadingEnabled, true);
  assert.equal(config.entryPointLoadingEnabled, true);
  const originalImports = staticRelativeImports(original, 'package/');
  assert(originalImports > 0, 'expected app and kit relative imports');

  const staged = path.join(TEMP, 'staged');
  unpack(original.map(member => ({ name: member.name.slice('package/'.length), data: member.data })), staged);
  const donor = path.join(TEMP, 'synthetic-sdk-donor.js');
  fs.writeFileSync(donor, donorSource());
  const built = path.join(TEMP, 'prepared.tgz');
  const prepared = link.preparePackage(staged, built, { donors: [donor] });
  assert(prepared.sdk && prepared.sdk.api.includes('OnlineApp') && prepared.sdk.api.includes('someipBuilders'),
    'real module-mode preparer must generate the SDK public API from the donor');
  const flat = link.untar(fs.readFileSync(built));
  const flatNames = new Set(flat.map(member => member.name));
  assert(flat.length > 0 && flat.every(member => !member.name.startsWith('package/')),
    'installed archive must be flat');
  assert(flatNames.has('node_modules/oap-sdk/index.js'));
  assert(flatNames.has('node_modules/oap-sdk/package.json'));
  assert(flatNames.has('javascript/app.js'));
  const flatPkg = JSON.parse(flat.find(member => member.name === 'package.json').data.toString('utf8'));
  assert.equal(flatPkg.main, 'javascript/app.js');
  assert.equal(flatPkg.mguLocalOnly, true);
  const sdk = require(path.join(staged, 'node_modules', 'oap-sdk'));
  assert.equal(typeof sdk.OnlineApp, 'function');
  assert.equal(typeof sdk.someipBuilders.syntheticBuilder, 'function');
  const flatImports = staticRelativeImports(flat, '');
  assert(flatImports >= originalImports);
  const jsFiles = flat.filter(member => member.name.endsWith('.js')).map(member =>
    path.join(staged, ...member.name.split('/')));
  const node8Parsed = checkNode8(node8Executable(), jsFiles);
  console.log(`native_package.test.js: OK (${originalImports} source imports, ${flatImports} flat imports, ${node8Parsed} Node 8 JS files)`);
} finally {
  const real = fs.realpathSync(TEMP);
  const root = fs.realpathSync(os.tmpdir());
  assert(real.startsWith(root + path.sep) && path.basename(real).startsWith('x3-native-package-test-'));
  fs.rmSync(real, { recursive: true, force: true });
}
