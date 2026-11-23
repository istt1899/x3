// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const trip = require('./trip_view.js');
const camera = require('./view_model.js');

const tabs = [
    ['0', 'Сводка'], ['1', 'GPS'], ['service', 'Сервис'],
    ['2', 'Камера'], ['3', 'Вывод'], ['5', 'База']
];
const missing = '—';
function text(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : missing;
}
function flag(value) {
    return value === true ? 'Вкл.' : value === false ? 'Выкл.' : missing;
}
function measure(value, unit, digits) {
    if (!Number.isFinite(value)) return missing;
    const number = digits === undefined ? String(value) : value.toFixed(digits);
    return number.replace('.', ',') + (unit ? ' ' + unit : '');
}
function cards(page, state, version) {
    const s = state || {}, fix = s.gpsFix || {}, clock = s.clock || {};
    const valid = Number.isFinite(fix.lat) && Math.abs(fix.lat) <= 90 &&
        Number.isFinite(fix.lon) && Math.abs(fix.lon) <= 180;
    const gps = !state ? missing : camera.gpsClockWaiting(clock) ? 'Ожидание часов' :
        clock.issue && clock.issue !== 'NONE' ? 'Проверить время GPS' :
        valid ? 'Координаты приняты' : 'Ожидание координат';
    const service = state ? 'Связь установлена' : 'Нет связи';
    const ride = trip.model(state, version), out = s.outputs || {}, db = s.database || {};
    const count = measure(db.count, ''), countSummary = count === missing ? missing : 'Записей: ' + count;
    const inputs = s.gpsInput || {}, layers = s.rendererDetails || {};
    const regionLabel = typeof db.region === 'string' && db.region ?
        trip.regionName({region:db.region}) : missing;
    switch (page) {
    case '1':
        return [['Позиция GPS', gps], ['Широта / долгота', valid ? measure(fix.lat, '', 5) + ' / ' + measure(fix.lon, '', 5) : missing],
            ['Источник позиции', text(fix.source)], ['Точность', measure(fix.accuracyM, 'м', 1)],
            ['Спутники', measure(fix.satellites, '')], ['Возраст пакета', measure(inputs.lastPacketAgeMs, 'мс')]];
    case 'service':
        return [['Сервис камер', service], ['Версия сервиса', text(s.serviceVersion)], ['Версия приложения', text(version)],
            ['Предупреждения', flag(s.enabled)], ['Результат команды', text((s.commandResult || {}).message || (s.commandResult || {}).phase)],
            ['Последняя ошибка', text(s.controlError || s.error)]];
    case '2':
        return [['Предупреждение', ride.text.tripCameraStatus], ['Камера', ride.active ? ride.text.tripCameraIdentity : missing],
            ['Дистанция', measure(ride.distance, 'м')], ['Лимит', trip.limitText(trip.approachLimit(ride.active ? s.alert : null)).replace(/^Лимит[: ]+/, '')],
            ['Подход', ride.active ? ride.text.tripCameraRoad : missing], ['Основание лимита', ride.active ? ride.text.tripCameraEvidence.replace(/^Основание: /, '') : missing]];
    case '3':
        return [['Проекция HUD', flag(out.hud)], ['Приборная панель', flag(out.cluster)],
            ['Состояние HUD', text((layers.hud || {}).state)], ['Состояние приборов', text((layers.map || {}).state)],
            ['Связь с renderer', text(layers.connection)], ['Тест изображения', s.displayTest && typeof s.displayTest.active === 'boolean' ?
                (s.displayTest.active ? 'Активен' : 'Остановлен') : missing]];
    case '5':
        return [['Регион', regionLabel], ['Версия базы', text(db.version)], ['Записи базы', count],
            ['Источник', text(db.source)], ['Дата базы', text(db.updated || db.generatedAt || db.sourceTimestamp)],
            ['Обновление', text((s.databaseUpdate || {}).message || (s.databaseUpdate || {}).phase)]];
    default:
        return [['GPS', gps], ['Сервис камер', service], ['Камера', ride.text.tripCameraStatus +
            (ride.distance === null ? '' : ' · ' + measure(ride.distance, 'м'))],
            ['Вывод', 'HUD ' + flag(out.hud) + ' · приборы ' + flag(out.cluster)],
            ['База', [regionLabel, countSummary].filter(value => value !== missing).join(' · ') || missing]];
    }
}

function drawCards(cv, rows, top, bottom, colors, words) {
    const gap = 12, columns = 3, width = (1552 - 2 * gap) / columns;
    const height = (bottom - top - gap) / 2;
    rows.forEach((entry, i) => {
        const x = 24 + (i % columns) * (width + gap), y = top + Math.floor(i / columns) * (height + gap);
        cv.roundRect(x, y, width, height, 12, colors.surface);
        words(cv, entry[0], x + 18, y + 32, 23, width - 36, colors.dim);
        const room = width - 36, size = 28;
        const value = String(entry[1]);
        const fits = line => cv.textWidth(line, size, {literal:true, font:'bold'}) <= room;
        if (fits(value)) {
            words(cv, value, x + 18, y + height * .70 + 5, size, room, colors.text, true);
            return;
        }
        // Long service diagnostics remain fully readable in the detailed report.
        const parts = value.split(/\s+/);
        let first = parts.shift();
        while (parts.length && fits(first + ' ' + parts[0])) first += ' ' + parts.shift();
        let second = parts.join(' ');
        if (!fits(first)) {
            second = first + (second ? ' ' + second : '');
            first = '';
            while (second && fits(first + second[0])) { first += second[0]; second = second.slice(1); }
        }
        if (!fits(second)) {
            while (second && !fits(second + '…')) second = second.slice(0, -1);
            second += '…';
        }
        words(cv, first, x + 18, y + height * .58, size, room, colors.text, true);
        words(cv, second, x + 18, y + height * .58 + 32, size, room, colors.text, true);
    });
}
module.exports = {tabs, cards, drawCards};
