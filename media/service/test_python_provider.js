'use strict';
// Runs under Node 8 as well as modern Node; all children are controlled local fixtures.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const PassThrough = require('stream').PassThrough;
const PythonProvider = require('./python_provider.js').PythonProvider;

const VIDEO = '03a9cb54bac3376af4c5cb0f18444e01';
const SECRET = 'fixture-access-private';
const DEVICE = 'fixture-device-private';
const CARD = { id: VIDEO, title: 'Test video', channel: 'Test channel', duration_s: 293,
    thumbnail: 'https://pic.rutubelist.ru/fixture.jpg', url: 'https://rutube.ru/video/' + VIDEO + '/',
    playback: { url: 'https://bl.rutube.ru/route/private.m3u8?sign=private' } };

async function rejects(promise, expected) {
    let error;
    try { await promise; } catch (e) { error = e; }
    assert.ok(error, 'expected rejection');
    if (expected) assert.ok(expected.test(error.code + ' ' + error.message), String(error));
    return error;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

function timerFixture() {
    let next = 0;
    const pending = new Map();
    return {
        pending: pending,
        set: (fn, delay) => { const token = { id: ++next, unref: function () {} }; pending.set(token, { fn: fn, delay: delay }); return token; },
        clear: (token) => pending.delete(token),
        fire: (wanted) => {
            const entry = Array.from(pending.entries()).find((row) => wanted(row[1]));
            assert.ok(entry, 'missing requested timer'); pending.delete(entry[0]); entry[1].fn();
        }
    };
}

function fakeSpawn(handler) {
    const calls = [];
    const spawn = (binary, argv, options) => {
        const child = new EventEmitter();
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        const call = { binary: binary, argv: argv, options: options, child: child, chunks: [], killed: false };
        calls.push(call);
        child.kill = () => { call.killed = true; return true; }; // a stubborn child may answer after cancellation
        call.finish = (value, code) => {
            const bytes = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
            child.stdout.write(bytes); child.stdout.end(); child.stderr.end(); child.emit('close', code || 0);
        };
        child.stdin.on('data', (chunk) => call.chunks.push(Buffer.from(chunk)));
        child.stdin.on('end', () => {
            call.input = Buffer.concat(call.chunks);
            if (argv.indexOf('/decoder.js') < 0) call.request = JSON.parse(call.input.toString());
            Promise.resolve().then(() => handler(call)).then((result) => {
                if (result !== undefined) call.finish(result);
            }).catch((error) => child.emit('error', error));
        });
        return child;
    };
    spawn.calls = calls;
    return spawn;
}

function removeTree(root) {
    const absolute = path.resolve(root), parent = path.resolve(os.tmpdir()) + path.sep;
    if (absolute.indexOf(parent) !== 0 || path.basename(absolute).indexOf('python-provider-') !== 0) throw new Error('unsafe test cleanup');
    const remove = (file) => {
        const st = fs.lstatSync(file);
        if (st.isDirectory() && !st.isSymbolicLink()) { fs.readdirSync(file).forEach((name) => remove(path.join(file, name))); fs.rmdirSync(file); }
        else fs.unlinkSync(file);
    };
    remove(absolute);
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'python-provider-'));
    const owned = [];
    let clock = 1800000000000;
    const timers = timerFixture();
    let pollCall = null;
    const account = { provider: 'rutube', tokens: { access_token: SECRET, refresh_token: 'fixture-refresh-private', verified: true } };
    const pending = () => ({ provider: 'rutube', pending: { device_code: DEVICE, user_code: 'abc123',
        next_poll_at: clock / 1000 + 10, expires_at: clock / 1000 + 1200, interval: 10 } });
    const spawn = fakeSpawn((call) => {
        if (!call.request) return Buffer.alloc(320 * 180 * 4, 7);
        const request = call.request;
        if (request.op === 'auth_begin') return { public: { state: 'code', code: 'abc123', url: 'https://rutube.ru/activate/?user_code=abc123',
            expires: 1200, access_token: SECRET, device_code: DEVICE, private: account }, private: pending() };
        if (request.op === 'auth_status') return { public: { state: 'signed_in', access_token: SECRET, cookies: 'private-cookie' }, private: account };
        if (request.op === 'auth_poll') { pollCall = call; return undefined; }
        if (request.op === 'sign_out') return { public: { state: 'signed_out' }, private: { tokens: { access_token: 'must-not-restore' } } };
        if (request.op === 'thumb') return { result: { jpeg: Buffer.from([255, 216, 255, 217]).toString('base64') } };
        if (request.op === 'resolve') return { result: Object.assign({}, CARD, { provider: 'rutube',
            created_at: clock / 1000, url: CARD.playback.url }), private: request.private };
        return { result: { items: [Object.assign({}, CARD, { access_token: SECRET })],
            shelves: [{ title: 'Videos', items: [CARD] }], private: account }, private: account };
    });
    const provider = new PythonProvider({ id: 'rutube', getUid: () => 20202,
        spawn: spawn, chownSync: (file, uid, gid) => owned.push({ file: file, uid: uid, gid: gid }),
        python: '/python', node22: '/node22', workerPath: '/worker.py', decoderPath: '/decoder.js',
        setTimeout: timers.set, clearTimeout: timers.clear, now: () => clock });
    const ctx = Object.freeze({ providerId: 'rutube', proxyPolicy: 'direct',
        stateDir: path.join(root, 'state', 'rutube'), cacheDir: path.join(root, 'cache', 'rutube') });
    const events = [];
    provider.attach((event) => events.push(event));
    try {
        const result = await provider.search('science', ctx);
        assert.deepStrictEqual(Object.keys(result.items[0]).sort(), ['channel', 'duration_s', 'id', 'title']);
        assert.strictEqual(result.items[0].id, VIDEO);
        assert.ok(!JSON.stringify(result).includes(SECRET));
        assert.ok(!JSON.stringify(result).includes('https://'));
        const worker = spawn.calls[0];
        assert.deepStrictEqual(worker.options.env, {});
        assert.strictEqual(worker.options.cwd, '/');
        assert.strictEqual(worker.options.uid, 20202);
        assert.strictEqual(worker.options.gid, 20202);
        assert.ok(!JSON.stringify(worker.argv).includes(SECRET));
        const stateFile = path.join(ctx.stateDir, 'account.json');
        assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).tokens.access_token, SECRET);
        assert.ok(owned.some((o) => o.uid === 0 && o.file.indexOf('account.json.') >= 0));
        if (process.platform !== 'win32') assert.strictEqual(fs.statSync(stateFile).mode & 0o777, 0o600);

        const status = await provider.status(ctx);
        assert.deepStrictEqual(status, { state: 'signed_in' });
        const job = await provider.preparePlayback(VIDEO, ctx);
        assert.strictEqual(job.cacheDir, ctx.cacheDir);
        assert.ok(job.fetcher.indexOf('--job-dir') > 0);
        assert.ok(!JSON.stringify(job).includes('sign=private'));
        assert.ok(!JSON.stringify(job).includes(SECRET));
        const jobFile = path.join(ctx.cacheDir, 'jobs', VIDEO + '.json');
        assert.strictEqual(JSON.parse(fs.readFileSync(jobFile, 'utf8')).url, CARD.playback.url);
        assert.ok(owned.some((o) => o.uid === 20202 && o.file.indexOf(VIDEO + '.json.') >= 0));
        await rejects(provider.preparePlayback('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ctx), /unknown_video/);
        await rejects(provider.preparePlayback('../account', ctx), /unknown_video/);
        await rejects(provider.search('x', Object.assign({}, ctx, { providerId: 'youtube' })), /invalid_context/);
        await rejects(provider.search('x', Object.assign({}, ctx, { proxyPolicy: 'youtube' })), /invalid_context/);

        // Resume survives an empty in-memory registry after a service restart. Only a
        // complete provider-local media cache or root-owned position can grant this ID.
        const videoDir = path.join(ctx.cacheDir, VIDEO);
        fs.mkdirSync(videoDir);
        fs.writeFileSync(path.join(videoDir, 'meta.json'), JSON.stringify(CARD));
        ['audio.m4a', 'index.bin', 'video.h264'].forEach((name) => fs.writeFileSync(path.join(videoDir, name), 'fixture'));
        let resumeOffline = false;
        const resumeSpawn = fakeSpawn(() => resumeOffline ? { error: { code: 'network_error', message: 'Offline' } }
            : { result: Object.assign({}, CARD, { provider: 'rutube', url: CARD.playback.url, created_at: clock / 1000 }) });
        const resumed = new PythonProvider({ id: 'rutube', noSetuid: true, spawn: resumeSpawn,
            setTimeout: timers.set, clearTimeout: timers.clear });
        const cached = await resumed.preparePlayback(VIDEO, ctx);
        assert.strictEqual(cached.metadata.title, CARD.title);
        assert.strictEqual(resumeSpawn.calls.length, 0, 'complete cache resumes offline');
        await resumed.refreshPlayback(VIDEO, ctx);
        assert.strictEqual(resumeSpawn.calls.length, 1, 'quality refresh resolves new signed URLs despite a complete cache');
        assert.strictEqual(resumeSpawn.calls[0].request.op, 'resolve');
        assert.strictEqual(JSON.parse(fs.readFileSync(jobFile, 'utf8')).url, CARD.playback.url);
        assert.strictEqual(fs.readFileSync(path.join(videoDir, 'video.h264'), 'utf8'), 'fixture', 'refresh does not delete playing media');
        const previousJob = fs.readFileSync(jobFile, 'utf8');
        resumeOffline = true;
        await rejects(resumed.refreshPlayback(VIDEO, ctx), /network_error/);
        assert.strictEqual(fs.readFileSync(jobFile, 'utf8'), previousJob, 'failed refresh does not replace the last valid private job');
        assert.strictEqual(fs.readFileSync(path.join(videoDir, 'video.h264'), 'utf8'), 'fixture', 'failed refresh preserves playing media');
        resumeOffline = false;
        await rejects(resumed.refreshPlayback('../account', ctx), /unknown_video/);
        resumed.close();
        fs.unlinkSync(path.join(videoDir, 'video.h264'));
        const positionFile = path.join(ctx.cacheDir, 'positions.json');
        fs.writeFileSync(positionFile, JSON.stringify({ [VIDEO]: { ms: 15000, title: CARD.title } }));
        const partial = new PythonProvider({ id: 'rutube', noSetuid: true, spawn: resumeSpawn,
            setTimeout: timers.set, clearTimeout: timers.clear });
        const resolves = resumeSpawn.calls.length;
        await partial.preparePlayback(VIDEO, ctx);
        assert.strictEqual(resumeSpawn.calls.length, resolves + 1, 'known partial cache is re-resolved');
        partial.close();
        fs.unlinkSync(positionFile);
        const unknown = new PythonProvider({ id: 'rutube', noSetuid: true, spawn: resumeSpawn });
        await rejects(unknown.preparePlayback(VIDEO, ctx), /unknown_video/);
        unknown.close();
        ['meta.json', 'audio.m4a', 'index.bin'].forEach((name) => fs.unlinkSync(path.join(videoDir, name)));
        fs.rmdirSync(videoDir);

        const thumb = await provider.thumb(VIDEO, ctx);
        assert.strictEqual(thumb.rgba.length, 230400);
        const decoder = spawn.calls[spawn.calls.length - 1];
        assert.strictEqual(decoder.binary, '/node22');
        assert.strictEqual(decoder.options.uid, 20202);
        assert.deepStrictEqual(decoder.options.env, {});
        assert.strictEqual((await provider.thumb('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ctx)), null);

        const code = await provider.auth(ctx);
        assert.strictEqual(code.state, 'code');
        assert.ok(!JSON.stringify(code).includes(DEVICE));
        assert.ok(!JSON.stringify(code).includes('access_token'));
        assert.ok(Array.from(timers.pending.values()).some((entry) => entry.delay === 10000));
        clock += 10000;
        timers.fire((entry) => entry.delay === 10000);
        await tick(); await tick();
        assert.ok(pollCall, 'poll worker started');
        assert.strictEqual(pollCall.request.private.pending.device_code, DEVICE);
        assert.ok(!JSON.stringify(pollCall.argv).includes(DEVICE));
        const signOut = provider.signOut(ctx);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { provider: 'rutube' }, 'local sign-out is immediate');
        assert.strictEqual((await signOut).state, 'signed_out');
        assert.ok(pollCall.killed, 'the old auth worker was cancelled');
        pollCall.finish({ public: { state: 'signed_in' }, private: account });
        await tick();
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { provider: 'rutube' }, 'late poll cannot restore an account');
        assert.ok(!events.some((event) => event.state === 'signed_in'), 'late poll cannot emit signed_in');
        assert.strictEqual(timers.pending.size, 0);

        // A refreshed private record accompanying search is saved, never returned to UI.
        await provider.search('again', ctx);
        assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).tokens.access_token, SECRET);
        fs.writeFileSync(path.join(ctx.stateDir, 'config.json'), JSON.stringify({ client_id: 123, redirect_uri: 'https://example.com/cb',
            proxy: 'socks5://PRIVATE:PASS@example.invalid:1080', access_token: SECRET }));
        await provider.search('config', ctx);
        const configRequest = spawn.calls[spawn.calls.length - 1].request;
        assert.strictEqual(configRequest.config.client_id, 123);
        assert.ok(!Object.prototype.hasOwnProperty.call(configRequest.config, 'proxy'));
        assert.ok(!Object.prototype.hasOwnProperty.call(configRequest.config, 'access_token'));

        // VK's HTTPS callback relay is privately configured. Only its short public
        // session URL crosses the socket; authentication and polling keys use stdin.
        const brokerKey = 'fixture_broker_key_0123456789abcdefghijkl';
        const pollToken = 'fixture_poll_token_0123456789abcdefghijklmnop';
        const authNonce = 'fixture_oauth_state_0123456789';
        const relay = 'https://relay.example.test';
        const relayUrl = relay + '/s/' + 'a'.repeat(22);
        const vkctx = Object.freeze({ providerId: 'vk', proxyPolicy: 'direct',
            stateDir: path.join(root, 'state', 'vk'), cacheDir: path.join(root, 'cache', 'vk') });
        const vkSpawn = fakeSpawn(() => ({ public: { state: 'code', url: relayUrl,
            broker_key: brokerKey, broker_poll_token: pollToken, state_nonce: authNonce,
            msg: 'Confirm ' + brokerKey + ' ' + pollToken + ' ' + authNonce }, private: {
            pending: { broker_poll_token: pollToken, state: authNonce, poll_interval: 5,
                expires_at: clock / 1000 + 600 } } }));
        const vk = new PythonProvider({ id: 'vk', noSetuid: true, spawn: vkSpawn,
            setTimeout: timers.set, clearTimeout: timers.clear, now: () => clock });
        vk._dirs(vkctx);
        fs.writeFileSync(path.join(vkctx.stateDir, 'config.json'), JSON.stringify({ client_id: 123,
            redirect_uri: relay + '/callback', callback_broker: relay, broker_key: brokerKey,
            proxy: 'must-not-forward', access_token: SECRET }));
        const relayState = await vk.auth(vkctx);
        assert.strictEqual(relayState.url, relayUrl, 'configured short relay URL is allowed for QR');
        [brokerKey, pollToken, authNonce].forEach((secret) => assert.ok(!JSON.stringify(relayState).includes(secret)));
        const vkCall = vkSpawn.calls[0];
        assert.strictEqual(vkCall.request.config.callback_broker, relay);
        assert.strictEqual(vkCall.request.config.broker_key, brokerKey);
        assert.ok(!JSON.stringify(vkCall.argv).includes(brokerKey));
        assert.ok(!Object.prototype.hasOwnProperty.call(vkCall.request.config, 'proxy'));
        assert.ok(!Object.prototype.hasOwnProperty.call(vkCall.request.config, 'access_token'));
        assert.ok(Array.from(timers.pending.values()).some((entry) => entry.delay === 5000));
        assert.strictEqual(vk._public({ state: 'code', url: 'https://other.example.test/s/' + 'a'.repeat(22) }).url, undefined);
        assert.strictEqual(vk._public({ state: 'code', url: relayUrl + '?poll_token=' + pollToken }).url, undefined);
        assert.strictEqual(vk._public({ state: 'code', url: 'https://id.vk.ru/authorize?state=' + authNonce }).url, undefined);
        vk.close();

        // Refresh/expiry/login completion may arrive with ordinary content, not
        // only an explicit auth_status command. Its private/public changes must
        // be persisted and emitted as one current-generation operation.
        const contentTimers = timerFixture(), contentEvents = [];
        let contentMode = 'success', heldContent = null;
        const contentSpawn = fakeSpawn((call) => {
            if (call.request.op === 'sign_out') return { public: { state: 'signed_out' }, private: {} };
            if (contentMode === 'held') { heldContent = call; return undefined; }
            const value = { result: call.request.op === 'resolve'
                ? Object.assign({}, CARD, { provider: 'rutube', url: CARD.playback.url, created_at: clock / 1000 })
                : { items: [CARD] } };
            if (contentMode === 'success') return Object.assign(value, { private: account,
                auth: { state: 'signed_in', access_token: SECRET } });
            if (contentMode === 'pending') return Object.assign(value, { private: pending(),
                auth: { state: 'code', code: 'abc123', url: 'https://rutube.ru/activate', device_code: DEVICE } });
            if (contentMode === 'error') return Object.assign(value, { private: {},
                auth: { state: 'error', msg: 'Account expired', refresh_token: SECRET } });
            return { error: { code: 'auth_required', message: 'Account expired' }, private: {},
                auth: { state: 'error', msg: 'Account expired' } };
        });
        const contentProvider = new PythonProvider({ id: 'rutube', noSetuid: true, spawn: contentSpawn,
            setTimeout: contentTimers.set, clearTimeout: contentTimers.clear, now: () => clock });
        const contentCtx = Object.freeze({ providerId: 'rutube', proxyPolicy: 'direct',
            stateDir: path.join(root, 'state', 'content-rutube'), cacheDir: path.join(root, 'cache', 'content-rutube') });
        contentProvider.attach((event) => contentEvents.push(event));
        try {
            await contentProvider.search('refresh', contentCtx);
            await contentProvider.feed('home', contentCtx);
            await contentProvider.preparePlayback(VIDEO, contentCtx);
            assert.strictEqual(contentEvents.filter((event) => event.state === 'signed_in').length, 3,
                'search/feed/resolve each publish the account update accompanying their content');
            assert.ok(!JSON.stringify(contentEvents).includes(SECRET));
            contentMode = 'pending';
            await contentProvider.search('still pending', contentCtx);
            assert.strictEqual(contentEvents[contentEvents.length - 1].state, 'code');
            assert.ok(Array.from(contentTimers.pending.values()).some((entry) => entry.delay === 10000),
                'pending auth returned with content schedules the advertised poll');
            contentMode = 'error';
            await contentProvider.search('expired', contentCtx);
            assert.strictEqual(contentEvents[contentEvents.length - 1].state, 'error');
            assert.strictEqual(contentTimers.pending.size, 0, 'an account expiry cancels the old auth poll');
            const contentState = path.join(contentCtx.stateDir, 'account.json');
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(contentState, 'utf8')), { provider: 'rutube' });
            contentMode = 'content_error';
            const emitted = contentEvents.length;
            await rejects(contentProvider.search('denied', contentCtx), /auth_required/);
            assert.strictEqual(contentEvents.length, emitted + 1, 'publish auth loss even when content itself fails');
            assert.strictEqual(contentEvents[contentEvents.length - 1].state, 'error');

            contentMode = 'held';
            const stale = rejects(contentProvider.search('stale', contentCtx), /provider_cancelled/);
            await tick(); await tick();
            assert.ok(heldContent);
            await contentProvider.signOut(contentCtx);
            await stale;
            const afterSignOut = contentEvents.length;
            heldContent.finish({ result: { items: [CARD] }, private: account,
                auth: { state: 'signed_in' } });
            await tick();
            assert.strictEqual(contentEvents.length, afterSignOut, 'late content cannot publish an old account');
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(contentState, 'utf8')), { provider: 'rutube' });
            assert.strictEqual(contentTimers.pending.size, 0);

            contentProvider._schedule({ private: pending() }, contentCtx, contentProvider.generation);
            assert.strictEqual(contentTimers.pending.size, 1);
            contentProvider._schedule({ private: {} }, contentCtx, contentProvider.generation - 1);
            assert.strictEqual(contentTimers.pending.size, 1, 'a stale scheduling continuation cannot cancel a new auth timer');
        } finally {
            contentProvider.close();
        }
        assert.strictEqual(contentTimers.pending.size, 0);

        // Close kills outstanding workers and leaves no timers/state restoration path.
        await provider.auth(ctx);
        assert.ok(timers.pending.size > 0);
        provider.close();
        assert.strictEqual(timers.pending.size, 0);
        assert.strictEqual(provider.children.size, 0);
        await rejects(provider.search('after close', ctx), /provider_cancelled/);

        // Invalid/oversized child output is rejected without echoing its content.
        for (const payload of ['not-json private-device-code', Buffer.alloc(4 * 1024 * 1024 + 1)]) {
            const bad = new PythonProvider({ id: 'rutube', noSetuid: true,
                spawn: fakeSpawn(() => payload), setTimeout: timers.set, clearTimeout: timers.clear });
            const error = await rejects(bad.search('test', ctx), /worker_json|worker_limit/);
            assert.ok(!error.message.includes('private-device-code'));
            bad.close();
        }
        const heldSpawn = fakeSpawn(() => undefined);
        const timed = new PythonProvider({ id: 'rutube', noSetuid: true, spawn: heldSpawn, timeoutMs: 1000,
            setTimeout: timers.set, clearTimeout: timers.clear });
        const timeoutResult = rejects(timed.search('timeout', ctx), /worker_timeout/);
        await tick(); timers.fire((entry) => entry.delay === 1000); await timeoutResult;
        assert.ok(heldSpawn.calls[0].killed);
        timed.close();
        assert.strictEqual(timers.pending.size, 0);
        console.log('ok: Python provider UID/stdin isolation, private state, safe UI, jobs/thumbs, poll generations, limits and close');
    } finally {
        provider.close();
        removeTree(root);
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
