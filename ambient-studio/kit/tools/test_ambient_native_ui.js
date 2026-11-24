'use strict';
// Build the Store staging tree first with kit/tools/build.py --store --language ru marku_ambient_studio.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');
const { headUnit } = require('./hu-stub');

const stage = path.resolve(__dirname, '../../dist/marku_ambient_studio');
const screens = ['1920x720', '2880x960'];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label) {
    const end = Date.now() + 3000;
    while (!predicate() && Date.now() < end) await pause(20);
    assert(predicate(), 'Timed out waiting for ' + label);
}

function capture(display, kitDir, file) {
    const { Canvas, ScaledCanvas } = require(path.join(kitDir, 'canvas'));
    const { OP, play } = require(path.join(kitDir, 'record'));
    const surface = display.place;
    const { w, h } = display.gpu.screen;
    const app = display.app;
    const page = new ScaledCanvas(app.w, app.h + (surface.extra || 0), surface.scale);
    const chrome = new Canvas(surface.w, surface.h);
    const clear = chrome.clear.bind(chrome);
    // Native Chrome has its own coordinate space. Its CLIP/CLEAR sequences cut
    // out the HMI's status and back areas. The kit's CPU player ignores CLIP.
    const words = display.chromeRec.words();
    const numbers = new Float32Array(words.buffer, words.byteOffset, words.length);
    const cutouts = [];
    for (let i = 0; i + 7 < words.length; i++) {
        if (words[i] === OP.CLIP && words[i + 5] === OP.CLEAR &&
            words[i + 6] === 0 && words[i + 7] === OP.NOCLIP) {
            cutouts.push(Array.from(numbers.subarray(i + 1, i + 5)));
        }
    }
    chrome.clear = (colour) => colour[3] ? clear(colour) : chrome;
    play(app.words, page);
    play(words, chrome);

    const combined = new Canvas(surface.w, surface.h);
    combined.blit(page.canvas, surface.ox, surface.oy);
    combined.blit(chrome, 0, 0);
    const shell = '#080a0e';
    cutouts.forEach((r) => combined.fillRect(...r, shell));
    const image = new Canvas(w, h).clear(shell);
    image.blit(combined, surface.x, surface.y);
    fs.writeFileSync(file, image.png());
}

function verifyGeometry(display, label) {
    const place = display.place;
    const limit = (r, top, bottom, key) => {
        assert(r && [r.x, r.y, r.w, r.h].every(Number.isFinite) &&
            r.x >= 0 && r.y >= top && r.w > 0 && r.h > 0 &&
            r.x + r.w <= place.w && r.y + r.h <= bottom,
        label + ' ' + key + ' is outside its native surface: ' + JSON.stringify(r));
    };
    const header = display._ring().filter((p) => p.tab != null);
    const page = display._ring().filter((p) => p.tgt);
    assert(header.length >= 5 && page.length >= 3, label + ' rendered missing interactive controls');
    for (const [places, top, bottom] of [
        [header, 0, display.headH()],
        [page, display.headH(), place.h - display.barH()],
    ]) {
        const rects = places.map((p) => [p.k, display._rectOf(p)]);
        rects.forEach(([key, r], i) => {
            limit(r, top, bottom, key);
            for (const [otherKey, other] of rects.slice(0, i)) {
                const overlap = r.x < other.x + other.w - 0.01 &&
                    r.x + r.w > other.x + 0.01 && r.y < other.y + other.h - 0.01 &&
                    r.y + r.h > other.y + 0.01;
                assert(!overlap, label + ' overlapping controls: ' + key + ' and ' + otherKey);
            }
        });
        assert.strictEqual(new Set(places.map((p) => p.k)).size, places.length, label + ' duplicate keys');
    }
}

async function verify(screen, output) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-native-ui-'));
    const stream = path.join(dataDir, 'frames.bin');
    Object.assign(process.env, {
        MGU_RENDERER: 'auto',
        MGU_RENDERD_FILE: stream,
        MGU_RENDERD_SCREEN: screen,
        MGU_RENDERD_TOUCH: '1',
    });
    const errors = [];
    const log = { debug() {}, info() {}, warn() {}, error: (...parts) => errors.push(parts.join(' ')) };
    const hu = headUnit(stage, { dataDir, live: true, image() {}, log, sets: { layout: 'full' } });
    const { display, settings } = hu;
    const sections = { headlights: 'frame0', strobe: 'strobe-play', cabin: 'preset1', check: 'check' };
    const target = (key) => (display.pageTargets || []).find((r) => r.key === 'studio-' + key);
    const captureSection = async (section, name = section) => {
        await waitFor(() => display.app && target(sections[section]), section);
        verifyGeometry(display, screen + ' ' + section);
        if (output) {
            // Let native press highlighting expire without changing the selection.
            await pause(350);
            capture(display, hu.kitDir, path.join(output, screen + '-' + name + '.png'));
        }
    };
    function tap(r, name) {
        assert(r, 'Missing touch target: ' + name);
        const x = r.x + r.w / 2, y = r.y + r.h / 2;
        display.gpu.emit('touch', 1, x, y);
        display.gpu.emit('touch', 3, x, y);
    }
    const touchTarget = (key) => tap(target(key), key);
    const touchTab = (i) => tap(display.tabs.find((q) => q.i === i), 'tab ' + i);
    let encoder = 0;
    function controller(button = 0) {
        display.gpu.emit('ccu', {
            frontRotaryEncoderOperation: encoder,
            frontRotaryEncoderPushButton: button,
            frontRotaryEncoderDeflection: 0,
        });
    }
    function rotaryFocus(key) {
        const ring = display._ring();
        const want = ring.findIndex((p) => p.k === key);
        assert(want >= 0, 'Missing controller target: ' + key);
        if (!ring.some((p) => p.k === display.focusKey)) { encoder++; controller(); }
        const from = ring.findIndex((p) => p.k === display.focusKey);
        assert(from >= 0, 'Initial controller focus is outside the native ring');
        const step = Math.sign(want - from);
        for (let i = from; i !== want; i += step) {
            encoder += step;
            controller();
            assert.strictEqual(display.focusKey, ring[i + step].k);
        }
    }
    function pressTarget(key) {
        rotaryFocus('tgt:studio-' + key);
        controller(1);
        controller();
    }

    try {
        const originalLoad = Module._load;
        try { hu.start(); } finally { Module._load = originalLoad; }
        await waitFor(() => display.own() && display.app && display.tabs && target('section0'), 'native Light tab');
        const [w, h] = screen.split('x').map(Number);
        assert.deepStrictEqual(display.gpu.screen, { w, h });
        assert(display.place.full && display.place.x + display.place.w <= w &&
            display.place.y + display.place.h <= h, 'Invalid native surface');
        assert.strictEqual(display.app.tabs.sel, 0, 'Light must open first');
        assert(fs.statSync(stream).size > 0, 'No commands sent to the native renderer');
        await captureSection('headlights');
        assert(display.gpu.sent.layer.size > 0, 'BMW artwork needs a cached native layer');
        assert.strictEqual(display.gpu.sent.image.size, 0, 'Native renderer cannot upload IMAGE resources');
        controller();
        pressTarget('strobe-toggle');
        await captureSection('strobe');
        assert(!target('strobe-bmw'), 'Physical test is unavailable without a diagnostic provider');
        touchTarget('strobe-mode2');
        await waitFor(() => target('strobe-burst') && target('strobe-order'), 'burst controls');
        touchTarget('strobe-mode1');
        touchTarget('strobe-play');
        const ready = display.app.words.slice();
        await waitFor(() => display.app.words.some((word, i) => word !== ready[i]), 'running strobe preview');
        if (output) capture(display, hu.kitDir, path.join(output, screen + '-strobe-test.png'));
        touchTarget('strobe-play');
        touchTarget('section1');
        await waitFor(() => target('preset1'), 'leave strobe');
        touchTarget('section0');
        await waitFor(() => target('frame0') && !target('strobe-play'), 'strobe disarmed after navigation');

        controller();
        pressTarget('seq1');
        await waitFor(() => settings.get('studioSequence') === 1, 'scene choice');
        touchTarget('frame2');
        touchTarget('left');
        assert.deepStrictEqual(settings.get('studioFrames'), [1, 0, 3, 0]);
        touchTarget('hold');
        assert.deepStrictEqual(settings.get('studioTimes'), [1000, 1000, 1500, 1000]);
        await captureSection('headlights', 'headlights-edited');
        pressTarget('undo');
        assert.deepStrictEqual(settings.get('studioTimes'), [1000, 1000, 1000, 1000]);
        touchTarget('hold');
        touchTarget('play');
        await waitFor(() => target('play-reset'), 'timing controls');
        const timingFrame = display.app.words;
        await waitFor(() => display.app.words.some((word, i) => word !== timingFrame[i]),
            'moving duration indicator');
        assert.deepStrictEqual(settings.get('studioFrames'), [1, 0, 3, 0]);
        assert.deepStrictEqual(settings.get('studioTimes'), [1000, 1000, 1500, 1000]);
        await captureSection('headlights', 'headlights-timing');
        touchTarget('play-reset');
        await waitFor(() => !target('play-reset'), 'timing reset');

        pressTarget('back');
        await captureSection('cabin');
        touchTarget('zone-upper');
        await waitFor(() => target('zone-reset'), 'upper zone preview');
        await captureSection('cabin', 'cabin-zone');
        touchTarget('zone-lower');
        touchTarget('zone-reset');
        await waitFor(() => !target('zone-reset'), 'zone reset');
        pressTarget('preset1');
        touchTarget('save');
        pressTarget('stock');
        await waitFor(() => !target('save'), 'stock cabin setting');
        pressTarget('cabin-undo');
        await waitFor(() => target('save'), 'cabin undo');
        touchTarget('colour');
        await waitFor(() => display.app.tabs.sel === 1, 'Colour tab');
        touchTab(4);
        await waitFor(() => display.app.tabs.sel === 4, 'Favorites tab');
        touchTab(0);
        await waitFor(() => display.app.tabs.sel === 0 && target('section2'), 'return to Light');
        pressTarget('section2');
        await captureSection('check', 'check-ready');
        touchTarget('check');
        await captureSection('check');
        touchTarget('back');
        await waitFor(() => target('preset1'), 'return to Cabin');
        verifyGeometry(display, screen + ' Cabin after return');
        assert.strictEqual(hu.stack.at(-1), 'MAIN', 'App must stay in the main screen');
        assert.deepStrictEqual(errors, []);
        console.log('Ambient Studio native ' + screen + ': bounds, touch, rotary focus, strobe, storyboard and tab navigation passed');
    } finally {
        await hu.ui.close('MAIN');
        if (display.gpu) display.gpu.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

if (process.argv[2] === '--screen') {
    verify(process.argv[3], process.argv[4]).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
} else {
    const output = process.argv[2] && path.resolve(process.argv[2]);
    if (output) fs.mkdirSync(output, { recursive: true });
    for (const screen of screens) {
        const args = [__filename, '--screen', screen];
        if (output) args.push(output);
        const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: 20000 });
        if (result.error) throw result.error;
        assert.strictEqual(result.status, 0, 'Native UI test failed for ' + screen);
    }
}
