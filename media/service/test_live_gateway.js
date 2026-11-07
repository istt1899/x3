'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Optional network smoke: Node 8 -> real pipe/Unix sockets -> real Python workers.
// Uses guest video APIs and an unapproved RUTUBE TV code. It never signs in to a
// personal account and never starts a downloader, decoder or real MGU player.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Gateway = require('./gateway').Gateway;
const PythonProvider = require('./python_provider').PythonProvider;
const TIMEOUT = 30000;
const FIRST_REQUEST_TIMEOUT = 60000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function removeTemp(directory) {
    const absolute = path.resolve(directory), parent = path.resolve(os.tmpdir()) + path.sep;
    if (absolute.indexOf(parent) !== 0 || path.basename(absolute).indexOf('live-media-gateway-') !== 0)
        throw new Error('unsafe test cleanup');
    const remove = (file) => {
        const st = fs.lstatSync(file);
        if (st.isDirectory() && !st.isSymbolicLink()) {
            fs.readdirSync(file).forEach((name) => remove(path.join(file, name)));
            fs.rmdirSync(file);
        } else fs.unlinkSync(file);
    };
    remove(absolute);
}
async function until(check, description, timeout) {
    const deadline = Date.now() + (timeout || TIMEOUT);
    for (;;) {
        const result = check();
        if (result) return result;
        if (Date.now() >= deadline) {
            const error = new Error(description); error.code = 'live_timeout'; throw error;
        }
        await delay(25);
    }
}
async function connect(socketPath) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(socketPath), messages = [];
        const client = { socket: socket, messages: messages, error: null,
            send: (message) => socket.write(JSON.stringify(message) + '\n') };
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('error', (error) => { client.error = error; reject(error); });
        socket.on('data', (chunk) => {
            buffer += chunk;
            if (Buffer.byteLength(buffer, 'utf8') > 4 * 1024 * 1024) {
                client.error = new Error('response limit'); socket.destroy(); return;
            }
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
                try { messages.push(JSON.parse(buffer.slice(0, end))); }
                catch (error) { client.error = new Error('response JSON'); }
                buffer = buffer.slice(end + 1);
            }
        });
        socket.once('connect', () => resolve(client));
    });
}
async function response(client, predicate, since, timeout) {
    return until(() => {
        if (client.error) throw new Error('socket transport failed');
        const messages = client.messages.slice(since || 0);
        const failure = messages.find((event) => event.ev === 'error');
        if (failure) throw new Error('gateway provider request failed');
        return messages.find(predicate);
    }, 'gateway response deadline', timeout);
}
class FakePlayer {
    constructor() { this.context = null; this.running = false; this.plays = 0; }
    start() {}
    retire() { this.running = false; return Promise.resolve(); }
    configure(context, emit) { this.context = context; this.emit = emit; }
    command() {}
    play(message) {
        this.running = true; this.plays++;
        this.emit({ ev: 'state', state: 'preparing', id: message.id });
    }
    status() { return { state: this.running ? 'preparing' : 'idle' }; }
    close() {}
}
function youtubeFixture() {
    return { id: 'youtube', search: async () => ({ items: [] }),
        status: async () => ({ state: 'signed_out' }), close: () => {} };
}
function safeResults(result, pattern) {
    assert.ok(Array.isArray(result.items) && result.items.length > 0, 'guest search returned videos');
    result.items.forEach((card) => {
        assert.ok(pattern.test(card.id), 'socket uses its own provider IDs');
        assert.ok(Object.keys(card).every((key) => ['id', 'title', 'channel', 'duration_s', 'meta'].indexOf(key) >= 0),
            'socket cards contain only public metadata');
    });
    const bytes = JSON.stringify(result);
    assert.ok(!/"(?:private|access_token|refresh_token|device_code|broker_key|broker_poll_token|poll_token)"\s*:/.test(bytes),
        'no private fields cross guest socket');
}
async function run() {
    if (process.argv.indexOf('--live') < 0) {
        console.log('skip: optional live gateway smoke (pass --live to contact VK/RUTUBE)'); return;
    }
    const windows = process.platform === 'win32';
    const python = process.env.LIVE_PYTHON || (windows
        ? 'C:\\Users\\Marku\\AppData\\Local\\Programs\\Python\\Python313\\python.exe' : '/usr/bin/python3');
    const node22 = process.env.LIVE_NODE22 || (windows
        ? 'D:\\BMW\\Tools\\node-v24.22.2-win-x64\\node.exe' : process.execPath);
    const pyz = process.env.LIVE_YTDLP || (windows
        ? 'D:\\BMW\\RideTube-audit-0.3.12\\service\\files\\ytdlp.pyz'
        : path.join(__dirname, '..', 'core', 'native', 'jap-ridetube-d', 'ytdlp.pyz'));
    const ca = path.join(__dirname, '..', 'runtime', 'cacert.pem');
    [python, node22, pyz, ca].forEach((file) => assert.ok(fs.existsSync(file), 'live runtime dependency exists'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-media-gateway-'));
    const options = { python: python, node22: node22, pyz: pyz, caBundle: ca,
        noSetuid: true, getUid: () => 12345, timeoutMs: 65000 };
    const vk = new PythonProvider(Object.assign({}, options, { id: 'vk' }));
    const rutube = new PythonProvider(Object.assign({}, options, { id: 'rutube' }));
    const player = new FakePlayer(), sockets = {}, clients = {};
    ['youtube', 'vk', 'rutube'].forEach((id) => {
        sockets[id] = windows ? '\\\\.\\pipe\\live-media-' + process.pid + '-' + Date.now() + '-' + id
            : path.join(root, id + '.sock');
    });
    const gateway = new Gateway({ player: player, providers: [youtubeFixture(), vk, rutube],
        sockets: sockets, stateDir: path.join(root, 'state'), cacheDir: path.join(root, 'cache') });
    try {
        await gateway.start();
        for (const id of ['youtube', 'vk', 'rutube']) clients[id] = await connect(sockets[id]);
        clients.vk.send({ cmd: 'search', q: 'NASA', provider: 'youtube' });
        clients.rutube.send({ cmd: 'search', q: 'NASA', provider: 'youtube' });
        const guest = await Promise.all(['vk', 'rutube'].map((id) => response(clients[id],
            (event) => event.ev === 'results' && event.q === 'NASA', 0, FIRST_REQUEST_TIMEOUT)));
        safeResults(guest[0], /^-?[1-9]\d{0,19}_[1-9]\d{0,19}$/);
        safeResults(guest[1], /^[0-9a-f]{32}$/);
        assert.strictEqual(clients.youtube.messages.length, 0, 'guest results stay on matching socket');
        console.log('ok: Node 8 sockets -> real Python guest search VK=' + guest[0].items.length + ' RUTUBE=' + guest[1].items.length);

        const sample = guest[1].items.find((item) => item.duration_s > 0 && item.duration_s <= 180) || guest[1].items[0];
        const beforePlay = clients.rutube.messages.length;
        clients.rutube.send({ cmd: 'play', id: sample.id });
        await response(clients.rutube, (event) => event.ev === 'state' && event.state === 'preparing', beforePlay);
        assert.ok(player.context && player.context.providerId === 'rutube' && player.context.proxyPolicy === 'direct',
            'resolved RUTUBE playback uses immutable direct context');
        const job = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'rutube', 'jobs', sample.id + '.json'), 'utf8'));
        assert.ok(job.id === sample.id && job.provider === 'rutube' && /^https:\/\//.test(job.url),
            'real resolve produced a private playback job');
        assert.ok(!JSON.stringify(player.context).includes(job.url), 'private signed URL is absent from player context');
        clients.rutube.send({ cmd: 'stop' });
        await until(() => gateway.owner === null, 'fake playback stopped');
        console.log('ok: RUTUBE resolve -> private job -> fake player (no media download)');

        const beforeQr = clients.rutube.messages.length;
        clients.rutube.send({ cmd: 'auth' });
        const auth = await response(clients.rutube, (event) => event.ev === 'auth', beforeQr);
        assert.ok(auth.state === 'code' && typeof auth.code === 'string' && /^[A-Za-z0-9]{6}$/.test(auth.code),
            'RUTUBE returned a real six-character device code');
        assert.ok(/^https:\/\/rutube\.ru\/activate\//.test(auth.url), 'RUTUBE official activation URL');
        assert.ok(!Object.keys(auth).some((key) => /private|token|device_code/.test(key)), 'QR state has no private credentials');
        const beforePoll = clients.rutube.messages.length;
        const pending = await response(clients.rutube, (event) => event.ev === 'auth', beforePoll);
        assert.ok(pending.state === 'code', 'unapproved real TV code remains pending');
        assert.ok(!clients.vk.messages.some((event) => event.ev === 'auth') && clients.youtube.messages.length === 0,
            'RUTUBE auth poll stays on RUTUBE socket');
        console.log('ok: real RUTUBE TV code and pending poll (code/URL/tokens omitted)');

        const beforeVkAuth = clients.vk.messages.length;
        clients.vk.send({ cmd: 'auth' });
        const vkAuth = await response(clients.vk, (event) => event.ev === 'auth', beforeVkAuth);
        assert.ok(vkAuth.state === 'error', 'missing VK application/relay configuration is an honest error');
        assert.ok(!clients.vk.messages.some((event) => event.ev === 'auth' && event.state === 'signed_in'),
            'guest VK access never impersonates personal sign-in');
        const beforeOut = clients.rutube.messages.length;
        clients.rutube.send({ cmd: 'sign_out' });
        await response(clients.rutube, (event) => event.ev === 'auth' && event.state === 'signed_out', beforeOut);
        assert.strictEqual(rutube.pollTimer, null, 'sign-out cancels device polling');
        console.log('ok: VK configuration blocker and RUTUBE cancellation; no personal login performed');
    } finally {
        Object.keys(clients).forEach((id) => clients[id].socket.destroy());
        await gateway.close();
        // Children do not write any account file directly. Let cancelled pipes close
        // before deleting the harness-owned temporary tree on Windows.
        await delay(100);
        removeTemp(root);
    }
}
run().catch((error) => {
    // Do not echo responses, URLs, real device codes, request bodies or stack traces.
    console.error('FAIL: live gateway smoke (' + (/^[A-Za-z0-9_-]{1,80}$/.test(error.code || '') ? error.code : 'assertion') + ')');
    process.exitCode = 1;
});
