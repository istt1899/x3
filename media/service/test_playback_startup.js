'use strict';
// A failed/timed out resolve must replace the UI's local preparing 0% state.
const assert = require('assert');
const { Gateway } = require('./gateway');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise((resolve) => setImmediate(resolve));

function setup(prepare) {
    const events = [], calls = [];
    const player = { retire: async () => {}, configure: () => calls.push('configure'),
        command: async () => {}, play: async () => calls.push('play') };
    const gateway = new Gateway({ player, prepareTimeoutMs: 30,
        providers: [{ id: 'vk', preparePlayback: prepare }], cacheDir: '/fixture/cache', stateDir: '/fixture/state' });
    const session = { id: 1, providerId: 'vk', closed: false, videoOn: false,
        socket: { write: (line) => events.push(JSON.parse(line)) } };
    return { gateway, session, events, calls };
}
const prepared = (id, ctx) => ({ id, cacheDir: ctx.cacheDir, fetcher: ['python', 'mediafetch.py'] });

(async () => {
    const refused = setup(async () => { throw new Error('VK не предоставил доступ к этому видео.'); });
    await refused.gateway.dispatch(refused.session, { cmd: 'play', id: '-123_456' });
    assert.deepStrictEqual(refused.events.filter((event) => event.ev === 'state').map((event) => event.state), ['preparing', 'error']);
    assert.strictEqual(refused.events[0].phase, 'resolve');
    assert.strictEqual(refused.events[2].cmd, 'play');
    assert.ok(/доступ/.test(refused.events[2].msg));
    assert.deepStrictEqual(refused.calls, []);

    const pending = deferred();
    const timed = setup(() => pending.promise);
    await timed.gateway.dispatch(timed.session, { cmd: 'play', id: '-123_456' });
    assert.ok(timed.events.some((event) => event.ev === 'state' && event.state === 'error'));
    assert.strictEqual(timed.gateway.pendingPlay, null);
    pending.resolve(prepared('-123_456', { cacheDir: '/fixture/cache/vk' }));
    await turn();
    assert.deepStrictEqual(timed.calls, [], 'late resolution after the deadline never starts playback');

    const older = deferred();
    const newer = setup((id, ctx) => id === '-1_2' ? older.promise : Promise.resolve(prepared(id, ctx)));
    const oldRequest = newer.gateway.dispatch(newer.session, { cmd: 'play', id: '-1_2' });
    await newer.gateway.dispatch(newer.session, { cmd: 'play', id: '-3_4' });
    older.reject(new Error('old resolve failed'));
    await oldRequest; await turn();
    assert.deepStrictEqual(newer.calls, ['configure', 'play']);
    assert.ok(!newer.events.some((event) => event.state === 'error' || event.ev === 'error'),
        'an older failure cannot overwrite the newer selected video');
    console.log('ok: resolve stage, visible failure, bounded deadline and stale-result rejection');
})().catch((error) => { console.error(error); process.exitCode = 1; });
