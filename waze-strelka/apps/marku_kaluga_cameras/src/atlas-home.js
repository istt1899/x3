// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const scene = require('./atlas-camera-scene.js');
const menu = [
    ['tripCamera','Камера'], ['tripMaps','Карты телефона'], ['tripDatabase','Базы и регионы'],
    ['tripDiagnostics','Диагностика'], ['tripSettings','Настройки'], ['tripAbout','Справка']
];
const sectionPages=['cameraDetail','main','regions','diagnostics','cameras','about'];
const sections=['trip'].concat(sectionPages);
const labels=['Поездка'].concat(menu.map(item=>item[1]));
const exitButton={command:'atlasExit',label:'Выход',x:177,y:24,w:115,h:56,enabled:true};
const subSection={logs:'main',database:'regions',diagnosticPhoto:'diagnostics',alerts:'cameras',types:'cameras',
    calibration:'cameras',position:'cameras',overspeed:'cameras',atlasMenu:'trip'};
function section(page){return subSection[page]||page;}
function railTargets(page){
    const active=section(page);
    return sections.map((dest,i)=>({
        command:'atlasNav:'+dest,label:labels[i],kind:'section',destination:dest,selected:active===dest,enabled:true,
        x:18,y:i===0?10:105+(i-1)*66,w:274,h:i===0?87:60
    }));
}
const C = { panel:'#112820', map:'#132e2b', line:'#395248', text:'#edf4e9', dim:'#b8cbbd',
    green:'#86dfc0', stroke:'#779687', warm:'#f1bf76', off:'#70847a' };
const phases = { waiting:'Ожидание сервиса', disabled:'Камеры выключены', gps:'Ожидание GPS', stop:'Остановка', approach:'Камера впереди',
    nearby:'Камера рядом', passed:'Камера пройдена', idle:'Путь свободен' };
const directions = { front:'В лоб', rear:'В спину', both:'В обе стороны', unknown:'Неизвестно' };
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
const editButton={command:scene.open,label:scene.openLabel,x:331,y:419,w:548,h:63,enabled:true};
function menuTargets() {
    return menu.map((v,i)=>({command:v[0],label:v[1],x:18,y:105+i*66,w:274,h:60,enabled:true})).concat(editButton,exitButton);
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
function drawRail(c,page,focus) {
    c.fillRect(0,0,309,520,C.panel);
    const rail=railTargets(page);
    const top=rail[0];
    if(focus===top.command)c.strokeRoundRect(top.x,top.y,top.w,top.h,9,2,C.green);
    text(c,'Атлас',30,61,45,C.text,true);
    text(c,'Поездка',32,90,23,page==='trip'?C.green:C.dim,page==='trip');
    if(page==='trip'){
        const b=exitButton, active=focus===b.command;
        c.roundRect(b.x,b.y,b.w,b.h,8,active?'#294a39':'#203b2d');
        c.strokeRoundRect(b.x,b.y,b.w,b.h,8,active?3:1,active?C.green:C.stroke);
        text(c,b.label,b.x+b.w/2,b.y+37,24,C.text,active,'center');
    }
    rail.slice(1).forEach((b,i)=>{
        const focused=focus===(page==='trip'?menu[i][0]:b.command);
        if(b.selected||focused)c.roundRect(b.x,b.y,b.w,b.h,8,b.selected?'#294a39':'#203b2d');
        if(b.selected)c.fillRect(b.x,b.y+8,4,b.h-16,C.green);
        if(focused)c.strokeRoundRect(b.x+2,b.y+2,b.w-4,b.h-4,7,2,C.green);
        if(!focused&&!b.selected)c.line(30,b.y+1,280,b.y+1,1,C.line);
        menuIcon(c,i,36,b.y+20);
        text(c,b.label,78,b.y+40,24,C.text,b.selected||focused);
    });
    c.line(308,0,308,520,1,C.line);
}
function drawHome(c,v,focus) {
    c.fillRect(0,0,1600,520,scene.C.bg);
    drawRail(c,'trip',focus);
    scene.text(c,'Карта поездки',332,60,42,860,scene.C.text,true);
    scene.text(c,String(v.outputs||'').split(' • ').slice(0,2).join('  /  '),1565,58,23,590,scene.C.dim,false,'right');
    scene.hero(c,v,331,85,548,316);
    scene.map(c,v,898,85,672,397);
    const b=editButton, active=focus===b.command;
    c.roundRect(b.x,b.y,b.w,b.h,10,active?scene.C.accent:C.panel);
    c.strokeRoundRect(b.x,b.y,b.w,b.h,10,2,scene.C.accent);
    scene.text(c,b.label,b.x+22,b.y+41,27,b.w-68,active?scene.C.bg:scene.C.accent,true);
    const x=b.x+b.w-27,y=b.y+b.h/2, ink=active?scene.C.bg:scene.C.accent;
    c.line(x-6,y-9,x+3,y,3,ink);c.line(x+3,y,x-6,y+9,3,ink);
}
function drawSummary(c,v) {
    c.fillRect(0,0,1600,240,C.panel);
    if(!v)return;
    const at=[28,540,897,1265];
    fitText(c,phases[v.phase]||'Поездка',at[0],54,40,490,C.text,true);
    fitText(c,v.street||v.region||'Яндекс Стрелка',at[0],101,28,490,C.dim);
    if(v.active){optic(c,at[0],111,v.side);fitText(c,directions[v.side],at[0]+89,174,28,390,C.text,true);}
    else fitText(c,v.text.tripCameraStatus,at[0],170,29,485,C.text);
    const metrics=[['До камеры',scene.distance(v.distance)],['Лимит',v.limit===null?'—':v.limit+' км/ч'],['Скорость',v.speed===null?'—':v.speed+' км/ч']];
    metrics.forEach((m,i)=>{const x=at[i+1];c.line(x-22,25,x-22,187,1,C.line);
        fitText(c,m[0],x,58,29,300,C.dim);fitText(c,m[1],x,139,56*v.centralScale/100,300,C.green,true);});
    const hint=v.active?v.limitNote:'';
    if(hint)fitText(c,hint,at[2],177,24,310,C.dim);
    c.line(28,198,1570,198,1,C.line);fitText(c,v.outputs||'—',28,228,23,1530,C.dim);
}
module.exports={menuTargets,railTargets,section,drawRail,model:scene.model,drawHome,drawSummary,distance:scene.distance};
