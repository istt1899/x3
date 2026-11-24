'use strict';

const { drawCabin } = require('./cabin');
const { sample } = require('./lin');
const scenes = require('./scenes');
const { drawHeadlights } = require('./headlight-art');
const { modes, flashLengths, intervals, orderNames, lampLabel, strobeFrames, frameAt } = require('./headlight-preview');

const sequences = [
    { name: 'Вместе', frames: [0, 3, 0, 3] },
    { name: 'По очереди', frames: [1, 0, 2, 0] },
    { name: 'Осмотр', frames: [1, 2, 3, 0] },
];
const presets = [
    { name: 'Янтарь', upper: [255, 156, 50], lower: [192, 77, 32], bright: 65 },
    { name: 'Ледник', upper: [80, 186, 242], lower: [54, 100, 220], bright: 55 },
    { name: 'Сумерки', upper: [162, 109, 244], lower: [57, 69, 156], bright: 35 },
];
const holds = [500, 1000, 1500, 2000];
const defaultTimes = [1000, 1000, 1000, 1000];
const sections = [[0, 'Фары и эффекты', 246], [1, 'Салон', 153], [2, 'Проверка', 188]];
const previewScale = 4;
const zoneNames = { upper: 'Верхняя зона', lower: 'Нижняя зона' };
const model = sample();
const C = {
    bg: '#10171d', panel: '#18222a', stage: '#121b23', border: '#40515b', soft: '#263741',
    text: '#eff4f2', dim: '#b5c5c8', accent: '#aad8e3', active: '#254c58',
    warm: '#f4c58c', ok: '#a8dfbd', fault: '#ffb4aa',
};
const seconds = (ms) => String(ms / 1000).replace('.', ',') + ' с';
const validFrames = (xs) => Array.isArray(xs) && xs.length === 4 && xs.every((v) => Number.isInteger(v) && v >= 0 && v <= 3);
const validTimes = (xs) => Array.isArray(xs) && xs.length === 4 && xs.every((v) => holds.includes(v));
const lookFor = (p) => ({ kind: 'solid', upper: { rgb: p.upper.slice(), bright: p.bright }, lower: { rgb: p.lower.slice(), bright: p.bright }, speed: 2 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const total = (times) => times.reduce((sum, ms) => sum + ms, 0);

function lightStudio(ctx, control, lights, redraw, go, vehicle = {}) {
    const { settings } = ctx;
    let section = 0, frame = 0, report = null, saved = false, zone = null;
    let lastEdit = null, lastCabin = null, elapsed = 0, started = null;
    let armed = false, confirmation = 0, testPreview = null, previewFinished = false;
    const { headlights } = vehicle;
    const strobe = { mode: 0, flash: 1, rate: 1, burst: 2, order: 0, fog: false };
    const hardwareStatus = () => headlights ? headlights.status() :
        { busy: false, note: '', blocked: 'На этом стенде доступен экранный тест' };

    function resetPreview() {
        testPreview = null;
        previewFinished = false;
        confirmation = 0;
    }
    function setArmed(value) {
        resetPreview();
        timing(true);
        if (!value && headlights) headlights.stop();
        armed = value;
    }
    function configure(key, value) {
        resetPreview();
        strobe[key] = value;
    }
    function playStrobe() {
        if (testPreview) { resetPreview(); return; }
        confirmation = 0;
        previewFinished = false;
        const steps = strobeFrames(strobe.mode, strobe.burst, strobe.order, flashLengths[strobe.flash],
            intervals[strobe.rate], strobe.fog);
        testPreview = { steps, started: Date.now() };
    }
    function previewMask() {
        if (!testPreview) return 0;
        const index = frameAt(testPreview.steps, (Date.now() - testPreview.started) / previewScale);
        if (index >= 0) return testPreview.steps[index].mask;
        resetPreview();
        previewFinished = true;
        return 0;
    }
    function testBMW() {
        const status = hardwareStatus();
        if (status.busy) { headlights.stop(); return; }
        if (!headlights || status.blocked) { confirmation = 0; return; }
        if (confirmation > Date.now()) {
            confirmation = 0;
            void headlights.start(flashLengths[strobe.flash]);
        } else {
            resetPreview();
            confirmation = Date.now() + 10000;
        }
    }
    const validSequence = (value) => Number.isInteger(value) && value >= 0 && value <= sequences.length;
    const chosen = () => {
        const value = settings.get('studioSequence');
        return validSequence(value) ? value : 2;
    };
    const custom = () => {
        const stored = settings.get('studioFrames');
        return validFrames(stored) ? stored.slice() : [0, 0, 0, 0];
    };
    const customTimes = () => {
        const stored = settings.get('studioTimes');
        return validTimes(stored) ? stored.slice() : defaultTimes.slice();
    };
    const frames = () => chosen() === 3 ? custom() : sequences[chosen()].frames;
    const durations = () => chosen() === 3 ? customTimes() : defaultTimes;
    const liveLights = () => Array.isArray(lights.lights) ? lights.lights : [];
    const zones = () => ctx.preview ? model : liveLights().filter((lamp) => !lamp.blind && !lamp.fault);
    const hasZone = (name) => zones().some((lamp) => lamp.part === name);
    const hasConflict = () => typeof vehicle.conflict === 'function' && !!vehicle.conflict();
    const canApply = () => ctx.preview || (liveLights().some((lamp) => !lamp.fault) &&
        !hasConflict() && lights.state !== 'finding' && !lights.error && !lights.readFail);
    function timing(reset) {
        if (reset) { elapsed = 0; started = null; return 0; }
        if (started !== null && Math.max(0, Date.now() - started) + elapsed >= total(durations())) {
            elapsed = total(durations());
            started = null;
        }
        return started === null ? elapsed : elapsed + Math.max(0, Date.now() - started);
    }
    function toggleTiming() {
        const point = timing();
        if (started !== null) { elapsed = point; started = null; return; }
        if (point >= total(durations())) elapsed = 0;
        started = Date.now();
    }
    function setSection(value) {
        if (section !== value) {
            setArmed(false);
            zone = null;
            saved = false;
        }
        section = value;
    }
    function storeUndo() {
        lastEdit = { seq: chosen(), frame, frames: custom(), times: customTimes() };
        timing(true);
    }
    function selectSequence(i) {
        if (chosen() !== i) {
            storeUndo();
            settings.set('studioSequence', i);
        }
        frame = 0;
    }
    function edit(bit) {
        storeUndo();
        const xs = frames().slice(), times = durations().slice();
        if (bit) xs[frame] ^= bit;
        else times[frame] = holds[(holds.indexOf(times[frame]) + 1) % holds.length];
        settings.set('studioFrames', xs);
        settings.set('studioTimes', times);
        settings.set('studioSequence', 3);
    }
    function undo() {
        if (!lastEdit) return;
        timing(true);
        settings.set('studioFrames', lastEdit.frames);
        settings.set('studioTimes', lastEdit.times);
        settings.set('studioSequence', lastEdit.seq);
        frame = lastEdit.frame;
        lastEdit = null;
    }
    function changeCabin(look) {
        if (look ? !canApply() : !control.on()) return;
        if (look && control.on() && same(control.look(), look)) { zone = null; return; }
        lastCabin = { look: control.look(), on: control.on() };
        if (look) {
            control.setLook(look);
            if (vehicle.activate) vehicle.activate();
        } else control.carColour();
        lastCabin.expected = { look: control.look(), on: control.on() };
        zone = null;
        saved = false;
    }
    function canUndoCabin() {
        return lastCabin && (!lastCabin.on || canApply()) &&
            same(lastCabin.expected, { look: control.look(), on: control.on() });
    }
    function undoCabin() {
        if (!canUndoCabin()) return;
        if (lastCabin.on) {
            control.setLook(lastCabin.look);
            if (vehicle.activate) vehicle.activate();
        } else control.carColour();
        lastCabin = null;
        zone = null;
        saved = false;
    }
    function check() {
        const colour = scenes.lightAt(lookFor(presets[0]), { part: 'upper', y: 0 }, 0);
        const storage = [['studioSequence', validSequence], ['studioFrames', validFrames], ['studioTimes', validTimes]];
        const validStorage = storage.every(([key, valid]) => {
            const value = settings.get(key);
            return value === undefined || valid(value);
        });
        report = [
            ['Модель салона', model.some((l) => l.part === 'upper') && model.some((l) => l.part === 'lower')],
            ['Цвет и яркость', scenes.hex(colour.rgb) === '#ff9c32' && colour.bright === 65],
            ['Кадры фар', validStorage && sequences.every((s) => validFrames(s.frames))],
        ];
    }

    function draw(cv, t) {
        const label = (value, x, y, size, color = C.text, align = 'left', bold = false) => cv.text(
            value, x, y, size, color, { align, font: bold ? 'bold' : 'label', literal: true }
        );
        const title = (value, x, y) => label(value, x, y, 34, C.text, 'left', true);
        const rule = (a, b, y) => cv.line(a, y, b, y, 1, C.border);
        const target = (x, y, w, h, key, fn, enabled = true) => {
            if (enabled && cv.own && cv.target) cv.target(x, y, w, h, () => { fn(); return redraw(); }, 'studio-' + key);
        };
        function button(x, y, w, h, name, key, fn, { selected = false, primary = false, enabled = true } = {}) {
            cv.roundRect(x, y, w, h, 9, primary && enabled ? C.accent : selected ? C.active : C.soft);
            cv.strokeRoundRect(x, y, w, h, 9, selected ? 2 : 1, selected ? C.accent : C.border);
            const fg = !enabled ? C.dim : primary ? C.bg : C.text;
            const options = { font: 'bold', literal: true };
            let size = 24;
            if (cv.textWidth) while (size > 19 && cv.textWidth(name, size, options) > w - 22) size--;
            label(name, x + w / 2, y + h / 2 + size * 0.31, size, fg, 'center', true);
            target(x, y, w, h, key, fn, enabled);
        }

        cv.roundRect(16, 42, 1568, 470, 14, C.bg);
        let tabX = 26;
        sections.forEach(([value, name, width]) => {
            const selected = section === value;
            button(tabX, 49, width, 52, name, 'section' + value, () => setSection(value), { selected });
            tabX += width + 12;
        });
        label(ctx.preview ? 'Эмулятор iDrive' : 'Студия света', 1552, 82, 23, C.dim, 'right');
        cv.roundRect(26, 115, 575, 380, 14, C.panel);
        cv.roundRect(617, 115, 957, 380, 14, C.panel);

        if (section === 0) {
            const xs = frames(), times = durations(), length = total(times), point = timing();
            const frameIndex = point > 0 || started !== null
                ? frameAt(times.map((ms) => ({ ms })), point) : frame;
            const hardware = armed ? hardwareStatus() : null;
            const mask = armed ? previewMask() : (xs[frameIndex] || 0);
            title('Фары BMW', 48, 158);
            label('Экранный предпросмотр', 575, 158, 22, C.accent, 'right');
            cv.roundRect(48, 177, 531, 220, 10, C.stage);
            drawHeadlights(cv, mask);
            label(lampLabel(mask), 48, 424, 24, C.text, 'left', true);
            if (!armed) {
                label(frameIndex < 0 ? 'Тест завершён' : 'Кадр ' + (frameIndex + 1) + ' из 4',
                    575, 424, 21, C.dim, 'right');
            } else if (mask & 48) label('Вид сзади', 575, 424, 21, C.dim, 'right');
            button(48, 435, 531, 43, armed ? 'Выключить стробоскоп' : 'Включить стробоскоп',
                'strobe-toggle', () => setArmed(!armed), { primary: !armed, selected: armed });

            if (armed) {
                const rateNames = ['1 Гц', '2 Гц', '3 Гц', '4 Гц'];
                const confirming = confirmation > Date.now() && !hardware.blocked;
                title('Стробоскоп', 641, 158);
                label('Включён', 1542, 158, 22, C.ok, 'right');
                modes.forEach(({ name }, i) => {
                    button(641 + i * 229, 176, 216, 49, name, 'strobe-mode' + i,
                        () => configure('mode', i), { selected: strobe.mode === i, enabled: !hardware.busy });
                });
                button(641, 241, 290, 50, 'Импульс · ' + flashLengths[strobe.flash] + ' мс', 'strobe-flash',
                    () => configure('flash', (strobe.flash + 1) % flashLengths.length), { enabled: !hardware.busy });
                button(946, 241, 290, 50, 'Частота · ' + rateNames[strobe.rate], 'strobe-rate',
                    () => configure('rate', (strobe.rate + 1) % intervals.length), { enabled: !hardware.busy });
                const lampChoice = strobe.mode === 3 ? 'Все огни' : strobe.fog ? 'Дальний + ПТФ' : 'Дальний свет';
                button(1251, 241, 291, 50, lampChoice, 'strobe-lamps', () => configure('fog', !strobe.fog),
                    { enabled: strobe.mode !== 3 && !hardware.busy, selected: strobe.mode === 3 || strobe.fog });
                if (strobe.mode === 2) {
                    button(641, 302, 290, 45, 'Вспышек в серии · ' + strobe.burst, 'strobe-burst',
                        () => configure('burst', strobe.burst % 3 + 1), { enabled: !hardware.busy });
                    button(946, 302, 290, 45, orderNames[strobe.order], 'strobe-order',
                        () => configure('order', (strobe.order + 1) % orderNames.length), { enabled: !hardware.busy });
                }
                const previewNote = testPreview ? 'Идёт экранный тест · замедлен в 4 раза' : previewFinished
                    ? 'Экранный тест завершён' : 'Левая и правая фары указаны по ходу движения';
                label(previewNote, 641, 375, 22, C.dim);
                const carNote = confirming ? 'На закрытой площадке · 3 вспышки дальнего света' :
                    hardware.note || hardware.blocked || 'BMW · тест обеих фар на стоянке';
                label(carNote, 641, 408, 22, confirming ? C.warm : C.dim);
                button(641, 424, 420, 53, testPreview ? 'Остановить экранный тест' : 'Тест на экране',
                    'strobe-play', playStrobe, { primary: true, enabled: !hardware.busy });
                const carAction = hardware.busy ? 'Остановить тест BMW' : confirming ? 'Подтвердить тест фар' : 'Тест фар BMW';
                button(1073, 424, 469, 53, carAction, 'strobe-bmw', testBMW,
                    { enabled: hardware.busy || (!hardware.blocked && !testPreview), selected: confirming });
                return;
            }

            title('Редактор кадров', 641, 158);
            label('Длина сцены · ' + seconds(length), 1548, 158, 22, C.dim, 'right');
            sequences.map((s) => s.name).concat('Свой').forEach((name, i) => {
                button(641 + i * 229, 176, 216, 49, name, 'seq' + i, () => selectSequence(i), { selected: chosen() === i });
            });

            const stripX = 641, stripW = 901;
            let start = 0;
            xs.forEach((mask, i) => {
                const x = stripX + i * 229, selected = i === frameIndex;
                cv.roundRect(x, 239, 216, 88, 9, selected ? C.active : C.stage);
                cv.strokeRoundRect(x, 239, 216, 88, 9, selected ? 2 : 1, selected ? C.accent : C.border);
                label('Кадр ' + (i + 1), x + 14, 269, 22, C.text, 'left', true);
                label(seconds(times[i]), x + 202, 269, 22, C.dim, 'right');
                [1, 2].forEach((bit, j) => {
                    const ix = x + 14 + 99 * j, on = (mask & bit) !== 0;
                    cv.roundRect(ix, 281, 89, 30, 5, on ? C.accent : C.soft);
                    label(j ? 'Правая' : 'Левая', ix + 44.5, 302, 18, on ? C.bg : C.dim, 'center', true);
                });
                target(x, 239, 216, 88, 'frame' + i, () => { timing(true); frame = i; });
                const width = stripW * times[i] / length;
                cv.roundRect(stripX + start + 1, 337, width - 3, 6, 2, selected ? C.accent : C.border);
                start += width;
            });
            if (point > 0 || started !== null) {
                const marker = stripX + 4 + (stripW - 8) * point / length;
                cv.roundRect(marker - 3, 331, 6, 18, 3, C.warm);
            }
            button(641, 360, 276, 53, 'Левая фара', 'left', () => edit(1), { selected: !!(xs[frame] & 1) });
            button(929, 360, 276, 53, 'Правая фара', 'right', () => edit(2), { selected: !!(xs[frame] & 2) });
            button(1217, 360, 325, 53, 'Время кадра · ' + seconds(times[frame]), 'hold', () => edit(0));
            const playback = started !== null ? 'Пауза' : point > 0 && point < length ? 'Продолжить тест' : 'Тест кадров';
            button(641, 424, 358, 53, playback, 'play', toggleTiming, { primary: true });
            button(1011, 424, 160, 53, 'Сброс времени', 'play-reset', () => timing(true), { enabled: started !== null || point > 0 });
            button(1183, 424, 175, 53, 'Отменить', 'undo', undo, { enabled: !!lastEdit });
            button(1370, 424, 172, 53, 'К салону', 'back', () => setSection(1));
        } else if (section === 1) {
            title('Подсветка салона', 48, 158);
            const has = liveLights().length > 0, pending = lights.state === 'finding';
            const conflict = hasConflict();
            const stockAvailable = typeof vehicle.stock === 'function' && !!vehicle.stock();
            const followsMode = typeof control.target === 'function' && control.target().why === 'mode';
            const canChange = canApply();
            const partial = has && (!hasZone('upper') || !hasZone('lower'));
            const noReply = lights.error || lights.readFail;
            const summary = ctx.preview ? 'Модель салона' : conflict ? 'Подсветкой управляет другое приложение' :
                pending ? 'Поиск зон салона' : noReply ? 'Нет свежего ответа подсветки' :
                    !has ? 'Зоны салона не найдены' : partial ? 'Известна часть зон салона' : 'Известные зоны салона';
            label(summary, 48, 192, 22, conflict || noReply ? C.warm : C.dim);
            cv.roundRect(48, 208, 239, 267, 10, C.stage);
            const look = control.look();
            const lit = zone ? lookFor(presets[0]) : lights.scene;
            const shown = has && !ctx.preview ? liveLights() : model;
            drawCabin(cv, t, { x: 49, y: 221, w: 236, h: 240 }, shown,
                (lamp) => {
                    if (zone) return lamp.part === zone && !lamp.fault && !lamp.blind ? scenes.lightAt(lit, lamp, 0) : null;
                    return lit ? lights.at(lamp) : null;
                }, { rhd: settings.get('drive') === 'rhd' });
            const reason = zone ? 'Проверка на схеме' : ctx.preview ? (control.on() ? 'Сцена в эмуляторе' : 'Штатная сцена в модели') :
                followsMode ? 'Сцена режима движения' :
                    control.on() ? 'Выбрана своя сцена' : 'Штатный свет';
            label(reason, 308, 244, 23, C.text, 'left', true);
            Object.entries(zoneNames).forEach(([name, title], i) => {
                const y = 265 + 71 * i;
                cv.roundRect(308, y, 29, 29, 6, zone === name || (control.on() && hasZone(name)) ? (zone ? lit[name].rgb : look[name].rgb) : C.border);
                label(title, 352, y + 22, 23);
                label(hasZone(name) ? (ctx.preview ? 'В модели' : 'В конфигурации') : 'Нет данных', 352, y + 46, 19, C.dim);
            });
            if (zone) label('Тест на экране', 308, 448, 21, C.accent);
            else if (ctx.preview) label('Экранный режим', 308, 448, 21, C.dim);
            else if (partial) label('Часть зон недоступна', 308, 448, 21, C.dim);

            title('Быстрые сцены', 641, 158);
            label('Постоянный свет', 1548, 158, 22, C.dim, 'right');
            presets.forEach((p, i) => {
                const x = 641 + i * 304, selected = control.on() && same(control.look(), lookFor(p));
                button(x, 176, 292, 54, p.name, 'preset' + i, () => changeCabin(lookFor(p)), { selected, primary: i === 0, enabled: canChange });
                cv.roundRect(x + 2, 237, 138, 5, 2, p.upper);
                cv.roundRect(x + 152, 237, 138, 5, 2, p.lower);
            });
            const manual = has || stockAvailable || ctx.preview;
            const message = conflict ? 'Сцены доступны после отключения второго контроллера' : !canChange ?
                (stockAvailable ? 'Доступны штатные цвета во вкладке «Цвет»' : 'Ожидаются данные о зонах салона') :
                followsMode ? 'Режим движения имеет приоритет над быстрыми сценами' :
                    partial ? 'Сцена меняет цвет в доступных зонах' : 'Сцена меняет цвет верхней и нижней зон';
            label(message, 641, 273, 21, C.dim);
            rule(641, 1542, 288);
            button(641, 302, 292, 54, 'Цвет и яркость', 'colour', () => go(0), { enabled: manual && !conflict });
            button(945, 302, 292, 54, 'Штатный свет', 'stock', () => changeCabin(null), { selected: !control.on() && !followsMode, enabled: control.on() || canChange });
            button(1249, 302, 293, 54, 'Отменить смену', 'cabin-undo', undoCabin, { enabled: !!canUndoCabin() });
            label('Проверка зон на схеме', 641, 389, 22, C.dim);
            button(641, 403, 212, 53, 'Верхняя зона', 'zone-upper', () => { zone = 'upper'; }, { selected: zone === 'upper', enabled: hasZone('upper') });
            button(865, 403, 212, 53, 'Нижняя зона', 'zone-lower', () => { zone = 'lower'; }, { selected: zone === 'lower', enabled: hasZone('lower') });
            button(1089, 403, 159, 53, 'Завершить', 'zone-reset', () => { zone = null; }, { enabled: zone !== null });
            button(1260, 403, 282, 53, saved ? 'Сцена сохранена' : 'В избранное', 'save', () => {
                if (!control.favs().some((value) => same(value, look))) control.saveFav();
                saved = true;
            }, { selected: saved, enabled: control.on() });
            if (!ctx.preview) label('Если цвет не изменился, выберите штатный свет в прежнем Ambient Config.', 641, 481, 20, C.dim);
        } else {
            title('Данные автомобиля', 48, 158);
            const checks = [
                ['Верхняя зона', hasZone('upper')],
                ['Нижняя зона', hasZone('lower')],
            ];
            const noReply = !ctx.preview && (lights.error || lights.readFail);
            label(ctx.preview ? 'Источник — модель салона' : noReply ? 'Нет свежего ответа подсветки' : 'Источник — данные приложения',
                48, 194, 22, noReply ? C.warm : C.dim);
            checks.forEach(([name, found], i) => {
                const y = 234 + 64 * i;
                rule(48, 575, y - 10);
                label(name, 48, y + 27, 25);
                label(found ? (ctx.preview ? 'В модели' : 'В конфигурации') : 'Нет данных', 575, y + 27, 22, found ? C.ok : C.dim, 'right');
            });
            label('Внешние фары', 48, 395, 24, C.text, 'left', true);
            const car = hardwareStatus();
            label(car.blocked || car.note || 'Готово к тесту на стоянке', 48, 434, 22, C.dim);

            title('Самопроверка', 641, 158);
            label('Проверка формата кадров и расчёта цвета', 641, 193, 22, C.dim);
            (report || [['Модель салона', null], ['Цвет и яркость', null], ['Кадры фар', null]]).forEach(([name, ok], i) => {
                const y = 220 + i * 62;
                rule(641, 1542, y);
                label(name, 641, y + 40, 25);
                label(ok === null ? 'Ожидает проверки' : ok ? 'Пройдено' : 'Ошибка', 1542, y + 40, 23,
                    ok === null ? C.dim : ok ? C.ok : C.fault, 'right');
            });
            if (report && !report[2][1]) {
                label('Измените кадр в разделе «Фары и эффекты», затем повторите проверку.', 641, 408, 20, C.warm);
            }
            button(641, 424, 326, 53, report ? 'Проверить снова' : 'Запустить проверку', 'check', check, { primary: true });
            button(979, 424, 180, 53, 'К салону', 'back', () => setSection(1));
        }
    }

    draw.moving = () => section === 0 && (started !== null || armed);
    draw.leave = () => { setArmed(false); zone = null; saved = false; };
    return draw;
}

module.exports = { lightStudio, validFrames };
