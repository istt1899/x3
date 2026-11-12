// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const path = require('path');
const mgu = require('./kit/mgu');
const { Trips, CATEGORIES, csv } = require('./model.js');
const store = require('./store.js');

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
    let message = loaded.corrupted ? 'trips.json повреждён; резервная копия сохранена' : 'Журнал готов';
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

    function render() {
      const writes = [];
      const write = (name, value) => writes.push(Promise.resolve(ui.text(name, value)).catch((error) => log.warn('UI ' + name + ': ' + error)));
      const current = trips.cur;
      const last = trips.trips[trips.trips.length - 1];
      const shown = current || last;
      write('tripsCurrent', shown ? (current ? 'Текущая: ' : 'Последняя: ') + shown.km.toFixed(1) + ' км · ' + new Date(shown.start).toLocaleString('ru-RU') : 'Поездок ещё не было');
      const fuel = shown && shown.tank0 !== null && shown.tank1 !== null && shown.tank1 < shown.tank0 ? shown.tank0 - shown.tank1 : shown && shown.fuel !== undefined ? shown.fuel : null;
      write('tripsFuel', 'Топливо: ' + (fuel === null || fuel === undefined ? 'нет данных' : fuel.toFixed(2) + ' л'));
      const cost = shown && shown.cost !== undefined ? shown.cost : fuel !== null ? fuel * trips.price : null;
      write('tripsCost', 'Стоимость: ' + (cost ? cost.toFixed(0) + ' ₽' : 'нет данных'));
      const total = trips.total(settings.get('period') || 'week', Date.now());
      write('tripsTotals', 'Итог: ' + total.n + ' поездок · ' + total.km.toFixed(1) + ' км · ' + total.fuel.toFixed(1) + ' л · ' + total.cost.toFixed(0) + ' ₽ · без топлива: ' + total.unknownFuel);
      write('tripsFinish', trips.cur ? 'Завершить поездку' : 'Поездка не активна');
      write('tripsCategory', 'Категория: ' + (shown ? shown.category : '—'));
      write('tripsPrivacy', 'Локально; без облака, маршрутов и геолокации');
      ui.enabled('tripsFinish', !!trips.cur);
      ui.enabled('tripsCategory', !!shown);
      return Promise.all(writes);
    }

    function tick() {
      const result = trips.feed(Date.now(), { speed, running: engine, tank });
      if (result.started || result.ended) {
        message = result.started ? 'Поездка началась' : 'Поездка завершена';
        scheduleSave();
      }
      render();
    }

    ui.onClick('tripsFinish', () => {
      const ended = trips.finish();
      message = ended ? 'Поездка завершена вручную' : 'Завершать нечего';
      scheduleSave();
      return render();
    });
    ui.onClick('tripsCategory', () => {
      const trip = trips.trips[trips.trips.length - 1];
      if (!trip) return;
      const next = CATEGORIES[(CATEGORIES.indexOf(trip.category) + 1) % CATEGORIES.length];
      trips.setCategory(trip.id, next);
      message = 'Категория: ' + next;
      scheduleSave();
      return render();
    });
    ui.onClick('tripsExport', () => {
      try {
        store.saveCsv(csvFile, csv(trips.trips, trips.price));
        message = 'CSV сохранён: ' + csvFile;
      } catch (error) { message = 'Не удалось сохранить CSV'; log.warn('trips csv: ' + error); }
      return render();
    });
    settings.onChange((key, value) => {
      if (key === 'price') trips.setPrice(Number(value));
      scheduleSave();
      render();
    });
    const persist = () => { try { store.save(file, trips); } catch (error) { log.warn('trips save: ' + error); } };
    process.on('exit', persist);
    const tickTimer = setInterval(() => { try { tick(); } catch (error) { log.warn('trips tick: ' + error); } }, 500);
    app.on('shutdown', () => { clearInterval(tickTimer); clearTimeout(saveTimer); persist(); });
    render();
  }
});
