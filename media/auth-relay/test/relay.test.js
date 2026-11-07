'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRelay, validateConfig, loadConfig } = require('../server');

const KEY = 'test-only-key-not-a-real-secret-1234567890';
const CONFIG = { publicBaseUrl: 'https://vk.example', clientId: '123456',
    redirectUri: 'https://vk.example/callback', apiKey: KEY, scope: 'video' };

async function harness(t, extra = {}, options = {}) {
    const relay = createRelay({ ...CONFIG, ...extra }, options);
    await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => relay.server.close(resolve)));
    const port = relay.server.address().port;
    const request = (method, path, value, key = KEY, contentType = 'application/json') => new Promise((resolve, reject) => {
        const data = value === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(value) : value;
        const headers = { Connection: 'close' };
        if (key !== null) headers.Authorization = 'Bearer ' + key;
        if (data !== undefined) { headers['Content-Type'] = contentType; headers['Content-Length'] = Buffer.byteLength(data); }
        const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (part) => { text += part; });
            res.on('end', () => {
                let json; try { json = JSON.parse(text); } catch (error) { /* HTML */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject); req.end(data);
    });
    let serial = 0;
    const create = async (changes = {}) => request('POST', '/v1/sessions', {
        client_id: CONFIG.clientId, redirect_uri: CONFIG.redirectUri,
        state: 'state-' + String(++serial).padStart(32, 'a'), code_challenge: 'c'.repeat(43),
        code_challenge_method: 'S256', ...changes,
    });
    return { ...relay, request, create };
}

test('requires a registered HTTPS origin/application and a strong private API key', () => {
    for (const change of [{ publicBaseUrl: 'http://vk.example' }, { clientId: '' }, { apiKey: 'short' },
        { redirectUri: 'https://attacker.example/callback' }, { redirectUri: 'https://vk.example/callback?x=1' },
        { publicBaseUrl: 'https://' + 'x'.repeat(50) + '.example' }]) {
        assert.throws(() => validateConfig({ ...CONFIG, ...change }));
    }
    assert.throws(() => loadConfig({}));
});

test('full QR -> VK redirect -> callback -> one-time secret handoff; no verifier/tokens', async (t) => {
    let clock = 100000;
    const h = await harness(t, {}, { now: () => clock });
    const created = await h.create();
    assert.equal(created.status, 201);
    const session = created.json, id = session.session_id;
    assert.ok(session.poll_token.length >= 43);
    assert.ok(Buffer.byteLength(session.url) <= 62);
    assert.ok(!session.url.includes(session.poll_token));
    assert.equal((await h.request('POST', `/v1/sessions/${id}/poll`, { poll_token: 'wrong' })).status, 404);
    const location = await h.request('GET', '/s/' + id, undefined, null);
    assert.equal(location.status, 302);
    const authorize = new URL(location.headers.location);
    assert.equal(authorize.origin + authorize.pathname, 'https://id.vk.ru/authorize');
    assert.equal(authorize.searchParams.get('client_id'), CONFIG.clientId);
    assert.equal(authorize.searchParams.get('redirect_uri'), CONFIG.redirectUri);
    assert.equal(authorize.searchParams.get('code_challenge'), 'c'.repeat(43));
    assert.equal(authorize.searchParams.get('code_verifier'), null);
    const state = authorize.searchParams.get('state');
    assert.equal((await h.request('GET', '/callback?state=wrong&code=x&device_id=y', undefined, null)).status, 400);
    const pending = await h.request('POST', `/v1/sessions/${id}/poll`, { poll_token: session.poll_token });
    assert.equal(pending.json.status, 'pending');
    assert.equal((await h.request('POST', `/v1/sessions/${id}/poll`, { poll_token: session.poll_token })).status, 429);
    const query = new URLSearchParams({ state, code: 'test-authorization-code', device_id: 'test-device-id' });
    const callback = await h.request('GET', '/callback?' + query, undefined, null);
    assert.equal(callback.status, 200);
    assert.ok(!callback.text.includes('test-authorization-code'));
    assert.equal(callback.headers['referrer-policy'], 'no-referrer');
    assert.equal(callback.headers['cache-control'], 'no-store');
    assert.equal((await h.request('GET', '/callback?' + query, undefined, null)).status, 400);
    clock += 5001;
    const completed = await h.request('POST', `/v1/sessions/${id}/poll`, { poll_token: session.poll_token });
    assert.deepEqual(completed.json, { status: 'complete', state, code: 'test-authorization-code', device_id: 'test-device-id' });
    assert.equal((await h.request('POST', `/v1/sessions/${id}/poll`, { poll_token: session.poll_token })).status, 404);
    assert.equal(h.stats().sessions, 0);
});

test('API authentication and app/redirect/scope allowlist fail closed', async (t) => {
    const h = await harness(t);
    assert.equal((await h.request('POST', '/v1/sessions', {}, null)).status, 401);
    assert.equal((await h.request('POST', '/v1/sessions', {}, 'bad-key')).status, 401);
    assert.equal((await h.create({ client_id: '987654' })).status, 400);
    assert.equal((await h.create({ redirect_uri: 'https://attacker.example/callback' })).status, 400);
    assert.equal((await h.create({ scope: 'phone email' })).status, 400);
    for (const key of ['code_verifier', 'access_token', 'refresh_token', 'password']) {
        assert.equal((await h.create({ [key]: 'forbidden' })).status, 400);
    }
    assert.equal(h.stats().sessions, 0);
});

test('TTL, capacity, duplicate state and deletion bound session memory', async (t) => {
    let clock = 0;
    const h = await harness(t, { ttlMs: 1000, maxSessions: 1 }, { now: () => clock });
    const first = (await h.create()).json;
    assert.equal((await h.create()).status, 503);
    clock = 1001;
    assert.equal((await h.request('POST', `/v1/sessions/${first.session_id}/poll`, { poll_token: first.poll_token })).status, 404);
    const second = (await h.create()).json;
    assert.equal(h.stats().sessions, 1);
    assert.equal((await h.request('DELETE', '/v1/sessions/' + second.session_id, { poll_token: second.poll_token })).status, 200);
    assert.equal(h.stats().sessions, 0);
});

test('different MGU sessions cannot consume each other and callbacks cannot be injected before QR open', async (t) => {
    const h = await harness(t);
    const first = (await h.create({ state: 'a'.repeat(32) })).json;
    const second = (await h.create({ state: 'b'.repeat(32) })).json;
    assert.equal((await h.create({ state: 'a'.repeat(32) })).status, 409);
    assert.equal((await h.request('POST', `/v1/sessions/${first.session_id}/poll`, { poll_token: second.poll_token })).status, 404);
    assert.equal((await h.request('GET', '/callback?state=' + 'a'.repeat(32) + '&code=x&device_id=y', undefined, null)).status, 400);
    await h.request('GET', '/s/' + first.session_id, undefined, null);
    const payload = JSON.stringify({ state: 'a'.repeat(32), code: 'anonymous-fixture-code', device_id: 'anonymous-fixture-device' });
    const done = await h.request('POST', '/callback', 'payload=' + encodeURIComponent(payload), null, 'application/x-www-form-urlencoded');
    assert.equal(done.status, 200);
    const result = await h.request('POST', `/v1/sessions/${first.session_id}/poll`, { poll_token: first.poll_token });
    assert.equal(result.json.code, 'anonymous-fixture-code');
    assert.equal((await h.request('POST', `/v1/sessions/${second.session_id}/poll`, { poll_token: second.poll_token })).json.status, 'pending');
});

test('callback cannot deliver OAuth tokens and browser never sees a callback code', async (t) => {
    const h = await harness(t);
    const first = (await h.create({ state: 'a'.repeat(32) })).json;
    await h.request('GET', '/s/' + first.session_id, undefined, null);
    const request = { state: 'a'.repeat(32), code: 'test-code', device_id: 'test-device', access_token: 'FORBIDDEN' };
    assert.equal((await h.request('POST', '/callback', request, null)).status, 400);
    const payload = JSON.stringify({ state: 'a'.repeat(32), code: 'test-code', device_id: 'test-device' });
    assert.equal((await h.request('POST', '/callback', { payload, password: 'FORBIDDEN' }, null)).status, 400);
    assert.equal((await h.request('GET', '/callback?state=' + 'a'.repeat(32) + '&state=' + 'b'.repeat(32)
        + '&code=x&device_id=y', undefined, null)).status, 400);
    assert.equal((await h.request('GET', '/callback?state=' + 'a'.repeat(32) + '&error=access_denied', undefined, null)).status, 400);
    const result = await h.request('POST', `/v1/sessions/${first.session_id}/poll`, { poll_token: first.poll_token });
    assert.deepEqual(result.json, { status: 'complete', state: 'a'.repeat(32), error: 'access_denied' });
});

test('creation is rate-limited independently of capacity and body size is bounded', async (t) => {
    const h = await harness(t, { maxSessions: 128 });
    const huge = await h.request('POST', '/v1/sessions', { x: 'x'.repeat(5000) });
    assert.equal(huge.status, 413);
    let limited = false;
    for (let i = 0; i < 22; i++) if ((await h.create()).status === 429) limited = true;
    assert.ok(limited);
    assert.ok(h.stats().sessions <= 20);
    assert.ok(h.stats().rateBuckets <= 1024);
});
