'use strict';
const assert = require('assert'), Events = require('events');
const { attachNetwork } = require('./network-view');
const ctl = new Events(), sent = [], labels = {}, clicks = {};
let refreshed = 0, opened = null;
ctl.send = (message) => { sent.push(message); return true; };
attachNetwork({ ui: { text: (key,value) => { labels[key] = value; }, onClick: (key,fn) => { clicks[key] = fn; }, open: (screen) => { opened = screen; } } }, ctl, () => { refreshed++; });
ctl.emit('up'); assert.strictEqual(sent[0].cmd, 'network_status');
clicks.BTN_NETWORK(); assert.strictEqual(opened, 'NETWORK');
ctl.emit('msg', { ev: 'network', source: 'external', busy: false });
assert.strictEqual(refreshed, 0);
clicks.BTN_NET_BUILTIN(); assert.deepStrictEqual(sent[sent.length-1], { cmd: 'network_set', source: 'builtin' });
ctl.emit('msg', { ev: 'network', source: 'external', busy: true, testing: 'builtin' });
assert.ok(/проверяем/.test(labels.NET_BUILTIN));
const length = sent.length; clicks.BTN_NET_TEST(); assert.strictEqual(sent.length, length, 'cannot start overlapping tests');
clicks.BTN_NET_CANCEL(); assert.strictEqual(sent[sent.length-1].cmd, 'network_cancel');
ctl.emit('msg', { ev: 'network', source: 'external', busy: false, error: 'Нужна первичная проверка MGU' });
assert.ok(/первичная/.test(labels.NET_ERROR)); assert.strictEqual(refreshed, 1);
ctl.emit('msg', { ev: 'network', source: 'builtin', busy: false, results: {
    external: { source:'external', ok:true, speedTested:true, serviceAvailable:true, downloadMbps:5, latencyMs:150 },
    builtin: { source:'builtin', ok:true, speedTested:true, serviceAvailable:true, downloadMbps:10, latencyMs:120 }
} });
assert.ok(/быстрее.*BMW/.test(labels.NET_WINNER)); assert.strictEqual(refreshed, 2);
clicks.BTN_NET_TEST(); assert.strictEqual(labels.NET_ERROR, '');
console.log('ok: source page, busy/cancel, authoritative selection, reauthentication, failure and measured comparison');
