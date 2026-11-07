'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Root owns private account files. All network/decode children run as the internet UID.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const URL = require('url').URL;

const IDS = { rutube: /^[0-9a-f]{32}$/, vk: /^-?[1-9]\d{0,19}_[1-9]\d{0,19}$/ };
const MAX_INPUT = 2 * 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_STATE = 512 * 1024;
const MAX_JPEG = 2 * 1024 * 1024;
const RGBA_SIZE = 320 * 180 * 4;
const CANCELLED = 'provider_cancelled';

function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}
function mkdir(dir, mode) {
    if (!fs.existsSync(dir)) {
        const parent = path.dirname(dir);
        if (parent !== dir) mkdir(parent, mode);
        try { fs.mkdirSync(dir, mode); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    if (!fs.lstatSync(dir).isDirectory()) throw failure('invalid_directory', 'Каталог службы недоступен.');
    fs.chmodSync(dir, mode);
}
function readJson(file, maximum) {
    try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.size > maximum) throw new Error('invalid private file');
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid private JSON');
        return value;
    } catch (e) {
        if (e.code === 'ENOENT') return {};
        throw failure('invalid_private_state', 'Не удалось прочитать приватные настройки сервиса.');
    }
}
function cleanMessage(message) {
    return String(message || 'Сервис не ответил. Повторите запрос.')
        .replace(/((?:https?|socks5h?):\/\/)[^\s/@]+:[^\s/@]*@/gi, '$1[redacted]@')
        .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
        .replace(/((?:access_token|refresh_token|anonymous_token|exchange_token|auth_hash|device_code|code_verifier|client_secret|broker_key|broker_poll_token|poll_token|state)\s*[=:]\s*)[^\s&,]+/gi, '$1[redacted]')
        .slice(0, 500);
}
function text(value, maximum) { return String(value || '').slice(0, maximum); }
function publicState(value, brokerOrigin, providerId) {
    const allowed = ['signed_out', 'code', 'signed_in', 'error'];
    const state = value && allowed.indexOf(value.state) >= 0 ? value.state : 'error';
    const result = { state: state };
    if (value && typeof value.code === 'string' && /^[A-Za-z0-9 -]{1,40}$/.test(value.code)) result.code = value.code;
    if (value && Number.isFinite(Number(value.expires))) result.expires = Math.max(0, Math.min(86400, Math.floor(Number(value.expires))));
    if (value && value.msg) result.msg = cleanMessage(value.msg);
    if (value && typeof value.url === 'string' && value.url.length <= 4096) {
        try {
            const url = new URL(value.url);
            const forbidden = ['access_token', 'refresh_token', 'device_code', 'client_secret', 'code_verifier',
                'anonymous_token', 'exchange_token', 'auth_hash', 'broker_key', 'broker_poll_token', 'poll_token', 'state'];
            let containsSecret = false;
            url.searchParams.forEach((v, key) => { if (forbidden.indexOf(key.toLowerCase()) >= 0) containsSecret = true; });
            // The VK relay's short URL is public, but its polling/PKCE credentials are not.
            // Accept only /s/<opaque-session> on the root-configured origin, never an
            // arbitrary URL returned by an extractor or a credential-bearing query.
            const brokerUrl = brokerOrigin && url.origin === brokerOrigin &&
                /^\/s\/[A-Za-z0-9_-]{22}$/.test(url.pathname) && !url.search && !url.hash;
            const tvKeys = [];
            url.searchParams.forEach((v, key) => tvKeys.push(key));
            const tvUrl = providerId === 'vk' && url.hostname === 'qr.vk.ru' && !url.port && url.pathname === '/ca' &&
                !url.hash && tvKeys.length === 1 && tvKeys[0] === 'q' && /^[A-Za-z0-9]{6}$/.test(value.code || '') &&
                url.searchParams.get('q') === value.code && value.url === 'https://qr.vk.ru/ca?q=' + value.code &&
                Buffer.byteLength(url.href, 'utf8') <= 62;
            if (url.protocol === 'https:' && !url.username && !url.password &&
                (['rutube.ru', 'id.vk.ru', 'id.vk.com'].indexOf(url.hostname) >= 0 || brokerUrl || tvUrl) &&
                !containsSecret && !/(access_token|refresh_token|anonymous_token|exchange_token|auth_hash|device_code|code_verifier|client_secret|broker_key|broker_poll_token|poll_token|state)/i.test(url.hash)) result.url = value.url;
        } catch (e) { /* no untrusted address in UI */ }
    }
    return result;
}
function publicCard(value, idPattern) {
    if (!value || !idPattern.test(String(value.id))) return null;
    const duration = Number(value.duration_s);
    const result = { id: String(value.id), title: text(value.title || value.id, 400),
        channel: text(value.channel, 200), duration_s: Number.isFinite(duration) && duration > 0 ? duration : 0 };
    if (Array.isArray(value.meta)) result.meta = value.meta.slice(0, 4).map((v) => text(v, 150));
    return result;
}

class PythonProvider {
    constructor(options) {
        const o = options || {};
        if (!IDS[o.id]) throw new Error('PythonProvider requires vk or rutube');
        if (typeof o.getUid !== 'function' && !o.noSetuid) throw new Error('PythonProvider requires getUid');
        this.id = o.id;
        this.context = o.context;
        this.python = o.python || '/var/opt/mgu-python/current/bin/python3';
        this.node22 = o.node22 || '/var/opt/jap-node22/current/bin/node';
        this.workerPath = o.workerPath || path.join(__dirname, 'worker.py');
        this.mediafetchPath = o.mediafetchPath || path.join(__dirname, 'mediafetch.py');
        this.decoderPath = o.decoderPath || path.join(__dirname, 'thumb_decode.js');
        this.ffmpeg = o.ffmpeg || '/var/opt/marku-ffmpeg/current/ffmpeg';
        this.pyz = o.pyz || path.join(__dirname, '..', 'core', 'native', 'jap-ridetube-d', 'ytdlp.pyz');
        this.caBundle = o.caBundle || path.join(__dirname, '..', 'runtime', 'cacert.pem');
        this.leaseFile = o.leaseFile || '/run/mgu-uplink/lease.json';
        this.getUid = o.getUid || function () { return 12345; };
        this.noSetuid = !!o.noSetuid;
        this.spawn = o.spawn || cp.spawn;
        this.chownSync = o.chownSync || fs.chownSync;
        this.timeoutMs = Math.min(120000, Math.max(1000, o.timeoutMs || 65000));
        this.now = o.now || Date.now;
        this.setTimer = o.setTimeout || setTimeout;
        this.clearTimer = o.clearTimeout || clearTimeout;
        this.generation = 0;
        this.closed = false;
        this.queue = Promise.resolve();
        this.children = new Set();
        this.cards = new Map();
        this.secrets = new Set();
        this.pollTimer = null;
        this.emit = null;
        this.brokerOrigin = null;
        this.accountScope = undefined;
    }
    attach(emit) { this.emit = typeof emit === 'function' ? emit : null; }
    _context(ctx) {
        if (this.closed) throw failure(CANCELLED, 'Сервис закрыт.');
        if (!ctx || ctx.providerId !== this.id || ctx.proxyPolicy !== 'direct' ||
            !path.isAbsolute(ctx.stateDir) || !path.isAbsolute(ctx.cacheDir))
            throw failure('invalid_context', 'Некорректный контекст видеосервиса.');
        return ctx;
    }
    _uid() {
        const uid = Number(this.getUid());
        if (!Number.isInteger(uid) || uid <= 0) throw failure('no_internet_uid', 'Для сервиса не назначен интернет-UID.');
        return uid;
    }
    _owner(file, uid) { if (!this.noSetuid) this.chownSync(file, uid, uid); }
    _dirs(ctx) {
        this._context(ctx);
        const uid = this._uid();
        mkdir(ctx.stateDir, 0o700);
        this._owner(ctx.stateDir, 0);
        mkdir(ctx.cacheDir, 0o711);
        this._owner(ctx.cacheDir, 0);
        const jobs = path.join(ctx.cacheDir, 'jobs'), ytc = path.join(ctx.cacheDir, 'ytc');
        [jobs, ytc].forEach((dir) => { mkdir(dir, 0o700); this._owner(dir, uid); });
        return { uid: uid, jobs: jobs, ytc: ytc, account: path.join(ctx.stateDir, 'account.json') };
    }
    _atomic(file, value, owner) {
        const bytes = Buffer.from(JSON.stringify(value));
        if (bytes.length > MAX_STATE) throw failure('state_too_large', 'Приватные данные сервиса превышают лимит.');
        const temporary = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
        let descriptor;
        try {
            descriptor = fs.openSync(temporary, 'wx', 0o600);
            fs.writeFileSync(descriptor, bytes);
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor); descriptor = null;
            fs.chmodSync(temporary, 0o600);
            this._owner(temporary, owner);
            fs.renameSync(temporary, file);
        } finally {
            if (descriptor !== null && descriptor !== undefined) { try { fs.closeSync(descriptor); } catch (e) {} }
            try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
    }
    _state(file) {
        const value = readJson(file, MAX_STATE);
        if (value.provider && value.provider !== this.id) throw failure('wrong_account', 'Учётная запись принадлежит другому сервису.');
        this._rememberSecrets(value);
        return value;
    }
    _rememberSecrets(value, key) {
        if (typeof value === 'string' && /^(access_token|refresh_token|access_key|anonymous_token|exchange_token|auth_hash|device_code|code_verifier|client_secret|password|cookie|broker_key|broker_poll_token|poll_token|state)$/i.test(key || '') && value.length >= 4)
            this.secrets.add(value);
        else if (value && typeof value === 'object') Object.keys(value).forEach((name) => this._rememberSecrets(value[name], name));
        while (this.secrets.size > 1024) this.secrets.delete(this.secrets.values().next().value);
    }
    _redact(value) {
        let result = String(value || '');
        this.secrets.forEach((secret) => { result = result.split(secret).join('[redacted]'); });
        return result;
    }
    _public(value) {
        const result = publicState(value, this.brokerOrigin, this.id);
        if (result.msg) result.msg = this._redact(result.msg);
        if (result.code && this._redact(result.code) !== result.code) delete result.code;
        if (result.url && this._redact(result.url) !== result.url) delete result.url;
        return result;
    }
    _card(value) {
        const result = publicCard(value, IDS[this.id]);
        if (!result) return null;
        ['title', 'channel'].forEach((key) => { result[key] = this._redact(result[key]); });
        if (result.meta) result.meta = result.meta.map((v) => this._redact(v));
        return result;
    }
    _config(ctx, dirs) {
        const stored = readJson(path.join(ctx.stateDir, 'config.json'), 65536);
        const config = { cache_dir: dirs.ytc, pyz: this.pyz, ca_bundle: this.caBundle, lease_file: ctx.leaseFile || this.leaseFile };
        // Never forward Store/YouTube proxy settings or arbitrary worker configuration.
        ['client_id', 'app_id', 'redirect_uri', 'scope', 'api_version', 'callback_broker', 'broker_key', 'auth_mode'].forEach((key) => {
            if (typeof stored[key] === 'string' || typeof stored[key] === 'number') config[key] = stored[key];
        });
        if (!config.client_id && config.app_id) config.client_id = String(config.app_id);
        this._rememberSecrets(config);
        this.brokerOrigin = null;
        if (this.id === 'vk' && typeof config.callback_broker === 'string') {
            try {
                const broker = new URL(config.callback_broker);
                if (broker.protocol === 'https:' && !broker.username && !broker.password && !broker.search && !broker.hash &&
                    (broker.pathname === '/' || broker.pathname === '')) this.brokerOrigin = broker.origin;
            } catch (error) { /* the provider returns a safe configuration error */ }
        }
        return config;
    }
    _child(command, input, options) {
        const o = options || {}, generation = o.generation === undefined ? this.generation : o.generation;
        const maximum = o.maximum || MAX_OUTPUT;
        const data = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
        if (data.length > MAX_INPUT) return Promise.reject(failure('request_too_large', 'Запрос к сервису превышает лимит.'));
        if (this.closed || generation !== this.generation) return Promise.reject(failure(CANCELLED, 'Запрос отменён.'));
        return new Promise((resolve, reject) => {
            let child, timer, done = false, size = 0;
            const output = [];
            const record = { generation: generation, cancel: null };
            const finish = (error, result) => {
                if (done) return;
                done = true;
                if (timer) this.clearTimer(timer);
                this.children.delete(record);
                if (error) {
                    try { if (child) child.kill('SIGKILL'); } catch (e) {}
                    reject(error);
                } else resolve(result);
            };
            record.cancel = () => finish(failure(CANCELLED, 'Запрос отменён.'));
            try {
                const uid = this._uid(), ids = this.noSetuid ? {} : { uid: uid, gid: uid };
                child = this.spawn(command[0], command.slice(1), Object.assign(ids,
                    { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'] }));
                record.child = child;
                this.children.add(record);
            } catch (e) { finish(failure('worker_start', 'Не удалось запустить сетевой процесс сервиса.')); return; }
            timer = this.setTimer(() => finish(failure('worker_timeout', 'Сервис не ответил вовремя. Повторите запрос.')), o.timeoutMs || this.timeoutMs);
            if (timer && timer.unref) timer.unref();
            child.on('error', () => finish(failure('worker_error', 'Сетевой процесс сервиса недоступен.')));
            child.stdin.on('error', () => finish(failure('worker_input', 'Не удалось передать запрос сервису.')));
            child.stdout.on('data', (chunk) => {
                if (done) return;
                size += chunk.length;
                if (size > maximum) return finish(failure('worker_limit', 'Ответ видеосервиса превышает лимит.'));
                output.push(Buffer.from(chunk));
            });
            // Never repeat raw stderr: extractors may include signed URLs or credentials.
            child.stderr.on('data', function () {});
            child.on('close', (code) => {
                if (done) return;
                if (this.closed || generation !== this.generation) return record.cancel();
                if (code !== 0) return finish(failure('worker_exit', 'Сетевой процесс сервиса завершился с ошибкой.'));
                finish(null, Buffer.concat(output));
            });
            child.stdin.end(data);
        });
    }
    _enqueue(fn) {
        const run = this.queue.then(fn);
        this.queue = run.catch(function () {});
        return run;
    }
    _worker(op, args, ctx, generation, override, save) {
        return this._enqueue(async () => {
            if (this.closed || generation !== this.generation) throw failure(CANCELLED, 'Запрос отменён.');
            const dirs = this._dirs(ctx);
            const privateState = override === undefined ? this._state(dirs.account) : override;
            const request = { provider: this.id, op: op, args: args || {}, private: privateState, config: this._config(ctx, dirs) };
            const bytes = await this._child([this.python, this.workerPath], request, { generation: generation });
            if (this.closed || generation !== this.generation) throw failure(CANCELLED, 'Запрос отменён.');
            let result;
            try { result = JSON.parse(bytes.toString('utf8')); }
            catch (e) { throw failure('worker_json', 'Сервис вернул некорректный ответ.'); }
            if (!result || typeof result !== 'object' || Array.isArray(result)) throw failure('worker_json', 'Сервис вернул некорректный ответ.');
            this._rememberSecrets(result.private);
            if (save !== false && result.private && typeof result.private === 'object' && !Array.isArray(result.private)) {
                this._atomic(dirs.account, Object.assign({}, result.private, { provider: this.id }), 0);
                const nextScope = this._cacheScope(result.private);
                if (this.id === 'vk' && nextScope !== this.accountScope) this.cards.clear();
                this.accountScope = nextScope;
            }
            // Ordinary content operations may refresh, invalidate or finish an
            // account login. Persist and publish that envelope together, including
            // permission failures accompanying a content error. A cancelled worker
            // must never restore the account or emit a stale signed_in event.
            if (!this.closed && generation === this.generation && save !== false &&
                result.auth && typeof result.auth === 'object' && !Array.isArray(result.auth)) {
                this._broadcast(result.auth, ctx);
                this._schedule(result, ctx, generation);
            }
            if (result.error) {
                const code = /^[a-z0-9_-]{1,80}$/.test(String(result.error.code)) ? String(result.error.code) : 'provider_error';
                throw failure(code, this._redact(cleanMessage(result.error.message)));
            }
            return result;
        });
    }
    _remember(result) {
        const remember = (items) => (Array.isArray(items) ? items : []).slice(0, 100).map((item) => {
            const card = this._card(item);
            if (!card) return null;
            this.cards.delete(card.id); this.cards.set(card.id, item);
            while (this.cards.size > 400) this.cards.delete(this.cards.keys().next().value);
            return card;
        }).filter(Boolean);
        const out = { items: remember(result && result.items || result) };
        if (result && Array.isArray(result.shelves)) out.shelves = result.shelves.slice(0, 8).map((shelf) =>
            ({ title: this._redact(text(shelf.title, 200)), items: remember(shelf.items) }));
        if (result && result.error) out.error = this._redact(cleanMessage(result.error));
        return out;
    }
    async search(q, ctx) {
        this._context(ctx);
        const query = String(q || '').trim().slice(0, 200);
        if (!query) throw failure('empty_query', 'Введите запрос для поиска.');
        const result = await this._worker('search', { q: query }, this._accountContext(ctx), this.generation);
        return this._remember(result.result);
    }
    async feed(which, ctx) {
        this._context(ctx);
        const name = String(which || 'home');
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) throw failure('invalid_feed', 'Этот раздел недоступен.');
        const result = await this._worker('feed', { which: name }, this._accountContext(ctx), this.generation);
        return this._remember(result.result);
    }
    _cancelPoll() {
        if (this.pollTimer) this.clearTimer(this.pollTimer);
        this.pollTimer = null;
    }
    _advance() {
        this.generation++;
        this._cancelPoll();
        Array.from(this.children).forEach((record) => record.cancel());
        return this.generation;
    }
    _broadcast(state, ctx) {
        const event = Object.assign({ ev: 'auth' }, this._public(state));
        if (this.emit) this.emit(event);
        else if (ctx && typeof ctx.emit === 'function') ctx.emit(event);
    }
    _schedule(envelope, ctx, generation) {
        if (this.closed || generation !== this.generation) return;
        this._cancelPoll();
        const pending = envelope.private && envelope.private.pending;
        if (!pending || Number(pending.expires_at) * 1000 <= this.now()) return;
        const interval = Number(pending.interval || pending.poll_interval);
        const advertised = interval > 0 ? interval * 1000 : 10000;
        const next = Number(pending.next_poll_at) > 0 ? Number(pending.next_poll_at) * 1000 - this.now() : advertised;
        const delay = Math.min(60000, Math.max(1000, next));
        this.pollTimer = this.setTimer(() => {
            this.pollTimer = null;
            this._worker('auth_poll', {}, ctx, generation).then((answer) => {
                if (this.closed || generation !== this.generation) return;
                this._broadcast(answer.public, ctx);
                this._schedule(answer, ctx, generation);
            }, (error) => {
                if (error.code === CANCELLED || this.closed || generation !== this.generation) return;
                this._broadcast({ state: 'error', msg: cleanMessage(error.message) }, ctx);
            });
        }, delay);
        if (this.pollTimer && this.pollTimer.unref) this.pollTimer.unref();
    }
    async auth(ctx) {
        this._context(ctx);
        const generation = this._advance();
        try {
            const result = await this._worker('auth_begin', {}, ctx, generation);
            this._schedule(result, ctx, generation);
            return this._public(result.public);
        } catch (error) {
            if (error.code === CANCELLED) return undefined;
            return { state: 'error', msg: cleanMessage(error.message) };
        }
    }
    async status(ctx) {
        this._context(ctx);
        const generation = this.generation;
        try {
            const result = await this._worker('auth_status', {}, ctx, generation);
            this._schedule(result, ctx, generation);
            return this._public(result.public);
        } catch (error) {
            if (error.code === CANCELLED) return undefined;
            return { state: 'error', msg: cleanMessage(error.message) };
        }
    }
    async signOut(ctx) {
        this._context(ctx);
        const generation = this._advance(), dirs = this._dirs(ctx);
        const previous = this._state(dirs.account);
        this._atomic(dirs.account, { provider: this.id }, 0);
        if (this.id === 'vk') {
            this.cards.clear(); this.accountScope = null;
            this._purgeAccountCache(ctx, previous);
        }
        this._broadcast({ state: 'signed_out' }, ctx);
        try { await this._worker('sign_out', {}, ctx, generation, previous, false); }
        catch (error) { /* local sign-out succeeds even if the server is unavailable */ }
        if (this.closed || generation !== this.generation) return undefined;
        return { state: 'signed_out' };
    }
    async authComplete(args, ctx) {
        this._context(ctx);
        if (this.id !== 'vk') throw failure('unsupported_auth', 'Этот способ входа не поддерживается.');
        const generation = this.generation;
        const result = await this._worker('auth_complete', args, ctx, generation);
        this._schedule(result, ctx, generation);
        return this._public(result.public);
    }
    async thumb(id, ctx) {
        this._context(ctx);
        if (!IDS[this.id].test(String(id)) || !this.cards.has(String(id))) return null;
        ctx = this._accountContext(ctx);
        try {
            const cached = path.join(ctx.cacheDir, String(id), 'thumb.rgba'), st = fs.lstatSync(cached);
            if (st.isFile() && !st.isSymbolicLink() && [RGBA_SIZE, 57600].indexOf(st.size) >= 0) {
                const rgba = fs.readFileSync(cached);
                return { rgba: rgba, w: rgba.length === RGBA_SIZE ? 320 : 160, h: rgba.length === RGBA_SIZE ? 180 : 90 };
            }
        } catch (e) { /* no cached image */ }
        const card = this.cards.get(String(id)), address = card.thumbnail || card.thumbnail_url;
        if (typeof address !== 'string' || address.length > 8192 || !/^https:\/\//.test(address)) return null;
        const generation = this.generation;
        try {
            const answer = await this._worker('thumb', { url: address }, ctx, generation, {}, false);
            const encoded = answer.result && answer.result.jpeg;
            if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_JPEG / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
            const jpeg = Buffer.from(encoded, 'base64');
            if (jpeg.length > MAX_JPEG || jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
            const rgba = await this._child([this.node22, this.decoderPath], jpeg,
                { generation: generation, maximum: RGBA_SIZE, timeoutMs: 10000 });
            return rgba.length === RGBA_SIZE ? { rgba: rgba, w: 320, h: 180 } : null;
        } catch (error) { return null; }
    }
    _cacheScope(privateState) {
        const account = privateState && privateState.account;
        return this.id === 'vk' && account && /^[a-f0-9]{32}$/.test(String(account.cache_id || '')) ? account.cache_id : null;
    }
    _accountContext(ctx, privateState) {
        if (this.id !== 'vk') return ctx;
        const state = privateState === undefined ? this._state(path.join(ctx.stateDir, 'account.json')) : privateState;
        const account = state && state.account, scope = this._cacheScope(state);
        if (!scope || !account || account.video_access !== true || account.verification_pending ||
            typeof account.access_token !== 'string' || !account.access_token || !/^[1-9]\d{0,19}$/.test(String(account.user_id || ''))) return ctx;
        return Object.freeze(Object.assign({}, ctx, { cacheDir: path.join(ctx.cacheDir, 'account-' + scope) }));
    }
    _purgeAccountCache(ctx, previous) {
        if (Array.isArray(ctx.alternateCacheDirs)) {
            ctx.alternateCacheDirs.filter((dir) => dir !== ctx.cacheDir).forEach((dir) => {
                this._purgeAccountCache(Object.assign({}, ctx, { cacheDir: dir, alternateCacheDirs: null }), previous);
            });
        }
        const scope = this._cacheScope(previous), base = path.resolve(ctx.cacheDir);
        const names = scope ? ['account-' + scope] : [];
        try { fs.readdirSync(base).forEach((name) => { if (/^account-[a-f0-9]{32}$/.test(name) && names.indexOf(name) < 0) names.push(name); }); }
        catch (error) { /* absent cache */ }
        // Only random account namespaces directly inside this provider cache may
        // be removed, including orphaned sessions whose token was revoked earlier.
        // lstat/unlink never follow a symlink or Windows directory junction.
        const remove = (file) => {
            const st = fs.lstatSync(file);
            if (st.isDirectory() && !st.isSymbolicLink()) {
                fs.readdirSync(file).forEach((name) => remove(path.join(file, name)));
                fs.rmdirSync(file);
            } else fs.unlinkSync(file);
        };
        names.forEach((name) => {
            const target = path.resolve(base, name);
            if (path.dirname(target) !== base || !/^account-[a-f0-9]{32}$/.test(path.basename(target))) return;
            try { remove(target); } catch (error) { /* key is already erased; a failed cleanup cannot make this cache reachable */ }
        });
        // Drop old private jobs in the legacy provider root too. Complete guest
        // media still resumes offline; a future online start can resolve a new job.
        const jobs = path.join(base, 'jobs');
        try {
            fs.readdirSync(jobs).forEach((name) => {
                if (name.slice(-5) !== '.json' || !IDS.vk.test(name.slice(0, -5))) return;
                try { fs.unlinkSync(path.join(jobs, name)); } catch (error) { /* cleanup remains confined to known job names */ }
            });
        } catch (error) { /* no legacy jobs */ }
    }
    async positions(ctx) {
        this._context(ctx);
        const media = this._accountContext(ctx);
        const stored = readJson(path.join(media.cacheDir, 'positions.json'), MAX_STATE);
        const items = Object.keys(stored).filter((id) => IDS[this.id].test(id)).slice(0, 300).map((id) => {
            const entry = stored[id];
            if (!entry || !Number.isFinite(Number(entry.ms)) || !Number.isFinite(Number(entry.total))) return null;
            return { id: id, title: this._redact(text(entry.title || id, 400)), channel: this._redact(text(entry.channel, 200)),
                ms: Math.max(0, Number(entry.ms)), total: Math.max(0, Number(entry.total)), done: !!entry.done,
                duration_s: Math.max(0, Number(entry.duration_s) || 0) };
        }).filter(Boolean);
        return { ev: 'positions', items: items };
    }
    _cachedKnown(id, ctx) {
        const dir = path.join(ctx.cacheDir, id);
        try {
            const st = fs.lstatSync(dir);
            if (!st.isDirectory() || st.isSymbolicLink()) return null;
            const meta = readJson(path.join(dir, 'meta.json'), 65536);
            const complete = meta.id === id && this._card(meta) && !fs.existsSync(path.join(dir, 'audio.m4a.part')) &&
                ['audio.m4a', 'index.bin', 'video.h264'].every((name) => {
                    try { const f = fs.lstatSync(path.join(dir, name)); return f.isFile() && !f.isSymbolicLink() && f.size > 0; }
                    catch (e) { return false; }
                });
            if (complete) return { card: meta, complete: true };
        } catch (e) { /* absent or damaged media cache */ }
        try {
            const file = path.join(ctx.cacheDir, 'positions.json'), st = fs.lstatSync(file);
            if (!this.noSetuid && process.platform !== 'win32' && (st.uid !== 0 || st.mode & 0o022)) return null;
            const entry = readJson(file, MAX_STATE)[id];
            if (!entry || typeof entry !== 'object' || !Number.isFinite(Number(entry.ms))) return null;
            return { card: { id: id, title: text(entry.title || id, 400), channel: text(entry.channel, 200), duration_s: 0 }, complete: false };
        } catch (e) { return null; }
    }
    _prepared(id, ctx, metadata) {
        const dirs = this._dirs(ctx);
        return { id: id, cacheDir: ctx.cacheDir, metadata: metadata,
            fetcher: [this.python, this.mediafetchPath, '--provider', this.id, '--job-dir', dirs.jobs,
                '--ffmpeg', this.ffmpeg, '--pyz', this.pyz, '--ca-file', this.caBundle,
                '--lease', ctx.leaseFile || this.leaseFile], thumbCmd: null };
    }
    preparePlayback(id, ctx) { return this._preparePlayback(id, ctx, false); }
    refreshPlayback(id, ctx) { return this._preparePlayback(id, ctx, true); }
    async _preparePlayback(id, ctx, refresh) {
        this._context(ctx);
        const baseContext = ctx;
        ctx = this._accountContext(ctx);
        id = String(id || '');
        if (!IDS[this.id].test(id)) throw failure('unknown_video', 'Выберите видео из списка этого сервиса.');
        const cached = this._cachedKnown(id, ctx);
        if (cached) {
            this.cards.delete(id); this.cards.set(id, cached.card);
            while (this.cards.size > 400) this.cards.delete(this.cards.keys().next().value);
        }
        if (!this.cards.has(id)) throw failure('unknown_video', 'Выберите видео из списка этого сервиса.');
        // A complete provider-local cache can resume after a service restart while offline.
        // Incomplete/missing media still needs a server resolve, allowed only by this
        // process's registry or a protected position written by the player.
        // A quality restart needs new signed URLs even when the old decoded media
        // is complete. Resolve/atomically save first; leave that cache intact on error.
        if (!refresh && cached && cached.complete) return this._prepared(id, ctx, this._card(cached.card));
        const generation = this.generation;
        const answer = await this._worker('resolve', { id: id, height: 720 }, ctx, generation);
        if (this.closed || generation !== this.generation) throw failure(CANCELLED, 'Запрос отменён.');
        const job = answer.result;
        if (!job || job.provider !== this.id || job.id !== id || typeof job.url !== 'string' || !/^https:\/\//.test(job.url))
            throw failure('invalid_playback', 'Сервис не предоставил доступное видео.');
        // A preflight refresh may have created/recovered the account scope. Never
        // save API-signed media URLs into the guest cache selected before it ran.
        ctx = this._accountContext(baseContext, answer.private);
        const dirs = this._dirs(ctx);
        this._atomic(path.join(dirs.jobs, id + '.json'), job, dirs.uid);
        const metadata = this._card(job) || this._card(this.cards.get(id));
        return this._prepared(id, ctx, metadata);
    }
    networkChanged() { this._advance(); }
    close() {
        if (this.closed) return;
        this.closed = true;
        this._advance();
        this.cards.clear();
        this.secrets.clear();
        this.emit = null;
    }
}

module.exports = { PythonProvider: PythonProvider, Provider: PythonProvider, publicState: publicState, publicCard: publicCard };
