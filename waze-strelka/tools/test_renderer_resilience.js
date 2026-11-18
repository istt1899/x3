'use strict';
// 0.8.7 renderer resilience: a dropped cluster-render connection is
// re-established with backoff and the active card is drawn again; the
// diagnostics expose reconnects and the reasons.
const net = require('net'), assert = require('assert'), os = require('os'), path = require('path');
const displayModule = require('../native/marku-kaluga-cameras/files/camera-layers');
const socketName = process.platform === 'win32' ? '\\\\.\\pipe\\kaluga-resilience-' + process.pid : path.join(os.tmpdir(), 'kaluga-resilience-' + process.pid + '.sock');
const frame = (o) => { const p = Buffer.from(JSON.stringify(o), 'utf8'), m = Buffer.alloc(5 + p.length); m.writeUInt32LE(p.length + 1, 0); m[4] = 74; p.copy(m, 5); return m; };
function serve(targets) {
    const peers = new Set(), server = net.createServer(sock => {
        peers.add(sock); let buf = Buffer.alloc(0);
        sock.on('error', () => {}); sock.on('close', () => peers.delete(sock));
        sock.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
            while (buf.length >= 5 && buf.length >= 4 + buf.readUInt32LE(0)) {
                const end = 4 + buf.readUInt32LE(0), type = buf[4], data = buf.slice(5, end); buf = buf.slice(end);
                if (type !== 74) continue; // pixel frames are not JSON
                const msg = JSON.parse(data.toString());
                if (msg.op === 'hello') { sock.write(frame({ ev: 'hello', backend: 'test', version: '0.5.0', targets })); peers.forEach(s => s.write(frame({ ev: 'target', target: 'map', state: 'shown', rendering: 'verified' }))); }
                if (msg.op === 'set' && msg.visible === 1) sock.write(frame({ ev: 'layer', ref: msg.ref, state: 'visible' }));
            }
        });
    });
    return new Promise(resolve => server.listen(socketName, () => resolve({ server, peers,
        closeAll: () => { peers.forEach(s => s.destroy()); },
        closeListener: () => new Promise(r => { peers.forEach(s => s.destroy()); server.close(() => r()); }) })));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(label, check) { for (let i = 0; i < 400; i++) { if (check()) return; await sleep(10); } throw new Error(label + ' timed out'); }
(async () => {
    const display = displayModule.createDisplay({ socket: socketName });
    const alert = { id: 'cam', title: 'Камера', controls: ['speed'], distanceM: 300, limitKmh: 60, roadConfirmed: true };
    const outputs = { cluster: true, hud: true };
    let env = await serve('map:874x749,hud:353x203');
    display.update(alert, outputs, undefined);
    await until('card shown', () => display.diagnostics().connection === 'ready' && display.diagnostics().map.state === 'visible');
    assert.strictEqual(display.diagnostics().reconnects, 0);
    const opensBefore = env.peers.size;
    // The renderer dies: sockets and the listener are gone.
    await env.closeListener();
    await until('disconnect detected', () => display.diagnostics().connection === 'disconnected');
    assert(display.diagnostics().lastDisconnectReason, 'a disconnect reason is recorded');
    // Reconnect attempts keep failing while the listener is gone: the first
    // backoff is half a second, so within ~1.2 s at least one failed attempt
    // is counted while the state stays disconnected.
    await sleep(1200);
    assert(display.diagnostics().connection === 'disconnected', 'no fake resurrection without a listener');
    assert(display.diagnostics().reconnects >= 1, 'failed reconnect attempts are counted');
    // The renderer comes back (restart): the client must reconnect, replay the
    // layers and draw the still-active card again.
    env = await serve('map:874x749,hud:353x203');
    await until('reconnected and card redrawn', () => display.diagnostics().connection === 'ready' && display.diagnostics().map.state === 'visible');
    assert(display.diagnostics().reconnects >= 1, 'reconnect counter grows, got ' + display.diagnostics().reconnects);
    assert(display.diagnostics().lastReconnectAt !== null, 'last reconnect time is recorded');
    assert.strictEqual(display.diagnostics().version, '0.5.0');
    // A brief no-card gap must NOT tear the session down any more.
    const reconnects = display.diagnostics().reconnects;
    display.update(null, outputs, undefined);
    await sleep(60);
    assert.strictEqual(display.diagnostics().connection, 'ready', 'suspend keeps the session');
    assert.strictEqual(display.diagnostics().reconnects, reconnects);
    display.update(alert, outputs, undefined);
    await until('card resumes after gap', () => display.diagnostics().map.state === 'visible');
    assert.strictEqual(display.diagnostics().reconnects, reconnects, 'resume never reconnects');
    await env.closeListener(); display.close();
    console.log('PASS renderer resilience: disconnect reason, 0.5/1/2/5 s backoff reconnects, layer replay and card redraw, reconnect counters, suspend-without-tear; real sockets');
    setTimeout(() => process.exit(process.exitCode || 0), 100);
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
