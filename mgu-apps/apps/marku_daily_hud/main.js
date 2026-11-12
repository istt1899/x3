// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const mgu = require('./kit/mgu');
const { ClusterRender } = require('./cluster_render_client.js');
const model = require('./model.js');
const render = require('./render.js');

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

    function statusText() {
      if (!settings.get('enabled')) return 'Слой выключен';
      return 'Слой включён · ' + service + ' · ' + targetState;
    }

    function renderStatus() {
      const alerts = model.buildAlerts({ battery, tyrePressure, tyreTarget, cbs: cbsList,
        batteryThreshold: Number(settings.get('batteryThreshold')) });
      const alert = settings.get('enabled') ? alerts.active : null;
      ui.text('hudStatus', statusText());
      ui.text('hudService', 'cluster-render: ' + service);
      ui.text('hudAlert', alert ? alert.text : 'Отклонений нет');
      ui.text('hudReason', alert ? 'Одна карточка по событию; постоянные шкалы отсутствуют' : 'В норме приложение ничего не рисует');
      ui.text('hudToggle', settings.get('enabled') ? 'Выключить слой' : 'Включить слой');
      ui.text('hudSafety', 'HUD включается только вручную после проверки на автомобиле');
      return alerts;
    }

    function draw(alerts) {
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
      const frame = render.rgbaAlert(alert.text, alert.color || 'yellow');
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

    function evaluate() {
      const alerts = renderStatus();
      try { draw(alerts); } catch (error) { log.warn('hud draw: ' + error); service = 'ошибка отрисовки'; renderStatus(); }
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

    ui.onClick('hudToggle', () => {
      settings.set('enabled', !settings.get('enabled'));
      startClient();
    });
    ui.onClick('hudCheck', () => { if (settings.get('enabled') && !client) startClient(); else evaluate(); });
    settings.onChange((key) => {
      if (key === 'enabled' || key === 'target') startClient();
      else evaluate();
    });
    app.on('shutdown', stopClient);
    renderStatus();
  }
});
