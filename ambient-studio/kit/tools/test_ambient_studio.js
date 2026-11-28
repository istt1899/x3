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
const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'source/manifest.json'), 'utf8'));
assert.strictEqual(manifest.proxies['de.bmw.infrastructure.VehicleInformation'].attributes.statusGearboxDrive, 's',
    'The Store must accept a selector field with a notifier and no getter');
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
    let now = 10000, starts = [], stops = 0;
    const headlights = {
        status: () => ({ busy: false, note: '', blocked: '' }),
        start: (program) => { starts.push(program); },
        stop: () => { stops++; },
    };
    Date.now = () => now;
    try {
        const ui = open({ headlights });
        assert(ui.captions.includes('Стробоскоп'));
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
        assert.strictEqual(starts.length, 0, 'No hardware command from a preview');
        ui.press('strobe-bmw');
        assert(ui.captions.includes('Подтвердить запуск'));
        assert.strictEqual(starts.length, 0, 'The first tap only requests confirmation');
        now += 10001;
        ui.draw();
        assert(ui.captions.includes('Запустить фары'));
        ui.press('strobe-mode3');
        assert(ui.captions.includes('Световое шоу доступно на экране'));
        assert.throws(() => ui.press('strobe-bmw'), /missing button/);
        ui.press('strobe-mode2');
        ui.press('strobe-rate');
        ui.press('strobe-burst');
        ui.press('strobe-bmw');
        ui.press('strobe-bmw');
        assert.deepStrictEqual(starts, [{ mode: 2, flashMs: 80, every: 333, burst: 3, fog: false }]);
        ui.leave();
        ui.draw();
        assert.strictEqual(stops, 1);
        assert(ui.captions.includes('Стробоскоп'));
    } finally { Date.now = realNow; }
}

async function verifyHardware() {
    const acceptTimed = ([sid, , , , , , ticks]) => sid === 0x2E && ticks > 0;
    function rig({ controller = 'timed', beforeSend, onWait, onRequest, onHold, keepSpeed = true } = {}) {
        let now = 10000;
        const calls = [], holds = [], times = [];
        const outputs = Array(9).fill(0);
        const test = headlightTest({
            available: () => '',
            hold: async (on) => { holds.push(on); if (onHold) onHold(test, on); },
            now: () => now, log: { warn() {} },
            wait: async (ms) => {
                now += ms;
                if (keepSpeed) test.updateSpeed(0);
                if (onWait) onWait(test, calls);
            },
            diag: { physical: async (address, sid, data, _ms, accept, options) => {
                assert.strictEqual(address, 0x40);
                assert.strictEqual(options.maxRetries, 0, 'No autonomous write retries after Stop');
                if (sid === 0x2F) {
                    assert(!accept([0x6F, data[0], data[1], data[2] ^ 3]),
                        'Ignore an acknowledgment for a different control subfunction');
                }
                if (beforeSend) beforeSend(sid, data, test, (ms) => { now += ms; });
                if (options.beforeSend) options.beforeSend();
                calls.push([sid, ...data]);
                times.push(now);
                const forced = onRequest && onRequest(sid, data, test);
                if (forced !== undefined) return forced;
                if (sid === 0x22) {
                    if (['timed', 'dual'].includes(controller) && data[0] === 0xD5) return [0x62, ...data];
                    if (['g05', 'dual'].includes(controller) && data[0] === 0xE3) return [0x62, ...data, ...outputs];
                    if (controller === 'bdc' && data[0] === 0x45) return [0x62, ...data, ...outputs];
                    return [0x7F, sid, 0x31];
                }
                if (sid === 0x2F && (['g05', 'dual', 'bdc'].includes(controller))) {
                    assert.strictEqual(data[0], controller === 'bdc' ? 0x45 : 0xE3);
                    outputs[data[3]] = data[4];
                }
                return [sid + 0x40, ...data.slice(0, { 0x10: 1, 0x2E: 2, 0x2F: 3 }[sid])];
            } },
        });
        const parked = () => { test.updateSpeed(0); test.updateGear('gearbox', 'P'); };
        return { test, parked, calls, holds, times, advance: (ms) => { now += ms; } };
    }
    const program = { mode: 2, flashMs: 150, every: 500, burst: 2 };
    const ok = rig();
    await ok.test.start(program);
    assert.deepStrictEqual(ok.calls, []);
    ok.parked();
    ok.test.updateGear('powertrain', 'N');
    await ok.test.start(program);
    assert.deepStrictEqual(ok.calls, [], 'Conflicting selector reading blocks a launch');
    ok.test.updateGear('powertrain', undefined);
    ok.advance(18000);
    ok.test.updateSpeed(0);
    await ok.test.start(program);
    assert.deepStrictEqual(ok.calls.slice(0, 2), [[0x22, 0xD5, 0x42], [0x10, 3]]);
    assert.deepStrictEqual(ok.calls.slice(-2), [[0x2E, 0xD5, 0x42, 0, 5, 0, 0], [0x10, 1]]);
    assert(ok.calls.filter(acceptTimed).length > 3);
    assert(ok.calls.filter(acceptTimed).every((pulse) => pulse[6] === 15));
    assert.deepStrictEqual(ok.times.slice(2, 6).map((at) => at - ok.times[2]), [0, 500, 1650, 2150]);
    assert.deepStrictEqual(ok.holds, [true, false]);
    assert.strictEqual(ok.test.status().note, 'Цикл фар завершён');
    const completed = ok.calls.length;
    await ok.test.start(program);
    assert.strictEqual(ok.calls.length, completed, 'Enforce the pause between runs');

    for (const invalidate of [
        (test) => test.updateSpeed(1), (test) => test.clearGear(),
        (test) => test.updateGear('gearbox', 'D'), (test) => test.stop(),
        (test) => test.updateGear('gearbox', undefined),
    ]) {
        const invalid = rig({ onWait: (test) => invalidate(test) });
        invalid.parked();
        await invalid.test.start(program);
        assert.strictEqual(invalid.calls.filter(acceptTimed).length, 1);
        assert.deepStrictEqual(invalid.calls.slice(-2), [[0x2E, 0xD5, 0x42, 0, 5, 0, 0], [0x10, 1]]);
        assert(invalid.test.status().note.startsWith('Фары остановлены'));
    }
    const cancelled = rig({ onHold: (test, on) => { if (on) test.stop(); } });
    cancelled.parked();
    await cancelled.test.start(program);
    assert.deepStrictEqual(cancelled.calls, [], 'Stop during a pending hold prevents every diagnostic request');
    assert.deepStrictEqual(cancelled.holds, [true, false]);

    for (const controller of ['bdc', 'g05', 'dual']) {
        const legacy = rig({ controller });
        legacy.parked();
        await legacy.test.start({ mode: 1, flashMs: 80, every: 1000 });
        const writes = legacy.calls.filter(([sid, , , mode, , on]) => sid === 0x2F && mode === 3 && on === 1);
        assert.deepStrictEqual(writes.map((write) => write[4]), [7, 8, 7, 8, 7, 8, 7, 8]);
        assert.deepStrictEqual(legacy.calls.filter(([sid, , , mode]) => sid === 0x2F && mode === 0)
            .map((write) => write[4]), [7, 8]);
        assert.deepStrictEqual(legacy.calls.slice(-1)[0], [0x10, 1]);
    }
    const alternate = rig();
    alternate.parked();
    await alternate.test.start({ mode: 1 });
    assert(alternate.calls.every(([sid]) => sid === 0x22), 'Unsupported alternation must not switch on both headlights');
    assert(alternate.test.status().fault);
    const fog = rig();
    fog.parked();
    await fog.test.start({ mode: 0, fog: true });
    assert.deepStrictEqual(fog.calls.filter(acceptTimed).slice(0, 4).map((pulse) => pulse[4]), [5, 8, 5, 8]);

    const refused = rig({ onRequest: (sid) => sid === 0x2E ? [0x7F, sid, 0x31] : undefined });
    refused.parked();
    await refused.test.start(program);
    assert.strictEqual(refused.calls.filter(acceptTimed).length, 1);
    assert.deepStrictEqual(refused.calls.slice(-1)[0], [0x10, 1]);
    assert(refused.test.status().fault);
    assert.deepStrictEqual(refused.holds, [true, false]);

    const queue = rig({ beforeSend: (sid, data, test) => {
        if (sid === 0x2E && data[5] > 0) test.clearGear();
    } });
    queue.parked();
    await queue.test.start(program);
    assert.strictEqual(queue.calls.filter(acceptTimed).length, 0, 'Provider loss in the send queue prevents activation');
    assert.deepStrictEqual(queue.calls.slice(-1)[0], [0x10, 1], 'Queued activation cancellation still closes its session');
    const overrun = rig({ beforeSend: (sid, data, test, advance) => {
        if (sid === 0x2E && data[5] > 0) { advance(8100); test.updateSpeed(0); }
    } });
    overrun.parked();
    await overrun.test.start(program);
    assert.strictEqual(overrun.calls.filter(acceptTimed).length, 0, 'Do not send activation after the cycle deadline');

    const noController = rig({ controller: 'none' });
    noController.parked();
    await noController.test.start(program);
    assert(noController.calls.every(([sid]) => sid === 0x22));
    assert(noController.test.status().fault);
    const noSelector = rig();
    noSelector.test.updateSpeed(0);
    noSelector.test.updateGear('powertrain', undefined);
    await noSelector.test.start(program);
    assert.deepStrictEqual(noSelector.calls, [], 'Ambiguous N/P and zero speed cannot authorize the lights');
    const motion = rig();
    motion.parked();
    motion.test.updateSpeed(1);
    motion.test.updateSpeed(0);
    await motion.test.start(program);
    assert.deepStrictEqual(motion.calls, [], 'A stop after movement must receive a new P');
    motion.test.updateGear('gearbox', 'P');
    motion.advance(3000);
    motion.test.updateSpeed(0, 10000);
    await motion.test.start(program);
    assert.deepStrictEqual(motion.calls, [], 'A slow read must retain its original sample time');

    const stale = rig({ keepSpeed: false });
    stale.parked();
    await stale.test.start(program);
    assert(stale.test.status().note.startsWith('Фары остановлены'), 'A missing speed update stops while operating');
    stale.advance(10000);
    const previous = stale.calls.length;
    await stale.test.start(program);
    assert.strictEqual(stale.calls.length, previous, 'Stale speed also blocks a new launch');
}

async function verifyQueuedTransport() {
    const { Diag } = require(path.join(app, 'kit/diag'));
    const signals = require(path.join(app, 'kit/signals'));
    const log = { info() {}, warn() {} };
    for (const cancel of [(run) => run.stop(), (run) => run.clearGear()]) {
        const sent = [];
        const diag = new Diag(signals, log);
        let unblock, entered;
        const blocked = new Promise((resolve) => { entered = resolve; });
        const blocker = { callMethod: () => new Promise((resolve) => { unblock = resolve; entered(); }) };
        diag.p = { async callMethod(method, params) {
            assert.strictEqual(method, 'sendTasuRequest');
            const sid = params.serviceID, data = Array.from(params.udsData);
            sent.push([sid, ...data]);
            if (sid === 0x10 && data[0] === 3) void signals.call(blocker, 'queue-blocker');
            diag.emit('frame', { ecu: 0x40, uds: [sid + 0x40, ...data.slice(0, sid === 0x10 ? 1 : 2)] });
            return 'NO_ERROR';
        } };
        const headlights = headlightTest({ diag, hold: async () => {}, available: () => '', log });
        headlights.updateSpeed(0);
        headlights.updateGear('gearbox', 'P');
        const run = headlights.start({ mode: 0 });
        await blocked;
        cancel(headlights);
        unblock();
        await run;
        assert(!sent.some((frame) => frame[0] === 0x2E && frame[6] > 0), 'Cancel queued activation before the native call');
        assert.deepStrictEqual(sent[sent.length - 1], [0x10, 1], 'The actual transport can send cleanup after cancellation');
    }
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

verifyHardware().then(verifyQueuedTransport).then(() => {
    console.log('Headlight strobe: confirmation, parked interlock, BDC profiles, cadence, stop, cleanup and ECU refusals passed');
    execFileSync(process.execPath, [path.join(__dirname, 'test_ambient_native_ui.js')], { stdio: 'inherit' });
}).catch((error) => { console.error(error); process.exitCode = 1; });
