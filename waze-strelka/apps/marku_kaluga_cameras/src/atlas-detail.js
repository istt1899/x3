// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const trip = require('./trip_view.js');
const camera = require('./view_model.js');
const diagnostics = require('./diagnostics_view.js');

// One non-focusable graphic per actual RHMI state. Existing controls retain their
// widget types, guards and values; the graphic refers to actions by native name.
const pageIds = {main:1, logs:2, cameras:3, diagnostics:4, alerts:5, types:6, calibration:7,
    position:8, database:9, overspeed:11, diagnosticPhoto:12, cameraDetail:14, about:15, regions:16};
const names = {};
Object.keys(pageIds).forEach(page => { names[page] = 'atlasDetailGraphic' + pageIds[page]; });

const catalog = {
    cameraDetail:['Карточка камеры','camera', [['tripCameraDiagnostics','Диагностика']]],
    regions:['Региональные пакеты','map', [['tripRegionPage','Следующие регионы'],['tripRegionRefresh','Обновить список'],
        ['tripRegionDownload','Загрузить / продолжить'],['tripRegionRollback','Откатить пакет'],['tripLegacyDatabase','База автомобиля']]],
    database:['База автомобиля','map',[['cameraUpdate','Проверить базу'],['cameraRollback','Вернуть версию'],['cameraCoverageDetails','Покрытие']]],
    diagnostics:['Диагностика','signal',[['cameraDiagFreeze','Снимок для фото'],['cameraDiagTest','Тест изображения'],
        ['cameraDiagMore','Следующие строки'],['cameraDiagResultMore','Ещё о команде'],['cameraDiagExport','Сохранить JSON']]],
    diagnosticPhoto:['Снимок диагностики','signal',[]],
    cameras:['Настройки','settings',[['cameraAlertsLink','Оповещения'],['cameraTypesLink','Типы камер'],['cameraHudSetup','HUD'],
        ['cameraMapSetup','Приборы'],['cameraDatabaseLink','База'],['cameraDiagnostics','Диагностика']]],
    alerts:['Оповещения','settings',[['cameraEnable','Предупреждения'],['cameraDistanceRecommended','Дальность 1000 м'],['cameraOverspeedLink','Мигание и звук']]],
    types:['Типы контроля','settings',[['cameraTypesAll','Включить все типы']]],
    overspeed:['Мигание и звук','audio',[['cameraSoundEnabled','Включить / выключить звук'],['cameraDiagAudio','Проверить звук'],
        ['cameraOverspeedRecommended','Рекомендуемые значения']]],
    calibration:['Калибровка экрана','display',[['cameraCardOutput','Вывод на экран'],['cameraTestStart','Показать / скрыть тест'],
        ['cameraCardPosition','Положение'],['cameraCardReset','Базовый профиль'],['cameraCardSave','Готово']]],
    position:['Положение карточки','display',[['cameraCardLeft','Влево'],['cameraCardRight','Вправо'],['cameraCardUp','Вверх'],
        ['cameraCardDown','Вниз'],['cameraPositionTest','Показать / скрыть тест']]],
    main:['Карты телефона','map',[['wocProfile','Профиль'],['wocLogs','Журнал'],['wocCameras','Настройки камер']]],
    logs:['Журнал приложения','signal',[['wocCapture','Запись журнала'],['wocLogsSave','Сохранить журнал']]],
    about:['О приложении','info',[['tripAboutLogs','Журнал приложения']]]
};
function inlineButton(command,label,index,enabled) {
    const start=582,room=980,half=room/2;
    return {command,label,enabled,inline:true,x:start+(index%2)*half,y:94+Math.floor(index/2)*52,w:half-8,h:47};
}
const face = {front:'В лоб',rear:'В спину',both:'В обе стороны'};
function confirmedDirection(alert) {
    const a=alert||{},capture=a.capture;
    const side=v=>Object.prototype.hasOwnProperty.call(face,v);
    if(a.captureDirectionVerified===true&&side(a.captureDirection))return a.captureDirection;
    if(!capture||capture.verified!==true||!a.captureClass||a.captureClass==='cross')return 'unknown';
    if(side(capture.side))return capture.side;
    return Number.isFinite(capture.facingDeg)&&side(a.captureClass)?a.captureClass:'unknown';
}
const palette = {bg:'#101e1d',side:'#172b27',panel:'#1e342e',edge:'#385346',fg:'#f1f7ec',muted:'#b6c8bb',green:'#a6e4aa',quiet:'#758b7e'};
const dash = '—';
function safe(v) { return v == null || v === '' ? dash : String(v).replace(/[\u0000-\u001f]+/g, ' ').trim() || dash; }
function on(v) { return v === true ? 'Вкл.' : v === false ? 'Выкл.' : dash; }
function unit(v,u) { return Number.isFinite(v) ? v + ' ' + u : dash; }
function statusLine(written, name) { return safe(written[name]); }
function splitRow(value) {
    const s=safe(value), pos=s.indexOf(' • ');
    return pos>0 ? [s.slice(0,pos),s.slice(pos+3)] : ['',s];
}
function buttonsFor(page, written) {
    const visible = catalog[page][2].filter(a=>written['visible:'+a[0]]!==false);
    const n=visible.length, gap=10, start=28, width=n?(1600-2*start-gap*(n-1))/n:0;
    return visible.map((a,i)=>({command:a[0],label:a[1],x:start+i*(width+gap),y:436,w:width,h:65,
        enabled:written['enabled:'+a[0]]!==false}));
}
function model(page, input) {
    if(!Object.prototype.hasOwnProperty.call(catalog,page))return null;
    const context=input||{}, state=context.state||null, live=state||{}, written=context.written||{};
    const spec=catalog[page], v={page,title:spec[0],icon:spec[1],lead:'',side:'',rows:[],buttons:buttonsFor(page,written)};
    const ride=trip.model(state,context.version);
    const w=(name)=>statusLine(written,name), set=(lead,side,rows)=>{v.lead=safe(lead);v.side=safe(side);v.rows=rows;};
    const target=context.target==='map'?'map':'hud', display=target==='map'?'Приборы':'HUD';
    const outputs=live.outputs||{}, raw=live.alert||{}, prefs=camera.alertPreferences(state), over=camera.overspeedPreferences(state);
    if(page==='cameraDetail'){
        v.lens=ride.active?confirmedDirection(raw):'unknown';
        set(face[v.lens]||'Сторона неизвестна',ride.text.tripCameraStatus,[
            ['Дистанция',unit(ride.distance,'м')],['Лимит',trip.limitText(trip.approachLimit(ride.active?raw:null)).replace(/^Лимит /,'')],
            ['Камера',ride.active?ride.text.tripCameraIdentity:dash],['Подход',ride.text.tripCameraRoad],['Основание',ride.text.tripCameraEvidence.replace(/^Основание: /,'')]]);
    }else if(page==='regions'){
        const region=context.region||trip.regionsModel(state,null,null), item=region.selected;
        const data=region.data||{};
        const activePack=['downloading','verifying','installing','rolling-back'].indexOf(data.phase)>=0&&
            Array.isArray(data.regions)&&data.regions.find(entry=>entry.region===data.selectedRegion);
        const updateStatus=written.tripRegionStatus||region.text.tripRegionStatus;
        v.regionResult=written.tripRegionResult||trip.speedcamStatus(live.database,live.speedcamDownload);
        set(item?trip.regionName(item):'Регион не выбран',activePack?updateStatus+' · '+trip.regionName(activePack):updateStatus,[
            ['Установлено',item?safe(item.currentVersion):dash],['Доступно',item?safe(item.availableVersion):dash],
            ['Покрытие',region.text.tripRegionCoverage],['Дорожные данные',region.text.tripRegionRoad],['Источник',region.text.tripRegionSource]]);
        v.regionRows=region.rows.map((entry,i)=>({name:trip.regionName(entry),selected:!!item&&entry.region===item.region,
            control:inlineButton('atlasRegion:'+entry.region,trip.regionName(entry),i,written['enabled:tripRegionSelector']!==false)}));
        v.regionPage=(region.index+1)+' / '+region.pages;
        v.buttons=v.regionRows.map(r=>r.control).concat(v.buttons);
    }else if(page==='database'){
        const values=camera.model(state).text, db=live.database||{};
        set(Number.isFinite(db.count)?db.count+' объектов':'Нет данных о базе',values.cameraDate,[
            ['Состав базы',values.cameraDatabase],['Лимиты',values.cameraCoverageLimits],['Подходы',values.cameraCoverageRoad],
            ['Направления',values.cameraCoverageDirection],['Последнее действие',w('cameraDatabaseCommand')]]);
    }else if(page==='diagnostics'){
        const source=context.diagnosticState||live;
        const current=written['cell:cameraDiagSelector:SelectedItem']||0;
        const initial=written.cameraDiag_page?null:diagnostics.reportPage(null,source,context.version,current,0).rows;
        const row=key=>written['cameraDiag_'+key]||(initial&&initial[key])||' ';
        const tabs=diagnostics.PAGE_TITLES.map((label,i)=>({command:'atlasDiagnostic:'+i,label,
            x:28+i*258,y:90,w:248,h:48,enabled:true,inline:true}));
        v.report={title:row('page'),tabs,selected:current,lines:[],command:row('command'),more:row('commandMore')};
        for(let i=1;i<=diagnostics.PAGE_ROWS;i++)v.report.lines.push(row('row'+i));
        v.buttons=v.buttons.slice(0,1).concat(tabs,v.buttons.slice(1));
    }else if(page==='diagnosticPhoto'){
        const snap=context.snapshot;
        if(!snap){set('Ожидание снимка','Диагностика',[['Состояние','Откройте «Снимок для фото» из диагностики.']]);}
        else{
            const diagState=snap.state||{},savedOutputs=diagState.outputs||{};
            const photoRows=diagnostics.photoRows(snap,!!diagState.serviceVersion,savedOutputs.hud?'hud':savedOutputs.cluster?'map':null);
            const rows=diagnostics.PHOTO_NAMES.map((name,i)=>written[name]&&written[name]!==' '?written[name]:photoRows[i]);
            const savedRide=trip.model(diagState,context.version);
            const lens=savedRide.active?face[confirmedDirection(diagState.alert)]||'неизвестно':dash;
            v.photo=rows.concat(['Сторона съёмки: '+lens+' • '+savedRide.text.tripCameraEvidence]);
            set('Зафиксировано',snap.id,v.photo.map(splitRow));
        }
    }else if(page==='cameras'){
        set('Предупреждения',state?on(live.enabled):'Сервис недоступен',[
            ['Проекция HUD',on(outputs.hud)],['Приборы',on(outputs.cluster)],['Дальность',unit(prefs.warningDistanceM,'м')],
            ['Типы камер',prefs.enabledCount==null?dash:prefs.enabledCount+' из '+camera.ALERT_TYPES.length],['Звук',on(over.soundEnabled)]]);
    }else if(page==='alerts'){
        set(unit(prefs.warningDistanceM,'м'),'Дальность предупреждения',[
            ['Предупреждения',state?on(live.enabled):dash],['Диапазон','50–1000 м · шаг 50 м'],
            ['Типы контроля',prefs.enabledCount===null?dash:prefs.enabledCount+' из '+camera.ALERT_TYPES.length],
            ['Состояние',prefs.reason||w('cameraPreferencesStatus')],['Команда',w('cameraAlertCommand')]]);
    }else if(page==='types'){
        const count=prefs.enabledCount;
        set(count==null?'Нет данных':count+' из '+camera.ALERT_TYPES.length,'Включённые типы контроля',[]);
        v.types=camera.ALERT_TYPES.map((t,i)=>({label:t.label,on:prefs.available?prefs.cameraTypes[t.key]:null,
            control:inlineButton('cameraType_'+t.key,t.label,i,prefs.available&&written['enabled:cameraType_'+t.key]!==false)}));
        v.buttons=v.types.map(r=>r.control).concat(v.buttons);
    }else if(page==='overspeed'){
        set(over.available?on(over.soundEnabled):'Нет данных','Звуковые предупреждения',[
            ['Мигание / порог',on(over.visualFlash)+' · '+unit(over.visualOffsetKmh,'км/ч')],['Порог звука',unit(over.soundOffsetKmh,'км/ч')],
            ['Дистанция',unit(over.soundDistanceM,'м')],['Повтор',over.soundRepeatSec===0?'Однократно':unit(over.soundRepeatSec,'с')],
            ['Канал',over.audioReason]]);
    }else if(page==='calibration'||page==='position'){
        const profile=(live.cardLayout||{})[target]||{},test=live.displayTest||{};
        v.preview={x:profile.x,y:profile.y,size:profile.scalePct};
        set(display,test.active&&test.target===target?'Тест активен':'Предпросмотр профиля',[
            ['По горизонтали',unit(Number.isFinite(profile.x)?profile.x/10:null,'%')],['По вертикали',unit(Number.isFinite(profile.y)?profile.y/10:null,'%')],
            ['Размер',unit(profile.scalePct,'%')],['Яркость',unit(profile.brightnessPct,'%')],['Непрозрачность',unit(profile.opacityPct,'%')]]);
    }else if(page==='main'){
        set('Карты телефона','Вывод навигации',[
            ['Проекция',w('wocHud')],['Приборы',w('wocMap')],['CarPlay',w('wocStatus')],['Android Auto',w('wocAaStatus')]]);
    }else if(page==='logs'){
        set('Журнал','Диагностика приложения',[
            ['Запись',w('wocCaptureStatus')],['Архивы',w('wocLogsStatus')],['Последний журнал',w('wocLogsRow1')]]);
    }else{
        set('Яндекс Стрелка','Атлас · BMW iDrive 7',[
            ['Версия приложения',safe(context.version)],['Камеры','Предупреждения на подходе'],
            ['Управление','Касание или поворот и нажатие iDrive'],['Выходы','Центральный экран, приборы и HUD']]);
    }
    return v;
}

function drawDetail(cv,page,v) {
    if(!v)return;
    const p=palette, panel=(x,y,w,h,r,ink)=>cv.roundRect(x,y,w,h,r,ink);
    const line=(a,b,x,y,ink,width)=>cv.line(a,b,x,y,width||2,ink);
    function txt(text,x,y,size,color,max,align) {
        const str=safe(text);
        const opts={align:align||'left',literal:true};
        const measured=typeof cv.textWidth==='function'?cv.textWidth(str,size,opts):null;
        const width=Number.isFinite(measured)&&measured>0?measured:str.length*size*.68;
        const fit=Math.min(size,size*max/Math.max(1,width));
        cv.text(str,x,y,Math.max(8,Math.floor(fit)),color,opts);
    }
    cv.fillRect(0,0,1600,520,p.bg);
    txt(v.title,32,55,43,p.fg,1280);
    line(32,76,1568,76,p.edge,2);
    if(v.report){
        const r=v.report;
        r.tabs.forEach((b,i)=>{
            const active=r.selected===i;
            if(v.buttons.some(target=>target.command===b.command))panel(b.x,b.y,b.w,b.h,7,active?p.panel:p.side);
            if(active)line(b.x+8,b.y+b.h-2,b.x+b.w-8,b.y+b.h-2,p.green,3);
            txt(b.label,b.x+b.w/2,b.y+32,26,active?p.fg:p.muted,b.w-22,'center');
        });
        txt(r.title,32,171,26,p.green,1530);
        r.lines.forEach((value,i)=>{
            if(!value.trim())return;
            const x=i<5?32:810, y=182+(i%5)*32;
            txt(value,x,y+22,24,p.fg,750);
        });
        line(30,350,1568,350,p.edge,2);
        txt(r.command,32,382,24,p.muted,1530);
        if(r.more.trim())txt(r.more,32,412,24,p.muted,1530);
    }else if(v.photo){
        const width=750,height=72, gap=10;
        v.photo.forEach((item,i)=>{
            const col=i<4?0:1, row=i%4,x=32+col*(width+32),y=92+row*(height+gap);
            panel(x,y,width,height,10,p.panel);
            const chunks=splitRow(item);
            if(chunks[0]){txt(chunks[0],x+16,y+29,24,p.muted,width-32);txt(chunks[1],x+16,y+61,29,p.fg,width-32);}
            else txt(chunks[1],x+16,y+49,28,p.fg,width-32);
        });
        if(!v.buttons.length)txt(v.side,32,489,25,p.green,1500);
    }else{
        const col=525;
        panel(28,94,col,320,15,p.side);
        const artX=col/2+28;
        if(page==='cameraDetail'){
            const bx=artX-22,by=166;
            panel(bx,by,45,75,12,p.fg);panel(bx+5,by+13,35,23,5,p.side);panel(bx+6,by+53,33,8,2,p.side);
            line(bx+6,by+7,bx+13,by+5,p.edge,3); line(bx+32,by+5,bx+39,by+7,p.edge,3);
            line(bx+6,by+69,bx+13,by+69,'#aa6657',3);line(bx+32,by+69,bx+39,by+69,'#aa6657',3);
            function ray(tail) {
                const sy=tail?by+102:by-28,ex=bx+40,ey=tail?by+72:by+2, cx=bx+100;
                panel(cx-13,sy-9,31,19,4,p.green);panel(cx-8,sy-13,11,6,2,p.green);
                cv.circle(cx+4,sy,6,p.side);cv.circle(cx+4,sy,3,p.green);
                line(cx-14,sy,ex,ey,p.green,4);
                line(ex,ey,ex+4,ey+(tail?12:-12),p.green,3);
                line(ex,ey,ex+14,ey+(tail?1:-1),p.green,3);
            }
            if(v.lens==='front'||v.lens==='both')ray(false);
            if(v.lens==='rear'||v.lens==='both')ray(true);
            if(v.lens==='unknown')txt('?',bx+72,by+55,42,p.muted,52);
        }else if(v.preview){
            const f=v.preview, w=230,h=110,x=artX-w/2,y=141;
            panel(x,y,w,h,9,p.edge);panel(x+4,y+4,w-8,h-8,8,p.bg);
            if(Number.isFinite(f.x)&&Number.isFinite(f.y)&&Number.isFinite(f.size)){
                const sw=56*f.size/100,sh=26*f.size/100,xx=x+7+(w-sw-14)*Math.min(1,Math.max(0,f.x/1000)),
                    yy=y+7+(h-sh-14)*Math.min(1,Math.max(0,f.y/1000));
                panel(xx,yy,sw,sh,4,p.green);
            }
        }else{
            const x=artX,y=196;
            if(v.icon==='map'){
                [[-65,19,-33,-22],[-33,-22,5,4],[5,4,48,-40]].forEach(a=>line(x+a[0],y+a[1],x+a[2],y+a[3],p.green,6));
                cv.circle(x-65,y+19,8,p.fg);cv.circle(x+48,y-40,9,p.fg);
            }else if(v.icon==='settings'){
                [-24,0,24].forEach((offset,i)=>{line(x-44,y+offset,x+44,y+offset,p.muted,4);cv.circle(x+[-14,18,-2][i],y+offset,8,p.green);});
            }else if(v.icon==='signal'||v.icon==='audio'){
                [[-56,3,-28,3],[-28,3,-15,-27],[-15,-27,6,26],[6,26,26,-8],[26,-8,36,3],[36,3,53,3]].forEach(a=>line(x+a[0],y+a[1],x+a[2],y+a[3],p.green,5));
            }else{cv.circle(x,y,32,p.green);txt('i',x,y+15,44,p.bg,50,'center');}
        }
        txt(v.lead,artX,321,43,p.fg,col-44,'center');
        txt(v.side,artX,v.regionRows?359:367,25,p.muted,col-48,'center');
        if(v.regionRows)txt(v.regionResult,artX,397,21,p.muted,col-48,'center');
        const start=582, room=1600-start-38;
        if(v.types||v.regionRows){
            const cells=v.types||v.regionRows;
            cells.forEach(t=>{
                const b=t.control,selected=t.selected===true||t.on===true, xx=b.x,yy=b.y, cy=yy+b.h/2;
                if(v.buttons.some(target=>target.command===b.command))panel(xx,yy,b.w,b.h,6,selected?p.panel:p.side);
                cv.circle(xx+17,cy,6,selected?p.green:p.quiet);
                txt(t.label||t.name,xx+33,cy+8,24,selected?p.fg:p.muted,b.w-45);
            });
            if(v.regionRows){
                txt('Регионы   '+v.regionPage,start,285,24,p.green,room);
                txt(v.rows[0][0]+'   '+v.rows[0][1]+'      '+v.rows[1][0]+'   '+v.rows[1][1],start,320,24,p.fg,room);
                txt(v.rows[2][1],start,355,23,p.muted,room);
                txt(v.rows[3][1],start,385,23,p.muted,room);
                txt(v.rows[4][1],start,415,22,p.muted,room);
            }
        }else{
            const n=v.rows.length, step=Math.min(67,307/Math.max(1,n));
            v.rows.forEach((row,i)=>{const yy=111+i*step;
                txt(row[0],start,yy+24,23,p.muted,230);
                txt(row[1],start+252,yy+25,26,p.fg,room-254);
                line(start,yy+step-6,start+room,yy+step-6,p.edge,1);
            });
        }
    }
    v.buttons.filter(b=>!b.inline).forEach(b=>{
        panel(b.x,b.y,b.w,b.h,9,b.enabled?p.panel:p.side);
        txt(b.label,b.x+14,b.y+41,25,b.enabled?p.green:p.quiet,b.w-30);
    });
}

module.exports={names,pageIds,model,drawDetail,confirmedDirection};
