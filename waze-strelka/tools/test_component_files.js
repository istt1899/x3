'use strict';
// 0.9.0 regression: every relative require of the native service must be
// shipped in the tool package. The 0.8.7 package missed capture-data.js —
// the service could not start. This test fails on any such gap.
const assert = require('assert'), fs = require('fs'), path = require('path');
const base = path.join(__dirname, '../native/marku-kaluga-cameras/files');
const component = JSON.parse(fs.readFileSync(path.join(base, '..', 'component.json'), 'utf8'));
const shipped = new Set(component.files.map(f => f.path));
const BUILTINS = new Set(['fs', 'net', 'path', 'crypto', 'zlib', 'events', 'util', 'os', 'url', 'querystring', 'buffer', 'stream']);
const RELATIVE = /require\(\s*'(\.[^']*)'\s*\)/g;
const queue = ['marku-kaluga-cameras.js'], seen = new Set();
while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert(shipped.has(file), file + ' is required but not listed in component.json');
    const text = fs.readFileSync(path.join(base, file), 'utf8');
    let match;
    while ((match = RELATIVE.exec(text))) {
        const rel = match[1];
        const candidates = [rel.replace(/^\.\//, '').replace(/\.js$/, '') + '.js', rel.replace(/^\.\//, '')];
        const found = candidates.find(c => fs.existsSync(path.join(base, c)));
        assert(found, file + ' requires ' + rel + ' which does not exist');
        assert(shipped.has(found), file + ' requires ' + found + ' which is not shipped');
        queue.push(found);
    }
}
// Data files the service reads by default must ship too.
['kaluga-speed.json', 'road-zones.json', 'camera-details.json', 'reported-cameras.json', 'enforcement-relations.json',
    'gibdd-kaluga.json', 'official-camera-quality.json', 'speed-limit-data.json', 'openspeedcam-central.json',
    'moscow-osm.json', 'camera-font.json', 'database-version.json'].forEach(f =>
    assert(shipped.has(f), f + ' must be shipped'));
console.log('PASS component completeness: every relative require of ' + seen.size + ' native modules and every default data file is shipped in the tool package');
