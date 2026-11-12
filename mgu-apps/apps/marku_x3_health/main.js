// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { DiagnosticProbe } = require('./diagnostics.js');
const model = require('./model.js');
const store = require('./store.js');

mgu.run({
  async start(ctx) {
    const { app, ui, settings, log } = ctx;
    const historyFile = path.join(ctx.dataDir, 'health-history.json');
    const reportFile = path.join(ctx.dataDir, 'health-report.json');
    let loaded = store.loadHistory(historyFile);
    let history = loaded.items;
    let baseline = history[0] || null;
    let cbs = { known: false, items: [], summary: null };
    let battery = null;
    let lastSnapshot = null;
    let comparison = null;
    let scanning = false;
    let status = loaded.corrupted ? 'История повреждена; сохранена резервная копия' : 'Проверка ещё не запускалась';
    const probe = new DiagnosticProbe();

    app.on('shutdown', () => {
      Promise.resolve().then(() => probe.close()).catch((error) => log.warn('health close: ' + error));
    });

    if (loaded.corrupted) log.warn('health history corrupted; backup kept');

    ctx.signals.watch('de.bmw.infotainment.KombiInterface_2', '1', {
      cbsDataServiceList: (value) => { cbs = model.normalizeCbs(value, cbs.summary); render(); },
      cbsDataSBA: (value) => { cbs = model.normalizeCbs(cbs.items, value); render(); }
    }, log, { pollMs: 60000 }).catch((error) => log.warn('health CBS: ' + error));
    ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
      statusBattery2: (value) => { battery = model.normalizeBattery(value); render(); }
    }, log, { pollMs: 10000 }).catch((error) => log.warn('health battery: ' + error));

    function coverageText(snapshot) {
      if (!snapshot) return 'Покрытие: CBS, 12 В, ECU discovery';
      return 'Покрытие: CBS ' + snapshot.coverage.cbs + ' · 12 В ' + snapshot.coverage.battery + ' · ECU ' + snapshot.coverage.ecus;
    }

    function render() {
      const writes = [];
      const write = (name, value) => writes.push(Promise.resolve(ui.text(name, value)).catch((error) => log.warn('UI ' + name + ': ' + error)));
      write('healthStatus', status);
      write('healthBattery', '12 В: ' + (battery === null ? 'нет данных' : battery + ' %'));
      const next = cbs.items.find((item) => item.color === 'red' || item.color === 'yellow') || cbs.items[0];
      write('healthService', next ? 'CBS: ' + model.itemLine(next) : 'CBS: нет данных');
      write('healthCoverage', coverageText(lastSnapshot));
      ui.enabled('healthScan', !scanning);
      ui.enabled('healthSave', !!lastSnapshot && !scanning);
      ui.enabled('healthReport', !!lastSnapshot);
      const latest = history.slice(-5).reverse();
      for (let index = 0; index < 5; index += 1) {
        const item = latest[index];
        write('healthH' + (index + 1), item ? new Date(item.at).toLocaleString('ru-RU') + ' · ' + item.summary.verdict : '');
      }
      if (lastSnapshot && comparison) {
        const lines = model.formatReport(lastSnapshot, comparison).split('\n');
        for (let index = 0; index < 5; index += 1) write('healthR' + (index + 1), lines[index] || '');
      }
      return Promise.all(writes);
    }

    async function scan() {
      if (scanning) return;
      scanning = true;
      status = 'Проверка: читаем CBS, 12 В и доступные блоки…';
      render();
      const ecus = model.normalizeEcus(await probe.scan());
      const snapshot = model.buildSnapshot({ now: Date.now(), cbs, battery, ecus });
      comparison = model.diff(baseline, snapshot);
      lastSnapshot = snapshot;
      scanning = false;
      status = ecus.error ? 'Проверка завершена с ошибкой: ' + ecus.error : 'Проверка завершена: ' + comparison.changes.length + ' изменений';
      try { fs.writeFileSync(reportFile, JSON.stringify({ snapshot, comparison }, null, 2) + '\n', { mode: 0o600 }); }
      catch (error) { log.warn('health report: ' + error); }
      if (settings.get('autoBaseline') && !baseline) {
        history = store.saveHistory(historyFile, history.concat(snapshot), settings.get('historyLimit'));
        baseline = history[0] || snapshot;
        status += '; базовая линия сохранена';
      }
      return render();
    }

    ui.onClick('healthScan', scan);
    ui.onClick('healthSave', () => {
      if (!lastSnapshot) return;
      history = store.saveHistory(historyFile, history.concat(lastSnapshot), settings.get('historyLimit'));
      baseline = history[0] || lastSnapshot;
      status = 'Снимок сохранён локально';
      return render();
    });
    ui.onClick('healthHistory', () => render().then(() => ui.open('HISTORY')));
    ui.onClick('healthBack', () => ui.close('HISTORY'));
    ui.onClick('healthReport', () => render().then(() => ui.open('REPORT')));
    ui.onClick('healthReportBack', () => ui.close('REPORT'));
    render();
  }
});
