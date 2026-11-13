// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * Отрисовка canvas-экранов «Поездки и расходы».
 */
const G = require('./kit/gauges');

const W = 1600, H = 520;
const CAT_COLORS = { 'Не выбрана': 'dim', 'Личное': 'accent', 'Работа': 'accent2', 'Клиент': 'warn' };

function fmtDay(at) {
  return new Date(at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
}

/** d = { current, last, fuel, cost, active, speed, message } */
function drawNow(cv, t, d) {
  const shown = d.current || d.last;
  const lp = G.panel(cv, t, 24, 44, 760, 468, d.current ? 'Текущая поездка' : 'Последняя поездка');
  if (!shown) {
    cv.text('Поездок ещё не было', lp.x + 40, lp.y + 150, 30, t.dim);
    cv.text('Поездка определяется сама: движение или работающий двигатель', lp.x + 40, lp.y + 196, 20, t.dim);
    cv.text('Завершение — 10 минут без движения', lp.x + 40, lp.y + 226, 20, t.dim);
  } else {
    G.readout(cv, t, lp.x + 30, lp.y + 80, { label: 'Пробег', value: shown.km, decimals: 1, unit: 'км', size: 76 });
    G.readout(cv, t, lp.x + 330, lp.y + 80, { label: 'В пути', text: fmtDur((shown.end || Date.now()) - shown.start), size: 40 });
    G.readout(cv, t, lp.x + 570, lp.y + 80, { label: 'Макс. скорость', value: shown.vmax, decimals: 0, unit: 'км/ч', size: 40 });
    const fy = lp.y + 250;
    G.bar(cv, t, lp.x + 30, fy, 320, 92, { label: 'Топливо', value: d.fuel, decimals: 2, unit: 'л', max: Math.max(10, Math.ceil((d.fuel || 0) * 1.4)), niceMax: true });
    G.readout(cv, t, lp.x + 400, fy + 6, { label: 'Стоимость', value: d.cost, decimals: 0, unit: 'руб', size: 56 });
    G.pill(cv, t, lp.x + 30, lp.y + 468 - 64, 180, 34, 'КАТЕГОРИЯ', { color: 'dim', filled: 0.1 });
    G.pill(cv, t, lp.x + 222, lp.y + 468 - 64, 190, 34, String(shown.category || 'Не выбрана').toUpperCase(), { color: CAT_COLORS[shown.category] || 'accent', filled: 0.26 });
  }

  const rp = G.panel(cv, t, 808, 44, 384, 468, 'Сейчас');
  G.readout(cv, t, rp.x + 24, rp.y + 80, { label: 'Скорость', value: d.speed, decimals: 0, unit: 'км/ч', size: 68 });
  G.pill(cv, t, rp.x + 24, rp.y + 210, d.active ? 170 : 210, 34, d.active ? 'ПОЕЗДКА АКТИВНА' : 'СЕЙЧАС НЕ ЕДЕМ', { color: d.active ? 'ok' : 'dim', filled: 0.26 });
  if (d.message) cv.text(d.message, rp.x + 24, rp.y + 300, 20, t.dim);
  G.button(cv, t, rp.x + 24, rp.y + 468 - 60, 170, 44, 'Завершить', d.onFinish, { busy: !d.current });
  G.button(cv, t, rp.x + 206, rp.y + 468 - 60, 160, 44, 'Категория', d.onCategory, { busy: !shown });

  const tp = G.panel(cv, t, 1216, 44, 384, 468, 'Приватность');
  const lines = ['Журнал хранится только', 'в этом автомобиле.', '', 'Без облака, маршрутов', 'и геолокации.', '', 'CSV: данные приложения,', 'забирается по USB.'];
  lines.forEach((lineText, i) => cv.text(lineText, tp.x + 24, tp.y + 80 + i * 34, 22, t.dim));
}

/** d = { total, days, period, unknownFuel } */
function drawTotals(cv, t, d) {
  const tiles = [
    ['Поездки', d.total.n, '', 0],
    ['Пробег', d.total.km, 'км', 1],
    ['Топливо', d.total.fuel, 'л', 2],
    ['Стоимость', d.total.cost, 'руб', 0]
  ];
  tiles.forEach(([label, value, unit], i) => {
    G.stat(cv, t, 24 + i * 392, 44, 368, 168, { label, value, decimals: unit === 'км' || unit === 'руб' ? 0 : 1, unit, size: 64 });
  });
  const ch = G.panel(cv, t, 24, 236, 1000, 276, 'Километры по дням');
  const keys = Object.keys(d.days || {}).sort().slice(-14);
  const pts = keys.map((key, i) => [i + 1, d.days[key].km]);
  if (pts.length > 1) {
    G.chart(cv, t, ch.x + 16, ch.y + 30, ch.w - 48, ch.h - 76, {
      xMin: 1, xMax: Math.max(2, pts.length), yMin: 0,
      yMax: Math.max(10, Math.ceil(Math.max.apply(null, pts.map((p) => p[1])) * 1.2)),
      series: [{ pts, color: 'accent', fill: 0.14 }], padLeft: 44, yUnit: 'км'
    });
  } else {
    cv.text('Мало данных: нужно минимум два дня с поездками', ch.x + 40, ch.y + 140, 22, t.dim);
  }
  const rp = G.panel(cv, t, 1048, 236, 552, 276, 'Допущения');
  const rows = [
    ['Период итогов', d.periodLabel],
    ['Без данных о топливе', d.total.unknownFuel + ' поездок'],
    ['Цена топлива', d.price + ' руб/л'],
    ['Источник пробега', 'штатный спидометр']
  ];
  rows.forEach(([label, value], i) => {
    const y = rp.y + 80 + i * 46;
    cv.text(label, rp.x + 24, y, 20, t.dim);
    cv.text(String(value), rp.x + rp.w - 24, y, 22, t.text, { align: 'right', font: 'bold' });
  });
}

/** items — список поездок, selectedIndex; callbacks */
function drawJournal(cv, t, items, onCategory) {
  const jp = G.panel(cv, t, 24, 44, 1552, 468, 'Журнал поездок');
  const cols = [
    { label: 'Начало', w: 170 },
    { label: 'Пробег', w: 130, align: 'right' },
    { label: 'Топливо', w: 120, align: 'right' },
    { label: 'Стоимость', w: 140, align: 'right' },
    { label: 'Категория', w: 200 }
  ];
  const rows = items.slice(-8).reverse().map((trip) => [
    fmtDay(trip.start),
    trip.km.toFixed(1) + ' км',
    trip.fuel === null ? '—' : trip.fuel.toFixed(2) + ' л',
    trip.cost === null ? '—' : Math.round(trip.cost) + ' руб',
    { text: String(trip.category).toUpperCase(), color: CAT_COLORS[trip.category] || 'accent' }
  ]);
  G.table(cv, t, jp.x + 20, jp.y + 28, jp.w - 40, cols, rows, { rowH: 48, size: 22, headerSize: 16, empty: 'Журнал пуст' });
  G.button(cv, t, jp.x + jp.w - 240, jp.y + jp.h - 60, 220, 44, 'Сменить категорию', onCategory, { busy: !items.length });
}

function header(cv, t, page, badges) {
  G.frame(cv, t, ['Сейчас', 'Итоги', 'Журнал'], page, badges || []);
}

module.exports = { W, H, drawNow, drawTotals, drawJournal, header, CAT_COLORS, fmtDay };
