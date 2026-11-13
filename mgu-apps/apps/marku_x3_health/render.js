// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * Отрисовка canvas-экранов «Здоровье X3». Чистые функции: принимают канву,
 * тему и данные, не трогают состояние приложения — тестируются без машины.
 */
const G = require('./kit/gauges');

const W = 1600, H = 520;

function fmtDateTime(at) {
  return new Date(at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function verdictBadge(verdict, scanning) {
  if (scanning) return { text: 'ПРОВЕРКА', color: 'accent2' };
  if (verdict === 'attention') return { text: 'ВНИМАНИЕ', color: 'warn' };
  if (verdict === 'partial') return { text: 'ЧАСТИЧНО', color: 'accent2' };
  return { text: 'НЕТ ДАННЫХ', color: 'dim' };
}

/** d = { battery, batteryHistory, cbsItems, cbsSummary, ecuCount, ecuTotal, coverage, verdict, scanning, status } */
function drawOverview(cv, t, d) {
  G.stat(cv, t, 24, 44, 372, 200, {
    label: 'Аккумулятор 12 В', value: d.battery, unit: '%', decimals: 0, size: 84,
    zones: [{ from: 0, to: 50, color: 'crit' }, { from: 50, to: 60, color: 'warn' }],
    history: d.batteryHistory, sub: 'Порог внимания 60 %'
  });
  G.stat(cv, t, 24, 268, 372, 244, {
    label: 'Блоки ECU', value: d.ecuCount, decimals: 0, size: 84,
    text: d.ecuCount === null ? '—' : undefined,
    sub: d.ecuTotal ? 'из ' + d.ecuTotal + ' по SVT' : 'read-only опрос'
  });
  const pillY = 268 + 244 - 96;
  const cov = d.coverage || {};
  const covColor = (v) => (v === 'read' ? 'ok' : 'dim');
  let px = 42;
  px += G.pill(cv, t, px, pillY, 96, 30, 'CBS', { color: covColor(cov.cbs), filled: cov.cbs === 'read' ? 0.28 : 0.1 }) + 8;
  px += G.pill(cv, t, px, pillY, 82, 30, '12 В', { color: covColor(cov.battery), filled: cov.battery === 'read' ? 0.28 : 0.1 }) + 8;
  G.pill(cv, t, px, pillY, 96, 30, 'ECU', { color: covColor(cov.ecus), filled: cov.ecus === 'read' ? 0.28 : 0.1 });

  const sh = G.panel(cv, t, 420, 44, 700, 468, 'Сервис CBS');
  if (!d.cbsItems.length) {
    cv.text('Нет данных CBS', 448, sh.y + 130, 28, t.dim);
    cv.text('Проверьте автомобиль: кнопка «Проверить»', 448, sh.y + 168, 22, t.dim);
  } else {
    const cols = [
      { label: 'Работа', w: 330 },
      { label: 'Осталось / дата', w: 236, align: 'right' },
      { label: 'Статус', w: 86, align: 'right' }
    ];
    const rows = d.cbsItems.slice(0, 7).map((item) => [
      (item.name || 'CBS ' + item.id).slice(0, 34),
      { text: ((item.way || '') + (item.date ? ' · ' + item.date : '')).slice(0, 26), color: 'dim' },
      { text: item.color === 'red' ? 'СРОЧНО' : item.color === 'yellow' ? 'СКОРО' : 'OK', color: item.color === 'red' ? 'crit' : item.color === 'yellow' ? 'warn' : 'ok' }
    ]);
    G.table(cv, t, 448, sh.y + 30, 644, cols, rows, { rowH: 52, size: 22, headerSize: 16 });
  }

  const rp = G.panel(cv, t, 1144, 44, 432, 468, 'Снимок');
  G.readout(cv, t, rp.x + 24, rp.y + 66, { label: 'Вердикт', text: d.verdict === 'attention' ? 'Внимание' : d.verdict === 'partial' ? 'Частично' : 'Нет данных', size: 40 });
  G.readout(cv, t, rp.x + 24, rp.y + 170, { label: 'Последняя проверка', text: d.checkedAt ? fmtDateTime(d.checkedAt) : '—', size: 30 });
  G.readout(cv, t, rp.x + 24, rp.y + 250, { label: 'Снимков в истории', value: d.historyCount, decimals: 0, size: 44 });
  G.readout(cv, t, rp.x + 24, rp.y + 316, { label: 'Изменений от базовой линии', value: d.changeCount, decimals: 0, size: 44 });

  const by = rp.y + 468 - 60;
  cv.text(d.status || '', rp.x + 24, by - 14, 18, t.dim);
  G.button(cv, t, rp.x + 20, by, 190, 44, d.scanning ? 'Проверка…' : 'Проверить', d.onScan, { busy: d.scanning, primary: true });
  G.button(cv, t, rp.x + 222, by, 190, 44, 'Сохранить', d.onSave, { busy: d.scanning });
}

/** items — история снимков [{ at, battery, summary }] */
function drawHistory(cv, t, items) {
  const sh = G.panel(cv, t, 24, 44, 960, 468, 'Аккумулятор по снимкам, %');
  const pts = [];
  (items || []).forEach((item, i) => {
    if (typeof item.battery === 'number') pts.push([i + 1, item.battery]);
  });
  if (pts.length > 1) {
    G.chart(cv, t, sh.x + 16, sh.y + 40, sh.w - 48, sh.h - 110, {
      xMin: 1, xMax: Math.max(2, pts.length), yMin: 40, yMax: 100,
      series: [{ pts, color: 'accent', fill: 0.14 }], padLeft: 40
    });
  } else {
    cv.text('Мало снимков для графика', sh.x + 40, sh.y + 180, 26, t.dim);
    cv.text('Сохраняйте снимок после каждой проверки', sh.x + 40, sh.y + 218, 22, t.dim);
  }
  const tp = G.panel(cv, t, 1008, 44, 568, 468, 'История');
  const cols = [{ label: 'Дата', w: 170 }, { label: '12 В', w: 80, align: 'right' }, { label: 'Вердикт', w: 180 }];
  const rows = (items || []).slice(-8).reverse().map((item) => [
    fmtDateTime(item.at),
    typeof item.battery === 'number' ? item.battery + '' : '—',
    { text: item.summary && item.summary.verdict === 'attention' ? 'Внимание' : item.summary && item.summary.verdict === 'partial' ? 'Частично' : 'Нет данных',
      color: item.summary && item.summary.verdict === 'attention' ? 'warn' : 'dim' }
  ]);
  G.table(cv, t, tp.x + 20, tp.y + 30, tp.w - 40, cols, rows, { rowH: 48, size: 20, headerSize: 16, empty: 'История пуста' });
}

/** snapshot + comparison — как в model.diff */
function drawReport(cv, t, snapshot, comparison) {
  const lp = G.panel(cv, t, 24, 44, 560, 468, 'Покрытие проверки');
  const cov = snapshot ? snapshot.coverage : {};
  const line = (y, label, value, color) => {
    cv.text(label, 48, y, 24, t.dim);
    cv.text(value, 560 - 40, y + 2, 24, t[color] || color, { align: 'right', font: 'bold' });
  };
  line(lp.y + 100, 'CBS (бортовой сервис)', cov.cbs === 'read' ? 'прочитан' : 'нет данных', cov.cbs === 'read' ? 'ok' : 'warn');
  line(lp.y + 150, 'Аккумулятор 12 В', cov.battery === 'read' ? 'прочитан' : 'нет данных', cov.battery === 'read' ? 'ok' : 'warn');
  line(lp.y + 200, 'Опрос блоков ECU', cov.ecus === 'read' ? 'прочитан' : 'нет данных', cov.ecus === 'read' ? 'ok' : 'warn');
  cv.text('Остальные системы не проверялись.', 48, lp.y + 270, 20, t.dim);
  cv.text('Отчёт не является общим заключением', 48, lp.y + 298, 20, t.dim);
  cv.text('об исправности автомобиля.', 48, lp.y + 326, 20, t.dim);

  const rp = G.panel(cv, t, 608, 44, 968, 468, 'Отчёт');
  if (!snapshot) {
    cv.text('Снимок ещё не делался', rp.x + 40, rp.y + 140, 28, t.dim);
    cv.text('Запустите проверку кнопкой «Проверить»', rp.x + 40, rp.y + 180, 22, t.dim);
    return;
  }
  cv.text('Снимок от ' + new Date(snapshot.at).toLocaleString('ru-RU'), rp.x + 24, rp.y + 90, 24, t.text, { font: 'bold' });
  const changes = comparison && comparison.changes || [];
  if (comparison && comparison.baseline) {
    cv.text('Первый снимок — базовая линия.', rp.x + 24, rp.y + 140, 24, t.accent2);
    cv.text('Следующие проверки будут сравниваться с ней.', rp.x + 24, rp.y + 174, 20, t.dim);
  } else if (!changes.length) {
    cv.text('Изменений от базовой линии нет.', rp.x + 24, rp.y + 140, 24, 'ok');
  } else {
    const names = { battery: 'Аккумулятор 12 В', 'cbs-new': 'Новый пункт CBS', 'cbs-changed': 'Изменился пункт CBS', ecus: 'Число блоков ECU' };
    changes.slice(0, 6).forEach((change, i) => {
      const y = rp.y + 140 + i * 52;
      G.pill(cv, t, rp.x + 24, y, 210, 32, names[change.kind] || change.kind, { color: 'accent2', filled: 0.2 });
      cv.text(change.kind === 'battery' ? change.from + ' % -> ' + change.to + ' %' :
        change.kind === 'ecus' ? change.from + ' -> ' + change.to :
        change.item ? String(change.item.name || change.item.id).slice(0, 30) : '', rp.x + 250, y + 8, 22, t.text);
    });
  }
  cv.text('Файл отчёта: health-report.json (данные приложения)', rp.x + 24, rp.y + 468 - 44, 18, t.dim);
}

function header(cv, t, page, badges) {
  G.frame(cv, t, ['Обзор', 'История', 'Отчёт'], page, badges);
}

module.exports = { W, H, drawOverview, drawHistory, drawReport, header, verdictBadge, fmtDateTime };
