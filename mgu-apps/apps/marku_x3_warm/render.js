// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * Отрисовка canvas-экранов «Тёплый старт».
 */
const G = require('./kit/gauges');

const W = 1600, H = 520;
const ENGINE_LABEL = { off: 'Заглушен', starting: 'Запускается', running: 'Работает' };

function engineColor(state) {
  return state === 'running' ? 'ok' : state === 'starting' ? 'warn' : 'dim';
}

/** d = { oil, coolant, outside, estimate, advice, engine, readyPct } */
function drawWarm(cv, t, d) {
  // масло: радиальный прибор, диапазон −40…160 °C, красная зона до +10
  G.radial(cv, t, 236, 262, 168, {
    label: 'Масло', unit: '°C', value: d.oil, decimals: 0, min: -40, max: 160, ticks: 10, majorEvery: 2,
    zones: [{ from: -40, to: 60, color: 'cold', tintOnly: true }],
    tickDiv: 1
  });
  // ОЖ
  G.radial(cv, t, 612, 262, 168, {
    label: 'ОЖ', unit: '°C', value: d.coolant, decimals: 0, min: -40, max: 160, ticks: 10, majorEvery: 2,
    zones: [{ from: -40, to: 70, color: 'cold', tintOnly: true }]
  });

  // готовность: кольцо прогресса к рабочей температуре
  const rp = G.panel(cv, t, 888, 44, 320, 468, 'Готовность');
  G.ring(cv, t, 1048, 250, 118, {
    value: d.readyPct, min: 0, max: 100, decimals: 0, unit: '%',
    label: 'к рабочей температуре', color: d.readyPct >= 100 ? 'ok' : 'accent'
  });
  const est = d.estimate || { known: false };
  if (!est.known) {
    cv.text('Нет данных температуры', rp.x + 30, rp.y + 420, 20, t.dim);
  } else if (est.ready) {
    G.pill(cv, t, rp.x + 74, rp.y + 400, 172, 34, 'РАБОЧИЙ ДИАПАЗОН', { color: 'ok', filled: 0.28 });
  } else if (est.calculated) {
    G.readout(cv, t, rp.x + 160, rp.y + 388, { label: 'Осталось', text: '~ ' + est.minutes + ' мин', size: 32, align: 'center' });
  } else {
    G.readout(cv, t, rp.x + 160, rp.y + 388, { label: 'Осталось', text: est.range[0] + '–' + est.range[1] + ' мин', size: 30, align: 'center' });
  }

  // климат и статус
  const cp = G.panel(cv, t, 1232, 44, 344, 468, 'Климат');
  G.readout(cv, t, cp.x + 24, cp.y + 66, { label: 'Наружная', value: d.outside, decimals: 1, unit: '°C', size: 56 });
  const advice = d.advice || { level: 0, text: 'Нет данных наружной температуры' };
  if (advice.level > 0) {
    cv.text('РЕКОМЕНДАЦИЯ', cp.x + 24, cp.y + 190, 18, t.dim, { font: 'bold', spacing: 2 });
    cv.text('сиденье ' + advice.level + (advice.level >= 2 ? ', руль 1' : ''), cp.x + 24, cp.y + 232, 24, t.text);
    cv.text('штатными кнопками BMW', cp.x + 24, cp.y + 266, 20, t.dim);
    G.pill(cv, t, cp.x + 24, cp.y + 304, 120 + advice.level * 40, 32, 'УРОВЕНЬ ' + advice.level, { color: advice.level >= 3 ? 'crit' : advice.level === 2 ? 'warn' : 'accent2', filled: 0.24 });
  } else {
    cv.text(advice.text, cp.x + 24, cp.y + 210, 22, t.dim);
  }
  cv.text('Запись в климатический блок', cp.x + 24, cp.y + 356, 20, t.dim);
  cv.text('не выполняется', cp.x + 24, cp.y + 384, 20, t.dim);
  const stY = cp.y + 468 - 56;
  G.pill(cv, t, cp.x + 24, stY, 150, 34, 'ДВИГАТЕЛЬ', { color: 'dim', filled: 0.1 });
  G.pill(cv, t, cp.x + 184, stY, 136, 34, (ENGINE_LABEL[d.engine] || 'НЕТ ДАННЫХ').toUpperCase(), { color: engineColor(d.engine), filled: 0.28 });
}

/** records — [{ at, minutes }] */
function drawHistory(cv, t, records) {
  const sh = G.panel(cv, t, 24, 44, 720, 468, 'Длительность прогревов, мин');
  const pts = (records || []).map((r, i) => [i + 1, r.minutes]);
  if (pts.length > 1) {
    const max = Math.max.apply(null, pts.map((p) => p[1]));
    G.chart(cv, t, sh.x + 16, sh.y + 40, sh.w - 48, sh.h - 110, {
      xMin: 1, xMax: Math.max(2, pts.length), yMin: 0, yMax: Math.max(5, Math.ceil(max * 1.2)),
      series: [{ pts, color: 'accent', fill: 0.14 }], padLeft: 40, yUnit: 'мин'
    });
  } else {
    cv.text('Мало записей для графика', sh.x + 40, sh.y + 180, 26, t.dim);
    cv.text('Записи появляются после прогревов', sh.x + 40, sh.y + 218, 22, t.dim);
  }
  const total = (records || []).reduce((a, r) => a + r.minutes, 0);
  const stat = G.panel(cv, t, 768, 44, 400, 468, 'Статистика');
  G.readout(cv, t, stat.x + 24, stat.y + 70, { label: 'Прогревов записано', value: records.length, decimals: 0, size: 64 });
  G.readout(cv, t, stat.x + 24, stat.y + 180, { label: 'Суммарно', value: total, decimals: 0, unit: 'мин', size: 64 });
  if (records.length) {
    const last = records[records.length - 1];
    G.readout(cv, t, stat.x + 24, stat.y + 290, { label: 'Последний', value: last.minutes, decimals: 0, unit: 'мин', size: 64 });
    cv.text(new Date(last.at).toLocaleString('ru-RU'), stat.x + 24, stat.y + 380, 20, t.dim);
  }
  const note = G.panel(cv, t, 1192, 44, 384, 468, 'Как это работает');
  const lines = [
    'Оценка строится на скорости',
    'набора температуры этого',
    'автомобиля (учится за поездки).',
    '',
    'До обучения показываем',
    'типовой диапазон для текущей',
    'температуры.'
  ];
  lines.forEach((lineText, i) => cv.text(lineText, note.x + 24, note.y + 80 + i * 34, 22, t.dim));
}

function header(cv, t, page) {
  G.frame(cv, t, ['Прогрев', 'История'], page, []);
}

module.exports = { W, H, drawWarm, drawHistory, header, ENGINE_LABEL };
