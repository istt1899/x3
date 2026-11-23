'use strict';
// Run after: python3 kit/tools/build.py --store --language ru marku_ambient_studio
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.MGU_RENDERER = 'software';
const { headUnit } = require('./hu-stub');
const stage = path.resolve(__dirname, '../../dist/marku_ambient_studio');
const app = path.join(stage, 'source/javascript');
const { lightStudio } = require(path.join(app, 'light-studio'));
const { previewCabin } = require(path.join(app, 'preview-cabin'));
const { Recorder } = require(path.join(app, 'kit/record'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-studio-'));
const settingsFile = path.join(dataDir, 'settings.json');

function open() {
    const { ctx } = headUnit(stage, { dataDir });
    const { lights, control } = previewCabin(ctx);
    const captions = [];
    const cv = new Recorder(1600, 520);
    cv.own = true;
    const text = cv.text.bind(cv);
    cv.text = (s, ...args) => { captions.push(s); return text(s, ...args); };
    let selectedPage = null;
    const page = lightStudio(ctx, control, lights, draw, (n) => { selectedPage = n; });
    function draw() {
        cv.reset();
        captions.length = 0;
        page(cv, ctx.theme());
    }
    function press(key) {
        const target = cv.targets.find((r) => r.key === 'studio-' + key);
        assert(target, 'missing button: ' + key);
        target.run();
    }
    draw();
    return { captions, press, settings: ctx.settings, control, page: () => selectedPage };
}

try {
    let ui = open();
    assert(ui.captions.includes('Левая включена'));
    ui.press('section2');
    ui.press('check');
    assert.strictEqual(ui.captions.filter((s) => s === 'Пройдено').length, 3, 'Fresh settings can use defaults');
    ui.press('section0');
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
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    saved.studioTimes = [1000, 1000, 750, 1000];
    fs.writeFileSync(settingsFile, JSON.stringify(saved));
    ui = open();
    ui.press('section2');
    ui.press('check');
    assert.strictEqual(ui.captions.filter((s) => s === 'Пройдено').length, 2);
    assert.strictEqual(ui.captions.filter((s) => s === 'Ошибка').length, 1, 'Self-check must report invalid saved durations');
    ui.press('section0');
    ui.press('left');
    ui.press('section2');
    ui.press('check');
    assert.strictEqual(ui.captions.filter((s) => s === 'Пройдено').length, 3, 'Editing repairs invalid saved durations');
    console.log('Ambient Studio: editing, timing, presets, favorites, persistence, navigation and self-check with valid, invalid and repaired settings passed');
} finally {
    if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
    fs.rmdirSync(dataDir);
}

execFileSync(process.execPath, [path.join(__dirname, 'test_ambient_native_ui.js')], { stdio: 'inherit' });
