'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { accountView } = require('./account-view');
const apps = path.join(__dirname, '..', 'core', 'apps');
function sourceModel(service) {
    const model = { exports: {} };
    const load = (name) => name === './service-config' ? service : require(name);
    // Exercise the editable source before the release builder copies it into apps.
    new Function('require', 'module', 'exports', fs.readFileSync(path.join(__dirname, 'model.js'), 'utf8'))(load, model, model.exports);
    return model.exports;
}

const definitions = [
    ['marku_vk_video', '-230138956_456239834'],
    ['marku_rutube', '0123456789abcdef0123456789abcdef'],
];

definitions.forEach(([appId, videoId]) => {
    const { Model, validId, SOCKET, SERVICE } = sourceModel(require(path.join(apps, appId, 'service-config')));
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

const privateId = '123_456', publicId = '-456_789', privacySent = [];
const privacy = new (sourceModel(vk).Model)((message) => { privacySent.push(message); return true; });
privacy.setConnected(true);
privacy.onMsg({ ev: 'auth', state: 'signed_in' });
privacy.feed('home');
privacy.onMsg({ ev: 'feed', which: 'home', items: [{ id: privateId, title: 'Fixture private title' }] });
privacy.search('Fixture personal query');
privacy.onMsg({ ev: 'results', q: 'Fixture personal query', items: [{ id: privateId, title: 'Fixture private title' }] });
privacy.wantThumb(privateId);
privacy.onMsg({ ev: 'thumb', id: privateId, rgba: Buffer.alloc(160 * 90 * 4, 1).toString('base64'), w: 160, h: 90 });
privacy.onMsg({ ev: 'positions', items: [{ id: privateId, title: 'Fixture private title', ms: 20000, total: 90000 }] });
assert.ok(privacy.thumbs[privateId]);
assert.strictEqual(privacy.resume.length, 1);
privacy.play(privateId, '1600x600', false);
assert.ok(privacy.signOut());
assert.ok(privacySent.some((message) => message.cmd === 'stop'), 'logout stops account playback before clearing its view');
assert.strictEqual(privacy.results.length, 0);
assert.strictEqual(privacy.feeds.home.items.length, 0);
assert.deepStrictEqual(Object.keys(privacy.thumbs), []);
assert.strictEqual(privacy.resume.length, 0);
assert.strictEqual(privacy.title, '');
assert.strictEqual(privacy.search('while signing out'), false, 'do not start another account request before logout is acknowledged');
privacy.onMsg({ ev: 'results', q: 'Fixture personal query', items: [{ id: privateId, title: 'LATE PRIVATE' }] });
privacy.onMsg({ ev: 'feed', which: 'home', items: [{ id: privateId, title: 'LATE PRIVATE' }] });
privacy.onMsg({ ev: 'thumb', id: privateId, rgba: Buffer.alloc(160 * 90 * 4).toString('base64'), w: 160, h: 90 });
privacy.onMsg({ ev: 'positions', items: [{ id: privateId, title: 'LATE PRIVATE', ms: 20000, total: 90000 }] });
privacy.onMsg({ ev: 'auth', state: 'signed_in' });
assert.ok(privacy.logoutPending, 'late signed_in cannot interrupt a deliberate logout');
privacy.onMsg({ ev: 'auth', state: 'signed_out' });
privacy.onMsg({ ev: 'state', state: 'playing', id: privateId, title: 'LATE PRIVATE' });
assert.strictEqual(privacy.results.length, 0);
assert.strictEqual(privacy.feeds.home.items.length, 0);
assert.strictEqual(privacy.resume.length, 0);
assert.strictEqual(privacy.title, '');
assert.strictEqual(privacy.play(privateId, '1600x600', false), false, 'an old private tile is no longer playable');
assert.ok(privacy.search('Public search'));
privacy.onMsg({ ev: 'results', q: 'Public search', items: [{ id: publicId, title: 'Public result' }] });
assert.strictEqual(privacy.results[0].id, publicId);
assert.ok(privacy.play(publicId, '1600x600', false), 'fresh guest search remains usable after logout');

const lost = new (sourceModel(vk).Model)(() => true);
lost.setConnected(true); lost.onMsg({ ev: 'auth', state: 'signed_in' }); lost.feed('home');
lost.onMsg({ ev: 'feed', which: 'home', items: [{ id: privateId, title: 'Private' }] });
lost.onMsg({ ev: 'auth', state: 'error', msg: 'Account expired' });
lost.onMsg({ ev: 'feed', which: 'home', items: [{ id: privateId, title: 'LATE PRIVATE' }] });
assert.strictEqual(lost.feeds.home.items.length, 0, 'auth loss clears personal home and rejects an old feed response');
console.log('ok: separate service identities, guest browse/search, long IDs, account states, no fake QR or token exposure');
