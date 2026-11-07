'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// External = the existing mgu-uplink UID. Builtin = a separate, unregistered UID,
// using an owner-verified native route. No BMW routes/firewall rules are rewritten.
const fs = require('fs'), path = require('path'), cp = require('child_process'), net = require('net');
const core = require('../core/native/jap-ridetube-d/ytd');
const SOURCES = ['external', 'builtin'];
function read(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw new Error('Не удалось прочитать настройки интернета'); }
}
function route(text) {
    const dev = /\bdev\s+([A-Za-z0-9_.:-]{1,15})(?:\s|$)/.exec(text);
    const src = /\bsrc\s+([0-9.]+)(?:\s|$)/.exec(text);
    if (!dev || !src || net.isIP(src[1]) !== 4 || /\b(unreachable|blackhole|prohibit)\b/.test(text))
        throw new Error('Нет подходящего маршрута встроенного интернета');
    return { interface: dev[1], sourceIp: src[1] };
}
class NetworkAccess {
    constructor(options) {
        const o = options || {};
        this.stateDir = o.stateDir;
        this.cacheDir = o.cacheDir;
        this.runtimeDir = o.runtimeDir || '/run/jap-ridetube-d';
        this.python = o.python;
        this.getExternalUid = o.getExternalUid;
        this.uidOptions = o.uidOptions;
        this.getBuiltinUid = o.getBuiltinUid || (() => core.pickFetchUid(Object.assign({}, this.uidOptions, { uidRole: 'builtin' })));
        this.spawn = o.spawn || cp.spawn;
        this.execFileSync = o.execFileSync || cp.execFileSync;
        this.noSetuid = !!o.noSetuid;
        this.file = path.join(this.stateDir, 'network.json');
        const saved = read(this.file);
        this.source = saved && SOURCES.indexOf(saved.source) >= 0 ? saved.source : 'external';
        this.results = {}; this.busy = false; this.children = new Set(); this.lastTest = 0; this.cancelled = false; this.testing = null;
    }
    cache(base, source) { return (source || this.source) === 'builtin' ? path.join(base, 'network-builtin') : base; }
    route(ip, uid) {
        try { return route(this.execFileSync('/sbin/ip', ['-4', 'route', 'get', ip, 'uid', String(uid)],
            { encoding: 'utf8', timeout: 2000, maxBuffer: 8192 })); }
        catch (e) { throw new Error('Нет подтверждённого маршрута встроенного интернета BMW'); }
    }
    profile() {
        const file = path.join(this.stateDir, 'builtin-network.json');
        let st;
        try { st = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') throw new Error('Встроенный интернет: нужна первичная проверка MGU по SSH'); throw e; }
        if (!st.isFile() || st.isSymbolicLink() || st.size > 4096 || (!this.noSetuid && (st.uid !== 0 || (st.mode & 0o077))))
            throw new Error('Некорректные права профиля встроенного интернета');
        const p = read(file);
        if (!p || p.verified !== true || !/^[A-Za-z0-9_.:-]{1,15}$/.test(p.interface || '') ||
            /^(lo|wlan|veth|tun|tap|docker)/.test(p.interface) || net.isIP(p.sourceIp || '') !== 4 ||
            !Array.isArray(p.dns) || !p.dns.length || p.dns.length > 4 || p.dns.some((v) => net.isIP(v) !== 4 || /^(0\.|127\.)/.test(v)))
            throw new Error('Профиль встроенного интернета не подтверждён');
        return p;
    }
    context(source) {
        if (SOURCES.indexOf(source) < 0) throw new Error('Неизвестный источник интернета');
        if (source === 'external') {
            const leaseFile = '/run/mgu-uplink/lease.json';
            const uid = this.getExternalUid();
            return { source: source, uid: uid, leaseFile: leaseFile };
        }
        const p = this.profile(), uid = this.getBuiltinUid();
        if (!Number.isInteger(uid) || uid <= 0 || uid === this.getExternalUid()) throw new Error('Нет отдельного UID встроенного интернета');
        const external = read('/run/mgu-uplink/lease.json');
        if (external && external.interface === p.interface) throw new Error('Встроенный и внешний канал используют один интерфейс');
        const actual = this.route('1.1.1.1', uid);
        if (actual.interface !== p.interface || actual.sourceIp !== p.sourceIp) throw new Error('Маршрут BMW изменился: нужна повторная проверка MGU');
        p.dns.forEach((ip) => {
            const r = this.route(ip, uid);
            if (r.interface !== p.interface) throw new Error('DNS BMW использует другой канал');
        });
        if (!fs.existsSync(this.runtimeDir)) fs.mkdirSync(this.runtimeDir, 0o755);
        const leaseFile = path.join(this.runtimeDir, 'builtin-lease.json');
        fs.writeFileSync(leaseFile + '.tmp', JSON.stringify({ dns: p.dns, interface: p.interface,
            ip: p.sourceIp, networkSource: 'builtin' }), { mode: 0o644 });
        fs.renameSync(leaseFile + '.tmp', leaseFile);
        return { source: source, uid: uid, leaseFile: leaseFile, interface: p.interface, sourceIp: p.sourceIp };
    }
    uid() { return this.context(this.source).uid; }
    leaseFile() { return this.source === 'builtin' ? path.join(this.runtimeDir, 'builtin-lease.json') : '/run/mgu-uplink/lease.json'; }
    state() { return { ev: 'network', source: this.source, busy: this.busy, testing: this.testing, results: this.results }; }
    async probe(source, provider, speed) {
        let ctx;
        try { ctx = this.context(source); }
        catch (e) { return { source: source, ok: false, message: e.message }; }
        return new Promise((resolve) => {
            const ids = this.noSetuid ? {} : { uid: ctx.uid, gid: ctx.uid };
            let child, done = false, size = 0, timer, output = [];
            const finish = (result) => {
                if (done) return; done = true; clearTimeout(timer);
                this.children.delete(cancel);
                try { if (child) child.kill('SIGKILL'); } catch (e) {}
                resolve(Object.assign({ source: source }, result));
            };
            const cancel = () => finish({ ok: false, message: 'Проверка отменена' });
            try { child = this.spawn(this.python, ['-I', path.join(__dirname, 'network_probe.py')], Object.assign(ids,
                { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'ignore'] })); }
            catch (e) { finish({ ok: false, message: 'Не удалось запустить проверку' }); return; }
            this.children.add(cancel);
            timer = setTimeout(() => finish({ ok: false, message: 'Канал не ответил вовремя' }), 30000);
            child.on('error', () => finish({ ok: false, message: 'Проверка недоступна' }));
            child.stdin.on('error', () => finish({ ok: false, message: 'Проверка недоступна' }));
            child.stdout.on('data', (part) => {
                size += part.length;
                if (size > 16384) return finish({ ok: false, message: 'Некорректный ответ проверки' });
                output.push(part);
            });
            child.on('close', () => {
                try {
                    const answer = JSON.parse(Buffer.concat(output).toString('utf8'));
                    if (typeof answer.ok !== 'boolean') throw new Error('bad result');
                    finish(answer);
                } catch (e) { finish({ ok: false, message: 'Проверка не завершена' }); }
            });
            let proxy = null;
            if (provider === 'youtube') {
                try { proxy = read(path.join(this.stateDir, 'proxy.json')); } catch (e) {}
            }
            // Proxy credentials only cross the child's private stdin, never argv/env/UI.
            child.stdin.end(JSON.stringify({ source: source, provider: provider, speed: !!speed,
                leaseFile: ctx.leaseFile, interface: ctx.interface, sourceIp: ctx.sourceIp,
                caFile: path.join(__dirname, '..', 'runtime', 'cacert.pem'),
                proxy: proxy && proxy.url || null }));
        });
    }
    async select(source, provider) {
        if (SOURCES.indexOf(source) < 0) throw new Error('Неизвестный источник интернета');
        const result = await this.probe(source, provider, false);
        this.results[source] = result;
        if (!result.ok && source === 'builtin') throw new Error(result.message || 'Выбранный канал недоступен');
        fs.writeFileSync(this.file + '.tmp', JSON.stringify({ source: source }) + '\n', { mode: 0o600 });
        fs.renameSync(this.file + '.tmp', this.file);
        this.source = source;
    }
    cancel() { this.cancelled = true; Array.from(this.children).forEach((cancel) => cancel()); }
    async test(provider, emit) {
        if (Date.now() - this.lastTest < 30000) throw new Error('Повторить тест можно через 30 секунд');
        this.lastTest = Date.now(); this.results = {}; this.cancelled = false;
        for (const source of SOURCES) {
            if (this.cancelled) break;
            this.testing = source; emit(this.state());
            this.results[source] = await this.probe(source, provider, true);
            this.testing = null;
            emit(this.state());
        }
        return this.state();
    }
    close() { this.cancel(); }
}
module.exports = { NetworkAccess, route };
