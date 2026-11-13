// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const path = require('path');
const mgu = require('./kit/mgu');
const model = require('./model.js');
const store = require('./store.js');
const view = require('./render.js');

mgu.run({
  async start(ctx) {
    const { ui, settings, log } = ctx;
    const file = path.join(ctx.dataDir, 'warm-history.json');
    const saved = store.load(file);
    const estimator = new model.WarmEstimator(saved.estimator);
    let records = saved.records;
    let temperatures = { oil: null, coolant: null, known: false };
    let outside = null;
    let engine = null;
    let warmStart = null;
    let page = 0;

    ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
      statusEngineTemperature: (value) => { temperatures = model.normalizeTemperatures(value); render(); },
      statusEngineStatus: (value) => {
        const next = model.normalizeEngine(value);
        if (next === 'running' && engine !== 'running' && temperatures.coolant !== null && temperatures.coolant < 70) warmStart = Date.now();
        if (next === 'off') warmStart = null;
        engine = next;
        render();
      }
    }, log, { pollMs: 10000 }).catch((error) => log.warn('warm CDS: ' + error));
    ctx.signals.watch('de.bmw.infrastructure.EnvironmentalInformation', '1', {
      ExteriorTemperature: (value) => { outside = model.normalizeOutside(value); render(); }
    }, log, { pollMs: 30000 }).catch((error) => log.warn('warm outside: ' + error));

    function readyPercent(estimate) {
      if (!estimate.known) return null;
      if (estimate.ready) return 100;
      const target = temperatures.coolant !== null ? 85 : 80;
      const current = temperatures.coolant !== null ? temperatures.coolant : temperatures.oil;
      if (current === null || current >= target) return 100;
      const span = target - Math.min(0, current > 0 ? 0 : current);
      return Math.max(0, Math.min(99, Math.round((current / target) * 100)));
    }

    async function render() {
      const t = ctx.theme();
      const cv = ctx.canvas(view.W, view.H).clear(t.bg);
      const estimate = estimator.estimate(Date.now(), temperatures.oil, temperatures.coolant);
      if (page === 0) {
        view.drawWarm(cv, t, {
          oil: temperatures.oil, coolant: temperatures.coolant,
          outside, estimate, engine,
          advice: model.recommendation(outside, Number(settings.get('threshold'))),
          readyPct: readyPercent(estimate)
        });
      } else {
        view.drawHistory(cv, t, records);
      }
      view.header(cv, t, page, temperatures.known ? [] : [{ text: 'НЕТ ДАННЫХ', color: 'dim' }]);
      return ui.image('MAIN_GFX', cv);
    }

    ui.onClick('BTN_REFRESH', () => render());
    ctx.onTab((i) => { if (i !== page) { page = i; return render(); } return null; });
    settings.onChange(() => render());
    process.on('exit', () => {
      const estimate = estimator.estimate(Date.now(), temperatures.oil, temperatures.coolant);
      if (settings.get('history') && warmStart && estimate.known && estimate.ready) {
        records = records.concat({ at: Date.now(), minutes: Math.max(1, Math.round((Date.now() - warmStart) / 60000)) }).slice(-20);
      }
      try { store.save(file, estimator.toJSON(), records); } catch (error) { log.warn('warm save: ' + error); }
    });
    ctx.loop('MAIN', 10, render);
    return render().then(() => log.info('warm 0.2.0 first frame'));
  }
});
