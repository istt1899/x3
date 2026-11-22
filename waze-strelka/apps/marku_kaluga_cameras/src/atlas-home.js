// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const trip = require('./trip_view.js');
const menu = [
    ['tripCamera','Камера'], ['tripMaps','Карта телефона'], ['tripDatabase','Базы и регионы'],
    ['tripDiagnostics','Диагностика'], ['tripSettings','Настройки'], ['tripAbout','Справка']
];
const C = { panel:'#112820', map:'#1c342e', line:'#395248', text:'#edf4e9', dim:'#b8cbbd',
    green:'#a3edac', stroke:'#779687', warm:'#f1bf76', off:'#70847a' };
const phases = { waiting:'Ожидание сервиса', disabled:'Камеры выключены', gps:'Ожидание GPS', stop:'Остановка', approach:'Камера впереди',
    nearby:'Камера рядом', passed:'Камера пройдена', idle:'Путь свободен' };
const directions = { front:'В лоб', rear:'В спину', both:'В обе стороны', unknown:'Неизвестно' };
function point(lat,lon) {
    return Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180 ? [lat,lon] : null;
}
function model(state, version) {
    const view = trip.model(state,version), s=state||{}, a=s.alert||{}, raw=s.atlasMap||{};
    const origin=raw.origin && point(raw.origin.lat,raw.origin.lon);
    const camera=raw.camera && point(raw.camera.lat,raw.camera.lon);
    const roads=Array.isArray(raw.roads) ? raw.roads.slice(0,36).map(r=>{
        if(!r||!Array.isArray(r.points))return null;
        const points=r.points.slice(0,96).map(p=>Array.isArray(p) ? point(p[0],p[1]) : null);
        return points.length>1 && points.every(Boolean)?{points,name:typeof r.name==='string'?r.name.slice(0,40):'',current:r.current===true}:null;
    }).filter(Boolean):[];
    const side=view.active ? require('./atlas-detail.js').confirmedDirection(a) : 'unknown';
    return Object.assign(view,{side, origin:origin||null,camera:camera||null,roads,
        heading:s.gpsFix&&Number.isFinite(s.gpsFix.headingDeg)?s.gpsFix.headingDeg:null,
        street:s.street&&s.street.state==='ready'&&typeof s.street.name==='string'?s.street.name:'',
        region:typeof raw.region==='string'?raw.region.slice(0,40):''});
}
function text(c,value,x,y,size,color,weight,align) {
    c.text(String(value),x,y,size,color,{font:weight?'bold':'label',align:align||'left',literal:true});
}
function fitText(c,value,x,y,size,width,color,bold) {
    const opts={literal:true,font:bold?'bold':'label'}; let v=String(value||'');
    if(c.textWidth(v,size,opts)>width) {
        while(v.length&&c.textWidth(v+'…',size,opts)>width)v=v.slice(0,-1);
        v+='…';
    }
    text(c,v,x,y,size,color,bold);
}
function stroke(c,pts,color,width) {c.polyline(pts,width||2,color);}
function cameraIcon(c,x,y,size,fg,bg) {
    const k=size/32;
    c.roundRect(x,y+5*k,32*k,23*k,5*k,fg);c.roundRect(x+5*k,y,10*k,7*k,2*k,fg);
    c.circle(x+19*k,y+16*k,7*k,bg);c.circle(x+19*k,y+16*k,4*k,fg);
}
function menuIcon(c,i,x,y) {
    if(i===0){cameraIcon(c,x,y,26,C.green,C.panel);return;}
    if(i===1){stroke(c,[[x,y+4],[x+8,y],[x+17,y+4],[x+26,y],[x+26,y+19],[x+17,y+23],[x+8,y+19],[x,y+23],[x,y+4]],C.green);return;}
    if(i===2){for(let j=0;j<3;j++)stroke(c,[[x,y+4+j*7],[x+13,y+8+j*7],[x+26,y+4+j*7]],C.green);return;}
    if(i===3){stroke(c,[[x,y+12],[x+6,y+12],[x+9,y+3],[x+15,y+22],[x+19,y+9],[x+23,y+12],[x+27,y+12]],C.green);return;}
    if(i===4){for(let j=0;j<3;j++){c.line(x,y+j*8+2,x+25,y+j*8+2,2,C.green);c.circle(x+8+(j%2)*10,y+j*8+2,3,C.green);}return;}
    c.arc(x+13,y+12,10,12,0,360,C.green);text(c,'i',x+13,y+19,19,C.green,true,'center');
}
function menuTargets() {
    return menu.map((v,i)=>({command:v[0],label:v[1],x:18,y:105+i*66,w:274,h:60,enabled:true}));
}
function optic(c,x,y,side){
    c.roundRect(x+5,y+20,26,53,7,C.dim);
    c.roundRect(x+9,y+29,18,13,3,C.panel);
    c.roundRect(x+9,y+55,18,10,3,C.panel);
    function cameraArrow(rear){
        const yy=rear?y+89:y+2, step=rear?-1:1;
        cameraIcon(c,x+45,yy-4,17,C.green,C.panel);
        c.line(x+45,yy+9,x+31,yy+16*step,3,C.green);
        stroke(c,[[x+32,yy+9*step],[x+30,yy+17*step],[x+39,yy+16*step]],C.green,2);
    }
    if(side==='front'||side==='both')cameraArrow(false);
    if(side==='rear'||side==='both')cameraArrow(true);
    if(side==='unknown')text(c,'?',x+48,y+57,23,C.dim,true);
}
function distance(value) {return value===null?'—':value>=1000?(value/1000).toFixed(1).replace('.',',')+' км':value+' м';}
function drawMap(c,v) {
    const x=309,w=875,right=x+w, center=752,baseline=341;
    c.fillRect(x,0,w,520,C.map);
    const geo=!!(v.origin && v.roads.length);
    const header=geo?(v.street||v.region||'Окрестности'):'Схема расстояния';
    if(geo){
        // A north-up local projection. Clip each segment at the panel to avoid drawing across adjacent controls.
        const radius=Math.max(340,Math.min(2100,(v.distance||380)*1.18));
        const scale=204/radius, lat=v.origin[0],lon=v.origin[1], cy=286;
        const project=p=>[center+((((p[1]-lon+540)%360)-180)*111195*Math.cos(lat*Math.PI/180))*scale,cy-(p[0]-lat)*111195*scale];
        const inside=p=>p[0]>=x+4 && p[0]<right-4 && p[1]>=66 && p[1]<475;
        v.roads.forEach(r=>{
            const pts=r.points.map(project);const street=r.current?C.green:'#758d7e';
            for(let i=1;i<pts.length;i++){
                let a=pts[i-1],b=pts[i],t0=0,t1=1;const dx=b[0]-a[0],dy=b[1]-a[1];
                const edge=[[-dx,a[0]-x-5],[dx,right-5-a[0]],[-dy,a[1]-65],[dy,475-a[1]]];
                let show=true;
                edge.forEach(e=>{if(!e[0]){if(e[1]<0)show=false;}else if(e[0]<0)t0=Math.max(t0,e[1]/e[0]);else t1=Math.min(t1,e[1]/e[0]);});
                if(show&&t0<t1)c.line(a[0]+t0*dx,a[1]+t0*dy,a[0]+t1*dx,a[1]+t1*dy,r.current?9:5,street);
            }
        });
        if(v.active&&v.camera){const p=project(v.camera);if(inside(p))cameraIcon(c,p[0]-14,p[1]-14,29,C.green,C.panel);}
        c.circle(center,cy,15,C.panel);c.circle(center,cy,8,C.green);
        if(Number.isFinite(v.heading)){const rad=v.heading*Math.PI/180;c.line(center,cy,center+Math.sin(rad)*23,cy-Math.cos(rad)*23,4,C.green);}
        c.line(x+35,457,x+35+100*scale,457,3,C.dim);text(c,'100 м',x+35,447,18,C.dim);
        text(c,'Север',right-44,452,19,C.dim,false,'right');
        c.line(right-30,453,right-30,435,2,C.dim);
        stroke(c,[[right-36,442],[right-30,434],[right-24,442]],C.dim,2);
    } else {
        // The service can publish distance without road coordinates. A proportional
        // measuring rail communicates that fact without inventing streets or turns.
        const x0=x+66, x1=right-68;
        const max=Math.max(500,Math.ceil((v.distance||0)/250)*250);
        const gy=baseline-40;
        for(let i=0;i<=10;i++){
            const xx=x0+(x1-x0)*i/10;
            c.line(xx,gy-22,xx,gy+(i%2===0?22:11),i%2===0?2:1,'#526e60');
            if(i%5===0)text(c,distance(Math.round(max*i/10)),xx,gy+52,20,C.dim,false,'center');
        }
        c.line(x0,gy,x1,gy,4,'#658572');
        c.circle(x0,gy,16,C.panel);c.circle(x0,gy,8,C.green);
        if(v.distance!==null&&v.active){
            const at=x0+(x1-x0)*Math.min(1,v.distance/max);
            c.line(x0,gy,at,gy,5,C.green);c.line(at,gy-55,at,gy,2,C.green);
            cameraIcon(c,at-18,gy-84,37,C.green,C.panel);
        }
        text(c,'Автомобиль',x0,gy+95,21,C.text);
        text(c,'Расстояние от автомобиля',x0,gy+132,19,C.dim);
    }
    fitText(c,header,x+32,53,30,w-76,C.text,true);
    if(!geo && v.street)fitText(c,v.street,x+32,96,23,w-70,C.dim);
}
function drawHome(c,v,focus) {
    c.fillRect(0,0,1600,520,C.panel); drawMap(c,v);
    text(c,'Атлас',30,65,51,C.text,true);text(c,'Меню поездки',32,95,22,C.dim);
    menuTargets().forEach((b,i)=>{
        if(focus===b.command){c.roundRect(b.x,b.y,b.w,b.h,8,'#284a37');c.fillRect(b.x,b.y+8,4,b.h-16,C.green);}
        else c.line(30,b.y+1,280,b.y+1,1,C.line);
        menuIcon(c,i,36,b.y+20);
        text(c,b.label,78,b.y+40,24,C.text,focus===b.command);
    });
    const xx=1215;
    fitText(c,phases[v.phase]||'Поездка',xx,54,34,354,C.text,true);
    text(c,'До камеры',xx,108,23,C.dim);text(c,distance(v.distance),xx,185,69,C.green,true);
    c.line(xx,218,1568,218,1,C.line);
    const known=v.limit!==null, advisory=['map','speedcam'].includes(v.limitScope);
    c.circle(xx+37,280,35,known?(advisory?C.warm:'#eb6b59'):C.off); c.circle(xx+37,280,29,'#f5f1df');
    text(c,known?v.limit:'—',xx+37,292,34,'#1b2820',true,'center');
    text(c,'Лимит',xx+94,264,20,C.dim);
    text(c,advisory?(v.limitScope==='map'?'по карте':'по базе'):'км/ч',xx+94,297,21,C.text);
    text(c,'Скорость',xx+221,264,20,C.dim);text(c,(v.speed===null?'—':v.speed)+' км/ч',xx+221,298,25,C.text,true);
    c.line(xx,337,1568,337,1,C.line);
    text(c,'Направление камеры',xx,377,24,C.dim);optic(c,xx+7,391,v.side);
    text(c,directions[v.side],xx+102,451,26,C.text,true);
}
module.exports={menuTargets,model,drawHome,distance};
