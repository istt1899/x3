'use strict';
const assert = require('assert');
const path = require('path');
const { accountView } = require('./account-view');
const apps = path.join(__dirname, '..', 'core', 'apps');

const definitions = [
    ['marku_vk_video', '-230138956_456239834'],
    ['marku_rutube', '0123456789abcdef0123456789abcdef'],
];

definitions.forEach(([appId, videoId]) => {
    const { Model, validId, SOCKET, SERVICE } = require(path.join(apps, appId, 'yt'));
    const sent = [], model = new Model((message) => { sent.push(message); return true; });
    model.setConnected(true);
    assert.ok(validId(videoId));
    assert.strictEqual(SOCKET, '/run/jap-ridetube-d/' + SERVICE.id + '.sock');
    assert.ok(!sent.some((message) => message.cmd === 'auth'), 'connecting must not start login');
    model.onMsg({ ev: 'auth', state: 'signed_out' });
    assert.ok(model.feed('home'), 'public home must load without an account');
    assert.ok(model.search('Автомобили'), 'guest search must remain available');
    model.onMsg({ ev: 'results', q: 'Автомобили', items: [
        { id: videoId, title: 'Тест видео', channel: 'Канал', duration_s: 125 },
        { id: 'https://attacker.invalid/private', title: 'not a video ID' },
    ] });
    assert.strictEqual(model.results.length, 1);
    assert.strictEqual(model.results[0].id, videoId);
    assert.ok(model.wantThumb(videoId));
    assert.ok(model.play(videoId, '1600x600', false), 'full VK/RUTUBE IDs must play');
    const before = sent.length;
    assert.strictEqual(model.play('../state/account.json', '1600x600', false), false);
    assert.strictEqual(sent.length, before, 'a path cannot become a playback request');
    model.onMsg({ ev: 'results', provider: SERVICE.id === 'vk' ? 'rutube' : 'vk', items: [] });
    assert.strictEqual(model.results.length, 1, 'another provider cannot change this app model');
    model.onMsg({ ev: 'auth', state: 'signed_in', name: 'Тест', access_token: 'PRIVATE', refresh_token: 'PRIVATE2' });
    assert.strictEqual(accountView(model.auth, SERVICE).kind, 'signed_in');
    assert.ok(JSON.stringify(model.auth).indexOf('PRIVATE') < 0, 'tokens must not enter UI account state');
    model.onMsg({ ev: 'auth', state: 'error', msg: 'Не удалось подключиться' });
    assert.strictEqual(accountView(model.auth, SERVICE).kind, 'error');
    assert.ok(model.authStart(true), 'a failed login can be retried deliberately');
    assert.ok(!model.authStart(true), 'a pending attempt is not repeatedly restarted');
    assert.ok(model.checkAuth(Date.now() + 100000, 90000), 'silent login must reach an error');
    model.onMsg({ ev: 'auth', state: 'code', code: '123456', url: 'https://rutube.ru/activate' });
    assert.ok(model.authStart(true), 'an explicit retry action can refresh a code; opening a page cannot');
});

const vk = require(path.join(apps, 'marku_vk_video', 'service-config'));
const rt = require(path.join(apps, 'marku_rutube', 'service-config'));
const activation = accountView({ state: 'code', code: '123456', url: 'https://rutube.ru/activate' }, rt);
assert.strictEqual(activation.kind, 'code');
assert.strictEqual(activation.code, '123456');
assert.strictEqual(activation.url, 'https://rutube.ru/activate');
const long = accountView({ state: 'code', url: 'https://id.vk.ru/authorize?client_id=123&code_challenge=' + 'a'.repeat(80) }, vk);
assert.strictEqual(long.kind, 'setup');
assert.strictEqual(long.url, undefined, 'a long URL must not become an unrelated QR address');
const wrong = accountView({ state: 'code', code: '123456', url: 'https://www.google.com/device' }, rt);
assert.strictEqual(wrong.kind, 'error');
const setup = accountView({ state: 'error', code: 'configuration_required', msg: 'Нужен client_id VK ID' }, vk);
assert.strictEqual(setup.kind, 'setup');
const shortRelay = 'https://vk.example/s/' + 's'.repeat(22);
assert.strictEqual(accountView({ state: 'code', url: shortRelay }, vk).kind, 'code');
assert.strictEqual(accountView({ state: 'code', url: shortRelay }, rt).kind, 'error');
[
    shortRelay + '?poll_token=secret', shortRelay + '#private', shortRelay.replace('https:', 'http:'),
    shortRelay.replace('vk.example', 'user:password@vk.example'), 'https://vk.example/redirect',
    'https://www.google.com/device',
].forEach((url) => assert.strictEqual(accountView({ state: 'code', url }, vk).kind, 'error'));
assert.ok(!JSON.stringify([activation, long, wrong, setup]).includes('google.com/device'));
console.log('ok: separate service identities, guest browse/search, long IDs, account states, no fake QR or token exposure');
