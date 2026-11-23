'use strict';
/**
 * Ambient config - any colour on the car's ambient light, animations, and a look for each driving mode.
 *
 * Tabs:
 *   Свет           cabin presets, a screen-only headlight storyboard, and a local model self-check
 *   Colour         the colour ring (and white) for the whole car, the upper lights or the lower ones, the
 *                  brightness, and the car from above lit as the car is; Original colour gives the light back
 *   Animations     Solid, Breathing, Rainbow, Smooth fade, Colour wave, how fast, shown moving on the car picture;
 *                  Turn signal glow (that side's door lines blink green with it), Open door red (its line blinking) and
 *                  Hazard red (every light pulses red while the hazards are on), each off until switched on
 *   Driving modes  for each driving mode the car has: Choose colour (the Colour and Animations tabs change that mode's
 *                  look until Done), the animation button stepping through them, or Original colour (BMW's); with
 *                  nothing chosen, the Colour tab's colour; welcome sweep, Sport pulse, Redline's shift flash
 *   Favourites     six saved looks: tap to put one on
 * Outside the emulator, cabin selections use the car. The cabin lights are driven through the body controller (lights.js); a car
 * whose body controller does not answer keeps BMW's own colours (ambient.js), offered on the Colour tab.
 * It runs from the platform's start (app.json "autostart"): the look and the driving modes work with the app closed.
 * With IterioDev's Comfort tool writing the same lights (others.js: its own ambient colour on), it stands aside (no
 * light writes until that is off or Comfort is gone) and the Colour and Animations tabs say so in red and recommend uninstalling it.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { Diag } = require('./kit/diag');
const Car = require('./kit/car');
const { Ambient, SLOTS } = require('./ambient');
const { Lights } = require('./lights');
const { Control } = require('./control');
const { Others } = require('./others');
const { lightStudio } = require('./light-studio');
const { previewCabin } = require('./preview-cabin');
const { t: translate } = require('./kit/i18n');
const { drawCabin } = require('./cabin');
const { sample } = require('./lin');
const S = require('./scenes');

const W = 1600, H = 520;
const TABS = ['Свет', 'Цвет', 'Анимации', 'Режимы', 'Избранное'];
const MODE_NAMES = { sport: 'Sport', comfort: 'Comfort', eco: 'Eco Pro', adaptive: 'Adaptive', hybrid: 'Hybrid', electric: 'Electric' };
const QUICK = [['Red', [255, 0, 0]], ['Orange', [255, 100, 0]], ['Amber', [255, 170, 0]], ['Yellow', [255, 235, 0]], ['Green', [0, 255, 60]],
    ['Cyan', [0, 230, 255]], ['Blue', [0, 70, 255]], ['Violet', [120, 60, 255]], ['Pink', [255, 40, 170]], ['White', [255, 255, 255]]];
const RING = { cx: 290, cy: 288, R: 186, r: 136 }, DIAL = { cx: 655, cy: 400, R: 54, r: 43 };

const ON_BY_DEFAULT = ['follow', 'flashAlerts'];
const MOVE_DRAW_MS = 250;            // a moving scene's picture: at most 4 a second
const FIND_LATER_MS = 5000;          // lights known from an earlier start: read again once the first colour is out
const IDLE_MS = 15 * 60000;          // without the car's own state: not driven nor the app used this long = parked and left
/* The car's turn signals (Light.StatusFunctionsIndicators activeFunctionIndicateDirection, by name or number): the
 * driver's (held or tapped), the driving assistant's, and the hazards; the lock and alarm flashes are none. */
const TURN = { DAUERBLINKEN_LINKS: 'left', TIPPBLINKEN_LINKS: 'left', DAUERBLINKEN_RECHTS: 'right', TIPPBLINKEN_RECHTS: 'right',
    WARNBLINKEN_MANUELL: 'both', CRASH_BLINKEN: 'both', AUFFAHRWARNBLINKEN: 'both', WARNBLINKEN_NACH_GEFAHRENBREMSUNG: 'both',
    FAS_WARNBLINKEN_AUSPRAEGUNG_1: 'both', FAS_WARNBLINKEN_AUSPRAEGUNG_2: 'both', FAS_WARNBLINKEN_AUSPRAEGUNG_3: 'both',
    FAS_RICHTUNGSBLINKEN_LOWPRIO_LINKS: 'left', FAS_RICHTUNGSBLINKEN_MIDPRIO_LINKS: 'left', FAS_RICHTUNGSBLINKEN_HIGHPRIO_LINKS: 'left',
    FAS_RICHTUNGSBLINKEN_LOWPRIO_RECHTS: 'right', FAS_RICHTUNGSBLINKEN_MIDPRIO_RECHTS: 'right', FAS_RICHTUNGSBLINKEN_HIGHPRIO_RECHTS: 'right' };
const TURN_NO = { 1: 'both', 6: 'both', 7: 'left', 8: 'right', 9: 'left', 10: 'right', 12: 'both', 13: 'both', 16: 'both', 18: 'left', 19: 'right',
    20: 'left', 21: 'right', 22: 'left', 23: 'right', 24: 'both', 25: 'both' };
const turnOf = (v) => { const x = v && typeof v === 'object' ? v.activeFunctionIndicateDirection : v; return (typeof x === 'number' ? TURN_NO[x] : TURN[x]) || null; };
/* The doors (DoorsWindowsRoofMirrors.CentralLockingSystemAndPanelStatus): each door's switch, open = 1 or ..._OFFEN. */
const DOOR_FIELDS = { statusDoorSwitchDRD: 'driver front', statusDoorSwitchPSD: 'passenger front', statusDoorSwitchDRDR: 'driver rear',
    statusDoorSwitchPSDR: 'passenger rear' };
const doorsOf = (v) => Object.keys(DOOR_FIELDS).filter((k) => v && (v[k] === 1 || /_OFFEN$/.test(String(v[k])))).map((k) => DOOR_FIELDS[k]);
const DAY_NIGHT = { KEINE_AENDERUNG: 0, TAG: 1, NACHT: 2, SIGNAL_UNGUELTIG: 3 };

async function background(bg) {
    if (bg.preview) return previewCabin(bg);
    const { settings, signals, log } = bg;
    const ambient = new Ambient({ settings, signals, log });
    await ambient.start();
    const diag = await new Diag(signals, log).init();
    diag.quiet = true; diag.busyLog = false;
    // the lights found at an earlier start: the colour goes out at once, and the buses are read again after it
    S.setDecor(settings.get('decorWith'));
    // light reads that failed (busy or silent) READ_FAILS times in a row: the body module's write is tried first and the
    // reads are left out, as they hang it on some cars (#197, lights.js "Blind")
    const READ_FAILS = 3;
    const lights = new Lights({ diag, log, known: settings.get('lightsKnown'), writeFirst: (Number(settings.get('lightsReadFails')) || 0) >= READ_FAILS });
    const control = new Control({ settings, lights, ambient, log });
    control.start();
    // with the lights answering, the driving modes' looks replace BMW's colours by mode (ambient.js)
    lights.on('change', () => { ambient.slotsOff = lights.lights.length > 0; });
    lights.on('found', (l) => settings.set('lightsKnown', l));
    // lights that did not answer: asked again every 2 min while the car is in use (parked and left: the car sleeps)
    const again = () => setTimeout(() => { if (control._away) again(); else find(); }, 120000);
    const counted = (l) => {
        const n = Number(settings.get('lightsReadFails')) || 0;
        if (l.length && !lights.blind) { if (n) settings.set('lightsReadFails', 0); }
        else if (!l.length && lights.readFail && !control._away) {
            settings.set('lightsReadFails', n + 1);
            if (n + 1 >= READ_FAILS && !lights.writeFirst) { lights.writeFirst = true; log.info('lights: the reads failed ' + (n + 1) + ' times: the write is tried first from now'); }
        }
        return l;
    };
    const find = () => lights.find().then(counted).then((l) => { if (!l.length) again(); }, (e) => { log.warn('lights: ' + e); again(); });
    setTimeout(find, lights.lights.length ? FIND_LATER_MS : 0);
    signals.watch('de.bmw.infotainment.vehicle.Vehicle', '1', {
        statusDayNightChangeOver: (v) => {
            const x = v && typeof v === 'object' ? v.dayNightChangeOver : v, c = typeof x === 'string' ? DAY_NIGHT[x] : x;
            if (c === 1 || c === 2) control.night(c === 2);
        },
    }, log).catch((e) => log.warn('day / night: ' + (e && e.message || e)));
    // the car locked and left (parked, standby: nobody in it) gives the lights back and nothing is written, so the car
    // can sleep; living, ignition, driving: ours again. A car that has not said its state: not driven and the app not
    // used for IDLE_MS counts as left
    let stateSeen = false, activeT = Date.now();
    const active = () => { activeT = Date.now(); if (!stateSeen && control._away) control.away(false); };
    // the state from either of the car's two copies (some cars send only the one without a CRC); without one, the
    // partial networks it keeps awake, numbered the same (KOM_PARKEN... = 1-3, no communication = parked)
    const conditionFrom = (v) => {
        const n = Car.conditionOf(v && v.statusConditionVehicle);
        if (n !== undefined) return n;
        const p = v && v.controlBasePartialNetworks;
        if (p === 0 || p === 'KEINE_KOMMUNIKATION') return 1;
        return Car.conditionOf(typeof p === 'string' ? p.replace(/^KOM_/, '') : p);
    };
    const sources = new Set();
    const onCondition = (field) => (v) => {
        const n = conditionFrom(v);
        if (n === undefined) return;
        if (!sources.has(field)) { sources.add(field); log.info('vehicle state: from ' + field + ' (' + n + ')'); }
        stateSeen = true;
        control.away(n <= 3);
    };
    signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
        VehicleCondition: onCondition('VehicleCondition'),
        vehicleConditionNoCrc: onCondition('vehicleConditionNoCrc'),
    }, log).catch((e) => log.warn('vehicle state: ' + (e && e.message || e)));
    // the speed
    signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
        statusCarSpeed2: (v) => {
            const k = v && v.speedVehicleCentreOfGravity;
            if (typeof k === 'number' && k !== 65535 && k * 0.015625 > 1 && k * 0.015625 < 400) active();
        },
    }, log).catch((e) => log.warn('speed: ' + (e && e.message || e)));
    setInterval(() => {
        if (stateSeen || control._away || Date.now() - activeT <= IDLE_MS) return;
        log.info('vehicle state: none from the car, not driven or used for ' + IDLE_MS / 60000 + ' min: parked');
        control.away(true);
    }, 30000);
    // the turn signals: that side's door lines blink green; an open door: its line red (settings turnGlow, doorRed, both off
    // until switched on)
    signals.watch('de.bmw.body.Light', '1', { StatusFunctionsIndicators: (v) => control.turn(turnOf(v)) }, log)
        .catch((e) => log.warn('turn signals: ' + (e && e.message || e)));
    signals.watch('de.bmw.body.DoorsWindowsRoofMirrors', '1', { CentralLockingSystemAndPanelStatus: (v) => control.doors(doorsOf(v)) }, log)
        .catch((e) => log.warn('doors: ' + (e && e.message || e)));
    settings.onChange((key) => {
        if (key === 'nightDim') control.night(control._night);
        if (key === 'decorWith') { S.setDecor(settings.get('decorWith')); lights.redraw(); }
        if (key === 'follow') control.apply();
        if (key === 'turnGlow' || key === 'doorRed' || key === 'hazardRed' || key === 'drive') control.signals();
        if (key === 'doorCar') control.carDoorSetting();
    });
    const others = new Others({ log }).start();
    // IterioDev's Comfort tool writes the same lights while its own ambient colour is on: then ours stand aside (no
    // writes, so the two don't fight and the lights don't jump), and carry on once it is off or gone. Comfort running
    // for the Seats app alone (its ambient off) leaves the lights to us (others.js).
    const besideComfort = () => {
        lights.hold('comfort', others.comfort);
        if (others.comfort) log.warn('lights: IterioDev\'s Comfort tool has its ambient on, Ambient config stands aside until it is off or gone');
    };
    others.on('change', besideComfort);
    besideComfort();
    return { ambient, lights, control, active, others, lookAgain: () => lights.find({ force: true }).then(counted) };
}

const nearest = (rgb) => {
    const sat = (Math.max.apply(null, rgb) - Math.min.apply(null, rgb)) / Math.max(1, Math.max.apply(null, rgb));
    if (sat < 0.25) return 'White';
    const h = S.hueOf(rgb);
    let best = QUICK[0], d = 999;
    QUICK.forEach((q) => { if (q[0] === 'White') return; const e = Math.abs(((S.hueOf(q[1]) - h + 540) % 360) - 180); if (e < d) { d = e; best = q; } });
    return best[0];
};
const textOn = (rgb) => (rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11 > 150 ? '#101010' : '#ffffff');

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const { ambient, lights, control, active, others, lookAgain } = ctx.background || await background(ctx);
        // editing: null (the driver's own look) or a driving mode whose look the Colour and Animations tabs change
        let page = 4, part = 'all', dirty = true, editing = null;
        const T0 = Date.now();

        const look = () => (editing ? control.modeLook(editing) || control.look() : control.look());
        const setLook = (patch) => (editing ? control.setModeLook(editing, Object.assign(look(), patch)) : control.setLook(patch));
        const isOn = () => (editing ? !!control.modeLook(editing) : control.on());
        const done = () => { editing = null; page = 2; return redraw(); };
        // what the picture shows: a driving mode being changed as it will look, else the lights as the car shows them
        const pictureOf = (l, lk) => (editing ? (x) => S.lightAt(lk, x, Date.now() - T0) : l);
        const partColour = (l) => (part === 'lower' ? l.lower : l.upper);
        const shown = () => (lights.lights.length ? lights.lights : sample());
        const rhd = () => settings.get('drive') === 'rhd';
        // (a tap: the app in use - the car is not left, also for a car that does not say so)
        const redraw = () => { dirty = true; if (active) active(); return render(); };

        const setRgb = (rgb) => {
            const l = look(), b = partColour(l).bright;
            const c = { rgb: rgb.slice(), bright: b || 80 };
            if (part !== 'lower') l.upper = c;
            if (part !== 'upper') l.lower = Object.assign({}, c, part === 'all' ? {} : { bright: l.lower.bright });
            setLook({ upper: l.upper, lower: l.lower });
            return redraw();
        };
        const setBright = (b) => {
            const l = look(), v = Math.max(5, Math.min(100, Math.round(b)));
            if (part !== 'lower') l.upper.bright = v;
            if (part !== 'upper') l.lower.bright = v;
            setLook({ upper: l.upper, lower: l.lower });
            return redraw();
        };
        const stepHue = (d) => { const c = partColour(look()); return setRgb(S.hsv(S.stepHue(S.hueOf(c.rgb), d), 1, 1)); };

        // another ambient app's service writing the same lights: says so in place of the status, wrapped to width w
        const COMFORT_WARNING = 'IterioDev\'s Comfort tool has its ambient colour on and changes the same lights, so Ambient config ' +
            'has stopped changing them. Turn its colour and its drive-mode colours off in IterioDev\'s Ambient Light app (the seats ' +
            'keep working), or uninstall Comfort in the Store (Installed, Head-unit tools, Comfort).';
        // in red, so it is seen: nothing on these tabs reaches the lights while Comfort runs
        function warnOthers(cv, t, x, y, w) {
            const head = cv.textWidth(translate('Another ambient app is running'), 22, { font: 'bold', literal: true }) <= w
                ? 'Another ambient app is running' : 'Another ambient app';
            cv.text(head, x, y, 22, t.crit, { font: 'bold' });
            const lines = [];
            // translated whole before wrapping, so a localized build wraps its own sentence
            translate(COMFORT_WARNING).split(' ').forEach((word) => {
                const last = lines.length - 1, joined = last >= 0 ? lines[last] + ' ' + word : word;
                if (last >= 0 && cv.textWidth(joined, 18, { literal: true }) <= w) lines[last] = joined; else lines.push(word);
            });
            lines.forEach((line, i) => cv.text(line, x, y + 30 + i * 24, 18, t.crit, { literal: true }));
        }
        function status(cv, t, x, y) {
            if (ctx.preview) return cv.text('Предпросмотр в эмуляторе', x, y, 20, t.dim);
            if (others.comfort) return warnOthers(cv, t, x, y, 1560 - x);
            const n = lights.lights.length;
            const s = lights.state === 'finding' ? 'Поиск модулей подсветки…'
                : lights.state === 'none' ? 'Модули подсветки не ответили'
                    : lights.state === 'car' ? 'Штатный цвет из меню BMW'
                        : lights.blind ? 'Один цвет для всей подсветки' : 'Модулей подсветки под управлением: ' + n;
            cv.text(s, x, y, 20, lights.state === 'none' ? t.warn : t.dim);
            if (lights.error && lights.state !== 'none') {
                cv.text('Модуль не подтвердил запрос', x, y + 26, 18, t.warn);
            }
        }
        // the car picture: the lights as the car shows them (the car's own colour: grey)
        const carNow = (l) => (lights.scene ? lights.at(l) : null);

        function drawColour(cv, t) {
            const l = look(), c = partColour(l), sel = nearest(c.rgb);
            G.panel(cv, t, 24, 44, 736, 468, editing ? 'Цвет · ' + MODE_NAMES[editing] : 'Цвет');
            cv.arc(RING.cx, RING.cy, RING.r, RING.R, 0, 360, '#ff0000', { ramp: ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'], rampFrom: 0, rampTo: 360 });
            const h = S.hueOf(c.rgb), a = (90 - h) * Math.PI / 180, rm = (RING.R + RING.r) / 2;
            const kx = RING.cx + Math.cos(a) * rm, ky = RING.cy - Math.sin(a) * rm;
            cv.arc(kx, ky, 0, 22, 0, 360, '#ffffff'); cv.arc(kx, ky, 0, 16, 0, 360, S.hsv(h, 1, 1));
            const shownRgb = c.rgb.map((x) => Math.round(x * (0.35 + 0.65 * c.bright / 100)));
            cv.arc(RING.cx, RING.cy, 0, RING.r - 18, 0, 360, shownRgb);
            cv.text(nearest(c.rgb), RING.cx, RING.cy + 4, 38, textOn(shownRgb), { align: 'center', font: 'bold' });
            cv.text(part === 'all' ? 'Whole car' : part === 'upper' ? 'Upper lights' : 'Lower lights', RING.cx, RING.cy + 40, 20, textOn(shownRgb), { align: 'center' });
            G.button(cv, t, 44, 446, 56, 48, '<', () => stepHue(-15), { key: 'h-' });
            G.button(cv, t, 480, 446, 56, 48, '>', () => stepHue(15), { key: 'h+' });

            cv.text('Colouring', 566, 92, 20, t.dim);
            [['all', 'Whole car'], ['upper', 'Upper lights'], ['lower', 'Lower lights']].forEach(([k, n], i) => {
                G.button(cv, t, 566, 104 + i * 56, 176, 46, n, () => { part = k; return redraw(); }, { primary: part === k, key: 'part-' + k });
            });
            // the ring has every colour at its fullest: white is its own button
            G.button(cv, t, 566, 272, 176, 46, 'White', () => setRgb([255, 255, 255]), { primary: isOn() && sel === 'White', key: 'white' });
            cv.arc(DIAL.cx, DIAL.cy, DIAL.r, DIAL.R, -135, 135, withAlpha('#ffffff', 0.12), { round: true });
            cv.arc(DIAL.cx, DIAL.cy, DIAL.r, DIAL.R, -135, -135 + 270 * c.bright / 100, S.hsv(h, 1, 1), { round: true });
            cv.text(c.bright + '%', DIAL.cx, DIAL.cy + 6, 28, t.text, { align: 'center', font: 'bold' });
            cv.text('Brightness', DIAL.cx, DIAL.cy + 32, 15, t.dim, { align: 'center' });
            G.button(cv, t, 580, 464, 64, 44, '-', () => setBright(c.bright - 10), { key: 'b-' });
            G.button(cv, t, 666, 464, 64, 44, '+', () => setBright(c.bright + 10), { key: 'b+' });

            G.panel(cv, t, 776, 44, 800, 468, editing ? 'Предпросмотр · ' + MODE_NAMES[editing] : 'In the car');
            if (lights.state === 'none' && !editing) return drawBmwColours(cv, t);
            drawCabin(cv, t, { x: 790, y: 92, w: 330, h: 404 }, shown(), pictureOf(carNow, l), { rhd: rhd() });
            const x = 1150;
            [['Upper', l.upper], ['Lower', l.lower]].forEach(([n, v], i) => {
                cv.roundRect(x, 104 + i * 40, 26, 26, 7, v.rgb);
                cv.text(n + ': ' + nearest(v.rgb) + ', ' + v.bright + '%', x + 38, 124 + i * 40, 20, t.text);
            });
            if (editing) return editBar(cv, t, x);
            G.button(cv, t, x, 210, 268, 48, 'Original colour', () => { control.carColour(); return redraw(); }, { primary: !control.on(), key: 'car' });
            G.button(cv, t, x, 270, 268, 48, 'Save favourite', () => { control.saveFav(); return redraw(); }, { key: 'save' });
            status(cv, t, x, 352);
        }

        // changing a driving mode's look: which mode, and Done back to the Driving modes tab
        function editBar(cv, t, x) {
            cv.text('Сцена · ' + MODE_NAMES[editing], x, 222, 22, t.text, { font: 'bold' });
            cv.text('Для выбранного режима движения', x, 250, 18, t.dim);
            G.button(cv, t, x, 280, 268, 48, 'Done', done, { primary: true, key: 'done' });
        }

        // the body controller did not answer: BMW's own colours, as BMW's menu has them
        function drawBmwColours(cv, t) {
            cv.text('Any colour needs the body module, which did not answer.', 796, 136, 20, t.warn);
            cv.text('BMW\'s own colours meanwhile:', 796, 164, 20, t.dim);
            const now = ambient.slot();
            for (let i = 0; i < SLOTS; i++) {
                const n = i + 1;
                G.button(cv, t, 796 + (i % 4) * 132, 186 + Math.floor(i / 4) * 62, 120, 50, String(n), () => { ambient.setSlot(n); return redraw(); },
                    { primary: n === now, busy: !ambient.available, key: 'slot-' + n });
            }
            G.button(cv, t, 796, 386, 0, 48, 'Look again', () => { lookAgain().catch((e) => log.warn('lights: ' + e)); return redraw(); }, { key: 'again' });
            if (others.comfort) warnOthers(cv, t, 1346, 136, 214);
        }

        function drawAnimations(cv, t) {
            const l = look();
            G.panel(cv, t, 24, 44, 640, 468, editing ? 'Анимация · ' + MODE_NAMES[editing] : 'Анимация');
            const kinds = [['solid', 'No animation, a steady colour'], ['breathing', 'Slowly brighter and dimmer'], ['rainbow', 'Every colour in turn'],
                ['fade', 'Upper colour to lower colour and back'], ['wave', 'Colour rolling from side to side']];
            kinds.forEach(([k, d], i) => {
                const y = 92 + i * 66, on = isOn() && l.kind === k;
                G.button(cv, t, 44, y, 220, 50, S.NAMES[k], () => { setLook({ kind: k }); return redraw(); }, { primary: on, key: 'k-' + k });
                cv.text(d, 284, y + 32, 20, on ? t.text : t.dim);
            });
            cv.text('Speed', 44, 470, 20, t.dim);
            [[1, 'Slow'], [2, 'Normal'], [3, 'Fast']].forEach(([v, n], i) => {
                G.button(cv, t, 120 + i * 150, 440, 136, 48, n, () => { setLook({ speed: v }); return redraw(); }, { primary: (l.speed || 2) === v, key: 'sp-' + v });
            });

            G.panel(cv, t, 678, 44, 898, 468, editing ? 'Предпросмотр · ' + MODE_NAMES[editing] : 'In the car');
            // the picture shows the animation picked even before the car has answered
            const preview = (x) => (lights.scene ? lights.at(x) : control.on() ? S.lightAt(l, x, Date.now() - T0) : null);
            drawCabin(cv, t, { x: 700, y: 92, w: 420, h: 404 }, shown(), pictureOf(preview, l), { rhd: rhd() });
            const x = 1150;
            [['Upper', l.upper], ['Lower', l.lower]].forEach(([n, v], i) => {
                cv.roundRect(x, 104 + i * 40, 26, 26, 7, v.rgb);
                cv.text(n + ': ' + nearest(v.rgb), x + 38, 124 + i * 40, 20, t.text);
            });
            cv.text('Colours: on the Colour tab', x, 214, 18, t.dim);
            if (editing) return editBar(cv, t, x);
            G.button(cv, t, x, 240, 0, 48, 'Original colour', () => { control.carColour(); return redraw(); }, { primary: !control.on(), key: 'car2' });
            status(cv, t, x, 330);
            // over every look, off until switched on: the turn signal's green glow, an open door's red, the hazards' red
            // pulse. Under the other ambient app's warning (4 lines, to y 440) all three side by side, a little lower
            const togs = others.comfort ? [[x, 460, 128, 40, 'Turn glow'], [x + 136, 460, 128, 40, 'Door red'], [x + 272, 460, 128, 40, 'Hazard red']]
                : [[x, 400, 400, 48], [x, 456, 194, 48], [x + 206, 456, 194, 48]];
            [['turnGlow', 'Turn signal glow'], ['doorRed', 'Open door red'], ['hazardRed', 'Hazard red']].forEach(([k, n], i) => {
                const [bx, by, bw, bh, short] = togs[i];
                n = short || n;
                G.button(cv, t, bx, by, bw, bh, n, () => { settings.set(k, settings.get(k) !== true); return redraw(); }, { primary: settings.get(k) === true, key: 'tog-' + k });
            });
            if (!others.comfort && lights.state === 'ours' && S.moves(lights.scene)) cv.text('Обновление: ' + lights.rate.toFixed(0) + ' зап./с · ' + lights.fps.toFixed(1).replace('.', ',') + ' кадр/с', x, 390, 18, t.dim);
        }

        function drawModes(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'By driving mode');
            const mine = control.look(), cur = ambient.mode();
            ambient.modes().forEach((m, i) => {
                const y = 92 + i * 72, ml = control.modeLook(m);
                if (m === cur) cv.roundRect(40, y - 6, 1520, 62, 10, withAlpha(t.accent, 0.14));
                cv.text(MODE_NAMES[m], 60, y + 34, 28, t.text, { font: 'bold' });
                const orig = control.modeOriginal(m);
                if (ml) { cv.roundRect(250, y + 6, 38, 38, 9, ml.upper.rgb); cv.text(nearest(ml.upper.rgb) + (ml.kind !== 'solid' ? ', ' + S.NAMES[ml.kind] : ''), 304, y + 33, 22, t.text); }
                else cv.text(orig ? 'BMW\'s original colour' : 'The Colour tab\'s colour', 250, y + 33, 22, t.dim);
                // any colour: the Colour and Animations tabs change this mode's look
                G.button(cv, t, 760, y + 1, 250, 48, 'Choose colour', () => { editing = m; page = 0; return redraw(); }, { primary: !!ml, key: m + '-any' });
                // the animation, one tap each: Solid, Breathing, Rainbow, Smooth fade, Colour wave
                const kind = ml ? ml.kind : 'solid', next = S.KINDS[(S.KINDS.indexOf(kind) + 1) % S.KINDS.length];
                G.button(cv, t, 1026, y + 1, 250, 48, S.NAMES[kind], () => { control.setModeLook(m, Object.assign(ml || mine, { kind: next })); return redraw(); },
                    { primary: !!ml && kind !== 'solid', key: m + '-anim' });
                // Original colour: BMW's colour in this mode; tapped again, the Colour tab's colour back
                G.button(cv, t, 1292, y + 1, 250, 48, 'Original colour', () => { control.setModeLook(m, orig ? null : 'original'); return redraw(); },
                    { primary: orig, key: m + '-orig' });
            });
            cv.text('Nothing chosen: the Colour tab\'s colour. Tap Original colour again to undo it.', 60, 412, 18, t.dim);
            const tog = (key, label, x) => x + 16 + G.button(cv, t, x, 440, 0, 48, label, () => { settings.set(key, !settings.get(key)); return redraw(); },
                { primary: ON_BY_DEFAULT.indexOf(key) >= 0 ? settings.get(key) !== false : !!settings.get(key), key: 'tog-' + key });
            let x = 60;
            x = tog('follow', settings.get('follow') !== false ? 'Following driving mode' : 'Not following', x);
            x = tog('welcome', 'Welcome sweep at start', x);
            x = tog('sportPulse', 'Sport pulse', x);
            tog('flashAlerts', 'Redline shift flash', x);
        }

        function drawFavs(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Favourites');
            const favs = control.favs(), mine = JSON.stringify(look());
            for (let i = 0; i < 6; i++) {
                const x = 44 + (i % 3) * 512, y = 92 + Math.floor(i / 3) * 206, f = favs[i];
                const on = f && control.on() && JSON.stringify(f) === mine;
                cv.roundRect(x, y, 492, 190, 16, on ? withAlpha(t.accent, 0.22) : withAlpha('#ffffff', 0.06));
                if (!f) {
                    cv.text('Empty', x + 246, y + 86, 26, t.dim, { align: 'center', font: 'bold' });
                    cv.text('Tap to save the look on now', x + 246, y + 118, 20, t.dim, { align: 'center' });
                    if (cv.target) cv.target(x, y, 492, 190, () => { control.saveFav(); return redraw(); }, 'fav-' + i);
                    continue;
                }
                cv.roundRect(x + 24, y + 24, 120, 66, 14, f.upper.rgb);
                cv.roundRect(x + 24, y + 98, 120, 66, 14, f.lower.rgb);
                cv.text(nearest(f.upper.rgb) + (nearest(f.lower.rgb) !== nearest(f.upper.rgb) ? ' / ' + nearest(f.lower.rgb) : ''), x + 166, y + 60, 26, t.text, { font: 'bold' });
                cv.text(S.NAMES[f.kind] + ', ' + f.upper.bright + '%', x + 166, y + 94, 20, t.dim);
                if (cv.target) cv.target(x, y, 340, 190, () => { control.useFav(i); return redraw(); }, 'fav-' + i);
                G.button(cv, t, x + 360, y + 130, 116, 44, 'Delete', () => { control.dropFav(i); return redraw(); }, { key: 'del-' + i, confirm: true });
            }
        }

        const redrawStudio = () => { dirty = true; return render(); };
        const drawStudio = lightStudio(ctx, control, lights, redrawStudio, (i) => {
            drawStudio.leave();
            page = i;
        }, { stock: () => ambient.available, conflict: () => !!others.comfort, activate: active });

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            [drawColour, drawAnimations, drawModes, drawFavs, drawStudio][page](cv, t);
            G.frame(cv, t, TABS, (page + 1) % TABS.length, []);
            dirty = false;
            await ui.image('MAIN_GFX', cv);
        }
        let movedAt = 0;
        const tick = () => {
            const moving = (lights.scene && S.moves(lights.scene)) || (page === 1 && control.on() && S.moves(look()));
            const studioMoving = page === 4 && drawStudio.moving();
            const due = (moving && page <= 1 || studioMoving) &&
                Date.now() - movedAt >= (studioMoving ? 125 : MOVE_DRAW_MS);
            if (due) movedAt = Date.now();
            return dirty || due ? render() : null;
        };

        // the colour ring and the brightness dial under a finger (Colour tab): 'ring' or 'dial', else null
        const ringAt = (x, y) => { const dx = x - RING.cx, dy = y - RING.cy, d = Math.sqrt(dx * dx + dy * dy); return d >= RING.r - 12 && d <= RING.R + 12; };
        const dialAt = (x, y) => {
            const ex = x - DIAL.cx, ey = y - DIAL.cy, e = Math.sqrt(ex * ex + ey * ey), a = Math.atan2(ex, -ey) * 180 / Math.PI;
            return e >= DIAL.r - 14 && e <= DIAL.R + 14 && a >= -140 && a <= 140;
        };
        const hueAt = (x, y) => S.snapHue((Math.atan2(x - RING.cx, -(y - RING.cy)) * 180 / Math.PI + 360) % 360);
        const brightAt = (x, y) => (Math.max(-135, Math.min(135, Math.atan2(x - DIAL.cx, -(y - DIAL.cy)) * 180 / Math.PI)) + 135) / 270 * 100;
        // a finger on the ring or the dial: the colour or the brightness follows it while it moves, sent to the lights at
        // most every DRAG_MS and once more where it lets go (a tap: there at once)
        const DRAG_MS = 120;
        let drag = null;                                    // { what: 'ring' | 'dial', at, x, y, timer }
        const dragApply = () => {
            if (!drag) return null;
            drag.at = Date.now(); clearTimeout(drag.timer); drag.timer = null;
            return drag.what === 'ring' ? setRgb(S.hsv(hueAt(drag.x, drag.y), 1, 1)) : setBright(brightAt(drag.x, drag.y));
        };
        if (ctx.onTouch) {
            ctx.onTouch((phase, x, y) => {
                if (phase === 1) {
                    drag = null;
                    if (page !== 0) return false;
                    const what = ringAt(x, y) ? 'ring' : dialAt(x, y) ? 'dial' : null;
                    if (!what) return false;
                    drag = { what, at: 0, x, y, timer: null };
                    dragApply();
                    return true;
                }
                if (!drag) return false;
                drag.x = x; drag.y = y;
                if (phase === 3) { dragApply(); drag = null; return true; }
                const wait = drag.at + DRAG_MS - Date.now();
                if (wait <= 0) dragApply(); else if (!drag.timer) drag.timer = setTimeout(dragApply, wait);
                return true;
            });
        } else if (ctx.onTap) {
            ctx.onTap((x, y) => {
                if (page !== 0) return null;
                if (ringAt(x, y)) return setRgb(S.hsv(hueAt(x, y), 1, 1));
                if (dialAt(x, y)) return setBright(brightAt(x, y));
                return null;
            });
        }
        ctx.onTab((i) => {
            const next = (i + TABS.length - 1) % TABS.length;
            if (page === 4 && next !== 4) drawStudio.leave();
            page = next;
            if (page >= 2) editing = null;
            return page === 4 ? redrawStudio() : redraw();
        });
        lights.on('change', () => { dirty = true; });
        ambient.on('change', () => { dirty = true; });
        others.on('change', () => { dirty = true; });
        settings.onChange(() => { dirty = true; });
        ctx.onLayout(() => { dirty = true; });
        ctx.loop('MAIN', 8, tick);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
