'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { ClusterOutput, packet } = require(process.env.MGU_CLUSTER_MODULE || './cluster_output');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-socket-test-'));
    const file = path.join(root, 'frame');
    const bytes = Buffer.alloc(64 + 16 * 16 * 3 / 2, 128);
    bytes.fill(0, 0, 64);
    [0x4656474d, 1, 16, 16, 1, 0, 1, 1, 0].forEach((v, i) => bytes.writeUInt32LE(v, i * 4));
    fs.writeFileSync(file, bytes);
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\mgu-cluster-test-' + process.pid : path.join(root, 'socket');
    let received = 0, connections = 0, disconnects = 0, active = true;
    const server = net.createServer(peer => {
        connections++;
        let buffer = Buffer.alloc(0);
        peer.on('error', () => {});
        peer.on('close', () => disconnects++);
        peer.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 5 && buffer.length >= buffer.readUInt32LE(0) + 4) {
                const size = buffer.readUInt32LE(0), type = buffer[4], data = buffer.slice(5, size + 4);
                buffer = buffer.slice(size + 4);
                if (type === 0x4a) {
                    const message = JSON.parse(data.toString());
                    if (message.op === 'hello') {
                        const response = packet(0x4a, Buffer.from(JSON.stringify({ ev: 'hello', backend: 'id7', targets: 'map:1088x480' })));
                        peer.write(response.slice(0, 3));
                        setTimeout(() => peer.write(response.slice(3)), 20);
                    } else if (message.op === 'layer') {
                        assert.strictEqual(message.target, 'map');
                        peer.write(packet(0x4a, Buffer.from(JSON.stringify({ ev: 'target', target: 'map', state: 'shown' }))));
                    }
                } else {
                    assert.strictEqual(type, 0x46); assert.strictEqual(data.length, 14 + 544 * 240 * 3 / 2);
                    assert.strictEqual(data.readUInt16LE(12), 0); received++;
                }
            }
        });
    });
    await new Promise(resolve => server.listen(socket, resolve));
    let shown = false;
    const output = new ClusterOutput({ file, socket, active: () => active, report: state => { if (state === 'shown') shown = true; } });
    try {
        output.heartbeat(true);
        const deadline = Date.now() + 2000;
        while (!received && Date.now() < deadline) { output.heartbeat(true); await delay(100); }
        assert.ok(received && shown, 'fragmented hello + real socket delivered a valid frame');
        const count = received;
        await delay(1500);
        assert.ok(disconnects > 0, 'lost parked heartbeat closes the socket');
        active = false; output.heartbeat(true); await delay(350);
        assert.strictEqual(connections, 1, 'no reconnection while decoder is inactive');
        output.heartbeat(false); assert.ok(received <= count + 6, 'no frames after lease expires');
        console.log('ok: real socket fragmented handshake, map frames, shown acknowledgement, lease and inactive decoder');
    } finally {
        output.close(); await new Promise(resolve => server.close(resolve));
        fs.unlinkSync(file); fs.rmdirSync(root);
    }
})().catch(error => { console.error(error); process.exit(1); });
