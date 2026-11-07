'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const EventEmitter = require('events'), net = require('net');
const { ClusterOutput, atlas, packet } = require('./cluster_output');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-video-test-'));
const file = path.join(tmp, 'frame');
const input = Buffer.alloc(64 + 16 * 16 * 3 / 2);
[0x4656474d, 1, 16, 16, 1, 0, 1, 1, 0].forEach((v, n) => input.writeUInt32LE(v, n * 4));
input.fill(64, 64, 320); input.fill(100, 320, 384); input.fill(150, 384);
fs.writeFileSync(file, input);
const image = atlas(file);
assert.strictEqual(image.data.length, 544 * 240 * 3 / 2);
assert.strictEqual(image.data[0], 16, 'letterbox preserves aspect ratio');
assert.strictEqual(image.data[152], 64);
assert.strictEqual(image.data[544 * 240 + 76], 100);
assert.strictEqual(image.data[544 * 240 + 76 + 272], 150, 'U and V side by side, not planar');
input.writeUInt32LE(5, 24); fs.writeFileSync(file, input);
assert.strictEqual(atlas(file), null, 'malformed slot count is rejected');
input.writeUInt32LE(1, 24); fs.writeFileSync(file, input);
class Peer extends EventEmitter {
    constructor() { super(); this.messages = []; this.bufferSize = 0; this.destroyed = false; }
    write(p) { this.messages.push(p); return true; }
    destroy() { this.destroyed = true; this.emit('close'); }
}
const original = net.connect;
let peer, now = 10000, active = true;
net.connect = () => (peer = new Peer());
const output = new ClusterOutput({ file, now: () => now, active: () => active });
try {
    output.heartbeat(true); output.tick(); peer.emit('connect');
    peer.emit('data', packet(0x4a, Buffer.from(JSON.stringify({ ev: 'hello', backend: 'id7', targets: 'map:1088x480,panel:1920x720' }))));
    output.tick();
    const layer = JSON.parse(peer.messages[1].slice(5).toString());
    assert.strictEqual(layer.target, 'map'); assert.strictEqual(layer.guide_hold, 0);
    assert.strictEqual(peer.messages[2][4], 0x46);
    peer.bufferSize = 1024 * 1024; now += 250; output.tick();
    assert.strictEqual(peer.messages.length, 3, 'backpressure bounded on real Node 8 bufferSize');
    now += 1201; output.tick(); assert.ok(peer.destroyed, 'lost parked heartbeat disconnects');
    now += 5000; output.heartbeat(true); active = false; output.tick();
    assert.strictEqual(output.peer, null, 'no decoder/active video means no stale private frame');
} finally {
    output.close(); net.connect = original;
    fs.unlinkSync(file); fs.rmdirSync(tmp);
}
console.log('ok: atlas format/aspect, map-only protocol, decoder gate, heartbeat expiry and Node 8 backpressure');
