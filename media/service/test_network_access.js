'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { NetworkAccess, route } = require('./network_access');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-network-'));
const options = { stateDir: temp, cacheDir: temp, runtimeDir: temp, python: 'python',
    getExternalUid: () => 15001, getBuiltinUid: () => 15002, noSetuid: true,
    execFileSync: (file, args) => { assert.strictEqual(args[5], '15002'); return args[3] + ' via 10.0.0.1 dev eth2 src 10.0.0.2 uid 15002'; } };
(async () => {
    const n = new NetworkAccess(options);
    assert.strictEqual(n.source, 'external');
    assert.strictEqual(n.uid(), 15001);
    assert.strictEqual(n.cache('/cache'), '/cache');
    const denied = await n.probe('builtin', 'rutube', true);
    assert.strictEqual(denied.ok, false);
    assert.ok(/первичная проверка/.test(denied.message));
    assert.strictEqual(n.source, 'external', 'failed native test must not change selection');
    fs.writeFileSync(path.join(temp, 'builtin-network.json'), JSON.stringify({ verified: true,
        interface: 'eth2', sourceIp: '10.0.0.2', dns: ['10.0.0.1'] }));
    const native = n.context('builtin');
    assert.strictEqual(native.uid, 15002);
    assert.strictEqual(JSON.parse(fs.readFileSync(native.leaseFile)).networkSource, 'builtin');
    const bad = new NetworkAccess(Object.assign({}, options, { execFileSync: () => '1.1.1.1 dev wlan1 src 172.20.10.2' }));
    assert.throws(() => bad.context('builtin'), /Маршрут BMW изменился/);
    assert.throws(() => route('unreachable 1.1.1.1'), /маршрута/);
    assert.throws(() => n.context('auto'), /Неизвестный/);
    n.probe = async (source) => ({ source, ok: source === 'builtin', serviceAvailable: true });
    await n.select('builtin', 'rutube');
    assert.strictEqual(n.source, 'builtin');
    assert.strictEqual(n.uid(), 15002);
    assert.strictEqual(n.cache('/cache'), path.join('/cache', 'network-builtin'));
    assert.strictEqual(new NetworkAccess(options).source, 'builtin', 'selection survives service restart');
    await n.select('external', 'rutube');
    assert.strictEqual(n.source, 'external', 'an explicit return to external must remain possible while offline');
    n.probe = async (source) => ({ source, ok: false });
    try { await n.select('builtin', 'rutube'); assert.fail('unavailable native selection must fail'); } catch (e) {}
    assert.strictEqual(n.source, 'external', 'a failed native selection keeps the existing choice');
    const events = [];
    await n.test('rutube', (event) => events.push(event));
    assert.strictEqual(events.length, 4);
    assert.strictEqual(n.source, 'external', 'comparison does not select a network');
    let throttled = false;
    try { await n.test('rutube', () => {}); } catch (e) { throttled = /30/.test(e.message); }
    assert.strictEqual(throttled, true);
    n.close();
    console.log('ok: separate source UID/DNS/cache, verified native route, persistence, failed selection and comparison cooldown');
})().catch((e) => { console.error(e); process.exit(1); });
