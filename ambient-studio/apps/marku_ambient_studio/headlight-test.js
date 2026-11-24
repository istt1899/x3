'use strict';

const { flashLengths } = require('./headlight-preview');

// The BDC's own timed high-beam test, as used by Ambient Config 2.7.17.
// Each pulse expires in the controller, including if iDrive closes or loses transport.
const BDC = 0x40;
const LIGHT_FUNCTION = [0xD5, 0x42];
const HIGH_BEAM = 0x05;
const PULSES = 3;
const INTERVAL_MS = 1000;
const FRESH_MS = 2500;
const REST_MS = 10000;

function headlightTest({ diag, hold, available, log, now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    let speed, speedAt, operation = null, nextStart = 0;
    const gears = new Map();
    let note = '';
    const fresh = (at) => now() >= at && now() - at <= FRESH_MS;
    function blocked() {
        const why = available();
        if (why) return why;
        const current = Array.from(gears.values()).filter((value) => fresh(value.at));
        if ((fresh(speedAt) && speed > 0) || current.some((value) => value.stage && value.stage !== 'P')) {
            return 'Остановите BMW и переведите селектор в P';
        }
        if (!fresh(speedAt) || speed !== 0 || !current.some((value) => value.stage === 'P')) {
            return 'Ожидаю скорость и положение селектора';
        }
        return '';
    }
    const stop = () => { if (operation) operation.cancel = true; };
    function updateSpeed(raw) {
        speed = Number.isInteger(raw) && raw >= 0 && raw < 65535 ? raw : null;
        speedAt = now();
        if (speed !== 0) stop();
    }
    function updateGear(source, stage) {
        gears.set(source, { stage, at: now() });
        if (blocked()) stop();
    }
    async function request(sid, data, prefix) {
        const matches = (reply) => prefix.every((byte, i) => reply[i] === byte);
        const reply = await diag.physical(BDC, sid, data, 650, (bytes) =>
            matches(bytes) || (bytes[0] === 0x7F && bytes[1] === sid),
        { hardTimeoutMs: 900, pendingTimeoutMs: 650, maxRetries: 0 });
        if (!reply || !matches(reply)) {
            const reason = reply && reply[2] != null ? 'NRC ' + reply[2].toString(16).toUpperCase() : 'нет ответа';
            throw new Error(reason);
        }
    }
    async function start(flashMs) {
        if (operation || blocked() || now() < nextStart) return;
        const run = { cancel: false };
        operation = run;
        let sessionAttempted = false, failed = false, pulses = 0;
        const cancelled = () => run.cancel || !!blocked();
        const pulseWidth = flashLengths.includes(flashMs) ? flashMs : 80;
        note = 'Подключение к блоку фар…';
        try {
            await hold(true);
            if (cancelled()) return;
            sessionAttempted = true;
            await request(0x10, [0x03], [0x50, 0x03]);
            if (cancelled()) return;
            await request(0x22, LIGHT_FUNCTION, [0x62].concat(LIGHT_FUNCTION));
            for (let i = 0; i < PULSES && !cancelled(); i++) {
                await request(0x2E, LIGHT_FUNCTION.concat([0, HIGH_BEAM, 0, pulseWidth / 10]), [0x6E].concat(LIGHT_FUNCTION));
                pulses++;
                note = 'Блок BMW принял импульс ' + pulses + ' из ' + PULSES;
                await wait(i + 1 < PULSES ? INTERVAL_MS : pulseWidth);
            }
        } catch (error) {
            failed = true;
            note = 'Блок BMW отклонил тест · ' + error.message;
            log.warn('headlight test: ' + error.message);
        } finally {
            if (sessionAttempted) {
                try { await request(0x10, [0x01], [0x50, 0x01]); }
                catch (error) { note = 'Выход из диагностики не подтверждён'; failed = true; log.warn('headlight test cleanup: ' + error.message); }
            }
            try { await hold(false); }
            catch (error) { note = 'Не удалось возобновить подсветку салона'; failed = true; log.warn('headlight test resume: ' + error.message); }
            if (!failed) note = pulses === PULSES && !run.cancel ? 'Тест завершён · проверьте фары снаружи' : 'Тест остановлен';
            if (sessionAttempted) nextStart = now() + REST_MS;
            operation = null;
        }
    }
    return {
        updateSpeed, updateGear, start, stop,
        status: () => ({ busy: !!operation, note, blocked: blocked() || (now() < nextStart ? 'Повтор через ' + Math.ceil((nextStart - now()) / 1000) + ' с' : '') }),
    };
}

module.exports = { headlightTest };
