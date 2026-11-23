// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const names = {cluster:'Приборная панель', hud:'Проекция HUD'};
const center = 'atlasCenterMapScale';
const layouts = ['Вывод карты','Центральный экран','Проекция HUD','Приборная панель','Параметры навигации','Другие разделы'];
const HOLD_MS = 700;

function status(control, scale) {
    return {
        cluster:control.clusterOn(), hud:control.hudOn(), available:control.canChooseShownOn(),
        hudDisabled:control.hudDisabled(), width:control.hudWidth(), offset:control.hudOffset(),
        error:control.mapSaveError || '', centerScale:scale.get(center), centerError:scale.error || ''
    };
}
function groups(v, regular) {
    const m=v.maps, outputs=Object.keys(names).map(display=>{
        const on=m[display], want=on===false ? 1 : 0;
        return {source:'wocShowOn', command:'atlasMapOutput:'+display+':'+want,
            label:names[display], kind:'toggle', selected:on, holdMs:HOLD_MS, focusKey:'atlasSwitch:'+display,
            enabled:typeof on==='boolean' && m.available && !(display==='hud' && !on && m.hudDisabled)};
    });
    if (v.interactive) v.mapConfirm=null;
    if (v.mapConfirm) {
        const target=outputs.find(b=>b.command===v.mapConfirm && b.enabled);
        if(target){
            outputs.push({command:'atlasMapConfirm',label:target.selected?'Подтвердить выключение':'Подтвердить включение',enabled:true},
                {command:'atlasMapCancel',label:'Отмена',enabled:true});
        } else v.mapConfirm=null;
    }
    // These are ordinary Atlas pages. A fixed BMW slot has no size/position writes.
    const step=(m.centerScale-65)/5;
    const preview={source:center,command:'atlasEdit:atlasCenterMapScale',label:'Размер предпросмотра',value:m.centerScale+' %',
        step,max:12,kind:'slider',enabled:Number.isInteger(step) && step>=0 && step<=12};
    const centerButtons=[preview,
        {command:'atlasMapSmaller',label:'Уменьшить на 5 %',enabled:preview.enabled && step>0},
        {command:'atlasMapBigger',label:'Увеличить на 5 %',enabled:preview.enabled && step<12}];
    const hud=regular(['wocHudSize','wocHudLeft','wocHudRight','wocHudUp','wocHudDown','wocHudCentre']);
    hud.forEach(item=>{
        if(!item)return;
        item.enabled=item.enabled && m.available && m.hud===true && !m.hudDisabled;
        if(item.source==='wocHudSize') {
            item.enabled=item.enabled && m.width!==null;
            if(item.enabled && Number.isInteger(item.step)){item.kind='slider';item.max=11;}
        }else if(!m.offset) item.enabled=false;
    });
    const sets=[outputs,centerButtons,hud,regular(['wocAaZoomOut','wocAaZoomIn']),
        regular(['wocGuide','wocProfile','wocHudKeep','wocAaCard','wocHudOpacity']),regular(['wocCameras','wocLogs'])];
    return sets.map((items,index)=>[layouts[index],items.filter(Boolean)]);
}
function stepFor(command,scale) {
    if(command==='atlasMapSmaller')return (scale-65)/5-1;
    if(command==='atlasMapBigger')return (scale-65)/5+1;
    const match=/^atlasValue:atlasCenterMapScale:(0|[1-9][0-9]?)$/.exec(command);
    return match ? Number(match[1]) : null;
}
function mark(cv,x,y,w,h,P) {
    cv.roundRect(x,y,w,h,Math.min(8,h/5),P.tile);
    // A route glyph marks the map area, without inventing a phone route or position.
    cv.line(x+w*.17,y+h*.76,x+w*.43,y+h*.54,Math.max(2,h*.05),P.focus);
    cv.line(x+w*.43,y+h*.54,x+w*.57,y+h*.54,Math.max(2,h*.05),P.focus);
    cv.line(x+w*.57,y+h*.54,x+w*.81,y+h*.22,Math.max(2,h*.05),P.focus);
}
function diagram(cv,v,words,P,x,y,w,h) {
    const m=v.maps, mode=v.sheet===2?'hud':v.sheet===3?'cluster':'center';
    cv.roundRect(x,y,w,h,9,P.line);
    cv.roundRect(x+2,y+2,w-4,h-4,8,P.bg);
    const drag=v.sliderPreview, centerPct=drag && drag.source===center ? 65+5*drag.step : m.centerScale;
    const pct=drag && drag.source==='wocHudSize' ? 30+5*drag.step : m.width;
    if(mode==='hud' && (!Number.isFinite(pct)||!m.offset)){
        words(cv,'Геометрия HUD неизвестна',x+w/2,y+h*.57,21,w-24,P.dim,false,'center');return;
    }
    const ratio=mode==='hud' ? (pct===0 ? 0.57 : pct/100) : mode==='cluster' ? 0.65 : 0.55*centerPct/100;
    const rw=Math.round((w-24)*ratio), rh=Math.max(18,Math.min(h-18,Math.round((h-20)*ratio/.82)));
    const clamp=n=>Math.max(-1,Math.min(1,n/400));
    const dx=mode==='hud'?clamp(m.offset[0]):0,dy=mode==='hud'?clamp(m.offset[1]):0;
    const left=x+8+(w-16-rw)*(1+dx)/2,top=y+7+(h-14-rh)*(1+dy)/2;
    mark(cv,left,top,rw,rh,P);
}
function draw(cv,v,words,P,compact) {
    const m=v.maps, sheet=v.sheet, left=compact?28:48, top=compact?68:105;
    const w=compact?620:656, h=compact?150:314;
    if(!compact)cv.roundRect(24,top,704,h,12,P.surface);
    const title=sheet===0?'Карта телефона':sheet===1?'Схема на центральном экране':sheet===2?'Расположение на HUD':sheet===3?'Слот приборной панели':'Подключение телефона';
    words(cv,title,left,top+32,29,w,P.text,true);
    if(sheet<=3)diagram(cv,v,words,P,left,top+49,w,compact?76:134);
    const x=compact?700:left, y=compact?top+40:top+228, room=compact?855:w;
    let line='',note='';
    if(sheet===0){
        const summary=m.cluster===null||m.hud===null?'Состояние выходов неизвестно':
            m.cluster&&m.hud?'Приборы и HUD':m.cluster?'Приборная панель':m.hud?'Проекция HUD':'Оба выхода выключены';
        line=summary;
        note=v.mapConfirm?'Подтверждение · '+names[v.mapConfirm.split(':')[1]]:
            !m.available?'Ожидание данных службы вывода':v.holding?'Удерживайте до переключения':
            v.interactive?'Удерживайте нужный выход 0,7 с':'Выберите выход и подтвердите изменение';
    }else if(sheet===1){
        line='Масштаб схемы · '+m.centerScale+' %';note='Полноэкранной картой управляет телефон';
    }else if(sheet===2){
        line=m.width===null?'Размер неизвестен':m.width===0?'Размер · штатный':'Ширина · '+m.width+' %';
        note=m.offset?'Смещение X '+m.offset[0]+' пкс  ·  Y '+m.offset[1]+' пкс':'Смещение неизвестно';
        if(m.hud===false)note+='  ·  HUD выключен';
        if(m.hudDisabled)note='Вывод на HUD недоступен';
    }else if(sheet===3){
        line='Размер и положение задаёт BMW';note='Масштаб Android Auto меняет детализацию карты';
    }else {
        line=v.rows[0][1];note=v.rows[1][1];
    }
    words(cv,line,x,y,26,room,P.text,true);
    words(cv,(sheet===1 && m.centerError)||m.error||note,x,y+38,22,room,(m.error || sheet===1 && m.centerError)?P.gold:P.dim);
}
module.exports={status,groups,draw,diagram,stepFor,names,HOLD_MS};
