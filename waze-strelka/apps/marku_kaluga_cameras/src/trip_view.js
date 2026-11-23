// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const { rgbaPng } = require('./qr.js');

const NAMES = ['tripGraphic', 'tripStatus', 'tripReading', 'tripOutputs', 'tripCamera', 'tripMaps', 'tripSettings',
    'tripDiagnostics', 'tripDatabase', 'tripAbout', 'tripCameraStatus', 'tripCameraDistance', 'tripCameraLimit',
    'tripCameraRoad', 'tripCameraIdentity', 'tripCameraEvidence', 'tripCameraDiagnostics', 'tripAboutVersion', 'tripAboutLogs',
    'tripRegionStatus', 'tripRegionSelector', 'tripRegionVersion', 'tripRegionCoverage', 'tripRegionSource',
    'tripRegionRoad', 'tripRegionResult', 'tripRegionPage', 'tripRegionRefresh', 'tripRegionDownload', 'tripRegionRollback', 'tripLegacyDatabase'];
const COMMANDS = { tripCamera:'cameraDetail', tripMaps:'main', tripSettings:'cameras', tripDatabase:'regions', tripLegacyDatabase:'database',
    tripAbout:'about', tripAboutLogs:'logs' };

function short(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 64) : '';
}
function speedValue(value) {
    return Number.isFinite(value) && value >= 0 && value <= 400 ? Math.round(value) : null;
}
function approachLimit(alert) {
    const unknown = { value:null, scope:'unknown' };
    if (!alert) return unknown;
    const valid = value => Number.isInteger(value) && value > 0 && value <= 300;
    const resolved = alert.displayLimit;
    if (resolved && (valid(resolved.value) && resolved.state === 'known' || resolved.value === null &&
        (resolved.state === 'conflict' || resolved.state === 'unknown'))) return resolved;
    const entry = alert.speedcamApproach;
    const camera = entry && entry.source === 'SpeedCamOnLine' && short(entry.id) &&
        Number.isFinite(entry.courseDeg) && entry.courseDeg >= 0 && entry.courseDeg < 360 && valid(entry.limitKmh) ?
        {value:entry.limitKmh, scope:'speedcam', source:entry} : unknown;
    if (alert.roadConfirmed !== true) return camera;
    const verified = Number.isFinite(alert.limitKmh) ? Math.round(alert.limitKmh) : 0;
    if (verified > 0 && alert.limitKmh <= 300) return { value:verified, scope:'road' };
    if (valid(alert.postedApproachLimitKmh)) return { value:alert.postedApproachLimitKmh, scope:'posted' };
    const source = alert.roadMapLimitSource;
    if (valid(alert.roadMapLimitKmh) && source && source.provider === 'openstreetmap' && source.tag === 'maxspeed' &&
        Number.isSafeInteger(source.wayId) && source.wayId > 0 && String(source.wayId) === String(alert.way) &&
        typeof source.sourceTimestamp === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(source.sourceTimestamp) &&
        Number.isFinite(Date.parse(source.sourceTimestamp))) {
        return { value:alert.roadMapLimitKmh, scope:'map', source };
    }
    return camera;
}
function limitText(limit) {
    const suffix = (limit.scope === 'camera' || limit.scope === 'speedcam') ? ' (по базе камер)' : limit.scope === 'map' ? ' (по карте)' : limit.scope === 'posted' ? ' (знак)' : '';
    if (limit.scope === 'conflict') {
        const values = Array.isArray(limit.values) ? limit.values.filter(v => Number.isInteger(v) && v > 0 && v <= 300) : [];
        return values.length > 1 ? 'Лимит: расхождение ' + values.join(' / ') + ' км/ч' : 'Лимит: расхождение данных';
    }
    return 'Лимит ' + (limit.value === null ? '—' : limit.value + ' км/ч' + suffix);
}
function cameraDistance(alert) {
    if (!alert || alert.gpsHeld === true) return null;
    const value = [alert.displayDistanceM, alert.distanceM, alert.distance].find(item => Number.isFinite(item) && item >= 0);
    return value === undefined ? null : Math.round(value);
}
function roadDirection(alert) {
    if (!alert || alert.roadConfirmed !== true) return 'Направление не подтверждено';
    const way = Number.isSafeInteger(alert.way) || typeof alert.way === 'string' && /^\d{1,14}$/.test(alert.way) ? ' №' + alert.way : '';
    const sign = alert.sign === 1 ? ' +' : alert.sign === -1 ? ' −' : '';
    return 'Подход подтверждён' + way + sign;
}
function outputLabel(enabled, output) {
    if (enabled === false) return 'выкл.';
    if (enabled !== true) return '—';
    if (output && (output.disabled || output.state === 'отказ')) return 'отказ';
    return output && output.rendering === 'verified' ? 'показ' : 'вкл.';
}
function model(state, version) {
    const s = state || {}, alert = s.enabled !== false && s.alert || null;
    const motion = s.gpsMotion || {}, vehicle = s.vehicleMotion || {};
    const distance = cameraDistance(alert), held = !!(alert && alert.gpsHeld === true);
    const limit = approachLimit(alert), outputs = s.outputs || {}, layers = s.rendererDetails || {};
    const speed = vehicle.code === 'READY' ? speedValue(vehicle.speedKmh) :
        motion.state === 'stopped' || motion.state === 'moving' ? speedValue(motion.speedKmh) : null;
    const lastClear = (s.guidance || {}).lastClear || {};
    const clearAge = s.observedAtMs - lastClear.timeMs;
    const passed = lastClear.reason === 'CAMERA_PASSED' && Number.isFinite(lastClear.timeMs) && clearAge >= 0 && clearAge < 4000;
    const stopped = alert && alert.roadConfirmed === true && (motion.state === 'stopped' || (vehicle.code === 'READY' && Number.isFinite(vehicle.speedKmh) && vehicle.speedKmh <= 1));
    const street = s.street && s.street.state === 'ready' ? short(s.street.name) : '';
    const regional = s.regionalDatabase || {};
    const activeRegion = Array.isArray(regional.regions) && regional.regions.find(item=>item && item.region===regional.selectedRegion);
    const region = activeRegion ? regionName(activeRegion) : '';
    const phase = !state ? 'waiting' : s.enabled === false ? 'disabled' : alert ?
        held ? 'gps' : stopped && !motion.conflict ? 'stop' : alert.roadConfirmed === true ? 'approach' : 'nearby' :
        passed ? 'passed' : !s.gpsFix ? 'gps' : 'idle';
    const statuses = { waiting:'Ожидание сервиса камер', disabled:'Предупреждения выключены', gps:'Ожидание свежих данных GPS',
        stop:'Остановка перед камерой', approach:'Камера на вашем пути', nearby:'Камера рядом • путь не подтверждён',
        passed:'Камера пройдена', idle:'Активных предупреждений нет' };
    const status = held ? 'GPS временно недоступен • камера удерживается' : statuses[phase];
    const dash = '—', display = value => value === null ? dash : String(value);
    const limitLabel = limitText(limit), distanceText = 'Дистанция ' + display(distance) + (distance === null ? '' : ' м');
    const reading = alert ? distanceText + ' • ' + limitLabel + ' • ' : '';
    const camera = alert && (short(alert.title) || 'Камера');
    const source = short(alert && alert.limitEvidence && alert.limitEvidence.source);
    const evidence = limit.state === 'conflict' ? 'Источники расходятся: ' + limit.values.join(' / ') + ' км/ч' :
        limit.state === 'known' ? limit.source + (limit.sourceDate ? ' • ' + (limit.dateKind === 'edition' ? 'выпуск ' : 'запись ') + limit.sourceDate.slice(0,10) : '') :
        limit.scope === 'speedcam' ? 'SpeedCamOnLine • курс ' + limit.source.courseDeg + '°' : limit.scope === 'map' ? 'OpenStreetMap • участок №' + limit.source.wayId +
        ' • ' + limit.source.sourceTimestamp.slice(0,10) : limit.scope === 'posted' ? 'знак на подходе' :
        limit.scope === 'road' ? source || 'подтверждённый подход' : '—';
    return {
        active:!!alert, cameraId:alert ? short(alert.id) : '', phase, speed, distance, limit:limit.value, limitScope:limit.scope,
        text:{
            tripStatus:status + (street ? ' • ' + street : ''),
            tripReading:reading + 'Скорость ' + display(speed) + (speed === null ? '' : ' км/ч'),
            tripCamera:alert ? 'Активная камера' : 'Камеры',
            tripOutputs:'HUD ' + outputLabel(outputs.hud, layers.hud) + ' • Приборы ' + outputLabel(outputs.cluster, layers.map) +
                (region ? ' • '+region : ''),
            tripCameraStatus:status,
            tripCameraDistance:distanceText + (held ? ' • GPS устарел' : ''),
            tripCameraLimit:limitLabel,
            tripCameraRoad:alert ? roadDirection(alert) : 'Подход —',
            tripCameraIdentity:camera ? camera + (short(alert.id) ? ' • ' + short(alert.id) : '') : 'Камера —',
            tripCameraEvidence:limit.scope === 'unknown' && alert ? 'Лимит для этого направления не подтверждён' :
                'Основание: ' + evidence,
            tripAboutVersion:'Версия приложения ' + (short(version) || dash)
        }
    };
}

// Only the displayed label is localized; selection and package metadata use the source region code.
const REGION_NAMES = {
    AD:'Республика Адыгея', AL:'Республика Алтай', ALT:'Алтайский край', AMU:'Амурская область',
    ARK:'Архангельская область', AST:'Астраханская область', BA:'Республика Башкортостан', BEL:'Белгородская область',
    BRY:'Брянская область', BU:'Республика Бурятия', CE:'Чеченская Республика', CHE:'Челябинская область',
    CHU:'Чукотский автономный округ', CU:'Чувашская Республика', DA:'Республика Дагестан', IN:'Республика Ингушетия',
    IRK:'Иркутская область', IVA:'Ивановская область', KAM:'Камчатский край', KB:'Кабардино-Балкарская Республика',
    KC:'Карачаево-Черкесская Республика', KDA:'Краснодарский край', KEM:'Кемеровская область — Кузбасс',
    KGD:'Калининградская область', KGN:'Курганская область', KHA:'Хабаровский край', KHM:'Ханты-Мансийский автономный округ — Югра',
    KIR:'Кировская область', KK:'Республика Хакасия', KL:'Республика Калмыкия', KLU:'Калужская область',
    KO:'Республика Коми', KOS:'Костромская область', KR:'Республика Карелия', KRS:'Курская область',
    KYA:'Красноярский край', LEN:'Ленинградская область', LIP:'Липецкая область', MAG:'Магаданская область',
    ME:'Республика Марий Эл', MO:'Республика Мордовия', MOS:'Московская область', MOW:'Москва',
    MUR:'Мурманская область', NEN:'Ненецкий автономный округ', NGR:'Новгородская область', NIZ:'Нижегородская область',
    NVS:'Новосибирская область', OMS:'Омская область', ORE:'Оренбургская область', ORL:'Орловская область',
    PER:'Пермский край', PNZ:'Пензенская область', PRI:'Приморский край', PSK:'Псковская область',
    ROS:'Ростовская область', RYA:'Рязанская область', SA:'Республика Саха (Якутия)', SAK:'Сахалинская область',
    SAM:'Самарская область', SAR:'Саратовская область', SE:'Республика Северная Осетия — Алания',
    SMO:'Смоленская область', SPE:'Санкт-Петербург', STA:'Ставропольский край', SVE:'Свердловская область',
    TA:'Республика Татарстан', TAM:'Тамбовская область', TOM:'Томская область', TUL:'Тульская область',
    TVE:'Тверская область', TY:'Республика Тыва', TYU:'Тюменская область', UD:'Удмуртская Республика',
    ULY:'Ульяновская область', VGG:'Волгоградская область', VLA:'Владимирская область', VLG:'Вологодская область',
    VOR:'Воронежская область', YAN:'Ямало-Ненецкий автономный округ', YAR:'Ярославская область',
    YEV:'Еврейская автономная область', ZAB:'Забайкальский край'
};
function regionName(entry) {
    const code = short(entry.region);
    return REGION_NAMES[code.slice(3)] || short(entry.name) || code;
}

function speedcamStatus(database, download) {
    const layer = database && database.speedcamOnline;
    if ((!layer || layer.phase !== 'active') && download) {
        const phases = {
            scheduled: 'ожидает загрузки',
            downloading: 'идёт загрузка',
            converting: 'проверка и импорт данных',
            retry: 'загрузка будет повторена'
        };
        const label = phases[download.phase];
        if (label) {
            const error = download.phase === 'retry' && short(download.errorCode);
            return 'SpeedCamOnLine • ' + label + (error ? ' • ' + error : '');
        }
    }
    if (!layer) return 'SpeedCamOnLine • нет данных о загрузке';
    if (layer.phase === 'absent') return 'SpeedCamOnLine • пакет отсутствует';
    if (layer.phase === 'invalid') return 'SpeedCamOnLine • ошибка пакета';
    if (layer.phase !== 'active') return 'SpeedCamOnLine • состояние неизвестно';
    return 'SpeedCamOnLine • загружен • ' + (short(layer.sourceDate) || 'дата неизвестна');
}

const REGION_ROWS = 6;
function regionsModel(state, choice, page) {
    const data = state && state.regionalDatabase;
    const all = data && Array.isArray(data.regions) ? data.regions.filter(item => item && /^RU-[A-Z0-9]{2,4}$/.test(item.region)) : [];
    const pages = Math.max(1, Math.ceil(all.length/REGION_ROWS));
    const selected = all.find(item => item.region === choice) || all.find(item => item.region === (data && data.selectedRegion)) || all[0];
    const index = page === null ? Math.max(0, Math.floor(all.indexOf(selected)/REGION_ROWS)) : Math.min(page,pages-1);
    const rows = all.slice(index*REGION_ROWS,(index+1)*REGION_ROWS);
    const progress = data && data.phase, error = data && short(data.errorCode);
    const busy = !!(data && data.busy) || ['checking','listing','downloading','verifying','installing','rolling-back'].indexOf(progress)>=0;
    const labels = {unavailable:'Список регионов недоступен', idle:'Выберите регион', listed:'Список обновлён • выберите регион',
        checking:'Проверка списка', downloading:'Загрузка пакета', installing:'Проверка и применение пакета',
        current:'Установлена актуальная версия', updated:'Пакет обновлён', 'rolled-back':'Предыдущая версия восстановлена',
        error:'Ошибка регионального пакета'};
    const count = key => selected && Number.isSafeInteger(selected[key]) && selected[key]>=0 ? selected[key] : '—';
    const text = key => short(selected && selected[key]) || '—';
    const selectedName = selected ? regionName(selected) : '—';
    const download=!!selected && selected.status === 'available' && typeof selected.availableVersion === 'string' && !!selected.availableVersion;
    const rollback=!!selected && selected.canRollback === true;
    const packageStatus={installed:'установлен', available:'доступен', bundled:'встроен', 'no-records':'нет записей'};
    return {data, selected, index, pages, rows, selectedRow:rows.indexOf(selected), busy, download, rollback, text:{
        tripRegionStatus:(data ? labels[progress] || 'Выберите регион' : 'Региональные пакеты недоступны') + (error?' • '+error:''),
        tripRegionVersion:selectedName + ' • установлено '+text('currentVersion')+' • доступно '+text('availableVersion'),
        tripRegionCoverage:'Камер '+count('count')+' • лимит в записи '+count('withCameraLimit')+' • ориентация объектива '+count('withDirection'),
        tripRegionRoad:'Подтверждённые лимиты '+count('withApproachLimit')+' • направления '+count('withApproachDirection')+
            ' • конфликты '+count('conflictCount'),
        tripRegionSource:'Дата данных '+text('sourceTimestamp').slice(0,10) +
            (selected && packageStatus[selected.status] ? ' • '+packageStatus[selected.status] : ''),
        tripRegionPage:'Следующие регионы · '+(index+1)+'/'+pages,
        tripRegionDownload:busy?'Дождитесь завершения операции':'Загрузить / продолжить'
    }};
}

// Native RHMI Text rows carry the reading and the units. This compact opaque
// panel supplies the large distance, recognizable speed dial and limit sign.
const WIDTH = 640;
const HEIGHT = 148;
const SILK = [246, 243, 240], SOFT = [176, 155, 171], PEACH = [241, 177, 132], RED = [229, 99, 83], AMBER = [233, 188, 111];
const MAP_CAPTION = [
    ['10001', '01110', '11110', '11111', '01110'],
    ['10010', '10001', '10001', '00100', '10001'],
    ['10100', '10001', '10001', '00100', '10001'],
    ['11000', '11111', '11110', '00100', '11111'],
    ['10100', '10001', '10000', '00100', '10001'],
    ['10010', '10001', '10000', '00100', '10001'],
    ['10001', '10001', '10000', '00100', '10001']
];
const SEGMENTS = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
function graphic(view) {
    const stride = WIDTH * 4 + 1, raw = Buffer.alloc(stride * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const at = y*stride + 1 + x*4;
            const tint = Math.max(0, 1 - Math.abs(x-303)/350) * (1-y/HEIGHT);
            raw[at] = 33 + tint*20; raw[at+1] = 27 + tint*10; raw[at+2] = 36 + tint*12; raw[at+3] = 255;
        }
    }
    function dot(x,y,color) {
        if (x<0 || y<0 || x>=WIDTH || y>=HEIGHT) return;
        const at=y*stride+1+x*4;
        raw[at]=color[0]; raw[at+1]=color[1]; raw[at+2]=color[2];
    }
    function box(x,y,w,h,color) {
        for(let row=y;row<y+h;row++) for(let col=x;col<x+w;col++) dot(col,row,color);
    }
    function ring(x,y,r,thickness,color) {
        const inner=(r-thickness)*(r-thickness);
        for(let row=-r;row<=r;row++) for(let col=-r;col<=r;col++) {
            const sq=row*row+col*col;
            if(sq>=inner&&sq<=r*r) dot(x+col,y+row,color);
        }
    }
    function glyph(value, center, top, unit, color) {
        const text=value===null?'-':String(value);
        const span=11*unit, start=Math.round(center-(text.length*span-2*unit)/2);
        const bounds={a:[1,0,7,1],b:[8,1,1,5],c:[8,7,1,5],d:[1,12,7,1],e:[0,7,1,5],f:[0,1,1,5],g:[1,6,7,1]};
        for(let i=0;i<text.length;i++) {
            const bits=text[i]==='-'?'g':SEGMENTS[Number(text[i])];
            for(const ch of bits) {
                const b=bounds[ch];
                box(start+i*span+b[0]*unit,top+b[1]*unit,b[2]*unit,b[3]*unit,color);
            }
        }
    }
    function dial(x,y,speed,limit) {
        const lit = speed===null ? -1 : Math.min(27, Math.floor(speed/6));
        const over = limit!==null && speed!==null && speed>limit;
        for(let i=0;i<28;i++) {
            const angle=(135+i*10)*Math.PI/180;
            for(let r=i%3===0?52:57;r<=63;r++) {
                const px=Math.round(x+Math.cos(angle)*r), py=Math.round(y+Math.sin(angle)*r);
                box(px,py,2,2,i<=lit ? (over ? RED : PEACH) : SOFT);
            }
        }
        if (limit!==null && limit<=162) {
            const angle=(135+limit/6*10)*Math.PI/180;
            box(Math.round(x+Math.cos(angle)*46)-2,Math.round(y+Math.sin(angle)*46)-2,5,5,RED);
        }
        glyph(speed,x,y-23,4,SILK);
    }
    box(24,16,2,116,view.active ? PEACH : SOFT);
    if(view.active) {
        const distance=view.distance!==null&&view.distance<=9999 ? view.distance : null;
        glyph(distance,164,26,7, distance===null?SOFT:SILK);
        // Cyrillic lowercase «м» beside the large numeric distance.
        if(distance!==null) {
            box(287,101,3,15,SOFT); box(303,101,3,15,SOFT);
            for(let i=0;i<9;i++) { box(287+i,101+i,3,3,SOFT); box(303-i,101+i,3,3,SOFT); }
        }
        box(338,22,1,104,[89,57,70]);
        const map = view.limitScope === 'map';
        const advisory = map || view.limitScope === 'speedcam';
        dial(431,76,view.speed,view.limitScope === 'road' ? view.limit : null);
        ring(566,75,46,5,view.limit===null ? SOFT : advisory ? AMBER : RED);
        glyph(view.limit,566,map ? 50 : 56,3,SILK);
        if (map) MAP_CAPTION.forEach((letters,y) => letters.forEach((letter,i) => {
            for (let x=0;x<letter.length;x++) if (letter[x] === '1') box(537+i*12+x*2,91+y*2,2,2,AMBER);
        }));
    } else {
        dial(320,76,view.speed,null);
    }
    return rgbaPng(WIDTH, HEIGHT, raw, 2);
}

module.exports = { NAMES, COMMANDS, model, approachLimit, limitText, roadDirection, cameraDistance, regionsModel, regionName, REGION_ROWS, speedcamStatus, graphic };
