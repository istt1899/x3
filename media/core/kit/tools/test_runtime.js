'use strict';

// Kit runtime (display.js, renderd.js, mgu.js Settings) against a stand-in mgu-render on a Unix socket: the
// unchanged-frame skip and its keepalive, a sheet that throws, X_STATE front flips, a reconnect after a cut
// message, the theme kept on a fresh install, the Russian catalog (plurals, rows, glyphs, the HMI table). No SDK,
// renderer or car needed:
//   node kit/tools/test_runtime.js

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-rt-'));
process.env.MGU_RENDERD_SOCKET = path.join(dir, 'render.sock');
['MGU_RENDERER', 'MGU_RENDERD_FILE', 'MGU_RENDERD_PROTO', 'MGU_NO_GRAB'].forEach((k) => delete process.env[k]);
const { Display } = require('../runtime/display');
const { RenderClient } = require('../runtime/renderd');
const themes = require('../runtime/themes');

const FRAME = 7, READY = 101, TICK = 102, TOUCH = 105, X_READY = 0x4d520101, X_STATE = 0x4d520102, X_CCU = 0x4d520103;
const uncaught = [];
process.on('uncaughtException', (e) => uncaught.push(e));     // (else node exits, as mgu.js does on the car)
const SHOW_WAIT = 600;                                   // over display.js SHOW_DELAY_MS (350)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u32 = (...a) => Buffer.from(new Uint32Array(a).buffer);
function msg(type, p) {
    const b = Buffer.alloc(8 + p.length + ((4 - (p.length & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4); p.copy(b, 8);
    return b;
}
async function waitFor(fn, ms) {
    for (const t0 = Date.now(); Date.now() - t0 < (ms || 2000); await sleep(10)) if (fn()) return true;
    return false;
}

// the renderer's side: the app's FRAMEs (time of each, a TICK back for each), READY on connect (onConn)
let onConn = null;
const server = net.createServer((s) => {
    const c = { s, frames: [], buf: Buffer.alloc(0), send: (t, p) => s.write(msg(t, p)) };
    s.on('data', (d) => {
        c.buf = Buffer.concat([c.buf, d]);
        while (c.buf.length >= 8) {
            const t = c.buf.readUInt32LE(0), n = c.buf.readUInt32LE(4);
            if (c.buf.length < 8 + n) break;
            c.buf = c.buf.slice(8 + n);
            if (t === FRAME) { c.frames.push(Date.now()); c.send(TICK, u32(c.frames.length, 0)); }
        }
    });
    s.on('error', () => {});
    onConn(c);
});
const ready = (c) => { c.send(X_READY, u32(1, 1, 7)); c.send(READY, u32(4, 1920, 720, 1)); };   // touch, controller, front gate
const ccu = (k, pb, df) => { const b = Buffer.alloc(5); b.writeUInt16BE(k, 1); b[3] = pb; b[4] = df; return b; };
const touch = (phase, x, y) => { const b = Buffer.alloc(12); b.writeUInt32LE(phase, 0); b.writeFloatLE(x, 4); b.writeFloatLE(y, 8); return b; };

/** A Display on the stand-in renderer, the kit running the screen (full-screen layout, touch), shown. */
async function setup() {
    let conn = null;
    onConn = (c) => { conn = c; ready(c); };
    const log = { errors: [], info() {}, warn() {}, debug() {}, error: (...a) => log.errors.push(a) };
    const vis = new Set(['MAIN']), visH = [];
    const ui = {
        rhmi: null, close() {}, visible() {}, onVisible: (fn) => visH.push(fn), isVisible: (n) => vis.has(n),
        setVisible: (v) => { if (v) vis.add('MAIN'); else vis.delete('MAIN'); visH.forEach((fn) => fn('MAIN', v)); },
    };
    const spec = { id: 'test', title: 'Test', screens: [{ name: 'MAIN', kind: 'canvas', buttons: [['BTN_SETTINGS', 'Settings']] }] };
    const d = new Display(ui, log, spec, { get: () => undefined, onChange() {} }, () => themes.theme());
    assert(await waitFor(() => conn && d.active() && d.own()), 'display on the renderer');
    return { d, ui, log, c: conn, end() { d.closeSheet(); d.gpu.close(); clearInterval(d.keepTimer); } };
}
/** The app draws its page (v: what changes) and hands it over, as ui.image does. */
function page(d, v) {
    const r = d.canvas(1600, 520);
    r.fillRect(100, 100, 400, 200, '#ff0000'); r.fillRect(0, 300, v, 10, '#00ff00');
    d.present('MAIN', r, () => Promise.resolve());
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('unchanged frames: not sent again, but one a second (the renderer hides an app quiet for 3 s)', async () => {
    const t = await setup(), c = t.c;
    try {
        const t0 = Date.now();
        while (Date.now() - t0 < 2500) { page(t.d, 10); await sleep(16); }
        const f = c.frames.slice(), gaps = f.slice(1).map((x, i) => x - f[i]).concat(Date.now() - f[f.length - 1]);
        console.log('  a static page at 60 fps for 2.5 s: ' + f.length + ' FRAMEs, longest gap ' + Math.max(...gaps) + ' ms');
        assert(f.length >= 2 && f.length <= 6, 'FRAMEs for a static page: ' + f.length);
        assert(Math.max(...gaps) < 1600, 'the longest time without a FRAME: ' + Math.max(...gaps) + ' ms');
        // a changed page: at once
        let n = c.frames.length;
        page(t.d, 20); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'a changed page');
        // the header changed (the knob turned onto a tab), the page did not: at once, and only once
        n = c.frames.length;
        c.send(X_CCU, ccu(0, 0, 0)); c.send(X_CCU, ccu(1, 0, 0)); await sleep(50);
        assert.strictEqual(t.d.focusTab, 0);
        assert.strictEqual(c.frames.length, n + 1, 'the header changed');
        page(t.d, 20); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'the same page with the same header');
        // shown again: the picture comes back once the HMI's page has opened (display.js SHOW_DELAY_MS, 350 ms),
        // then the same page goes out at once
        t.ui.setVisible(false); t.ui.setVisible(true);
        await sleep(450);
        n = c.frames.length;
        page(t.d, 20); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'shown again');
        // a sheet painted every 33 ms that does not change: its first frame, then the keepalive
        n = c.frames.length;
        assert(t.d.openSheet({ draw: (r) => { r.fillRect(0, 0, 50, 50, '#0000ff'); return []; }, move() {} }));
        await sleep(1500);
        console.log('  a static sheet for 1.5 s: ' + (c.frames.length - n) + ' FRAMEs');
        assert(c.frames.length - n >= 2 && c.frames.length - n <= 4, 'FRAMEs for a static sheet: ' + (c.frames.length - n));
        // closed: the page again, at once
        n = c.frames.length;
        t.d.closeSheet(); await sleep(50);
        assert.strictEqual(c.frames.length, n + 1, 'the sheet closed');
    } finally { t.end(); }
});

test('a sheet\'s press, back and touch target that throw: logged, the app runs on', async () => {
    const t = await setup(), c = t.c;
    try {
        page(t.d, 10);
        const boom = (w) => () => { throw new Error(w); };
        assert(t.d.openSheet({ draw: () => [{ x: 0, y: 0, w: 1600, h: 520, act: boom('act') }], move() {}, press: boom('press'), back: boom('back') }));
        const n = uncaught.length;
        c.send(X_CCU, ccu(0, 0, 0)); c.send(X_CCU, ccu(0, 1, 0));                      // press
        c.send(X_CCU, ccu(0, 0, 0)); c.send(X_CCU, ccu(0, 0, 10));                     // push left
        c.send(TOUCH, touch(1, 800, 300)); c.send(TOUCH, touch(3, 800, 300));          // a tap on the target
        await sleep(100);
        // (an uncaught exception ends the app on the car: mgu.js process.exit(1), and the platform wipes its data)
        assert.deepStrictEqual(uncaught.slice(n).map((e) => e.message), [], 'uncaught in the socket\'s data handler');
        assert.deepStrictEqual(t.log.errors.map((a) => a[0] + ' ' + a[1].message), ['sheet press', 'sheet back', 'sheet act']);
        assert(t.d.sheet, 'the sheet stays open');
    } finally { t.end(); }
});

test('not in front, then in front (not on screen yet) within 1.5 s: the app stays on the renderer', async () => {
    const t = await setup(), c = t.c;
    try {
        page(t.d, 10);
        c.send(X_STATE, u32(1, 0, 0)); await sleep(100);
        c.send(X_STATE, u32(1, 0, 1)); await sleep(1700);
        assert(!t.d.blocked, 'blocked though in front');
        assert(t.d.own());
        // not in front for good: blocked after 1.5 s
        c.send(X_STATE, u32(1, 0, 0)); await sleep(1700);
        assert.strictEqual(t.d.blocked, true, 'not in front for 1.5 s');
    } finally { t.end(); }
});

test('a connection cut in the middle of a message: the next connection\'s READY is read', async () => {
    let n = 0;
    onConn = (c) => {
        if (n++) { ready(c); return; }
        c.s.write(Buffer.concat([u32(TICK, 8), u32(1)]));                              // 4 of TICK's 8 bytes
        setTimeout(() => c.s.destroy(), 50);
    };
    const g = new RenderClient('test', { info() {}, warn() {}, error() {} }, { native: true });
    try {
        let readyN = 0;
        g.on('ready', () => readyN++);
        g.connect();
        await waitFor(() => readyN, 5000);
        assert.strictEqual(n, 2, 'connected again');
        assert.strictEqual(readyN, 1, 'READY after the reconnect');
        assert(g.native && g.info && g.info.touch, 'X_READY after the reconnect');
    } finally { g.close(); }
});

test('the one-time move to the new default theme: a theme picked on a fresh install stays', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
    const cls = src.match(/class Settings[\s\S]*?\n}\n/)[0];      // (as hu-stub.js: the real class without the SDK)
    const make = (sub) => {
        const dd = path.join(dir, sub);
        fs.mkdirSync(dd);
        return new Function('fs', 'path', 'DATA_DIR', 'log', cls + '\nreturn Settings;')(fs, path, dd, { warn() {}, error() {} });
    };
    const file = (sub) => path.join(dir, sub, 'settings.json');
    const schema = [{ key: 'theme', type: 'choice', default: 'm_tricolour', options: [] }, { key: 'units', type: 'choice', default: 'metric', options: [] }];
    // fresh install: no file until something is set; a theme set then stays
    let S = make('fresh');
    assert.strictEqual(new S(schema).get('theme'), 'm_tricolour');
    assert(!fs.existsSync(file('fresh')), 'a fresh start writes no file');
    new S(schema).set('theme', 'amber');
    assert.strictEqual(new S(schema).get('theme'), 'amber', 'theme picked on a fresh install, next start');
    // another setting set first, the theme later: stays too
    S = make('fresh2');
    new S(schema).set('units', 'imperial');
    new S(schema).set('theme', 'amber');
    assert.strictEqual(new S(schema).get('theme'), 'amber', 'theme picked after another setting, next start');
    // saved before the new default (no mark): moved to it once, the next choice stays
    S = make('old');
    fs.writeFileSync(file('old'), JSON.stringify({ theme: 'amber', units: 'imperial' }));
    const o = new S(schema);
    assert.strictEqual(o.get('theme'), 'm_tricolour', 'an old save moves to the new default');
    assert.strictEqual(o.get('units'), 'imperial');
    assert.strictEqual(JSON.parse(fs.readFileSync(file('old'), 'utf8'))._themeV, 2);
    o.set('theme', 'amber');
    assert.strictEqual(new S(schema).get('theme'), 'amber');
});

test('a menu of ours over the drawn page (the HMI stack still lists the page): no picture until the page is in front again', async () => {
    // the real Ui class (as the Settings test: the class without the SDK); the HMI's events as mgu.js gets them
    const src = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mgu.js'), 'utf8').replace(/\r\n/g, '\n');
    const cls = src.match(/class Ui \{[\s\S]*?\n}\n/)[0];
    const quiet = { info() {}, warn() {}, debug() {}, error() {} };
    const Ui = new Function('log', 'HmiText', cls + '\nreturn Ui;')(quiet, class {});
    const ui = new Ui({ rhmiApplication: { openState: () => Promise.resolve(), getByName: () => null } });
    // the HMI's side: a screen we open is listed at once (its visible event)
    const open = (n) => { ui.open(n); ui._setVisible(n, true); };
    let conn = null;
    onConn = (c) => { conn = c; ready(c); };
    const log = { errors: [], info() {}, warn() {}, debug() {}, error: (...a) => log.errors.push(a) };
    const spec = { id: 'test', title: 'Test', screens: [{ name: 'VIEW', kind: 'canvas', buttons: [] }, { name: 'MAIN', kind: 'menu', items: [] }] };
    const d = new Display(ui, log, spec, { get: () => undefined, onChange() {} }, () => themes.theme());
    try {
        open('VIEW');
        assert(await waitFor(() => conn && d.active() && d.own()), 'display on the renderer');
        assert(await waitFor(() => d.gpu.visible, 1500), 'the drawn page shows');
        open('MAIN');                                         // the rail's Search
        assert.strictEqual(ui.topScreen(), 'MAIN');
        assert(!d.gpu.visible, 'the menu covers the page: the picture goes at once');
        ui._setVisible('VIEW', true); d._syncVisible();       // the stack event that lists VIEW again
        await sleep(SHOW_WAIT);
        assert(!d.gpu.visible, 'the stack listing the page under the menu does not bring the picture back');
        open('VIEW');                                         // Home in the menu (MAIN stays listed)
        assert(await waitFor(() => d.gpu.visible, 1500), 'back on the page: the picture again');
        open('MAIN'); assert(!d.gpu.visible);
        ui._setVisible('MAIN', false);                        // BACK: the menu leaves the stack
        assert.strictEqual(ui.topScreen(), 'VIEW');
        assert(await waitFor(() => d.gpu.visible, 1500), 'BACK from the menu: the picture again');
        assert.deepStrictEqual(log.errors, []);
    } finally { d.closeSheet(); d.gpu.close(); clearInterval(d.keepTimer); }
});

test('a new scale keeps the uploads (the renderer keeps them), a new size sends them again', async () => {
    const t = await setup(), g = t.d.gpu;
    try {
        const pl = Object.assign({}, g.placement);
        g.sent.atlas.add(1); g.sent.ramp.add(2); g.sent.image.set(3, 1); g.sent.layer.add(4);
        g.place(Object.assign({}, pl, { scale: pl.scale * 0.9 }));
        assert.deepStrictEqual([g.sent.atlas.has(1), g.sent.ramp.has(2), g.sent.image.has(3)], [true, true, true], 'a new scale sends everything again');
        assert(!g.sent.layer.has(4), 'layers drawn at the old scale');
        g.place(Object.assign({}, pl, { w: pl.w - 8 }));
        assert.deepStrictEqual([g.sent.atlas.size, g.sent.ramp.size, g.sent.image.size], [0, 0, 0], 'a new size');
    } finally { t.end(); }
});

test('Cyrillic titles: every letter drawn (accented Latin too), in the weight and size asked; Latin-only text keeps the main atlases', () => {
    const fonts = require('../runtime/fonts');
    // mixed titles: the Cyrillic and the Latin with accents, all from the one companion atlas
    const titles = ['Поправка a B58 — їжак, Ґанок, ўсё, Љубљана, Қазақ «№1»', 'Café — Кофе', 'Đorđe / Ђорђе', 'Łódź, Ærøskøbing · Straße · Москва'];
    [['label', 18], ['label', 44], ['bold', 24], ['bold', 64], ['num', 40], ['light', 32], ['light', 64]].forEach(([fam, size]) => {
        const f = fonts.get(fam, size, titles[0]);
        assert.ok(f, fam + ' ' + size);
        assert.deepStrictEqual([f.family, f.size], [fam + '_cyr', size], fam + ' ' + size + ': its own weight, at the size asked (not scaled up)');
        assert.ok(f.cacheKey, fam + ': a cache key (atlases are shared between apps by family and size)');
        // every character the family's own atlas has at this size, plus the Cyrillic letters
        const main = fonts.get(fam, size, 'Latin'), lost = Object.keys(main.glyphs).filter((c) => !f.glyphs[c]);
        assert.deepStrictEqual(lost, [], fam + ' ' + size + ': all of the main atlas\'s characters');
        titles.forEach((t) => assert.deepStrictEqual(Array.from(t).filter((ch) => !f.glyphs[ch.codePointAt(0)]), [], fam + ' ' + size + ': nothing dropped from ' + t));
    });
    // the digit-only sizes (gauges): digits, units and Cyrillic units at the size asked
    [['num', 64], ['num', 96], ['num', 150], ['light', 110]].forEach(([fam, size]) => {
        const f = fonts.get(fam, size, '120 км/ч');
        assert.deepStrictEqual([f.family, f.size], [fam + '_cyr', size], fam + ' ' + size + ': at its own size');
        assert.deepStrictEqual(Array.from('120 км/ч 3,5 bar').filter((ch) => !f.glyphs[ch.codePointAt(0)]), [], fam + ' ' + size + ': the digits and units');
    });
    ['label', 'bold', 'num', 'light'].forEach((fam) => assert.strictEqual(fonts.get(fam, 32, 'Rebuilding a B58 · Café').family, fam, fam + ': Latin as before'));
});

test('CJK titles never pick an atlas over 4096 rows (mgu-render closes the connection on one)', () => {
    const fs = require('fs'), path = require('path');
    const link = path.join(__dirname, '..', 'runtime', 'fonts', 'cjk-titles.json');
    const had = fs.existsSync(link);
    if (!had) fs.copyFileSync(path.join(__dirname, '..', 'localization', 'fonts', 'cjk-titles.json'), link);
    try {
        delete require.cache[require.resolve('../runtime/fonts')];
        const fonts = require('../runtime/fonts');
        const rare = '\u9f98\u9f49';   // two characters the UI atlas (cjk.json) lacks: they take cjk-titles
        [14, 22, 32, 52, 64].forEach((size) => {
            const f = fonts.get('label', size, '\u6807\u9898 ' + rare);
            assert.strictEqual(f.family, 'cjk-titles', size + ': the titles atlas');
            assert.ok(f.atlasH <= 4096, size + ': atlas ' + f.atlasH + ' rows');
        });
    } finally {
        if (!had) fs.unlinkSync(link);
        delete require.cache[require.resolve('../runtime/fonts')];
    }
});

test('Romanian ș ț Ș Ț draw as ş ţ Ş Ţ, an accented letter the atlas lacks as its base letter: nothing drops out of a title', () => {
    const fonts = require('../runtime/fonts');
    const { Canvas } = require('../runtime/canvas');
    const ro = 'Știri și Țara Românească — Ştefan, ţară', vi = 'Phở ngon · Đà Nẵng';
    [['label', 18], ['label', 32], ['bold', 24], ['bold', 44], ['light', 32], ['num', 40]].forEach(([fam, size]) => {
        const f = fonts.get(fam, size, ro);
        assert.strictEqual(f.family, fam, fam + ' ' + size + ': the main atlas, not a companion');
        [ro, vi].forEach((t) => assert.deepStrictEqual(Array.from(t).filter((ch) => !fonts.glyph(f, ch)), [], fam + ' ' + size + ': nothing dropped from ' + t));
        assert.strictEqual(fonts.glyph(f, 'ș'), f.glyphs['ş'.codePointAt(0)], 'ș as ş');
        assert.strictEqual(fonts.glyph(f, 'Ț'), f.glyphs['Ţ'.codePointAt(0)], 'Ț as Ţ');
        assert.strictEqual(fonts.glyph(f, 'ở'), f.glyphs['o'.codePointAt(0)], 'ở as o');
        assert.strictEqual(fonts.glyph(f, '😀'), undefined, 'an emoji: dropped, as before');
        assert.strictEqual(fonts.measure(f, 'Știri'), fonts.measure(f, 'Ştiri'), 'measured as drawn');
    });
    // drawn: the comma-below word is as wide as the cedilla one, and wider than the word without its first letter
    const cv = new Canvas(400, 60);
    const w = cv.text('Știri', 0, 40, 32, '#ffffff', { literal: true });
    assert.strictEqual(w, cv.text('Ştiri', 0, 40, 32, '#ffffff', { literal: true }));
    assert.ok(w > cv.text('tiri', 0, 40, 32, '#ffffff', { literal: true }));
});

// ======== WP7 Language: the Russian catalog (kit/runtime/locales/ru.json), chosen at run time
// the RideTube strings a catalog must have: wrapped call sites, the tables drawn through translate / whole, app.json's labels
function rideTubeStrings() {
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
    const src = read('apps/jap_ridetube/main.js') + '\n' + read('apps/jap_ridetube/health.js');
    const LIT = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
    const un = (s) => s.slice(1, -1).replace(/\\(.)/g, '$1');
    const out = new Set();
    const add = (s) => { s = s.trim(); if (/[A-Za-z]{2}/.test(s)) out.add(s); };
    let m;
    const call = new RegExp(String.raw`\b(?:translate|whole|message|t)\(\s*` + LIT, 'g');
    while ((m = call.exec(src))) add(un(m[1]));
    const tern = new RegExp(String.raw`\b(?:translate|whole|message|t)\([^()]*?\?\s*` + LIT + String.raw`\s*:\s*` + LIT, 'g');
    while ((m = tern.exec(src))) { add(un(m[1])); add(un(m[2])); }
    const cnt = new RegExp(String.raw`\bcount\([^,]+,\s*` + LIT + String.raw`,\s*` + LIT, 'g');
    while ((m = cnt.exec(src))) out.add(un(m[1]) + '|' + un(m[2]));
    // tables drawn through translate / whole: NAMES, SUGGEST, the SponsorBlock names, the log errors, the clock text,
    // the bar and account labels, the logs page's buttons, the rail's own names
    const table = (name) => { const b = src.match(new RegExp('const ' + name + ' = ([\\s\\S]*?);\\n')); if (!b) throw new Error('no ' + name); const r = new RegExp(LIT, 'g'); let x; const v = []; while ((x = r.exec(b[1]))) v.push(un(x[1])); return v; };
    table('NAMES').filter((s) => /[A-Z]/.test(s[0])).forEach(add);
    table('SUGGEST').forEach(add);
    table('LOGS_ERR').filter((s) => / /.test(s)).forEach(add);
    table('CLOCK_MSG').forEach(add);
    table('SB').filter((s) => / |-/.test(s) || s === 'sponsor' || s === 'intro').forEach(add);
    ['Play', 'Pause', 'Now playing', 'Player', 'Sign in', 'Sign out', 'Press again to sign out', 'Send', 'Cancel', 'Close',
        'Home', 'Subscriptions', 'Subs', 'Watch later', 'Playlists', 'History', 'Playing', 'Search', 'segment'].forEach(add);
    // yt.js: the skipped toast
    ['Skipped', 'self-promotion', 'like & subscribe reminder'].forEach(add);
    // app.json: title, screens, buttons, menu items, settings and their options (the HMI and the drawn sheet)
    const spec = JSON.parse(read('apps/jap_ridetube/app.json'));
    add(spec.title);
    for (const sc of spec.screens) { if (sc.title) add(sc.title); (sc.buttons || []).forEach((b) => add(b[1])); (sc.items || []).forEach((it) => it[2] && add(it[2])); }
    for (const s of spec.settings) { add(s.label); (s.options || []).forEach((o) => { if (s.key !== 'language') add(o[1]); }); }
    // the kit's drawn settings sheet
    ['Settings', 'Done', 'Back', 'Version'].forEach(add);
    return [...out];
}
const RT_SOURCES = ['apps/jap_ridetube/main.js', 'apps/jap_ridetube/health.js', 'apps/jap_ridetube/yt.js', 'apps/jap_ridetube/app.json', 'kit/runtime/sheet.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8')).join('\n').replace(/\\(['"])/g, '$1');
const RU = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'runtime', 'locales', 'ru.json'), 'utf8'));
const BRAND = /^(RideTube|720p)$/;
const alreadyRussian = (s) => /[\u0400-\u04ff]/.test(s);   // names, no row

test('ru plurals: one, few, many (11-14 many), the catalog\'s three forms; English keeps two, zh-CN one', () => {
    const i18n = require('../runtime/i18n');
    assert.ok(i18n.languages().indexOf('ru') >= 0 && i18n.languages().indexOf('zh-CN') >= 0, 'the catalogs: ' + i18n.languages());
    try {
        assert.ok(i18n.setLanguage('ru'));
        const v = (n) => i18n.plural(n, '{count} channel', '{count} channels').replace('{count}', n);
        assert.deepStrictEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 0].map(v),
            ['1 канал', '2 канала', '4 канала', '5 каналов', '11 каналов', '12 каналов', '14 каналов', '21 канал', '22 канала', '25 каналов', '101 канал', '111 каналов', '0 каналов']);
        assert.deepStrictEqual([1, 3, 7].map((n) => i18n.plural(n, '{count} subscriptions', '{count} subscriptions')), ['{count} подписка', '{count} подписки', '{count} подписок']);
        assert.strictEqual(i18n.t('Home'), 'Главная');
        assert.ok(i18n.setLanguage('zh-CN'));
        assert.deepStrictEqual([1, 5].map((n) => i18n.plural(n, '{count} channel', '{count} channels')), ['{count} 个频道', '{count} 个频道'], 'zh-CN: its one form for every count');
        assert.strictEqual(i18n.t('Home'), '首页');
        assert.strictEqual(i18n.setLanguage('xx'), false, 'an unknown language: nothing changes');
        assert.strictEqual(i18n.getLanguage(), 'zh-CN');
    } finally { i18n.setLanguage('en'); }
    assert.deepStrictEqual([i18n.t('Home'), i18n.plural(1, 'a', 'b'), i18n.plural(2, 'a', 'b'), Object.keys(i18n.dict).length], ['Home', 'a', 'b', 0], 'English again: nothing translated');
});

test('ru.json: every key is in the source, every string RideTube translates has a row, plural rows have three forms', () => {
    const gone = Object.keys(RU).filter((k) => k.split('|').some((part) => RT_SOURCES.indexOf(part) < 0));
    assert.deepStrictEqual(gone, [], 'keys no source has');
    const missing = rideTubeStrings().filter((s) => !BRAND.test(s) && !alreadyRussian(s) && !Object.prototype.hasOwnProperty.call(RU, s));
    assert.deepStrictEqual(missing, [], 'strings without a Russian row');
    Object.keys(RU).filter((k) => k.indexOf('|') >= 0).forEach((k) => assert.strictEqual(RU[k].split('|').length, 3, k));
    Object.keys(RU).forEach((k) => {
        const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
        RU[k].split('|').forEach((v) => assert.strictEqual(ph(v), ph(k.split('|')[0]), 'the same {placeholders}: ' + k));
        assert.ok(/[\u0400-\u04ff]/.test(RU[k]), 'Russian: ' + k);
    });
});

test('ru.json: every character draws from the Cyrillic atlases (label, bold, light, num), none dropped', () => {
    const fonts = require('../runtime/fonts');
    const text = Object.keys(RU).map((k) => RU[k]).join('');
    [['label', 18], ['label', 24], ['bold', 24], ['bold', 32], ['light', 32], ['num', 40]].forEach(([fam, size]) => {
        const f = fonts.get(fam, size, 'Я');
        assert.strictEqual(f.family, fam + '_cyr');
        const lost = Array.from(new Set(Array.from(text))).filter((ch) => !fonts.glyph(f, ch));
        assert.deepStrictEqual(lost, [], fam + ' ' + size + ': no glyph for ' + lost.join(' '));
    });
    // the Language setting's own names in the atlases an English package draws them with
    assert.ok(Array.from('Русский').every((ch) => fonts.glyph(fonts.get('label', 28, 'Русский'), ch)), 'Русский');
});

test('the built package (dist/jap_ridetube): the car\'s ru_RU table has the menu and settings in Russian, en_GB as before', () => {
    const dir = path.join(__dirname, '..', '..', 'dist', 'jap_ridetube', 'rhmiData', 'strings');
    if (!fs.existsSync(path.join(dir, 'ru_RU.json'))) { console.log('      (skipped: python3 kit/tools/build.py jap_ridetube first)'); return; }
    const table = (l) => JSON.parse(fs.readFileSync(path.join(dir, l + '.json'), 'utf8'));
    const en = table('en_GB'), ru = table('ru_RU'), de = table('de_DE');
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'apps', 'jap_ridetube', 'app.json'), 'utf8'));
    const labels = [].concat(...spec.screens.map((sc) => (sc.items || []).map((it) => it[2]).concat((sc.buttons || []).map((b) => b[1]))),
        ...spec.settings.map((s) => [s.label].concat(s.key === 'language' ? [] : (s.options || []).map((o) => o[1])))).filter((x) => x && !BRAND.test(x) && !/^\d+ %$/.test(x));
    const enValues = Object.keys(en).map((k) => en[k]), ruValues = Object.keys(ru).map((k) => ru[k]);
    labels.forEach((l) => {
        assert.ok(enValues.indexOf(l) >= 0, 'en_GB has ' + l);
        if (alreadyRussian(l)) { assert.ok(ruValues.indexOf(l) >= 0, 'shared menu keeps ' + l); return; }
        assert.ok(ruValues.indexOf(RU[l]) >= 0, 'ru_RU has ' + RU[l] + ' (' + l + ')');
        assert.ok(ruValues.indexOf(l) < 0, 'ru_RU has no English ' + l);
    });
    assert.deepStrictEqual(Object.keys(ru), Object.keys(en), 'the same string ids');
    assert.deepStrictEqual(de, en, 'a car language without a catalog: the English table');
    assert.ok(enValues.filter(alreadyRussian).every((v) => labels.indexOf(v) >= 0 || v === '\u0420\u0443\u0441\u0441\u043a\u0438\u0439'), 'en_GB: existing x3 Russian menu labels and the language name');
});

(async () => {
    await new Promise((r) => server.listen(process.env.MGU_RENDERD_SOCKET, r));
    let failed = 0;
    for (const [name, fn] of cases) {
        try { await fn(); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
    }
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(failed ? failed + ' of ' + cases.length + ' failed' : 'runtime: all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
