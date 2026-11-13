// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { DiagnosticProbe } = require('./diagnostics.js');
const model = require('./model.js');
const store = require('./store.js');
const view = require('./render.js');

mgu.run({
  async start(ctx) {
    const { ui, settings, log } = ctx;
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
    let page = 0;
    let status = loaded.corrupted ? 'История повреждена; резервная копия сохранена' : 'Проверка ещё не запускалась';
    const probe = new DiagnosticProbe();

    ctx.app.on('shutdown', () => {
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

    function batteryHistory() {
      const values = history.map((item) => (typeof item.battery === 'number' ? item.battery : null));
      if (battery !== null) values.push(battery);
      return values.slice(-24);
    }

    async function render() {
      const t = ctx.theme();
      const cv = ctx.canvas(view.W, view.H).clear(t.bg);
      const urgent = cbs.items.filter((item) => item.color === 'red' || item.color === 'yellow').length;
      const snapshotSummary = lastSnapshot ? lastSnapshot.summary : null;
      if (page === 0) {
        view.drawOverview(cv, t, {
          battery, batteryHistory: batteryHistory(),
          cbsItems: cbs.items, cbsSummary: cbs.summary,
          ecuCount: lastSnapshot && lastSnapshot.ecus.known ? lastSnapshot.ecus.items.length : null,
          coverage: lastSnapshot ? lastSnapshot.coverage : {},
          verdict: lastSnapshot ? lastSnapshot.summary.verdict : 'unknown',
          scanning, status,
          checkedAt: lastSnapshot ? lastSnapshot.at : null,
          historyCount: history.length,
          changeCount: comparison && !comparison.baseline ? comparison.changes.length : 0,
          onScan: () => scan(),
          onSave: () => saveSnapshot()
        });
      } else if (page === 1) {
        view.drawHistory(cv, t, history);
      } else {
        view.drawReport(cv, t, lastSnapshot, comparison);
      }
      view.header(cv, t, page, [view.verdictBadge(snapshotSummary ? snapshotSummary.verdict : 'unknown', scanning)]);
      syncBar();
      return ui.image('MAIN_GFX', cv);
    }

    function syncBar() {
      ui.text('BTN_SCAN', scanning ? 'Проверка…' : 'Проверить');
      ui.text('BTN_SAVE', 'Снимок');
      ui.enabled('BTN_SCAN', !scanning);
      ui.enabled('BTN_SAVE', !!lastSnapshot && !scanning);
    }

    async function scan() {
      if (scanning) return;
      scanning = true;
      status = 'Читаем CBS, 12 В и блоки…';
      render();
      const ecus = model.normalizeEcus(await probe.scan());
      const snapshot = model.buildSnapshot({ now: Date.now(), cbs, battery, ecus });
      comparison = model.diff(baseline, snapshot);
      lastSnapshot = snapshot;
      scanning = false;
      status = ecus.error ? 'Проверка завершена с ошибкой: ' + ecus.error : 'Проверено: ' + (urgentCount(snapshot)) + ' требуют внимания';
      try { fs.writeFileSync(reportFile, JSON.stringify({ snapshot, comparison }, null, 2) + '\n', { mode: 0o600 }); }
      catch (error) { log.warn('health report: ' + error); }
      if (settings.get('autoBaseline') && !baseline) {
        history = store.saveHistory(historyFile, history.concat(snapshot), settings.get('historyLimit'));
        baseline = history[0] || snapshot;
        status += '; базовая линия сохранена';
      }
      return render();
    }

    function urgentCount(snapshot) {
      return snapshot.cbs.items.filter((item) => item.color === 'red' || item.color === 'yellow').length;
    }

    function saveSnapshot() {
      if (!lastSnapshot || scanning) return;
      history = store.saveHistory(historyFile, history.concat(lastSnapshot), settings.get('historyLimit'));
      baseline = history[0] || lastSnapshot;
      status = 'Снимок сохранён локально';
      return render();
    }

    ui.onClick('BTN_SCAN', scan);
    ui.onClick('BTN_SAVE', saveSnapshot);
    ctx.onTab((i) => { if (i !== page) { page = i; return render(); } return null; });
    settings.onChange(() => render());
    ctx.loop('MAIN', 10, render);
    return render().then(() => log.info('health 0.2.0 first frame'));
  }
});
