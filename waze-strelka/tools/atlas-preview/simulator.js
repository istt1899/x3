const home=load('app/atlas-home'), detail=load('app/atlas-detail'), stage=load('app/atlas-stage');
const trip=load('app/trip_view'), diag=load('app/diagnostics_view'), camera=load('app/view_model');
const layout=load('output/card-layout'), layers=load('output/camera-layers'), card=load('output/alert-card');
const policy=load('output/action-policy'), Raster=load('kit/canvas').Canvas;
const el=id=>document.getElementById(id), clone=value=>JSON.parse(JSON.stringify(value));
const key='bmw-atlas-stand.preferences.v1', emptyPanel=()=>({sheet:0,edit:null});
const props={cameraVisualFlash:'visualFlash',cameraSoundEnabled:'soundEnabled',cameraSoundAppear:'soundOnCameraAppear'};
const allTypes=()=>Object.fromEntries(camera.ALERT_TYPES.map(t=>[t.key,true]));
const defaults=()=>({enabled:true,outputs:{hud:true,cluster:true},cardLayout:layout.defaultLayouts(),
    alertPreferences:{warningDistanceM:1000,cameraTypes:allTypes()},overspeedPreferences:{...camera.OVERSPEED_RECOMMENDED},
    phone:{wocProfile:false,wocGuide:false,wocHudKeep:false,wocAaCard:false,wocShowOn:2,wocHudSize:5,wocHudOpacity:0,zoom:0,x:0,y:0},
    packs:{'RU-KLU':{current:'Учебная 1',previous:null}},opticsStyle:'beam'});
let saved=defaults(), storageAvailable=true;
try {
    const persisted=JSON.parse(localStorage.getItem(key)||'null');
    if(persisted&&persisted.schema===1&&persisted.values) {
        const p=persisted.values;
        if(camera.alertPreferences({capabilities:{alertPreferences:true},alertPreferences:p.alertPreferences}).available) saved.alertPreferences=p.alertPreferences;
        if(camera.overspeedPreferences({capabilities:{overspeedPreferences:true},overspeedPreferences:p.overspeedPreferences}).available) saved.overspeedPreferences=p.overspeedPreferences;
        if(typeof p.enabled==='boolean')saved.enabled=p.enabled;
        for (const t of ['hud','cluster']) if(typeof p.outputs?.[t]==='boolean')saved.outputs[t]=p.outputs[t];
        saved.cardLayout=layout.normalizeLayouts(p.cardLayout);
        if(['beam','pulse','trail'].includes(p.opticsStyle))saved.opticsStyle=p.opticsStyle;
        if(p.phone&&typeof p.phone==='object')Object.assign(saved.phone,p.phone);
        if(p.packs&&typeof p.packs==='object')saved.packs=p.packs;
    }
} catch {storageAvailable=false;}
function persist() {
    try {localStorage.setItem(key,JSON.stringify({schema:1,values:saved}));} catch {storageAvailable=false;}
}
let page='trip', history=[], panel=emptyPanel(), target='hud', selected='', region='RU-KLU', regionPage=null;
let diagnosticPage=0, diagnosticBlock=0, resultBlock=0, snapshot=null, test=null, timer=null, capture=false, activeOutput=null;
let message='', lastState, view, buttons=[], lastBitmap='', logEntries=[], datasetStatus='idle', updateAvailable=true;
let cropped=false;
const outputCards={hud:null,map:null};
const inputStage=new stage.Stage(()=>{},command=>activate(command),()=>{});
inputStage.gpu={ready:true,native:true,touch:true,info:{touch:true,controller:true,frontGate:true},
    screen:{w:1920,h:720},grabbing:true,visible:true};
inputStage.front=true;
inputStage.present=()=>{selected=inputStage.focus[page];drawStage();};
let rotary=0;
function syncInput(){
    inputStage.page=page;inputStage.view=view;inputStage.focus[page]=selected;
}
function ccu(push) {
    inputStage.controller({frontRotaryEncoderOperation:rotary,frontRotaryEncoderPushButton:push,frontRotaryEncoderDeflection:0});
}
const screenRaster=new Raster(stage.width,stage.height), px=node=>node.getContext('2d');
const cardCanvas=document.createElement('canvas');cardCanvas.width=card.width;cardCanvas.height=card.height;
const nav={...trip.COMMANDS,tripDiagnostics:'diagnostics',tripCameraDiagnostics:'diagnostics',cameraDiagnostics:'diagnostics',
    cameraAlertsLink:'alerts',cameraTypesLink:'types',cameraDatabaseLink:'database',cameraOverspeedLink:'overspeed',
    cameraCardPosition:'position',wocLogs:'logs',wocCameras:'cameras',atlasMenuCamera:'cameraDetail',atlasMenuMaps:'main'};
const zone=config.zone, way=zone.roads.find(r=>r.cam>0);
const east=111320*Math.cos(zone.lat*Math.PI/180);
const coordinate=([x,y])=>[zone.lat+y/111320,zone.lon+x/east];
const roads=zone.roads.filter(r=>r.pts.length>1).map(r=>({current:r.id===way.id,points:r.pts.map(coordinate)}));
function nearbyRoads(fix){
    const dx=lon=>(lon-fix.lon)*east,dy=lat=>(lat-fix.lat)*111320;
    return roads.map(road=>{
        let nearest=Infinity;
        for(let i=1;i<road.points.length;i++){
            const a=road.points[i-1],b=road.points[i],x=dx(a[1]),y=dy(a[0]),vx=dx(b[1])-x,vy=dy(b[0])-y;
            const t=Math.max(0,Math.min(1,-(x*vx+y*vy)/(vx*vx+vy*vy||1)));
            nearest=Math.min(nearest,(x+t*vx)**2+(y+t*vy)**2);
        }
        return {road,nearest};
    }).sort((a,b)=>Number(b.road.current)-Number(a.road.current)||a.nearest-b.nearest).slice(0,36).map(r=>r.road);
}
function roadPosition(distance,parallel) {
    const points=way.pts;
    let remain=distance;
    for(let i=way.cam;i>0;i--) {
        const [x,y]=points[i],dx=points[i-1][0]-x,dy=points[i-1][1]-y,len=Math.hypot(dx,dy);
        if(len && (remain<=len||i===1)){
            const [lat,lon]=coordinate([x+dx*Math.min(1,remain/len),y+dy*Math.min(1,remain/len)+(parallel?130:0)]);
            return {lat,lon,headingDeg:(Math.atan2(-dx,-dy)*180/Math.PI+360)%360};
        }
        remain-=len;
    }
    return {lat:zone.lat,lon:zone.lon,headingDeg:0};
}
const notes={known:'Одна демонстрационная запись указывает 40 км/ч.',newer:'У одной камеры две записи. Значение 60 датировано 1 ноября, 40 — 15 ноября 2026 года.',conflict:'У записи 60 нет даты изменения. Второй источник указывает 40 км/ч.',unknown:'Для этого подхода нет числовой записи.'};
function makeWarning(distance,speed,held) {
    const selection=el('limit').value,side=el('lens').value;
    const records=selection==='unknown'?[]:[{valueKmh:40,sourceDate:'2026-11-15'}];
    if(selection==='newer'||selection==='conflict')records.push({valueKmh:60,sourceDate:selection==='newer'?'2026-11-01':null});
    const alert={id:'Учебная камера',type:'speed',controls:['speed','lane'],roadConfirmed:true,way:way.id,sign:1,
        distanceM:distance,displayDistanceM:distance,speedKmh:speed,gpsHeld:held,limitReference:{source:'Учебная база',records},
        roadName:'Демонстрационный проезд',captureDirection:side,captureDirectionVerified:side!=='unknown',
        captureClass:side,speedWarning:{flashActive:false}};
    alert.displayLimit=load('output/display-limit').select(alert);
    return alert;
}
function catalog() {
    return config.regions.map(item=>{
        const pack=saved.packs[item.region];
        return {...item,currentVersion:pack?.current||null,canRollback:!!pack?.previous,
            status:pack?.current===item.availableVersion?'installed':'available'};
    });
}
function stateNow() {
    const phase=el('phase').value,distance=Number(el('distance').value),now=Date.now();
    const speed=phase==='stop'?0:phase==='gps'?null:47, held=phase==='gps';
    const canWarn=['approach','stop','gps'].includes(phase)&&saved.enabled&&distance<=saved.alertPreferences.warningDistanceM&&
        (saved.alertPreferences.cameraTypes.speed||saved.alertPreferences.cameraTypes.lane);
    const fix=roadPosition(distance,phase==='parallel');
    const state={...saved,serviceVersion:config.version,observedAtMs:now,appClock:{wallMs:now,wallUtc:new Date(now).toISOString()},
        capabilities:{alertPreferences:true,overspeedPreferences:true,outputs:true,displayTest:true,update:true,hudOpacity:true},
        audio:{available:false,reason:'Учебный стенд • звуковой канал BMW не подключён'},
        gpsFix:held?null:{...fix,speedKmh:speed,timeMs:now,source:'simulator'},vehicleMotion:{code:held?'UNAVAILABLE':'READY',speedKmh:speed},
        gpsMotion:{state:held?'unknown':speed===0?'stopped':'moving',speedKmh:speed},
        atlasMap:{origin:held?null:fix,camera:{lat:zone.lat,lon:zone.lon},roads:nearbyRoads(fix),region:'Калуга · учебный маршрут'},
        street:{state:'ready',name:'Калуга · учебный маршрут'},alert:canWarn?makeWarning(distance,speed,held):null,
        guidance:{lastClear:phase==='passed'?{reason:'CAMERA_PASSED',timeMs:now}:{}},
        database:{source:'Учебная база',updated:'2026-11-15',count:1},databaseUpdate:{canRollback:!updateAvailable},
        regionalDatabase:{phase:datasetStatus,regions:catalog(),selectedRegion:region},
        storage:{persistent:storageAvailable,settingsSaved:storageAvailable},rendererDetails:{connection:'ready'},
        displayTest:test?{active:true,target:test,pinned:true}:{active:false}};
    state.actions=policy.policies(state,state.gpsFix,now,null,speed);
    return state;
}
const compare={cameraWarningDistance:s=>(s.alertPreferences.warningDistanceM-50)/50,
    cameraVisualOffset:s=>s.overspeedPreferences.visualOffsetKmh,cameraSoundOffset:s=>s.overspeedPreferences.soundOffsetKmh,
    cameraSoundDistance:s=>(s.overspeedPreferences.soundDistanceM-100)/50,cameraSoundRepeat:s=>[0,3,5,10].indexOf(s.overspeedPreferences.soundRepeatSec),
    cameraCardX:s=>s.cardLayout[target].x/5,cameraCardY:s=>s.cardLayout[target].y/5,
    cameraCardScale:s=>(s.cardLayout[target].scalePct-75)/5,cameraCardBrightness:s=>(s.cardLayout[target].brightnessPct-10)/5,
    cameraCardTransparency:s=>(100-s.cardLayout[target].opacityPct)/5,wocHudSize:s=>s.phone.wocHudSize,wocHudOpacity:s=>s.phone.wocHudOpacity};
function written(s,reg) {
    const t=s.cardLayout[target],d=s.actions,ok=d.cardLayout.allowed,ownTest=s.displayTest.active&&s.displayTest.target===target;
    const raw={...trip.model(s,config.version).text,...camera.model(s).text,...reg.text,
        wocHud:s.phone.wocShowOn===0?'HUD выключен':'HUD учебного профиля',wocMap:s.phone.wocShowOn===1?'Приборы выключены':'Приборы учебного профиля',
        wocStatus:'Телефон не подключён',wocAaStatus:'Телефон не подключён',wocCaptureStatus:capture?'Идёт локальная запись':'Запись остановлена',
        wocLogsStatus:logEntries.length+' событий в этом сеансе',wocLogsRow1:logEntries.at(-1)||'Нет записей',
        cameraCardStatus:ownTest?'Учебный тест включён':ok?'Учебный профиль':'Для теста выберите сценарий остановки',
        cameraCardStorage:storageAvailable?'Хранилище браузера':'Только этот сеанс',cameraPositionHint:ok?'Показать тест для перемещения':'Настройка доступна на стоянке',
        cameraCommand:message,cameraDatabaseCommand:message,cameraAlertCommand:message,tripRegionResult:message||'Локальный каталог • пример операции',
        'cell:cameraDiagSelector:SelectedItem':diagnosticPage,'cell:wocShowOn:SelectedItem':s.phone.wocShowOn};
    const report=diag.reportPage(null,s,config.version,diagnosticPage,diagnosticBlock,message||null,resultBlock);
    for(const [k,v] of Object.entries(report.rows))raw['cameraDiag_'+k]=v;
    for(const [control,read] of Object.entries(compare))raw['cell:'+control+':0:Value']=read(s);
    for(const [n,k] of Object.entries(props))raw['selected:'+n]=s.overspeedPreferences[k];
    for(const [n,v] of Object.entries(s.phone))raw['selected:'+n]=v===true;
    for(const item of camera.ALERT_TYPES)raw['selected:cameraType_'+item.key]=s.alertPreferences.cameraTypes[item.key];
    raw['selected:cameraCardOutput']=s.outputs[target==='hud'?'hud':'cluster'];raw['selected:cameraEnable']=s.enabled;
    Object.assign(raw,{'enabled:cameraTestStart':ownTest||ok,'enabled:cameraPositionTest':ownTest||ok,
        'enabled:cameraDiagTest':d.displayTest.allowed,'enabled:cameraDiagCalibration':d.calibrationTest.allowed,
        'enabled:cameraDiagAudio':d.audioTest.allowed,'enabled:cameraCardReset':ok,'enabled:cameraCardSave':true,
        'enabled:tripRegionDownload':ok&&reg.download,'enabled:tripRegionRollback':ok&&reg.rollback,
        'enabled:tripRegionRefresh':ok,'enabled:tripRegionPage':reg.pages>1,'enabled:cameraRollback':ok&&!updateAvailable,
        'enabled:cameraUpdate':ok,'enabled:cameraGpsReset':false});
    for(const name of ['cameraCardX','cameraCardY','cameraCardScale','cameraCardBrightness','cameraCardTransparency'])
        raw['enabled:'+name]=ok;
    for(const name of ['cameraCardUp','cameraCardDown','cameraCardLeft','cameraCardRight'])raw['enabled:'+name]=ok&&ownTest;
    Object.assign(raw,{cameraCardPosition:'X '+t.x/10+' % · Y '+t.y/10+' %',
        cameraTestStart:ownTest?'Скрыть тест':'Показать тест',cameraPositionTest:ownTest?'Скрыть тест':'Показать тест',
        wocHudPos:'X '+s.phone.x+' · Y '+s.phone.y,wocAaZoom:'Масштаб '+s.phone.zoom});
    return raw;
}
function say(value) {
    message=value;el('notice').textContent=value;
    if(capture)logEntries.push(new Date().toLocaleTimeString('ru')+' · '+value);
}
function go(next,replacing=false) {
    if(!replacing&&next!==page)history.push({page,panel:{...panel},selected,target});
    page=next;panel=emptyPanel();selected='';
}
function back() {
    if(panel.edit){panel={sheet:panel.sheet,edit:null};selected='';return;}
    const old=history.pop();
    if(old){page=old.page;panel=old.panel;selected=old.selected;target=old.target;}
    else {page='trip';panel=emptyPanel();selected='';}
}
function configure(out) {
    if(page!=='calibration')go('calibration');
    target=out;panel=emptyPanel();selected='';
    if(!lastState.actions.cardLayout.allowed)say('Для калибровки выберите «Остановка перед камерой» в сценарии поездки.');
}
function inspectOutput(out) {
    activeOutput=out;cropped=false;el('detail-title').textContent=out==='hud'?'Проекция HUD':'Приборная панель';
    el('detail-output').showModal();updateInspection();
}
function updateInspection(){
    if(!activeOutput||!el('detail-output').open)return;
    const original=el(activeOutput);
    let copy=el('detail-surface').querySelector('canvas');
    if(!copy){copy=document.createElement('canvas');el('detail-surface').append(copy);}
    const width=cropped?card.width:original.width,height=cropped?card.height:original.height;
    if(copy.width!==width||copy.height!==height){copy.width=width;copy.height=height;}
    const ctx=px(copy);ctx.clearRect(0,0,width,height);
    if(cropped){if(outputCards[activeOutput])bitmap(copy,outputCards[activeOutput],width,height);}
    else ctx.drawImage(original,0,0);
    el('detail-surface').className=activeOutput+(cropped?' crop':'');
    el('detail-note').textContent=cropped?'Карточка · '+card.width+' × '+card.height+' · '+el(activeOutput+'-state').textContent.split(' · ')[0]:el(activeOutput+'-state').textContent;
    for(const n of document.querySelectorAll('[data-crop]'))n.setAttribute('aria-pressed',String((n.dataset.crop==='card')===cropped));
    for(const n of document.querySelectorAll('[data-side]'))n.setAttribute('aria-pressed',String(n.dataset.side===el('lens').value));
}
function bitmap(canvas,bytes,width,height){
    px(canvas).putImageData(new ImageData(new Uint8ClampedArray(bytes.buffer,bytes.byteOffset,bytes.byteLength),width,height),0,0);
}
let animationTime=0;
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
el('optics').value=saved.opticsStyle;
function renderOutputs(s) {
    for(const out of ['hud','map']) {
        const node=el(out),ctx=px(node),profile=s.cardLayout[out],enabled=s.outputs[out==='hud'?'hud':'cluster'];
        const activeTest=test===out&&s.actions.cardLayout.allowed;
        const visibleAlert=activeTest?{...makeWarning(150,0,false),test:true,calibration:true}:s.alert;
        const info=layers.layoutFor(out,{width:node.width,height:node.height},'simulator',profile);
        ctx.clearRect(0,0,node.width,node.height);
        const show=enabled&&visibleAlert&&info.withinBounds;
        outputCards[out]=null;
        if(show){
            const frame=reducedMotion.matches||!['approach','stop'].includes(el('phase').value)?0:(animationTime%1500)/500;
            const optical={...visibleAlert,opticsStyle:saved.opticsStyle,opticsFrame:frame};
            outputCards[out]=layers.styledPixels(optical,out,profile);
            bitmap(cardCanvas,outputCards[out],card.width,card.height);
            const r=info.card;ctx.drawImage(cardCanvas,r.x,r.y,r.width,r.height);
        }
        const legend=!enabled?'Вывод выключен':!info.withinBounds?'Недостаточно места':!visibleAlert?'Нет предупреждения':
            activeTest?'Стояночный тест':visibleAlert.gpsHeld?'Нет свежего GPS':'Предупреждение';
        const content=show?card.presentation(visibleAlert):null;
        node.setAttribute('aria-label',legend+(content?' · '+(content.distance??'—')+' м · лимит '+(content.limit??'—')+' км/ч':''));
        el(out+'-state').textContent=legend+' · '+node.width+' × '+node.height;
    }
    updateInspection();
}
function focusId(item){return item&&(item.focusKey||item.command);}
function updateHits(oldFocus) {
    const area=el('hits'),existing=new Map(Array.from(area.children,n=>[n.dataset.focus,n]));
    for(const b of buttons){
        const id=focusId(b);let button=existing.get(id);
        if(!button){button=document.createElement('button');button.className='hit';button.type='button';button.dataset.focus=id;
            button.addEventListener('click',event=>{if(event.detail===0)activate(button.dataset.command);});
            button.addEventListener('focus',()=>{if(selected!==button.dataset.focus){selected=button.dataset.focus;drawStage();}});
        }
        existing.delete(id);
        button.dataset.command=b.command;button.setAttribute('aria-label',b.label||b.command);
        button.disabled=b.enabled===false;button.setAttribute('aria-disabled',String(button.disabled));
        Object.assign(button.style,{left:(100*b.x/stage.width)+'%',top:(100*b.y/stage.height)+'%',
            width:(100*b.w/stage.width)+'%',height:(100*b.h/stage.height)+'%'});
        if(!button.parentNode)area.append(button);
    }
    existing.forEach(node=>node.remove());
    if(oldFocus&&(!document.activeElement?.isConnected||document.activeElement===document.body)){
        Array.from(area.children).find(n=>n.dataset.focus===selected)?.focus({preventScroll:true});
    }
}
function drawStage(){
    const current=buttons.find(b=>focusId(b)===selected);
    const sceneFocus=focusId(current)||'';
    const key=JSON.stringify([page,view,sceneFocus]);
    if(key===lastBitmap)return;
    stage.scene(screenRaster,page,view,sceneFocus,true);
    bitmap(el('central'),screenRaster.d,stage.width,stage.height);lastBitmap=key;
}
function render() {
    const domFocus=el('hits').contains(document.activeElement);
    const s=stateNow(),reg=trip.regionsModel(s,region,regionPage),writes=written(s,reg);
    lastState=s;view=page==='trip'?home.model(s,config.version):detail.model(page,{state:s,written:writes,
        version:config.version,atlasPanel:panel,region:reg,target,snapshot,serviceReady:true,diagnosticState:s});
    if(!view)throw Error('Отсутствует экран '+page);
    buttons=stage.targets(page,view);
    if(!buttons.some(b=>focusId(b)===selected&&b.enabled!==false))selected=focusId(buttons.find(b=>b.enabled!==false))||'';
    drawStage();updateHits(domFocus);renderOutputs(s);
    el('screen').dataset.page=page;el('screen').dataset.sheet=String(panel.sheet);el('screen').dataset.edit=panel.edit||'';
    el('path').textContent=view.title||'Поездка';el('central').setAttribute('aria-label',page==='trip'?view.text.tripReading:view.title+' · '+(view.lead||''));
    el('metres').textContent=el('phase').value==='gps'?'—':el('distance').value+' м';
    el('limit-note').textContent=notes[el('limit').value];
    const phase=el('phase').value;
    el('distance').disabled=['stop','gps','passed','idle','parallel'].includes(phase);
    el('back').disabled=!history.length&&!panel.edit;el('vehicle-menu').hidden=page!=='trip';
    // Exposed DOM state is also useful to assistive technologies and offline verification.
    document.documentElement.dataset.ready='true';
}
function changeValue(control,step) {
    if(!Number.isInteger(step))return;
    const profile=saved.cardLayout[target],o=saved.overspeedPreferences, minmax=(v,a,b)=>Math.min(b,Math.max(a,v));
    if(control.startsWith('cameraCard')&&!lastState.actions.cardLayout.allowed)return;
    if(control==='cameraWarningDistance')saved.alertPreferences.warningDistanceM=50+50*minmax(step,0,19);
    else if(control==='cameraVisualOffset')o.visualOffsetKmh=minmax(step,0,30);
    else if(control==='cameraSoundOffset')o.soundOffsetKmh=minmax(step,0,30);
    else if(control==='cameraSoundDistance')o.soundDistanceM=100+minmax(step,0,12)*50;
    else if(control==='cameraSoundRepeat')o.soundRepeatSec=[0,3,5,10][minmax(step,0,3)];
    else if(control==='cameraCardX')profile.x=minmax(step*5,0,1000);
    else if(control==='cameraCardY')profile.y=minmax(step*5,0,1000);
    else if(control==='cameraCardScale')profile.scalePct=75+minmax(step,0,15)*5;
    else if(control==='cameraCardBrightness')profile.brightnessPct=10+minmax(step,0,18)*5;
    else if(control==='cameraCardTransparency')profile.opacityPct=100-minmax(step,0,18)*5;
    else if(control==='wocHudOpacity'||control==='wocHudSize')saved.phone[control]=step;
    else throw Error('Неизвестный регулятор '+control);
    persist();
}
function download(name,obj) {
    const content=typeof obj==='string'?obj:JSON.stringify(obj,null,2);
    const url=URL.createObjectURL(new Blob([content],{type:typeof obj==='string'?'text/plain;charset=utf-8':'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
function execute(command){
    const sourceButton=buttons.find(b=>b.command===command);
    if(!sourceButton||sourceButton.enabled===false)return;
    selected=focusId(sourceButton);
    const updated=page==='trip'?null:detail.reducePanel(panel,command,view);
    if(updated){panel=updated;selected='';return;}
    if(command==='atlasBack'){back();return;}
    if(command.startsWith('atlasValue:')){const [,name,step]=command.split(':');changeValue(name,Number(step));return;}
    if(command.startsWith('atlasChoice:')){const [,name,idx]=command.split(':');saved.phone[name]=Number(idx);persist();return;}
    if(command.startsWith('atlasDiagnostic:')){diagnosticPage=Number(command.split(':')[1]);diagnosticBlock=0;return;}
    if(command.startsWith('atlasRegion:')){region=command.slice(12);regionPage=null;datasetStatus='idle';return;}
    if(command.startsWith('cameraType_')){const key=command.slice('cameraType_'.length);saved.alertPreferences.cameraTypes[key]=!saved.alertPreferences.cameraTypes[key];persist();return;}
    if(nav[command]){go(nav[command]);return;}
    const s=lastState,o=saved.overspeedPreferences,p=saved.cardLayout[target];
    if(Object.hasOwn(props,command)){o[props[command]]=!o[props[command]];persist();return;}
    if(['wocProfile','wocGuide','wocHudKeep','wocAaCard'].includes(command)){
        saved.phone[command]=!saved.phone[command];say('Изменён учебный профиль телефона.');persist();return;}
    if(['wocAaZoomIn','wocAaZoomOut'].includes(command)){
        saved.phone.zoom=Math.min(10,Math.max(-10,saved.phone.zoom+(command.endsWith('In')?1:-1)));say('Масштаб учебной карты: '+saved.phone.zoom);persist();return;}
    if(['wocHudLeft','wocHudRight','wocHudUp','wocHudDown','wocHudCentre'].includes(command)){
        if(command.endsWith('Centre'))saved.phone.x=saved.phone.y=0;
        else if(command.endsWith('Left')||command.endsWith('Right'))saved.phone.x+=command.endsWith('Right')?1:-1;
        else saved.phone.y+=command.endsWith('Down')?1:-1;
        say('Положение учебной карты: '+saved.phone.x+' / '+saved.phone.y);persist();return;}
    switch(command) {
    case 'cameraHudSetup':configure('hud');break;
    case 'cameraMapSetup':configure('map');break;
    case 'cameraEnable':saved.enabled=!saved.enabled;break;
    case 'cameraDistanceRecommended':saved.alertPreferences.warningDistanceM=1000;break;
    case 'cameraOverspeedRecommended':saved.overspeedPreferences={...camera.OVERSPEED_RECOMMENDED};break;
    case 'cameraTypesAll':saved.alertPreferences.cameraTypes=allTypes();break;
    case 'cameraCardOutput': {
        const id=target==='hud'?'hud':'cluster';saved.outputs[id]=!saved.outputs[id];
        if(!saved.outputs[id]&&test===target)test=null;
        break;
    }
    case 'cameraTestStart':case 'cameraPositionTest':case 'cameraDiagTest':case 'cameraDiagCalibration':
        if(!s.actions.cardLayout.allowed){say(s.actions.cardLayout.reason);break;}
        if(command.startsWith('cameraDiag')){target=saved.outputs.hud?'hud':'map';go('calibration');}
        if(!saved.outputs[target==='hud'?'hud':'cluster']){say('Включите вывод на выбранный экран.');break;}
        test=test===target&&!command.startsWith('cameraDiag')?null:target;say(test?'Стояночный тест показан в симуляторе.':'Тест завершён.');break;
    case 'cameraCardSave':test=null;go('cameras',true);history=history.filter(h=>!['calibration','position','cameras'].includes(h.page));
        say(storageAvailable?'Профиль сохранён в этом браузере.':'Профиль действует до закрытия страницы.');break;
    case 'cameraCardReset':saved.cardLayout[target]=layout.defaultLayouts()[target];say('Восстановлен исходный профиль выбранного экрана.');break;
    case 'cameraCardLeft':case 'cameraCardRight':case 'cameraCardUp':case 'cameraCardDown': {
        if(!s.actions.cardMove.allowed||test!==target){say('Сначала покажите тест выбранного экрана на стоянке.');break;}
        const axis=command.endsWith('Right')||command.endsWith('Left')?'x':'y';
        const delta=command.endsWith('Down')||command.endsWith('Right')?5:-5;p[axis]=Math.min(1000,Math.max(0,p[axis]+delta));break;
    }
    case 'cameraDiagFreeze':snapshot=diag.capture(s,config.version,Date.now());go('diagnosticPhoto');break;
    case 'cameraDiagMore':{const data=diag.reportPage(null,s,config.version,diagnosticPage,diagnosticBlock);
        diagnosticBlock=(diagnosticBlock+1)%data.blocks;if(data.blocks===1)say('Все строки этой страницы уже показаны.');break;}
    case 'cameraDiagExport':download('atlas-simulator-diagnostics.json',{environment:'browser-simulation',snapshot:diag.capture(s,config.version,Date.now())});
        say('Локальный отчёт симулятора передан браузеру для сохранения.');break;
    case 'cameraDiagAudio':say('Учебная проверка звука: канал BMW недоступен в браузере.');break;
    case 'cameraCoverageDetails':diagnosticPage=5;diagnosticBlock=0;go('diagnostics');break;
    case 'cameraDiagResultMore':case 'cameraResultMore':case 'cameraAlertsResultMore':case 'cameraDatabaseResultMore':case 'cameraOverspeedResultMore':
        {const c=diag.commandPage(s,message||null,resultBlock);resultBlock=(resultBlock+1)%Math.max(1,c.blocks||1);say(message||'Команд пока нет.');break;}
    case 'tripRegionPage':{const reg=trip.regionsModel(s,region,regionPage);regionPage=(reg.index+1)%reg.pages;break;}
    case 'tripRegionRefresh':datasetStatus='listed';say('Учебный каталог перечитан из HTML.');break;
    case 'tripRegionDownload':{
        const pack=catalog().find(item=>item.region===region);if(!pack)break;
        saved.packs[region]={current:pack.availableVersion,previous:pack.currentVersion||null,installedHere:true};
        datasetStatus='updated';say('В учебной базе выбран пакет '+trip.regionName(pack)+' '+pack.availableVersion+'.');break;}
    case 'tripRegionRollback':{
        const pack=saved.packs[region];if(pack?.previous){saved.packs[region]={current:pack.previous,previous:null};datasetStatus='rolled-back';say('Учебный пакет возвращён к прежней версии.');}break;}
    case 'cameraUpdate':updateAvailable=false;say('Проверена локальная учебная база. Сервер автомобиля не подключён.');break;
    case 'cameraRollback':updateAvailable=true;say('Восстановлено исходное состояние учебной базы.');break;
    case 'wocCapture':capture=!capture;say(capture?'Начата запись действий в браузере.':'Запись действий остановлена.');break;
    case 'wocLogsSave':download('atlas-simulator.log',['BMW Atlas • browser simulation',...logEntries].join('\n'));say('Учебный журнал передан браузеру для сохранения.');break;
    default:say('Действие требует подключения к оборудованию BMW.');break;
    }
    persist();
}
function activate(command){execute(command);render();}
function rotate(amount) {
    syncInput();ccu(0);rotary=(rotary+amount+65536)%65536;ccu(0);
    if(el('headunit').classList.contains('zoomed')){
        const node=Array.from(el('hits').children).find(n=>n.dataset.focus===selected);
        node?.scrollIntoView({block:'nearest',inline:'nearest'});
    }
}
function confirm(){syncInput();ccu(0);ccu(1);ccu(0);}
function pointEvent(event,phase){
    const rect=el('screen').getBoundingClientRect();
    syncInput();
    inputStage.touch(phase,(event.clientX-rect.left)/rect.width*stage.width,(event.clientY-rect.top)/rect.height*stage.height);
}
el('hits').addEventListener('pointerdown',e=>{if(e.isPrimary&&e.button===0)pointEvent(e,1);});
el('hits').addEventListener('pointermove',e=>{if(e.isPrimary&&e.buttons===1)pointEvent(e,2);});
el('hits').addEventListener('pointerup',e=>{if(e.isPrimary&&e.button===0)pointEvent(e,3);});
el('hits').addEventListener('pointercancel',()=>{inputStage.pressed=null;});
function keyboard(event){
    if(el('detail-output').open||event.altKey||event.ctrlKey||event.metaKey||['SELECT','INPUT','SUMMARY'].includes(event.target.tagName))return;
    if(event.key==='Escape'){event.preventDefault();if(el('headunit').classList.contains('zoomed'))toggleZoom();else{back();render();}return;}
    if(['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'].includes(event.key)){event.preventDefault();rotate(['ArrowUp','ArrowLeft'].includes(event.key)?-1:1);return;}
    if(event.key==='Enter'&&(event.target===document.body||el('hits').contains(event.target)||event.target===el('screen'))){event.preventDefault();confirm();}
}
function toggleZoom(){
    const expanded=el('headunit').classList.toggle('zoomed');el('zoom').setAttribute('aria-pressed',String(expanded));
    el('zoom').textContent=expanded?'Свернуть':'Увеличить';el('scrollscreen').scrollLeft=0;
}
function stopPlay(){clearInterval(timer);timer=null;el('play').textContent='▶  Проехать';}
function changedScene(){
    stopPlay();const phase=el('phase').value;
    if(phase==='passed')el('distance').value='0';
    if(phase!=='stop'&&test){test=null;say('Стояночный тест завершён при смене движения.');}
    render();
}
el('play').onclick=()=>{
    if(timer){stopPlay();return;}
    test=null;el('phase').value='approach';el('distance').value='480';el('play').textContent='Ⅱ  Пауза';render();
    timer=setInterval(()=>{
        const distance=Math.max(0,Number(el('distance').value)-12);el('distance').value=String(distance);
        if(!distance){stopPlay();el('phase').value='passed';say('Камера пройдена. Предупреждение завершено.');}render();
    },320);
};
for(const name of ['phase','lens','limit'])el(name).addEventListener('change',changedScene);
function setOptics(style){
    saved.opticsStyle=style;el('optics').value=style;
    for(const n of document.querySelectorAll('[data-style]'))n.setAttribute('aria-pressed',String(n.dataset.style===style));
    persist();if(lastState)renderOutputs(lastState);
}
for(const n of document.querySelectorAll('[data-style]'))n.onclick=()=>setOptics(n.dataset.style);
setOptics(saved.opticsStyle);el('optics').onchange=()=>setOptics(el('optics').value);
let lastAnimation=0;
function animate(now) {
    if(!document.hidden&&!reducedMotion.matches&&lastState&&(lastState.alert||test)&&['approach','stop'].includes(el('phase').value)&&now-lastAnimation>=83){
        lastAnimation=animationTime=now;renderOutputs(lastState);
    }
    requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
reducedMotion.addEventListener('change',()=>{if(lastState)renderOutputs(lastState);});
el('distance').addEventListener('input',()=>{stopPlay();render();});
el('prev').onclick=()=>rotate(-1);el('next').onclick=()=>rotate(1);el('ok').onclick=confirm;
el('vehicle-menu').onclick=()=>{go('atlasMenu');render();};
el('back').onclick=()=>{back();render();};el('zoom').onclick=toggleZoom;
el('screen').addEventListener('wheel',event=>{
    if(event.ctrlKey||Math.abs(event.deltaX)>Math.abs(event.deltaY)||document.activeElement?.tagName==='INPUT')return;
    event.preventDefault();rotate(Math.sign(event.deltaY));
},{passive:false});
document.addEventListener('keydown',keyboard);
for(const n of document.querySelectorAll('[data-output]'))n.onclick=()=>{configure(n.dataset.output);render();el('headunit').scrollIntoView({block:'start'});};
for(const n of document.querySelectorAll('[data-inspect]'))n.onclick=()=>inspectOutput(n.dataset.inspect);
for(const n of document.querySelectorAll('[data-side]'))n.onclick=()=>{el('lens').value=n.dataset.side;render();};
for(const n of document.querySelectorAll('[data-crop]'))n.onclick=()=>{cropped=n.dataset.crop==='card';updateInspection();};
el('close-output').onclick=()=>el('detail-output').close();
el('detail-output').addEventListener('close',()=>{activeOutput=null;});
say('Симулятор работает автономно.');render();
