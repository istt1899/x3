'use strict';
const assert = require('assert'), Events = require('events'), fs = require('fs'), os = require('os'), path = require('path');
const { Gateway } = require('./gateway');
const turn = () => new Promise((r) => setImmediate(r));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
class Socket extends Events {
    constructor() { super(); this.messages = []; }
    setEncoding() {}
    write(line) { this.messages.push(JSON.parse(line)); }
    destroy() { this.emit('close'); }
}
(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-network-gateway-'));
    const trace = [], heldSearch = deferred(), retired = deferred();
    const player = { async retire() { trace.push('retire'); if (this.held) { await retired.promise; this.held = false; } },
        configure(ctx) { this.context = ctx; }, play() {}, command() {} };
    const network = { source: 'external', busy: false, cache: (base, source) => (source || network.source) === 'builtin' ? path.join(base, 'native') : base,
        leaseFile: () => network.source + '-lease', state: () => ({ ev:'network', source:network.source, busy:network.busy }),
        async select(source) { trace.push('select'); network.source = source; }, async test() { trace.push('test'); }, cancel() { trace.push('cancel'); }, close() {} };
    const provider = { id:'vk', networkChanged() { trace.push('invalidate'); }, search() { return heldSearch.promise; },
        preparePlayback: async (id, ctx) => ({ id, cacheDir:ctx.cacheDir, fetcher:['python','fetch.py'] }) };
    const gateway = new Gateway({ player, providers:[provider], network, stateDir:root, cacheDir:root });
    const socket = new Socket(), session = gateway.connect('vk', socket);
    await gateway.dispatch(session, { cmd:'play', id:'-123_456' }); await turn();
    const search = gateway.dispatch(session, { cmd:'search', q:'before switch' });
    player.held = true;
    const switching = gateway.dispatch(session, { cmd:'network_set', source:'builtin' }); await turn();
    assert.strictEqual(network.busy, true);
    assert.strictEqual(trace.indexOf('select'), -1, 'retire the actual player before switching the transport');
    let rejected = false;
    try { await gateway.dispatch(session, { cmd:'play', id:'-123_457' }); } catch (e) { rejected = true; }
    assert.strictEqual(rejected, true);
    retired.resolve(); await switching;
    assert.strictEqual(network.source, 'builtin'); assert.strictEqual(network.busy, false);
    heldSearch.resolve({ items:[{ id:'-123_456', title:'stale' }] }); await search;
    assert.ok(!socket.messages.some((m) => m.ev === 'results'), 'do not deliver replies from the old transport');
    await gateway.dispatch(session, { cmd:'play', id:'-123_458' }); await turn();
    assert.strictEqual(player.context.leaseFile, 'builtin-lease');
    assert.ok(/native/.test(player.context.cacheDir));
    await gateway.dispatch(session, { cmd:'network_test' });
    assert.strictEqual(network.source, 'builtin'); assert.ok(trace.indexOf('test') > 0);
    await gateway.dispatch(session, { cmd:'network_cancel' }); assert.ok(trace.indexOf('cancel') > 0);
    await gateway.close();
    console.log('ok: transport switch retires playback, invalidates old queries, blocks overlap and preserves selection during comparison');
})().catch((e) => { console.error(e); process.exit(1); });
