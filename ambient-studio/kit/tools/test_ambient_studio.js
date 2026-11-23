'use strict';
// Run after: python3 kit/tools/build.py --store --language ru marku_ambient_studio
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.MGU_RENDERER = 'software';
const { headUnit } = require('./hu-stub');
const stage = path.resolve(__dirname, '../../dist/marku_ambient_studio');
const app = path.join(stage, 'source/javascript');
const { lightStudio } = require(path.join(app, 'light-studio'));
const { previewCabin } = require(path.join(app, 'preview-cabin'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-studio-'));

function open() {
    const { ctx } = headUnit(stage, { dataDir });
    const { lights, control } = previewCabin(ctx);
    const targets = new Map(), captions = [];
    // Record the targets built by the real kit buttons. Pixels are checked in the desktop emulator.
    const cv = {
        own: true, text: (s) => captions.push(s), target: (x, y, w, h, run, id) => targets.set(id, run),
        line() {}, arc() {}, roundRect() {}, strokeRoundRect() {}, polyline() {},
    };
    let selectedPage = null;
    const page = lightStudio(ctx, control, lights, draw, (n) => { selectedPage = n; });
    function draw() {
        targets.clear();
        captions.length = 0;
        page(cv, ctx.theme());
    }
    function press(key) {
        const action = targets.get('studio-' + key);
        assert(action, 'missing button: ' + key);
        action();
    }
    draw();
    return { captions, press, settings: ctx.settings, control, page: () => selectedPage };
}

try {
    let ui = open();
    assert(ui.captions.includes('Левая включена'));
    ui.press('seq1');
    ui.press('frame2');
    ui.press('left');
    assert.deepStrictEqual(ui.settings.get('studioFrames'), [1, 0, 3, 0]);
    ui.press('hold');
    assert.deepStrictEqual(ui.settings.get('studioTimes'), [1000, 1000, 1500, 1000]);
    assert(ui.captions.includes('Длина сцены · 4,5 с'));
    ui.press('seq0');
    assert(ui.captions.includes('Длина сцены · 4 с'));
    ui.press('seq3');
    ui.press('frame2');
    assert(ui.captions.includes('Обе включены'));

    ui.press('section1');
    ui.press('preset1');
    assert.deepStrictEqual(ui.control.look().upper.rgb, [80, 186, 242]);
    assert.deepStrictEqual(ui.control.look().lower.rgb, [54, 100, 220]);
    ui.press('save');
    ui.press('save');
    assert.strictEqual(ui.control.favs().length, 1);
    ui.press('stock');
    assert.strictEqual(ui.control.on(), false);
    ui.press('colour');
    assert.strictEqual(ui.page(), 0);

    ui = open();
    assert.strictEqual(ui.settings.get('studioSequence'), 3);
    assert(ui.captions.includes('Длина сцены · 4,5 с'));
    assert.strictEqual(ui.control.favs().length, 1);
    ui.press('section2');
    ui.press('check');
    assert.strictEqual(ui.captions.filter((s) => s === 'Пройдено').length, 3);
    console.log('Ambient Studio: frame editing, timing, presets, favorites, persistence, navigation and self-check passed');
} finally {
    const settingsFile = path.join(dataDir, 'settings.json');
    if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
    fs.rmdirSync(dataDir);
}
