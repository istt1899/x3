// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const trip = require('./trip_view.js');
const cameraView = require('./view_model.js');
const diagnostics = require('./diagnostics_view.js');

const C = {bg:'#102622', panel:'#19332e', map:'#132e2b', line:'#36534c', road:'#506c63',
    text:'#f0f5ee', dim:'#b8ccc4', accent:'#86dfc0', amber:'#edb575', off:'#769085', sign:'#f5f0e2'};
const faces = {front:'В лоб',rear:'В спину',both:'В обе стороны',unknown:'Не подтверждено'};
const screens = {center:'Центральный экран',hud:'Проекция HUD',map:'Приборная панель'};
const phases = {waiting:'Ожидание сервиса',disabled:'Камеры выключены',gps:'Ожидание GPS',stop:'Остановка перед камерой',
    approach:'Камера впереди',nearby:'Камера рядом',passed:'Камера пройдена',idle:'Свободный путь'};
const open = 'atlasCameraOpen';
const openLabel = 'Настроить уведомление';
function confirmedDirection(alert) {
    const a=alert||{}, capture=a.capture;
    const valid=v=>v==='front'||v==='rear'||v==='both';
    if(a.captureDirectionVerified===true && valid(a.captureDirection))return a.captureDirection;
    if(!capture||capture.verified!==true||!a.captureClass||a.captureClass==='cross')return 'unknown';
    if(valid(capture.side))return capture.side;
    return Number.isFinite(capture.facingDeg)&&valid(a.captureClass)?a.captureClass:'unknown';
}
function point(lat,lon) {
    return Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180 ? [lat,lon] : null;
}
function model(state,version,centralScale) {
    const v=trip.model(state,version), s=state||{}, raw=s.atlasMap||{}, a=v.active?s.alert:{};
    const roads=Array.isArray(raw.roads)?raw.roads.slice(0,36).map(r=>{
        if(!r || !Array.isArray(r.points))return null;
        const points=r.points.slice(0,96).map(p=>Array.isArray(p)?point(p[0],p[1]):null);
        return points.length>=2 && points.every(Boolean)?{points,current:r.current===true,name:String(r.name||'').slice(0,40)}:null;
    }).filter(Boolean):[];
    const limit=trip.approachLimit(a), prefs=s.cardLayout||{}, fields=s.cardComposition||{}, outputs=s.outputs||{};
    const keys=Array.isArray(a.controls)&&a.controls.length?a.controls:[a.type];
    const types=keys.map(key=>cameraView.ALERT_TYPES.find(t=>t.key===key)).filter(Boolean).map(t=>t.label);
    const limitNote=limit.scope==='conflict'?'Расхождение '+(limit.values||[]).join(' / '):
        ['speedcam','camera'].includes(limit.scope)?'По базе камер':limit.scope==='map'?'По карте':
        limit.scope==='posted'?'По знаку':limit.scope==='road'?'Дорожный лимит':'Нет данных';
    const outputProfiles={};
    for(const target of ['hud','map']){
        const layout=prefs[target]||{}, composition=fields[target]||null;
        outputProfiles[target]={enabled:outputs[target==='map'?'cluster':'hud'],fields:composition,
            size:layout.scalePct,brightness:layout.brightnessPct,opacity:layout.opacityPct};
    }
    return Object.assign(v,{side:confirmedDirection(a),limitNote,origin:raw.origin&&point(raw.origin.lat,raw.origin.lon)||null,
        camera:raw.camera&&point(raw.camera.lat,raw.camera.lon)||null,roads,
        heading:s.gpsFix&&Number.isFinite(s.gpsFix.headingDeg)&&s.gpsFix.headingDeg>=0&&s.gpsFix.headingDeg<360?s.gpsFix.headingDeg:null,
        street:s.street&&s.street.state==='ready'&&typeof s.street.name==='string'?s.street.name.slice(0,80):'',
        region:typeof raw.region==='string'?raw.region.slice(0,40):'',outputs:v.text.tripOutputs,
        cameraTitle:types[0]||String(a.title||'Камера').slice(0,80),types,outputProfiles,
        centralScale:Number.isInteger(centralScale)&&centralScale>=65&&centralScale<=125?centralScale:100});
}
function distance(v){return v===null?'—':v>=1000?(v/1000).toFixed(1).replace('.',',')+' км':v+' м';}
function text(c,value,x,y,size,width,color,bold,align) {
    let str=String(value==null?'—':value);
    const opts={literal:true,font:bold?'bold':'label',align:align||'left'};
    if(c.textWidth(str,size,opts)>width){
        while(str.length && c.textWidth(str+'…',size,opts)>width)str=str.slice(0,-1);
        str+='…';
    }
    c.text(str,x,y,size,color,opts);
}
function cameraIcon(c,x,y,size,fg,bg) {
    const k=size/32;
    c.roundRect(x,y+5*k,32*k,23*k,4*k,fg);c.roundRect(x+4*k,y+1*k,10*k,6*k,2*k,fg);
    c.circle(x+19*k,y+16*k,7*k,bg);c.circle(x+19*k,y+16*k,3*k,fg);
}
function clipped(c,a,b,box,width,color){
    const dx=b[0]-a[0],dy=b[1]-a[1];
    let t0=0,t1=1;
    const edges=[[-dx,a[0]-box.x],[dx,box.right-a[0]],[-dy,a[1]-box.top],[dy,box.bottom-a[1]]];
    for(const [d,p] of edges){
        if(!d){if(p<0)return;}
        else if(d<0)t0=Math.max(t0,p/d);
        else t1=Math.min(t1,p/d);
    }
    if(t0<t1)c.line(a[0]+t0*dx,a[1]+t0*dy,a[0]+t1*dx,a[1]+t1*dy,width,color);
}
function map(c,v,x,y,w,h){
    c.roundRect(x,y,w,h,12,C.map);
    const right=x+w,bottom=y+h, geo=!!(v.origin&&(v.roads.length||v.active&&v.camera));
    const title=geo?(v.street||v.region||'Окрестности'):'Схема расстояния';
    text(c,title,x+20,y+34,24,w-(v.speed===null?44:196),C.dim,true);
    if(v.speed!==null)text(c,v.speed+' км/ч',right-18,y+34,23,146,C.text,true,'right');
    if(!geo){
        if(!v.active || v.distance===null){
            text(c,v.phase==='gps'?'Ожидание координат GPS':'Нет дорожной схемы',x+w/2,y+h*.56,26,w-62,C.dim,false,'center');
            return;
        }
        const x0=x+40,x1=right-44,gy=y+h*.62, span=Math.max(250,Math.ceil(v.distance/250)*250);
        const at=x0+(x1-x0)*v.distance/span;
        c.line(x0,gy,x1,gy,3,C.road);
        for(let i=0;i<=8;i++){const t=x0+(x1-x0)*i/8;c.line(t,gy-6,t,gy+9,2,C.road);}
        c.line(x0,gy,at,gy,5,C.accent);c.circle(x0,gy,8,C.text);
        c.line(at,gy-25,at,gy,2,C.amber);cameraIcon(c,at-14,gy-51,28,C.amber,C.bg);
        text(c,'Автомобиль',x0,gy+35,18,w*.55,C.dim);
        text(c,distance(span),x1,gy+35,18,w*.29,C.dim,false,'right');
        return;
    }
    const box={x:x+8,right:right-8,top:y+44,bottom:bottom-48};
    const cx=(box.x+box.right)/2,cy=(box.top+box.bottom)/2, aspect=c.scaleX||1;
    const lat=v.origin[0],lon=v.origin[1], east=111195*Math.cos(lat*Math.PI/180);
    const metric=p=>[(((p[1]-lon+540)%360)-180)*east,(p[0]-lat)*111195];
    const camera=v.active&&v.camera?metric(v.camera):null;
    const radius=Math.max(300,Math.min(2100,(v.distance||380)*1.18));
    let scale=(box.bottom-box.top)*.46/radius;
    if(camera)scale=Math.min(scale,(box.right-box.x)*.42*aspect/Math.max(1,Math.abs(camera[0])),
        (box.bottom-box.top)*.4/Math.max(1,Math.abs(camera[1])));
    const project=p=>[cx+p[0]*scale/aspect,cy-p[1]*scale];
    for(const current of [false,true]){
        for(const road of v.roads){
            if(road.current!==current)continue;
            const pts=road.points.map(p=>project(metric(p)));
            for(let i=1;i<pts.length;i++)clipped(c,pts[i-1],pts[i],box,current?9:4,current?C.accent:C.road);
        }
    }
    if(camera){
        const [xx,yy]=project(camera);
        c.circle(xx,yy,17,C.amber);cameraIcon(c,xx-10,yy-10,20,C.bg,C.amber);
    }
    c.circle(cx,cy,10,C.bg);c.circle(cx,cy,6,C.text);
    if(Number.isFinite(v.heading)){
        const rad=v.heading*Math.PI/180,dx=Math.sin(rad),dy=-Math.cos(rad);
        c.line(cx,cy,cx+dx*23/aspect,cy+dy*23,4,C.text);
        for(const sign of [-1,1]){
            c.line(cx+dx*23/aspect,cy+dy*23,cx+(dx*12+sign*dy*6)/aspect,cy+dy*12-sign*dx*6,3,C.text);
        }
    }
    const rulerY=bottom-25;
    c.line(x+20,rulerY,x+20+100*scale/aspect,rulerY,3,C.dim);
    text(c,'100 м',x+20,rulerY-8,16,100,C.dim);
    text(c,'Север',right-20,rulerY,17,115,C.dim,false,'right');
}
function sign(c,value,x,y,r) {
    c.circle(x,y,r,value===null?C.off:C.amber);
    c.circle(x,y,r*.84,C.sign);
    text(c,value===null?'—':value,x,y+r*.36,r*.94,r*2.3,C.bg,true,'center');
}
function captureArrow(c,side,x,y,size,ink) {
    if(side==='unknown')return;
    c.line(x,y-size,x,y+size,2.5,ink);
    for(const direction of (side==='both'?[-1,1]:[side==='front'?1:-1])){
        const tip=y+direction*size;
        c.line(x,tip,x-5,tip-6*direction,2.5,ink);c.line(x,tip,x+5,tip-6*direction,2.5,ink);
    }
}
function hero(c,v,x,y,w,h) {
    const k=v.centralScale/100, left=x+23, inner=w-46;
    c.roundRect(x,y,w,h,12,C.panel);
    text(c,phases[v.phase],left,y+h*.17,22,inner,C.accent,true);
    text(c,v.active?v.cameraTitle:v.phase==='idle'?'Активных камер нет':'Предупреждения',left,y+h*.37,34*k,inner,C.text,true);
    const metric=v.active?distance(v.distance):(v.speed===null?'—':v.speed)+' км/ч';
    text(c,metric,left,y+h*.65,Math.min(66,h*.22)*k,inner,C.text,true);
    if(v.active){
        const r=Math.min(26,h*.11)*k,cy=y+h*.83;
        sign(c,v.limit,left+r,cy,r);
        let dirX=left+2*r+18;
        const dir=v.side==='unknown'?'Сторона не подтверждена':faces[v.side];
        if(v.side!=='unknown'){captureArrow(c,v.side,dirX+5,cy-4,10*k,C.accent);dirX+=22;}
        text(c,dir,dirX,cy+4,23*k,inner-(dirX-left),C.text,true);
        text(c,v.limitNote,dirX,cy+25,16,inner-(dirX-left),v.limitScope==='conflict'?C.amber:C.dim);
    }else{
        text(c,v.text.tripCameraStatus,left,y+h*.86,21,inner,C.dim);
    }
}
function profileText(v,target){
    const p=v.outputProfiles[target];
    if(p.enabled!==true)return p.enabled===false?'Вывод выключен':'Вывод не подтверждён';
    if(!v.active)return phases[v.phase];
    if(!p.fields)return 'Состав не подтверждён';
    const f=p.fields, parts=[];
    if(f.limit)parts.push('Лимит '+(v.limit===null?'—':v.limit));
    if(f.direction)parts.push(v.side==='unknown'?'Сторона —':faces[v.side]);
    if(f.distance)parts.push(distance(v.distance));
    if(f.types)parts.push(v.types.slice(0,3).join(', ')||'Камера');
    if(f.speed)parts.push((v.speed===null?'—':v.speed)+' км/ч');
    if(f.status)parts.push(phases[v.phase]);
    return parts.join('  ·  ')||'Все поля скрыты';
}
function preview(c,v,target,x,y,w,h,scaleOverride) {
    const p=v.outputProfiles[target], profile=p.fields||{};
    const scale=(scaleOverride||p.size||100)/100, compact=h<110, left=x+18;
    c.roundRect(x,y,w,h,10,C.panel);
    text(c,screens[target],left,y+(compact?27:36),compact?21:24,w-40,C.dim);
    if(p.enabled!==true || !v.active || !p.fields || !Object.values(profile).some(Boolean)){
        text(c,profileText(v,target),left,y+h*.76,(compact?25:32)*scale,w-40,C.text,true);
        return;
    }
    // Only the contents of the preview follow the physical output's dimming.
    const brightness=Number.isFinite(p.brightness)?p.brightness/100:1, opacity=Number.isFinite(p.opacity)?p.opacity/100:1;
    const ink='#'+[0,1,2].map(i=>Math.min(255,Math.max(0,Math.round([25,51,46][i]*(1-opacity)+[234,244,235][i]*brightness*opacity))).toString(16).padStart(2,'0')).join('');
    const baseline=y+h*(compact ? .60 : .55),radius=(compact?16:23)*scale;
    let tx=left;
    if(profile.limit){
        const cx=tx+radius,cy=baseline-3;
        c.circle(cx,cy,radius,ink);c.circle(cx,cy,radius*.79,C.panel);
        text(c,v.limit===null?'—':v.limit,cx,cy+radius*.35,radius*.87,radius*2.3,ink,true,'center');
        tx+=2*radius+15;
    }
    const main=[];
    if(profile.distance)main.push(distance(v.distance));
    if(profile.direction)main.push(v.side==='unknown'?'Сторона —':faces[v.side]);
    if(profile.speed)main.push((v.speed===null?'—':v.speed)+' км/ч');
    const aux=[];
    if(profile.types)aux.push(v.types.slice(0,3).join(', ')||'Камера');
    if(profile.status)aux.push(phases[v.phase]);
    const primary=main.length?main.join('  ·  '):aux.join(' · ');
    text(c,primary,tx,baseline+5,(compact?21:35)*scale,w-(tx-x)-18,ink,true);
    if(main.length && aux.length)text(c,aux.join(' · '),tx,y+h-9,(compact?16:22)*scale,w-(tx-x)-18,ink);
}
function editor(v,context,target){
    const central=target==='center', p=v.ride.outputProfiles[target]||{},guard=diagnostics.action(context.state,'cardLayout');
    const source=central?'atlasCenterCameraScale':'cameraCardScale', min=central?65:75, max=central?12:15;
    const pct=central?v.ride.centralScale:p.size;
    const step=Number.isInteger(pct)&&(pct-min)%5===0&&(pct-min)/5>=0&&(pct-min)/5<=max?(pct-min)/5:null;
    const enabled=step!==null&&(central||guard.allowed);
    v.cameraOutput=target;v.title='Вид уведомления';v.group='Редактор';v.edit=null;v.sheet=0;v.sheets=1;
    if(context.atlasPanel.cameraAdjust && enabled)v.edit={name:source,label:'Размер',value:pct+' %',step,max};
    v.side=screens[target];v.feedback=central?context.centralScaleError||'':guard.allowed?'':guard.reason;
    const btn=(command,label,x,y,w,extra)=>Object.assign({command,label,enabled:true,x,y,w,h:59},extra);
    v.buttons=Object.keys(screens).map((key,i)=>btn('atlasCameraOutput:'+key,screens[key],24+i*511,83,493,{kind:'choice',selected:key===target}));
    v.buttons.push(btn('atlasCameraSlider','Размер',24,335,1540,{kind:'slider',source,step,max,enabled,value:step===null?'—':pct+' %',
        track:{x:224,y:365,w:1145,h:8,wide:true}}));
    v.buttons.push(btn('atlasValue:'+source+':'+(step-1),'Уменьшить',24,443,272,{enabled:enabled&&step>0}),
        btn('atlasValue:'+source+':'+(step+1),'Увеличить',310,443,272,{enabled:enabled&&step<max}));
    if(!central)v.buttons.push(btn(target==='hud'?'cameraHudSetup':'cameraMapSetup','Яркость, положение и состав',599,443,650));
    v.buttons.push(btn('atlasCameraClose','Назад',1281,443,283));
    return v;
}
function button(c,b,focus) {
    const chosen=b.selected===true, active=b.enabled!==false&&focus===b.command, primary=b.command===open;
    const ink=active?C.bg:b.enabled===false?C.off:chosen||primary?C.accent:C.text;
    c.roundRect(b.x,b.y,b.w,b.h,9,active?C.accent:chosen?'#24493e':C.panel);
    const cy=b.y+b.h/2, left=b.x+20;
    let labelX=left;
    if(primary){
        cameraIcon(c,left-2,cy-12,26,ink,active?C.accent:C.panel);
        labelX+=34;
    }else if(chosen){
        c.line(left,cy,left+5,cy+5,2.5,ink);
        c.line(left+5,cy+5,left+14,cy-6,2.5,ink);
        labelX+=34;
    }
    text(c,b.label,labelX,cy+9,26,b.x+b.w-labelX-18,ink,true);
}
function editorDraw(c,v,focus) {
    const ride=v.ride, target=v.cameraOutput, slider=v.buttons.find(b=>b.kind==='slider');
    const pct=v.sliderPreview&&v.sliderPreview.source===slider.source?(target==='center'?65:75)+5*v.sliderPreview.step:
        slider.step===null?null:parseInt(slider.value,10);
    text(c,v.title,28,57,39,1190,C.text,true);
    const left=24,top=158,w=1540,h=158;
    if(target==='center'){
        c.roundRect(left,top,w,h,12,C.panel);
        text(c,'Предпросмотр · '+screens[target],left+22,top+36,22,w-42,C.dim);
        const size=Math.round(35*(pct||100)/100);
        const display=ride.active?ride.cameraTitle+'  ·  '+distance(ride.distance)+'  ·  '+faces[ride.side]:phases[ride.phase];
        text(c,display,left+22,top+107,size,w-44,C.text,true);
    }else preview(c,ride,target,left,top,w,h,pct);
    if(v.feedback)text(c,v.feedback,27,425,18,1515,C.amber);
    else if(v.edit)text(c,'Поворот iDrive меняет размер. Нажмите, чтобы закончить.',27,425,18,1515,C.dim);
    v.buttons.forEach(b=>{
        if(b.kind==='slider'){
            const current=v.sliderPreview&&v.sliderPreview.source===b.source?v.sliderPreview.step:b.step;
            const bar=b.track;
            c.roundRect(b.x,b.y,b.w,b.h,8,b.enabled?C.panel:C.bg);
            text(c,b.label,b.x+20,b.y+39,24,164,C.text,true);
            c.roundRect(bar.x,bar.y,bar.w,8,4,C.road);
            if(Number.isInteger(current)){
                const travel=bar.w*current/b.max;
                if(travel>0)c.roundRect(bar.x,bar.y,travel,8,Math.min(4,travel/2),C.accent);
                c.circle(bar.x+travel,bar.y+4,9,C.accent);
            }
            text(c,pct===null?'—':pct+' %',b.x+b.w-20,b.y+39,25,143,C.text,true,'right');
        }else button(c,b,focus);
    });
}
module.exports={C,open,openLabel,phases,faces,screens,confirmedDirection,model,distance,text,hero,map,profileText,preview,editor,editorDraw,button,cameraIcon};
