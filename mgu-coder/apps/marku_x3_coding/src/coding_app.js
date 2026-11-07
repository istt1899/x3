// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { DiagnosticProbe } = require('./diagnostics');
const { FEATURES } = require('./catalog');
const { model, PAGE_SIZE } = require('./view_model');

const logger = logging.getSDKLogger();
const STATE_NAME = 'ST_OnlineApps_MarkuX3Coding';
const NAMES = ['codingTitle', 'codingStatus', 'codingGate', 'codingPage', 'codingScan',
  'codingSlot1', 'codingSlot2', 'codingSlot3', 'codingSlot4', 'codingSlot5',
  'codingPrev', 'codingNext', 'detailEcu', 'detailSummary', 'detailRequirement',
  'detailCaution', 'detailStatus', 'codingBack', 'codingFooter'];

class X3CodingApp extends OnlineApp {
  constructor() {
    super();
    this.components = {};
    this.state = null;
    this.visible = false;
    this.reportedVisibility = null;
    this.sawForeground = false;
    this.written = {};
    this.shutdownPromise = null;
    this.page = 0;
    this.selected = null;
    this.scanResult = null;
    this.probe = new DiagnosticProbe();
    this.on('initialized', () => this.appInitialized().catch((err) => logger.error('X3 coding init: ' + err.message)));
    this.on('shutdown', () => this.handleShutdown());
    this.on('error', (err) => logger.warn('X3 coding OAP: ' + err.message));
    this.on('entryPointExecute', (uuid) => this.openEntry(uuid));
    this.on('changeVisibility', (data) => { if (data && data.visible === false) this.setAppVisible(false); });
  }
  startedForeground() {
    const reasons = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
    const data = this.getVisibilityData && this.getVisibilityData();
    return reasons.indexOf((data && data.reason) || this.startReason) >= 0;
  }
  appInitialized() {
    if (!this.rhmiApplication) return this.initialized();
    const foreground = this.startedForeground();
    return this.setupRhmi().then(() => this.registerEntryPoint()).then(() => {
      if (foreground) return this.registerActive();
    }).then(() => this.initialized()).then(() => {
      if (foreground || this.visible) { this.sawForeground = true; this.setAppVisible(true); }
      const uuid = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
      return uuid ? this.openEntry(uuid) : undefined;
    });
  }
  setupRhmi() {
    const rhmi = this.rhmiApplication;
    this.state = rhmi.getByName(STATE_NAME);
    if (!this.state) return Promise.reject(new Error('missing ' + STATE_NAME));
    NAMES.forEach((name) => { this.components[name] = rhmi.getByName(name); });
    const missing = NAMES.filter((name) => !this.components[name]);
    if (missing.length) return Promise.reject(new Error('missing components ' + missing.join(',')));
    this.components.codingScan.on('action', () => this.scan());
    for (let slot = 0; slot < PAGE_SIZE; slot++) {
      this.components['codingSlot' + (slot + 1)].on('action', () => {
        const index = this.page * PAGE_SIZE + slot;
        if (index >= FEATURES.length) return;
        this.selected = index;
        this.render();
      });
    }
    this.components.codingPrev.on('action', () => { this.page = 0; this.render(); });
    this.components.codingNext.on('action', () => { this.page = 1; this.render(); });
    this.components.codingBack.on('action', () => { this.selected = null; this.render(); });
    rhmi.on('applicationStackChanged', (stack) => {
      const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
      if (!keys.length) return;
      if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) {
        this.sawForeground = true; this.setAppVisible(true);
      } else if (this.sawForeground) this.setAppVisible(false);
    });
    rhmi.on('restoreHmi', () => { this.written = {}; this.render(); });
    this.state.on('visible', (ev) => {
      const value = ev && ev.visible;
      const visible = value === true || value === 'true' || value === 1 || value === '1';
      if (visible) this.sawForeground = true;
      this.setAppVisible(visible);
    });
    return Promise.resolve(this.state.updateResources()).then(() => this.render());
  }
  registerEntryPoint() {
    const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
    const ours = this.getEntryPoints().find((ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
    if (!ours) return Promise.reject(new Error('no entry point'));
    const d = ours.getDescription();
    return ours.init().then(() => this.rhmiApplication.mapEntryState(d.uuid, this.state))
      .then(() => Promise.resolve().then(() => ours.entryPoint.setText(d.textId))
        .then(() => d.icon ? ours.entryPoint.setIcon(d.icon) : undefined)
        .catch((err) => logger.warn('X3 coding tile resources: ' + err.message)))
      .then(() => ours.setAvailability('ENABLED'));
  }
  openEntry(uuid) {
    if (this.shutdownPromise || !this.rhmiApplication || !uuid) return Promise.resolve();
    this.sawForeground = true; this.setAppVisible(true);
    return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
      .catch((err) => logger.warn('X3 coding open: ' + err.message));
  }
  setAppVisible(visible) {
    if (this.shutdownPromise) return;
    this.visible = visible;
    if (!this._initialized || !this._appStatusService || this.reportedVisibility === visible) return;
    this.reportedVisibility = visible;
    const reports = visible ? [this.registerActive(), this.registerHmiVisible()] :
      [this.unregisterHmiVisible(), this.registerInactive()];
    reports.forEach((p) => Promise.resolve(p).catch(() => {}));
  }
  scan() {
    if (this.scanResult && this.scanResult.scanning) return;
    this.scanResult = { scanning: true };
    this.render();
    Promise.resolve().then(() => this.probe.scan()).then((result) => {
      if (result.technicalError) logger.warn('X3 diagnostics [' + result.error + ']: ' +
        String(result.technicalError).replace(/[\r\n\t]/g, ' ').slice(0, 512));
      this.scanResult = { available: result.available, ecus: result.ecus, error: result.error };
      this.render();
    }).catch((err) => {
      logger.warn('X3 diagnostics: ' + String(err.message || err).replace(/[\r\n\t]/g, ' ').slice(0, 512));
      this.scanResult = { available: false, ecus: [], error: 'UNKNOWN_ERROR' };
      this.render();
    });
  }
  set(name, kind, value) {
    if (this.written[kind + ':' + name] === value) return;
    this.written[kind + ':' + name] = value;
    const component = this.components[name];
    const action = kind === 'text' ? component.setValue(0, 'Text', value, 'Text') :
      kind === 'visible' ? component.setProperty('Visible', value ? 1 : 0, 'UInt') : component.setEnabled(value);
    Promise.resolve(action).catch((err) => logger.warn('X3 coding UI ' + name + ': ' + err.message));
  }
  render() {
    if (!this.state || this.shutdownPromise) return;
    const view = model(this.scanResult, this.page, this.selected);
    Object.keys(view.text).forEach((name) => this.set(name, 'text', view.text[name]));
    Object.keys(view.visible).forEach((name) => this.set(name, 'visible', view.visible[name]));
    Object.keys(view.enabled).forEach((name) => this.set(name, 'enabled', view.enabled[name]));
  }
  handleShutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = Promise.resolve().then(() => this.probe.close().catch(() => {}))
      .then(() => this.destroyBundles().catch(() => {}))
      .then(() => process.exit(0));
    return this.shutdownPromise;
  }
}

const app = new X3CodingApp();
app.start().catch((err) => logger.error('X3 coding start: ' + err.message));
