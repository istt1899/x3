// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * Отрисовка canvas-экранов «X3 ↔ Дом».
 */
const G = require('./kit/gauges');

const W = 1600, H = 520;

/** d = { bridge, telemetry, journal, busy, onArrive, onLeave, onSnapshot } */
function drawMain(cv, t, d) {
  // статус
  const sp = G.panel(cv, t, 24, 44, 520, 180, 'Bridge');
  const bridge = d.bridge;
  const stColor = !bridge ? 'warn' : bridge.paired ? 'ok' : 'accent2';
  const stText = !bridge ? 'НЕ ПОДКЛЮЧЁН' : bridge.paired ? 'НАСТРОЕН' : 'НУЖЕН PAIRING' + (bridge.pairCode ? ' ' + bridge.pairCode : '');
  G.pill(cv, t, sp.x + 24, sp.y + 70, Math.max(200, 40 + stText.length * 13), 38, stText, { color: stColor, filled: 0.26 });
  cv.text(bridge && bridge.paired ? 'Сеть: готова к одной команде' : 'Сеть: подключите телефон к hotspot X3',
    sp.x + 24, sp.y + 140, 20, t.dim);

  // телеметрия (что уйдёт домой)
  const tp = G.panel(cv, t, 24, 248, 520, 264, 'Снимок автомобиля');
  const rows = [
    ['Зажигание', d.telemetry.ignite],
    ['12 В', d.telemetry.battery],
    ['CBS', d.telemetry.service]
  ];
  rows.forEach(([label, value], i) => {
    const y = tp.y + 84 + i * 40;
    cv.text(label, tp.x + 24, y, 22, t.dim);
    cv.text(value === null || value === undefined ? '—' : String(value), tp.x + tp.w - 24, y, 24, t.text, { align: 'right', font: 'bold' });
  });
  cv.text('VIN и координаты исключены.', tp.x + 24, tp.y + 264 - 56, 18, t.dim);

  // сцены
  const cp = G.panel(cv, t, 568, 44, 520, 468, 'Сцены');
  cv.text('Разрешённые сцены Home Assistant.', cp.x + 24, cp.y + 84, 20, t.dim);
  cv.text('Произвольные команды отключены.', cp.x + 24, cp.y + 112, 20, t.dim);
  const by = cp.y + 170;
  G.button(cv, t, cp.x + 40, by, 440, 84, 'Возвращаюсь', d.onArrive, { busy: d.busy, primary: true });
  G.button(cv, t, cp.x + 40, by + 108, 440, 84, 'Выезжаю', d.onLeave, { busy: d.busy, confirm: true, color: t.warn });
  G.button(cv, t, cp.x + 40, by + 216, 440, 56, 'Снимок автомобиля', d.onSnapshot, { busy: d.busy, confirm: true });

  // журнал
  const jp = G.panel(cv, t, 1112, 44, 464, 468, 'Журнал');
  if (!d.journal.length) {
    cv.text('Команд не выполнялось', jp.x + 24, jp.y + 100, 22, t.dim);
  } else {
    d.journal.slice(0, 7).forEach((entry, i) => {
      const y = jp.y + 84 + i * 52;
      const timeText = entry.slice(0, 5);
      const rest = entry.slice(8);
      G.pill(cv, t, jp.x + 24, y - 4, 64, 30, timeText, { color: 'dim', filled: 0.12 });
      cv.text(rest.slice(0, 30), jp.x + 100, y, 20, i === 0 ? t.text : t.dim);
    });
  }
}

function header(cv, t, badges) {
  G.frame(cv, t, ['Дом'], 0, badges || []);
}

module.exports = { W, H, drawMain, header };
