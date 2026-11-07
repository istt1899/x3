'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Authoritative shared source lives in the daemon, never in a per-app setting.
function attachNetwork(ctx, ctl, onSourceChanged) {
    const ui = ctx.ui;
    let source = null, busy = false, error = '';
    const names = { external: 'Внешнее подключение MGU Store', builtin: 'Встроенное соединение BMW' };
    function send(message) {
        if (!ctl.send(message)) ui.text('NET_ERROR', 'Нет связи с MGU Video service');
    }
    function row(label, value, fallback) {
        if (!value) return label + ': ' + fallback;
        if (!value.ok) return label + ': ' + (value.message || 'недоступен');
        const speed = typeof value.downloadMbps === 'number' ? value.downloadMbps.toFixed(1) + ' Мбит/с' : 'доступен';
        const service = { youtube: 'YouTube', vk: 'VK Видео', rutube: 'RUTUBE' }[value.provider] || 'сервис';
        return label + ': ' + speed + (typeof value.latencyMs === 'number' ? ', HTTPS ' + value.latencyMs + ' мс' : '') +
            (value.shortSample && value.speedTested ? ' (короткий замер)' : '') +
            (value.serviceAvailable ? ', ' + service + ' доступен' : ', ' + service + ' недоступен');
    }
    function update(state) {
        const wasBusy = busy;
        let changed = false;
        if (names[state.source]) {
            changed = source !== null && source !== state.source;
            source = state.source;
        }
        busy = !!state.busy;
        if (!busy && (changed || wasBusy) && onSourceChanged) onSourceChanged(source);
        if (state.error) error = String(state.error).slice(0, 300);
        const r = state.results || {};
        ui.text('NET_CURRENT', 'Источник: ' + (names[source] || 'неизвестен') + (busy ? ' — проверяем…' : ''));
        ui.text('NET_EXTERNAL', state.testing === 'external' ? 'Внешний: проверяем…' : row('Внешний', r.external, 'ещё не проверен'));
        ui.text('NET_BUILTIN', state.testing === 'builtin' ? 'BMW: проверяем…' : row('BMW', r.builtin, 'нужна первичная проверка MGU'));
        let comparison = 'Загрузка без прокси; доступ к выбранному видеосервису проверяется отдельно.';
        const a = r.external, b = r.builtin;
        if (a && b && a.ok && b.ok && a.speedTested && b.speedTested && !a.shortSample && !b.shortSample) {
            const faster = a.downloadMbps > b.downloadMbps ? a : b, slower = faster === a ? b : a;
            comparison = faster.downloadMbps > slower.downloadMbps * 1.2
                ? 'В этом замере быстрее: ' + names[faster.source] + '. Выбор вручную.'
                : 'Скорости близки. Повторите замер для сравнения.';
        } else if (a && b && (!a.ok || !b.ok)) comparison = 'Недоступные каналы не участвуют в сравнении скорости.';
        ui.text('NET_WINNER', comparison);
        ui.text('NET_ERROR', error);
    }
    function action(message) {
        if (busy && message.cmd !== 'network_cancel') return;
        error = ''; ui.text('NET_ERROR', ''); send(message);
    }
    const open = () => { send({ cmd: 'network_status' }); ui.open('NETWORK'); };
    ui.onClick('BTN_NETWORK', open);
    ui.onClick('BTN_NET_EXTERNAL', () => action({ cmd: 'network_set', source: 'external' }));
    ui.onClick('BTN_NET_BUILTIN', () => action({ cmd: 'network_set', source: 'builtin' }));
    ui.onClick('BTN_NET_TEST', () => action({ cmd: 'network_test' }));
    ui.onClick('BTN_NET_CANCEL', () => action({ cmd: 'network_cancel' }));
    ui.onClick('BTN_NET_BACK', () => { if (busy) send({ cmd: 'network_cancel' }); ui.open('VIEW'); });
    ctl.on('up', () => send({ cmd: 'network_status' }));
    ctl.on('down', () => { busy = false; ui.text('NET_ERROR', 'Нет связи с MGU Video service'); });
    ctl.on('msg', (message) => { if (message && message.ev === 'network') update(message); });
    return { open };
}
module.exports = { attachNetwork };
