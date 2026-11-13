// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * Отрисовка canvas-экранов «Только важное».
 */
const G = require('./kit/gauges');

const W = 1600, H = 520;

/** Превью карточки слоя примитивами канвы — работает в обоих путях отрисовки. */
function drawFrame(cv, t, frame, x, y, w, h) {
  const red = frame.color === 'red';
  cv.roundRect(x, y, w, h, 10, red ? [70, 12, 12, 230] : [54, 38, 8, 230]);
  cv.strokeRoundRect(x, y, w, h, 10, 2, red ? t.crit : t.warn);
  cv.text(frame.text, x + w / 2, y + h / 2 + 18, 42, red ? '#ff8a8a' : '#ffe096', { align: 'center', font: 'bold', spacing: 2 });
}

/** d = { enabled, service, targetState, alert, alerts, frame, onToggle, onCheck, threshold } */
function drawMain(cv, t, d) {
  // превью: что сейчас видно на панели приборов / HUD
  const pp = G.panel(cv, t, 24, 44, 760, 300, 'Что показывает слой');
  if (d.frame) {
    drawFrame(cv, t, d.frame, pp.x + 40, pp.y + 90, 640, 128);
    cv.text('Так карточка выглядит поверх ' + (d.target === 'hud' ? 'HUD' : 'приборной панели'), pp.x + 40, pp.y + 250, 20, t.dim);
  } else {
    cv.text(d.enabled ? 'Слой активен, отклонений нет — экран чист' : 'Слой выключен', pp.x + 40, pp.y + 130, 26, t.dim);
    cv.text('В норме приложение ничего не рисует', pp.x + 40, pp.y + 170, 20, t.dim);
  }

  // статус контура
  const sp = G.panel(cv, t, 24, 368, 760, 144, 'Контур');
  const rows = [
    ['Слой отклонений', d.enabled ? 'включён' : 'выключен', d.enabled ? 'ok' : 'dim'],
    ['cluster-render', d.service, d.service === 'готов' ? 'ok' : 'warn'],
    ['Цель', d.targetState, 'dim']
  ];
  rows.forEach(([label, value, color], i) => {
    const y = sp.y + 66 + i * 30;
    cv.text(label, sp.x + 24, y, 20, t.dim);
    cv.text(value, sp.x + sp.w - 24, y, 20, t[color] || color, { align: 'right', font: 'bold' });
  });

  // текущие отклонения
  const ap = G.panel(cv, t, 808, 44, 768, 468, 'Отклонения сейчас');
  const items = [
    ['Аккумулятор 12 В', d.alerts.batteryValue === null ? 'нет данных' : d.alerts.batteryValue + ' %', batteryColor(d.alerts)],
    ['Шины', d.alerts.tyreAlert ? d.alerts.tyreAlert.text : 'в норме', d.alerts.tyreAlert ? 'crit' : 'ok'],
    ['CBS', d.alerts.cbsAlert ? d.alerts.cbsAlert.text : 'в норме', d.alerts.cbsAlert ? 'warn' : 'ok']
  ];
  items.forEach(([label, value, color], i) => {
    const y = ap.y + 90 + i * 62;
    cv.text(label, ap.x + 24, y, 24, t.text);
    G.pill(cv, t, ap.x + ap.w - 260, y - 8, 236, 36, String(value).toUpperCase(), { color, filled: 0.24 });
  });
  cv.text('Порог 12 В: ' + d.threshold + ' %', ap.x + 24, ap.y + 300, 20, t.dim);
  cv.text('Одна карточка по событию; постоянных шкал нет.', ap.x + 24, ap.y + 330, 20, t.dim);

  const by = ap.y + 468 - 60;
  G.button(cv, t, ap.x + 24, by, 240, 44, d.enabled ? 'Выключить слой' : 'Включить слой', d.onToggle, { primary: !d.enabled });
  G.button(cv, t, ap.x + 280, by, 220, 44, 'Проверить', d.onCheck);

}

function batteryColor(alerts) {
  if (alerts.batteryAlert) return 'warn';
  return alerts.batteryValue === null ? 'dim' : 'ok';
}

/** Кадр-заглушка для превью: текст и цвет активного алерта. */
function alertFrame(alert) {
  if (!alert) return null;
  return { text: alert.text, color: alert.color || 'yellow' };
}

module.exports = { W, H, drawMain, alertFrame };
