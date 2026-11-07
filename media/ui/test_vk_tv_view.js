'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic codes only. No account, API request, QR image download or real auth hash.
const assert = require('assert');
const { accountView } = require('./account-view');
const QR = require('../core/kit/runtime/qr');

const vk = { id: 'vk', title: 'VK Видео', authHosts: ['qr.vk.ru', 'id.vk.ru', 'id.vk.com'], allowConfiguredRelay: true };
const rutube = { id: 'rutube', title: 'RUTUBE', authHosts: ['rutube.ru', 'www.rutube.ru'] };
const code = 'AB12cd';
const url = 'https://qr.vk.ru/ca?q=' + code;
const view = accountView({ state: 'code', code, url, expires: 600,
    access_token: 'PRIVATE-ACCESS', anonymous_token: 'PRIVATE-ANON', auth_hash: 'PRIVATE-POLL' }, vk);

assert.strictEqual(Buffer.byteLength(url, 'utf8'), 28, 'the observed VK TV link fits the local QR capacity');
assert.strictEqual(view.kind, 'code');
assert.strictEqual(view.url, url);
assert.strictEqual(view.code, code);
assert.strictEqual(view.expires, 600, 'public expires is the provider-normalized TTL');
assert.ok(/VK.*телефоне/.test(view.hint), 'the owner confirms the account on the phone');
assert.ok(!JSON.stringify(view).includes('PRIVATE'), 'backend account/poll tokens never enter presentation');
const matrix = QR.encode(view.url);
assert.ok(matrix.length >= 21 && matrix.length <= 33);
assert.ok(matrix.every((row) => row.length === matrix.length), 'the bundled local encoder produces a square QR');
const colors = [];
assert.ok(QR.draw({ fillRect: (x, y, width, height, color) => colors.push(color) }, view.url, 0, 0, 8) > 0);
assert.ok(colors.indexOf('#ffffff') >= 0 && colors.indexOf('#000000') >= 0);

[
    'http://qr.vk.ru/ca?q=' + code,
    'https://user:password@qr.vk.ru/ca?q=' + code,
    'https://qr.vk.ru:443/ca?q=' + code,
    'https://qr.vk.ru:8443/ca?q=' + code,
    'https://qr.vk.ru.attacker.invalid/ca?q=' + code,
    'https://qr.vk.ru./ca?q=' + code,
    'https://qr.vk.ru/other?q=' + code,
    'https://qr.vk.ru/ca/?q=' + code,
    'https://qr.vk.ru/ca?q=%41B12cd',
    'https://qr.vk.ru/ca?q=OTHER6',
    'https://qr.vk.ru/ca?q=' + code + '&q=' + code,
    'https://qr.vk.ru/ca?q=' + code + '&access_token=PRIVATE',
    'https://qr.vk.ru/ca?q=' + code + '&auth_hash=PRIVATE',
    'https://qr.vk.ru/ca?q=' + code + '&redirect_uri=https://attacker.invalid',
    'https://qr.vk.ru/ca?q=' + code + '#PRIVATE',
    'https://qr.vk.ru/s/' + 's'.repeat(22),
    'https://chart.googleapis.com/chart',
    'https://id.vk.ru/?access_token=PRIVATE',
].forEach((address) => {
    const rejected = accountView({ state: 'code', code, url: address }, vk);
    assert.strictEqual(rejected.kind, 'error', 'reject a noncanonical or private activation address');
    assert.strictEqual(rejected.url, undefined, 'a rejected address cannot become a QR');
});
['', '12345', '1234567', 'АБВГДЕ', 'a_b-12'].forEach((invalid) => {
    assert.strictEqual(accountView({ state: 'code', code: invalid,
        url: 'https://qr.vk.ru/ca?q=' + invalid }, vk).kind, 'error');
});
assert.strictEqual(accountView({ state: 'code', url }, vk).kind, 'error', 'URL and visible code must agree');
assert.strictEqual(accountView({ state: 'code', code, url }, rutube).kind, 'error', 'VK code belongs only to the VK app');

// Explicitly configured old relay remains available; its mailbox contains no secret query.
const mailbox = 'https://vk.example/s/' + 's'.repeat(22);
assert.strictEqual(accountView({ state: 'code', url: mailbox }, vk).kind, 'code');
assert.strictEqual(accountView({ state: 'code', url: mailbox }, Object.assign({}, vk, { allowConfiguredRelay: false })).kind, 'error');
assert.strictEqual(accountView({ state: 'code', url: mailbox + '?poll_token=PRIVATE' }, vk).kind, 'error');
assert.strictEqual(accountView({ state: 'code', url: 'https://id.vk.ru/authorize?client_id=123&code_challenge=' + 'a'.repeat(80) }, vk).kind, 'setup');
assert.strictEqual(accountView({ state: 'code', code: '123456', url: 'https://rutube.ru/activate' }, rutube).kind, 'code');
assert.strictEqual(accountView({ state: 'signed_in', name: 'Владелец' }, vk).kind, 'signed_in');
console.log('ok: exact VK TV code link, local QR, no credential URLs, optional relay and RUTUBE preserved');
