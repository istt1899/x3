'use strict';
var fs = require('fs'), net = require('net'), path = require('path'), os = require('os');
var GpsProvider = require('./gps-source').GpsProvider;
var validPosition = require('./gps-source').validPosition;
var cameraInfo = require('./camera-info');
var actionPolicy = require('./action-policy'), dataModule = require('./database-store');
var cardLayout = require('./card-layout');
var cardComposition = require('./card-composition');
var alertPreferences = require('./alert-preferences');
var warningPolicy = require('./warning-policy');
var databaseCoverage = require('./database-coverage');
var officialData = require('./official-camera-data'), databaseVersion = require('./database-version.json');
var captureData = require('./capture-data');
var crypto = require('crypto');
var zlib = require('zlib');
var cameraLayers = require('./camera-layers');
var regionalData = require('./russia-regional-store');
var speedcamPrivate = require('./speedcam-private');
var speedcamDownload = require('./speedcam-download');
function clockSnapshot(now, input) {
  var c = input && typeof input === 'object' ? input : {}, wall = Number.isFinite(now) ? now : null;
  function num(key) { return Number.isFinite(c[key]) ? c[key] : null; }
  function str(key) { return typeof c[key] === 'string' ? c[key].slice(0, 300) : null; }
  return { serviceWallMs: wall, serviceWallUtc: wall !== null && isFinite(new Date(wall).getTime()) ? new Date(wall).toISOString() : null,
    sourceUtcMs: num('sourceUtcMs'), sourceUtc: str('sourceUtc'), rawSourceUtc: str('rawSourceUtc'), sourceDeltaMs: num('sourceDeltaMs'),
    lastPacketAgeMs: num('lastPacketAgeMs'), packetReceiptDeltaMs: num('packetReceiptDeltaMs'),
    receiptClockDiscontinuity: typeof c.receiptClockDiscontinuity === 'boolean' ? c.receiptClockDiscontinuity : null,
    admissionAfterUtcMs: num('admissionAfterUtcMs'), admissionAfterUtc: str('admissionAfterUtc'),
    issue: str('issue') || 'SOURCE_UTC_UNKNOWN', reason: str('reason') || 'Данные часов источника GPS недоступны' };
}
/* Why the BMW GPS bridge gives no position, in plain words for the status. */
function bridgeReason(b) {
  if (!b || typeof b !== 'object') return null;
  if (b.reason && typeof b.reason === 'string') return b.reason.slice(0, 160);
  if (b.state === 'subscribed') return 'Мост GPS BMW работает';
  if (b.state === 'starting') return 'Мост GPS подключается к SatellitePositioning';
  if (b.state === 'stopped' || b.state === null || b.state === undefined) return 'Мост не запущен: приложение не стартовало или остановлено';
  var codes = { GPS_EVENT_TIMEOUT: 'События GPS не приходят; подписка перезапускается', GPS_PROXY_TIMEOUT: 'GPS-прокси BMW не отвечает',
    GPS_SUBSCRIPTION_TIMEOUT: 'Подписка на GPS не подтверждена', GPS_RETRY_CAPACITY_LIMIT: 'Исчерпаны повторы подключения GPS; перезапустите приложение',
    GPS_EVENT_UNAVAILABLE: 'Событие updatePosition недоступно в этом SDK', GPS_PROXY_UNAVAILABLE: 'SDK не предоставляет прокси GPS',
    NMEA_PAYLOAD_INVALID: 'Пакет NMEA от BMW невалиден' };
  if (b.errorCode && codes[b.errorCode]) return codes[b.errorCode];
  return 'Мост GPS недоступен' + (b.errorCode ? ': ' + String(b.errorCode).slice(0, 48) : '');
}
/* Guidance may retain an already confirmed road alert through brief quality
 * degradation; the service keeps that visual alert while all non-metric
 * safety gates remain strict. */
function validRetainedPosition(f, now) { return validPosition(f, now, 30); }
function mkdirp(dir) {
  try { if (fs.statSync(dir).isDirectory()) return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  var parent = path.dirname(dir); if (parent !== dir) mkdirp(parent);
  try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST' || !fs.statSync(dir).isDirectory()) throw e; }
}
function previewScale(value) { return Number.isInteger(value) && value >= 75 && value <= 125 && value % 5 === 0; }
function readSettings(file) {
  var settings = { enabled: true, outputs: { cluster: false, hud: false }, hudOpacityPct: 100, cardLayout: cardLayout.defaultLayouts(), cardComposition: cardComposition.normalize(), alertPreferences: alertPreferences.normalize(), overspeedPreferences: warningPolicy.normalize() };
  try {
    var p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof p.enabled === 'boolean') settings.enabled = p.enabled;
    if (p.outputs) ['cluster', 'hud'].forEach(function (key) { if (typeof p.outputs[key] === 'boolean') settings.outputs[key] = p.outputs[key]; });
    if (Number.isInteger(p.hudOpacityPct) && p.hudOpacityPct >= 10 && p.hudOpacityPct <= 100) settings.hudOpacityPct = p.hudOpacityPct;
    if (previewScale(p.centerCameraScalePct)) settings.centerCameraScalePct = p.centerCameraScalePct;
    settings.cardLayout = cardLayout.normalizeLayouts(p.cardLayout);
    settings.cardComposition = cardComposition.normalize(p.cardComposition);
    settings.alertPreferences = alertPreferences.normalize(p.alertPreferences);
    settings.overspeedPreferences = warningPolicy.normalize(p.overspeedPreferences);
  } catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read settings: ' + e.message); }
  return settings;
}
function loadDatabase(file) {
  var p = JSON.parse(fs.readFileSync(file, 'utf8')), ids = Object.create(null);
  if (p.schemaVersion !== 1 || p.source !== 'OpenStreetMap' || !Array.isArray(p.records) || !p.records.length || p.records.length > 100000 || !isFinite(Date.parse(p.sourceTimestamp))) throw new Error('Unsupported snapshot');
  p.records.forEach(function (r) {
    if (!r || typeof r.id !== 'string' || ids[r.id] || ['speed', 'average', 'redlight'].indexOf(r.type) < 0 || !r.position ||
        typeof r.position.lat !== 'number' || typeof r.position.lon !== 'number' || !isFinite(r.position.lat) || !isFinite(r.position.lon) ||
        r.position.lat < 53 || r.position.lat > 56 || r.position.lon < 33 || r.position.lon > 38) throw new Error('Invalid Kaluga record');
    ids[r.id] = true;
  });
  return p;
}
function nearestCandidates(records, fix, count, describeCamera, preferences) {
  if (!fix) return [];
  var search = require('./vehicle-guidance'), closest = [], rad = Math.PI / 180;
  var maxLatitudeDifference = 2000 / (rad * 6371008.8);
  records.forEach(function (record) {
    var y = record.position.lat - fix.lat;
    if (Math.abs(y) > maxLatitudeDifference) return;
    var x = search.longitudeDelta(record.position.lon, fix.lon) * Math.cos((record.position.lat + fix.lat) * rad / 2);
    var distanceM = Math.sqrt(x * x + y * y) * rad * 6371008.8;
    // The service previously ranked rounded metres; preserve that order.
    if (distanceM <= 2000) search.insertNearest(closest, record, Math.round(distanceM), count);
  });
  return closest.map(function(item) {
    var r = item.record;
    var result = Object.assign({}, (describeCamera || cameraInfo.describe)(r),
      { id: r.id, distanceM: item.distanceM, limitKmh: r.limitKmh, confidence: 'unconfirmed' });
    if (preferences) result.filterMatched = alertPreferences.matches(r, preferences);
    return result;
  });
}
function nearest(records, fix, describeCamera) {
  return nearestCandidates(records, fix, 1, describeCamera)[0] || null;
}
function start(options) {
  options = options || {};
  var dataDir = options.dataDir || process.env.KALUGA_DATA_DIR || '/var/opt/marku-kaluga-cameras/data';
  var socketPath = options.socket || process.env.KALUGA_CONTROL_SOCKET || '/dev/shm/marku-kaluga-cameras/ctl.sock';
  var storageError = null;
  try { mkdirp(dataDir); } catch (e) { storageError = e.code || e.message; }
  var inherited = Number(process.env.LISTEN_PID) === process.pid && Number(process.env.LISTEN_FDS) === 1;
  if (!inherited && socketPath.indexOf('\\\\.\\pipe\\') !== 0) mkdirp(path.dirname(socketPath));
  var settingsPath = path.join(dataDir, 'settings.json'), settings;
  try { settings = readSettings(settingsPath); }
  catch (e) { storageError = e.message; settings = { enabled: true, outputs: { cluster: false, hud: false }, hudOpacityPct: 100, cardLayout: cardLayout.defaultLayouts(), cardComposition: cardComposition.normalize(), alertPreferences: alertPreferences.normalize(), overspeedPreferences: warningPolicy.normalize() }; }
  var state = { serviceVersion: '0.13.2', enabled: settings.enabled, outputs: settings.outputs, hudOpacityPct: settings.hudOpacityPct,
    cardLayout: settings.cardLayout, centerCameraScalePct: settings.centerCameraScalePct || null,
    layoutPreview: null, layoutPreviewResult: null, layoutPreviewTrace: [], atlasSamplesRevision: 0,
    cardComposition: settings.cardComposition,
    alertPreferences: settings.alertPreferences,
    overspeedPreferences: settings.overspeedPreferences,
    speedWarning: warningPolicy.evaluate(null,null,Date.now(),settings.overspeedPreferences),
    gpsReset: { phase:'idle', generation:0, afterUtc:null },
    street: { name: null, source: 'BMW', state: 'unavailable', reason: 'Название улицы BMW ещё не получено', observedAtMs: null },
    audio: { available: false, reason: 'Безопасный звуковой канал BMW не подтверждён' },
    commandResult: null, actions: {}, databaseUpdate: { phase: 'idle', busy: false }, nearestCandidates: [],
    atlasMap: { origin: null, roads: [], camera: null },
    hudDimming: 'unavailable', capabilities: { outputs: false, update: false, hudOpacity: false, displayTest: false, layoutPreview: false, cardComposition: true, vehicleSpeedTest: true, alertPreferences: true, overspeedPreferences: true, gpsReset: false },
    rendererDetails: {}, displayTest: { active: false, pinned: false, target: null, calibration: false, untilMs: 0 },
    gps: 'Ожидание моста GPS BMW', gpsFix: null, gpsMotion: { state:'unknown', conflict:false, roadMismatch:false, sources:[] }, clock: clockSnapshot(Date.now(), null),
    gpsBridge: { state: 'stopped', errorCode: null, ageMs: null, reason: 'Мост не запущен: приложение не стартовало или остановлено' },
    gpsNavigation: { source: 'bmw-navigation', state: 'unavailable', updates: 0, accepted: 0, rejected: 0, lastUpdateAgeMs: null, reason: 'Позиция навигации BMW ещё не получена' },
    gpsInput: { source: 'bmw-nmea', packets: 0, badPackets: 0, checksumErrors: 0, sentences: { RMC: 0, GGA: 0, GST: 0 }, lastPacketAgeMs: null, fixUtcAgeMs: null },
    database: { state: 'error', source: 'OpenStreetMap', count: 0, error: null },
    sourceAssembly: { state: 'loading', wantedVersion: databaseVersion.version, selectedVersion: null, activeVersion: null, errorCode: null, reason: null },
    renderer: 'off', alert: null, nearest: null, error: null, diagnostic: 'No confirmed road; nearby points are diagnostic only',
    gpsHold: { active: false, sinceMs: null, ageMs: null, reason: null },
    storage: { persistent: !storageError, settingsSaved: false, error: storageError } };
  var database = null, guidance = null, display = null, dimmer = null, store = null, audio = null, commandCounter = 0, clients = [], lastStatus = '', closed = false, ownsSocket = false, server;
  var lastGoodFix = null, regionalStore = null, curatedBundle = null;
  state.regionalDatabase = { phase: 'unavailable', errorCode: null, selectedRegion: null, regions: [] };
  try {
    regionalStore = (options.regionalStoreFactory || regionalData.createRegionalStore)({
      dataDir: dataDir, snapshot: options.russiaSnapshot || path.join(__dirname, 'russia-camera-baseline.json'),
      beforeInstall: function () {
        var now = gpsNow();
        if (!actionsAt(now, gps.current(now)).cardLayout.allowed) {
          throw Object.assign(new Error('Для установки региональной базы остановитесь'), { code: 'REGION_PARK_REQUIRED' });
        }
      },
      onChange: function () { if (curatedBundle) activateDatabase(curatedBundle); },
      onStatus: function (value) { state.regionalDatabase = value; broadcast(true); }
    });
    state.regionalDatabase = regionalStore.status();
  } catch (e) { state.regionalDatabase.errorCode = e.code || 'REGION_BASELINE_INVALID'; }
  var describeCamera = cameraInfo.describe;
  var selectedVersion = databaseVersion;
  try {
    // Assemble independently; a failed optional source must never acquire the
    // latest version stamp or replace a complete stored database.
    var candidate = loadDatabase(options.database || path.join(__dirname, 'kaluga-speed.json'));
    cameraInfo.enrich(candidate, options.cameraDetails || path.join(__dirname, 'camera-details.json'));
    cameraInfo.supplement(candidate, options.reportedCameras || path.join(__dirname, 'reported-cameras.json'));
    candidate = dataModule.mergeRelations(candidate, JSON.parse(fs.readFileSync(options.enforcementRelations || path.join(__dirname, 'enforcement-relations.json'), 'utf8')));
    try {
      database = officialData.augment(candidate,
        JSON.parse(fs.readFileSync(options.officialCatalog || path.join(__dirname, 'gibdd-kaluga.json'), 'utf8')),
        JSON.parse(fs.readFileSync(options.officialQuality || path.join(__dirname, 'official-camera-quality.json'), 'utf8')));
      database = require('./speed-limits').augment(database,JSON.parse(fs.readFileSync(options.speedLimitData || path.join(__dirname,'speed-limit-data.json'),'utf8')));
      database = require('./openspeedcam-data').augment(database,
        JSON.parse(fs.readFileSync(options.openSpeedcamSnapshot || path.join(__dirname, 'openspeedcam-central.json'), 'utf8')));
      database = require('./region-osm').merge(database, require('./region-osm').load(options.moscowOsm || path.join(__dirname, 'moscow-osm.json')));
      database = require('./capture-data').augment(database);
      state.sourceAssembly.state = 'complete';
    } catch (sourceError) {
      database = candidate; selectedVersion = databaseVersion.legacy;
      if (!selectedVersion) throw sourceError;
      state.sourceAssembly.state = 'legacy-fallback';
      state.sourceAssembly.errorCode = 'OFFICIAL_SOURCE_ASSEMBLY_FAILED';
      state.sourceAssembly.reason = String(sourceError.code || sourceError.message).slice(0,300);
    }
    state.sourceAssembly.selectedVersion = selectedVersion.version;
  } catch (e) {
    database = null; state.database.error = e.message;
    state.sourceAssembly.state = 'unavailable'; state.sourceAssembly.errorCode = 'BUNDLED_SOURCE_ASSEMBLY_FAILED';
    state.sourceAssembly.reason = String(e.code || e.message).slice(0,300);
  }
  try {
    if (!options.guidance) {
      var zones = JSON.parse(fs.readFileSync(path.join(__dirname, 'road-zones.json'), 'utf8'));
      if (!database || zones.sourceTimestamp !== database.sourceTimestamp || zones.pbfMd5 !== database.pbfMd5 || zones.region !== database.region) throw new Error('Road zones and camera snapshot do not match');
    }
    guidance = options.guidance || require('./vehicle-guidance').createGuidance({ zones: zones.zones, records: database.records });
  }
  catch (e) { state.error = 'Guidance unavailable: ' + e.message; }
  try { display = options.display || cameraLayers.createDisplay(); state.capabilities.outputs = true; state.capabilities.displayTest = true; state.capabilities.layoutPreview = true; }
  catch (e) { state.renderer = 'unavailable'; state.error = state.error || 'Display unavailable: ' + e.message; }
  try { dimmer = options.dimmer || require('./hud-dimmer').createDimmer(); state.capabilities.hudOpacity = true; }
  catch (e) { state.hudDimming = 'unavailable'; }
  var gps = options.gps || new GpsProvider({ host: process.env.KALUGA_GPSD_HOST || '127.0.0.1',
    port: Number(process.env.KALUGA_GPSD_PORT) || 2947, nmeaHost: process.env.KALUGA_NMEA_HOST || '127.0.0.1',
    nmeaPort: process.env.KALUGA_NMEA_PORT === '0' ? 0 : Number(process.env.KALUGA_NMEA_PORT) || 5001 });
  state.capabilities.gpsReset = typeof gps.resetEpoch === 'function';
  var clock = gps.referenceClock;
  var gpsNow = clock ? clock.now : function () { return Date.now(); };
  var referenceEpoch = 0;
  function resetGps(now) {
    var epoch = gps.resetEpoch(now);
    if (guidance && typeof guidance.reset === 'function') guidance.reset();
    if (audio && typeof audio.resetEpoch === 'function') audio.resetEpoch(now);
    state.gpsReset = Object.assign({phase:'waiting-new-fix',generation:state.gpsReset.generation+1,afterUtc:now+500},epoch||{});
    lastGoodFix = null;
    state.alert = null;
    state.atlasMap = { origin: null, roads: [], camera: null };
    if (state.displayTest.active || previewRequest) stopDisplayTest('GPS_RESET');
    closeLayoutPreview('GPS_RESET', 'Сброс данных GPS');
  }
  function motionFixes(now) {
    if (typeof gps.motionFixes !== 'function') return null; // older injected GPS providers
    try { return gps.motionFixes(now); }
    catch (e) { state.error = 'GPS motion: ' + e.message; return []; }
  }
  // Linux Node 8 floors OS uptime to whole seconds. An age of two whole
  // seconds means strictly less than three seconds of elapsed time.
  var bootSec = options.bootSec || function () { return Math.floor(os.uptime()); };
  var vehicleSpeedSocket = null, vehicleSpeedSample = null;
  function vehicleMotion() {
    if (!vehicleSpeedSample) return { code: 'NO_SIGNAL', speedKmh: null };
    var age = bootSec() - vehicleSpeedSample.sampledAtBootSec;
    if (!(age >= 0 && age <= 2)) {
      vehicleSpeedSample = null;
      return { code: 'NO_SIGNAL', speedKmh: null };
    }
    var raw = vehicleSpeedSample.raw;
    return raw === null ? { code: 'INVALID', speedKmh: null } : { code: 'READY', speedKmh: raw / 64 };
  }
  function actionsAt(now, fix) { return actionPolicy.policies(state, fix, now, motionFixes(now), vehicleMotion().speedKmh); }
  function requestToken(msg) {
    return msg && typeof msg.requestId === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(msg.requestId) ? msg.requestId : null;
  }
  function commandResult(commandName, phase, message, id, requestId) {
    if (id && state.commandResult && state.commandResult.id === id) requestId = state.commandResult.requestId;
    state.commandResult = { id: id || ++commandCounter, requestId: requestId || null,
      command: commandName, phase: phase, message: String(message).slice(0,300), timeMs: Date.now() };
  }
  function describeDatabase(bundle) {
    var describer=cameraInfo.createDescriber(bundle.records),known=0;
    bundle.records.forEach(function(r){var d=describer(r);if(Number.isFinite(d.cameraLimitKmh)||d.limitReference&&d.limitReference.state==='known'&&Number.isFinite(d.limitReference.valueKmh))known++;});
    return { state: 'ready', source: bundle.displaySource || bundle.source, baseSource: bundle.source,
      osmCount: bundle.osmCount, reportedCount: bundle.reportedCount, relationCount: bundle.relationCount || 0, officialCount: bundle.officialCount || 0,
      speedcamOnline: bundle.speedcamOnline,
      openSpeedcamCount: bundle.openSpeedcamCount || 0, nationalOsm: bundle.nationalOsm || null,
      speedLimitCoverage: {known:known,unknown:bundle.records.length-known,total:bundle.records.length}, sourceMetadata: bundle.sourceMetadata || null, speedLimitMetadata: bundle.speedLimitMetadata || null, countUnit: 'source-position-records',
      updated: bundle.sourceTimestamp, generatedAt: bundle.generatedAt, count: bundle.records.length, version: bundle.version,
      regions: Array.isArray(bundle.regions) ? bundle.regions.slice() : ['RU-KLU'], regionalSources: Array.isArray(bundle.regionalSources) ? bundle.regionalSources.map(function (r) { return Object.assign({}, r); }) : [],
      sha256: crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex'), digestKind: 'canonical-json',
      licence: bundle.licence, region: bundle.region, coverage: databaseCoverage.summarize(bundle.records,bundle.zones||[]),
      skippedCount: bundle.enforcementAudit && Array.isArray(bundle.enforcementAudit.unsupported) ? bundle.enforcementAudit.unsupported.length : null,
      coverageReason: bundle.enforcementAudit && bundle.enforcementAudit.coverage || 'Неполный набор открытых источников', error: null };
  }
  function activateDatabase(bundle) {
    var nextGuidance = options.guidance || require('./vehicle-guidance').createGuidance({ zones: bundle.zones, records: bundle.records });
    var nextDescription = describeDatabase(bundle), nextDescriber = cameraInfo.createDescriber(bundle.records);
    database = bundle; guidance = nextGuidance; describeCamera = nextDescriber; state.database = nextDescription;
    state.sourceAssembly.activeVersion = bundle.version;
  }
  var speedcamLayer = speedcamPrivate.load([path.join(dataDir, 'speedcam-private.json'), path.join(__dirname, 'speedcam-private.json')]);
  var speedcamInstaller = null;
  if (speedcamLayer.phase === 'active') {
    state.speedcamDownload = {phase: 'local', errorCode: null, retryInMs: null};
  } else {
    var downloadedLayer = speedcamDownload.cached(dataDir);
    if (downloadedLayer) speedcamLayer = downloadedLayer;
    state.speedcamDownload = {phase: downloadedLayer ? 'ready' : 'scheduled', errorCode: null, retryInMs: null};
  }
  var activateDatabaseBase = activateDatabase;
  activateDatabase = function (bundle) {
    // Stored bundles from before 0.9.0 predate the Moscow merge and the
    // capture field: derive both. The merge is idempotent.
    try { bundle = require('./region-osm').merge(bundle, require('./region-osm').load(path.join(__dirname, 'moscow-osm.json'))); } catch (ignored) {}
    var domestic = require('./capture-data').augment(bundle);
    var working = regionalStore ? regionalData.merge(domestic, regionalStore.current()) : domestic;
    activateDatabaseBase(speedcamPrivate.merge(working, speedcamLayer));
    curatedBundle = bundle;
    if (regionalStore) state.regionalDatabase = regionalStore.status();
  };
  function updateStatus(value) {
    state.databaseUpdate = Object.assign({}, value, { source: dataModule.SOURCE_URL, busy: ['checking','downloading','installing'].indexOf(value.phase) >= 0 });
    var messages = { idle: 'База готова к проверке', checking: 'Проверяю опубликованный источник базы', downloading: 'Загружаю новую базу',
      installing: 'Проверяю и сохраняю новую базу', current: 'База актуальна', updated: 'База обновлена', 'rolled-back': 'Предыдущая база восстановлена',
      'recovered-from-previous': 'Повреждение активной базы: загружена предыдущая версия',
      'recovered-from-packaged': 'Локальная база недоступна: загружена база из пакета',
      'bundled-upgraded': 'База из нового пакета применена; предыдущая сохранена',
      'bundled-upgrade-error': 'Не удалось применить базу нового пакета; проверьте хранилище',
      'rollback-pinned': 'Выбранный откат сохранён; проверка обновлений снимет закрепление',
      error: 'Не удалось обновить базу; рабочие данные сохранены' };
    state.databaseUpdate.message = messages[value.phase] || value.phase;
    if (value.errorCode === 'UPDATE_RESTORE_FAILED') state.databaseUpdate.message = 'Ошибка носителя: восстановление базы на диске не подтверждено';
    if (value.errorCode === 'ROLLBACK_PIN_RESTORE_FAILED') state.databaseUpdate.message = 'Восстановление отметки отката не подтверждено; проверьте диагностику базы';
    if (value.errorCode) state.databaseUpdate.message += ' (' + value.errorCode + ')';
  }
  try {
    if (database) {
      var initialBundle = Object.assign({}, database, { schema: 1, version: selectedVersion.version, generatedAt: selectedVersion.generatedAt,
        source: database.displaySource || database.source, zones: zones && zones.zones || [] });
      initialBundle.records = initialBundle.records.map(function (record) { return Object.assign({}, record, { controls: cameraInfo.controls(Object.assign({},record,{officialSiteContext:null})) }); });
      store = (options.storeFactory || dataModule.createStore)({ dataDir: dataDir, initial: initialBundle, onChange: activateDatabase, onStatus: updateStatus });
      activateDatabase(store.current()); updateStatus(store.status()); state.capabilities.update = true;
    }
  } catch (e) { state.databaseUpdate = { phase: 'error', busy: false, errorCode: 'DATA_STORE_UNAVAILABLE', message: 'Обновление базы недоступно: ' + e.message }; }
  try { audio = require('./warning-audio').createAudio(options.audio || createRemoteAudioAdapter(), options.audio ? {} : { remote: true }); state.audio = audio.status(); } catch (ignored) {}
  /* The HMI owns the BMW gong service. A play request is published in the
   * status as state.audioRequest; the app executes it and answers with the
   * 'audio-played' command. Unconfirmed requests time out honestly. */
  function createRemoteAudioAdapter() {
    var pending = {}, seq = 0;
    return { play: function (req) {
        return new Promise(function (resolve, reject) {
          var id = ++seq;
          pending[id] = { resolve: resolve, reject: reject };
          state.audioRequest = { seq: id, test: !!req.test, kind: String(req.kind || 'overspeed').slice(0, 24),
            durationMs: Number.isInteger(req.durationMs) ? req.durationMs : 250, atMs: Date.now() };
          broadcast(true);
          pending[id].timer = setTimeout(function () {
            if (!pending[id]) return;
            clearTimeout(pending[id].timer); delete pending[id];
            if (state.audioRequest && state.audioRequest.seq === id) state.audioRequest = null;
            reject(new Error('Приложение не подтвердило воспроизведение звука'));
          }, 10000);
        });
      },
      outcome: function (id, played, reason) {
        var p = pending[id];
        if (!p) return false;
        clearTimeout(p.timer); delete pending[id];
        if (state.audioRequest && state.audioRequest.seq === id) { state.audioRequest = null; broadcast(true); }
        if (played) { p.resolve({ played: true }); return true; }
        p.reject(new Error(reason || 'Воспроизведение звука не подтверждено'));
        return true;
      },
      close: function () { Object.keys(pending).forEach(function (id) { clearTimeout(pending[id].timer); pending[id].reject(new Error('Сервис закрыт')); }); pending = {}; state.audioRequest = null; } };
  }
  function publicState() { return state; }
  var waitingStatus = new WeakMap();
  function send(sock) {
    if (sock.destroyed) return;
    var pending = waitingStatus.get(sock);
    if (pending) { pending.latest = true; return; }
    var current = layoutSession && layoutSession.socket !== sock ? Object.assign({}, state, {layoutPreview:null}) : publicState();
    if (!sock.write(JSON.stringify({ ev: 'status', state: current }) + '\n')) {
      // Finish the current frame and coalesce intermediate updates. In
      // particular, the final command state survives a busy socket.
      pending = { latest: false };
      waitingStatus.set(sock, pending);
      function drain() {
        sock.removeListener('close', closeStatus);
        waitingStatus.delete(sock);
        if (pending.latest) send(sock);
      }
      function closeStatus() { sock.removeListener('drain', drain); waitingStatus.delete(sock); }
      sock.once('drain', drain);
      sock.once('close', closeStatus);
    }
  }
  function broadcast(force) {
    var signature = JSON.stringify(state);
    if (!force && signature === lastStatus) return;
    lastStatus = signature; clients.forEach(send);
  }
  function save(next, requirePersistence) {
    var tmp = settingsPath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(tmp, settingsPath); state.storage = { persistent: true, settingsSaved: true, error: null };
    } catch (e) {
      state.storage = { persistent: false, settingsSaved: false, error: e.code || e.message };
      try { fs.unlinkSync(tmp); } catch (ignored) {}
      if (requirePersistence) throw new Error('Не удалось сохранить размер уведомлений');
    }
    settings = next; state.centerCameraScalePct = settings.centerCameraScalePct || null; state.enabled = settings.enabled; state.outputs = settings.outputs; state.hudOpacityPct = settings.hudOpacityPct; state.cardLayout = settings.cardLayout; state.cardComposition = settings.cardComposition; state.alertPreferences = settings.alertPreferences; state.overspeedPreferences = settings.overspeedPreferences;
  }
  function nextSettings() { return { enabled: settings.enabled, centerCameraScalePct: settings.centerCameraScalePct, outputs: Object.assign({}, settings.outputs), hudOpacityPct: settings.hudOpacityPct, cardLayout: cardLayout.normalizeLayouts(settings.cardLayout), cardComposition: cardComposition.normalize(settings.cardComposition), alertPreferences: alertPreferences.normalize(settings.alertPreferences), overspeedPreferences: warningPolicy.normalize(settings.overspeedPreferences) }; }
  function testTargetEnabled(target) { return target === 'hud' ? settings.outputs.hud : target === 'map' ? settings.outputs.cluster : settings.outputs.hud || settings.outputs.cluster; }
  var previewRequest = null;
  var monotonicNow = options.monotonicNow || function() { return process.uptime() * 1000; };
  var layoutSession = null;
  var layoutSample = cameraLayers.layoutSample;
  var sampleKey, atlasSamples;
  function traceLayout(session, event, code, details) {
    var trace = state.layoutPreviewTrace;
    trace.push(Object.assign({
      session: session.id, requestId: session.requestId, revision: session.revision,
      timeMs: Date.now(), event: event, code: code
    }, details));
    if (trace.length > 24) trace.shift();
  }
  function updateAtlasSamples() {
    var calibration = state.displayTest.active && state.displayTest.calibration;
    var key = JSON.stringify([settings.cardComposition, calibration]);
    if (key === sampleKey) return;
    var cards = {}, calibrationCards = {};
    ['map', 'hud'].forEach(function (target) {
      function image(sample) {
        return zlib.deflateSync(cameraLayers.styledPixels(sample, target, null,
          settings.cardComposition[target])).toString('base64');
      }
      cards[target] = image(layoutSample);
      calibrationCards[target] = image(cameraLayers.displaySample(calibration));
    });
    atlasSamples = { alert: layoutSample, cards: cards, calibrationCards: calibrationCards };
    state.atlasSamplesRevision++;
    sampleKey = key;
  }
  function closeLayoutPreview(code, message) {
    if (!layoutSession) return;
    traceLayout(layoutSession, 'stopped', code);
    state.layoutPreviewResult = Object.assign({}, state.layoutPreviewResult, {
      session: layoutSession.id, requestId: layoutSession.requestId, revision: layoutSession.revision,
      phase: 'stopped', code: code, message: message, stoppedAtMs: Date.now()
    });
    layoutSession = null;
    state.layoutPreview = null;
  }
  function editLayouts(scale) {
    var profiles = cardLayout.normalizeLayouts(settings.cardLayout);
    if (scale !== null) ['map', 'hud'].forEach(function (target) { profiles[target].scalePct = scale; });
    return profiles;
  }
  function updateLayoutPreview() {
    if (!layoutSession) return null;
    var policy = state.actions.displayTest;
    if (!policy.allowed || monotonicNow() >= layoutSession.deadline) {
      if (!policy.allowed) closeLayoutPreview(policy.code, policy.reason);
      else closeLayoutPreview('LEASE_EXPIRED', 'Связь с редактором прервана: время сеанса истекло');
      return null;
    }
    var layouts = editLayouts(layoutSession.scale);
    var imageKey = JSON.stringify([settings.cardComposition, layouts.map.brightnessPct, layouts.map.opacityPct,
      layouts.hud.brightnessPct, layouts.hud.opacityPct]);
    if (imageKey !== layoutSession.imageKey) {
      layoutSession.imageKey = imageKey;
      layoutSession.cards = {};
      ['map', 'hud'].forEach(function (target) {
        var pixels = cameraLayers.styledPixels(layoutSample, target, layouts[target], settings.cardComposition[target]);
        layoutSession.cards[target] = zlib.deflateSync(pixels).toString('base64');
      });
    }
    state.layoutPreview = { session: layoutSession.id, revision: layoutSession.revision, scalePct: layoutSession.scale,
      alert: layoutSample, cards: layoutSession.cards, profiles: layouts };
    return layouts;
  }
  function editLayoutPreview(msg, sock) {
    var allowed = ['cmd', 'requestId', 'session', 'scalePct', 'revision'];
    if (typeof msg.session !== 'string' || !/^[a-zA-Z0-9._:-]{1,96}$/.test(msg.session) ||
        Object.keys(msg).some(function (key) { return allowed.indexOf(key) < 0; })) throw new Error('Сеанс предпросмотра недействителен');
    var own = layoutSession && layoutSession.id === msg.session && layoutSession.socket === sock;
    if (msg.cmd === 'layout-preview-cancel') {
      if (own) { closeLayoutPreview('CANCELLED', 'Редактор закрыт'); tick(); }
      return;
    }
    var now = gpsNow(), policy = actionsAt(now, gps.current(now)).displayTest;
    var starting = msg.cmd === 'layout-preview-start';
    var requested = { id: msg.session, requestId: requestToken(msg), revision: 0 };
    if (starting && !own) traceLayout(requested, 'start-requested', policy.code);
    if (!policy.allowed) {
      if (starting && !own) traceLayout(requested, 'start-denied', policy.code);
      if (own) { closeLayoutPreview(policy.code, policy.reason); tick(); }
      throw new Error(policy.reason);
    }
    if (starting) {
      if (layoutSession && monotonicNow() >= layoutSession.deadline)
        closeLayoutPreview('LEASE_EXPIRED', 'Связь с редактором прервана: время сеанса истекло');
      if (layoutSession && !own && layoutSession.socket !== sock) {
        traceLayout(requested, 'start-denied', 'EDITOR_BUSY');
        throw new Error('Уже открыт другой сеанс предпросмотра');
      }
      if (!display) {
        traceLayout(requested, 'start-denied', 'RENDERER_UNAVAILABLE');
        throw new Error('Рендерер предупреждений недоступен');
      }
      if (state.displayTest.active) stopDisplayTest('ATLAS_PREVIEW');
      if (!layoutSession || !own) {
        if (layoutSession) closeLayoutPreview('REPLACED', 'Открыт новый сеанс');
        layoutSession = Object.assign(requested, { socket: sock, scale: null });
        state.layoutPreviewResult = { session: msg.session, requestId: layoutSession.requestId,
          phase: 'active', code: policy.code, startedAtMs: Date.now() };
        traceLayout(layoutSession, 'started', policy.code);
      }
    } else if (!own || monotonicNow() >= layoutSession.deadline) throw new Error('Тест завершён. Включите предпросмотр снова');
    if (msg.cmd === 'layout-preview') {
      if (!previewScale(msg.scalePct) || !Number.isSafeInteger(msg.revision) || msg.revision < 1)
        throw new Error('Некорректный масштаб предпросмотра');
      if (msg.revision > layoutSession.revision) {
        layoutSession.scale = msg.scalePct;
        layoutSession.revision = msg.revision;
      }
    }
    if (msg.cmd === 'layout-preview-save') {
      if (msg.revision !== layoutSession.revision) throw new Error('Дождитесь обновления теста');
      if (layoutSession.scale !== null) {
        var next = nextSettings();
        next.cardLayout = editLayouts(layoutSession.scale);
        next.centerCameraScalePct = layoutSession.scale;
        save(next, true);
      }
      closeLayoutPreview('SAVED', 'Размер уведомлений сохранён');
      tick();
      commandResult(msg.cmd, 'finished', 'Размер уведомлений сохранён', state.commandResult.id);
      return;
    }
    layoutSession.deadline = monotonicNow() + 8000;
    tick();
  }
  function finishPreview(phase, message) {
    if (!previewRequest) return;
    var result = Object.assign({}, previewRequest.result, { phase: phase, message: message.slice(0, 300), timeMs: Date.now() });
    previewRequest = null;
    state.displayTest.result = result;
    if (state.commandResult && state.commandResult.id === result.id) state.commandResult = result;
  }
  function stopDisplayTest(reason) {
    finishPreview('unconfirmed', 'Тест завершён: ' + reason);
    state.displayTest.active = false; state.displayTest.pinned = false; state.displayTest.untilMs = 0;
    state.displayTest.stoppedReason = reason;
  }
  function updateDisplay(alert, outputs, layouts) {
    if (!display) return;
    try {
      display.update(alert, outputs, layouts || settings.cardLayout, settings.cardComposition);
      state.renderer = display.status();
      state.rendererDetails = typeof display.diagnostics === 'function' ? display.diagnostics() : {};
    } catch (e) {
      state.renderer = 'error: ' + e.message;
      state.rendererDetails = {};
      state.error = 'Display: ' + e.message;
    }
  }
  function settlePreview() {
    var details = state.rendererDetails || {}, connected = details.connection === 'ready';
    var targets = state.displayTest.target ? [state.displayTest.target] :
      ['map', 'hud'].filter(testTargetEnabled);
    var results = targets.map(function(target) {
      var item = connected && details[target], label = target === 'map' ? 'Приборы' : 'HUD';
      var reason = item && (item.targetReason || item.reason);
      if (!connected) return { pending: true, message: label + ' — ожидание подключения renderer' };
      if (item && (item.disabled || item.target === 'unavailable' || item.state === 'отказ' ||
          item.state === 'error' || item.reason === 'CANVAS_TOO_SMALL')) {
        return { refused: true, message: label + ' — ' + (reason || 'вывод недоступен') };
      }
      var showing = item && item.state === 'shown' && (item.target === 'shown' || item.target === 'lingering');
      if (showing && (item.rendering === 'verified' || item.rendering === 'unobservable'))
        return { message: label + ' — кадр не подтверждён. Проверьте изображение' };
      return { pending: true, message: label + ' — ' + (reason || item && item.target || 'ожидание подтверждения') };
    });
    var failed = results.some(function(result) { return result.refused; });
    var pending = !results.length || results.some(function(result) { return result.pending; });
    if (pending && monotonicNow() < previewRequest.deadline) return false;
    var message = results.map(function(result) { return result.message; }).join(' • ');
    if (results.every(function(result) { return result.refused || result.pending; })) {
      finishPreview(failed ? 'error' : 'unconfirmed', failed ? message : 'Время ожидания истекло. ' + message);
      stopDisplayTest(failed ? 'RENDERER_REFUSED' : 'RENDERER_TIMEOUT');
      return true;
    }
    finishPreview('unconfirmed', message);
    return false;
  }
  function movedProfile(target, direction) {
    if (['up', 'down', 'left', 'right'].indexOf(direction) < 0) throw new Error('Выберите направление перемещения карточки');
    // Read the current renderer session before moving; the periodic snapshot
    // may predate a socket disconnect or a changed runtime canvas.
    tick();
    var now = gpsNow(), policy = actionsAt(now, gps.current(now)).cardMove;
    if (!policy.allowed) throw new Error(policy.reason);
    if (state.displayTest.target && state.displayTest.target !== target) throw new Error('Включите тест того экрана, который перемещаете');
    var detail = state.rendererDetails[target], layout = detail && detail.layout, canvas = layout && layout.canvas, card = layout && layout.card;
    var range = layout && layout.positionRange;
    if (!layout || layout.withinBounds !== true || !canvas || !card || !range || ![canvas.width, canvas.height, card.x, card.y, card.width, card.height, range.minX, range.maxX, range.minY, range.maxY].every(Number.isFinite) ||
      canvas.width <= 0 || canvas.height <= 0 || card.width <= 0 || card.height <= 0 || range.minX < 0 || range.minY < 0 || range.maxX < range.minX || range.maxY < range.minY ||
      range.maxX + card.width > canvas.width || range.maxY + card.height > canvas.height) throw new Error('Размеры и границы вывода ещё не получены: включите тест выбранного экрана');
    if (JSON.stringify(cardLayout.validateProfile(layout.settings)) !== JSON.stringify(cardLayout.validateProfile(settings.cardLayout[target]))) throw new Error('Дождитесь подтверждения текущих настроек карточки');
    var horizontal = direction === 'left' || direction === 'right', min = horizontal ? range.minX : range.minY, max = horizontal ? range.maxX : range.maxY;
    if (max <= min) throw new Error('Для перемещения карточки нет свободного места');
    var pixel = horizontal ? card.x : card.y;
    if (pixel < min || pixel > max) throw new Error('Положение карточки вне подтверждённых границ');
    pixel = Math.max(min, Math.min(max, pixel + (direction === 'left' || direction === 'up' ? -10 : 10)));
    var next = Object.assign({}, settings.cardLayout[target]);
    next[horizontal ? 'x' : 'y'] = Math.round((pixel - min) * 1000 / (max - min));
    return cardLayout.validateProfile(next);
  }
  function tick() {
    if(closed)return;
    var reference = clock && clock.snapshot(), now = reference ? reference.referenceUtcMs : gpsNow(), fix = null, gpsError = false;
    if (reference && reference.referenceEpoch !== referenceEpoch) {
      referenceEpoch = reference.referenceEpoch;
      resetGps(now);
    }
    try { fix = gps.current(now); } catch (e) { state.error = 'GPS provider: ' + e.message; gpsError = true; }
    var motions = gpsError ? [] : motionFixes(now), motion = actionPolicy.motionStatus(fix, now, motions);
    var roadBlocked = motion.conflict || motion.roadMismatch;
    var valid = validPosition(fix, now);
    valid = !!(valid && typeof fix.speedKmh === 'number' && isFinite(fix.speedKmh) && fix.speedKmh >= 0 && typeof fix.headingDeg === 'number' && isFinite(fix.headingDeg));
    state.gpsFix = fix || null;
    state.gpsMotion = motion;
    if(state.gpsReset.phase==='waiting-new-fix'&&validPosition(fix,now)&&fix.timeMs>state.gpsReset.afterUtc)state.gpsReset.phase='receiving';
    if (state.street.observedAtMs !== null && Date.now() - state.street.observedAtMs > 15000) state.street = { name: null, source: 'BMW', state: 'stale', reason: 'Название улицы BMW устарело', observedAtMs: null };
    state.vehicleMotion = vehicleMotion();
    state.actions = actionPolicy.policies(state, fix, now, motions, state.vehicleMotion.speedKmh);
    state.clock = clockSnapshot(now, null);
    if (typeof gps.diagnostics === 'function') {
      var gpsDiagnostics = gps.diagnostics(now); state.gpsBridge = gpsDiagnostics.gpsBridge; state.gpsInput = gpsDiagnostics.gpsInput;
      if (state.gpsBridge) state.gpsBridge.reason = bridgeReason(state.gpsBridge);
      if (gpsDiagnostics.gpsNavigation) state.gpsNavigation = gpsDiagnostics.gpsNavigation;
      state.clock = clockSnapshot(now, gpsDiagnostics.clock);
    }
    if (reference) {
      Object.assign(state.clock, reference);
      state.clock.referenceUtc = new Date(now).toISOString();
      state.clock.referenceUtcMs = now;
      state.clock.serviceWallMs = reference.systemWallMs;
      state.clock.serviceWallUtc = new Date(reference.systemWallMs).toISOString();
      if (Number.isFinite(state.clock.sourceUtcMs)) state.clock.sourceDeltaMs = reference.systemWallMs - state.clock.sourceUtcMs;
    }
    state.gps = typeof gps.description === 'function' ? gps.description(fix, now) : !fix ? 'Нет свежих подтверждённых координат UTC (максимум 3 с)' :
      !valid ? 'Координаты есть; точность, скорость или курс не подтверждены' : 'Свежие координаты, скорость, курс и точность получены';
    var gpsLabel = function(source) { return source === 'bmw-nmea' ? 'BMW' : source === 'gpsd' ? 'GPSD' :
      source === 'bmw-navigation' ? 'Навигация BMW' : 'NMEA'; };
    if (motion.sources.length > 1 || motion.roadMismatch) {
      var sourceSpeeds = motion.sources.map(function(item) { return gpsLabel(item.source) + ' ' +
        (item.speedKmh === null ? '?' : item.speedKmh.toFixed(1)); }).join(', ');
      state.gps = (fix ? gpsLabel(fix.source) + ' выбран' + (motion.roadMismatch ? ' ' + fix.speedKmh.toFixed(1) : '') + ' • ' : '') +
        'скорости ' + sourceSpeeds + ' км/ч' + (motion.conflict ? ' • КОНФЛИКТ' : '') +
        (motion.roadMismatch ? ' • РАЗНЫЕ ЭПОХИ' : '') + ' • ' + state.gps;
    } else if (fix && !Number.isFinite(fix.speedKmh) && motion.sources.length === 1 && motion.sources[0].speedKmh !== null) {
      var sample = motion.sources[0];
      state.gps = 'Для теста скорость ' + gpsLabel(sample.source) + ' ' + sample.speedKmh.toFixed(1) +
        ' км/ч (UTC ' + new Date(sample.motionTimeMs).toISOString() + ') • ' + state.gps;
    }
    state.nearestCandidates = database ?
      nearestCandidates(database.records, fix, 3, describeCamera, settings.alertPreferences) : [];
    state.nearest = state.nearestCandidates[0] || null;
    var alert = null;
    var previousAlert = state.alert;
    var withinSettings = function (item) {
      return !!(item && settings.enabled && alertPreferences.matches(item, settings.alertPreferences) &&
        Number.isFinite(item.distanceM) && item.distanceM >= 0 && item.distanceM <= settings.alertPreferences.warningDistanceM + 0.000001);
    };
    var goodPosition = validRetainedPosition(fix, now);
    if (lastGoodFix && lastGoodFix.timeMs > now + 500) lastGoodFix = null;
    var age = lastGoodFix ? now - lastGoodFix.timeMs : null;
    // The decoder publishes a position without GST only after pairing fresh
    // RMC/GGA. Use that fact for a bounded display hold, never for geometry.
    var partialPosition = !roadBlocked && !goodPosition && fix && lastGoodFix &&
      fix.source === 'bmw-nmea' && lastGoodFix.source === fix.source &&
      !Number.isFinite(fix.accuracyM) && Number.isFinite(fix.motionTimeMs) &&
      Math.abs(fix.motionTimeMs - fix.timeMs) <= 500 &&
      fix.timeMs > lastGoodFix.timeMs && now - fix.timeMs <= 3000 && fix.timeMs <= now + 500;
    var holdReason = null;
    if (withinSettings(previousAlert) && lastGoodFix && age >= 0 && !motion.conflict) {
      if (motion.roadMismatch && age <= 3000) holdReason = 'MOTION_EPOCH_MISMATCH';
      else if (partialPosition && age <= 15000) holdReason = 'ACCURACY_MISSING';
      else if (!roadBlocked && !goodPosition && age <= 5000) holdReason = 'GPS_HOLD';
      else if (!roadBlocked && !goodPosition) holdReason = 'GPS_LOST';
    }
    var holding = holdReason !== null && holdReason !== 'GPS_LOST';
    state.gpsHold = { active: holding, sinceMs: holdReason ? lastGoodFix.timeMs : null,
      ageMs: holdReason ? age : null, reason: holdReason };
    try {
      if (holding) alert = previousAlert;
      else if (guidance) {
        if (previousAlert && !withinSettings(previousAlert) && !goodPosition) {
          guidance.evaluate(null, now, settings.enabled, settings.alertPreferences);
        } else alert = guidance.evaluate(database && !roadBlocked ? fix : null, now, settings.enabled, settings.alertPreferences);
      }
    } catch (e) { state.error = 'Guidance: ' + e.message; }
    if (!database || !withinSettings(alert) || (!holding && (!goodPosition || roadBlocked))) alert = null;
    state.guidance = guidance && typeof guidance.diagnostic === 'function' ? guidance.diagnostic() : null;
    var guidanceHeld = !!(alert && state.guidance && state.guidance.holdReason);
    if (alert && !holding && !guidanceHeld && !roadBlocked && goodPosition && (!lastGoodFix || fix.timeMs > lastGoodFix.timeMs)) {
      lastGoodFix = { timeMs: fix.timeMs, source: fix.source };
    }
    var warningFix = !roadBlocked && !holding && !guidanceHeld ? fix : null;
    var mapFix = goodPosition && warningFix && !Number.isFinite(warningFix.extrapolatedMs) ? warningFix : null;
    state.atlasMap = database && guidance && typeof guidance.atlasMap === 'function' ? guidance.atlasMap(mapFix, alert) :
      { origin: mapFix ? { lat: mapFix.lat, lon: mapFix.lon } : null, roads: [], camera: null };
    state.nearestCandidates = state.nearestCandidates.map(function(item){
      var detail=state.guidance && state.guidance.candidates && state.guidance.candidates.find(function(c){return c.id===item.id;});
      return Object.assign({},item,{reason:!validPosition(fix,now)?'GPS_INVALID':detail?detail.reason:'NO_ROAD_ZONE',way:detail&&detail.way||null});
    });
    state.observedAtMs = now;
    state.alert = alert ? Object.assign({}, alert, { gpsHeld: holding || (guidanceHeld && state.guidance.holdReason === 'GPS_REPLAY'), filterMatched: true, limit: alert.limitKmh, distance: Math.round(Number.isFinite(alert.displayDistanceM) ? alert.displayDistanceM : alert.distanceM), stage: alert.stage || (alert.roadConfirmed ? 'approach' : 'nearby') }) : null;
    if (state.alert) state.alert.displayLimit = require('./display-limit').select(state.alert);
    state.speedWarning = warningPolicy.evaluate(state.alert,warningFix,now,settings.overspeedPreferences);
    if(roadBlocked)state.speedWarning.reason=motion.conflict?'MOTION_CONFLICT':'MOTION_EPOCH_MISMATCH';
    else if(!settings.enabled)state.speedWarning.reason='DISABLED';
    else if(state.gpsHold.reason==='GPS_LOST')state.speedWarning.reason='GPS_LOST';
    else if(state.gpsHold.reason==='GPS_HOLD' && (!fix || now - fix.timeMs > 3000))state.speedWarning.reason='GPS_STALE';
    else if(!validPosition(warningFix,now))state.speedWarning.reason=fix?'GPS_INVALID':'GPS_MISSING';
    else if(!state.alert&&state.nearest&&state.nearest.filterMatched===false)state.speedWarning.reason='TYPE_DISABLED';
    if (state.alert) { state.alert.speedKmh = warningFix ? warningFix.speedKmh : null; state.alert.overspeed = state.speedWarning.overspeed; state.alert.speedWarning = state.speedWarning;
      if (warningFix && Number.isFinite(warningFix.headingDeg)) state.alert.captureClass = captureData.classify(state.alert.capture, warningFix.headingDeg, state.alert.cameraFacing); }
    if (state.displayTest.active && (!state.actions.displayTest.allowed || !testTargetEnabled(state.displayTest.target))) stopDisplayTest(!state.actions.displayTest.allowed ? state.actions.displayTest.code : 'OUTPUTS_OFF');
    var displayAlert = state.displayTest.active ? cameraLayers.displaySample(state.displayTest.calibration) : state.alert;
    var displayOutputs = state.displayTest.active && state.displayTest.target ? {
      cluster: state.displayTest.target === 'map' && settings.outputs.cluster, hud: state.displayTest.target === 'hud' && settings.outputs.hud
    } : settings.outputs;
    var previewLayouts = updateLayoutPreview();
    updateAtlasSamples();
    updateDisplay(previewLayouts ? layoutSample : displayAlert, displayOutputs, previewLayouts);
    if (layoutSession) {
      var result = state.layoutPreviewResult;
      result.revision = layoutSession.revision;
      var outputsSnapshot = {};
      ['map', 'hud'].forEach(function(target) {
        var item = state.rendererDetails[target] || {};
        var enabled = testTargetEnabled(target), connected = state.rendererDetails.connection === 'ready';
        var unavailable = item.disabled || item.target === 'unavailable' || item.state === 'отказ' ||
          item.state === 'error' || item.reason === 'CANVAS_TOO_SMALL';
        var subscribed = item.state === 'shown' && (item.target === 'shown' || item.target === 'lingering');
        outputsSnapshot[target] = { enabled: enabled, connected: connected, reason: item.targetReason || item.reason || null,
          frame: !enabled ? 'disabled' : !connected ? 'connecting' : unavailable ? 'unavailable' :
            subscribed ? 'unconfirmed' : 'waiting' };
      });
      var outputKey = JSON.stringify([result.revision, outputsSnapshot]);
      if (layoutSession.outputKey !== outputKey) {
        layoutSession.outputKey = outputKey;
        result.outputs = outputsSnapshot;
        traceLayout(layoutSession, 'outputs', 'FRAME_ACK_UNAVAILABLE', { outputs: outputsSnapshot });
      }
    }
    if (previewRequest && state.displayTest.active && settlePreview()) updateDisplay(state.alert, settings.outputs);
    if (audio) { audio.configure(settings.overspeedPreferences); audio.update(state.alert, warningFix, now, holding || guidanceHeld); var audioState = audio.status();
      if(state.audio && state.audio.probeState)audioState.probeState=state.audio.probeState;
      state.audio=audioState;
    }
    state.actions = actionPolicy.policies(state, fix, now, motions, state.vehicleMotion.speedKmh);
    if (dimmer) {
      try { dimmer.update(settings.hudOpacityPct); state.hudDimming = dimmer.status(); }
      catch (e) { state.hudDimming = 'error: ' + e.message; }
    }
    broadcast(false);
  }
  function execute(msg, sock) {
    if(closed)throw new Error('Сервис завершает работу');
    if (!msg || typeof msg.cmd !== 'string') throw new Error('Invalid command');
    if (msg.cmd === 'status') return;
    if (['layout-preview-start','layout-preview','layout-preview-keep','layout-preview-save','layout-preview-cancel'].indexOf(msg.cmd) >= 0) return editLayoutPreview(msg, sock);
    if (msg.cmd === 'gps-reset') {
      if(Object.keys(msg).some(function(key){return ['cmd','requestId'].indexOf(key)<0;}))throw new Error('Неизвестное поле перезапуска GPS');
      if(!state.capabilities.gpsReset)throw new Error('Источник GPS не поддерживает явный сброс сеанса');
      resetGps(gpsNow());tick();
      commandResult(msg.cmd,'finished','История GPS очищена; ожидание новых координат UTC',state.commandResult.id);return;
    }
    if (msg.cmd === 'display-test-stop') {
      stopDisplayTest('USER_STOP'); save(nextSettings()); tick();
      commandResult(msg.cmd, 'finished', state.storage.settingsSaved ? 'Тест скрыт; настройки сохранены' : 'Тест скрыт; настройки действуют временно: хранилище недоступно', state.commandResult.id);
      return;
    }
    if (msg.cmd === 'display-test' || msg.cmd === 'calibration-test') {
      tick();
      var now = gpsNow(); state.actions = actionsAt(now, gps.current(now));
      var policy = state.actions[msg.cmd === 'display-test' ? 'displayTest' : 'calibrationTest'];
      if(!policy.allowed)throw Object.assign(new Error(policy.reason), { code: policy.code });
      var target = msg.target === undefined ? null : cardLayout.validateTarget(msg.target);
      if(!testTargetEnabled(target))throw new Error('Включите выход «' + (target === 'hud' ? 'HUD' : 'Приборы') + '» для камер');
      closeLayoutPreview('OTHER_TEST', 'Открыт тест отдельного экрана');
      previewRequest = { result: state.commandResult, deadline: monotonicNow() + 10000 };
      state.displayTest.result = state.commandResult;
      state.displayTest.calibration = msg.cmd === 'calibration-test';
      state.displayTest.active = true; state.displayTest.pinned = true; state.displayTest.target = target; state.displayTest.stoppedReason = null;
      state.displayTest.untilMs = 0; tick(); return;
    }
    if (['regional-list', 'regional-download', 'regional-rollback'].indexOf(msg.cmd) >= 0) {
      if (!regionalStore) throw new Error('Региональная база недоступна');
      if (msg.cmd !== 'regional-list') {
        tick();
        if (!state.actions.databaseCheck.allowed) throw new Error(state.actions.databaseCheck.reason);
        if (!state.actions.cardLayout.allowed) throw new Error('Для обновления региональной базы остановитесь и дождитесь измерения скорости');
      }
      var regionRequestId = state.commandResult.id;
      regionalStore.run(msg.cmd, msg.region).then(function (status) {
        if (closed || state.commandResult.id !== regionRequestId) return;
        var phase = status.phase, names = { listed: 'Каталог получен', updated: 'Региональная база сохранена', current: 'База региона актуальна',
          'rolled-back': 'Предыдущая версия региона восстановлена' };
        var reason = status.errorCode === 'REGION_PARK_REQUIRED' ? 'Для установки региональной базы остановитесь' : status.errorCode;
        commandResult(msg.cmd, phase === 'error' ? 'error' : 'finished', names[phase] || reason || phase, regionRequestId);
        tick();
      }, function (error) {
        if (!closed && state.commandResult.id === regionRequestId) { commandResult(msg.cmd, 'error', error.message, regionRequestId); tick(); }
      });
      return;
    }
    if (msg.cmd === 'database-check' || msg.cmd === 'database-rollback') {
      tick(); var dataPolicy = state.actions[msg.cmd === 'database-check' ? 'databaseCheck' : 'databaseRollback'];
      if(!dataPolicy.allowed)throw new Error(dataPolicy.reason);
      var requestId=state.commandResult.id;
      (msg.cmd === 'database-check' ? store.check() : store.rollback()).then(function(status) {
        if(closed)return;updateStatus(status);
        if(state.commandResult && state.commandResult.id===requestId)commandResult(msg.cmd,status.phase==='error'?'error':'finished',state.databaseUpdate.message,requestId);tick();
      },function(error){if(!closed){if(state.commandResult && state.commandResult.id===requestId)commandResult(msg.cmd,'error',error.message,requestId);tick();}});return;
    }
    if (msg.cmd === 'audio-test') {
      tick();if(!state.actions.audioTest.allowed)throw new Error(state.actions.audioTest.reason);
      var audioRequestId=state.commandResult.id;
      audio.test(gpsNow()).then(function(){if(!closed){if(state.commandResult && state.commandResult.id===audioRequestId)commandResult(msg.cmd,'played','Воспроизведение сигнала подтверждено',audioRequestId);tick();}},
        function(error){if(!closed){if(state.commandResult && state.commandResult.id===audioRequestId)commandResult(msg.cmd,'error',error.message,audioRequestId);tick();}});return;
    }
    if (msg.cmd === 'audio-played') {
      if (!Number.isInteger(msg.seq) || msg.seq <= 0 || msg.seq > 1000000) throw new Error('AUDIO_SEQ_INVALID');
      if (typeof msg.played !== 'boolean') throw new Error('AUDIO_PLAYED_INVALID');
      if (msg.reason !== undefined && (typeof msg.reason !== 'string' || msg.reason.length > 160)) throw new Error('AUDIO_REASON_INVALID');
      if (audio) audio.outcome(msg.seq, msg.played, msg.reason || null);
      tick(); return;
    }
    if (msg.cmd === 'vehicle-context') {
      var street=msg.street, audioProbe=msg.audio, navigation=msg.navigation, observed=street && street.observedAtMs, nowContext=Date.now();
      if(street && street.source==='BMW' && ['ready','unavailable','stale'].indexOf(street.state)>=0) {
        var name=street.name;
        if(name!==null && (typeof name!=='string'||name.length>96||Buffer.byteLength(name,'utf8')>240||/[\x00-\x1f\x7f]/.test(name)))throw new Error('STREET_PAYLOAD_INVALID');
        if(typeof name==='string')name=name.trim();
        var freshName=street.state==='ready' && typeof name==='string' && name.length>0 && Number.isFinite(observed) && nowContext-observed<=15000 && observed<=nowContext+500;
        state.street={name:freshName?name:null,source:'BMW',state:freshName?'ready':'unavailable',observedAtMs:freshName?observed:null,
          reason:freshName?null:'BMW не передала свежее название текущей улицы'};
      }
      if(navigation && navigation.source==='bmw-navigation' && ['ready','partial','unavailable'].indexOf(navigation.state)>=0) {
        if(typeof gps.inputNavigation !== 'function' || typeof gps.clearNavigation !== 'function') throw new Error('GPS_NAVIGATION_UNAVAILABLE');
        if(navigation.state==='ready' && navigation.fix) gps.inputNavigation(navigation.fix);
        else gps.clearNavigation(navigation.reason || navigation.state, navigation.reasonCode || (navigation.state === 'partial' ? 'QUALITY' : null));
      }
      if(audioProbe && ['detected','unavailable','unverified'].indexOf(audioProbe.state)>=0 && state.audio)state.audio.probeState=audioProbe.state;
      tick();return;
    }
    if (msg.cmd === 'vehicle-nmea') {
      if (typeof msg.data !== 'string' || !msg.data.length || Buffer.byteLength(msg.data, 'utf8') > 4096) throw new Error('GPS_PACKET_INVALID');
      if (typeof gps.inputNmea !== 'function') throw new Error('GPS_BRIDGE_UNAVAILABLE');
      gps.inputNmea(msg.data); tick(); return;
    }
    if (msg.cmd === 'gps-bridge') {
      if (typeof msg.reason !== 'undefined' && typeof msg.reason !== 'string') throw new Error('GPS_BRIDGE_REASON_INVALID');
      if (typeof gps.setBridgeStatus !== 'function') throw new Error('GPS_BRIDGE_UNAVAILABLE');
      gps.setBridgeStatus(msg.state, msg.errorCode, msg.reason); tick(); return;
    }
    var next = nextSettings();
    if (msg.cmd === 'enable' || msg.cmd === 'disable') next.enabled = msg.cmd === 'enable';
    else if (msg.cmd === 'alert-preferences') {
      if (Object.keys(msg).some(function(key) { return ['cmd','requestId','warningDistanceM','cameraTypes'].indexOf(key) < 0; })) throw new Error('Неизвестное поле настроек предупреждений');
      var preferencePatch = {};
      ['warningDistanceM','cameraTypes'].forEach(function(key) { if (Object.prototype.hasOwnProperty.call(msg,key)) preferencePatch[key] = msg[key]; });
      next.alertPreferences = alertPreferences.patch(settings.alertPreferences, preferencePatch);
    }
    else if (msg.cmd === 'overspeed-preferences') {
      var warningKeys=['visualFlash','visualOffsetKmh','soundEnabled','soundOffsetKmh','soundDistanceM','soundRepeatSec','soundOnCameraAppear'];
      if(Object.keys(msg).some(function(key){return ['cmd','requestId'].concat(warningKeys).indexOf(key)<0;}))throw new Error('Неизвестное поле настроек превышения');
      var warningPatch={};warningKeys.forEach(function(key){if(Object.prototype.hasOwnProperty.call(msg,key))warningPatch[key]=msg[key];});
      next.overspeedPreferences=warningPolicy.patch(settings.overspeedPreferences,warningPatch);
    }
    else if (msg.cmd === 'outputs') {
      if (!state.capabilities.outputs) throw new Error('Display unavailable');
      if (typeof msg.cluster !== 'boolean' || typeof msg.hud !== 'boolean') throw new Error('outputs requires cluster and hud booleans');
      if (state.displayTest.active && ((!msg.cluster && settings.outputs.cluster && state.displayTest.target !== 'hud') || (!msg.hud && settings.outputs.hud && state.displayTest.target !== 'map'))) stopDisplayTest('OUTPUTS_OFF');
      next.outputs = { cluster: msg.cluster, hud: msg.hud };
    } else if (msg.cmd === 'hud-opacity') {
      if (!state.capabilities.hudOpacity) throw new Error('HUD opacity unavailable');
      if (!Number.isInteger(msg.percent) || msg.percent < 10 || msg.percent > 100) throw new Error('HUD opacity requires an integer from 10 to 100');
      next.hudOpacityPct = msg.percent;
    } else if (['card-layout','card-layout-reset','card-move','card-composition'].indexOf(msg.cmd) >= 0) {
      var now = gpsNow(), cardPolicy = actionsAt(now, gps.current(now)).cardLayout;
      if(!cardPolicy.allowed)throw new Error(cardPolicy.reason);
      var cardTarget = cardLayout.validateTarget(msg.target);
      if (msg.cmd === 'card-composition') next.cardComposition = cardComposition.set(settings.cardComposition, cardTarget, msg.key, msg.value);
      else if (msg.cmd === 'card-layout-reset') next.cardLayout[cardTarget] = cardLayout.defaultLayouts()[cardTarget];
      else if (msg.cmd === 'card-move') next.cardLayout[cardTarget] = movedProfile(cardTarget, msg.direction);
      else {
        var partial = {};
        ['x','y','scalePct','brightnessPct','opacityPct'].forEach(function (key) { if (Object.prototype.hasOwnProperty.call(msg, key)) partial[key] = msg[key]; });
        partial = cardLayout.validateProfile(partial, true);
        next.cardLayout[cardTarget] = cardLayout.validateProfile(Object.assign({}, next.cardLayout[cardTarget], partial));
      }
    } else if (msg.cmd === 'update') throw new Error('Используйте команду database-check для независимого обновления базы');
    else throw new Error('Unsupported command');
    save(next); state.error = null; tick();
  }
  function command(msg, sock) {
    if (msg && msg.cmd === 'vehicle-speed') {
      if (!sock || vehicleSpeedSocket && vehicleSpeedSocket !== sock) throw new Error('VEHICLE_SPEED_SOURCE_INVALID');
      if (msg.raw !== null && (!Number.isInteger(msg.raw) || msg.raw < 0 || msg.raw >= 65535))
        throw new Error('VEHICLE_SPEED_VALUE_INVALID');
      if (!Number.isSafeInteger(msg.sampledAtBootSec) || msg.sampledAtBootSec < 0)
        throw new Error('VEHICLE_SPEED_STALE');
      var age = bootSec() - msg.sampledAtBootSec;
      if (!(age >= 0 && age <= 1)) throw new Error('VEHICLE_SPEED_STALE');
      vehicleSpeedSocket = sock;
      vehicleSpeedSample = { raw: msg.raw, sampledAtBootSec: msg.sampledAtBootSec };
      tick();
      return;
    }
    if (msg && msg.requestId !== undefined && !requestToken(msg)) throw new Error('Invalid requestId');
    var userCommand = msg && typeof msg.cmd === 'string' && ['status','vehicle-nmea','gps-bridge','vehicle-context','audio-played','layout-preview-keep','layout-preview-cancel','layout-preview'].indexOf(msg.cmd)<0;
    if(userCommand) { commandResult(msg.cmd,'requested','Выполняется: ' + msg.cmd, null, requestToken(msg)); broadcast(true); }
    try {
      var answer=execute(msg, sock);
      if(userCommand && state.commandResult.phase==='requested' && ['display-test','calibration-test','database-check','database-rollback','audio-test','regional-list','regional-download','regional-rollback'].indexOf(msg.cmd)<0)
        commandResult(msg.cmd,'finished',state.storage.settingsSaved === false && ['card-layout','card-layout-reset','card-move','card-composition','alert-preferences','overspeed-preferences'].indexOf(msg.cmd) >= 0 ? 'Настройка действует временно: хранилище недоступно' : 'Настройка применена',state.commandResult.id);
      if(userCommand)broadcast(true);return answer;
    } catch(error) {
      if (userCommand) {
        commandResult(msg.cmd, 'error', error.message, state.commandResult.id);
        if (msg.cmd === 'display-test' || msg.cmd === 'calibration-test') {
          state.commandResult.code = error.code || 'TEST_ERROR';
          state.displayTest.result = state.commandResult;
        }
        broadcast(true);
      }
      throw error;
    }
  }
  server = net.createServer(function (sock) {
    if (clients.length >= 16) { sock.destroy(); return; }
    clients.push(sock); sock.setEncoding('utf8');
    function drop() {
      clients = clients.filter(function (c) { return c !== sock; });
      var previewLost = layoutSession && layoutSession.socket === sock;
      if (previewLost) closeLayoutPreview('APP_DISCONNECTED', 'Прервалась связь с приложением');
      if (vehicleSpeedSocket !== sock) { if (previewLost) tick(); return; }
      vehicleSpeedSocket = null;
      vehicleSpeedSample = null;
      tick();
    }
    sock.on('error', drop); sock.on('close', drop); send(sock);
    var buffer = '';
    sock.on('data', function (chunk) {
      buffer += chunk;
      // One transport chunk can contain several legal JSONL commands.
      // Limit each complete/partial line, not the chunk's aggregate length.
      if (Buffer.byteLength(buffer, 'utf8') > 131072) { sock.destroy(); return; }
      var nl; while ((nl = buffer.indexOf('\n')) >= 0) {
        var line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        if (Buffer.byteLength(line, 'utf8') > 8192) { sock.destroy(); return; }
        if (!line.trim()) continue;
        var message = null;
        try {
          message = JSON.parse(line);
          if (message && message.cmd === 'atlas-samples') {
            sock.write(JSON.stringify({ ev: 'atlas-samples', revision: state.atlasSamplesRevision, samples: atlasSamples }) + '\n');
            continue;
          }
          command(message, sock);
        }
        catch (e) { sock.write(JSON.stringify({ ev: 'error', error: e.message, requestId: requestToken(message) }) + '\n'); }
        send(sock);
      }
      if (Buffer.byteLength(buffer, 'utf8') > 8192) sock.destroy();
    });
  });
  server.on('error', function (e) { state.error = 'Control: ' + e.message; broadcast(true); if (options.onError) options.onError(e); });
  function listening() {
    ownsSocket = !inherited;
    if (!inherited) { try { fs.chmodSync(socketPath, 0o660); } catch (e) {} }
    if (!closed && speedcamLayer.phase !== 'active') {
      speedcamInstaller = speedcamDownload.createInstaller(Object.assign({}, options.speedcamDownload, {
        dir: dataDir,
        onStatus: function (value) { state.speedcamDownload = value; broadcast(true); },
        onReady: function (layer) {
          var previous = speedcamLayer;
          speedcamLayer = layer;
          try { if (curatedBundle) activateDatabase(curatedBundle); }
          catch (error) { speedcamLayer = previous; throw error; }
        }
      }));
    }
    if (options.onListening) options.onListening();
  }
  if (inherited) server.listen({ fd: 3 }, listening);
  else {
    var oldSocket = null;
    try { oldSocket = fs.lstatSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (oldSocket && !oldSocket.isSocket()) throw new Error('Control path is not a socket');
    if (!oldSocket) server.listen(socketPath, listening);
    else {
      var existing = net.connect(socketPath), settled = false;
      function existingError(err) {
        if (settled) return; settled = true; existing.destroy();
        if (err.code !== 'ECONNREFUSED' && err.code !== 'ENOENT') { server.emit('error', err); return; }
        try { if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath); }
        catch (e) { if (e.code !== 'ENOENT') { server.emit('error', e); return; } }
        if (!closed) server.listen(socketPath, listening);
      }
      existing.setTimeout(1000, function () { existingError(Object.assign(new Error('Existing socket did not answer'), { code: 'ETIMEDOUT' })); });
      existing.on('error', existingError);
      existing.on('connect', function () {
        if (settled) return; settled = true; existing.destroy();
        server.emit('error', Object.assign(new Error('Control socket is already served'), { code: 'EADDRINUSE' }));
      });
    }
  }
  function onGpsStatus(text) { if(!closed)state.diagnostic=text; }
  gps.on('status', onGpsStatus);
  gps.on('fix', tick);
  try { gps.start(); } catch (e) { state.error = 'GPS start: ' + e.message; }
  var timer = setInterval(tick, 500); tick();
  function close() {
    if (closed) return; closeLayoutPreview('SERVICE_CLOSED', 'Сервис остановлен'); stopDisplayTest('SERVICE_CLOSED'); closed = true; clearInterval(timer); if (speedcamInstaller) speedcamInstaller.close(); gps.close(); if (display) display.close(); if (dimmer) dimmer.close(); if(store)store.close(); if(regionalStore)regionalStore.close(); if(audio)audio.close();
    if(typeof gps.removeListener==='function'){gps.removeListener('fix',tick);gps.removeListener('status',onGpsStatus);}
    clients.forEach(function (c) { c.destroy(); }); try { server.close(); } catch (e) {}
    if (ownsSocket) { try { fs.unlinkSync(socketPath); } catch (e) {} }
  }
  return { close: close, tick: tick, state: publicState, command: command };
}
module.exports = { start: start, loadDatabase: loadDatabase, nearest: nearest };
if (require.main === module) {
  var app;
  try { app = start({ onError: function (e) {
    process.stderr.write('Camera control startup: ' + (e.code || e.message) + '\n');
    if (app) app.close(); process.exitCode = 1;
  } }); }
  catch (e) { process.stderr.write('marku-kaluga-cameras: ' + e.message + '\n'); process.exitCode = 1; }
  function stop() { if (app) app.close(); }
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
