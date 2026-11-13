// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const mgu = require('./kit/mgu');
const { ClusterRender } = require('./cluster_render_client.js');
const model = require('./model.js');
const clusterRender = require('./render.js');
const view = require('./view.js');

mgu.run({
  async start(ctx) {
    const { app, ui, settings, log } = ctx;
    let battery = null;
    let tyrePressure = null;
    let tyreTarget = null;
    let cbsList = null;
    let client = null;
    let layer = null;
    let service = 'не подключён';
    let targetState = 'не проверен';
    let shownText = '';

    ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
      statusBattery2: (value) => { battery = value; evaluate(); }
    }, log, { pollMs: 10000 }).catch((error) => log.warn('hud battery: ' + error));
    ctx.signals.watch('de.bmw.infotainment.vehicle.TPMS', '1', {
      statusTyrePressure: (value) => { tyrePressure = value; evaluate(); },
      statusTargetTyrePressure: (value) => { tyreTarget = value; evaluate(); }
    }, log, { pollMs: 30000 }).catch((error) => log.warn('hud tpms: ' + error));
    ctx.signals.watch('de.bmw.infotainment.KombiInterface_2', '1', {
      cbsDataServiceList: (value) => { cbsList = value; evaluate(); }
    }, log, { pollMs: 60000 }).catch((error) => log.warn('hud cbs: ' + error));

    function buildAlerts() {
      return model.buildAlerts({ battery, tyrePressure, tyreTarget, cbs: cbsList,
        batteryThreshold: Number(settings.get('batteryThreshold')) });
    }

    function drawLayer(alerts) {
      if (!client || !client.ready) return;
      const alert = settings.get('enabled') ? alerts.active : null;
      if (!alert) {
        shownText = '';
        if (layer) client.set(layer, { visible: false });
        return;
      }
      const signature = alert.kind + ':' + alert.text;
      if (signature === shownText && layer) {
        client.set(layer, { visible: true });
        return;
      }
      const frame = clusterRender.rgbaAlert(alert.text, alert.color || 'yellow');
      if (!layer) {
        layer = client.image({ target: settings.get('target') || 'panel', klass: 'overlay', z: 20,
          x: 720, y: 300, w: frame.width, h: frame.height, iw: frame.width, ih: frame.height,
          visible: false, guide_hold: false });
      }
      client.set(layer, { target: settings.get('target') || 'panel', visible: false });
      client.pixels(layer, null, frame.pixels);
      client.set(layer, { visible: true });
      shownText = signature;
    }

    async function render() {
      const alerts = buildAlerts();
      const t = ctx.theme();
      const cv = ctx.canvas(view.W, view.H).clear(t.bg);
      const active = settings.get('enabled') ? alerts.active : null;
      view.drawMain(cv, t, {
        enabled: settings.get('enabled'),
        service, targetState,
        target: settings.get('target') || 'panel',
        alert: active,
        alerts,
        frame: active ? view.alertFrame(active) : null,
        threshold: Number(settings.get('batteryThreshold')),
        onToggle: toggle,
        onCheck: check
      });
      ui.text('BTN_TOGGLE', settings.get('enabled') ? 'Выключить' : 'Включить');
      return ui.image('MAIN_GFX', cv);
    }

    function evaluate() {
      const alerts = buildAlerts();
      try { drawLayer(alerts); } catch (error) { log.warn('hud draw: ' + error); service = 'ошибка отрисовки'; }
      return render();
    }

    function stopClient() {
      if (client) client.close();
      client = null;
      layer = null;
      shownText = '';
    }

    function startClient() {
      stopClient();
      if (!settings.get('enabled')) { service = 'выключен'; evaluate(); return; }
      client = new ClusterRender('marku_daily_hud');
      client.on('ready', () => { service = 'готов'; evaluate(); });
      client.on('disconnected', () => { service = 'переподключение'; evaluate(); });
      client.on('target', (name, state) => { targetState = name + ': ' + state; evaluate(); });
      client.on('budget', (cap, max, reason) => { if (reason) { service = 'budget: ' + reason; evaluate(); } });
      client.on('layer', (ref, state, reason) => { if (ref === layer && reason) { service = 'layer: ' + reason; evaluate(); } });
      client.connect();
      service = 'подключение';
      evaluate();
    }

    function toggle() {
      settings.set('enabled', !settings.get('enabled'));
      startClient();
    }
    function check() {
      if (settings.get('enabled') && !client) startClient();
      else evaluate();
    }

    ui.onClick('BTN_TOGGLE', toggle);
    ui.onClick('BTN_CHECK', check);
    settings.onChange((key) => {
      if (key === 'enabled' || key === 'target') startClient();
      else evaluate();
    });
    app.on('shutdown', stopClient);
    ctx.loop('MAIN', 10, render);
    startClient();
    return null;
  }
});
