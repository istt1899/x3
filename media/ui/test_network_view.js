'use strict';
const assert = require('assert');
const Events = require('events');
const { attachNetwork } = require('./network-view');

const ctl = new Events(), sent = [], labels = {}, clicks = {}, opened = [];
let refreshed = 0;
ctl.send = (message) => { sent.push(message); return true; };
attachNetwork({ spec: { id: 'marku_vk_video' }, ui: {
    text: (key, value) => { labels[key] = value; },
    onClick: (key, fn) => { clicks[key] = fn; },
    open: (screen) => { opened.push(screen); },
} }, ctl, () => { refreshed++; });
const last = () => sent[sent.length - 1];
const result = (source, provider, downloadMbps, extras) => Object.assign({
    source, provider, downloadMbps, ok: true, speedTested: true,
    shortSample: false, serviceAvailable: true, latencyMs: 120,
}, extras || {});
const report = (external, builtin, extras) => ctl.emit('msg', Object.assign({
    ev: 'network', source: 'external', busy: false, results: { external, builtin },
}, extras || {}));
const noRecommendation = (reason) => {
    assert(!/^Рекомендуем:/.test(labels.BTN_NET_EXTERNAL), reason + ': external');
    assert(!/^Рекомендуем:/.test(labels.BTN_NET_BUILTIN), reason + ': builtin');
    assert(!/По этому замеру быстрее/.test(labels.NET_WINNER), reason + ': comparison');
};

ctl.emit('up'); assert.deepStrictEqual(last(), { cmd: 'network_status' });
clicks.BTN_NETWORK();
assert.deepStrictEqual(last(), { cmd: 'network_status' }, 'opening requests fresh status');
assert.strictEqual(opened.pop(), 'NETWORK');
clicks.BTN_MAIN_NETWORK();
assert.deepStrictEqual(last(), { cmd: 'network_status' }, 'MAIN keeps its own HMI route');
assert.strictEqual(opened.pop(), 'NETWORK');
report(null, null);
assert(/Источник: Внешнее/.test(labels.NET_CURRENT));
assert.strictEqual(refreshed, 0);
clicks.BTN_NET_BUILTIN();
assert.deepStrictEqual(last(), { cmd: 'network_set', source: 'builtin' }, 'manual selection is a single click');
report(null, null, { busy: true, testing: 'builtin' });
assert(/проверяем/.test(labels.NET_BUILTIN));
const count = sent.length;
clicks.BTN_NET_TEST(); assert.strictEqual(sent.length, count, 'a second operation is blocked while busy');
clicks.BTN_NET_CANCEL(); assert.deepStrictEqual(last(), { cmd: 'network_cancel' });
report(null, null, { busy: false, error: 'Нужна первичная проверка MGU' });
assert(/первичная/.test(labels.NET_ERROR)); assert.strictEqual(refreshed, 1);

report(result('external', 'vk', 5), result('builtin', 'vk', 10), { source: 'builtin' });
assert.strictEqual(labels.NET_ERROR, '', 'a fresh successful status clears a prior error');
assert(/По этому замеру быстрее.*BMW/.test(labels.NET_WINNER));
assert(/VK Видео доступен/.test(labels.NET_WINNER));
assert(/^Рекомендуем:/.test(labels.BTN_NET_BUILTIN), 'the existing BMW button carries the recommendation');
assert(!/^Рекомендуем:/.test(labels.BTN_NET_EXTERNAL), 'the other manual choice remains plain');
assert.strictEqual(refreshed, 2);
clicks.BTN_NET_BUILTIN();
assert.deepStrictEqual(last(), { cmd: 'network_set', source: 'builtin' }, 'recommended channel selected in one click');
report(result('external', 'vk', 11), result('builtin', 'vk', 5));
assert(/^Рекомендуем:/.test(labels.BTN_NET_EXTERNAL));
clicks.BTN_NET_EXTERNAL();
assert.deepStrictEqual(last(), { cmd: 'network_set', source: 'external' });

const goodExternal = result('external', 'vk', 5), goodBuiltin = result('builtin', 'vk', 10);
for (const [reason, external, builtin] of [
    ['another service', result('external', 'youtube', 5), result('builtin', 'youtube', 10)],
    ['mixed services', result('external', 'vk', 5), result('builtin', 'rutube', 10)],
    ['VK unavailable', goodExternal, result('builtin', 'vk', 10, { serviceAvailable: false })],
    ['failed channel', result('external', 'vk', 5, { ok: false }), goodBuiltin],
    ['short sample', result('external', 'vk', 5, { shortSample: true }), goodBuiltin],
    ['missing sample flag', result('external', 'vk', 5, { shortSample: undefined }), goodBuiltin],
    ['speed not tested', result('external', 'vk', 5, { speedTested: false }), goodBuiltin],
    ['missing speed', result('external', 'vk', undefined), goodBuiltin],
    ['wrong source', result('builtin', 'vk', 5), goodBuiltin],
    ['similar speeds', result('external', 'vk', 9), goodBuiltin],
]) {
    report(external, builtin);
    noRecommendation(reason);
}
report(goodExternal, goodBuiltin, { busy: true, testing: 'external' });
noRecommendation('running test');
clicks.BTN_NET_BACK();
assert.deepStrictEqual(last(), { cmd: 'network_cancel' }, 'return cancels an active test');
assert.strictEqual(opened.pop(), 'VIEW');
report(goodExternal, goodBuiltin);
clicks.BTN_NET_TEST();
assert.deepStrictEqual(last(), { cmd: 'network_test' }, 'test can be requested');
assert.strictEqual(labels.NET_ERROR, '');
for (const [id, service] of [['marku_rutube', 'rutube'], ['jap_ridetube', 'youtube']]) {
    const otherCtl = new Events(), otherLabels = {}, otherClicks = {};
    otherCtl.send = () => true;
    attachNetwork({ spec: { id }, ui: {
        text: (key, value) => { otherLabels[key] = value; },
        onClick: (key, fn) => { otherClicks[key] = fn; }, open() {},
    } }, otherCtl);
    otherCtl.emit('msg', { ev: 'network', source: 'external', busy: false, results: {
        external: result('external', service, 5), builtin: result('builtin', service, 10),
    } });
    assert(/^Рекомендуем:/.test(otherLabels.BTN_NET_BUILTIN), service + ' accepts its own full comparison');
    otherCtl.emit('msg', { ev: 'network', source: 'external', busy: false, results: {
        external: goodExternal, builtin: goodBuiltin,
    } });
    assert(!/^Рекомендуем:/.test(otherLabels.BTN_NET_BUILTIN), service + ' ignores stale VK results');
    assert.strictEqual(typeof otherClicks.BTN_NET_EXTERNAL, 'function');
}
console.log('ok: network status, manual selection, cancel/back and service-specific full-sample recommendation');
