// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert');
const fs = require('fs');
const zlib = require('zlib');
const baseline = require('../../../native/marku-kaluga-cameras/files/russia-camera-baseline.json');
const regionalManifest = require('../../../data/russia/manifest-regions-v2.json');
const { create } = require('./ui_harness.js');
const trip = require('../src/trip_view.js');
const diagnostics = require('../src/diagnostics_view.js');

const h = create(), { app, byName:c, rhmi, commands } = h;
const HOME = 'ST_OnlineApps_StrelkaTrip';
const t0 = Date.UTC(2026, 10, 22, 15, 0, 0);
const state = {
    enabled:true, observedAtMs:t0+350, serviceVersion:'0.10.0',
    vehicleMotion:{code:'READY',speedKmh:29},
    gpsMotion:{state:'moving',speedKmh:28.9},
    gpsFix:{source:'bmw-nmea',accuracyM:8,timeMs:t0},
    clock:{referenceSource:'rtc'},
    outputs:{hud:true,cluster:false}, rendererDetails:{hud:{rendering:'verified'}},
    alert:{id:'osm:123456789',title:'Контроль скорости',distanceM:85,displayDistanceM:49,limitKmh:40,roadConfirmed:true,way:'23971863',sign:-1},
    actions:{cardLayout:{allowed:false,code:'MOVING'},databaseCheck:{allowed:false,code:'MOVING'},displayTest:{allowed:false,code:'MOVING'}},
    regionalDatabase:{selectedRegion:'RU-KLU',phase:'listed',regions:[
        {region:'RU-KLU',name:'Kaluga Oblast',count:125,withCameraLimit:61,withDirection:54,
            sourceTimestamp:'2026-11-21T07:00:00Z',currentVersion:'2026-10',availableVersion:'2026-11',status:'available'},
        {region:'RU-MOW',name:'Moscow',count:400,currentVersion:'2026-09',availableVersion:'2026-11',status:'available'},
        {region:'RU-MOS',name:'Moscow Oblast',count:210,currentVersion:'2026-09',availableVersion:'2026-11',status:'available'}
    ]}
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const mapSource = {provider:'openstreetmap',sourceTimestamp:'2026-09-21T00:00:00Z',wayId:23971863,tag:'maxspeed'};
const mapAlert = {...state.alert,limitKmh:null,roadMapLimitKmh:40,roadMapLimitSource:mapSource};
const mapState = {...state,vehicleMotion:{code:'READY',speedKmh:60},alert:mapAlert};
function panelPixels(view) {
    const png = trip.graphic(view);
    assert.strictEqual(png.toString('ascii',37,41),'IDAT');
    return zlib.inflateSync(png.subarray(41,41+png.readUInt32BE(33)));
}
function pixel(pixels,x,y) {
    const at=y*(640*4+1)+1+x*4;
    return [...pixels.subarray(at,at+3)];
}
function verifyMapLimit() {
    assert.strictEqual(trip.approachLimit({...mapAlert,limitKmh:60}).scope,'road');
    assert.strictEqual(trip.approachLimit({...mapAlert,postedApproachLimitKmh:60}).scope,'posted');
    for (const invalid of [{roadConfirmed:false}, {way:'23971864'}, {roadMapLimitSource:null},
        {roadMapLimitSource:{...mapSource,tag:'maxspeed:conditional'}}, {roadMapLimitSource:{...mapSource,sourceTimestamp:'missing'}},
        {roadMapLimitKmh:0}, {roadMapLimitKmh:30.5}]) {
        assert.strictEqual(trip.approachLimit({...mapAlert,...invalid}).value,null);
    }
    const view = trip.model(mapState), pixels = panelPixels(view);
    assert.strictEqual(view.limitScope,'map');
    assert.deepStrictEqual(pixel(pixels,566,29),[233,188,111],'map ring is amber');
    assert.deepStrictEqual(pixel(pixels,537,91),[233,188,111],'map ring includes the visible letter label');
    const unknown = panelPixels(trip.model({...mapState,alert:{...mapAlert,roadMapLimitKmh:null}}));
    for (let y=0;y<148;y++) {
        const at=y*(640*4+1)+1+365*4, end=at+133*4;
        assert(pixels.subarray(at,end).equals(unknown.subarray(at,end)),'map limit cannot affect the speed dial');
    }
    const held = trip.model({...mapState,alert:{...mapAlert,gpsHeld:true}});
    assert.strictEqual(held.distance,null);
    assert.strictEqual(held.limitScope,'map');
    const rows = diagnostics.photoRows(diagnostics.capture(mapState,'0.10.0',t0),true,'hud');
    assert(rows[4].includes('23971863− • Лимит 40 км/ч (по карте)'));
    const snapshot = diagnostics.capture(mapState,'0.10.0',t0);
    const detail = [];
    for (let block=0,blocks=1;block<blocks;block++) {
        const report=diagnostics.reportPage(snapshot,mapState,'0.10.0',2,block);
        blocks=report.blocks;
        detail.push(...Object.values(report.rows));
    }
    assert(detail.some(row=>row.includes('OpenStreetMap • участок №23971863 • maxspeed')));
    assert(detail.some(row=>row.includes('2026-09-21T00:00:00Z')));
}
function verifySpeedcamLimit() {
    const entry = {source:'SpeedCamOnLine', id:'sco:test', courseDeg:162, limitKmh:40};
    const alert = {id:'sample', roadConfirmed:false, speedcamApproach:entry};
    const view = trip.model({...state, alert});
    assert.strictEqual(view.limitScope, 'speedcam');
    assert.strictEqual(view.text.tripCameraLimit, 'Лимит 40 км/ч (по базе камер)');
    assert(view.text.tripCameraEvidence.includes('SpeedCamOnLine • курс 162°'));
    assert.strictEqual(trip.approachLimit({...mapAlert,speedcamApproach:entry}).scope, 'map');
    for (const invalid of [{source:'other'},{id:null},{courseDeg:360},{limitKmh:0}]) {
        assert.strictEqual(trip.approachLimit({...alert,speedcamApproach:{...entry,...invalid}}).value, null);
    }
}

function verifyRegionNames() {
    for (const entry of [...baseline.regions,...regionalManifest.regions]) {
        assert.match(trip.regionName(entry),/^[А-Яа-яЁё]/,entry.region);
    }
    assert.strictEqual(trip.regionName({region:'RU-NEW',name:'New region'}),'New region');
}
async function openFromHome(name, expected) {
    if (h.current() !== HOME) await h.enter(HOME);
    delete app._lastPress[name];
    assert(c[name].press(), name);
    await settle();
    assert.strictEqual(h.current(), expected);
}
async function main() {
    verifyMapLimit();
    verifySpeedcamLimit();
    verifyRegionNames();
    // Simulate actual EntryPointManager handover and the registered native tile.
    app.appDescription = {application:{entryPoints:[{uuid:'pulse'}]}};
    app.getEntryPoints = () => [{
        getDescription:()=>({uuid:'pulse',name:'pulse',textId:'pulse'}),
        init:()=>Promise.resolve(), setAvailability:()=>Promise.resolve(),
        entryPoint:{setText:()=>Promise.resolve()}
    }];
    const mapped = {};
    rhmi.mapEntryState = (uuid, nativeState) => { mapped[uuid] = nativeState.desc.name; return Promise.resolve(); };
    rhmi.openEntryState = uuid => rhmi.openState(mapped[uuid]);
    await app._setupRhmi();
    await app._registerEntryPoints();
    await app._onEntryPointExecute('pulse');
    assert.strictEqual(h.current(), HOME);
    assert(c.tripStatus.text().includes('Ожидание'));
    const liveHandles = new Set();
    const bundle = {
        createResourceHandles(files) {
            for (const file of files) {
                const png=fs.readFileSync(file);
                assert.strictEqual(png.readUInt32BE(16),640);
                assert.strictEqual(png.readUInt32BE(20),148);
                liveHandles.add(file);
            }
            return Promise.resolve();
        },
        destroyResourceHandles(files) { files.forEach(file=>liveHandles.delete(file)); return Promise.resolve(); }
    };
    rhmi.getResourceBundle = () => bundle;
    rhmi.flush = () => Promise.resolve();
    h.setState(state);
    await app._tripImage.rendering;
    assert.strictEqual(liveHandles.size,1);
    assert.strictEqual(c.tripReading.text(), 'Дистанция 49 м • Лимит 40 км/ч • Скорость 29 км/ч');
    assert.strictEqual(c.tripOutputs.text(), 'HUD показ • Приборы выкл. • Калужская область');
    assert.strictEqual(c.tripGraphic.cells['0:Graphic'],[...liveHandles][0]);
    assert(c.tripGraphic.visible);
    h.setState(mapState);
    assert(!c.tripGraphic.visible,'changing the provenance alone hides the old verified sign during upload');
    assert(c.tripReading.text().includes('Лимит 40 км/ч (по карте)'));
    await app._tripImage.rendering;
    assert(c.tripGraphic.visible);
    const stopped=Object.assign({}, state,{vehicleMotion:{code:'READY',speedKmh:0},gpsMotion:{state:'stopped',speedKmh:0}});
    h.setState(stopped);
    await app._tripImage.rendering;
    assert.strictEqual(liveHandles.size,1,'swap retires old graphic');
    assert(c.tripStatus.text().includes('Остановка'));
    assert(c.tripReading.text().includes('Дистанция 49 м • Лимит 40'));
    const held=Object.assign({}, stopped,{alert:Object.assign({},state.alert,{gpsHeld:true})});
    h.setState(held);
    assert(!c.tripGraphic.visible,'hide the obsolete graphic while the held state is uploading');
    await app._tripImage.rendering;
    assert(c.tripGraphic.visible,'show the new graphic after the held state is uploaded');
    assert(c.tripStatus.text().includes('GPS временно недоступен'));
    assert(c.tripReading.text().includes('Дистанция — • Лимит 40'));
    assert(!c.tripReading.text().includes('49'));
    const advisory = Object.assign({}, state, {alert:{id:'other',roadConfirmed:false,distanceM:90,limitKmh:60,cameraLimitKmh:60,
        approachLimitEvidence:{status:'historical',valueKmh:40}}});
    h.setState(advisory);
    await app._tripImage.rendering;
    assert(c.tripReading.text().includes('Лимит —'));
    assert(!c.tripReading.text().includes('60'));
    h.setState(Object.assign({}, state, {alert:null,guidance:{lastClear:{reason:'CAMERA_PASSED',timeMs:t0}}}));
    await app._tripImage.rendering;
    assert(c.tripStatus.text().includes('Камера пройдена'));
    assert(!c.tripReading.text().includes('Лимит'));
    await openFromHome('tripMaps','ST_OnlineApps_WazeCluster');
    await h.back();
    assert.strictEqual(h.current(),HOME);
    await openFromHome('tripSettings','ST_OnlineApps_WazeStrelkaCameras');
    h.setState(state);
    await openFromHome('tripCamera','ST_OnlineApps_StrelkaCamera');
    assert(c.tripCameraRoad.text().includes('23971863 −'));
    assert(c.tripCameraLimit.text().includes('40'));
    h.setState(mapState);
    assert(c.tripCameraLimit.text().includes('Лимит 40 км/ч (по карте)'));
    assert(c.tripCameraEvidence.text().includes('OpenStreetMap • участок №23971863 • 2026-09-21'));
    h.setState(state);
    await openFromHome('tripDiagnostics','ST_OnlineApps_WazeStrelkaDiagnostics');
    assert(c.cameraDiagFreeze.press());
    await settle();
    assert.strictEqual(h.current(),'ST_OnlineApps_CameraDiagnosticPhoto');
    const photo = diagnostics.PHOTO_NAMES.map(name=>c[name].text());
    assert.strictEqual(photo.length,7);
    assert(photo.some(row=>row.includes('Опора RTC')&&row.includes('23456789')));
    assert(photo.some(row=>row.includes('±8.0 м')&&row.includes('350 мс')));
    assert(photo.some(row=>row.includes('23971863−')&&row.includes('40 км/ч (подход)')));
    assert(photo.some(row=>row.includes('MOVING')));
    assert(!photo.some(row=>row.includes('54.516')));
    await openFromHome('tripDatabase','ST_OnlineApps_StrelkaRegions');
    assert(c.tripRegionVersion.text().includes('Калужская область'));
    assert(c.tripRegionResult.text().includes('нет данных о загрузке'));
    for (const [phase, label] of [['absent','пакет отсутствует'], ['invalid','ошибка пакета'], ['active','загружен • 2026-11-01']]) {
        h.setState({...state, database:{...state.database, speedcamOnline:{phase, sourceDate:'2026-11-01', added:12, enriched:7}}});
        assert(c.tripRegionResult.text().includes('SpeedCamOnLine • '+label));
    }
    for (const [phase, label] of [['scheduled','ожидает загрузки'],['downloading','идёт загрузка'],['converting','проверка и импорт данных'],['retry','загрузка будет повторена • NO_UPLINK']]) {
        h.setState({...state, speedcamDownload:{phase,errorCode:'NO_UPLINK'}, database:{...state.database,speedcamOnline:{phase:'absent'}}});
        assert(c.tripRegionResult.text().includes('SpeedCamOnLine • '+label));
    }
    assert.strictEqual(c.tripRegionSelector.cells['0:ItemText'],'Калужская область');
    assert.strictEqual(c.tripRegionSelector.cells['1:ItemText'],'Москва');
    assert.strictEqual(c.tripRegionSelector.cells['2:ItemText'],'Московская область');
    c.tripRegionSelector.pick(1);
    assert(c.tripRegionVersion.text().includes('Москва'));
    assert.strictEqual(state.regionalDatabase.regions[1].name,'Moscow');
    assert(!c.tripRegionDownload.press(),'package download is guarded while moving');
    assert(!commands.some(item=>item.cmd==='regional-download'));
    h.setState(Object.assign({}, stopped,{actions:{cardLayout:{allowed:true,code:'READY'},databaseCheck:{allowed:true,code:'READY'}}}));
    assert(c.tripRegionDownload.press());
    assert.strictEqual(commands[commands.length-1].cmd,'regional-download');
    assert.strictEqual(commands[commands.length-1].region,'RU-MOW');
    assert(c.tripLegacyDatabase.press());
    await settle();
    assert.strictEqual(h.current(),'ST_OnlineApps_CameraDatabase');
    await openFromHome('tripAbout','ST_OnlineApps_StrelkaAbout');
    assert(c.tripAboutVersion.text().includes(require('../mgu-app.json').version));
    assert(trip.model(null).text.tripReading.includes('—'));
    app._shuttingDown=true;
    await app._tripImage.rendering;
    if (app._tripImage.file) {
        await app._retireQr(bundle,app._tripImage.file);
        app._tripImage.file=null;
    }
    console.log('PASS Pulse native entry, readings and provenance, graphic swap, routes, photo, regional names and motion guard');
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).then(()=>h.close());
