// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert');
const detail = require('../src/atlas-detail.js');
const harness = require('./ui_harness.js');
const diagnostic = require('../src/diagnostics_view.js');
const controls = require('../src/atlas-controls.js');
const home = require('../src/atlas-home.js');
const fwCommands = ['wocEnable','wocDisable','wocAaEnable','wocAaDisable','wocRestart'];

function stage() {
    const words=[];
    const cv={textWidth:s=>s.length*10,fillRect:()=>{},line:()=>{},roundRect:()=>{},circle:()=>{},
        text(s,x,y,size){assert(Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(size));words.push(s);}};
    return {cv,words};
}
function overlaps(a,b) {
    return Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x) && Math.min(a.y+a.h,b.y+b.h)>Math.max(a.y,b.y);
}
function checkSwitchPresentation() {
    function render(view, focus) {
        const art=stage(), colors=[];
        art.cv.roundRect=(x,y,w,h,r,color)=>colors.push(color);
        detail.drawDetail(art.cv,view.page,view,focus);
        return {colors,words:art.words};
    }
    for(const enabled of [true,false,null]){
        const view=detail.model('alerts',{state:enabled===null?null:{enabled}});
        const toggle=view.buttons.find(b=>b.command==='cameraEnable');
        assert.strictEqual(toggle.selected,enabled);
        for(const focus of ['cameraEnable','atlasBack']){
            const result=render(view,focus);
            assert.strictEqual(result.colors.includes('#91cbae'),enabled===true);
            assert.strictEqual(result.colors.includes('#d79c98'),enabled===false);
            assert(result.words.includes(enabled===null?'—':enabled?'Вкл.':'Выкл.'));
        }
    }
    const view=detail.model('overspeed',{atlasPanel:{sheet:0,edit:'cameraSoundRepeat'},
        written:{'cell:cameraSoundRepeat:0:Value':1}});
    const choice=view.buttons.find(b=>b.selected===true);
    assert.strictEqual(choice.kind,'choice');
    const result=render(view,choice.command);
    assert(result.words.includes('Выбрано'));
    assert(!result.colors.includes('#91cbae')&&!result.colors.includes('#d79c98'));
}
async function main() {
    checkSwitchPresentation();
    const h=harness.create(), app=h.app;
    try {
        await app._setupRhmi();
        const tripState=h.ui.containers[113].name;
        await h.enter(tripState);
        const exit=home.menuTargets().find(item=>item.command==='atlasExit');
        assert(exit && home.menuTargets().every(item=>item.command===exit.command||!overlaps(item,exit)));
        app._atlasStage.focus.trip=exit.command;
        await app._atlasAction(exit.command);
        assert.strictEqual(h.current(),null,'Exit closes the RHMI entry state');
        assert.strictEqual(app._atlasStage.focus.trip,undefined,'reopening starts on the first section');
        await h.enter(tripState);
        await h.back();
        assert.strictEqual(h.current(),null,'hardware Back leaves the RHMI entry state');
        const metres100=100/111195;
        const map=home.model({atlasMap:{origin:{lat:0,lon:0},roads:[{current:true,
            points:[[0,0],[metres100,metres100]]}]},gpsFix:{headingDeg:45}},h.manifest.version);
        for(const aspect of [0.75,1,1.4]){
            const cv=stage().cv, lines=[];
            Object.assign(cv,{scaleX:aspect,arc(){},polyline(){},strokeRoundRect(){},line(...args){lines.push(args);}});
            home.drawHome(cv,map,exit.command);
            const road=lines.find(v=>v[4]===9), heading=lines.find(v=>v[4]===4&&v[0]===road[0]&&v[1]===road[1]);
            for(const v of [road,heading])assert(Math.abs((v[2]-v[0])*aspect-(v[1]-v[3]))<1e-7,'45° bearing on screen');
            const ruler=lines.find(v=>v[1]===457&&v[1]===v[3]);
            assert(Math.abs((road[2]-road[0])-(ruler[2]-ruler[0]))<1e-7,'100 m ruler matches projected road');
        }
        const base={enabled:true,outputs:{hud:true,cluster:true},alert:{id:'t1',roadConfirmed:true,
            limitKmh:40,distanceM:180,captureClass:'rear'},serviceVersion:'0.11.0'};
        base.cardLayout={hud:{x:5,y:5,scalePct:80,brightnessPct:15,opacityPct:95}};
        base.actions={cardLayout:{allowed:true},displayTest:{allowed:true},displayTestStop:{allowed:true}};
        base.regionalDatabase={selectedRegion:'RU-KLU',phase:'listed',regions:[{region:'RU-KLU'},{region:'RU-MOS'}]};
        const input={state:base,version:'0.11.0',serviceReady:true,written:app._written};
        function checkFrame(view){
            const art=stage(), summary=stage();
            detail.drawDetail(art.cv,view.page,view,view.buttons[0].command);
            detail.drawSummary(summary.cv,view.page,view);
            assert(art.words.includes(view.title));
            assert(summary.words.includes(view.edit?view.edit.label:view.title));
            assert(view.buttons.length<=9);
            assert.strictEqual(new Set(view.buttons.map(t=>t.command)).size,view.buttons.length);
            view.buttons.forEach((button,i)=>{
                assert(button.x>=0&&button.x+button.w<=1600&&button.y>=0&&button.y+button.h<=520);
                assert(button.h>=55&&button.w>=150);
                assert(!view.buttons.slice(i+1).some(c=>overlaps(button,c)),view.page+' overlapping actions');
            });
        }
        const nativeBackings=new Set();
        Object.keys(detail.names).forEach(page=>{
            const baseId=detail.pageIds[page];
            const surface=h.ui.containers[100+baseId];
            assert(Object.values(surface.components).some(c=>c.name==='atlasFrame'+baseId),page);
            const written={'cell:wocShowOn:SelectedItem':2};
            Object.keys(controls.sliders).forEach(id=>{written['cell:'+id+':0:Value']=1;});
            const mapState={cluster:true,hud:true,available:true,width:35,offset:[0,0],centerScale:100};
            const data=Object.assign({},input,{written,phoneMaps:mapState});
            const initial=detail.model(page,data);
            let panel={sheet:0,edit:null};
            for(let sheet=0;sheet<initial.sheets;sheet++){
                const view=detail.model(page,Object.assign({},data,{atlasPanel:panel}));
                assert.strictEqual(view.sheet,sheet);checkFrame(view);
                view.buttons.forEach(b=>{
                    assert(!fwCommands.includes(b.source));
                    if(!b.source)return;
                    nativeBackings.add(b.source);
                    if(b.kind==='editor'||b.kind==='slider'){
                        const opened=detail.reducePanel(panel,b.command,view);
                        assert.deepStrictEqual(opened,{sheet,edit:b.source});
                        const edit=detail.model(page,Object.assign({},data,{atlasPanel:opened}));
                        checkFrame(edit);
                        const expected='atlasValue:';
                        assert(edit.buttons.some(x=>x.enabled&&x.command.startsWith(expected+b.source+':')),'No editable value for '+b.source);
                        edit.buttons.filter(x=>x.command.startsWith(expected)).forEach(x=>{
                            const step=Number(x.command.split(':')[2]);
                            assert(Number.isInteger(step)&&step>=0&&step<=edit.edit.max);
                        });
                        assert.deepStrictEqual(detail.reducePanel(opened,'atlasEditClose',edit),panel);
                    }
                    if(controls.scaleSliders[b.source])return; // app-owned persistent preview scale
                    const isSlider=!!controls.sliders[b.source];
                    assert(h.byName[b.source]&&h.byName[b.source].listenerCount(isSlider?'changed':'action')>0,b.source+' listener');
                });
                if(sheet+1<initial.sheets)panel=detail.reducePanel(panel,'atlasSheet:'+(sheet+1),view);
            }
            for(const cmp of Object.values(h.ui.containers[baseId].components)){
                if(['button','slider','checkBox','dropDownMenu'].includes(cmp.type)&&!fwCommands.includes(cmp.name))
                    assert(nativeBackings.has(cmp.name),'Unreachable native control '+page+'/'+cmp.name);
            }
        });
        for(const name of Object.keys(controls.sliders)){
            for(const step of [0,1,controls.sliders[name][0]-1,controls.sliders[name][0]]){
                const page=Object.keys(detail.names).find(k=>{
                    const first=detail.model(k,{});
                    for(let n=0;n<first.sheets;n++){
                        if(detail.model(k,{atlasPanel:{sheet:n}}).buttons.some(b=>b.command==='atlasEdit:'+name))return true;
                    }
                    return false;
                });
                const baseline=detail.model(page,{});
                let sheet=0;
                for(let n=0;n<baseline.sheets;n++){
                    if(detail.model(page,{atlasPanel:{sheet:n}}).buttons.some(b=>b.command==='atlasEdit:'+name)){sheet=n;break;}
                }
                const profile={x:step*5,y:step*5,scalePct:75+step*5,brightnessPct:10+step*5,opacityPct:100-step*5};
                const state={cardLayout:{hud:profile},actions:base.actions};
                const phoneMaps={cluster:true,hud:true,available:true,width:30+5*step,offset:[0,0],centerScale:100};
                const rendered=detail.model(page,{state,phoneMaps,written:{['cell:'+name+':0:Value']:step},atlasPanel:{sheet,edit:name}});
                checkFrame(rendered);
                assert(rendered.buttons.some(b=>b.enabled&&b.command.startsWith('atlasValue:'+name+':')));
            }
        }
        h.setState(base);
        await h.enter(h.ui.containers[116].name);
        app._atlasAction('atlasSheet:1');
        app._atlasAction('atlasRegion:RU-MOS');
        assert.strictEqual(app._regionView().selected.region,'RU-MOS');
        app._atlasAction('atlasRegion:RU-AAA');
        assert.strictEqual(app._regionView().selected.region,'RU-MOS','An unavailable row cannot change the selection');
        await h.enter(h.ui.containers[104].name);
        const dashboard=()=>app._atlasStage.view;
        const selectedTab=()=>dashboard().buttons.filter(b=>b.kind==='diagTab' && b.selected).map(b=>b.label);
        assert.deepStrictEqual(dashboard().buttons.filter(b=>b.kind==='diagTab').map(b=>b.label),
            ['Сводка','GPS','Сервис','Камера','Вывод','База']);
        assert.deepStrictEqual(dashboard().diagnosticCards.map(r=>r[0]),['GPS','Сервис камер','Камера','Вывод','База']);
        assert(dashboard().buttons.some(b=>b.command==='cameraDiagFreeze' && b.enabled));
        app._atlasAction('atlasDiagnostic:service');
        assert.deepStrictEqual(selectedTab(),['Сервис']);
        assert(dashboard().diagnosticCards.some(r=>r[0]==='Версия сервиса' && r[1]===base.serviceVersion));
        app._atlasAction('atlasDiagnostic:2');
        assert.deepStrictEqual(selectedTab(),['Камера']);
        assert(dashboard().diagnosticCards.some(r=>r[0]==='Дистанция' && r[1]==='180 м'));
        app._atlasAction('atlasDiagnostic:3');
        assert.deepStrictEqual(selectedTab(),['Вывод']);
        assert(dashboard().diagnosticCards.some(r=>r[0]==='Проекция HUD' && r[1]==='Вкл.'));
        app._atlasAction('atlasDiagnostic:5');
        assert.deepStrictEqual(selectedTab(),['База']);
        assert(dashboard().diagnosticCards.some(r=>r[0]==='Записи базы' && r[1]==='—'));
        app._atlasAction('atlasDiagnostic:1');
        assert.deepStrictEqual(selectedTab(),['GPS']);
        const disconnected=detail.model('diagnostics',{state:null,written:{}});
        assert(disconnected.diagnosticCards.some(r=>r[0]==='Сервис камер' && r[1]==='Нет связи'));
        assert(disconnected.diagnosticCards.some(r=>r[0]==='Вывод' && r[1]==='HUD — · приборы —'));
        const liveReport=()=>detail.model('diagnostics',{state:base,written:app._written}).report;
        assert.strictEqual(liveReport().selected,1);assert(liveReport().title.indexOf('GPS')===0);
        const before=liveReport().lines.slice();
        app._atlasAction('atlasSheet:1');
        app._atlasAction('cameraDiagMore');
        assert.notDeepStrictEqual(liveReport().lines,before,'Read every native report block from the graphics');
        const updating=Object.assign({},base,{regionalDatabase:Object.assign({},base.regionalDatabase,{phase:'downloading'})});
        const choosing=require('../src/trip_view.js').regionsModel(updating,'RU-MOS',null);
        const pending=detail.model('regions',{state:updating,region:choosing});
        assert(pending.lead.includes('Московская')&&pending.side.includes('Калужская'),'The active download follows its starting region');
        const cam=()=>detail.model('cameraDetail',input);
        assert.strictEqual(cam().lens,'unknown','Traffic bearing alone is not a verified capture side');
        const sources=[['road',60,'Дорожный лимит'],['camera',40,'По базе камер'],['unknown',null,'Нет данных'],['conflict',null,'Расхождение 40 / 60']];
        for(const [scope,value,note] of sources){
            base.alert.displayLimit={scope,value,state:value===null?scope:'known',source:'Проверенный источник',values:[40,60]};
            const view=home.model(base,'0.12.0');
            assert.strictEqual(view.limit,value);assert.strictEqual(view.limitNote,note);
            if(scope==='conflict')assert(cam().rows.some(r=>r[1].includes('40 / 60')));
            if(scope==='camera'||scope==='road')assert(cam().rows.some(r=>r[1].includes('Проверенный источник')));
        }
        delete base.alert.displayLimit;
        base.alert.captureDirection='rear'; base.alert.captureDirectionVerified=true;
        assert.strictEqual(cam().lens,'rear');
        for(const side of ['front','both'])assert.strictEqual(detail.confirmedDirection({captureDirection:side,captureDirectionVerified:true}),side);
        assert.strictEqual(detail.confirmedDirection({captureClass:'front',capture:{verified:true,side:'unknown'}}),'unknown');
        base.alert.gpsHeld=true; assert.strictEqual(cam().rows[0][1],'—');
        base.alert.gpsHeld=false; assert.strictEqual(cam().rows[0][1],'180 м');
        assert.strictEqual(detail.model('cameraDetail',{state:null}).lens,'unknown');
        input.written=Object.assign({},input.written,{'enabled:tripRegionDownload':false,'visible:tripRegionRollback':false});
        const actions=detail.model('regions',input).buttons;
        assert.strictEqual(actions.find(b=>b.command==='tripRegionDownload').enabled,false);
        assert(!actions.some(b=>b.command==='tripRegionRollback'));
        const snapshot=diagnostic.capture(base,'0.11.0',1530000000000);
        const shotInput=Object.assign({},input,{snapshot,written:{}}),photo=detail.model('diagnosticPhoto',shotInput).photo;
        const captured=detail.model('diagnosticPhoto',shotInput).diagnosticCards;
        assert(captured.some(r=>r[0]==='Камера' && r[1].includes('180 м')));
        assert(captured.some(r=>r[0]==='Вывод' && r[1].includes('HUD Вкл.')));
        delete base.alert;base.outputs.hud=false;
        assert.deepStrictEqual(detail.model('diagnosticPhoto',shotInput).diagnosticCards,captured);
        assert.strictEqual(photo.length,8);assert(photo[7].includes('В спину'));assert.deepStrictEqual(detail.model('diagnosticPhoto',shotInput).photo,photo);
        console.log('PASS Atlas details: every ordinary RHMI action across 15 graphic pages, editor endpoints, both canvas layouts, four limit scopes, frozen diagnostics and verified camera side');
    } finally { h.close(); }
}
main().catch(err=>{console.error(err.stack);process.exitCode=1;});
