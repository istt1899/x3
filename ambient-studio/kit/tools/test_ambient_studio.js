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
const { headlightTest } = require(path.join(app, 'headlight-test'));
const { lightStudio } = require(path.join(app, 'light-studio'));
const { previewCabin } = require(path.join(app, 'preview-cabin'));
const { Recorder } = require(path.join(app, 'kit/record'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-studio-'));
const settingsFile = path.join(dataDir, 'settings.json');

function open(vehicle) {
    const { ctx } = headUnit(stage, { dataDir });
    const { lights, control } = previewCabin(ctx);
    const captions = [];
    const cv = new Recorder(1600, 520);
    cv.own = true;
    const text = cv.text.bind(cv);
    cv.text = (s, ...args) => { captions.push(s); return text(s, ...args); };
    let selectedPage = null;
    const page = lightStudio(ctx, control, lights, draw, (n) => { selectedPage = n; }, vehicle);
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
    return { captions, draw, press, leave: page.leave, settings: ctx.settings, control, page: () => selectedPage };
}

function verifyPlayback() {
    const realNow = Date.now;
    let now = 10000, starts = 0, stops = 0;
    const headlights = {
        status: () => ({ busy: false, note: '', blocked: '' }),
        start: () => { starts++; },
        stop: () => { stops++; },
    };
    Date.now = () => now;
    try {
        const ui = open({ headlights });
        assert(ui.captions.includes('Включить стробоскоп'));
        ui.press('play');
        assert(ui.captions.includes('Левая включена'));
        now += 1100;
        ui.draw();
        assert(ui.captions.includes('Правая включена'), 'Test follows the actual timeline');
        now += 3000;
        ui.draw();
        assert(ui.captions.includes('Тест завершён'));
        assert(ui.captions.includes('Обе выключены'));
        ui.press('strobe-toggle');
        ui.press('strobe-mode1');
        ui.press('strobe-play');
        assert(ui.captions.includes('Левая включена'));
        now += 2000;
        ui.draw();
        assert(ui.captions.includes('Правая включена'));
        ui.press('strobe-play');
        assert(ui.captions.includes('Обе выключены'));
        assert.strictEqual(starts, 0, 'No hardware command from a preview');
        ui.press('strobe-bmw');
        assert(ui.captions.includes('Подтвердить тест фар'));
        assert.strictEqual(starts, 0, 'The first tap only requests confirmation');
        now += 10001;
        ui.draw();
        assert(ui.captions.includes('Тест фар BMW'));
        ui.press('strobe-bmw');
        ui.press('strobe-bmw');
        assert.strictEqual(starts, 1);
        ui.leave();
        ui.draw();
        assert.strictEqual(stops, 1);
        assert(ui.captions.includes('Включить стробоскоп'));
    } finally { Date.now = realNow; }
}

async function verifyHardware() {
    function rig({ afterPulse, refusal } = {}) {
        let now = 10000;
        const calls = [], holds = [];
        const test = headlightTest({
            available: () => '',
            hold: async (on) => { holds.push(on); },
            now: () => now, log: { warn() {} },
            wait: async (ms) => {
                now += ms;
                if (afterPulse) afterPulse(test);
            },
            diag: { physical: async (address, sid, data, _ms, accept) => {
                assert.strictEqual(address, 0x40);
                calls.push([sid, ...data]);
                assert(!accept([0x6E, 0x60, 0xFD]), 'Ignore traffic for another DID');
                if (refusal === sid) return [0x7F, sid, 0x31];
                return [sid + 0x40, ...data.slice(0, sid === 0x10 ? 1 : 2)];
            } },
        });
        const parked = () => { test.updateSpeed(0); test.updateGear('gearbox', 'P'); };
        return { test, parked, calls, holds, advance: (ms) => { now += ms; } };
    }
    const ok = rig();
    await ok.test.start(150);
    assert.deepStrictEqual(ok.calls, []);
    ok.parked();
    ok.test.updateGear('powertrain', 'N');
    await ok.test.start(150);
    assert.deepStrictEqual(ok.calls, []);
    ok.test.updateGear('powertrain', undefined);
    await ok.test.start(150);
    assert.deepStrictEqual(ok.calls.map(([sid]) => sid), [0x10, 0x22, 0x2E, 0x2E, 0x2E, 0x10]);
    assert(ok.calls.filter(([sid]) => sid === 0x2E).every((pulse) => pulse[6] === 15));
    assert.deepStrictEqual(ok.holds, [true, false]);
    assert(ok.test.status().note.startsWith('Тест завершён'));
    await ok.test.start(150);
    assert.strictEqual(ok.calls.length, 6, 'Enforce the pause between runs');

    const moving = rig({ afterPulse: (test) => test.updateSpeed(1) });
    moving.parked();
    await moving.test.start(80);
    assert.strictEqual(moving.calls.filter(([sid]) => sid === 0x2E).length, 1);
    assert.deepStrictEqual(moving.calls.at(-1), [0x10, 0x01]);
    assert.strictEqual(moving.test.status().note, 'Тест остановлен');

    const refused = rig({ refusal: 0x22 });
    refused.parked();
    await refused.test.start(80);
    assert(refused.test.status().note.endsWith('NRC 31'));
    assert(refused.calls.every(([sid]) => sid !== 0x2E));
    assert.deepStrictEqual(refused.holds, [true, false]);

    const stale = rig();
    stale.parked();
    stale.advance(2501);
    await stale.test.start(80);
    assert.deepStrictEqual(stale.calls, []);
}

try {
    verifyPlayback();
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

verifyHardware().then(() => {
    console.log('Headlight test: confirmation, parked interlock, pulses, stop, cleanup and denied controller passed');
    execFileSync(process.execPath, [path.join(__dirname, 'test_ambient_native_ui.js')], { stdio: 'inherit' });
}).catch((error) => { console.error(error); process.exitCode = 1; });
