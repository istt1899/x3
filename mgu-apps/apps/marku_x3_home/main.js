// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const mgu = require('./kit/mgu');
const { HomeClient } = require('./home_client.js');

mgu.run({
  async start(ctx) {
    const { app, ui, settings, log } = ctx;
    const client = new HomeClient('/run/marku-home-bridge/ctl.sock', log);
    let bridge = null;
    let engine = null;
    let battery = null;
    let cbs = null;
    let pendingAction = null;
    const journal = [];

    ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
      statusEngineStatus: (value) => { engine = value && value.statusEngineRunDrive; },
      statusBattery2: (value) => { battery = value && value.conditionBatteryChargingCondition; }
    }, log, { pollMs: 10000 }).catch((error) => log.warn('home CDS: ' + error));
    ctx.signals.watch('de.bmw.infotainment.KombiInterface_2', '1', {
      cbsDataServiceList: (value) => { cbs = Array.isArray(value) ? value.length : value && value.cbsDataServiceList ? value.cbsDataServiceList.length : null; }
    }, log, { pollMs: 60000 }).catch((error) => log.warn('home CBS: ' + error));

    function addJournal(text) {
      journal.unshift(new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + ' · ' + text);
      journal.splice(5);
    }

    function telemetry() {
      return {
        ignition: engine === 'MOTOR_LAEUFT' || engine === 'MOTOR_STARTET' ? 'on' : engine ? 'off' : null,
        battery: typeof battery === 'number' && battery > 0 && battery <= 100 ? Math.round(battery) : null,
        service: typeof cbs === 'number' ? cbs + ' items' : null
      };
    }

    function render() {
      const writes = [];
      const write = (name, value) => writes.push(Promise.resolve(ui.text(name, value)).catch((error) => log.warn('UI ' + name + ': ' + error)));
      write('homeStatus', bridge ? (bridge.paired ? 'Bridge: настроен' : 'Bridge: нужен pairing ' + (bridge.pairCode || '')) : 'Bridge: не подключён');
      write('homeNetwork', bridge && bridge.paired ? 'Сеть: готова к одной команде' : 'Сеть: подключите телефон к hotspot X3');
      write('homeArrive', 'Возвращаюсь');
      write('homeLeave', 'Выезжаю');
      write('homeSnapshot', 'Снимок автомобиля');
      write('homePreview', 'Будет отправлено: зажигание, 12 В, число CBS. VIN и координаты исключены.');
      write('homeLog1', journal[0] || 'Команд не выполнялось');
      write('homeLog2', journal[1] || '');
      write('homeSafety', 'Произвольные команды Home Assistant отключены');
      return Promise.all(writes);
    }

    async function refreshStatus() {
      bridge = await client.request({ action: 'status' }, 5000);
      if (!bridge.ok) bridge = null;
      return render();
    }

    async function run(action, scene) {
      const response = await client.request(scene ? { action: 'scene', scene } : { action: 'telemetry', payload: telemetry() }, 12000);
      if (response.ok) addJournal((scene || 'snapshot') + ': выполнено');
      else if (response.unknown) addJournal((scene || 'snapshot') + ': исход неизвестен, повтор не выполняется');
      else addJournal((scene || 'snapshot') + ': отказ ' + response.error);
      return render();
    }

    function confirm(action) {
      pendingAction = action;
      const text = action === 'leave' ? 'Закрыть ворота и выключить свет через разрешённую сцену Home Assistant?' :
        'Отправить снимок: зажигание, 12 В, число CBS? VIN и координаты не отправляются.';
      ui.text('homeConfirmText', text);
      return ui.open('CONFIRM');
    }

    ui.onClick('homeArrive', () => run('arrive', 'arrive'));
    ui.onClick('homeLeave', () => confirm('leave'));
    ui.onClick('homeSnapshot', () => confirm('snapshot'));
    ui.onClick('homeConfirmNo', () => { pendingAction = null; return ui.close('CONFIRM'); });
    ui.onClick('homeConfirmYes', () => {
      const action = pendingAction;
      pendingAction = null;
      return ui.close('CONFIRM').then(() => action === 'leave' ? run('leave', 'leave') : run('snapshot'));
    });
    app.on('shutdown', () => client.close());
    refreshStatus();
    render();
  }
});
