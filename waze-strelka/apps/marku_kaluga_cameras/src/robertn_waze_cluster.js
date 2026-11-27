// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * robertn_waze_cluster - the control panel for the native
 * waze-on-cluster tool, which puts the CarPlay cluster map on the instrument
 * cluster. It drives the tool entirely from the HMI, so no shell is needed.
 *
 * The main page, one LT_State_Wide list in four sections, each under a
 * header row: General, HUD, CarPlay, Android Auto, then the restart's two
 * rows. General: Show on (a drop-down of Cluster, HUD and both), Cluster map
 * (the shared render's map), the Hide BMW's turn box checkbox (the render's
 * setting; a press asks the render to flip it), Logs. HUD: HUD map (the map
 * on the HUD), the Size slider, Position with Move left, Move right, Move
 * up, Move down and Centre; the slider and the position buttons are greyed
 * while the HUD is off or disabled after errors. CarPlay and Android Auto
 * have the same rows: Status, Patch, Remove patch; CarPlay adds CarPlay
 * Wi-Fi (the band, 5 GHz or 2.4 GHz) and, on 2.4 GHz, the line under it;
 * Android Auto adds Zoom with Zoom out and Zoom in, and the Hide phone's
 * turn card checkbox. Info rows read "Name: Value"; every on/off setting is
 * a checkbox. One that cannot act now is greyed, and while patchd runs any
 * operation every operation is. Every row stays on the page but four, the
 * only rows shown and hidden: CarPlay Wi-Fi while CarPlay runs over Wi-Fi
 * and patchd knows the band, and its line on 2.4 GHz, CarPlay's last two
 * (only Android Auto's rows move); Restart head unit while a written change
 * waits for the next head-unit start, and the Restart row while it has
 * something to say, the page's last two (no row moves). Once patched, the
 * render puts the map on the cluster whenever the phone streams it, with no
 * button.
 *
 * The Logs page (logs_control.js): Start capture and the Capture row, Save
 * logs and the Saved logs row, the QR code of the address a phone on the
 * car's hotspot downloads the saved archives from, that address, and the
 * archives. The app holds the logs socket while the page is visible; the QR
 * code is a PNG in QR_DIR (RAM), replaced when the address changes.
 *
 * CarPlay's Patch button is enabled for an unpatched or unknown state and Remove
 * patch for a patch, both only with no change pending (waze_cluster_control.js
 * canEnable/canDisable); capture is enabled while the patch daemon is
 * reachable. The app connects both sockets while one of its pages is visible
 * and closes them when it is hidden or the app shuts down; the tools keep
 * running. Moving between its pages hides one before the other shows, so a
 * hide counts only after HIDE_SETTLE_MS. waze_cluster_control.js holds the
 * protocol.
 *
 * Every word on both pages is in the HMI's display language (src/i18n.js),
 * read from HMIContext at start and on each change, which writes every row
 * again; English until then, and without it. The tile's name and the Logs
 * page's title are string ids the HMI shows itself (the RHMI text files).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const i18n = require('./i18n.js');
const { WazeClusterControl, ZOOM_STEP, SHOWN_ON } = require('./waze_cluster_control.js');
const { ProfileSync, sessionReader } = require('./profile_sync.js');
const { LogsControl, ROWS: LOGS_ROWS } = require('./logs_control.js');
const { qrPng } = require('./qr.js');
const { CameraControl } = require('./control.js');
const cameraView = require('./view_model.js');
const tripView = require('./trip_view.js');
const cameraDiagnostics = require('./diagnostics_view.js');
const atlasHome = require('./atlas-home.js');
const CenterScale = require('./atlas-center-scale.js');
const atlasDetail = require('./atlas-detail.js');
const atlasStage = require('./atlas-stage.js');
const phoneMaps = require('./atlas-phone-maps.js');
const { BmwGpsBridge } = require('./bmw_gps_bridge.js');
const { BmwNavigationBridge } = require('./bmw_navigation_bridge.js');
const { BmwSpeedBridge } = require('./bmw_speed_bridge.js');
const { BmwHoldBridge } = require('./bmw_hold_bridge.js');
const { BmwGongPlayer } = require('./bmw_gong_player.js');
const { CameraMoveRepeater } = require('./camera_move_repeater.js');

const logger = logging.getSDKLogger();

const STATE_NAME = 'ST_OnlineApps_WazeCluster';
const STATUS_NAME = 'wocStatus';
const MAP_NAME = 'wocMap';
const ENABLE_NAME = 'wocEnable';
const DISABLE_NAME = 'wocDisable';
const RESTART_NAME = 'wocRestart';
const RESTART_STATUS_NAME = 'wocRestartStatus';
const WIFI_NAME = 'wocWifi';
const WIFI_HINT_NAME = 'wocWifiHint';
const AA_STATUS_NAME = 'wocAaStatus';
const AA_ENABLE_NAME = 'wocAaEnable';
const AA_DISABLE_NAME = 'wocAaDisable';
const AA_ZOOM_NAME = 'wocAaZoom';
const AA_ZOOM_OUT_NAME = 'wocAaZoomOut';
const AA_ZOOM_IN_NAME = 'wocAaZoomIn';
const AA_CARD_NAME = 'wocAaCard';
const GUIDE_NAME = 'wocGuide';
const HEAD_GENERAL_NAME = 'wocHeadGeneral';
const HEAD_HUD_NAME = 'wocHeadHud';
const HUD_NAME = 'wocHud';
const SHOW_ON_NAME = 'wocShowOn';
const PROFILE_NAME = 'wocProfile';
const HUD_SIZE_NAME = 'wocHudSize';
const HUD_OPACITY_NAME = 'wocHudOpacity';
const HUD_POS_NAME = 'wocHudPos';
const HUD_MOVE_NAMES = { left: 'wocHudLeft', right: 'wocHudRight', up: 'wocHudUp', down: 'wocHudDown' };
const HUD_CENTRE_NAME = 'wocHudCentre';
const CAPTURE_NAME = 'wocCapture';
const CAPTURE_STATUS = 'wocCaptureStatus';
const LOGS_NAME = 'wocLogs';
const LOGS_STATE = 'ST_OnlineApps_WazeClusterLogs';
const LOGS_SAVE = 'wocLogsSave';
const LOGS_STATUS = 'wocLogsStatus';
const LOGS_QR = 'wocLogsQr';
const LOGS_URL = 'wocLogsUrl';
const CAMERA_LINK = 'wocCameras';
const CAMERA_STATE = 'ST_OnlineApps_WazeStrelkaCameras';
const DIAG_STATE = 'ST_OnlineApps_WazeStrelkaDiagnostics';
// Every native state participates in resources, visibility and overlay restore.
// Calibration has one static canonical parent (Cameras), including diagnostic entry.
const PAGE_STATES = Object.freeze({trip:'ST_OnlineApps_StrelkaTrip',atlasMenu:'ST_OnlineApps_AtlasMenu',cameraDetail:'ST_OnlineApps_StrelkaCamera',
    about:'ST_OnlineApps_StrelkaAbout',regions:'ST_OnlineApps_StrelkaRegions',main:STATE_NAME,logs:LOGS_STATE,cameras:CAMERA_STATE,diagnostics:DIAG_STATE,
    diagnosticPhoto:'ST_OnlineApps_CameraDiagnosticPhoto',
    alerts:'ST_OnlineApps_CameraAlerts',types:'ST_OnlineApps_CameraTypes',calibration:'ST_OnlineApps_CameraCalibration',
    position:'ST_OnlineApps_CameraPosition',database:'ST_OnlineApps_CameraDatabase',overspeed:'ST_OnlineApps_CameraOverspeed'});
const ATLAS_IDS = {main:1,logs:2,cameras:3,diagnostics:4,alerts:5,types:6,calibration:7,position:8,
    database:9,overspeed:11,diagnosticPhoto:12,trip:13,cameraDetail:14,about:15,regions:16,atlasMenu:17};
const ATLAS_EDITORS = ['main','alerts','calibration','position','overspeed'];
const ATLAS_RANGES={
    main:['wocHudSize','wocHudOpacity'],alerts:['cameraWarningDistance'],
    calibration:['cameraCardScale','cameraCardBrightness','cameraCardTransparency','cameraCardX','cameraCardY'],
    position:['cameraCardX','cameraCardY'],overspeed:['cameraVisualOffset','cameraSoundOffset','cameraSoundDistance','cameraSoundRepeat']
};
const ATLAS_PARENT = {main:'trip',logs:'main',cameras:'trip',diagnostics:'trip',alerts:'cameras',types:'cameras',
    calibration:'cameras',position:'calibration',database:'cameras',overspeed:'alerts',diagnosticPhoto:'diagnostics',
    cameraDetail:'trip',about:'trip',regions:'trip',atlasMenu:'trip'};
const DIAG_NAMES = cameraDiagnostics.PAGE_KEYS.map(k => 'cameraDiag_' + k).concat(['cameraDiagSelector','cameraDiagFreeze','cameraDiagTest',
    'cameraDiagCalibration','cameraDiagAudio','cameraDiagExport','cameraDiagMore','cameraDiagResultMore'], cameraDiagnostics.PHOTO_NAMES);
const CAMERA_NAMES = ['cameraStatus','cameraDatabase','cameraDate','cameraCoverage','cameraEnable','cameraUpdate','cameraRollback',
    'cameraDiagnostics','cameraAlertsLink','cameraTypesLink','cameraHudSetup','cameraMapSetup','cameraDatabaseLink','cameraOverspeedLink',
    'cameraDistanceRecommended','cameraTypesAll','cameraTypesStatus','cameraTypesHint','cameraCoverageDetails',
    'cameraCommand','cameraCommandMore','cameraResultMore','cameraAlertCommand','cameraAlertCommandMore','cameraAlertsResultMore',
    'cameraTypesCommand','cameraTypesCommandMore','cameraDatabaseCommand','cameraDatabaseCommandMore','cameraDatabaseResultMore',
    'cameraOverspeedCommand','cameraOverspeedCommandMore','cameraOverspeedResultMore'];
const PREFERENCE_NAMES = ['cameraPreferencesHead','cameraWarningDistance','cameraPreferencesStatus','cameraPreferencesHint']
    .concat(cameraView.ALERT_TYPES.map(type=>'cameraType_'+type.key));
const SOUND_REPEAT_VALUES = [0, 3, 5, 10];
const OVERSPEED_CHECKS = {cameraVisualFlash:'visualFlash',cameraSoundEnabled:'soundEnabled',cameraSoundAppear:'soundOnCameraAppear'};
const OVERSPEED_SLIDERS = {cameraVisualOffset:{key:'visualOffsetKmh',label:'Порог мигания',max:30},cameraSoundOffset:{key:'soundOffsetKmh',label:'Порог звука',max:30},
    cameraSoundDistance:{key:'soundDistanceM',label:'Дистанция контроля',max:12,format:v=>v+' м',fromSlider:step=>100+50*step,toSlider:value=>(value-100)/50},
    cameraSoundRepeat:{key:'soundRepeatSec',label:'Повтор сигнала',max:3,format:v=>v===0?'однократно':'каждые '+v+' с',fromSlider:v=>SOUND_REPEAT_VALUES[v],toSlider:v=>Math.max(0,SOUND_REPEAT_VALUES.indexOf(v))}};
const OVERSPEED_NAMES = ['cameraOverspeedHead','cameraOverspeedRecommended','cameraOverspeedStatus','cameraOverspeedHint',
    'cameraAudioStatus','cameraGpsReset','cameraGpsResetHint'].concat(Object.keys(OVERSPEED_CHECKS),Object.keys(OVERSPEED_SLIDERS));
const CARD_MOVE_NAMES = {up:'cameraCardUp',down:'cameraCardDown',left:'cameraCardLeft',right:'cameraCardRight'};
const CARD_SLIDERS = {cameraCardX:{key:'x',min:0,max:1000,label:'По горизонтали',divisor:10},
    cameraCardY:{key:'y',min:0,max:1000,label:'По вертикали',divisor:10},cameraCardScale:{key:'scalePct',min:75,max:150,label:'Размер предупреждения'},
    cameraCardBrightness:{key:'brightnessPct',min:10,max:100,label:'Яркость предупреждения'},
    cameraCardTransparency:{key:'opacityPct',min:0,max:90,label:'Прозрачность предупреждения',inverse:true}};
const CARD_NAMES = ['cameraCalibrationTitle','cameraPositionTitle','cameraHeadCalibration','cameraCardOutput','cameraCardStatus',
    'cameraCardPosition','cameraCardHint','cameraCardStorage','cameraTestStart','cameraCardSave','cameraCardReset','cameraCardBaselinePosition','cameraCardBaselineAppearance',
    'cameraPositionStatus','cameraPositionHint','cameraPositionTest','cameraPositionCommand','cameraPositionCommandMore']
    .concat(Object.values(CARD_MOVE_NAMES),Object.keys(CARD_SLIDERS),Array.from({length:30},(_,i)=>'cameraCardResultLine'+(i+3)));
const LOGS_ROW_NAMES = Array.from({ length: LOGS_ROWS }, (_, i) => `wocLogsRow${i + 1}`);
const ROW_CHARS = 90;
const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const HMI_CONTEXT = ['de.bmw.infotainment.hmi.hmicontext.HMIContext', 'HMI_CID'];
const { t } = i18n;
let cameraClientSequence = 0;
const CAMERA_TERMINAL_PHASES = ['finished','shown','error','unconfirmed','played','timeout','unavailable','outcome-unknown'];
const QR_DIR = path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(),
    `robertn_waze_cluster_qr_${typeof process.getuid === 'function' ? process.getuid() : 'x'}`);

/* A line as one row: no line breaks, at most ROW_CHARS characters. */
function oneRow(line) {
    const flat = line.replace(/\s+/g, ' ');
    return flat.length > ROW_CHARS ? `${flat.slice(0, ROW_CHARS - 1)}…` : flat;
}

/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class WazeClusterApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._pages = this._emptyPages();
        this._rhmiStates = {};
        this._appLastWallMs = null; this._appClockRollback = null;
        this._diagPage = 0; this._diagBlock = 0; this._diagServiceTab = false;
        this._diagnosticSnapshot = null;
        this._cameraFeedback = null; this._cameraCommandTimer = null;
        this._cameraPending = null; this._cameraCommandSequence = 0;
        this._cameraClientId = 'strelka-'+Date.now().toString(36)+'-'+process.pid.toString(36)+'-'+(++cameraClientSequence).toString(36);
        this._cameraResultBlock = 0; this._cameraResultText = null;
        this._cameraCardTarget = 'hud'; this._cameraCardSelectionReason = null;
        this._cameraFocusedArrow=null; this._cameraInputEvents=[]; this._cameraConsumedArrow=null; this._cameraSuppressUntil=0;
        this._cameraSuppressStartedAt=null; this._cameraHoldStop=null;
        this._shownPage = 'trip';   /* the page last shown, which shows again when the app does */
        this._hideTimer = null;
        this._qr = { url: undefined, file: null, chain: Promise.resolve() };
        this._regionChoice = null;
        this._regionPage = null;
        this._tripImage = { key: null, context: null, wantedContext: null, file: null, uploadingFile: null, pending: null, rendering: null, sequence: 0 };
        this._atlasScale = new CenterScale();
        this._atlasPanels = {};
        this._atlasSurface = null;
        this._atlasKeys = {};
        this._atlasReady = {};
        this._atlasProposals = {};
        this._atlasEditorStates = {};
        this._atlasHistory = ['trip'];
        this._atlasParents = {};
        this._atlasReturns = {};
        this._atlasRequested = null;
        // OAP runs <app>/source/javascript/app.js and registers graphics
        // from <app>/rhmiData/resources, shared with its RHMI resource bundle.
        this._atlasResources = path.resolve(__dirname, '..', '..', 'rhmiData', 'resources');
        this._atlasStage = new atlasStage.Stage(logger, name => this._atlasAction(name), () => this._renderAtlas(), null,
            command => this._focusAtlasDirection(command));
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._shuttingDown = false;
        this._activityReported = null;
        this._control = new WazeClusterControl({ log: logger });
        this._control.on('change', () => this._render());
        /* the map settings per driver profile, page shown or not */
        this._profiles = new ProfileSync({ control: this._control, log: logger, readProfile: sessionReader(someipBuilders, logger) });
        this._profiles.on('change', () => this._render());
        this._logs = new LogsControl({ log: logger });
        this._logs.on('change', () => this._renderLogs());
        this._cameraState = null;
        this._cameraInfoMode = null;
        this._cameras = new CameraControl();
        this._cameras.on('change', () => { this._refreshCameraFeedback(); this._renderCameras(); this._renderHudOpacity(); this._handleAudioRequest(); });
        this._gpsBridge = new BmwGpsBridge({ builders: someipBuilders });
        this._gongPlayer = new BmwGongPlayer({ builders: someipBuilders });
        this._lastAudioSeq = null;
        this._navigationBridge = new BmwNavigationBridge({builders:someipBuilders,control:this._gpsBridge.control});
        this._speedBridge = new BmwSpeedBridge(someipBuilders, this._gpsBridge.control);
        this._gpsBridge.on('change', () => this._syncActivity());
        this._holdBridge=new BmwHoldBridge({builders:someipBuilders});
        this._moveRepeater=new CameraMoveRepeater({guard:context=>this._cameraHeldMoveGuard(context),pending:()=>this._cameraPending,
            step:context=>{this._cameraAction('cardLayout','card-move',{target:context.target,direction:context.direction});return !!this._cameraPending;},
            onStop:reason=>{this._cameraHoldStop=reason;}});
        this._holdBridge.on('held',event=>{
            if(event.held){this._cameraConsumedArrow=event.direction;this._cameraSuppressStartedAt=null;this._cameraSuppressUntil=Infinity;this._moveRepeater.start(event.direction,event.target);}
            else{this._cameraSuppressStartedAt=Date.now();this._cameraSuppressUntil=this._cameraSuppressStartedAt+450;this._moveRepeater.stop(event.reason);}
            this._renderCameras();
        });
        this._holdBridge.on('change',()=>this._renderCameras());

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error(`robertn_waze_cluster init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) {
                this._setVisible(false);
            }
        });
    }

    _handleAudioRequest() {
        const state = this._cameras.state;
        if (!state || !state.audioRequest) return;
        const req = state.audioRequest;
        if (this._lastAudioSeq === req.seq) return;
        this._lastAudioSeq = req.seq;
        this._gongPlayer.play(req).then(
            () => this._cameras.send({ cmd: 'audio-played', seq: req.seq, played: true }),
            (error) => this._cameras.send({ cmd: 'audio-played', seq: req.seq, played: false,
                reason: String(error && error.message || error).slice(0, 160) }));
    }

    _appInitialized() {
        logger.info(`robertn_waze_cluster ${this.getAppId()} v${this._packageJson.version} starting`);
        this._profiles.start();
        // Never await GPS for RHMI startup. Its separate local IPC client and
        // background hold survive leaving this screen for CarPlay.
        Promise.resolve().then(() => { this._gpsBridge.start(); this._speedBridge.start(); this._navigationBridge.start(); this._holdBridge.start(); }).catch(() => logger.warn('BMW context bridge start failed'));
        Promise.resolve().then(() => this._gongPlayer.probe()).catch(() => logger.warn('BMW gong probe failed'));
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; initializing without a screen');
            return Promise.resolve(this.initialized()).then(() => this._syncActivity());
        }
        const foregroundStart = this._startedForeground();
        return this._setupRhmi()
            .then(() => this._setupLanguage())
            .then(() => this._registerEntryPoints())
            .then(() => {
                // A foreground start declares itself ACTIVE before initialized()
                // reports the first app status, so the manager keeps it running.
                if (foregroundStart) {
                    this.registerActive();
                }
                return this.initialized();
            })
            .then(() => {
                if (foregroundStart) {
                    this._sawForeground = true;
                    this._setVisible(true);
                }
                const lastUuid = this.getLastExecutedEntryPointUuid &&
                    this.getLastExecutedEntryPointUuid();
                return lastUuid ? this._onEntryPointExecute(lastUuid) : undefined;
            })
            // A ready GPS subscription can emit before initialized() lets us
            // report activity. Reconcile it also for a hidden RHMI start.
            .then(() => this._syncActivity());
    }

    _startedForeground() {
        const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK',
            'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.includes(reason);
    }

    /* ---- RHMI ---- */
    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        Object.keys(PAGE_STATES).forEach(page=>{this._rhmiStates[page]=rhmi.getByName(PAGE_STATES[page]);});
        const missingStates=Object.keys(PAGE_STATES).filter(page=>!this._rhmiStates[page]);
        if(missingStates.length)return Promise.reject(new Error('uiDescription lacks states: '+missingStates.join(', ')));
        this._state=this._rhmiStates.main;this._logsState=this._rhmiStates.logs;
        this._cameraState=this._rhmiStates.cameras;this._diagState=this._rhmiStates.diagnostics;
        const names = [STATUS_NAME, MAP_NAME, RESTART_STATUS_NAME, ENABLE_NAME, DISABLE_NAME, WIFI_NAME, WIFI_HINT_NAME, AA_STATUS_NAME,
            AA_ENABLE_NAME, AA_DISABLE_NAME, AA_ZOOM_NAME, AA_ZOOM_OUT_NAME, AA_ZOOM_IN_NAME, AA_CARD_NAME, RESTART_NAME, GUIDE_NAME,
            HEAD_GENERAL_NAME, HEAD_HUD_NAME, SHOW_ON_NAME, PROFILE_NAME, HUD_NAME, HUD_SIZE_NAME, HUD_OPACITY_NAME, HUD_POS_NAME]
            .concat(Object.values(HUD_MOVE_NAMES), [HUD_CENTRE_NAME, CAPTURE_NAME, CAPTURE_STATUS,
                LOGS_NAME, LOGS_SAVE, LOGS_STATUS, LOGS_QR, LOGS_URL, CAMERA_LINK], LOGS_ROW_NAMES, CAMERA_NAMES, DIAG_NAMES, CARD_NAMES, PREFERENCE_NAMES, OVERSPEED_NAMES, tripView.NAMES, Object.values(atlasDetail.names).filter(name=>rhmi.getByName(name)), ['atlasMenuOpen','atlasMenuCamera','atlasMenuMaps']);
        names.forEach((name) => { this._components[name] = rhmi.getByName(name); });
        const missing = names.filter((name) => !this._components[name]);
        if (missing.length) {
            return Promise.reject(new Error(`uiDescription lacks ${missing.join(', ')}`));
        }
        this._bind(ENABLE_NAME, () => this._control.enableMap());
        this._bind(DISABLE_NAME, () => this._control.disableMap());
        this._bind(AA_ENABLE_NAME, () => this._control.enableAa());
        this._bind(AA_DISABLE_NAME, () => this._control.disableAa());
        this._bind(AA_ZOOM_OUT_NAME, () => this._control.zoom(-ZOOM_STEP));
        this._bind(AA_ZOOM_IN_NAME, () => this._control.zoom(ZOOM_STEP));
        this._bind(AA_CARD_NAME, () => {
            /* as for the turn box: patchd's answer decides the tick */
            delete this._written[`selected:${AA_CARD_NAME}`];
            this._control.toggleCard();
        });
        this._bind(RESTART_NAME, () => this._control.requestRestart());
        this._bind(GUIDE_NAME, () => {
            /* the HMI ticks or unticks the box itself; the render's answer
             * decides what it shows */
            delete this._written[`selected:${GUIDE_NAME}`];
            this._control.toggleGuidance();
        });
        this._bind(PROFILE_NAME, () => {
            /* as for the turn box: patchd's answer decides the tick */
            delete this._written[`selected:${PROFILE_NAME}`];
            this._profiles.setOwn(!this._profiles.own);
            this._render();
        });
        /* The HMI moves the drop-down's choice and the slider itself; the
         * control's state, as asked and then as the render says, decides
         * what they show. */
        this._components[SHOW_ON_NAME].on('action', (ev) => this._press(SHOW_ON_NAME, () => {
            delete this._written[`cell:${SHOW_ON_NAME}:SelectedItem`];
            this._control.showOn(SHOWN_ON[ev && ev.row]);
            this._render();
        }));
        /* the SDK writes the slider's new step after telling it: the step it
         * shows is written again after that */
        this._components[HUD_SIZE_NAME].on('changed', (step) => {
            if (step !== this._written[`cell:${HUD_SIZE_NAME}:0:Value`]) {
                logger.info(`SLIDER ${HUD_SIZE_NAME} ${step}`);
                delete this._written[`cell:${HUD_SIZE_NAME}:0:Value`];
                this._control.setHudSizeStep(step);
                setImmediate(() => this._render());
            }
        });
        this._components[HUD_OPACITY_NAME].on('changed', (step) => {
            if(step===this._written['cell:'+HUD_OPACITY_NAME+':0:Value'])return;
            const state = this._cameras.state;
            if (state && state.capabilities && state.capabilities.hudOpacity && Number.isInteger(step) && step >= 0 && step <= 18 &&
                100 - step * 5 !== state.hudOpacityPct) {
                this._cameras.send({ cmd: 'hud-opacity', percent: 100 - step * 5 });
            }
            delete this._written[`cell:${HUD_OPACITY_NAME}:0:Value`];
            setImmediate(() => this._renderHudOpacity());
        });
        Object.keys(HUD_MOVE_NAMES).forEach((dir) => this._bind(HUD_MOVE_NAMES[dir], () => this._control.moveHud(dir)));
        this._bind(HUD_CENTRE_NAME, () => this._control.centreHud());
        this._bind(CAPTURE_NAME, () => this._control.capture());
        this._bind(LOGS_NAME, () => this._openCameraPage('logs'));
        this._bind(LOGS_SAVE, () => this._logs.save());
        this._bind(CAMERA_LINK, () => this._openCameraPage('cameras'));
        this._bind('cameraEnable', () => this._cameraCommand({ cmd: this._cameras.state && this._cameras.state.enabled ? 'disable' : 'enable' }));
        this._bind('cameraAlertsLink',()=>this._openCameraPage('alerts'));
        this._bind('cameraTypesLink',()=>this._openCameraPage('types'));
        this._bind('cameraHudSetup',()=>this._openCalibration('hud'));
        this._bind('cameraMapSetup',()=>this._openCalibration('map'));
        this._bind('cameraDatabaseLink',()=>this._openCameraPage('database'));
        this._bind('cameraOverspeedLink',()=>this._openCameraPage('overspeed'));
        this._bind('cameraCoverageDetails',()=>{this._diagPage=5;this._diagBlock=0;this._renderDiagnostics();return this._openCameraPage('diagnostics');});
        this._bind('cameraDistanceRecommended',()=>{
            if(cameraView.alertPreferences(this._cameras.state).available)this._cameraCommand({cmd:'alert-preferences',warningDistanceM:1000});
        });
        this._bind('cameraTypesAll',()=>{
            if(cameraView.alertPreferences(this._cameras.state).available){
                const types={};cameraView.ALERT_TYPES.forEach(type=>{types[type.key]=true;});
                this._cameraCommand({cmd:'alert-preferences',cameraTypes:types});
            }
        });
        this._components.cameraWarningDistance.on('changed',step=>{
            if(step===this._written['cell:'+'cameraWarningDistance'+':0:Value'])return;
            const prefs=cameraView.alertPreferences(this._cameras.state), value=50+step*50;
            if(prefs.available&&Number.isInteger(step)&&step>=0&&step<=19&&value!==prefs.warningDistanceM)
                this._cameraCommand({cmd:'alert-preferences',warningDistanceM:value});
            // Slider writes its proposed value after emitting changed. Restore
            // the confirmed service value after that write, including rejects.
            delete this._written['cell:cameraWarningDistance:0:Value'];
            setImmediate(()=>this._renderAlertPreferences());
        });
        cameraView.ALERT_TYPES.forEach(type=>{
            const name='cameraType_'+type.key;
            this._bind(name,()=>{
                const prefs=cameraView.alertPreferences(this._cameras.state);
                if(prefs.available){
                    const patch={};patch[type.key]=!prefs.cameraTypes[type.key];
                    this._cameraCommand({cmd:'alert-preferences',cameraTypes:patch});
                }
            });
            // HMI checkboxes toggle locally before action, even when _press
            // deduplicates a second delivery. Always restore the server tick.
            this._components[name].on('action',()=>{
                delete this._written['selected:'+name];
                this._renderAlertPreferences();
            });
        });
        this._bind('cameraOverspeedRecommended',()=>{
            if(cameraView.overspeedPreferences(this._cameras.state).available)
                this._cameraCommand(Object.assign({cmd:'overspeed-preferences'},cameraView.OVERSPEED_RECOMMENDED));
        });
        Object.keys(OVERSPEED_CHECKS).forEach(name=>{
            this._bind(name,()=>{
                const prefs=cameraView.overspeedPreferences(this._cameras.state),key=OVERSPEED_CHECKS[name];
                if(prefs.available){const patch={cmd:'overspeed-preferences'};patch[key]=!prefs[key];this._cameraCommand(patch);}
            });
            this._components[name].on('action',()=>{
                delete this._written['selected:'+name];this._renderOverspeedPreferences();
            });
        });
        Object.keys(OVERSPEED_SLIDERS).forEach(name=>this._components[name].on('changed',step=>{
            if(step===this._written['cell:'+name+':0:Value'])return;
            const config=OVERSPEED_SLIDERS[name],prefs=cameraView.overspeedPreferences(this._cameras.state),key=config.key;
            if(!prefs.available||!Number.isInteger(step)||step<0||step>(config.max!==undefined?config.max:30))return;
            const value=typeof config.fromSlider==='function'?config.fromSlider(step):step;
            if(Number.isInteger(value)&&value!==prefs[key]){
                const patch={cmd:'overspeed-preferences'};patch[key]=value;this._cameraCommand(patch);
            }
            delete this._written['cell:'+name+':0:Value'];setImmediate(()=>this._renderOverspeedPreferences());
        }));
        this._bind('cameraGpsReset',()=>{
            if (cameraView.canResetGps(this._cameras.state)) this._cameraCommand({cmd:'gps-reset'});
        });
        this._bind('cameraResultMore', () => this._nextCameraResult());
        this._bind('cameraDiagResultMore', () => this._nextCameraResult());
        ['cameraAlertsResultMore','cameraDatabaseResultMore','cameraOverspeedResultMore'].forEach(name=>this._bind(name,()=>this._nextCameraResult()));
        this._bind('cameraCardOutput',()=>{
            this._cameraCommand(cameraView.outputCommand(this._cameras.state,this._cameraCardTarget==='hud'?'hud':'cluster'));
        });
        this._components.cameraCardOutput.on('action',()=>{delete this._written['selected:cameraCardOutput'];this._renderCameraCard();});
        this._bind('cameraTestStart',()=>this._toggleCameraTest());
        this._bind('cameraPositionTest',()=>this._toggleCameraTest());
        this._bind('cameraCardPosition',()=>this._openCameraPage('position'));
        this._bind('cameraCardSave',()=>{
            if(this._cameraAction('displayTestStop','display-test-stop',{target:this._cameraCardTarget})&&this._cameraPending)
                this._cameraPending.returnOnSaved=true;
        });
        this._bind('cameraCardReset',()=>this._cameraAction('cardLayout','card-layout-reset',{target:this._cameraCardTarget}));
        Object.keys(CARD_MOVE_NAMES).forEach(direction=>{
            const name=CARD_MOVE_NAMES[direction],component=this._components[name];
            component.on('focus',event=>{
                const focus=event&&(event.focus!==undefined?event.focus:event.value);
                if(isTrue(focus))this._cameraFocusedArrow=direction;
                else if((focus===false||focus===0||focus==='false'||focus==='0')&&this._cameraFocusedArrow===direction)this._cameraFocusedArrow=null;
                this._syncCameraHold();
            });
            this._bind(name,()=>{
                if(this._cameraArrowSuppressed(direction))return;
                if(this._holdBridge.status().held){this._holdBridge.stopHeld('MANUAL_ARROW');this._moveRepeater.stop('MANUAL_ARROW');}
                if(this._cameraPending)return;
                const guard=this._cameraMoveGuard();
                if(!guard.allowed){this._cameraFeedback={message:guard.reason};this._renderCameras();return;}
                this._cameraAction('cardLayout','card-move',{target:this._cameraCardTarget,direction});
            });
        });
        Object.keys(CARD_SLIDERS).forEach(name=>this._components[name].on('changed',step=>{
            if(step===this._written['cell:'+name+':0:Value'])return;
            const config=CARD_SLIDERS[name], state=this._cameras.state, current=state&&state.cardLayout&&state.cardLayout[this._cameraCardTarget];
            const value=config.inverse?100-step*5:config.min+step*5;
            if(Number.isInteger(step)&&step>=0&&step<=(config.max-config.min)/5&&current&&
                value!==current[config.key]){
                const fields={target:this._cameraCardTarget};fields[config.key]=value;
                this._cameraAction('cardLayout','card-layout',fields);
            }
            delete this._written['cell:'+name+':0:Value'];
            setImmediate(()=>this._renderCameraCard());
        }));
        ['cameraDiagnostics','tripDiagnostics','tripCameraDiagnostics'].forEach(name=>
            this._bind(name, () => this._openDiagnostics()));
        this._bind('atlasMenuOpen', () => this._openCameraPage('atlasMenu'));
        this._bind('atlasMenuCamera', () => this._openCameraPage('cameraDetail'));
        this._bind('atlasMenuMaps', () => this._openCameraPage('main'));
        Object.keys(tripView.COMMANDS).forEach(name =>
            this._bind(name, () => this._openCameraPage(tripView.COMMANDS[name])));
        this._bind('cameraDiagFreeze', () => {
            const snapshot = cameraDiagnostics.capture(this._cameraDiagnosticState(), this._packageJson.version, Date.now());
            this._atlasPanels.diagnosticPhoto = {sheet:0,edit:null};
            const rows = cameraDiagnostics.photoRows(snapshot, snapshot.state.serviceReady,
                this._diagnosticCameraTarget());
            this._diagnosticSnapshot = snapshot;
            this._renderDiagnostics();
            cameraDiagnostics.PHOTO_NAMES.forEach((name, index) => this._write(name, rows[index]));
            return this._openCameraPage('diagnosticPhoto');
        });
        this._components.tripRegionSelector.on('action',event=>{
            const row=event&&event.row, view=this._regionView();
            if(Number.isInteger(row) && view.rows[row]){
                this._regionChoice=view.rows[row].region;
                this._regionPage=null;
            }
            delete this._written['cell:tripRegionSelector:SelectedItem'];
            this._renderRegions();
        });
        this._bind('tripRegionPage', () => {
            const view=this._regionView();
            this._regionPage=(view.index+1)%view.pages;
            this._renderRegions();
        });
        this._bind('tripRegionRefresh', () => this._regionalCommand('regional-list'));
        this._bind('tripRegionDownload', () => this._regionalCommand('regional-download'));
        this._bind('tripRegionRollback', () => this._regionalCommand('regional-rollback'));
        this._components.cameraDiagSelector.on('action',event=>{
            const row=event&&event.row;
            if(Number.isInteger(row)&&row>=0&&row<cameraDiagnostics.PAGE_TITLES.length){
                this._diagPage=row;this._diagBlock=0;this._diagServiceTab=event.serviceTab===true && row===0;
            }
            delete this._written['cell:cameraDiagSelector:SelectedItem'];this._renderDiagnostics();
        });
        this._bind('cameraDiagTest', () => {if(this._startCameraTest(false,true))return this._openCameraPage('calibration');});
        this._bind('cameraDiagCalibration', () => {if(this._startCameraTest(true,true))return this._openCameraPage('calibration');});
        this._bind('cameraDiagAudio', () => this._cameraAction('audioTest','audio-test'));
        this._bind('cameraDiagExport', () => this._exportDiagnostic());
        this._bind('cameraDiagMore', () => {
            const page=cameraDiagnostics.reportPage(null,this._cameraDiagnosticState(),this._packageJson.version,this._diagPage,this._diagBlock);
            this._diagBlock=(this._diagBlock+1)%page.blocks;
            if(page.blocks===1)this._cameraFeedback={message:'Все строки этой страницы уже показаны'};
            this._renderDiagnostics();
        });
        this._bind('cameraUpdate', () => this._cameraAction('databaseCheck','database-check'));
        this._bind('cameraRollback', () => this._cameraAction('databaseRollback','database-rollback'));
        // Presses also arrive as the application's raw 'userEvent'; both paths
        // land in _press, which keeps a press delivered twice to one.
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry && (!this._atlasSurface || entry.name.indexOf('atlasKey'+this._atlasSurface+'_')===0)) {
                this._press(entry.name, entry.handler);
                if(entry.name.indexOf('cameraType_')===0){
                    delete this._written['selected:'+entry.name];
                    this._renderAlertPreferences();
                }
                if(Object.prototype.hasOwnProperty.call(OVERSPEED_CHECKS,entry.name)){
                    delete this._written['selected:'+entry.name];this._renderOverspeedPreferences();
                }
            }
        });
        this._setupAtlasControls();
        rhmi.on('applicationStackChanged', (stack) => {
            // The app holds the foreground while the stack has a ROOT_APP slot;
            // the empty stack seen during startup is ignored.
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (!keys.length) {
                return;
            }
            if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) {
                this._sawForeground = true;
                this._setVisible(true);
            } else if (this._sawForeground) {
                this._setVisible(false);
            }
        });
        rhmi.on('restoreHmi', () => {
            logger.info('RESTORE_HMI: re-pushing page content');
            this._written = {};
            this._qr.url = undefined;
            this._hideAtlas();
            this._atlasReady = {};
            this._render();
            this._renderLogs();
            this._renderCameras();
        });
        Object.keys(this._rhmiStates).forEach(page=>{
            const state=this._rhmiStates[page];
            state.on('visible',event=>this._atlasVisible(page,false,isTrue(event&&event.visible)));
            state.on('focus',event=>{
                const focus=event&&(event.focus!==undefined?event.focus:event.value);
                if(page==='position'&&(focus===false||focus===0||focus==='false'||focus==='0'))this._cancelCameraHold('PAGE_FOCUS_LOST');
            });
        });
        this._removeStaleQr();
        try {
            fs.readdirSync(this._atlasResources).filter(name=>/^atlas_strelka-[a-z0-9-]+_[0-9]+\.png$/.test(name))
                .forEach(name=>fs.unlinkSync(path.join(this._atlasResources,name)));
        } catch(error) { if(error.code!=='ENOENT')logger.warn('Atlas resources: '+error.message); }
        return Promise.resolve().then(() => {
            logger.info(`page ready: ${names.length} components found`);
            this._render();
            this._renderLogs();
            this._renderCameras();
        });
    }

    /* The words follow the HMI's display language: read at start and on
     * each change; English until then, and without it. Never holds up the
     * start. */
    _setupLanguage() {
        logger.info(`languages: en ${i18n.codes().join(' ')}`);
        const [iface, instance] = HMI_CONTEXT;
        let proxy;
        Promise.resolve()
            .then(() => someipBuilders.buildTypedProxy(iface, instance))
            .then((p) => { proxy = p; return proxy.init(); })
            .then(() => proxy.waitUntilAvailable())
            .then(() => proxy.currentDisplayLanguage.subscribe((v) => this._displayLanguage(v)))
            .then(() => proxy.currentDisplayLanguage.getValue())
            .then((v) => this._displayLanguage(v))
            .catch((err) => logger.warn(`display language unavailable from ${iface}: ${err && err.message}`));
    }

    _displayLanguage(value) {
        if (i18n.setHmiLanguage(value)) {
            logger.info(`display language ${value}: ${i18n.language()}`);
            this._render();
            this._renderLogs();
            this._renderCameras();
        }
    }

    _bind(name, handler) {
        const comp = this._components[name];
        let id = null;
        try {
            id = comp.getId();
        } catch (e) {
            id = null;
        }
        if (id !== null) {
            this._actionById[Number(id)] = { name, handler };
        }
        logger.info(`BIND OK: ${name} (id ${id})`);
        comp.on('action', event => {if(Object.values(CARD_MOVE_NAMES).indexOf(name)>=0)this._recordCameraInput(name,event);this._press(name, handler);});
    }

    _press(name, handler) {
        const now = this._observeAppClock();
        const elapsed=now-this._lastPress[name];
        if (Object.prototype.hasOwnProperty.call(this._lastPress,name)&&elapsed>=0&&elapsed<PRESS_DEDUPE_MS) {
            return;
        }
        this._lastPress[name] = now;
        logger.info(`BUTTON ACTION ${name}`);
        try {
            handler();
        } catch (err) {
            logger.warn(`${name} failed: ${err && err.message}`);
        }
    }

    _emptyPages() {
        const pages={};Object.keys(PAGE_STATES).forEach(page=>{pages[page]=false;});return pages;
    }

    _cancelCameraHold(reason) {
        this._cameraFocusedArrow=null;
        if(this._holdBridge)this._holdBridge.stopHeld(reason);
        if(this._moveRepeater)this._moveRepeater.stop(reason);
        this._syncCameraHold();
    }

    _observeAppClock() {
        const now=Date.now(),previous=this._appLastWallMs;
        // Record before synchronous held/change listeners render again.
        this._appLastWallMs=now;
        if(Number.isFinite(previous)&&now<previous){
            this._appClockRollback={previousWallMs:previous,wallMs:now,deltaMs:now-previous};
            this._cancelCameraHold('CLOCK_ROLLBACK');
            this._cameraConsumedArrow=null;this._cameraSuppressStartedAt=null;this._cameraSuppressUntil=0;
        }
        return now;
    }

    _cameraArrowSuppressed(direction) {
        this._observeAppClock();
        if(this._cameraConsumedArrow!==direction)return false;
        if(this._holdBridge.status().held)return true;
        const elapsed=Date.now()-this._cameraSuppressStartedAt;
        // A release recorded in the old wall epoch cannot suppress a new press.
        return Number.isFinite(this._cameraSuppressStartedAt)&&elapsed>=0&&elapsed<450;
    }

    _openCameraPage(page) {
        if(!PAGE_STATES[page]||this._shutdownPromise)return Promise.resolve(false);
        this._cancelCameraHold('NAVIGATION');
        if(this._cameraPending&&page!=='calibration')this._cameraPending.returnOnSaved=false;
        return this._navigateAtlas(page, false);
    }

    _openDiagnostics() {
        this._atlasPanels.diagnostics = {sheet:0,edit:null};
        this._diagPage = 0; this._diagBlock = 0; this._diagServiceTab = false;
        this._diagnosticSnapshot = null;
        this._cameras.send({ cmd: 'status' }); this._renderDiagnostics();
        return this._openCameraPage('diagnostics');
    }

    _openCalibration(target) {
        if(target!=='hud'&&target!=='map')return Promise.resolve(false);
        this._flushAtlasInput();
        this._cancelCameraHold('TARGET_CHANGED');
        this._cameraCardTarget=target;this._cameraCardSelectionReason=null;
        this._renderCameraCard();
        // Selecting a profile never mutates settings or replaces another preview.
        return this._openCameraPage('calibration');
    }

    _toggleCameraTest() {
        const test=(this._cameras.state||{}).displayTest||{};
        return test.active&&test.target===this._cameraCardTarget?
            this._cameraAction('displayTestStop','display-test-stop',{target:this._cameraCardTarget}):this._startCameraTest(false);
    }

    /* The app manager inserts the public tile from application.json and hands
     * it to the app at start; the SDK emits 'entryPointExecute' on a tap. */
    _registerEntryPoints() {
        const descriptions = (this.appDescription &&
            this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find(
            (ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._rhmiStates.trip))
            .then(() => Promise.resolve()
                .then(() => ours.entryPoint.setText(description.textId))
                .then(() => (description.icon ? ours.entryPoint.setIcon(description.icon) : undefined))
                .catch((err) => logger.warn(`entry point text/icon: ${err && err.message}`)))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info(`entry point ${description.name} ENABLED`));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._sawForeground = true;
        /* the tile opens the main page, whichever page the app was left on;
         * its stack change may have come first and opened the Logs page's socket */
        this._hideAtlas();
        this._atlasSurface = null;
        this._atlasPanels = {};
        this._atlasHistory = ['trip'];
        this._atlasParents = {};
        this._atlasReturns = {};
        this._atlasRequested = 'trip';
        this._shownPage = 'trip';
        this._pages = this._emptyPages();
        this._logs.close();
        this._cancelCameraHold('ENTRY_POINT');
        this._setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .then(() => {
                // On reselecting the active tile some head units acknowledge
                // the open without another visibility event for the same state.
                if(this._visible && this._atlasRequested==='trip' && !this._atlasSurface)
                    this._atlasVisible('trip',false,true);
            })
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    /* ---- visibility ---- */
    /* One page shown or hidden. The logs socket follows the Logs page; the
     * app counts as hidden once neither page has shown for HIDE_SETTLE_MS. */
    _pageVisible(page, visible) {
        if (this._shutdownPromise) {
            return;
        }
        if(!Object.prototype.hasOwnProperty.call(PAGE_STATES,page))return;
        this._pages[page] = visible;
        if (!visible && this._shownPage === page) this._hideAtlas();
        if(page==='position'&&!visible||visible&&page!=='position')this._cancelCameraHold('PAGE_CHANGED');
        if(page==='calibration'&&!visible&&this._cameraPending)this._cameraPending.returnOnSaved=false;
        this._syncCameraHold();
        if (visible) {this._shownPage = page;this._syncCameraHold();}
        if (page === 'main' && visible) this._profiles.refresh();
        if (page === 'logs') {
            if (visible) {
                this._logs.open();
            } else {
                this._logs.close();
            }
        }
        if (page !== 'main' && page !== 'logs') {
            if (visible) this._cameras.open();
        }
        clearTimeout(this._hideTimer);
        this._hideTimer = null;
        if (visible) {
            this._sawForeground = true;
            this._setVisible(true);
            if (page === 'trip' || page === 'cameraDetail') this._renderTrip();
            if (page === 'regions') this._renderRegions();
            if (page !== 'trip') this._renderAtlas();
        } else if (!Object.keys(this._pages).some(key=>this._pages[key])) {
            this._hideTimer = setTimeout(() => {
                this._hideTimer = null;
                this._setVisible(false);
            }, HIDE_SETTLE_MS);
        }
    }

    _setVisible(visible) {
        clearTimeout(this._hideTimer);this._hideTimer=null;
        if (!visible) {
            this._atlasStage.forgetForeground();
            this._hideAtlas();
            this._pages = this._emptyPages();
            this._cancelCameraHold('APP_HIDDEN');
            if(this._cameraPending)this._cameraPending.returnOnSaved=false;
            this._logs.close();
            this._cameras.close();
        }
        if (this._shutdownPromise || this._visible === visible) {
            return;
        }
        this._visible = visible;
        logger.info(`page ${visible ? 'visible' : 'hidden'}`);
        this._reportVisibilityStatus(visible);
        if (visible) {
            this._control.open();
            this._cameras.open();
            if(Object.prototype.hasOwnProperty.call(this._pages,this._shownPage))this._pages[this._shownPage]=true;
            /* back from an overlay or another app on the Logs page, which
             * says nothing of its own */
            if (this._shownPage === 'logs') {
                this._pages.logs = true;
                this._logs.open();
            }
            this._syncCameraHold();
            this._renderAtlas();
        } else {
            this._control.close();
            this._cameras.close();
        }
    }

    _reportVisibilityStatus(visible) {
        if (!this._initialized || !this._appStatusService) {
            return;
        }
        this._syncActivity();
        Promise.resolve().then(() => visible ? this.registerHmiVisible() : this.unregisterHmiVisible())
            .catch(() => logger.warn('app HMI visibility report failed'));
    }

    _syncActivity() {
        if (!this._initialized || !this._appStatusService || this._shuttingDown) return;
        const active = this._visible || this._gpsBridge.shouldHold();
        if (this._activityReported === active) return;
        this._activityReported = active;
        Promise.resolve().then(() => active ? this.registerActive() : this.registerInactive())
            .catch(() => { this._activityReported = null; logger.warn('app activity report failed'); });
    }

    /* ---- rendering ---- */
    /* Writes text into a component's row unless it already shows it. */
    _write(name, text) {
        if (this._written[name] !== text) {
            this._written[name] = text;
            Promise.resolve(this._components[name].setValue(0, 'Text', text, 'Text'))
                .catch((err) => logger.warn(`${name} render failed: ${err && err.message}`));
        }
    }

    /* Writes a cell unless it already holds that value: a cell of the
     * component's (row null) or of its row. The slider's value goes through
     * the slider's own setStepValue, which keeps its step in step with it. */
    _writeCell(name, cell, value, type, row) {
        const key = `cell:${name}:${row == null ? '' : `${row}:`}${cell}`;
        if (this._written[key] !== value) {
            this._written[key] = value;
            const comp = this._components[name];
            Promise.resolve(cell === 'Value' && comp.setStepValue ? comp.setStepValue(value)
                : row == null ? comp.setValue(cell, value, type) : comp.setValue(row, cell, value, type))
                .catch((err) => logger.warn(`${name} ${cell} failed: ${err && err.message}`));
        }
    }

    /* Enables a component unless it already holds that state (the
     * drop-down and the slider have no setEnabled, only the property). */
    _setEnabled(name, enabled) {
        const key = `enabled:${name}`;
        if (this._written[key] !== enabled) {
            this._written[key] = enabled;
            const comp = this._components[name];
            Promise.resolve(comp.setEnabled ? comp.setEnabled(enabled) : comp.setProperty('Enabled', enabled ? 1 : 0, 'UInt'))
                .catch((err) => logger.warn(`${name} enable failed: ${err && err.message}`));
        }
    }

    /* Shows or hides a component unless it already holds that state. */
    _setVisibleComp(name, visible) {
        const key = `visible:${name}`;
        if (this._written[key] !== visible) {
            this._written[key] = visible;
            const component=this._components[name];
            Promise.resolve(component.setVisible?component.setVisible(visible):component.setProperty('Visible',visible?1:0,'UInt'))
                .catch((err) => logger.warn(`${name} visibility failed: ${err && err.message}`));
        }
    }

    /* Ticks or unticks a checkbox unless it already holds that state. */
    _setSelected(name, selected) {
        const key = `selected:${name}`;
        if (this._written[key] !== selected) {
            this._written[key] = selected;
            Promise.resolve(this._components[name].setValue(0, 'eParam_RowSelected', selected, 'Bool'))
                .catch((err) => logger.warn(`${name} select failed: ${err && err.message}`));
        }
    }

    _render() {
        if (!this._state || this._shutdownPromise) {
            return;
        }
        const c = this._control;
        [[ENABLE_NAME, t('Patch')], [DISABLE_NAME, t('Remove patch')], [AA_ENABLE_NAME, t('Patch')], [AA_DISABLE_NAME, t('Remove patch')],
            [AA_ZOOM_OUT_NAME, t('Zoom out')], [AA_ZOOM_IN_NAME, t('Zoom in')], [HEAD_GENERAL_NAME, t('General')], [LOGS_NAME, t('Logs')],
            [HEAD_HUD_NAME, t('HUD')], [CAMERA_LINK, t('Cameras')],
            [HUD_MOVE_NAMES.left, t('Move left')], [HUD_MOVE_NAMES.right, t('Move right')], [HUD_MOVE_NAMES.up, t('Move up')],
            [HUD_MOVE_NAMES.down, t('Move down')], [HUD_CENTRE_NAME, t('Centre')],
            [RESTART_NAME, t('Restart head unit')]].forEach(([name, text]) => this._write(name, text));
        this._write(STATUS_NAME, c.statusText());
        this._write(MAP_NAME, c.mapText());
        this._write(AA_STATUS_NAME, c.aaStatusText());
        this._write(AA_ZOOM_NAME, c.zoomText());
        this._write(AA_CARD_NAME, c.cardText());
        this._setSelected(AA_CARD_NAME, c.cardHidden());
        this._write(CAPTURE_NAME, c.captureButtonText());
        this._write(CAPTURE_STATUS, c.captureText());
        [[ENABLE_NAME, c.canEnable()], [DISABLE_NAME, c.canDisable()],
            [AA_ENABLE_NAME, c.canEnableAa()], [AA_DISABLE_NAME, c.canDisableAa()],
            [AA_ZOOM_OUT_NAME, c.canZoom(-ZOOM_STEP)], [AA_ZOOM_IN_NAME, c.canZoom(ZOOM_STEP)],
            [AA_CARD_NAME, c.canToggleCard()], [CAPTURE_NAME, c.canCapture()], [RESTART_NAME, c.canRestart()]]
            .forEach(([name, enabled]) => this._setEnabled(name, enabled));
        const restartText = c.restartText();
        this._setVisibleComp(RESTART_NAME, c.restartNeeded() || c.restartRequested());
        this._write(RESTART_STATUS_NAME, restartText);
        this._setVisibleComp(RESTART_STATUS_NAME, restartText !== '');
        const wifi = c.wifiText(), hint = c.wifiHint();
        this._write(WIFI_NAME, wifi);
        this._setVisibleComp(WIFI_NAME, wifi !== '');
        this._write(WIFI_HINT_NAME, hint);
        this._setVisibleComp(WIFI_HINT_NAME, hint !== '');
        const hide = c.hideGuidance();
        const unavailable = c.guidanceUnavailable();
        /* where the map shows: the choice, '—' in its place while there is none */
        const shownOn = SHOWN_ON.indexOf(c.shownOn());
        this._writeCell(SHOW_ON_NAME, 'HeaderText', t('Show on'), 'Text');
        [t('Cluster'), t('HUD (experimental)'), t('Cluster and HUD (experimental)'), t('Off')].forEach((text, row) =>
            this._writeCell(SHOW_ON_NAME, 'ItemText', row === 0 && shownOn < 0 ? '—' : text, 'Text', row));
        this._writeCell(SHOW_ON_NAME, 'SelectedItem', Math.max(shownOn, 0), 'UInt');
        this._setEnabled(SHOW_ON_NAME, c.canChooseShownOn());
        const profiles = this._profiles;
        this._write(PROFILE_NAME, t('Own settings for this driver'));
        this._setSelected(PROFILE_NAME, profiles.ownShown());
        this._setEnabled(PROFILE_NAME, profiles.canChooseOwn());
        /* the turn box's hold follows the map on the cluster */
        this._setEnabled(GUIDE_NAME, hide !== null && !unavailable && c.clusterOn() !== false);
        this._write(GUIDE_NAME, t("Hide BMW's turn box"));
        this._setSelected(GUIDE_NAME, !!hide && !unavailable);
        this._write(HUD_NAME, c.hudText());
        /* the size slider and the place buttons: greyed while the HUD is off
         * or disabled (the HMI greys no label) */
        const adjust = c.canChangeHudSize();
        this._writeCell(HUD_SIZE_NAME, 'TextDescription', c.hudSizeText(), 'Text', 0);
        if (c.hudSizeStep() !== null) {
            this._writeCell(HUD_SIZE_NAME, 'Value', c.hudSizeStep(), 'SInt', 0);
        }
        this._setEnabled(HUD_SIZE_NAME, adjust);
        this._write(HUD_POS_NAME, c.hudPositionText());
        Object.values(HUD_MOVE_NAMES).forEach((n) => this._setEnabled(n, adjust));
        this._setEnabled(HUD_CENTRE_NAME, c.canCentreHud());
        this._renderHudOpacity();
        if (this._shownPage === 'main') this._renderAtlas();
    }

    _renderHudOpacity() {
        if (!this._state || !this._components[HUD_OPACITY_NAME] || this._shutdownPromise) return;
        const state = this._cameras.state;
        const supported = !!(state && state.capabilities && state.capabilities.hudOpacity &&
            Number.isFinite(state.hudOpacityPct) && state.hudOpacityPct >= 10 && state.hudOpacityPct <= 100);
        this._setEnabled(HUD_OPACITY_NAME, supported);
        this._writeCell(HUD_OPACITY_NAME, 'TextDescription', supported ?
            'Прозрачность HUD: ' + (100 - state.hudOpacityPct) + ' %' : 'Прозрачность HUD: сервис недоступен', 'Text', 0);
        this._writeCell(HUD_OPACITY_NAME, 'Value', supported ? Math.round((100 - state.hudOpacityPct) / 5) : 0, 'SInt', 0);
    }

    _cameraCommand(message) {
        if(message&&message.cmd==='card-move'&&this._cameraPending)return;
        if(message&&message.cmd!=='card-move'){
            if(this._holdBridge.status().held)this._holdBridge.stopHeld('OTHER_COMMAND');
            this._moveRepeater.stop('OTHER_COMMAND');this._syncCameraHold();
        }
        clearTimeout(this._cameraCommandTimer); this._cameraCommandTimer=null;
        this._cameraPending=null;
        if (!message) {
            this._cameraFeedback={message:'Действие недоступно: сервис не подтвердил управление выходом'};
            this._renderCameras(); return;
        }
        this._cameraInfoMode = null;
        const requestId=this._cameraClientId+'-'+(++this._cameraCommandSequence).toString(36);
        const commandName={'regional-list':'проверка списка регионов','regional-download':'обновление пакета',
            'regional-rollback':'откат пакета','display-test':'тест предупреждения','calibration-test':'проверка границ',
            'display-test-stop':'сохранение и остановка теста','card-layout':'настройка предупреждения',
            'card-layout-reset':'сброс настроек предупреждения','card-move':'положение предупреждения',
            'alert-preferences':'настройки предупреждений','overspeed-preferences':'настройки превышения',
            'gps-reset':'сброс истории GPS; ожидайте свежие координаты'}[message.cmd]||message.cmd;
        const targetName=message.target==='map'?'приборы':message.target==='hud'?'HUD':null;
        const pending={message:'Ожидание ответа: '+commandName+(targetName?' • '+targetName:''),command:message.cmd,target:message.target,requestId,pending:true};
        this._cameraFeedback=pending; this._cameraPending=pending;
        if (!this._cameras.send(Object.assign({},message,{requestId}))) {
            this._cameraPending=null; this._cameraFeedback={message:this._cameras.diagnostic()};
        }
        else {
            this._cameraCommandTimer=setTimeout(()=>{
                this._cameraCommandTimer=null;
                if(this._cameraPending===pending){
                    pending.pending=false; pending.awaiting=true;
                    pending.message='Нет окончательного подтверждения: '+commandName+'; проверьте связь и обновите сервис';
                    this._cameraFeedback=pending;
                    if(pending.command==='card-move'){
                        this._cameraPending=null;this._cancelCameraHold('MOVE_ACK_TIMEOUT');
                    }
                    this._renderCameras();
                }
            },6000);
            if(this._cameraCommandTimer.unref)this._cameraCommandTimer.unref();
        }
        this._renderCameras();
        return this._cameraPending===pending?requestId:null;
    }

    _cameraAction(name,command,fields) {
        const a=cameraDiagnostics.action(this._cameras.state,name);
        if(!a.allowed){
            this._cameraFeedback={message:a.reason||'Действие недоступно ('+a.code+')'};
            this._renderCameras(); return null;
        }
        return this._cameraCommand(Object.assign({cmd:command},fields||{}));
    }

    _diagnosticCameraTarget() {
        const outputs=(this._cameras.state||{}).outputs||{};
        if(this._cameraCardTarget==='map'&&outputs.cluster===true||this._cameraCardTarget==='hud'&&outputs.hud===true)
            return this._cameraCardTarget;
        return outputs.cluster===true?'map':outputs.hud===true?'hud':null;
    }

    _cameraTestGuard(target) {
        const state=this._cameras.state, allowed=cameraDiagnostics.action(state,'displayTest');
        if(!allowed.allowed)return allowed;
        if(!target)return {allowed:false,reason:'Для теста включите приборы или HUD'};
        const output=target==='map'?'cluster':'hud';
        return state.outputs&&state.outputs[output]===true?allowed:
            {allowed:false,reason:(output==='hud'?'Проекция HUD':'Приборная панель')+' выключена. Откройте «Вывод и состав» и включите этот выход.'};
    }

    _startCameraTest(calibration,fromDiagnostics) {
        const target=fromDiagnostics?this._diagnosticCameraTarget():this._cameraCardTarget;
        const allowed=this._cameraTestGuard(target);
        this._cameraCardSelectionReason=allowed.allowed?null:allowed.reason;
        if(!allowed.allowed){this._cameraFeedback={message:allowed.reason};this._renderCameras();return null;}
        if(fromDiagnostics&&target!==this._cameraCardTarget)this._cameraCardTarget=target;
        return this._cameraAction(calibration?'calibrationTest':'displayTest',calibration?'calibration-test':'display-test',
            {target});
    }

    _syncCameraHold() {
        if(!this._holdBridge)return;
        const state=this._cameras.state||{},test=state.displayTest||{},renderer=state.rendererDetails||{},stationary=cameraDiagnostics.action(this._cameras.state,'cardLayout');
        this._holdBridge.setContext({visible:!!this._pages.position&&this._shownPage==='position'&&!this._shutdownPromise,focusedDirection:this._cameraFocusedArrow,target:this._cameraCardTarget,
            stationary:stationary.allowed===true,activeTest:test.active===true&&test.target===this._cameraCardTarget,
            serviceReady:this._cameras.link==='up'&&renderer.connection==='ready'});
    }
    _cameraHeldMoveGuard(context) {
        const state=this._cameras.state||{},test=state.displayTest||{},renderer=state.rendererDetails||{},hold=this._holdBridge.status(),profile=(state.cardLayout||{})[context.target];
        if(!hold.held||!this._pages.position||this._shownPage!=='position'||this._cameraFocusedArrow!==context.direction||this._cameraCardTarget!==context.target||!test.active||test.target!==context.target||renderer.connection!=='ready')return {allowed:false,reason:'CONTEXT_LOST'};
        const still=cameraDiagnostics.action(this._cameras.state,'cardLayout');if(!still.allowed)return still;
        if(!profile)return {allowed:false,reason:'PROFILE_UNAVAILABLE'};
        if((context.direction==='left'&&profile.x<=0)||(context.direction==='right'&&profile.x>=1000)||(context.direction==='up'&&profile.y<=0)||(context.direction==='down'&&profile.y>=1000))return{allowed:false,reason:'EDGE_REACHED'};
        const allowed=this._cameraMoveGuard();
        if(!allowed.allowed&&allowed.reason==='Дождитесь подтверждения текущих настроек изображения')return {allowed:false,waiting:true,reason:'RENDER_CONFIRMATION'};
        return allowed;
    }
    _recordCameraInput(name,event) {
        // Local diagnostic metadata only. No arbitrary SDK objects, strings,
        // coordinates, pointers or secrets are serialized.
        const safe={};for(const key of ['type','subType','subtype','actionType','value','row','pressed','long','keyCode','code']){
            let value;try{value=event&&event[key];}catch(ignored){continue;}
            if(typeof value==='boolean'||Number.isFinite(value)||typeof value==='string'&&/^[A-Za-z0-9_.-]{1,32}$/.test(value))safe[key]=value;
        }
        for(const key of ['args','parameters','parameterMap']){
            const value=event&&event[key],fields={};
            if(value instanceof Map)value.forEach((v,k)=>{if(/^\d{1,2}$/.test(String(k))&&(typeof v==='boolean'||Number.isFinite(v)))fields[k]=v;});
            else if(value&&typeof value==='object')Object.keys(value).slice(0,16).forEach(k=>{const v=value[k];if(/^\d{1,2}$/.test(k)&&(typeof v==='boolean'||Number.isFinite(v)))fields[k]=v;});
            if(Object.keys(fields).length)safe[key]=fields;
        }
        this._cameraInputEvents.push({at:new Date().toISOString(),component:name,data:safe});if(this._cameraInputEvents.length>6)this._cameraInputEvents.shift();
    }
    _cameraDiagnosticState() {
        const wallMs=this._observeAppClock();
        const serviceReady=this._cameras.link==='up' && !!this._cameras.state;
        return Object.assign({},serviceReady ? this._cameras.state : null,{serviceReady,appClock:{wallMs,wallUtc:new Date(wallMs).toISOString(),
            clockDiscontinuity:!!this._appClockRollback,lastRollback:this._appClockRollback&&Object.assign({},this._appClockRollback)},
            calibrationInput:{controller:this._holdBridge.status(),repeat:this._moveRepeater.status(),focusedDirection:this._cameraFocusedArrow,
            stopReason:this._cameraHoldStop,touchHoldConfirmed:false,events:this._cameraInputEvents.map(e=>Object.assign({},e))}});
    }

    _cameraMoveGuard() {
        const state=this._cameras.state||{}, guard=cameraDiagnostics.action(this._cameras.state,'cardMove'), test=state.displayTest||{},
            renderer=state.rendererDetails||{}, layout=(renderer[this._cameraCardTarget]||{}).layout||{};
        if(!guard.allowed)return guard;
        if(!test.active||test.target!==this._cameraCardTarget)return {allowed:false,reason:'Для перемещения покажите тест на выбранном выходе'};
        if(renderer.connection!=='ready')return {allowed:false,reason:'Перемещение: ожидание соединения renderer'};
        if(!layout.canvas||layout.withinBounds!==true)return {allowed:false,reason:'Перемещение: ожидаются размеры и границы изображения'};
        const profile=(state.cardLayout||{})[this._cameraCardTarget], rendered=layout.settings;
        if(!profile||!rendered||['x','y','scalePct','brightnessPct','opacityPct'].some(key=>profile[key]!==rendered[key]))
            return {allowed:false,reason:'Дождитесь подтверждения текущих настроек изображения'};
        return guard;
    }

    _renderCameraCard() {
        this._syncCameraHold();
        if(!this._cameraState||this._shutdownPromise)return;
        const state=this._cameras.state||{}, target=this._cameraCardTarget, profile=state.cardLayout&&state.cardLayout[target],
            test=state.displayTest||{}, guard=cameraDiagnostics.action(this._cameras.state,'cardLayout'), storage=state.storage||{},
            name=target==='hud'?'HUD':'Приборы', move=this._cameraMoveGuard(), feedback=this._cameraFeedback,
            cardFeedback=feedback&&feedback.target===target&&(/^(card-|display-test|calibration-test)/.test(feedback.command||''));
        this._write('cameraCalibrationTitle','Яндекс Стрелка · Настройка '+name);
        this._write('cameraPositionTitle','Яндекс Стрелка · Положение '+name);
        this._write('cameraHeadCalibration',name+' • настройка на стоянке');
        this._write('cameraCardOutput','Вывод предупреждений на '+name);
        this._setSelected('cameraCardOutput',!!(state.outputs||{})[target==='hud'?'hud':'cluster']);
        this._setEnabled('cameraCardOutput',!!(state.capabilities||{}).outputs);
        const ownTest=test.active&&test.target===target;
        this._write('cameraTestStart',ownTest?'Скрыть тест '+name:'Показать тест '+name+' • до остановки');
        this._write('cameraPositionTest',ownTest?'Скрыть тест '+name:'Показать тест '+name);
        this._write('cameraCardSave','Готово • сохранить и скрыть тест');
        this._write('cameraCardBaselinePosition','Базовый '+name+': X 50 % • Y '+(target==='hud'?'82':'88')+' %');
        this._write('cameraCardBaselineAppearance','Размер 100 % • яркость 100 % • прозрачность 0 %');
        this._write('cameraCardReset','Базовый профиль '+name+' • не проверен на X6M');
        this._write('cameraCardStatus',this._cameraCardSelectionReason||
            (cardFeedback&&(feedback.pending||feedback.awaiting||CAMERA_TERMINAL_PHASES.includes(feedback.phase))?
                cameraDiagnostics.commandPage(null,feedback.message,0).command:null)||
            (test.active?'Тест: '+(test.target==='hud'?'HUD':'Приборы')+' • '+(test.pinned?'закреплён до остановки':'показан'):
                'Тест скрыт • профиль '+name));
        this._write('cameraCardPosition',profile?'Положение: X '+(profile.x/10).toFixed(1)+' % • Y '+(profile.y/10).toFixed(1)+' %':
            'Настройки предупреждения: сервис не сообщил профиль');
        this._write('cameraCardHint',move.allowed?(this._holdBridge.status().state==='ready'?'Контроллер: удерживайте стрелку • сенсор: ползунки X/Y':'Быстро: ползунки X/Y • стрелки: один шаг'):
            move.reason||'Покажите тест на выбранном выходе для перемещения');
        this._write('cameraPositionStatus',profile?name+' • X '+(profile.x/10).toFixed(1)+' % • Y '+(profile.y/10).toFixed(1)+' %':name+' • профиль недоступен');
        this._write('cameraPositionHint',move.allowed?'Сенсор: X/Y • iDrive: короткое нажатие; удержание при подтверждённом вводе':move.reason);
        this._write('cameraCardStorage',!profile?'Обновите сервис для настройки предупреждения':
            !guard.allowed?guard.reason||'Настройка доступна на стоянке со свежей скоростью':
            storage.settingsSaved===true&&storage.persistent===true?'Изменения сохранены в автомобиле':
            storage.persistent===false?'Изменения временные • хранилище недоступно':'Изменения сохраняются после подтверждения сервиса');
        Object.keys(CARD_MOVE_NAMES).forEach(direction=>this._write(CARD_MOVE_NAMES[direction],
            {up:'↑ Выше',down:'↓ Ниже',left:'← Левее',right:'Правее →'}[direction]));
        Object.keys(CARD_SLIDERS).forEach(component=>{
            const config=CARD_SLIDERS[component], value=profile&&profile[config.key], supported=Number.isFinite(value),
                display=config.inverse?100-value:value;
            this._writeCell(component,'TextDescription',config.label+': '+(supported?(config.divisor?(display/config.divisor).toFixed(1):display)+' %':'нет данных'),'Text',0);
            this._writeCell(component,'Value',supported?Math.round((display-config.min)/5):0,'SInt',0);
            this._setEnabled(component,!!profile&&guard.allowed);
        });
        const held=this._holdBridge.status(),waitingForRenderer=move.reason==='Дождитесь подтверждения текущих настроек изображения';
        Object.keys(CARD_MOVE_NAMES).forEach(direction=>this._setEnabled(CARD_MOVE_NAMES[direction],move.allowed||
            held.held&&held.direction===direction&&held.target===target&&guard.allowed&&test.active&&test.target===target&&waitingForRenderer));
        ['cameraTestStart','cameraPositionTest','cameraCardPosition','cameraCardSave','cameraCardReset'].forEach(component=>this._setEnabled(component,true));
    }

    _refreshCameraFeedback() {
        const pending=this._cameraPending;
        if(!pending)return;
        const state=this._cameras.state||{}, preview=(state.displayTest||{}).result;
        const result=preview&&preview.requestId===pending.requestId&&preview.command===pending.command?
            preview:state.commandResult;
        if(this._cameras.commandError&&this._cameras.commandErrorRequestId===pending.requestId){
            this._cameraFeedback={message:'Ошибка: '+this._cameras.commandError,requestId:pending.requestId,
                command:pending.command,target:pending.target,phase:'error'};
        }else if(result&&result.requestId===pending.requestId&&result.command===pending.command){
            if(CAMERA_TERMINAL_PHASES.indexOf(result.phase)<0){
                // Acknowledgement is not completion. Preserve the original terminal deadline.
                if(pending.pending){pending.message=cameraDiagnostics.commandText({commandResult:result});this._cameraFeedback=pending;}
                return;
            }
            // Keep this request's complete result even if a late result from another client arrives.
            this._cameraFeedback={message:cameraDiagnostics.commandText({commandResult:result}),requestId:pending.requestId,
                command:pending.command,target:pending.target,phase:result.phase};
        }else return;
        if(pending.command==='card-move'&&this._cameraFeedback.phase==='error')this._moveRepeater.stop('MOVE_REJECTED');
        this._cameraPending=null;
        clearTimeout(this._cameraCommandTimer); this._cameraCommandTimer=null;
        if(pending.returnOnSaved&&this._pages.calibration&&this._shownPage==='calibration'&&
            this._cameraFeedback.phase==='finished'){
            const state=this._cameras.state||{};
            if(state.displayTest&&state.displayTest.active===false&&state.storage&&state.storage.settingsSaved===true&&state.storage.persistent===true)
                this._openCameraPage('cameras');
            else if(!state.storage||state.storage.settingsSaved!==true||state.storage.persistent!==true)
                this._cameraFeedback.message+=' • Сохранение в автомобиле не подтверждено; оставайтесь в настройке';
            else this._cameraFeedback.message+=' • Остановка теста не подтверждена; оставайтесь в настройке';
        }
    }

    _cameraResultView() {
        const local=this._cameraFeedback&&this._cameraFeedback.message;
        const text=cameraDiagnostics.commandText(this._cameras.state,local);
        if(text!==this._cameraResultText){this._cameraResultText=text;this._cameraResultBlock=0;}
        const result=cameraDiagnostics.commandPage(this._cameras.state,local,this._cameraResultBlock);
        this._cameraResultBlock=result.block;
        return result;
    }

    _nextCameraResult() {
        const result=this._cameraResultView();
        this._cameraResultBlock=(result.block+1)%result.blocks;
        this._renderCameras(); this._renderDiagnostics();
    }

    _exportDiagnostic() {
        try {
            if(!this._diagnosticSnapshot&&!this._cameras.state)throw new Error('Нет снимка или ответа сервиса');
            const report=this._diagnosticSnapshot||cameraDiagnostics.capture(this._cameraDiagnosticState(),this._packageJson.version,Date.now());
            const payload=JSON.stringify(report,null,2)+'\n';
            if(Buffer.byteLength(payload,'utf8')>262144)throw new Error('Отчёт больше 256 КБ; экспорт отменён');
            if(!fs.existsSync(QR_DIR))fs.mkdirSync(QR_DIR,0o700);
            const dir=path.join(QR_DIR,'diagnostics');
            if(!fs.existsSync(dir))fs.mkdirSync(dir,0o700);
            if(fs.lstatSync(QR_DIR).isSymbolicLink()||fs.lstatSync(dir).isSymbolicLink())throw new Error('Небезопасный каталог отчёта');
            const file=path.join(dir,'diagnostic-'+report.id+'.json');
            if(fs.existsSync(file)){
                if(fs.lstatSync(file).isSymbolicLink()||fs.readFileSync(file,'utf8')!==payload)throw new Error('Файл отчёта уже существует с другими данными');
            }else {
                if(fs.readdirSync(dir).filter(name=>/^diagnostic-S[A-Z0-9-]+\.json$/.test(name)).length>=20)
                    throw new Error('Сохранено 20 временных отчётов; новые снимки не записаны');
                fs.writeFileSync(file,payload,{flag:'wx',mode:0o600});
            }
            this._cameraFeedback={message:'JSON '+report.id+' сохранён локально в RAM; не отправлен. Путь: '+file};
            this._lastDiagnosticExport=file;
        }catch(err){this._cameraFeedback={message:'Экспорт: '+String(err.message||err).slice(0,150)};}
        this._renderDiagnostics();
    }

    _renderAlertPreferences() {
        if(!this._cameraState||this._shutdownPromise)return;
        const state=this._cameras.state, prefs=cameraView.alertPreferences(state), feedback=this._cameraFeedback;
        this._write('cameraPreferencesHead','Предупреждения о камерах');
        this._writeCell('cameraWarningDistance','TextDescription',prefs.available?
            'Предупреждать за: '+prefs.warningDistanceM+' м':'Дистанция: нет подтверждённых данных','Text',0);
        this._writeCell('cameraWarningDistance','Value',prefs.available?(prefs.warningDistanceM-50)/50:19,'SInt',0);
        this._setEnabled('cameraWarningDistance',prefs.available);
        const summary=!prefs.available?prefs.reason:prefs.enabledCount===0?'Все типы выключены — предупреждений не будет':
            'Типы включены: '+prefs.enabledCount+'/'+cameraView.ALERT_TYPES.length+' • дистанция '+prefs.warningDistanceM+' м';
        const temporary=state&&state.storage&&state.storage.persistent===false?' • настройки временные':'';
        this._write('cameraPreferencesStatus',summary+temporary);
        this._write('cameraPreferencesHint',prefs.available?feedback&&feedback.command==='alert-preferences'?
            feedback.message:'У комплекса достаточно любого включённого типа':'Нужен обновлённый сервис и подтверждённые настройки');
        this._write('cameraDistanceRecommended','Рекомендуется: дистанция 1000 м');this._setEnabled('cameraDistanceRecommended',prefs.available);
        this._write('cameraTypesAll','Включить все 11 типов • рекомендуется');this._setEnabled('cameraTypesAll',prefs.available);
        this._write('cameraTypesStatus',summary+temporary);
        this._write('cameraTypesHint',!prefs.available?prefs.reason:'У комплекса достаточно любого включённого типа');
        cameraView.ALERT_TYPES.forEach(type=>{
            const name='cameraType_'+type.key;
            this._write(name,type.label+(prefs.available?'':' • нет данных'));
            this._setEnabled(name,prefs.available);
            this._setSelected(name,prefs.available?prefs.cameraTypes[type.key]:false);
        });
    }

    _renderOverspeedPreferences() {
        if(!this._cameraState||this._shutdownPromise)return;
        const state=this._cameras.state,prefs=cameraView.overspeedPreferences(state),feedback=this._cameraFeedback;
        const temporary=state&&state.storage&&state.storage.persistent===false?' • настройки временные':'';
        this._write('cameraOverspeedHead','Превышение скорости');
        this._write('cameraOverspeedRecommended','Рекомендуется: мигание +0, звук выкл (+20)');
        this._setEnabled('cameraOverspeedRecommended',prefs.available);
        this._write('cameraOverspeedStatus',!prefs.available?prefs.reason:
            'Мигание '+(prefs.visualFlash?'вкл':'выкл')+' • звук выбран '+(prefs.soundEnabled?'вкл':'выкл')+temporary);
        this._write('cameraOverspeedHint',feedback&&feedback.command==='overspeed-preferences'?feedback.message:
            'Знак не меняется. 60/+20: сигнал только свыше 80 км/ч');
        this._write('cameraVisualFlash','Мигание при превышении');
        this._write('cameraSoundEnabled','Включать звуковой сигнал');
        this._write('cameraSoundAppear','Сигнал при появлении камеры');
        Object.keys(OVERSPEED_CHECKS).forEach(name=>{
            this._setEnabled(name,prefs.available);this._setSelected(name,prefs.available?prefs[OVERSPEED_CHECKS[name]]:false);
        });
        Object.keys(OVERSPEED_SLIDERS).forEach(name=>{
            const config=OVERSPEED_SLIDERS[name],value=prefs.available?prefs[config.key]:null;
            const shown=config.toSlider&&value!==null?config.toSlider(value):value;
            this._writeCell(name,'TextDescription',config.label+': '+(value===null?'нет подтверждённых данных':
                config.format?config.format(value):'+'+value+' км/ч'),'Text',0);
            this._writeCell(name,'Value',value===null?0:shown,'SInt',0);
            this._setEnabled(name,prefs.available);
        });
        this._write('cameraAudioStatus','Звук '+(prefs.audioAvailable?'доступен':'недоступен')+': '+prefs.audioReason);
        this._renderGpsReset(state, feedback);
    }

    _renderGpsReset(state, feedback) {
        const resetAvailable = cameraView.canResetGps(state);
        const reset = state && state.gpsReset || {};
        const clock = state && state.clock || {};
        const reference = cameraView.gpsClockReference(clock);
        this._write('cameraGpsReset', 'Сбросить историю GPS');
        this._setEnabled('cameraGpsReset', resetAvailable);
        let hint = 'Для сброса истории GPS обновите сервис камер';
        if (cameraView.gpsClockWaiting(clock)) {
            hint = 'Автосверка GPS: ожидание независимых часов';
        } else if (resetAvailable && feedback && feedback.command === 'gps-reset') {
            hint = feedback.message;
        } else if (clock.referenceState === 'ready' && reference) {
            hint = `Опора GPS: ${reference}` + (state.gpsFix ? '' : ' • ожидание свежего RMC BMW');
        } else if (resetAvailable) {
            hint = reset.reason || reset.message || 'После сброса GPS дождитесь свежих координат';
        }
        this._write('cameraGpsResetHint', hint);
    }

    _renderCameras() {
        this._observeAppClock();
        if (!this._cameraState || this._shutdownPromise) return;
        this._renderTrip();
        this._renderRegions();
        const view = cameraView.model(this._cameras.state);
        if (!this._cameras.state) view.text.cameraStatus = this._cameras.diagnostic();
        if (this._cameraInfoMode === 'diagnostics') view.text.cameraInfo = this._cameras.state ? cameraView.diagnostics(this._cameras.state) : this._cameras.diagnostic();
        const result=this._cameraResultView();
        view.text.cameraCommand=result.command; view.text.cameraCommandMore=result.commandMore;
        view.text.cameraResultMore=result.label;
        Object.keys(view.text).filter(name=>this._components[name]&&name!=='cameraCommand'&&name!=='cameraCommandMore').forEach((name) => this._write(name, view.text[name]));
        Object.keys(view.enabled).filter(name=>this._components[name]).forEach((name) => this._setEnabled(name, view.enabled[name]));
        // Calibration already has eight task controls. Its full result uses
        // native, scrollable reading rows rather than a ninth paging action.
        // Native results are <=300 chars; transport errors are <=1024 chars.
        const commandLines=cameraDiagnostics.commandLines(result.text);
        this._write('cameraCommand',commandLines[0]);this._write('cameraCommandMore',commandLines[1]||' ');
        for(let i=2;i<32;i++){
            const name='cameraCardResultLine'+(i+1);this._write(name,commandLines[i]||' ');this._setVisibleComp(name,i<commandLines.length);
        }
        this._write('cameraStatus',cameraView.hubSummary(this._cameras.state));
        const update=(this._cameras.state||{}).databaseUpdate||{};
        if(update.message)this._write('cameraCoverage',update.message+' • '+view.text.cameraCoverage);
        this._write('cameraUpdate',update.busy?'Проверка базы выполняется':'Проверить / продолжить');
        const links={cameraDiagnostics:'Диагностика',cameraAlertsLink:'Оповещения',cameraTypesLink:'Типы камер',
            cameraHudSetup:'HUD',cameraMapSetup:'Приборы',cameraDatabaseLink:'База',cameraOverspeedLink:'Мигание и звук',cameraCoverageDetails:'Подробности покрытия'};
        Object.keys(links).forEach(name=>{this._write(name,links[name]);this._setEnabled(name,true);});
        // Each action page carries its own immediate result; diagnostics retains
        // the complete paged message.
        [['cameraAlertCommand','cameraAlertCommandMore','cameraAlertsResultMore'],
            ['cameraTypesCommand','cameraTypesCommandMore'],['cameraDatabaseCommand','cameraDatabaseCommandMore','cameraDatabaseResultMore'],
            ['cameraOverspeedCommand','cameraOverspeedCommandMore','cameraOverspeedResultMore'],
            ['cameraPositionCommand','cameraPositionCommandMore']].forEach(names=>{
                this._write(names[0],result.command);this._write(names[1],result.commandMore);
                if(names[2]){this._write(names[2],result.label);this._setEnabled(names[2],true);}
            });
        this._setEnabled('cameraResultMore',true);
        this._renderAlertPreferences();
        this._renderOverspeedPreferences();
        this._renderCameraCard();
        this._renderDiagnostics();
        if (this._shownPage !== 'trip') this._renderAtlas();
    }

    _regionView() {
        return tripView.regionsModel(this._cameras.link === 'up' ? this._cameras.state : null, this._regionChoice, this._regionPage);
    }

    _regionalCommand(command) {
        const view=this._regionView();
        if (!view.data || view.busy || (command !== 'regional-list' && !this._mayChangeRegion())) return;
        if (command === 'regional-download' && !view.download) return;
        if (command === 'regional-rollback' && !view.rollback) return;
        const request = {cmd:command};
        if (command !== 'regional-list') request.region=view.selected.region;
        this._cameraCommand(request);
    }

    _mayChangeRegion() {
        const state=this._cameras.state;
        return cameraDiagnostics.action(state,'databaseCheck').allowed && cameraDiagnostics.action(state,'cardLayout').allowed;
    }

    _renderRegions() {
        const view=this._regionView(), canChange=this._mayChangeRegion();
        Object.keys(view.text).forEach(name=>this._write(name,view.text[name]));
        if (view.data && !view.busy && !canChange)
            this._write('tripRegionStatus',view.text.tripRegionStatus+' • действия на стоянке');
        this._writeCell('tripRegionSelector','HeaderText','Регион','Text');
        for (let i=0;i<tripView.REGION_ROWS;i++) {
            const entry=view.rows[i];
            this._writeCell('tripRegionSelector','ItemText',entry ? tripView.regionName(entry) : '—','Text',i);
        }
        this._writeCell('tripRegionSelector','SelectedItem',Math.max(0,view.selectedRow),'UInt');
        this._setEnabled('tripRegionSelector',view.rows.length>0);
        this._setEnabled('tripRegionPage',view.pages>1);
        const available=!!view.data && !view.busy;
        this._setEnabled('tripRegionRefresh',available);
        this._setEnabled('tripRegionDownload',available && canChange && view.download);
        this._setEnabled('tripRegionRollback',available && canChange && view.rollback);
        const state=this._cameras.state||{};
        const feedback=this._cameraFeedback, result=state.commandResult;
        const response=feedback&&/^regional-/.test(feedback.command||'')?feedback:result&&/^regional-/.test(result.command||'')?result:null;
        this._write('tripRegionResult',response&&response.message?'Команда: '+oneRow(response.message):tripView.speedcamStatus(state.database,state.speedcamDownload));
        if (this._shownPage === 'regions') this._renderAtlas();
    }

    _renderTrip() {
        if (!this._rhmiStates.trip || this._shutdownPromise) return;
        // The control clears state when the live service disconnects.
        const view = tripView.model(this._cameras.link === 'up' ? this._cameras.state : null, this._packageJson.version);
        Object.keys(view.text).forEach(name => this._write(name, view.text[name]));
        if (this._shownPage === 'trip') this._renderAtlas();
    }

    _setupAtlasControls() {
        const rhmi=this.rhmiApplication;
        Object.keys(ATLAS_IDS).forEach(page=>{
            const surfaces=ATLAS_EDITORS.indexOf(page)>=0?[false,true]:[false];
            surfaces.forEach(edit=>{
                const stem=(edit?'Edit':'')+ATLAS_IDS[page];
                if(edit){
                    const state=rhmi.getByName(PAGE_STATES[page]+'_AtlasEditor');
                    this._atlasEditorStates[page]=state;
                    state.on('visible',e=>this._atlasVisible(page,true,isTrue(e&&e.visible)));
                }
                const size=page==='trip'?8:9;
                ['atlasFrame','atlasStatus'].forEach(prefix=>{
                    const name=prefix+stem;
                    this._components[name]=rhmi.getByName(name);
                });
                if(page!=='trip'){
                    const name='atlasSection'+stem, picker=rhmi.getByName(name);
                    this._components[name]=picker;
                    picker.on('action',event=>{
                        if(!this._visible || this._atlasSurface!==stem || this._atlasStage.front&&this._atlasStage.owns())return;
                        const row=event&&event.row, sections=atlasHome.railTargets(page);
                        if(!Number.isInteger(row)||!sections[row])return;
                        this._atlasAction(sections[row].command);
                    });
                }
                (ATLAS_RANGES[page]||[]).forEach(source=>{
                    const name='atlasRange'+stem+'_'+source, control=rhmi.getByName(name);
                    this._components[name]=control;
                    control.on('changed',step=>{
                        if(!this._visible||this._atlasSurface!==stem||this._atlasStage.front&&this._atlasStage.owns())return;
                        const key='cell:'+name+':0:Value';
                        const previous=this._atlasProposals[name];
                        if(step===this._written[key]){
                            if(previous)clearTimeout(previous.timer);
                            delete this._atlasProposals[name];
                            return;
                        }
                        const command='atlasValue:'+source+':'+step, stage=this._atlasStage;
                        if(!Number.isInteger(step)||!stage.view||!atlasStage.actionTarget(page,stage.view,command))return;
                        if(previous)clearTimeout(previous.timer);
                        const generation=this._tripImage.generation, profile=this._cameraCardTarget;
                        const proposal={send:()=>{
                            if(this._atlasProposals[name]!==proposal)return;
                            clearTimeout(proposal.timer);
                            delete this._atlasProposals[name];
                            if(this._atlasSurface!==stem||this._tripImage.generation!==generation||
                                this._cameraCardTarget!==profile)return;
                            delete this._written[key];
                            this._atlasAction(command);
                            this._renderAtlas();
                        }};
                        this._atlasProposals[name]=proposal;
                        proposal.timer=setTimeout(proposal.send,125);
                    });
                });
                for(let i=0;i<size;i++){
                    const name='atlasKey'+stem+'_'+i, component=rhmi.getByName(name);
                    this._components[name]=component;
                    const press=()=>{
                        if(!this._visible || this._atlasSurface!==stem || this._atlasStage.front&&this._atlasStage.owns())return;
                        const target=this._atlasKeys[name];
                        if(target&&target.enabled!==false)this._atlasAction(target.command);
                    };
                    component.on('action',()=>this._press(name,press));
                    this._actionById[Number(component.getId())]={name,handler:press};
                    component.on('focus',event=>{
                        const target=this._atlasKeys[name];
                        if(this._atlasSurface!==stem || !target || this._atlasStage.front&&this._atlasStage.owns())return;
                        const focus=event&&(event.focus===undefined?event.value:event.focus);
                        if(isTrue(focus)){
                            this._atlasStage.nativeFocus(target.focusKey||target.command);
                            this._focusAtlasDirection(target.command);
                        }else if([false,0,'false','0'].includes(focus) && CARD_MOVE_NAMES[this._cameraFocusedArrow]===target.command){
                            this._focusAtlasDirection(null);
                        }
                    });
                }
            });
        });
    }

    _focusAtlasDirection(command) {
        if(this._shownPage!=='position')return;
        const direction=Object.keys(CARD_MOVE_NAMES).find(dir=>CARD_MOVE_NAMES[dir]===command)||null;
        if(this._cameraFocusedArrow===direction)return;
        this._cameraFocusedArrow=direction;
        this._syncCameraHold();
    }

    _navigateAtlas(page,edit) {
        const name=PAGE_STATES[page]+(edit?'_AtlasEditor':'');
        const origin=this._shownPage;
        if(!edit&&origin!==page && this._atlasHistory.indexOf(page)<0)this._atlasParents[page]=origin;
        this._atlasRequested=page;
        return Promise.resolve(this.rhmiApplication.openState(name)).then(()=>{
            if(this._visible && this._atlasRequested===page && this._atlasSurface!==(edit?'Edit':'')+ATLAS_IDS[page])
                this._atlasVisible(page,edit,true);
            return true;
        },error=>{
            if(this._atlasRequested===page)this._atlasRequested=null;
            logger.warn('Atlas navigation: '+(error&&error.message));
            return false;
        });
    }

    _atlasVisible(page,edit,visible) {
        const stem=(edit?'Edit':'')+ATLAS_IDS[page];
        if(!visible && this._atlasSurface!==stem)return;
        if(!visible || this._atlasSurface!==stem)this._flushAtlasInput();
        if(visible){
            const last=this._atlasHistory[this._atlasHistory.length-1];
            const origin=this._atlasParents[last];
            const cameraPanel=this._atlasPanels.cameraDetail;
            if(!edit && !this._atlasRequested && last==='cameraDetail' && page==='trip' && cameraPanel && cameraPanel.cameraOutput){
                const restore=cameraPanel.cameraFrom==='cameraDetail';
                this._atlasPanels.cameraDetail={sheet:0,edit:null};
                if(restore){this._navigateAtlas('cameraDetail',false);return;}
            }
            if(!edit && !this._atlasRequested && page===ATLAS_PARENT[last] && this._resumeAtlasSection(last))return;
            if(!edit && !this._atlasRequested && origin && page===ATLAS_PARENT[last] && page!==origin){
                // BMW's Back selects the statically declared parent. A section
                // also reachable from another tile returns to its actual caller.
                this._navigateAtlas(origin,false);
                return;
            }
            this._atlasRequested=null;
            if(this._atlasSurface!==stem)this._hideAtlas();
            this._atlasSurface=stem;
            const previous=this._atlasHistory.lastIndexOf(page);
            if(previous>=0)this._atlasHistory.length=previous+1;
            else this._atlasHistory.push(page);
            if(!edit && this._atlasPanels[page] && this._atlasPanels[page].edit){
                this._atlasStage.focus[page]='atlasEdit:'+this._atlasPanels[page].edit;
                this._atlasPanels[page].edit=null;
            }
            this._pages=this._emptyPages();
        }else{
            this._atlasSurface=null;
        }
        this._pageVisible(page,visible);
    }

    _flushAtlasInput() {
        this._atlasStage.finishNudge(true);
        Object.values(this._atlasProposals).forEach(proposal=>proposal.send());
    }

    _hideAtlas() {
        Object.values(this._atlasProposals).forEach(proposal=>clearTimeout(proposal.timer));
        this._atlasProposals={};
        this._atlasStage.set(null, null, null);
        this._tripImage.key=null;
        this._tripImage.context=null;
        this._tripImage.wantedContext=null;
        this._tripImage.pending=null;
        this._tripImage.generation=(this._tripImage.generation||0)+1;
    }

    _resumeAtlasSection(page) {
        const caller=this._atlasReturns[page];
        if(!caller)return false;
        delete this._atlasReturns[page];
        this._atlasPanels[caller.page]=caller.panel;
        if(caller.page==='calibration'||caller.page==='position'||caller.panel.cameraOutput)this._cameraCardTarget=caller.target;
        this._atlasStage.focus[caller.page]=caller.focus;
        this._navigateAtlas(caller.page,!!caller.panel.edit);
        return true;
    }

    _atlasAction(name) {
        const page=this._shownPage,stage=this._atlasStage;
        if (!this._visible || !this._pages[page] || stage.page!==page || !stage.view) return;
        if(!name.startsWith('atlasValue:'))this._flushAtlasInput();
        const item=atlasStage.actionTarget(page,stage.view,name);
        if(!item)return;
        if(name==='atlasCameraOpen'){
            this._atlasPanels.cameraDetail={sheet:0,edit:null,cameraOutput:'center',cameraFrom:page};
            stage.focus.cameraDetail='atlasCameraOutput:center';
            if(page==='cameraDetail'){this._renderAtlas();return;}
            return this._openCameraPage('cameraDetail');
        }
        const cameraPanel=page==='cameraDetail'&&this._atlasPanels.cameraDetail;
        if(cameraPanel && cameraPanel.cameraOutput){
            if(name==='atlasCameraClose'||name==='atlasBack'){
                const previous=cameraPanel.cameraFrom;
                this._atlasPanels.cameraDetail={sheet:0,edit:null};
                stage.focus[previous]='atlasCameraOpen';
                if(previous==='cameraDetail'){this._renderAtlas();return;}
                return this._openCameraPage('trip');
            }
            if(name.startsWith('atlasCameraOutput:')){
                const target=name.slice('atlasCameraOutput:'.length);
                if(!['center','hud','map'].includes(target))return;
                stage.cancelTouch(false);
                cameraPanel.cameraOutput=target;
                cameraPanel.cameraAdjust=false;
                if(target!=='center'){
                    this._cancelCameraHold('TARGET_CHANGED');
                    this._cameraCardTarget=target;
                    this._cameraCardSelectionReason=null;
                    this._renderCameraCard();
                }
                this._renderAtlas();return;
            }
            const scale=/^atlasValue:(atlasCenterCameraScale|cameraCardScale):([0-9]+)$/.exec(name);
            if(scale){
                const slider=stage.view.buttons.find(b=>b.kind==='slider'&&b.source===scale[1]);
                const step=Number(scale[2]);
                if(!slider||!slider.enabled||step>slider.max)return;
                if(cameraPanel.cameraOutput==='center'&&scale[1]==='atlasCenterCameraScale'){
                    try{this._atlasScale.set(scale[1],step);}catch(err){logger.warn('Atlas camera size: '+err.message);}
                }else if(scale[1]==='cameraCardScale'&&this._cameraCardTarget===cameraPanel.cameraOutput){
                    this._cameraAction('cardLayout','card-layout',{target:this._cameraCardTarget,scalePct:75+5*step});
                }
                this._renderAtlas();return;
            }
            if(name==='atlasCameraSlider'){
                cameraPanel.cameraAdjust=!cameraPanel.cameraAdjust;
                this._renderAtlas();return;
            }
        }
        if(name==='atlasExit'){
            return this.rhmiApplication.closeState(PAGE_STATES.trip)
                .then(()=>{if(stage.focus.trip==='atlasExit')delete stage.focus.trip;})
                .catch(error=>logger.warn('Atlas exit: '+error.message));
        }
        if(item.kind==='section'){
            const destination=item.destination;
            if(destination==='trip'){
                this._atlasParents={};
                this._atlasReturns={};
                this._atlasHistory=['trip'];
            }else if(destination!==page){
                const panel=Object.assign({sheet:0,edit:null},this._atlasPanels[page]);
                this._atlasReturns[destination]={page,panel,target:this._cameraCardTarget,
                    focus:panel.edit?'atlasSlider:'+panel.edit:stage.contentFocus[page]};
            }
            delete stage.focus[destination];
            this._atlasPanels[destination]={sheet:0,edit:null};
            if(destination==='diagnostics'){this._diagPage=0;this._diagBlock=0;this._diagServiceTab=false;this._diagnosticSnapshot=null;}
            this._openCameraPage(destination);
            return;
        }
        if(page==='main' && (name.startsWith('atlasMap') || name.startsWith('atlasValue:atlasCenterMapScale:'))){
            const panel=this._atlasPanels.main || {sheet:0,edit:null};
            let command=name;
            if(command==='atlasMapCancel'){
                delete panel.mapConfirm;
            }else if(command==='atlasMapConfirm'){
                command=panel.mapConfirm || '';
                delete panel.mapConfirm;
                if(!atlasStage.actionTarget(page,stage.view,command))return;
            }
            if(command.startsWith('atlasMapOutput:')){
                if(name!== 'atlasMapConfirm' && !(stage.front && stage.owns())){
                    panel.mapConfirm=command;
                }else{
                    const parts=command.split(':');
                    this._control.setMapOutput(parts[1],parts[2]==='1');
                }
            }else{
                const step=phoneMaps.stepFor(command,this._atlasScale.get('atlasCenterMapScale'));
                if(Number.isInteger(step) && step>=0 && step<=12){
                    try { this._atlasScale.set('atlasCenterMapScale',step); }
                    catch(error) { logger.warn('Atlas map preview scale: '+error.message); }
                }
            }
            this._atlasPanels.main=panel;
            this._renderAtlas();
            return;
        }
        if(name==='atlasCompositionOpen:hud'||name==='atlasCompositionOpen:map'){
            this._atlasPanels.calibration={sheet:2,edit:null};
            this._openCalibration(name.split(':')[1]);
            return;
        }
        if(name.indexOf('atlasComposition:')===0){
            if(page!=='calibration' || typeof item.selected!=='boolean')return;
            this._cameraAction('cardLayout','card-composition',{
                target:this._cameraCardTarget,key:name.slice('atlasComposition:'.length),value:!item.selected
            });
            return;
        }
        const panel=this._atlasPanels[page]||{sheet:0,edit:null};
        if(page==='main' && name==='atlasBack' && !panel.edit && panel.sheet>0){
            this._atlasPanels.main={sheet:0,edit:null};
            stage.focus.main='atlasSheet:1';
            this._renderAtlas();
            return;
        }
        if(name==='atlasBack'&&!panel.edit){
            if(this._resumeAtlasSection(page))return;
            const from=this._atlasHistory[this._atlasHistory.length-2]||ATLAS_PARENT[page];
            if(from)this._navigateAtlas(from,false);
            return;
        }
        const next=page!=='trip'&&atlasDetail.reducePanel(panel,name==='atlasBack'?'atlasEditClose':name,stage.view);
        if(next){
            this._atlasPanels[page]=next;
            if(!!next.edit!==!!panel.edit && this._atlasEditorStates[page]){
                stage.focus[page]=next.edit?'atlasSlider:'+next.edit:'atlasEdit:'+panel.edit;
                this._navigateAtlas(page,!!next.edit).then(opened=>{
                    if(!opened){this._atlasPanels[page]=panel;this._renderAtlas();}
                });
            }else this._renderAtlas();
            return;
        }
        const value=/^atlas(Value|Choice):([A-Za-z0-9_]+):([0-9]+)$/.exec(name);
        if(value){
            const component=this._components[value[2]];
            if(!component || !(panel.edit===value[2] || item.kind==='slider'&&item.source===value[2]) ||
                this._written['enabled:'+value[2]]===false)return;
            const step=Number(value[3]);
            if(value[1]==='Value'){
                const key='cell:'+value[2]+':0:Value';
                const confirmed=this._written[key];
                component.emit('changed',step);
                if(Number.isInteger(confirmed) && this._written[key]===undefined)
                    this._writeCell(value[2],'Value',confirmed,'SInt',0);
            }else component.emit('action',{row:step});
            this._renderAtlas();
            return;
        }
        let command = name, event = {};
        if (name==='atlasDiagnostic:service' || /^atlasDiagnostic:[0-9]+$/.test(name)) {
            if (this._shownPage !== 'diagnostics') return;
            const serviceTab=name==='atlasDiagnostic:service';
            const row = serviceTab ? 0 : Number(name.slice('atlasDiagnostic:'.length));
            if (row >= cameraDiagnostics.PAGE_TITLES.length) return;
            command = 'cameraDiagSelector';
            event = {row,serviceTab};
        } else if (name.indexOf('atlasRegion:') === 0) {
            if (this._shownPage !== 'regions') return;
            const code = name.slice('atlasRegion:'.length);
            const row = this._regionView().rows.findIndex(entry => entry.region === code);
            if (row < 0) return;
            command = 'tripRegionSelector';
            event = {row};
        }
        const component = this._components[command];
        if (component && this._written['enabled:' + command] !== false) component.emit('action', event);
    }

    _renderAtlas() {
        const page = this._shownPage, home = page === 'trip';
        if (!this._visible || !this._pages[page] || this._shuttingDown || !this._rhmiStates[page]) return;
        const stem=this._atlasSurface;
        if(!stem)return;
        const name='atlasFrame'+stem;
        if (!this._components[name]) return;
        const state = this._cameras.link === 'up' ? this._cameras.state : null;
        const view = home ? atlasHome.model(state, this._packageJson.version, this._atlasScale.get('atlasCenterCameraScale')) : atlasDetail.model(page, {
            state, version:this._packageJson.version, written:this._written, serviceReady:!!state, atlasPanel:this._atlasPanels[page],
            phoneMaps:page==='main' ? phoneMaps.status(this._control,this._atlasScale) : null,
            mapInteractive:page==='main' && this._atlasStage.front && this._atlasStage.owns(),
            centralCameraScalePct:this._atlasScale.get('atlasCenterCameraScale'),centralScaleError:this._atlasScale.error,
            region:page === 'regions' ? this._regionView() : null, snapshot:this._diagnosticSnapshot,
            diagnosticService:this._diagServiceTab,
            target:this._cameraCardTarget, testGuard:this._cameraTestGuard(this._cameraCardTarget), diagnosticState:page === 'diagnostics' ? this._cameraDiagnosticState() : null
        });
        if (!view) return;
        const signature = JSON.stringify(view);
        this._atlasStage.set(page, view, signature);
        const focus = this._atlasStage.focus[page] || (home ? 'tripCamera' : '');
        const images = this._tripImage;
        const interactive=this._atlasStage.owns()&&this._atlasStage.front;
        const items=atlasStage.targets(page,view);
        if(!home){
            const name='atlasSection'+stem, sections=atlasHome.railTargets(page);
            this._writeCell(name,'HeaderText','Раздел','Text');
            sections.forEach((entry,row)=>this._writeCell(name,'ItemText',entry.label,'Text',row));
            this._writeCell(name,'SelectedItem',sections.findIndex(entry=>entry.selected),'UInt');
            this._setVisibleComp(name,!interactive);
        }
        (ATLAS_RANGES[page]||[]).forEach(source=>{
            const name='atlasRange'+stem+'_'+source;
            const range=items.find(item=>item.kind==='slider'&&item.source===source);
            if(range){
                this._writeCell(name,'TextDescription',range.label+' · '+range.value,'Text',0);
                if(Number.isInteger(range.step)&&!this._atlasProposals[name])this._writeCell(name,'Value',range.step,'SInt',0);
                this._setEnabled(name,range.enabled!==false);
            }
            this._setVisibleComp(name,!!range&&!interactive);
        });
        const count=home?8:9;
        for(let i=0;i<count;i++){
            const slot='atlasKey'+stem+'_'+i, target=items[i]&&items[i].kind!=='section'?items[i]:null;
            this._atlasKeys[slot]=target;
            if(target){
                let value=target.value;
                if(target.kind==='toggle' && typeof target.selected==='boolean')value=target.selected?'Вкл.':'Выкл.';
                if((target.kind==='choice' || target.kind==='diagTab') && target.selected)value='Выбрано';
                this._writeCell(slot,'Text1stCol',target.label,'Text',0);
                this._writeCell(slot,'Text2ndCol',value && value!==target.label?String(value):'','Text',0);
                this._setEnabled(slot,target.enabled!==false);
            }
            this._setVisibleComp(slot,!!target && !interactive);
        }
        const status='atlasStatus'+stem;
        this._write(status,home?(this._written.tripStatus||'Атлас · Поездка'):[view.title,view.lead].filter(Boolean).join(' · '));
        // Clear obsolete warnings before an upload. Telemetry updates for the
        // same active camera can retain the preceding frame until its replacement.
        const context = home ? [page, view.phase, view.cameraId, view.limit, view.limitScope, view.side].join(':')
            : page === 'cameraDetail' ? page + signature : page;
        const surfaceContext=stem+':'+context;
        images.wantedContext = surfaceContext;
        this._setVisibleComp(name,!interactive && images.context===surfaceContext);
        this._setVisibleComp(status,!interactive && images.context!==surfaceContext);
        if(interactive){images.pending=null;return;}
        images.pending = {page,name,view,focus,stem,status,context:surfaceContext,generation:images.generation,
            key:stem+':'+signature};
        this._renderTripImage();
    }

    _renderTripImage() {
        const images = this._tripImage, rhmi = this.rhmiApplication, pending = images.pending;
        if (images.rendering || !pending || this._shuttingDown || !this._visible ||
            this._shownPage !== pending.page) return;
        if(typeof rhmi.getResourceBundle !== 'function'){
            images.pending=null;
            this._prepareAtlasRows(pending).catch(error=>logger.warn('Atlas rows: '+error.message));
            return;
        }
        images.pending = null;
        if (images.key === pending.key) return;
        let bundle, file;
        images.rendering = Promise.resolve()
            .then(() => {
                try { fs.mkdirSync(this._atlasResources, 0o755); } catch (err) { if (err.code !== 'EEXIST') throw err; }
                if (this._shuttingDown) return;
                file = path.join(this._atlasResources, 'atlas_' + this._cameraClientId + '_' + (++images.sequence) + '.png');
                images.uploadingFile = file;
                const png = atlasStage.drawPng(canvas => atlasStage.scene(canvas, pending.page, pending.view, pending.focus, false), atlasStage.summaryHeight);
                fs.writeFileSync(file, png, { mode: 0o644, flag: 'wx' });
                fs.chmodSync(file, 0o644);
                bundle = rhmi.getResourceBundle();
                return bundle.createResourceHandles([file]);
            })
            .then(() => {
                if (this._shuttingDown || images.wantedContext !== pending.context || images.generation!==pending.generation) return false;
                const handle=bundle.getResourceHandle(file);
                if(!handle)throw new Error('Missing RHMI graphic handle');
                return Promise.resolve(this._components[pending.name].setValue(0,'Graphic',handle,'Asset'))
                    .then(()=>this._prepareAtlasRows(pending)).then(()=>rhmi.flush()).then(()=>true);
            })
            .then(written => {
                if (!written || images.generation!==pending.generation || images.wantedContext!==pending.context)
                    return file ? this._retireQr(bundle,file) : undefined;
                const old = images.file;
                images.file = file;
                images.key = pending.key;
                images.context = pending.context;
                if (!this._shuttingDown && this._visible && this._shownPage === pending.page) {
                    const current = images.wantedContext === pending.context && images.generation===pending.generation;
                    const native=!(this._atlasStage.front&&this._atlasStage.owns());
                    this._setVisibleComp(pending.name, native&&current);
                    this._setVisibleComp(pending.status, native&&!current);
                }
                const retired=images.previous;
                images.previous=old;
                return retired ? this._retireQr(bundle,retired) : undefined;
            })
            .catch(err => {
                let rows=Promise.resolve();
                if (!this._shuttingDown && images.wantedContext===pending.context && images.generation===pending.generation) {
                    logger.warn('Atlas graphic: ' + err.message);
                    // The packaged entry icon is already in this app's resource
                    // bundle. Give the hidden Graphic a valid model before
                    // publishing the text and buttons when a live PNG fails.
                    rows=rows.then(()=>this._components[pending.name].setValue(0,'Graphic','kaluga_camera.png','ResourceId'))
                        .then(()=>this._prepareAtlasRows(pending)).catch(e=>logger.warn('Atlas rows: '+e.message));
                }
                return rows.then(()=>{
                    if (!file) return;
                    if (bundle) return this._retireQr(bundle,file);
                    try { fs.unlinkSync(file); } catch (e) { /* no partial image */ }
                });
            })
            .then(() => {
                images.uploadingFile = null;
                images.rendering = null;
                this._renderTripImage();
            });
    }

    _prepareAtlasRows(frame) {
        if(this._atlasReady[frame.stem])return this._atlasReady[frame.stem];
        const state=frame.stem.indexOf('Edit')===0?this._atlasEditorStates[frame.page]:this._rhmiStates[frame.page];
        const pending=Promise.resolve().then(()=>state.updateResources()).catch(error=>{
            delete this._atlasReady[frame.stem];
            throw error;
        });
        this._atlasReady[frame.stem]=pending;
        return pending;
    }

    _renderDiagnostics() {
        if (!this._diagState || this._shutdownPromise) return;
        const result=this._cameraResultView();
        const page=cameraDiagnostics.reportPage(null,this._cameraDiagnosticState(),this._packageJson.version,this._diagPage,this._diagBlock,
            this._cameraFeedback&&this._cameraFeedback.message,result.block);
        this._diagBlock=page.block;
        cameraDiagnostics.PAGE_KEYS.forEach(key=>this._write('cameraDiag_'+key,page.rows[key]));
        this._writeCell('cameraDiagSelector','HeaderText','Страница отчёта','Text');
        cameraDiagnostics.PAGE_TITLES.forEach((title,row)=>this._writeCell('cameraDiagSelector','ItemText',title,'Text',row));
        this._writeCell('cameraDiagSelector','SelectedItem',this._diagPage,'UInt');this._setEnabled('cameraDiagSelector',true);
        this._write('cameraDiagFreeze','Снимок для фото');
        this._write('cameraDiagMore',page.blocks>1?'Следующие строки • '+(page.block+1)+'/'+page.blocks:'Все строки показаны');
        this._write('cameraDiagResultMore',result.label);
        const testTarget=this._diagnosticCameraTarget();
        const testTargetName=testTarget==='map'?'на приборах':'на HUD';
        this._write('cameraDiagTest',testTarget?'Тест изображения '+testTargetName+' • на стоянке':'Тест изображения • включите приборы или HUD');
        this._write('cameraDiagCalibration',testTarget?'Проверить границы '+testTargetName+' • на стоянке':'Проверка границ • включите приборы или HUD');
        this._write('cameraDiagAudio','Проверить звук');
        this._write('cameraDiagExport',this._diagnosticSnapshot?'Сохранить снимок JSON • RAM':'Сохранить JSON локально • RAM');
        // Keep diagnostic actions reachable: every press either acts or explains the exact service guard.
        ['cameraDiagFreeze','cameraDiagTest','cameraDiagCalibration','cameraDiagAudio','cameraDiagExport',
            'cameraDiagMore','cameraDiagResultMore'].forEach(name=>this._setEnabled(name,true));
        if (this._shownPage === 'diagnostics') this._renderAtlas();
    }

    _renderLogs() {
        if (!this._logsState || this._shutdownPromise) {
            return;
        }
        this._write(LOGS_SAVE, t('Save logs'));
        this._write(LOGS_STATUS, this._logs.statusText());
        this._write(LOGS_URL, this._logs.urlText());
        this._setEnabled(LOGS_SAVE, this._logs.canSave());
        const rows = this._logs.rows();
        LOGS_ROW_NAMES.forEach((name, i) => this._write(name, oneRow(rows[i])));
        this._showQr(this._logs.url());
        if (this._shownPage === 'logs') this._renderAtlas();
    }

    /* Writes url's QR code (none: a blank square) as a new file and shows it,
     * then removes the one it replaced. */
    _showQr(url) {
        const rhmi = this.rhmiApplication;
        if (this._qr.url === url || !rhmi) {
            return this._qr.chain;
        }
        this._qr.url = url;
        this._qr.chain = this._qr.chain.then(() => {
            /* the HMI reads the picture: the folder and the file world-readable */
            try {
                fs.mkdirSync(QR_DIR);
            } catch (e) {
                if (e.code !== 'EEXIST') {
                    throw e;
                }
            }
            fs.chmodSync(QR_DIR, 0o755);
            const file = path.join(QR_DIR, `qr_${Date.now()}.png`);
            fs.writeFileSync(file, qrPng(url).png);
            fs.chmodSync(file, 0o644);
            const bundle = rhmi.getResourceBundle();
            const old = this._qr.file;
            return Promise.resolve(bundle.createResourceHandles([file]))
                .then(() => this._components[LOGS_QR].setValue(0, 'Graphic', file, 'ResourceId'))
                .then(() => rhmi.flush())
                .then(() => {
                    this._qr.file = file;
                    return old ? this._retireQr(bundle, old) : undefined;
                });
        }).catch((err) => {
            this._qr.url = undefined;
            logger.warn(`QR code failed: ${err && err.message}`);
        });
        return this._qr.chain;
    }

    _retireQr(bundle, file) {
        return Promise.resolve()
            .then(() => bundle.destroyResourceHandles([file]))
            .catch((err) => logger.warn(`QR handle ${file}: ${err && err.message}`))
            .then(() => {
                try {
                    fs.unlinkSync(file);
                } catch (e) {
                    /* gone already */
                }
            });
    }

    _removeStaleQr() {
        try {
            fs.readdirSync(QR_DIR).filter((n) => /^(?:qr_\d+|(?:pulse|atlas)_strelka-[a-z0-9-]+_\d+)\.png$/.test(n))
                .forEach((n) => fs.unlinkSync(path.join(QR_DIR, n)));
        } catch (e) {
            /* no folder yet */
        }
    }

    /* ---- shutdown ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        logger.info(`robertn_waze_cluster shutdown: ${JSON.stringify(reason)}`);
        this._shuttingDown = true;
        this._atlasStage.close();
        clearTimeout(this._cameraCommandTimer); this._cameraCommandTimer=null;
        clearTimeout(this._hideTimer);
        this._profiles.stop();
        this._control.close();
        this._logs.close();
        this._cameras.close();
        this._speedBridge.stop();
        this._gpsBridge.stop();
        this._navigationBridge.stop();
        this._moveRepeater.close();this._holdBridge.close();
        if (this._qr.file) {
            try {
                fs.unlinkSync(this._qr.file);
            } catch (e) {
                /* gone already */
            }
        }
        [this._tripImage.file, this._tripImage.previous, this._tripImage.uploadingFile].filter(Boolean).forEach(filename => {
            try { fs.unlinkSync(filename); } catch (e) { /* already retired */ }
        });
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) =>
                logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new WazeClusterApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`robertn_waze_cluster failed to start: ${err && err.message}`);
});
