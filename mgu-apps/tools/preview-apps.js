// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * Хост-превью canvas-экранов: рисует страницы приложений на ПК и пишет PNG
 * в dist/preview/<app>-<page>.png. Проверка визуала без автомобиля.
 *
 *   node tools/preview-apps.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const KIT = path.join(ROOT, '..', 'media', 'core', 'kit', 'runtime');
const OUT = path.join(ROOT, 'dist', 'preview');

const { Canvas } = require(path.join(KIT, 'canvas.js'));
const { Recorder, play } = require(path.join(KIT, 'record.js'));
const themes = require(path.join(KIT, 'themes.js'));

// приложение грузится из временной директории, где ./kit — симлинк на runtime
function loadApp(appId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-preview-'));
  const appSrc = path.join(ROOT, 'apps', appId);
  fs.readdirSync(appSrc).filter((f) => f.endsWith('.js')).forEach((f) => {
    fs.copyFileSync(path.join(appSrc, f), path.join(dir, f));
  });
  fs.symlinkSync(KIT, path.join(dir, 'kit'), 'junction');
  return dir;
}

function canvasOf(view) {
  return new Recorder(view.W, view.H);
}

function writePng(name, rec) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name + '.png');
  const cv = new Canvas(rec.w, rec.h);
  play(rec.words(), cv);
  fs.writeFileSync(file, cv.png());
  return file;
}

const t = themes.theme('m_tricolour');

// ---- health ----
{
  const dir = loadApp('marku_x3_health');
  const view = require(path.join(dir, 'render.js'));
  const history = [
    { at: Date.now() - 86400000 * 4, battery: 82, summary: { verdict: 'partial' } },
    { at: Date.now() - 86400000 * 3, battery: 80, summary: { verdict: 'partial' } },
    { at: Date.now() - 86400000 * 2, battery: 78, summary: { verdict: 'attention' } },
    { at: Date.now() - 86400000, battery: 77, summary: { verdict: 'attention' } }
  ];
  const snapshot = {
    at: Date.now(), battery: 76,
    coverage: { cbs: 'read', battery: 'read', ecus: 'read' },
    cbs: { items: [
      { id: 2, name: 'Передние тормозные колодки', way: '4200 км', date: '', color: 'yellow' },
      { id: 1, name: 'Моторное масло', way: '11800 км', date: '05/2027', color: 'green' },
      { id: 6, name: 'Задние тормозные колодки', way: '19800 км', date: '', color: 'green' }
    ] },
    ecus: { known: true, items: new Array(24).fill(0).map((_, i) => ({ address: i })) },
    summary: { verdict: 'attention' }
  };
  const comparison = { baseline: false, changes: [
    { kind: 'battery', from: 78, to: 76 },
    { kind: 'cbs-changed', from: null, to: null, item: { name: 'Передние тормозные колодки' } },
    { kind: 'ecus', from: 24, to: 24 }
  ] };

  let cv = canvasOf(view).clear(t.bg);
  view.drawOverview(cv, t, {
    battery: 76, batteryHistory: [82, 80, 78, 77, 76],
    cbsItems: snapshot.cbs.items, cbsSummary: null,
    ecuCount: 24, coverage: snapshot.coverage,
    verdict: 'attention', scanning: false, status: 'Проверено: 1 требует внимания',
    checkedAt: snapshot.at, historyCount: history.length, changeCount: 1,
    onScan: null, onSave: null
  });
  view.header(cv, t, 0, [view.verdictBadge('attention', false)]);
  console.log(writePng('health-overview', cv));

  cv = canvasOf(view).clear(t.bg);
  view.drawHistory(cv, t, history);
  view.header(cv, t, 1, []);
  console.log(writePng('health-history', cv));

  cv = canvasOf(view).clear(t.bg);
  view.drawReport(cv, t, snapshot, comparison);
  view.header(cv, t, 2, []);
  console.log(writePng('health-report', cv));
}

// ---- warm ----
{
  const dir = loadApp('marku_x3_warm');
  const view = require(path.join(dir, 'render.js'));
  let cv = canvasOf(view).clear(t.bg);
  view.drawWarm(cv, t, {
    oil: 42, coolant: 58, outside: -6, engine: 'running',
    estimate: { known: true, ready: false, calculated: true, minutes: 6 },
    advice: { level: 2, text: 'Рекомендация: сиденье 2, руль 1. Включите штатными кнопками BMW.' },
    readyPct: 62
  });
  view.header(cv, t, 0, []);
  console.log(writePng('warm-main', cv));

  cv = canvasOf(view).clear(t.bg);
  view.drawHistory(cv, t, [
    { at: Date.now() - 86400000 * 3, minutes: 9 },
    { at: Date.now() - 86400000 * 2, minutes: 12 },
    { at: Date.now() - 86400000, minutes: 7 }
  ]);
  view.header(cv, t, 1, []);
  console.log(writePng('warm-history', cv));
}

// ---- trips ----
{
  const dir = loadApp('marku_x3_trips');
  const view = require(path.join(dir, 'render.js'));
  let cv = canvasOf(view).clear(t.bg);
  view.drawNow(cv, t, {
    current: { start: Date.now() - 2400000, end: Date.now(), km: 18.4, vmax: 96, category: 'Личное' },
    last: null, fuel: 1.62, cost: 107, active: true, speed: 62,
    message: 'Поездка началась', onFinish: null, onCategory: null
  });
  view.header(cv, t, 0, [{ text: 'ЕДЕМ', color: 'ok' }]);
  console.log(writePng('trips-now', cv));

  cv = canvasOf(view).clear(t.bg);
  const days = {};
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86400000);
    days[d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')] = { km: 12 + (13 - i) * 3.7 };
  }
  view.drawTotals(cv, t, { total: { n: 9, km: 214.6, fuel: 17.4, cost: 1148, unknownFuel: 2 }, days, periodLabel: '7 дней', price: 66 });
  view.header(cv, t, 1, []);
  console.log(writePng('trips-totals', cv));

  cv = canvasOf(view).clear(t.bg);
  view.drawJournal(cv, t, [
    { start: Date.now() - 3600000, km: 18.4, fuel: 1.62, cost: 107, category: 'Личное' },
    { start: Date.now() - 90000000, km: 42.1, fuel: 3.3, cost: 218, category: 'Работа' },
    { start: Date.now() - 180000000, km: 12.0, fuel: null, cost: null, category: 'Клиент' },
    { start: Date.now() - 260000000, km: 65.9, fuel: 5.1, cost: 337, category: 'Личное' }
  ], null);
  view.header(cv, t, 2, []);
  console.log(writePng('trips-journal', cv));
}

// ---- hud ----
{
  const dir = loadApp('marku_daily_hud');
  const view = require(path.join(dir, 'view.js'));
  const cv = canvasOf(view).clear(t.bg);
  const alerts = { batteryValue: 52, tyreAlert: { text: 'TYRE +0.30' }, cbsAlert: null,
    batteryAlert: { kind: 'battery', text: '12V LOW 52%' }, active: { kind: 'battery', text: '12V LOW 52%', color: 'yellow' } };
  view.drawMain(cv, t, {
    enabled: true, service: 'готов', targetState: 'panel: показан',
    target: 'panel', alert: alerts.active, alerts,
    frame: view.alertFrame(alerts.active),
    threshold: 60, onToggle: null, onCheck: null
  });
  console.log(writePng('hud-main', cv));
}

// ---- home ----
{
  const dir = loadApp('marku_x3_home');
  const view = require(path.join(dir, 'view.js'));
  const cv = canvasOf(view).clear(t.bg);
  view.drawMain(cv, t, {
    bridge: { paired: true, pairCode: null },
    telemetry: { ignite: 'on', battery: '78 %', service: '5 пунктов' },
    journal: ['12:04 · arrive: выполнено', '11:58 · snapshot: выполнено', '11:30 · leave: отказ bridge'],
    busy: false, onArrive: null, onLeave: null, onSnapshot: null
  });
  view.header(cv, t, []);
  console.log(writePng('home-main', cv));
}

console.log('previews written to ' + OUT);
