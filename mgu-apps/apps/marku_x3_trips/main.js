// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const path = require('path');
const mgu = require('./kit/mgu');
const { Trips, CATEGORIES, csv } = require('./model.js');
const store = require('./store.js');
const view = require('./render.js');

const PERIOD_LABELS = { today: 'Сегодня', week: '7 дней', month: '30 дней', all: 'Все записи' };

mgu.run({
  async start(ctx) {
    const { app, ui, settings, log } = ctx;
    const file = path.join(ctx.dataDir, 'trips.json');
    const csvFile = path.join(ctx.dataDir, 'trips.csv');
    const loaded = store.load(file);
    const trips = loaded.trips;
    trips.setPrice(Number(settings.get('price')));
    let speed = null;
    let engine = null;
    let tank = null;
    let message = loaded.corrupted ? 'trips.json повреждён; резервная копия сохранена' : '';
    let page = 0;
    let saveTimer = null;

    ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
      statusCarSpeed2: (value) => { const raw = value && value.speedVehicleCentreOfGravity; speed = typeof raw === 'number' && raw !== 65535 ? raw * 0.015625 : null; }
    }, log, { pollMs: 2000 }).catch((error) => log.warn('trips speed: ' + error));
    ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
      statusEngineStatus: (value) => {
        const raw = value && value.statusEngineRunDrive;
        engine = raw === 'MOTOR_LAEUFT' || raw === 2 ? 'running' : raw === 'MOTOR_STARTET' || raw === 1 ? 'starting' : raw === 'MOTOR_AUS' || raw === 0 ? 'off' : null;
      }
    }, log, { pollMs: 5000 }).catch((error) => log.warn('trips engine: ' + error));
    ctx.signals.watch('de.bmw.infotainment.KombiIF', '1', {
      statusRangeTankStatus: (value) => { const raw = value && value.fluidLevelFuelTank; tank = typeof raw === 'number' && raw >= 0 && raw < 255 ? raw : null; }
    }, log, { pollMs: 10000 }).catch((error) => log.warn('trips tank: ' + error));

    function scheduleSave() {
      if (saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        try { store.save(file, trips); } catch (error) { log.warn('trips save: ' + error); message = 'Ошибка сохранения журнала'; render(); }
      }, 1000);
    }

    function shownTrip() {
      const last = trips.trips[trips.trips.length - 1];
      return { shown: trips.cur || last, fuel: fuelOf(trips.cur || last), cost: costOf(trips.cur || last) };
    }
    function fuelOf(trip) {
      if (!trip) return null;
      if (trip.tank0 !== null && trip.tank1 !== null && trip.tank1 < trip.tank0) return trip.tank0 - trip.tank1;
      return trip.fuel !== undefined ? trip.fuel : null;
    }
    function costOf(trip) {
      if (!trip) return null;
      if (trip.cost !== undefined && trip.cost !== null) return trip.cost;
      const fuel = fuelOf(trip);
      return fuel !== null ? fuel * trips.price : null;
    }

    async function render() {
      const t = ctx.theme();
      const cv = ctx.canvas(view.W, view.H).clear(t.bg);
      const period = settings.get('period') || 'week';
      if (page === 0) {
        const s = shownTrip();
        view.drawNow(cv, t, {
          current: trips.cur, last: s.shown, fuel: s.fuel, cost: s.cost,
          active: !!trips.cur, speed, message,
          onFinish: finishTrip, onCategory: cycleCategory
        });
      } else if (page === 1) {
        view.drawTotals(cv, t, {
          total: trips.total(period, Date.now()), days: trips.days,
          periodLabel: PERIOD_LABELS[period] || period, price: trips.price
        });
      } else {
        view.drawJournal(cv, t, trips.trips, trips.trips.length ? cycleCategory : null);
      }
      view.header(cv, t, page, trips.cur ? [{ text: 'ЕДЕМ', color: 'ok' }] : []);
      syncBar();
      return ui.image('MAIN_GFX', cv);
    }

    function syncBar() {
      ui.text('BTN_FINISH', trips.cur ? 'Завершить' : 'Не активна');
      ui.enabled('BTN_FINISH', !!trips.cur);
      ui.enabled('BTN_EXPORT', trips.trips.length > 0);
    }

    function finishTrip() {
      const ended = trips.finish();
      message = ended ? 'Поездка завершена' : 'Завершать нечего';
      if (ended) scheduleSave();
      return render();
    }

    function cycleCategory() {
      const trip = trips.trips[trips.trips.length - 1];
      if (!trip) return null;
      const next = CATEGORIES[(CATEGORIES.indexOf(trip.category) + 1) % CATEGORIES.length];
      trips.setCategory(trip.id, next);
      message = 'Категория: ' + next;
      scheduleSave();
      return render();
    }

    function exportCsv() {
      try {
        store.saveCsv(csvFile, csv(trips.trips, trips.price));
        message = 'CSV сохранён в данные приложения';
      } catch (error) { message = 'Не удалось сохранить CSV'; log.warn('trips csv: ' + error); }
      return render();
    }

    function tick() {
      const result = trips.feed(Date.now(), { speed, running: engine, tank });
      if (result.started || result.ended) {
        message = result.started ? 'Поездка началась' : 'Поездка завершена';
        scheduleSave();
      }
    }

    ui.onClick('BTN_FINISH', finishTrip);
    ui.onClick('BTN_EXPORT', exportCsv);
    ctx.onTab((i) => { if (i !== page) { page = i; return render(); } return null; });
    settings.onChange((key, value) => {
      if (key === 'price') trips.setPrice(Number(value));
      scheduleSave();
      render();
    });
    const persist = () => { try { store.save(file, trips); } catch (error) { log.warn('trips save: ' + error); } };
    process.on('exit', persist);
    const tickTimer = setInterval(() => { try { tick(); } catch (error) { log.warn('trips tick: ' + error); } }, 500);
    app.on('shutdown', () => { clearInterval(tickTimer); clearTimeout(saveTimer); persist(); });
    ctx.loop('MAIN', 10, render);
    render();
    return null;
  }
});
