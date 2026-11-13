// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const mgu = require('./kit/mgu');
const { HomeClient } = require('./home_client.js');
const view = require('./view.js');

mgu.run({
  async start(ctx) {
    const { app, ui, settings, log } = ctx;
    const client = new HomeClient('/run/marku-home-bridge/ctl.sock', log);
    let bridge = null;
    let engine = null;
    let battery = null;
    let cbs = null;
    let busy = false;
    const journal = [];

    ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
      statusEngineStatus: (value) => { engine = value && value.statusEngineRunDrive; render(); },
      statusBattery2: (value) => { battery = value && value.conditionBatteryChargingCondition; render(); }
    }, log, { pollMs: 10000 }).catch((error) => log.warn('home CDS: ' + error));
    ctx.signals.watch('de.bmw.infotainment.KombiInterface_2', '1', {
      cbsDataServiceList: (value) => { cbs = Array.isArray(value) ? value.length : value && value.cbsDataServiceList ? value.cbsDataServiceList.length : null; render(); }
    }, log, { pollMs: 60000 }).catch((error) => log.warn('home CBS: ' + error));

    function addJournal(text) {
      journal.unshift(new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + ' · ' + text);
      journal.splice(7);
    }

    function telemetry() {
      return {
        ignite: engine === 'MOTOR_LAEUFT' || engine === 'MOTOR_STARTET' ? 'on' : engine ? 'off' : null,
        battery: typeof battery === 'number' && battery > 0 && battery <= 100 ? Math.round(battery) + ' %' : null,
        service: typeof cbs === 'number' ? cbs + ' пунктов' : null
      };
    }

    async function render() {
      const t = ctx.theme();
      const cv = ctx.canvas(view.W, view.H).clear(t.bg);
      view.drawMain(cv, t, {
        bridge, telemetry: telemetry(), journal, busy,
        onArrive: () => run('arrive', 'arrive'),
        onLeave: () => run('leave', 'leave'),
        onSnapshot: () => run('snapshot')
      });
      view.header(cv, t, []);
      syncBar();
      return ui.image('MAIN_GFX', cv);
    }

    function syncBar() {
      ui.enabled('BTN_ARRIVE', !!bridge && bridge.paired && !busy);
      ui.enabled('BTN_LEAVE', !!bridge && bridge.paired && !busy);
      ui.enabled('BTN_SNAPSHOT', !!bridge && bridge.paired && !busy);
    }

    async function refreshStatus() {
      try {
        const response = await client.request({ action: 'status' }, 5000);
        bridge = response.ok ? response : null;
      } catch (error) { bridge = null; }
      return render();
    }

    async function run(action, scene) {
      if (busy) return null;
      busy = true;
      render();
      try {
        const response = await client.request(
          scene ? { action: 'scene', scene } : { action: 'telemetry', payload: telemetry() }, 12000);
        if (response.ok) addJournal((scene || 'snapshot') + ': выполнено');
        else if (response.unknown) addJournal((scene || 'snapshot') + ': исход неизвестен, повтор не выполняется');
        else addJournal((scene || 'snapshot') + ': отказ ' + response.error);
      } catch (error) {
        addJournal((scene || 'snapshot') + ': нет связи');
      }
      busy = false;
      return render();
    }

    ui.onClick('BTN_ARRIVE', () => run('arrive', 'arrive'));
    ui.onClick('BTN_LEAVE', () => run('leave', 'leave'));
    ui.onClick('BTN_SNAPSHOT', () => run('snapshot'));
    const statusTimer = setInterval(() => { refreshStatus().catch(() => {}); }, 30000);
    app.on('shutdown', () => { clearInterval(statusTimer); client.close(); });
    ctx.loop('MAIN', 10, render);
    refreshStatus();
    return null;
  }
});
