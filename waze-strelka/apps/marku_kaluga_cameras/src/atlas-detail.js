// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const trip = require('./trip_view.js');
const camera = require('./view_model.js');
const diagnostics = require('./diagnostics_view.js');
const diagnosticCards = require('./atlas-diagnostics.js');
const controls = require('./atlas-controls.js');
const phoneMaps = require('./atlas-phone-maps.js');
const composition = require('./atlas-card-composition.js');
const qr = require('./qrcodegen.js');
const cameraScene = require('./atlas-camera-scene.js');

// One non-focusable graphic per actual RHMI state. Existing controls retain their
// widget types, guards and values; the graphic refers to actions by native name.
const pageIds = {main:1, logs:2, cameras:3, diagnostics:4, alerts:5, types:6, calibration:7,
    position:8, database:9, overspeed:11, diagnosticPhoto:12, cameraDetail:14, about:15, regions:16, atlasMenu:17};
const names = {};
Object.keys(pageIds).forEach(page => { names[page] = 'atlasDetailGraphic' + pageIds[page]; });

const catalog = {
    atlasMenu:['Меню поездки','menu'], cameraDetail:['Карточка камеры','camera'],
    regions:['Регионы и пакеты','map'], database:['База автомобиля','map'],
    diagnostics:['Диагностика','signal'], diagnosticPhoto:['Снимок диагностики','signal'],
    cameras:['Настройки камер','settings'], alerts:['Оповещения','signal'], types:['Типы контроля','camera'],
    overspeed:['Мигание и звук','audio'], calibration:['Калибровка экрана','display'], position:['Положение карточки','display'],
    main:['Карты телефона','phone'], logs:['Журнал приложения','signal'], about:['О приложении','info']
};
const face = {front:'В лоб',rear:'В спину',both:'В обе стороны'};
const confirmedDirection = cameraScene.confirmedDirection;
const dash = '—';
function safe(v) { return v == null || v === '' ? dash : String(v).replace(/[\u0000-\u001f]+/g, ' ').trim() || dash; }
function on(v) { return v === true ? 'Вкл.' : v === false ? 'Выкл.' : dash; }
function unit(v,u) { return Number.isFinite(v) ? v + ' ' + u : dash; }
function statusLine(written, name) { return safe(written[name]); }
function splitRow(value) {
    const s=safe(value), pos=s.indexOf(' • ');
    return pos>0 ? [s.slice(0,pos),s.slice(pos+3)] : ['',s];
}
function outputText(value) {
    return value===true?'Вывод включён':value===false?'Вывод выключен':'Состояние выхода неизвестно';
}
function calibrationModel(context,target) {
    const state=context.state, live=state||{}, profile=(live.cardLayout||{})[target]||null;
    const output=(live.outputs||{})[target==='hud'?'hud':'cluster'];
    const testActive=!!(live.displayTest && live.displayTest.active && live.displayTest.target===target);
    const layout=diagnostics.action(state,'cardLayout'), save=diagnostics.action(state,'displayTestStop');
    let test=testActive ? save : (context.testGuard || diagnostics.action(state,'displayTest'));
    if(!testActive && test.allowed && output!==true) {
        test={allowed:false,reason:(target==='hud'?'Проекция HUD':'Приборная панель')+' выключена. Откройте «Вывод и состав» и включите этот выход.'};
    }
    const storage=live.storage||{}, written=context.written||{};
    const storageText=(!state?'Сервис недоступен':written.cameraCardStorage) || (!profile?'Сервис не сообщил профиль экрана':
        !layout.allowed?layout.reason:storage.persistent===false?'Изменения временные • хранилище недоступно':
        storage.settingsSaved===true&&storage.persistent===true?'Изменения сохранены в автомобиле':
        'Сохранение ожидает подтверждения сервиса');
    const options=composition.rows(target,state);
    const compositionGuard=diagnostics.action(state,'cardLayout');
    const compositionAvailable=!!(live.capabilities && live.capabilities.cardComposition===true && live.cardComposition && live.cardComposition[target]);
    return {target,profile,output,canOutput:!!(live.capabilities&&live.capabilities.outputs),layout,save,test,testActive,storageText,
        positionHint:written.cameraPositionHint,
        compositionReason:!compositionAvailable?'Обновите сервис для настройки состава уведомления':!compositionGuard.allowed?compositionGuard.reason:'',
        composition:options.map(option=>({command:'atlasComposition:'+option.key,kind:'toggle',key:option.key,
            label:option.label,description:option.description,selected:compositionAvailable?option.enabled:null,
            enabled:compositionAvailable&&compositionGuard.allowed}))};
}
function model(page, input) {
    if(!Object.prototype.hasOwnProperty.call(catalog,page))return null;
    const context=input||{}, state=context.state||null, live=state||{}, written=context.written||{};
    const spec=catalog[page], v={page,title:spec[0],icon:spec[1],lead:'',side:'',rows:[],buttons:[]};
    const ride=trip.model(state,context.version);
    const w=(name)=>statusLine(written,name), set=(lead,side,rows)=>{v.lead=safe(lead);v.side=safe(side);v.rows=rows;};
    const target=context.target==='map'?'map':'hud', display=target==='map'?'Приборы':'HUD';
    const outputs=live.outputs||{}, raw=live.alert||{}, prefs=camera.alertPreferences(state), over=camera.overspeedPreferences(state);
    if(page==='atlasMenu'){
        set('Атлас',ride.text.tripCameraStatus,[['Скорость',unit(ride.speed,'км/ч')],['Экраны',ride.text.tripOutputs]]);
    }else if(page==='cameraDetail'){
        v.ride=cameraScene.model(state,context.version,context.centralCameraScalePct);
        v.lens=v.ride.side;
        const destination=(context.atlasPanel||{}).cameraOutput;
        if(destination==='all') return cameraScene.editor(v,context);
        set(face[v.lens]||'Сторона неизвестна',ride.text.tripCameraStatus,[
            ['Дистанция',unit(ride.distance,'м')],['Лимит',trip.limitText(trip.approachLimit(ride.active?raw:null)).replace(/^Лимит[: ]+/, '')],
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
        v.regionRows=region.rows.map(entry=>({name:trip.regionName(entry),selected:!!item&&entry.region===item.region,
            control:{command:'atlasRegion:'+entry.region,enabled:written['enabled:tripRegionSelector']!==false}}));
        v.regionPage=(region.index+1)+' / '+region.pages;
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
        const selectedTab=current===0 && context.diagnosticService ? 'service' : current===4 ? '3' : String(current);
        const tabs=diagnosticCards.tabs.map(([id,label])=>({command:'atlasDiagnostic:'+id,label,selected:id===selectedTab}));
        v.diagnosticCards=diagnosticCards.cards(selectedTab,state,context.version);
        v.report={title:row('page'),tabs,selected:current,lines:[],command:row('command'),more:row('commandMore')};
        for(let i=1;i<=diagnostics.PAGE_ROWS;i++)v.report.lines.push(row('row'+i));
    }else if(page==='diagnosticPhoto'){
        const snap=context.snapshot;
        if(!snap){set('Ожидание снимка','Диагностика',[['Состояние','Откройте «Снимок для фото» из диагностики.']]);}
        else{
            const diagState=snap.state||{},savedOutputs=diagState.outputs||{};
            const connected=typeof diagState.serviceReady==='boolean' ? diagState.serviceReady : !!diagState.serviceVersion;
            const photoRows=diagnostics.photoRows(snap,connected,savedOutputs.hud?'hud':savedOutputs.cluster?'map':null);
            v.diagnosticCards=diagnosticCards.cards('0',connected ? diagState : null,snap.appVersion);
            const at=new Date(snap.capturedAtMs);
            if(Number.isFinite(at.getTime()))v.diagnosticCards.push(['Время снимка (UTC)',at.toISOString().slice(0,19).replace('T',' ')]);
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
        const result=live.commandResult||{};
        if(result.command==='display-test-stop' && result.phase==='finished'){
            const stored=live.storage||{};
            v.rows.push(['Сохранение профиля',stored.settingsSaved===true&&stored.persistent===true?'Сохранён в автомобиле':'Сохранение не подтверждено']);
        }
    }else if(page==='alerts'){
        v.alertsEnabled=state&&typeof live.enabled==='boolean'?live.enabled:null;
        set(unit(prefs.warningDistanceM,'м'),'Дальность предупреждения',[
            ['Предупреждения',state?on(live.enabled):dash],['Диапазон','50–1000 м · шаг 50 м'],
            ['Типы контроля',prefs.enabledCount===null?dash:prefs.enabledCount+' из '+camera.ALERT_TYPES.length],
            ['Состояние',prefs.reason||w('cameraPreferencesStatus')],['Команда',w('cameraAlertCommand')]]);
    }else if(page==='types'){
        const count=prefs.enabledCount;
        set(count==null?'Нет данных':count+' из '+camera.ALERT_TYPES.length,'Включённые типы контроля',[]);
        v.types=camera.ALERT_TYPES.map(t=>({label:t.label,on:prefs.available?prefs.cameraTypes[t.key]:null,
            control:{command:'cameraType_'+t.key,enabled:prefs.available&&written['enabled:cameraType_'+t.key]!==false}}));
    }else if(page==='overspeed'){
        set(over.available?on(over.soundEnabled):'Нет данных','Звуковые предупреждения',[
            ['Мигание / порог',on(over.visualFlash)+' · '+unit(over.visualOffsetKmh,'км/ч')],['Порог звука',unit(over.soundOffsetKmh,'км/ч')],
            ['Дистанция',unit(over.soundDistanceM,'м')],['Повтор',over.soundRepeatSec===0?'Однократно':unit(over.soundRepeatSec,'с')],
            ['Канал',over.audioReason]]);
    }else if(page==='calibration'||page==='position'){
        const c=calibrationModel(context,target), profile=c.profile||{};
        v.title=(page==='position'?'Положение':'Калибровка')+(target==='hud'?' HUD':' на приборах');
        v.calibration=c;
        const renderer=(live.rendererDetails||{})[target]||{};
        v.preview={x:profile.x,y:profile.y,size:profile.scalePct,brightness:profile.brightnessPct,opacity:profile.opacityPct,
            canvas:renderer.layout&&renderer.layout.canvas};
        set(display,c.testActive?'Тест включён':outputText(c.output),[
            ['X · Горизонталь',unit(Number.isFinite(profile.x)?profile.x/10:null,'%')],['Y · Вертикаль',unit(Number.isFinite(profile.y)?profile.y/10:null,'%')],
            ['Размер',unit(profile.scalePct,'%')],['Яркость',unit(profile.brightnessPct,'%')],['Прозрачность',unit(Number.isFinite(profile.opacityPct)?100-profile.opacityPct:null,'%')]]);
    }else if(page==='main'){
        v.maps=context.phoneMaps || {cluster:null,hud:null,available:false,hudDisabled:false,
            width:null,offset:null,error:'',centerScale:100,centerError:''};
        v.mapConfirm=context.atlasPanel && context.atlasPanel.mapConfirm || null;
        v.interactive=context.mapInteractive===true;
        set('Навигация телефона','Apple CarPlay / Android Auto',[
            ['CarPlay',w('wocStatus')],['Android Auto',w('wocAaStatus')],['На приборной панели',w('wocMap')],
            ['Проекция HUD',w('wocHud')],['Масштаб Android Auto',w('wocAaZoom')],['Положение на HUD',w('wocHudPos')] ]);
    }else if(page==='logs'){
        const rows=[['Запись',w('wocCaptureStatus')],['Архивы',w('wocLogsStatus')]];
        for(let i=1;i<=5;i++){
            const name=w('wocLogsRow'+i);
            if(name!==dash)rows.push(['Архив '+i,name]);
        }
        const address=w('wocLogsUrl');
        const link=address.match(/https?:\/\/[^\s]+$/);
        if(link&&link[0].length<=256)v.archiveUrl=link[0];
        rows.push(['Адрес',address]);
        set('Журнал',w('wocCaptureStatus'),rows);
    }else{
        set('Яндекс Стрелка','Атлас · BMW iDrive 7',[
            ['Версия приложения',safe(context.version)],['Камеры','Предупреждения на подходе'],
            ['Управление','Касание или поворот и нажатие iDrive'],['Выходы','Центральный экран, приборы и HUD']]);
    }
    const commandName={alerts:'cameraAlertCommand',position:'cameraPositionCommand',database:'cameraDatabaseCommand',overspeed:'cameraOverspeedCommand'}[page];
    if(commandName){
        const parts=[written[commandName],written[commandName+'More']].filter(t=>typeof t==='string'&&t.trim());
        v.feedback=parts.join(' · ');
    }
    if(page==='position' && v.calibration){
        if(!v.calibration.test.allowed)v.feedback=v.calibration.test.reason;
        else if(v.calibration.positionHint)v.feedback=v.calibration.positionHint;
    }
    if(page==='calibration'){
        v.feedback=state?written.cameraCardStatus||'':'';
        const names=['cameraCommand','cameraCommandMore'];
        for(let i=3;i<=32;i++)names.push('cameraCardResultLine'+i);
        v.resultLines=names.map(name=>written[name]).filter(line=>typeof line==='string'&&line.trim());
        if(!v.resultLines.length)delete v.resultLines;
    }
    if(page==='regions')v.feedback=v.regionResult;
    if(page==='diagnostics')v.feedback=v.report.command;
    const view=controls.apply(v,context);
    if(page==='cameraDetail'){
        const slots={atlasCameraOpen:[24,649],tripCameraDiagnostics:[695,556],atlasBack:[1273,291]};
        view.buttons.forEach(button=>{
            const place=slots[button.command];
            if(place)Object.assign(button,{x:place[0],y:443,w:place[1],h:60});
            if(button.command===cameraScene.open)delete button.source;
        });
    }
    return view;
}

// Everything on the canvas is expressed in the same 1600-pixel coordinate system as its hit targets.
const P = {bg:'#0b1818', surface:'#142a28',tile:'#203c37', focus:'#8bdfc4', ink:'#0c211c',
    text:'#f4f8ed',dim:'#b8cec6',line:'#3a5850',off:'#91a69e',soft:'#203630',gold:'#efc584'};
function words(cv,value,x,y,size,max,color,bold,align) {
    const str=safe(value), options={literal:true,font:bold?'bold':'label',align:align||'left'};
    let font=size;
    if(typeof cv.textWidth==='function'){
        const measured=cv.textWidth(str,size,options);
        if(measured>max)font=Math.max(10,Math.floor(size*max/measured));
    }
    cv.text(str,x,y,font,color||P.text,options);
}
function symbol(cv,icon,x,y,color,size) {
    const k=(size||30)/30;
    const line=(a,b,c,d,w)=>cv.line(x+a*k,y+b*k,x+c*k,y+d*k,(w||2.5)*k,color);
    const circle=(a,b,r)=>cv.circle(x+a*k,y+b*k,r*k,color);
    const box=(a,b,w,h)=>{line(a,b,a+w,b);line(a+w,b,a+w,b+h);line(a+w,b+h,a,b+h);line(a,b+h,a,b);};
    if(icon==='back'||icon==='next'){const sign=icon==='back'?-1:1;line(-10,0,10,0);line(9*sign,0,2*sign,-7);line(9*sign,0,2*sign,7);}
    else if(icon==='camera'){box(-12,-7,24,16);line(-7,-10,0,-10);circle(2,1,4);}
    else if(icon==='map'){line(-11,-8,-4,-12);line(-4,-12,4,-7);line(4,-7,12,-11);line(-11,-8,-11,10);line(-11,10,-4,5);line(-4,5,4,10);line(4,10,12,5);line(12,5,12,-11);}
    else if(icon==='phone'){box(-8,-13,16,26);line(-3,9,3,9);}
    else if(icon==='settings'){[-8,0,8].forEach((dy,i)=>{line(-12,dy,12,dy);circle(i===1?5:-4,dy,3);});}
    else if(icon==='signal'||icon==='audio'){line(-14,1,-7,1);line(-7,1,-3,-9);line(-3,-9,3,9);line(3,9,7,-2);line(7,-2,14,-2);}
    else if(icon==='display'){box(-13,-10,26,17);line(0,7,0,11);line(-6,12,6,12);}
    else if(icon==='check'){line(-9,0,-3,6,3);line(-3,6,9,-7,3);}
    else if(icon==='grid'){[-8,5].forEach(a=>[-8,5].forEach(b=>cv.roundRect(x+a*k,y+b*k,7*k,7*k,2*k,color)));}
    else if(icon==='info'){circle(0,-8,2);line(0,-2,0,9,3);}
    else{line(-4,-7,3,0);line(3,0,-4,7);}
}
function row(cv,label,value,x,y,w,compact) {
    const split=compact?Math.min(180,w*.28):Math.min(205,w*.29);
    words(cv,label,x,y,compact?20:23,split-12,P.dim);
    words(cv,value,x+split,y,compact?22:25,w-split,P.text);
}
function buttonIcon(b) {
    if(b.command==='atlasBack')return 'back';
    if(b.kind==='nav')return b.command==='atlasEditClose'?'check':'next';
    if(b.kind==='editor'||b.kind==='number')return 'settings';
    if(/Camera|cameraDetail|TypesLink/.test(b.command))return 'camera';
    if(/Database|Region|Maps|Coverage/.test(b.command))return 'map';
    if(/HudSetup|MapSetup|CardPosition|Calibration/.test(b.command))return 'display';
    if(/Diag|Audio|Sound|Alerts/.test(b.command))return 'signal';
    if(/Profile|Settings|Overspeed/.test(b.command))return 'settings';
    return 'open';
}
function paragraph(cv,value,x,y,size,width,lineHeight,color,maxLines) {
    if (!value) return y;
    const tokens=String(value).trim().split(/\s+/), lines=[];
    let line='';
    tokens.forEach(word=>{
        const next=line?line+' '+word:word;
        const length=typeof cv.textWidth==='function'?cv.textWidth(next,size,{literal:true,font:'label'}):next.length*size*.55;
        if(line && length>width && lines.length<maxLines-1){lines.push(line);line=word;}else line=next;
    });
    if(line)lines.push(line);
    lines.forEach((text,i)=>words(cv,text,x,y+i*lineHeight,size,width,color));
    return y+lines.length*lineHeight;
}
function shownStep(button,preview) {
    return preview && preview.source===button.source && Number.isInteger(preview.step) ?
        Math.max(0,Math.min(button.max,preview.step)) : button.step;
}
function drawSlider(cv,b,active,preview) {
    const fill=active?P.focus:b.enabled?P.tile:P.soft, fg=active?P.ink:b.enabled?P.text:P.off;
    const rail=active?'#7fa67d':P.line, current=active?P.ink:b.enabled?P.focus:P.off, t=b.track;
    const step=shownStep(b,preview), valid=Number.isInteger(step), wide=b.w>=800;
    const value=preview&&preview.source===b.source?controls.formatStep(b.source,step):b.value;
    cv.roundRect(b.x,b.y,b.w,b.h,9,fill);
    const baseline=wide?b.y+35:b.y+27;
    words(cv,b.label,b.x+18,baseline,wide?26:23,wide?246:b.w-118,fg,true);
    words(cv,value,b.x+b.w-16,baseline,wide?26:23,100,fg,true,'right');
    const cy=t.y+t.h/2;
    cv.roundRect(t.x,cy-4,t.w,8,4,rail);
    if(valid) {
        const travel=Math.round(t.w*step/b.max);
        if(travel>0)cv.roundRect(t.x,cy-4,travel,8,Math.min(4,travel/2),current);
        cv.circle(t.x+travel,cy,10,current);
        cv.circle(t.x+travel,cy,4,fill);
    }
}
function tile(cv,b,focus,preview) {
    const active=b.enabled!==false && (focus===b.command||focus===b.focusKey&&b.focusKey);
    if(b.kind==='slider'){drawSlider(cv,b,active,preview);return;}
    const stateControl=b.kind==='toggle'||b.kind==='choice';
    const filledFocus=active&&!stateControl;
    const bg=filledFocus?P.focus:b.enabled===false?P.soft:P.tile;
    const fg=filledFocus?P.ink:b.enabled===false?P.off:P.text, dim=filledFocus?P.ink:b.enabled===false?P.off:P.dim;
    if(active&&stateControl){
        cv.roundRect(b.x,b.y,b.w,b.h,10,P.focus);
        cv.roundRect(b.x+3,b.y+3,b.w-6,b.h-6,8,bg);
    }else cv.roundRect(b.x,b.y,b.w,b.h,10,bg);
    if(b.kind==='bar'){
        symbol(cv,b.command==='cameraCardSave'?'check':'display',b.x+29,b.y+b.h/2,fg,25);
        words(cv,b.label,b.x+55,b.y+37,27,b.w-70,fg,true);
        return;
    }
    if(b.kind==='nav'){
        symbol(cv,b.command==='atlasBack'||b.command.indexOf('atlasSheet:')===0&&b.x<1000?'back':buttonIcon(b),b.x+28,b.y+b.h/2,dim,25);
        words(cv,b.label,b.x+55,b.y+b.h/2+9,24,b.w-66,fg,true);
        return;
    }
    if(b.kind==='toggle'){
        const known=typeof b.selected==='boolean', available=b.enabled!==false;
        const track=known&&available?(b.selected?'#91cbae':'#d79c98'):P.line;
        cv.roundRect(b.x+18,b.y+16,48,24,12,track);
        if(known)cv.circle(b.x+(b.selected?54:30),b.y+28,8,available?P.ink:P.dim);
        else cv.line(b.x+33,b.y+28,b.x+51,b.y+28,2,P.dim);
    }else if(b.kind==='choice'){
        if(b.selected===true)symbol(cv,'check',b.x+33,b.y+29,P.focus,25);
        else symbol(cv,'open',b.x+33,b.y+29,dim,23);
    }else symbol(cv,buttonIcon(b),b.x+34,b.y+28,dim,28);
    if(b.kind==='choice'||b.kind==='toggle'){
        const state=b.kind==='choice'?(b.selected===true?'Выбрано':''):(b.selected===true?'Вкл.':b.selected===false?'Выкл.':'—');
        if(state)words(cv,state,b.x+b.w-17,b.y+34,22,140,dim,false,'right');
    } else if(b.value){
        words(cv,b.value,b.x+b.w-17,b.y+37,26,b.w-90,dim,true,'right');
    } else if(b.enabled===false){
        words(cv,'Недоступно',b.x+b.w-17,b.y+33,19,150,dim,false,'right');
    }
    words(cv,b.label,b.x+19,b.y+73,28,b.w-38,fg,true);
}
function capture(cv,x,y,side) {
    cv.roundRect(x,y,28,50,7,P.text);
    cv.roundRect(x+4,y+9,20,12,3,P.surface);cv.roundRect(x+5,y+35,18,6,2,P.surface);
    const ray=rear=>{
        const dy=rear?61:-10, end=rear?47:1,sign=rear?-1:1;
        symbol(cv,'camera',x+65,y+dy,P.focus,24);
        cv.line(x+51,y+dy,x+27,y+end,3,P.focus);
        cv.line(x+27,y+end,x+37,y+end-8*sign,3,P.focus);
        cv.line(x+27,y+end,x+38,y+end+3*sign,3,P.focus);
    };
    if(side==='front'||side==='both')ray(false);
    if(side==='rear'||side==='both')ray(true);
    if(side==='unknown')words(cv,'?',x+54,y+34,32,40,P.dim,true);
}
function calibrationPreview(v) {
    const p=Object.assign({},v.preview), drag=v.sliderPreview;
    if(drag && Number.isInteger(drag.step)) {
        const spec=controls.sliders[drag.source], keys={cameraCardX:'x',cameraCardY:'y',cameraCardScale:'size',cameraCardBrightness:'brightness',cameraCardTransparency:'opacity'};
        const key=keys[drag.source];
        if(spec && key && drag.step>=0 && drag.step<=spec[0]) {
            const value=spec[1]+drag.step*spec[2];
            p[key]=key==='x'||key==='y'?value*10:key==='opacity'?100-value:value;
        }
    }
    return p;
}
function profileDrawing(cv,profile,x,y,w,h) {
    cv.roundRect(x,y,w,h,9,P.line);cv.roundRect(x+2,y+2,w-4,h-4,8,P.bg);
    if(![profile.x,profile.y,profile.size,profile.brightness,profile.opacity].every(Number.isFinite)){
        words(cv,'Профиль экрана недоступен',x+w/2,y+h*.58,23,w-28,P.dim,false,'center');return;
    }
    const canvas=profile.canvas, known=canvas&&Number.isFinite(canvas.width)&&canvas.width>0&&Number.isFinite(canvas.height)&&canvas.height>0;
    const width=known?canvas.width:1000,height=known?canvas.height:260;
    const margin=Math.max(8,Math.min(20,Math.round(Math.min(width,height)*.035)));
    const factor=Math.min(profile.size/100,(width-2*margin)/320,(height-2*margin)/96);
    if(factor<.75){words(cv,'Выход меньше минимального размера',x+w/2,y+h*.58,22,w-24,P.dim,false,'center');return;}
    const sx=Number.isFinite(cv.scaleX)&&cv.scaleX>0?cv.scaleX:1;
    const px=Math.min((w-12)*sx/width,(h-12)/height), dw=width*px/sx,dh=height*px;
    const left=x+(w-dw)/2, top=y+(h-dh)/2;
    cv.roundRect(left,top,dw,dh,3,'#182b2b');
    const cardW=320*factor,cardH=96*factor, point=(val,length,card)=>margin+(length-2*margin-card)*val/1000;
    const cardX=left+px*point(profile.x,width,cardW)/sx,cardY=top+px*point(profile.y,height,cardH);
    const paintedW=cardW*px/sx,paintedH=cardH*px;
    const bright=profile.brightness/100,alpha=profile.opacity/100;
    const tint=rgb=>'#'+rgb.map((n,i)=>Math.round([24,43,43][i]*(1-alpha)+n*bright*alpha))
        .map(n=>('0'+n.toString(16)).slice(-2)).join('');
    cv.roundRect(cardX,cardY,paintedW,paintedH,3,tint([198,244,165]));
    if(paintedH>=14){
        const ink=tint([40,65,56]),cx=cardX+paintedW*.18,cy=cardY+paintedH*.52;
        symbol(cv,'camera',cx,cy,ink,Math.min(paintedW*.22,paintedH*.68));
        cv.roundRect(cardX+paintedW*.36,cardY+paintedH*.35,paintedW*.47,Math.max(1,paintedH*.09),1,ink);
        cv.roundRect(cardX+paintedW*.36,cardY+paintedH*.58,paintedW*.30,Math.max(1,paintedH*.09),1,ink);
    }
}
function calibrationInfo(cv,v) {
    const c=v.calibration, left=46, width=548;
    cv.roundRect(24,89,592,360,13,P.surface);
    words(cv,'Схема положения',left,124,27,340,P.text,true);
    words(cv,v.side,593,123,22,225,P.focus,false,'right');
    profileDrawing(cv,calibrationPreview(v),left,137,width,113);
    const messages=[];
    if(!c.test.allowed)messages.push(['Тест',c.test.reason||'Сервис не разрешил тест']);
    if(!c.layout.allowed && c.layout.reason && c.layout.reason!==c.test.reason)messages.push(['Настройка',c.layout.reason]);
    if(v.feedback && v.feedback!==dash && !messages.some(m=>m[1]===v.feedback))messages.push(['',v.feedback]);
    if(c.storageText && !messages.some(m=>m[1]===c.storageText))messages.push(['',c.storageText]);
    let pos=280;
    const shown=messages.slice(0,4);
    shown.forEach((m,i)=>{
        const value=m[0]?m[0]+' · '+m[1]:m[1];
        const remaining=shown.length-i-1;
        const lines=Math.max(1,Math.min(2,1+Math.floor((430-pos-remaining*33)/24)));
        pos=paragraph(cv,value,left,pos,22,width,24,m[0]?P.gold:i===0?P.text:P.dim,lines)+9;
    });
    if(pos<385 && c.layout.allowed){
        words(cv,'Коснитесь шкалы или потяните ползунок',left,392,22,width,P.dim);
        words(cv,'Наклон iDrive влево или вправо меняет значение',left,422,22,width,P.dim);
    }
}
function compositionInfo(cv,v,focus,x,y,w,h) {
    cv.roundRect(x,y,w,h,14,P.surface);
    const option=v.calibration.composition.find(b=>b.command===focus)||v.calibration.composition[0];
    if(!option)return;
    const left=x+24,width=w-48;
    words(cv,option.label,left,y+53,35,width,P.text,true);
    words(cv,option.selected===null?'Состояние не подтверждено':option.selected?'На экране':'Скрыто',left,y+94,24,width,P.focus,true);
    paragraph(cv,option.description,left,y+145,27,width,35,P.text,4);
    if(v.calibration.compositionReason)paragraph(cv,v.calibration.compositionReason,left,y+h-41,21,width,24,P.gold,2);
}
function information(cv,v,x,y,w,h) {
    cv.roundRect(x,y,w,h,14,P.surface);
    const left=x+24, room=w-48;
    if(v.resultBlock){
        words(cv,'Результат команды',left,y+37,28,room,P.focus,true);
        v.resultBlock.forEach((t,i)=>words(cv,t,left,y+80+31*i,23,room,P.text));
        return;
    }
    if(v.report){
        words(cv,v.report.title,left,y+37,26,room,P.focus,true);
        const lines=v.report.lines.filter(t=>typeof t==='string'&&t.trim());
        lines.forEach((s,i)=>words(cv,s,left,y+69+i*26,22,room,P.text));
        if(v.report.more && v.report.more.trim())words(cv,v.report.more,left,y+h-12,17,room,P.dim);
        return;
    }
    const context=v.edit?v.edit.label:v.lead;
    if(v.lens)capture(cv,x+w-106,y+19,v.lens);
    else if(v.calibration)profileDrawing(cv,calibrationPreview(v),x+w-149,y+14,122,61);
    else symbol(cv,v.icon,x+w-47,y+41,P.focus,42);
    words(cv,context,left,y+42,34,room-(v.preview?136:90),P.text,true);
    words(cv,v.edit?'Текущее значение':v.side,left,y+76,21,room-(v.preview?136:90),P.dim);
    if(v.edit){
        const preview=v.sliderPreview;
        const value=preview&&preview.source===v.edit.name?controls.formatStep(v.edit.name,preview.step):v.edit.value;
        words(cv,value,left,y+159,59,room,P.focus,true);
        if(!v.buttons.some(b=>b.kind==='slider') && Number.isInteger(v.edit.step)&&Number.isFinite(v.edit.max)&&v.edit.max>0){
            const bar=room-4;
            cv.roundRect(left,y+190,bar,8,4,P.line);
            const width=bar*Math.max(0,Math.min(1,v.edit.step/v.edit.max));
            if(width>=1)cv.roundRect(left,y+190,width,8,Math.min(4,width/2),P.focus);
        }
        if(v.buttons.some(b=>b.kind==='slider')){
            const spec=controls.sliders[v.edit.name]||controls.scaleSliders[v.edit.name];
            words(cv,controls.formatStep(v.edit.name,0)+' — '+controls.formatStep(v.edit.name,spec[0])+' · шаг '+String(spec[2]).replace('.',',')+' %',left,y+280,22,room,P.dim);
        }
        if(v.feedback&&v.feedback!==dash)words(cv,v.feedback,left,y+h-23,21,room,P.dim);
        return;
    }
    cv.line(left,y+93,x+w-24,y+93,1,P.line);
    const rows=v.rows||[],lineH=Math.min(46,(h-103)/Math.max(rows.length,1));
    rows.forEach((r,i)=>row(cv,r[0],r[1],left,y+110+lineH*(i+.5),room,lineH<35));
}
function photo(cv,lines,x,y,w,h) {
    const half=(w-12)/2, cell=(h-18)/4;
    lines.slice(0,8).forEach((line,i)=>{
        const col=i<4?0:1, at=i%4, left=x+col*(half+12), top=y+at*(cell+6);
        cv.roundRect(left,top,half,cell,9,P.surface);
        const pair=splitRow(line);
        if(pair[0]){words(cv,pair[0],left+15,top+cell*.43,24,half-30,P.dim);words(cv,pair[1],left+15,top+cell*.85,26,half-30,P.text,true);}
        else words(cv,pair[1],left+15,top+cell*.64,25,half-30,P.text);
    });
}
// The logs service supplies this address only while its local archive is available.
function archiveQR(cv,url,x,y,size) {
    if(cv.square){
        const area=cv.square(x,y,size);
        return archiveQR(area.canvas,url,area.x,area.y,area.size);
    }
    const code=qr.QrCode.encodeText(url,qr.QrCode.Ecc.MEDIUM);
    const step=Math.floor(size/(code.size+8)),side=step*(code.size+8);
    cv.fillRect(x,y,side,side,'#ffffff');
    for(let row=0;row<code.size;row++){
        let start=-1;
        for(let col=0;col<=code.size;col++){
            const dark=col<code.size&&code.getModule(col,row);
            if(dark&&start<0)start=col;
            if(!dark&&start>=0){
                cv.fillRect(x+(4+start)*step,y+(4+row)*step,(col-start)*step,step,'#10201b');
                start=-1;
            }
        }
    }
}
function drawDetail(cv,page,v,focus) {
    if(!v)return;
    cv.fillRect(0,0,1600,520,P.bg);
    if(page==='cameraDetail'){
        if(v.cameraOutput){cameraScene.editorDraw(cv,v,focus);return;}
        words(cv,v.title,26,52,40,920,P.text,true);
        words(cv,v.ride.active?v.ride.text.tripCameraEvidence:v.ride.outputs,1563,50,22,630,P.dim,false,'right');
        cameraScene.hero(cv,v.ride,24,71,626,246);
        cameraScene.map(cv,v.ride,671,71,893,246);
        ['hud','map'].forEach((target,i)=>{
            cameraScene.preview(cv,v.ride,target,24+i*782,332,759,94);
        });
        v.buttons.forEach(b=>cameraScene.button(cv,b,focus));
        return;
    }
    if(v.diagnosticCards && v.sheet===0){
        words(cv,v.title,24,67,46,900,P.text,true);
        const photoPage=page==='diagnosticPhoto';
        words(cv,photoPage?v.side:'Обзор системы',1576,62,24,562,P.dim,false,'right');
        diagnosticCards.drawCards(cv,v.diagnosticCards,photoPage?104:171,425,P,words);
        v.buttons.forEach(b=>{
            if(b.kind!=='diagTab' && b.kind!=='diagPhoto'){tile(cv,b,focus);return;}
            const selected=b.selected===true, focused=b.command===focus;
            cv.roundRect(b.x,b.y,b.w,b.h,10,selected?P.focus:focused?P.tile:P.surface);
            if(focused)cv.roundRect(b.x+15,b.y+b.h-6,b.w-30,3,1,selected?P.ink:P.focus);
            words(cv,b.label,b.x+b.w/2,b.y+b.h/2+10,28,b.w-24,selected?P.ink:P.text,true,'center');
        });
        return;
    }
    cv.roundRect(24,15,65,59,12,P.tile);symbol(cv,v.icon,56,45,P.focus,39);
    words(cv,v.title,105,60,44,605,P.text,true);
    words(cv,v.edit?'Значение параметра':v.group,762,65,33,665,P.text,true);
    if(v.sheets>1&&!v.edit)words(cv,(v.sheet+1)+' / '+v.sheets,1564,63,26,120,P.dim,false,'right');
    cv.line(24,86,1564,86,1,P.line);
    if(page==='calibration' && v.sheet===0 && !v.edit)calibrationInfo(cv,v);
    else if(v.compositionSheet)compositionInfo(cv,v,focus,24,101,711,331);
    else if(v.photo)photo(cv,v.photo,24,105,1540,321);
    else{
        if(page==='main' && !v.edit)phoneMaps.draw(cv,v,words,P,false);
        else information(cv,v,24,101,711,331);
        if(page==='logs'&&v.archiveUrl){
            cv.roundRect(762,239,802,192,14,P.surface);
            archiveQR(cv,v.archiveUrl,780,250,170);
            words(cv,'Архивы по Wi-Fi',977,307,30,550,P.text,true);
            words(cv,v.archiveUrl,977,361,25,550,P.dim);
        }
        if(v.edit)words(cv,v.edit.label,762,112,21,770,P.dim);
        else if(v.feedback&&v.feedback!==dash)words(cv,v.feedback,762,112,20,800,P.dim);
    }
    (v.buttons||[]).forEach(b=>tile(cv,b,focus,v.sliderPreview));
}
function drawSummary(cv,page,v) {
    cv.fillRect(0,0,1600,240,P.bg);
    if(!v)return;
    const title=v.edit?v.edit.label:v.title;
    words(cv,title,26,41,34,680,P.text,true);
    const overview=v.diagnosticCards && v.sheet===0;
    const activeTab=overview && v.report && v.report.tabs.find(tab=>tab.selected);
    words(cv,activeTab?activeTab.label:v.edit?v.edit.value:v.report?v.report.title:v.side,1572,39,27,827,P.focus,true,'right');
    cv.line(26,54,1572,54,1,P.line);
    if(v.cameraOutput){
        const button=v.buttons.find(b=>b.kind==='slider'),target=v.cameraOutput;
        words(cv,'Размер',26,99,24,220,P.dim);
        words(cv,button.value,26,164,45,310,P.focus,true);
        words(cv,target==='center'?v.ride.text.tripCameraStatus:cameraScene.profileText(v.ride,target),380,148,27,1177,P.text);
        if(v.feedback)words(cv,v.feedback,26,219,22,1531,P.gold);
        return;
    }
    if(v.resultBlock){
        v.resultBlock.forEach((t,i)=>words(cv,t,26+(i<4?0:780),89+(i%4)*40,24,750,P.text));
        return;
    }
    if(page==='main' && !v.edit){phoneMaps.draw(cv,v,words,P,true);return;}
    if(v.calibration&&!v.edit){
        if(v.compositionSheet){
            v.calibration.composition.forEach((b,i)=>{
                const x=i<3?26:810, y=83+i%3*51;
                words(cv,b.label,x,y,23,730,P.focus,true);
                words(cv,b.description,x,y+22,20,730,P.text);
            });
            if(v.calibration.compositionReason)words(cv,v.calibration.compositionReason,26,235,19,1540,P.gold);
        } else {
            v.rows.forEach((r,i)=>row(cv,r[0],r[1],26,81+i*34,637,true));
            const c=v.calibration;
            paragraph(cv,c.test.allowed?v.feedback||v.side:c.test.reason,710,100,28,840,33,c.test.allowed?P.text:P.gold,2);
            paragraph(cv,c.storageText,710,174,25,840,29,P.dim,2);
        }
        return;
    }
    if(v.archiveUrl){
        archiveQR(cv,v.archiveUrl,1380,66,158);
        const rows=v.rows||[];
        rows.forEach((r,i)=>row(cv,r[0],r[1],26+(i<4?0:666),94+(i%4)*42,620,true));
        return;
    }
    if(overview){
        v.diagnosticCards.forEach((r,i)=>row(cv,r[0],r[1],26+(i%2)*780,93+Math.floor(i/2)*55,750,true));
        return;
    }
    if(v.photo){
        v.photo.forEach((line,i)=>words(cv,line,26+(i%2)*780,87+Math.floor(i/2)*41,26,749,P.text));
        return;
    }
    if(v.report){
        v.report.lines.forEach((line,i)=>{if(line.trim())words(cv,line,26+(i<5?0:780),84+(i%5)*33,22,754,P.text);});
        return;
    }
    if(v.edit){
        words(cv,v.edit.value,28,157,66,610,P.focus,true);
        if(v.feedback&&v.feedback!==dash)words(cv,v.feedback,700,150,27,850,P.text);
        return;
    }
    const rows=v.rows||[];
    const perCol=Math.max(1,Math.ceil(rows.length/2)), spacing=Math.min(48,170/perCol);
    rows.forEach((r,i)=>row(cv,r[0],r[1],26+(i<perCol?0:780),77+(i%perCol+.42)*spacing,746,false));
    if(!rows.length)words(cv,v.lead,28,144,54,1500,P.focus,true);
}
module.exports={names,pageIds,model,drawDetail,drawSummary,confirmedDirection,reducePanel:controls.reducePanel,
    sliderCommand:controls.sliderCommand,sliderNudge:controls.sliderNudge};
