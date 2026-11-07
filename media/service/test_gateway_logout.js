'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const os = require('os');
const path = require('path');
const Gateway = require('./gateway').Gateway;
const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

class Socket extends EventEmitter {
    constructor() { super(); this.messages = []; }
    setEncoding() {}
    write(line) { this.messages.push(JSON.parse(line)); }
    destroy() { this.emit('close'); }
}
class Player {
    constructor() { this.running = false; this.configs = 0; this.retireCount = 0; this.gate = null; }
    async retire() { this.retireCount++; if (this.gate) await this.gate.promise; this.running = false; }
    configure(context, emit) { assert.strictEqual(this.running, false); this.context = context; this.emit = emit; this.configs++; }
    command() {}
    play() { this.running = true; }
}
function fixture() {
    const player = new Player(), gates = { vk: {}, rutube: {}, youtube: {} };
    const providers = Object.keys(gates).map((id) => ({
        id,
        search: async () => { if (gates[id].search) await gates[id].search.promise; return { items: [{ id: '-123_456', title: 'Private' }] }; },
        feed: async () => { if (gates[id].feed) await gates[id].feed.promise; return { items: [{ id: '-123_456', title: 'Private' }] }; },
        thumb: async () => { if (gates[id].thumb) await gates[id].thumb.promise; return { rgba: Buffer.alloc(230400), w: 320, h: 180 }; },
        status: async () => { if (gates[id].status) await gates[id].status.promise; return { state: 'signed_in' }; },
        signOut: async () => {
            if (player.context && player.context.providerId === id) assert.strictEqual(player.running, false, 'retire before purging private media');
            gates[id].purges = (gates[id].purges || 0) + 1;
            return { state: 'signed_out' };
        },
        preparePlayback: async (videoId, ctx) => {
            gates[id].prepares = (gates[id].prepares || 0) + 1;
            if (gates[id].prepare) await gates[id].prepare.promise;
            return { id: videoId, cacheDir: ctx.cacheDir, fetcher: ['python', 'fixture.py'] };
        }
    }));
    const gateway = new Gateway({ player, providers, stateDir: path.join(os.tmpdir(), 'fixture-state'), cacheDir: path.join(os.tmpdir(), 'fixture-cache') });
    const sockets = {}, clients = {};
    Object.keys(gates).forEach((id) => { sockets[id] = new Socket(); clients[id] = gateway.connect(id, sockets[id]); });
    return { player, gates, gateway, sockets, clients };
}

(async () => {
    const f = fixture(), g = f.gateway, vk = f.clients.vk;
    await g.dispatch(vk, { cmd: 'play', id: '-123_456' });
    await turn();
    assert.strictEqual(f.player.running, true);
    const old = [];
    ['search', 'feed', 'thumb', 'status'].forEach((name) => { f.gates.vk[name] = deferred(); });
    old.push(g.dispatch(vk, { cmd: 'search', q: 'private' }));
    old.push(g.dispatch(vk, { cmd: 'feed', which: 'home' }));
    old.push(g.dispatch(vk, { cmd: 'thumb', id: '-123_456' }));
    old.push(g.dispatch(vk, { cmd: 'auth_status' }));
    f.gates.vk.prepare = deferred();
    const latePlay = g.dispatch(vk, { cmd: 'play', id: '-123_789' });
    f.player.gate = deferred();
    const logout = g.dispatch(vk, { cmd: 'sign_out' });
    const secondLogout = g.dispatch(vk, { cmd: 'sign_out' });
    await turn();
    assert.strictEqual(f.gates.vk.purges || 0, 0);
    const afterReset = f.sockets.vk.messages.length;
    f.player.emit({ ev: 'state', state: 'idle', id: '-123_456', title: 'Old private title' });
    f.player.emit({ ev: 'positions', items: [{ id: '-123_456', title: 'Old private title' }] });
    g.emitProvider('vk', { ev: 'auth', state: 'signed_in' });
    ['search', 'feed', 'thumb', 'status'].forEach((name) => f.gates.vk[name].resolve());
    f.gates.vk.prepare.resolve();
    await Promise.all(old.concat([latePlay]));
    await g.dispatch(vk, { cmd: 'play', id: '-123_999' });
    assert.strictEqual(f.gates.vk.prepares, 2, 'new playback is blocked while exiting');
    assert.strictEqual(f.player.configs, 1, 'pending private playback does not restart');
    assert.deepStrictEqual(f.sockets.vk.messages.slice(afterReset), [], 'old content/auth/thumbnail cannot repopulate the signed-out UI');
    f.player.gate.resolve();
    await Promise.all([logout, secondLogout]);
    assert.strictEqual(f.gates.vk.purges, 1, 'concurrent sign-outs purge only once');
    assert.strictEqual(g.owner, null);
    assert.strictEqual(f.sockets.vk.messages[f.sockets.vk.messages.length - 1].state, 'signed_out');
    await g.close();

    const other = fixture(), h = other.gateway;
    await h.dispatch(other.clients.youtube, { cmd: 'play', id: 'abcdefghijk' });
    await turn();
    const retires = other.player.retireCount;
    other.gates.rutube.prepare = deferred();
    const otherPlay = h.dispatch(other.clients.rutube, { cmd: 'play', id: 'a'.repeat(32) });
    await h.dispatch(other.clients.vk, { cmd: 'sign_out' });
    assert.strictEqual(other.player.retireCount, retires, 'logging out VK preserves YouTube playback');
    assert.strictEqual(other.player.running, true);
    other.gates.rutube.prepare.resolve();
    await otherPlay;
    await turn();
    assert.strictEqual(h.owner.providerId, 'rutube', 'another provider pending play survives VK sign-out');
    await h.close();
    console.log('ok: account logout retires before purge, drops private replies/play, and preserves other providers');
})().catch((error) => { console.error(error); process.exit(1); });
