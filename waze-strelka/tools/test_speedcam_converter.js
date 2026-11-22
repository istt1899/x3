'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const { SOURCE, buildPack } = require('../native/marku-kaluga-cameras/files/speedcam-converter');
const selection = require('../native/marku-kaluga-cameras/files/speedcam-selection.json');

assert.deepStrictEqual(Object.keys(selection).sort(), ['includeLsbFirst', 'inputRows', 'links', 'outputRows']);
assert.strictEqual(selection.inputRows, 74309);
assert.strictEqual(selection.outputRows, 49108);
const include = Buffer.from(selection.includeLsbFirst, 'base64');
const included = index => Boolean(include[index >> 3] & (1 << (index & 7)));
assert.strictEqual(include.length, Math.ceil(selection.inputRows / 8));
let count = 0;
for (let i = 0; i < include.length * 8; i++) {
    if (included(i)) {
        assert(i < selection.inputRows);
        count++;
    }
}
assert.strictEqual(count, selection.outputRows);
const links = Object.entries(selection.links);
assert.strictEqual(links.length, 16);
assert.strictEqual(links.filter(([, link]) => link.length === 2).length, 4);
for (const [line, link] of links) {
    assert(included(Number(line) - 1));
    assert(link.length === 1 || link.length === 2);
    assert(/^(osc:[a-f0-9]{24}|gibdd:ru-klu:[a-f0-9]{16})$/.test(link[0]));
    if (link.length === 2) assert(/^sco:[a-f0-9]{20}$/.test(link[1]));
}

for (const input of [null, Buffer.alloc(0), Buffer.alloc(SOURCE.bytes)]) {
    assert.throws(() => buildPack(input), /SPEEDCAM_SOURCE_HASH/);
}

const paths = process.argv.slice(2);
if (paths.length) {
    assert.strictEqual(paths.length, 2, 'Supply both the upstream ZIP and the private reference JSON');
    const zip = fs.readFileSync(paths[0]);
    const pack = buildPack(zip);
    assert(pack.equals(fs.readFileSync(paths[1])), 'Converted bytes differ from the reviewed private pack');
    assert.strictEqual(crypto.createHash('sha256').update(pack).digest('hex'), SOURCE.packSha256);
    const rows = JSON.parse(pack.toString('utf8')).records;
    assert.strictEqual(rows.length, 49108);
    assert.strictEqual(rows.filter(row => row[5] === null).length, 49092);
    zip[zip.length - 1] ^= 1;
    assert.throws(() => buildPack(zip), /SPEEDCAM_SOURCE_HASH/);
    console.log('PASS upstream ZIP reproduces the complete reviewed private pack byte for byte');
} else {
    console.log('PASS SpeedCam selection table and rejection of unknown sources');
}
