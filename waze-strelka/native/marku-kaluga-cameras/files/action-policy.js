'use strict';
// One server-owned policy for the UI and command handler. Position accuracy is
// relevant to road matching, not to a stationary renderer check.
function motionStatus(fix, now, motionFixes) {
    const candidates = Array.isArray(motionFixes) ? motionFixes : [fix];
    const sources = candidates.filter(item => {
        const time = item && (Number.isFinite(item.motionTimeMs) ? item.motionTimeMs : item.timeMs);
        return Number.isFinite(time) && now - time <= 3000 && time <= now + 500;
    }).map(item => ({ source: item.source || 'unknown', speedKmh: Number.isFinite(item.speedKmh) && item.speedKmh >= 0 ? item.speedKmh : null,
        motionTimeMs: Number.isFinite(item.motionTimeMs) ? item.motionTimeMs : item.timeMs }));
    const known = sources.filter(item => item.speedKmh !== null);
    const moving = known.find(item => item.speedKmh > 1), stopped = known.find(item => item.speedKmh <= 1);
    const selectedTime = fix && (Number.isFinite(fix.motionTimeMs) ? fix.motionTimeMs : fix.timeMs);
    const newerSelectedSource = known.find(item => fix && item.source === fix.source &&
        Number.isFinite(selectedTime) && item.motionTimeMs > selectedTime);
    // An older complete position may remain usable while a new NMEA epoch
    // assembles. Its old stopped/moving speed must not drive road warnings
    // after that same source reports the opposite motion class.
    const roadMismatch = !!(newerSelectedSource && Number.isFinite(fix.speedKmh) && fix.speedKmh >= 0 &&
        (newerSelectedSource.speedKmh > 1) !== (fix.speedKmh > 1));
    return { state: moving && stopped ? 'conflict' : moving ? 'moving' : stopped ? 'stopped' : 'unknown',
        conflict: !!(moving && stopped), roadMismatch, speedKmh: moving ? moving.speedKmh : stopped ? stopped.speedKmh : null, sources };
}
function stationary(fix, now, motionFixes) {
    const motion = motionStatus(fix, now, motionFixes);
    if (motion.conflict) return { allowed: false, code: 'MOTION_CONFLICT', reason: 'Источники скорости расходятся; тест недоступен до согласованных измерений' };
    if (motion.state === 'unknown')
        return { allowed: false, code: 'STATIONARY_UNKNOWN', reason: 'Для теста остановитесь и дождитесь свежего измерения скорости' };
    if (motion.state === 'moving') return { allowed: false, code: 'MOVING', reason: 'Для теста остановитесь: скорость ' + motion.speedKmh.toFixed(1) + ' км/ч' };
    return { allowed: true, code: 'READY', reason: 'Свежая скорость не выше 1 км/ч' };
}
function policies(state, fix, now, motionFixes) {
    const stop = stationary(fix, now, motionFixes), caps = state.capabilities || {}, outputs = state.outputs || {};
    const no = (code, reason) => ({ allowed: false, code, reason });
    const test = !caps.displayTest ? no('DISPLAY_UNAVAILABLE', 'Вывод уведомлений недоступен') :
        !stop.allowed ? stop : !outputs.cluster && !outputs.hud ? no('OUTPUTS_OFF', 'Для теста включите приборы или HUD') : stop;
    const update = state.databaseUpdate || {};
    const check = !caps.update ? no('UPDATE_UNAVAILABLE', 'Обновление базы недоступно') : update.busy ? no('UPDATE_BUSY', 'Проверка базы уже выполняется') :
        state.storage && !state.storage.persistent ? no('STORAGE_UNAVAILABLE', 'Хранилище недоступно; новая база не может быть сохранена') : { allowed: true, code: 'READY', reason: 'Проверить опубликованный источник базы' };
    const move = !stop.allowed ? stop : !state.displayTest || !state.displayTest.active ? no('PREVIEW_REQUIRED', 'Для перемещения включите тест выбранного экрана') :
        !state.rendererDetails || state.rendererDetails.connection !== 'ready' ? no('RENDERER_NOT_READY', 'Дождитесь подключения выбранного экрана') : stop;
    return { displayTest: test, calibrationTest: test, cardLayout: stop, cardMove: move,
        displayTestStop: { allowed: true, code: 'READY', reason: 'Скрыть тест и сохранить настройки' },
        audioTest: state.audio && state.audio.available ? stop : no('AUDIO_UNAVAILABLE', state.audio && state.audio.reason || 'Безопасный канал звуковых уведомлений не подтверждён'),
        databaseCheck: check,
        databaseRollback: check.allowed && update.canRollback ? { allowed: true, code: 'READY', reason: 'Вернуть предыдущую проверенную базу' } : no('ROLLBACK_UNAVAILABLE', update.busy ? 'Дождитесь завершения проверки базы' : 'Предыдущая версия базы недоступна'),
        diagnosticExport: { allowed: true, code: 'READY', reason: 'Сохранить локальный отчёт по отдельному действию' } };
}
module.exports = { motionStatus, stationary, policies };
