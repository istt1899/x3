'use strict';
// Exercise the real shared app entry point with a small canvas/HMI stand-in.
const assert = require('assert');
const Events = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { attachNetwork } = require('./network-view');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
async function app(own) {
    const sent = [], clicks = {}, labels = {}, opened = [], targets = {}, words = [], hidden = [], wants = [];
    let start, render, model;
    let moving = false;
    const settingsMap = {};
    class Ctl extends Events {
        send(message) { sent.push(message); return true; }
        connect() {}
    }
    class Model {
        constructor() {
            this.connected = false; this.state = 'idle'; this.phase = null; this.pct = 0;
            this.id = null; this.title = ''; this.results = []; this.thumbs = {};
            this.feeds = {}; this.auth = { state: 'unknown' }; this.rev = 0;
            this.error = null; this.searchError = null; this.total = 0; this.elapsed = 0;
            model = this;
        }
        active() { return ['preparing', 'playing', 'paused'].indexOf(this.state) >= 0; }
        feed() {} setDisplayTarget() {} setWantVideo(v) { wants.push(!!v); }
        checkSearch() {} checkFeeds() {} checkAuth() {}
        item() { return null; }
    }
    const modules = {
        './service-config': { id: 'vk', title: 'VK Видео', accent: '#0077ff' },
        './account-view': { accountView() { return { kind: 'error', title: '', hint: '' }; } },
        './network-view': { attachNetwork },
        './kit/mgu': { run(entry) { start = entry.start; } },
        './kit/gauges': { frame() {} },
        './kit/qr': { encode() { return []; }, draw() {} },
        './kit/record': { setImage() {} },
        './kit/display': { HMI: { left: 120 } },
        './kit/parked': { watch() { return { moving() { return moving; } }; } },
        './yt': { Ctl, Model, SOCKET: 'test', FEEDS: ['home'], SHELF_MAX: 12, clock() { return '0:00'; } },
        './speller': { spell() { return Promise.resolve(''); } },
    };
    vm.runInNewContext(source, {
        require: (id) => modules[id] || require(id),
        process: { env: {}, on() {} },
        setInterval() {}, setTimeout, clearTimeout,
    }, { filename: 'media/ui/main.js' });
    const ui = {
        text: (key, value) => { labels[key] = value; },
        onClick: (key, fn) => { clicks[key] = fn; },
        open: (name) => { opened.push(name); },
        image() { return Promise.resolve(); },
        onVisible() {}, isVisible: (name) => name === 'VIEW', hasFocus() { return true; },
    };
    const canvas = () => {
        const cv = { own, extra: 0, place: null, targets: [] };
        const chain = ['clear', 'arc', 'line', 'roundRect', 'circle', 'strokeRoundRect', 'quad', 'fillRect', 'text', 'gradientRect', 'polyline'];
        chain.forEach((name) => { cv[name] = (...args) => { if (name === 'text') words.push(String(args[0])); return cv; }; });
        cv.textWidth = (value) => String(value).length * 12;
        cv.target = (x, y, w, h, run, key) => { targets[key] = run; return cv; };
        return cv;
    };
    await start({
        ui, spec: { id: 'marku_vk_video' }, dataDir: os.tmpdir(),
        settings: { get(key) { return settingsMap[key]; } },
        log: { info() {}, warn() {}, error(e) { throw e; } },
        signals: { watch() {} },
        canvas, theme() { return {}; },
        hideButton: (id) => hidden.push(id),
        loop: (name, fps, fn) => { assert.strictEqual(name, 'VIEW'); render = fn; },
    });
    return { sent, clicks, labels, opened, targets, words, hidden, model, render, wants, settingsMap,
        setMoving: (v) => { moving = v; } };
}

(async () => {
    const fallback = await app(false);
    await fallback.render();
    assert(!fallback.words.includes('Интернет'), 'fallback canvas has no inert network rail item');
    assert(!fallback.targets['rail:network'], 'fallback has no canvas hit target');
    fallback.clicks.BTN_NETWORK();
    assert.deepStrictEqual(fallback.sent[fallback.sent.length - 1], { cmd: 'network_status' });
    assert.strictEqual(fallback.opened.pop(), 'NETWORK', 'HMI button opens the network menu');
    fallback.model.connected = true;
    fallback.model.state = 'preparing'; fallback.model.phase = 'audio'; fallback.model.pct = 23;
    fallback.model.id = '1_2'; fallback.model.title = 'Ролик';
    fallback.clicks.BTN_NOW(); await fallback.render();
    assert(fallback.words.some((word) => /начальный звук.*стартовый буфер 23 %/.test(word)), 'preparing names the playable buffer stage');
    fallback.model.state = 'playing'; fallback.model.buffering = true; fallback.model.rev++;
    await fallback.render();
    assert(fallback.words.includes('Буферизация…'), 'buffering remains visible after playback starts');
    fallback.model.state = 'preparing'; fallback.model.phase = 'resolve'; fallback.model.pct = 0; fallback.model.rev++;
    await fallback.render();
    assert(fallback.words.some((word) => /Получаем ссылку на видео/.test(word)));
    fallback.model.state = 'error'; fallback.model.error = 'Сервер видео отклонил ссылку (HTTP 403).'; fallback.model.rev++;
    await fallback.render();
    assert(fallback.words.some((word) => /HTTP 403/.test(word)), 'playback failure replaces the preparing ring');

    const native = await app(true);
    await native.render();
    assert(native.words.includes('Интернет'), 'own renderer draws the network rail item');
    assert.strictEqual(typeof native.targets['rail:network'], 'function', 'own renderer registers its hit target');
    assert(native.hidden.includes('BTN_NETWORK'), 'own mode hides the duplicate HMI button');
    native.targets['rail:network']();
    assert.deepStrictEqual(native.sent[native.sent.length - 1], { cmd: 'network_status' });
    assert.strictEqual(native.opened.pop(), 'NETWORK');

    /* ---- the drive-lock latch (specs/video-driving-20261108 AC-001..007): gate decisions via setWantVideo ---- */
    async function driveLock() {
        const a = await app(false);
        a.model.state = 'playing';
        const gate = () => { a.clicks.BTN_NOW(); return a.wants[a.wants.length - 1]; };
        // AC-001: parked + setting on -> video
        a.settingsMap.video_driving = true;
        assert.strictEqual(gate(), true, 'AC-001 parked + on shows video');
        // AC-002: moving, armed while parked -> video stays
        a.setMoving(true);
        assert.strictEqual(gate(), true, 'AC-002 moving + armed keeps video');
        // AC-005: switched off while moving -> off at the next tick
        a.settingsMap.video_driving = false;
        assert.strictEqual(gate(), false, 'AC-005 off while moving hides video');
        // AC-004: switched on while moving -> does not arm
        a.settingsMap.video_driving = true;
        assert.strictEqual(gate(), false, 'AC-004 on while moving does not arm');
        // back to parked: the setting arms again
        a.setMoving(false);
        assert.strictEqual(gate(), true, 're-armed once parked');

        // AC-003: a fresh app whose first gate decision happens while moving never arms
        const b = await app(false);
        b.model.state = 'playing';
        b.settingsMap.video_driving = true;
        b.setMoving(true);
        b.clicks.BTN_NOW();
        assert.strictEqual(b.wants[b.wants.length - 1], false, 'AC-003 never-armed while moving hides video');

        // AC-006: armed, then speed goes stale/missing (strict: moving() reports true) -> picture stays, as in RideTube
        const c = await app(false);
        c.model.state = 'playing';
        c.settingsMap.video_driving = true;
        c.clicks.BTN_NOW();
        c.setMoving(true);
        assert.strictEqual(c.wants[c.wants.length - 1], true, 'AC-006 armed latch holds through a stale speed read');

        // AC-007: cluster never gets video while moving; main does when armed
        const d = await app(false);
        d.model.state = 'playing';
        d.settingsMap.video_driving = true;
        d.settingsMap.display = 'cluster';
        d.clicks.BTN_NOW();
        d.setMoving(true);
        d.clicks.BTN_NOW();
        assert.strictEqual(d.wants[d.wants.length - 1], false, 'AC-007 cluster: never while moving');
        d.settingsMap.display = 'main';
        d.clicks.BTN_NOW();
        assert.strictEqual(d.wants[d.wants.length - 1], true, 'AC-007 main: armed latch shows video');
    }
    await driveLock();
    console.log('ok: fallback HMI and own rail open NETWORK; preparing and buffering appear in the UI; drive-lock latch matrix');
})().catch((e) => { console.error(e); process.exitCode = 1; });
