'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Three provider endpoints, one MediaPlayer connection and one ytdec writer.
// Provider contract:
//   id, context?; search(q,ctx)/feed(which,ctx) -> {items,shelves?};
//   auth/status/signOut(ctx) -> public AuthState; thumb(id,ctx) -> RGBA or null;
//   preparePlayback(id,ctx) -> {id,cacheDir,fetcher,thumbCmd?,metadata?}.
//   refreshPlayback(id,ctx) refreshes expiring direct-provider jobs before quality changes.
// A provider may return undefined and use ctx.emit; attach(emit) is for provider-wide
// auth polling events. The context never changes when another provider starts playback.
// URL/token/cookie resolution belongs to adapters, not the untrusted socket protocol.
const fs = require('fs');
const net = require('net');
const path = require('path');
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const PROVIDERS = ['youtube', 'vk', 'rutube'];
const CONTROL = ['pause', 'resume', 'seek', 'stop', 'video', 'fill', 'quality', 'display'];
const MAX_LINE = 65536;

function mkdir(dir, mode) {
    if (!fs.existsSync(dir)) {
        const parent = path.dirname(dir);
        if (parent !== dir) mkdir(parent, mode);
        try { fs.mkdirSync(dir, mode || 0o700); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
}
function cleanError(error) {
    return String(error && error.message || error || 'request failed')
        .replace(/((?:https?|socks5h?):\/\/)[^\s/@]+:[^\s/@]*@/gi, '$1[redacted]@')
        .replace(/(Bearer\s+)\S+/gi, '$1[redacted]').slice(0, 500);
}
function video(item) {
    if (!item || !SAFE_ID.test(String(item.id))) return null;
    const result = { id: String(item.id), title: String(item.title || item.id).slice(0, 400),
        channel: String(item.channel || '').slice(0, 200),
        duration_s: Number(item.duration_s) > 0 ? Number(item.duration_s) : null };
    if (Array.isArray(item.meta)) result.meta = item.meta.slice(0, 4).map((s) => String(s).slice(0, 150));
    return result;
}
function videos(items) { return (Array.isArray(items) ? items : []).slice(0, 100).map(video).filter(Boolean); }
function authState(state) {
    if (!state || typeof state !== 'object') return { ev: 'auth', state: 'signed_out' };
    const out = { ev: 'auth', state: String(state.state || 'signed_out') };
    ['code', 'expires', 'msg'].forEach((k) => { if (state[k] !== undefined) out[k] = state[k]; });
    if (typeof state.url === 'string' && /^https:\/\//.test(state.url)) out.url = state.url;
    if (out.msg) out.msg = cleanError(out.msg);
    return out; // private tokens, cookies, device_code and configuration never enter the socket.
}
function inside(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (relative !== '..' && relative.indexOf('..' + path.sep) !== 0 && !path.isAbsolute(relative));
}

class Gateway {
    constructor(options) {
        const o = options || {};
        if (!o.player) throw new Error('gateway requires a player');
        this.player = o.player;
        this.log = o.log || function () {};
        this.stateDir = o.stateDir || '/var/opt/jap-ridetube-d/state';
        this.cacheDir = o.cacheDir || '/var/opt/jap-ridetube-d/cache';
        this.socketDir = o.socketDir || '/run/jap-ridetube-d';
        this.sockGid = o.sockGid === undefined ? 12202 : o.sockGid;
        this.socketPaths = o.sockets || { youtube: path.join(this.socketDir, 'ctl.sock'),
            vk: path.join(this.socketDir, 'vk.sock'), rutube: path.join(this.socketDir, 'rutube.sock') };
        this.providers = Object.create(null);
        this.contexts = Object.create(null);
        this.clients = new Map();
        this.servers = [];
        this.owner = null;
        this.epoch = 0;
        this.ticket = 0;
        this.pendingPlay = null;
        this.nextSession = 0;
        this.queue = Promise.resolve();
        this.authEpoch = Object.create(null);
        this.signingOut = Object.create(null);
        this.closed = false;
        (o.providers || []).forEach((provider) => {
            if (!provider || PROVIDERS.indexOf(provider.id) < 0 || this.providers[provider.id]) throw new Error('invalid or duplicate provider');
            this.providers[provider.id] = provider;
            const context = Object.assign({}, provider.context || {}, {
                providerId: provider.id,
                stateDir: provider.context && provider.context.stateDir || path.join(this.stateDir, provider.id),
                cacheDir: provider.context && provider.context.cacheDir || (provider.id === 'youtube' ? this.cacheDir : path.join(this.cacheDir, provider.id)),
                proxyPolicy: provider.id === 'youtube' ? 'youtube' : 'direct'
            });
            this.contexts[provider.id] = Object.freeze(context);
            if (typeof provider.attach === 'function') provider.attach((event) => this.emitProvider(provider.id, event));
        });
        if (typeof this.player.setYouTubeProvider === 'function' && this.providers.youtube)
            this.player.setYouTubeProvider(this.providers.youtube);
    }
    _send(session, event) {
        if (!session || session.closed || !event) return;
        const out = event.ev === 'auth' ? authState(event) : event;
        try { session.socket.write(JSON.stringify(out) + '\n'); } catch (e) { this.log('socket reply: ' + cleanError(e)); }
    }
    emitProvider(id, event) {
        if (this.signingOut[id]) return;
        this.clients.forEach((s) => { if (s.providerId === id) this._send(s, event); });
    }
    _context(session) {
        return Object.freeze(Object.assign({}, this.contexts[session.providerId], {
            sessionId: session.id, emit: (event) => this._send(session, event)
        }));
    }
    _enqueue(fn) {
        const run = this.queue.then(fn);
        this.queue = run.catch((e) => { this.log('playback queue: ' + cleanError(e)); });
        return run;
    }
    async start() {
        if (this.closed) throw new Error('gateway is closed');
        const pending = Object.keys(this.providers).map((id) => new Promise((resolve, reject) => {
            const socketPath = this.socketPaths[id];
            if (!socketPath) return reject(new Error('provider socket is not configured'));
            if (process.platform !== 'win32') {
                mkdir(path.dirname(socketPath), 0o755);
                try {
                    const st = fs.lstatSync(socketPath);
                    if (!st.isSocket()) return reject(new Error('refusing to replace a non-socket file'));
                    fs.unlinkSync(socketPath);
                } catch (e) { if (e.code !== 'ENOENT') return reject(e); }
            }
            const server = net.createServer((socket) => this.connect(id, socket));
            this.servers.push(server);
            server.once('error', reject);
            server.listen(socketPath, () => {
                if (process.platform !== 'win32') {
                    try { fs.chmodSync(socketPath, 0o660); fs.chownSync(socketPath, 0, this.sockGid); }
                    catch (e) { this.log('socket permissions: ' + cleanError(e)); }
                }
                server.removeListener('error', reject);
                server.on('error', (e) => this.log('socket server: ' + cleanError(e)));
                resolve();
            });
        }));
        await Promise.all(pending);
        if (typeof this.player.start === 'function') {
            this.playerReady = Promise.resolve(this.player.start());
            this.playerReady.catch((e) => this.log('player startup: ' + cleanError(e)));
        }
        return this;
    }
    connect(providerId, socket) {
        if (this.closed || !this.providers[providerId]) { socket.destroy(); return null; }
        // Video stays off until the app has supplied its parked/visibility decision.
        const session = { id: ++this.nextSession, providerId, socket, closed: false, videoOn: false };
        this.clients.set(session.id, session);
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', (data) => {
            buffer += data;
            if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE) { socket.destroy(); return; }
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (!line) continue;
                let message;
                try { message = JSON.parse(line); } catch (e) { this._send(session, { ev: 'error', msg: 'bad json' }); continue; }
                const epoch = this.authEpoch[session.providerId] || 0;
                this.dispatch(session, message).catch((e) => {
                    if (epoch === (this.authEpoch[session.providerId] || 0) && !this.signingOut[session.providerId])
                        this._send(session, { ev: 'error', msg: cleanError(e) });
                });
            }
        });
        socket.on('error', () => {});
        socket.on('close', () => this.disconnect(session));
        return session;
    }
    disconnect(session) {
        if (session.closed) return;
        session.closed = true;
        this.clients.delete(session.id);
        if (this.owner && this.owner.session === session) {
            const epoch = this.owner.epoch;
            this._enqueue(async () => {
                if (!this.owner || this.owner.epoch !== epoch) return;
                await this.player.retire();
                if (this.owner && this.owner.epoch === epoch) this.owner = null;
            }).catch((e) => this.log('disconnect playback: ' + cleanError(e)));
        }
    }
    _status(session) {
        if (this.owner && this.owner.session === session && typeof this.player.status === 'function') {
            const s = this.player.status();
            this._send(session, Object.assign({ ev: 'state' }, s));
            if (Number(s.total) > 0) this._send(session, { ev: 'time', elapsed: Number(s.elapsed) || 0, total: Number(s.total) });
        } else this._send(session, { ev: 'state', state: 'idle', id: null });
    }
    async dispatch(session, message) {
        if (this.closed || session.closed) return;
        if (!message || typeof message.cmd !== 'string') throw new Error('no cmd');
        const provider = this.providers[session.providerId], ctx = this._context(session), cmd = message.cmd;
        if (cmd === 'sign_out') return this._signOut(session, provider, ctx);
        if (this.signingOut[session.providerId]) return;
        const authEpoch = this.authEpoch[session.providerId] || 0;
        const currentAuth = () => authEpoch === (this.authEpoch[session.providerId] || 0) && !this.signingOut[session.providerId];
        if (cmd === 'video') session.videoOn = !!message.on;
        if (cmd === 'display') {
            if (['main', 'cluster', 'both'].indexOf(message.target) < 0) throw new Error('Неизвестный экран');
            session.displayTarget = message.target;
        }
        if (cmd === 'play') return this._play(session, message, provider, ctx);
        if (CONTROL.indexOf(cmd) >= 0) {
            if (cmd === 'stop' && this.pendingPlay && this.pendingPlay.session === session) {
                this.ticket++;
                this.pendingPlay = null;
                this._send(session, { ev: 'state', state: 'idle', id: null });
            }
            if (!this.owner || this.owner.session !== session) return;
            const epoch = this.owner.epoch;
            if (cmd === 'quality') return this._quality(session, message, provider, ctx);
            if (cmd === 'stop') this.owner.qualityTicket = (this.owner.qualityTicket || 0) + 1;
            return this._enqueue(async () => {
                if (!this.owner || this.owner.epoch !== epoch || session.closed) return;
                if (cmd === 'stop') {
                    await this.player.retire();
                    if (this.owner && this.owner.epoch === epoch) this.owner = null;
                } else await this.player.command(cmd, message);
            });
        }
        if (cmd === 'status') { this._status(session); return; }
        if (cmd === 'search') {
            const q = String(message.q || '').trim().slice(0, 200);
            if (!q) throw new Error('empty search');
            const result = await provider.search(q, ctx);
            if (currentAuth() && result !== undefined) this._send(session, { ev: 'results', q, items: videos(result.items || result) });
            return;
        }
        if (cmd === 'feed') {
            const which = String(message.which || 'home');
            if (!/^[A-Za-z0-9_-]{1,40}$/.test(which) || typeof provider.feed !== 'function') throw new Error('feed unavailable');
            const result = await provider.feed(which, ctx);
            if (currentAuth() && result !== undefined) {
                const event = { ev: 'feed', which, items: videos(result.items || result) };
                if (Array.isArray(result.shelves)) event.shelves = result.shelves.slice(0, 8).map((s) => ({ title: String(s.title || '').slice(0, 200), items: videos(s.items) }));
                if (result.error) event.error = cleanError(result.error);
                this._send(session, event);
            }
            return;
        }
        if (cmd === 'auth' || cmd === 'auth_status') {
            const name = cmd === 'auth_status' ? 'status' : 'auth';
            if (typeof provider[name] !== 'function') throw new Error('authorization unavailable');
            const result = await provider[name](ctx);
            if (currentAuth() && result !== undefined) this._send(session, authState(result));
            return;
        }
        if (cmd === 'thumb') {
            if (!SAFE_ID.test(String(message.id)) || typeof provider.thumb !== 'function') return;
            const result = await provider.thumb(String(message.id), ctx);
            if (currentAuth() && result && result.rgba) {
                const rgba = Buffer.isBuffer(result.rgba) ? result.rgba : Buffer.from(result.rgba, 'base64');
                if ((result.w === 320 && result.h === 180 && rgba.length === 230400) ||
                    (result.w === 160 && result.h === 90 && rgba.length === 57600))
                    this._send(session, { ev: 'thumb', id: String(message.id), w: result.w, h: result.h, rgba: rgba.toString('base64') });
            }
            return;
        }
        if (cmd === 'positions') {
            if (typeof provider.positions === 'function') {
                const result = await provider.positions(ctx);
                if (currentAuth() && result !== undefined) this._send(session, result);
            } else {
                let positions = {};
                try { positions = JSON.parse(fs.readFileSync(path.join(ctx.cacheDir, 'positions.json'), 'utf8')); } catch (e) { /* first use */ }
                const items = Object.keys(positions).filter((id) => SAFE_ID.test(id)).map((id) => Object.assign({ id }, positions[id]));
                this._send(session, { ev: 'positions', items });
            }
            return;
        }
        if (cmd === 'prefetch') {
            if (typeof provider.prefetch === 'function' && SAFE_ID.test(String(message.id))) await provider.prefetch(String(message.id), ctx);
            return;
        }
        if ((cmd === 'channels' || cmd === 'channel') && typeof provider[cmd] === 'function') return provider[cmd](message.id, ctx);
        throw new Error('unknown cmd ' + cmd);
    }
    _signOut(session, provider, ctx) {
        const id = session.providerId;
        if (this.signingOut[id]) return this.signingOut[id].promise;
        if (typeof provider.signOut !== 'function') throw new Error('authorization unavailable');
        const marker = {};
        this.signingOut[id] = marker;
        this.authEpoch[id] = (this.authEpoch[id] || 0) + 1;
        if (this.pendingPlay && this.pendingPlay.session.providerId === id) {
            this.ticket++;
            this.pendingPlay = null;
        }
        if (this.owner && this.owner.providerId === id)
            this.owner.qualityTicket = (this.owner.qualityTicket || 0) + 1;
        this.clients.forEach((client) => {
            if (client.providerId === id) this._send(client, { ev: 'auth', state: 'signed_out' });
        });
        marker.promise = (async () => {
            try {
                // An account's private media must not be purged while its decoder
                // or BMW player is using it. Another provider keeps playing.
                await this._enqueue(async () => {
                    const owner = this.owner;
                    if (!owner || owner.providerId !== id) return;
                    await this.player.retire();
                    if (this.owner === owner) {
                        this.owner = null;
                        this._send(owner.session, { ev: 'state', state: 'idle', id: null });
                    }
                });
                const result = await provider.signOut(ctx);
                delete this.signingOut[id];
                if (result !== undefined) this.emitProvider(id, authState(result));
            } catch (error) {
                this.clients.forEach((client) => {
                    if (client.providerId === id) this._send(client, { ev: 'auth', state: 'error', msg: cleanError(error) });
                });
                throw error;
            } finally {
                if (this.signingOut[id] === marker) delete this.signingOut[id];
            }
        })();
        return marker.promise;
    }
    _quality(session, message, provider, ctx) {
        const owner = this.owner, playTicket = this.ticket;
        const qualityTicket = owner.qualityTicket = (owner.qualityTicket || 0) + 1;
        const current = () => !this.closed && !session.closed && this.owner === owner &&
            owner.qualityTicket === qualityTicket && this.ticket === playTicket;
        // CDN URLs in private jobs expire. Resolve before allowing requality to
        // remove a playable cache; network work never holds the playback queue.
        return Promise.resolve().then(() => {
            if (session.providerId !== 'youtube') {
                if (typeof provider.refreshPlayback !== 'function') throw new Error('quality refresh unavailable');
                return provider.refreshPlayback(owner.id, ctx);
            }
        }).then(() => this._enqueue(() => {
            if (!current()) return;
            // Downloads can take seconds. STOP/switch may cancel the core's
            // play intent while this command is awaiting audio or new media.
            Promise.resolve().then(() => current() && this.player.command('quality', message))
                .catch((e) => { if (current()) this._send(session, { ev: 'error', msg: cleanError(e) }); });
        })).catch((e) => { if (current()) this._send(session, { ev: 'error', msg: cleanError(e) }); });
    }
    async _play(session, message, provider, ctx) {
        const id = String(message.id || '');
        if (!SAFE_ID.test(id) || typeof provider.preparePlayback !== 'function') throw new Error('bad video id');
        const ticket = ++this.ticket;
        const authEpoch = this.authEpoch[session.providerId] || 0;
        const currentAuth = () => authEpoch === (this.authEpoch[session.providerId] || 0) && !this.signingOut[session.providerId];
        this.pendingPlay = { ticket, session };
        const prepared = await provider.preparePlayback(id, ctx);
        if (!currentAuth()) return;
        if (!prepared || prepared.id !== id || typeof prepared.cacheDir !== 'string' || !inside(ctx.cacheDir, prepared.cacheDir)) throw new Error('invalid playback context');
        if (!Array.isArray(prepared.fetcher) || !prepared.fetcher.length || prepared.fetcher.some((a) => typeof a !== 'string' || a.indexOf('\0') >= 0)) throw new Error('invalid fetch helper');
        if (ctx.proxyPolicy === 'direct' && prepared.fetcher.some((a) => /^--proxy(?:=|-file(?:=|$)|$)/.test(a))) throw new Error('direct provider cannot use a proxy');
        const context = Object.freeze({ providerId: session.providerId, id, cacheDir: prepared.cacheDir,
            fetcher: Object.freeze(prepared.fetcher.slice()), thumbCmd: prepared.thumbCmd && Object.freeze(prepared.thumbCmd.slice()),
            metadata: prepared.metadata ? video(prepared.metadata) : null, proxyPolicy: ctx.proxyPolicy });
        return this._enqueue(async () => {
            if (this.closed || session.closed || ticket !== this.ticket || !currentAuth()) return;
            const old = this.owner;
            await this.player.retire();
            if (old) this._send(old.session, { ev: 'state', state: 'idle', id: null });
            this.owner = null;
            if (this.closed || session.closed || ticket !== this.ticket || !currentAuth()) return;
            const epoch = ++this.epoch;
            this.pendingPlay = null;
            this.owner = { session, providerId: session.providerId, id, epoch, qualityTicket: 0 };
            const emit = (event) => {
                if (this.owner && this.owner.epoch === epoch && !session.closed && currentAuth()) this._send(session, event);
            };
            this.player.configure(context, emit);
            if (session.displayTarget) await this.player.command('display', { target: session.displayTarget });
            await this.player.command('video', { on: session.videoOn });
            if (this.closed || session.closed || !this.owner || this.owner.epoch !== epoch || ticket !== this.ticket || !currentAuth()) return;
            // Loading can take seconds: do not block a newer play/stop behind it.
            Promise.resolve().then(() => this.player.play(message)).catch((e) => emit({ ev: 'error', msg: cleanError(e) }));
        });
    }
    async close() {
        if (this.closed) return;
        this.closed = true;
        this.ticket++;
        this.clients.forEach((s) => { s.closed = true; s.socket.destroy(); });
        this.clients.clear();
        await this._enqueue(async () => { await this.player.retire(); this.owner = null; });
        await Promise.all(this.servers.map((s) => new Promise((resolve) => s.close(resolve))));
        if (typeof this.player.close === 'function') await this.player.close();
        await Promise.all(Object.keys(this.providers).map((id) => {
            const provider = this.providers[id];
            return typeof provider.close === 'function' ? provider.close() : undefined;
        }));
    }
}

function waitForExit(child, timeoutMs) {
    if (!child || child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            child.removeListener('exit', exited);
            child.removeListener('close', exited);
            if (error) reject(error); else resolve();
        };
        const exited = () => finish();
        const timer = setTimeout(() => finish(new Error('media helper did not exit; refusing concurrent playback')), timeoutMs || 4500);
        child.once('exit', exited);
        child.once('close', exited);
    });
}

class DaemonPlayer {
    constructor(options) {
        const core = require('../core/native/jap-ridetube-d/ytd.js');
        this.engine = new core.Daemon(Object.assign({}, options, { embedded: true, spare: false,
            eventSink: (event) => { if (this.emit) this.emit(event); } }));
        this.fixedStateDir = this.engine.opts.stateDir;
        this.baseOptions = Object.assign({}, this.engine.opts);
        this.emit = null;
        this.retiring = new Set();
        const ClusterOutput = require('./cluster_output').ClusterOutput;
        this.displayTarget = 'main';
        this.cluster = new ClusterOutput({ active: () => !!(this.engine.child && this.engine.cur &&
            this.engine.videoOn && ['playing', 'paused'].indexOf(this.engine.state) >= 0),
            report: (state) => { if (this.emit) this.emit({ ev: 'display', target: this.displayTarget, state }); } });
        // Core paths such as requality/failPlayback clear engine.child as soon as
        // they send quit. Keep every decoder until its process has actually left,
        // including decoders released outside the gateway's retire() call.
        const killYtdec = this.engine.killYtdec;
        this.engine.killYtdec = () => {
            this._trackRetirement(this.engine.child);
            return killYtdec.call(this.engine);
        };
        const stop = this.engine.stop;
        this.engine.stop = async (reason, preservePlayIntent) => {
            const result = await stop.call(this.engine, reason, preservePlayIntent);
            // Internal play/requality stops also wait for old writers, even if
            // no provider switch passes through gateway.retire().
            await this._waitRetirements();
            return result;
        };
    }
    _trackRetirement(child) {
        if (!child || child.exitCode !== null && child.exitCode !== undefined || child.signalCode || this.retiring.has(child)) return;
        this.retiring.add(child);
        const exited = () => {
            this.retiring.delete(child);
            child.removeListener('exit', exited);
            child.removeListener('close', exited);
        };
        child.once('exit', exited);
        child.once('close', exited);
    }
    async _waitRetirements() {
        while (this.retiring.size) {
            await Promise.all(Array.from(this.retiring).map((child) => waitForExit(child).then(() => this.retiring.delete(child))));
        }
        // The decoder leaves its last frame behind. A later owner must never
        // show that frame while its own decoder is still starting.
        try {
            const st = fs.lstatSync(this.cluster.file);
            if (st.isFile() && (st.uid === 0 || st.uid === 65534)) fs.unlinkSync(this.cluster.file);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    setYouTubeProvider(provider) {
        if (!provider.daemon) return;
        // Queries/history always retain immutable YouTube proxy/account options.
        this.engine.account = provider.daemon.account;
        this.engine.opts.ytRequest = provider.daemon.opts.ytRequest;
    }
    start() { return this.engine.start(); }
    async retire() {
        this.cluster.heartbeat(false);
        const d = this.engine;
        const decoder = d.child, extras = [d.spare, d.extracting].filter(Boolean).map((x) => x.child);
        [decoder].concat(extras).forEach((child) => this._trackRetirement(child));
        d.spare = null; d.extracting = null; d.nextPrefetch = null;
        extras.forEach((child) => { try { child.kill('SIGKILL'); } catch (e) { /* exit already queued */ } });
        await d.stop('idle');
        // stop() can itself release a decoder. Re-read the registry after it, and
        // after each wait, so no detached writer is missed by a provider switch.
        await this._waitRetirements();
    }
    configure(context, emit) {
        const d = this.engine;
        if (d.child || d.fetcher || d.spare || d.extracting || this.retiring.size) throw new Error('player was not retired');
        mkdir(context.cacheDir, 0o711);
        this.emit = emit;
        // Invalidate an old play/requality continuation awaiting audio release.
        d.playIntent = (d.playIntent || 0) + 1;
        d.gen++;
        d.opts.cacheDir = context.cacheDir;
        d.opts.fetcher = context.fetcher.slice();
        d.opts.thumbCmd = context.thumbCmd ? context.thumbCmd.slice()
            : context.providerId === 'youtube' ? this.baseOptions.thumbCmd.slice() : null;
        d.opts.providerId = context.providerId;
        d.opts.proxyPolicy = context.proxyPolicy;
        d.opts.genericMediaIds = context.providerId !== 'youtube';
        d.opts.initialMetadata = context.metadata;
        d.opts.stateDir = this.fixedStateDir;
        d.pos = null; d.cur = null; d.fullReady = false;
        d.videoOn = false;
        this.displayTarget = 'main';
    }
    play(message) { return this.engine.play(String(message.id), message.rect, !!message.fill, message.at, message.quality, message.skip); }
    command(cmd, message) {
        const d = this.engine;
        if (cmd === 'pause') return d.pause();
        if (cmd === 'resume') return d.resume();
        if (cmd === 'seek') return d.seek(message.ms);
        if (cmd === 'video') {
            this.cluster.heartbeat(!!message.on && this.displayTarget !== 'main');
            return d.setVideo(!!message.on);
        }
        if (cmd === 'display') {
            if (message.target !== 'main' && !this.cluster.available())
                throw new Error('Для приборки нужен установленный cluster-render. Выберите основной экран.');
            this.displayTarget = message.target;
            this.cluster.heartbeat(false);
            return;
        }
        if (cmd === 'fill') {
            const current = d.cur, on = !!message.on;
            if (!current || current.fill === on) return;
            current.fill = on;
            const child = d.child, gen = d.gen;
            if (!child) return;
            this._trackRetirement(child);
            const exited = waitForExit(child).then(() => this.retiring.delete(child));
            d.killYtdec();
            return exited.then(() => {
                if (d.cur !== current || d.gen !== gen) return;
                d.spawnYtdec(d.paused || d.headWait ? d.elapsed : d.elapsed + (Date.now() - d.lastTickAt));
            });
        }
        if (cmd === 'quality') return d.requality(message.quality);
        throw new Error('unsupported playback control');
    }
    status() {
        const d = this.engine;
        return { state: d.state, id: d.cur && d.cur.id || null, title: d.cur && d.cur.title || null,
            elapsed: d.elapsed, total: d.total, buffering: d.isBuffering() };
    }
    close() { this.cluster.close(); this.emit = null; return this.engine.close(); }
}

function createYouTubeProvider(options) {
    const core = require('../core/native/jap-ridetube-d/ytd.js');
    let publish = function () {};
    const daemon = new core.Daemon(Object.assign({}, options, { embedded: true, providerId: 'youtube', proxyPolicy: 'youtube',
        spare: false, eventSink: (event) => publish(event) }));
    // This daemon is a query/account adapter only; it never starts SOME/IP, a listener or a decoder.
    return {
        id: 'youtube', daemon,
        context: { cacheDir: daemon.opts.cacheDir, stateDir: daemon.opts.stateDir },
        attach: (emit) => { publish = emit; },
        search: (q) => daemon.search(q), feed: (which) => daemon.account.feed(which),
        auth: () => daemon.account.start(), status: () => daemon.account.status(), signOut: () => daemon.account.signOut(),
        thumb: (id) => daemon.thumb(id),
        positions: () => { daemon.pos = null; daemon.sendPositions(); },
        channels: () => daemon.account.channels(), channel: (id) => daemon.account.channel(id),
        preparePlayback: async (id) => {
            if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('bad YouTube id');
            return { id, cacheDir: daemon.opts.cacheDir, fetcher: daemon.opts.fetcher.slice(), thumbCmd: daemon.opts.thumbCmd.slice() };
        },
        close: () => daemon.close()
    };
}

module.exports = { Gateway, DaemonPlayer, createYouTubeProvider, SAFE_ID, waitForExit, authState };
