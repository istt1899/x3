'use strict';

const { flashLengths, intervals } = require('./headlight-preview');
const { replyTo } = require('./kit/diag');

// BDC lamp functions and output control from MIT-licensed Ambient Config 2.8.4.
// https://github.com/cauliflowermossgrape/idrive7-apps/blob/23e128fc4c92d7803ba6daf32ef7c543de31a1d7/apps/ambient_config/strobe.js
const BDC = 0x40;
const FN = [0xD5, 0x42];
const OUTPUTS = [
    { status: [0x45, 0x00], control: [0x45, 0x01] },
    { status: [0xE3, 0xB9], control: [0xE3, 0xB5] },
];
const HIGH = 0x05;
const FOG = 0x08;
const BEAMS = [0x07, 0x08];
const FRESH_MS = 2500;
const RUN_MS = 8000;
const REST_MS = 10000;
const STOPPED = new Error('stopped');
const FINISHED = new Error('finished');
const park = 'Остановите BMW и переведите селектор в P';

function headlightTest({ diag, hold, available, log, now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    let speed, speedAt, operation = null, nextStart = 0;
    let note = '', fault = false;
    const gears = new Map();

    function blocked() {
        const gate = available();
        if (gate) return gate;
        const stages = Array.from(gears.values());
        const freshSpeed = now() >= speedAt && now() - speedAt <= FRESH_MS;
        if ((freshSpeed && speed > 0) || stages.some((stage) => stage !== 'P')) return park;
        return freshSpeed && speed === 0 && stages.includes('P') ? '' : 'Ожидаю скорость и положение селектора';
    }

    function stop(reason) {
        if (operation && !operation.reason) operation.reason = reason || 'По команде водителя';
    }

    function stopIfBlocked() {
        const reason = blocked();
        if (reason) stop(reason);
    }

    function updateSpeed(raw, sampledAt = now()) {
        speed = Number.isInteger(raw) && raw >= 0 && raw < 65535 ? raw : null;
        speedAt = sampledAt;
        if (speed !== 0) gears.clear();
        stopIfBlocked();
    }

    function updateGear(source, stage) {
        if (['P', 'R', 'N', 'D'].includes(stage) && !(stage === 'P' && speed > 0)) gears.set(source, stage);
        else gears.delete(source);
        stopIfBlocked();
    }

    const clearGear = () => { gears.clear(); stopIfBlocked(); };

    function check(run) {
        stopIfBlocked();
        if (run.reason) throw STOPPED;
        if (run.until && now() >= run.until) throw FINISHED;
    }

    async function request(sid, data, run) {
        const accept = replyTo(sid, data);
        const reply = await diag.physical(BDC, sid, data, 650, accept,
            {
                hardTimeoutMs: 900, pendingTimeoutMs: 650, callTimeoutMs: 1000, maxRetries: 0,
                beforeSend: run ? () => check(run) : undefined,
            });
        return reply && accept(reply) ? reply : null;
    }

    const accepted = (reply, sid) => reply && reply[0] === sid + 0x40;

    async function command(sid, data, run) {
        const reply = await request(sid, data, run);
        if (!accepted(reply, sid)) {
            const reason = reply && Number.isInteger(reply[2]) ? 'NRC ' + reply[2].toString(16).toUpperCase() : 'нет ответа';
            throw new Error(reason);
        }
        return reply;
    }

    async function hasTimedFunction(run) {
        for (let attempt = 0; attempt < 6; attempt++) {
            check(run);
            let reply;
            try { reply = await request(0x22, FN); }
            catch (error) {
                if (!/TEMPORARILY_NOT_ACCEPTED|BUSY/i.test(error.message)) throw error;
            }
            if (accepted(reply, 0x22)) return true;
            if (reply && [0x11, 0x12, 0x31].includes(reply[2])) return false;
            if (attempt < 5) await wait(750);
        }
        throw new Error('блок временных вспышек не ответил');
    }

    async function probe(run, program) {
        if (program.mode !== 1 && await hasTimedFunction(run)) return { timed: true };
        if (program.fog) return null;
        for (const output of OUTPUTS) {
            check(run);
            const reply = await request(0x22, output.status);
            if (accepted(reply, 0x22) && reply.length > 3 + BEAMS[1]) return output;
        }
        return null;
    }

    const timed = (lamp, ticks, run) => command(0x2E, FN.concat([0, lamp, 0, ticks]), run);
    const setBeam = (path, beam, on, run) => command(0x2F, path.control.concat([3, beam, Number(on)]), run);
    const releaseBeam = (path, beam) => command(0x2F, path.control.concat([0, beam, 0]));

    async function waitActive(run, until) {
        while (now() < until) {
            check(run);
            await wait(Math.min(50, until - now()));
        }
        check(run);
    }

    async function flash(run, path, program) {
        if (!path.timed) {
            check(run);
            const status = await command(0x22, path.status);
            if (!BEAMS.every((lamp) => status[3 + lamp] === 0)) throw new Error('выключите дальний свет и повторите');
        }
        const started = now();
        run.until = started + RUN_MS;
        for (let step = 0; ; step++) {
            const at = now();
            check(run);
            const active = path.timed ? [HIGH] : program.mode === 1 ? [BEAMS[step % 2]] : BEAMS;
            if (path.timed && program.fog) active[0] = step % 2 ? FOG : HIGH;
            for (const lamp of active) {
                check(run);
                run.used.add(lamp);
                if (path.timed) await timed(lamp, program.flashMs / 10, run);
                else await setBeam(path, lamp, true, run);
                run.flashed = true;
            }
            if (!path.timed && step === 0) {
                check(run);
                const status = await command(0x22, path.status);
                if (!BEAMS.every((lamp) => status[3 + lamp] === Number(active.includes(lamp)))) {
                    throw new Error('фары не подтвердили выбранный режим');
                }
            }
            note = 'Блок BMW принимает команды · ' + Math.max(1, Math.ceil((RUN_MS - (now() - started)) / 1000)) + ' с';
            if (!path.timed) {
                await waitActive(run, at + program.flashMs);
                for (const lamp of active) await setBeam(path, lamp, false);
            }
            const pause = program.mode === 2 && (step + 1) % program.burst === 0 ? 650 : 0;
            await waitActive(run, Math.min(at + program.every + pause, started + RUN_MS));
        }
    }

    async function start(options = {}) {
        if (operation || blocked() || now() < nextStart || options.mode === 3) return;
        const program = {
            mode: [0, 1, 2].includes(options.mode) ? options.mode : 0,
            flashMs: flashLengths.includes(options.flashMs) ? options.flashMs : 80,
            every: intervals.includes(options.every) ? options.every : 500,
            burst: [1, 2, 3].includes(options.burst) ? options.burst : 2,
            fog: options.fog === true && options.mode === 0,
        };
        const run = { reason: '', used: new Set() };
        operation = run;
        note = 'Определяю блок фар BMW…';
        fault = false;
        let path, sessionAttempted = false;
        try {
            await hold(true);
            path = await probe(run, program);
            check(run);
            if (!path) {
                note = program.fog ? 'Для этой BMW выберите дальний свет' : program.mode === 1 ?
                    'Раздельное управление недоступно · попробуйте «Вместе»' : 'Поддерживаемый блок фар не ответил';
                fault = true;
                return;
            }
            note = 'Подключаюсь к блоку фар BMW…';
            sessionAttempted = true;
            await command(0x10, [3], run);
            await flash(run, path, program);
        } catch (error) {
            if (error === FINISHED && run.flashed) note = 'Цикл фар завершён';
            else if (error === STOPPED) note = 'Фары остановлены · ' + run.reason;
            else {
                fault = true;
                const reason = error === FINISHED ? 'истекло время ожидания блока' : error.message;
                note = 'Цикл фар прерван · ' + reason;
                log.warn('strobe: ' + reason);
            }
        } finally {
            let cleanupFailed = false;
            const clean = async (fn) => {
                try { await fn(); }
                catch (error) { cleanupFailed = true; log.warn('strobe cleanup: ' + error.message); }
            };
            if (sessionAttempted) {
                for (const lamp of run.used) {
                    if (path.timed) await clean(() => timed(lamp, 0));
                    else {
                        await clean(() => setBeam(path, lamp, false));
                        await clean(() => releaseBeam(path, lamp));
                    }
                }
                await clean(() => command(0x10, [1]));
                nextStart = now() + REST_MS;
            }
            await clean(() => hold(false));
            if (cleanupFailed) { note = 'Возврат управления BMW не подтверждён'; fault = true; }
            operation = null;
        }
    }

    return {
        updateSpeed, updateGear, clearGear, start, stop,
        status: () => ({
            busy: !!operation, stopping: !!(operation && operation.reason), note, fault,
            blocked: blocked() || (now() < nextStart ? 'Повтор через ' + Math.ceil((nextStart - now()) / 1000) + ' с' : ''),
        }),
    };
}

module.exports = { headlightTest };
