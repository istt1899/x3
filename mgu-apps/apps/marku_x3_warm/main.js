// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const path = require('path');
const mgu = require('./kit/mgu');
const model = require('./model.js');
const store = require('./store.js');

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
    let lastEstimate = null;
    let warmStart = null;

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

    function render() {
      const writes = [];
      const write = (name, value) => writes.push(Promise.resolve(ui.text(name, value)).catch((error) => log.warn('UI ' + name + ': ' + error)));
      lastEstimate = estimator.estimate(Date.now(), temperatures.oil, temperatures.coolant);
      const advice = model.recommendation(outside, Number(settings.get('threshold')));
      write('warmEngine', 'Двигатель: ' + (engine || 'нет данных'));
      write('warmOil', 'Масло: ' + (temperatures.oil === null ? 'нет данных' : temperatures.oil.toFixed(1) + ' °C'));
      write('warmCoolant', 'ОЖ: ' + (temperatures.coolant === null ? 'нет данных' : temperatures.coolant.toFixed(1) + ' °C'));
      write('warmEstimate', model.formatEstimate(lastEstimate));
      write('warmAdvice', advice.text);
      write('warmSafety', 'Запись в климатический блок не выполняется');
      records.slice(-5).reverse().forEach((record, index) => {
        write('warmH' + (index + 1), new Date(record.at).toLocaleString('ru-RU') + ' · ' + record.minutes + ' мин');
      });
      for (let index = records.slice(-5).length; index < 5; index += 1) write('warmH' + (index + 1), '');
      return Promise.all(writes);
    }

    ui.onClick('warmRefresh', () => render());
    ui.onClick('warmHistory', () => render().then(() => ui.open('HISTORY')));
    ui.onClick('warmBack', () => ui.close('HISTORY'));
    process.on('exit', () => {
      const estimate = estimator.estimate(Date.now(), temperatures.oil, temperatures.coolant);
      if (settings.get('history') && warmStart && estimate.known && estimate.ready) {
        records = records.concat({ at: Date.now(), minutes: Math.max(1, Math.round((Date.now() - warmStart) / 60000)) }).slice(-20);
      }
      try { store.save(file, estimator.toJSON(), records); } catch (error) { log.warn('warm save: ' + error); }
    });
    render();
  }
});
