// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert=require('assert');
const detail=require('../src/atlas-detail.js');
const stage=require('../src/atlas-stage.js');
const composition=require('../src/atlas-card-composition.js');
const manifest=require('../mgu-app.json');
const {Canvas}=require('../'+manifest.tree+'/javascript/atlas-kit/canvas.js');
const {defaultLayouts}=require('../../../native/marku-kaluga-cameras/files/card-layout.js');
const harness=require('./ui_harness.js');

const allowed={allowed:true,code:'READY',reason:'Остановка подтверждена'};
function service() {
    const fields=()=>composition.OPTIONS.reduce((o,v)=>{o[v.key]=true;return o;},{});
    return {serviceVersion:'test',outputs:{hud:true,cluster:true},cardLayout:defaultLayouts(),
        capabilities:{outputs:true,cardComposition:true},
        cardComposition:{hud:fields(),map:fields()},
        actions:{cardLayout:allowed,displayTest:allowed,displayTestStop:allowed},
        displayTest:{active:false},storage:{persistent:true,settingsSaved:false}};
}
function frame(v,focus,summary) {
    const cv=new Canvas(1600,summary?240:520), text=[];
    const raw=cv.text.bind(cv);
    cv.text=function(s,x,y){text.push(s);assert(y>=0&&y<=cv.h,s);return raw.apply(cv,arguments);};
    stage.scene(cv,v.page,v,focus,!summary);
    return {cv,text:text.join(' ')};
}
function checkModel() {
    const state=service();
    const profile=(target='hud',panel={},extra={})=>detail.model('calibration',Object.assign({state,target,atlasPanel:panel},extra));
    const key=(v,command)=>v.buttons.find(b=>b.command===command);
    const expected=[
        ['cameraCardX',200,'0 %','100 %'],['cameraCardY',200,'0 %','100 %'],
        ['cameraCardScale',15,'75 %','150 %'],['cameraCardBrightness',18,'10 %','100 %'],
        ['cameraCardTransparency',18,'0 %','90 %']
    ];
    for (const target of ['hud','map']) {
        const v=profile(target);
        assert(v.title.includes(target==='hud'?'HUD':'приборах'));
        assert.deepStrictEqual(v.buttons.filter(b=>b.kind==='slider').map(b=>b.source),expected.map(item=>item[0]));
        assert(key(v,'cameraTestStart').enabled);assert(key(v,'cameraCardSave').enabled);
        const before=frame(v).cv.d;
        for (const [name,max,minText,maxText] of expected) {
            const b=key(v,'atlasEdit:'+name), left='atlasValue:'+name+':';
            assert(b.enabled);assert.strictEqual(b.max,max);
            for(const step of [0,1,Math.floor(max/2),max-1,max]){
                assert.strictEqual(detail.sliderCommand(b,b.track.x+b.track.w*step/max),left+step);
            }
            assert.strictEqual(detail.sliderCommand(b,-1000),left+'0');
            assert.strictEqual(detail.sliderCommand(b,99999),left+max);
            assert.strictEqual(detail.sliderCommand(b,NaN),null);
            const step=b.step===max ? -1 : 1;
            assert.strictEqual(detail.sliderNudge(b,step),left+(b.step+step));
            assert.strictEqual(detail.sliderNudge(b,3*step),left+Math.max(0,Math.min(max,b.step+3*step)));
            assert.strictEqual(detail.sliderNudge(Object.assign({},b,{step:max}),1),null);
            assert.strictEqual(detail.sliderNudge(Object.assign({},b,{step:0}),-1),null);
            const edited=profile(target,detail.reducePanel({},b.command,v));
            assert.strictEqual(edited.buttons[0].command,'atlasSlider:'+name);
            assert.strictEqual(edited.buttons[0].step,b.step);
            assert.deepStrictEqual(detail.reducePanel({sheet:0,edit:name},edited.buttons[0].command,edited),{sheet:0,edit:null});
            const editorText=frame(edited,edited.buttons[0].command).text;
            assert(editorText.includes(minText));assert(editorText.includes(maxText));
            const drag=Object.assign({},v,{sliderPreview:{source:name,step:b.step===0?max:0}});
            const after=frame(drag).cv.d;
            // Left-hand output diagram must change independently of the right-hand thumb.
            let changed=0;
            for(let y=139;y<247;y++)for(let x=348;x<780;x++){
                const i=(1600*y+x)*4;if(before[i]!==after[i])changed++;
            }
            assert(changed>15,'No live diagram change for '+name+' on '+target);
            assert.strictEqual(profile(target).buttons.find(t=>t.source===name).step,b.step);
        }
        const choice=profile(target,{sheet:2});
        assert.deepStrictEqual(choice.buttons.filter(b=>b.kind==='toggle').map(b=>b.key),composition.OPTIONS.map(o=>o.key));
        for(const b of choice.buttons.filter(b=>b.kind==='toggle')){
            const rendered=frame(choice,b.command).text;
            assert(rendered.includes(b.label));
            assert(rendered.includes(b.description.slice(0,b.description.indexOf(' '))));
        }
    }
    state.cardLayout.hud.x=503;
    assert.strictEqual(key(profile(),'atlasEdit:cameraCardX').value,'50,3 %','An imported position keeps its confirmed precision');
    const offline=detail.model('calibration',{state:null,written:{cameraCardStatus:'Старое подтверждение',cameraCardStorage:'Старый профиль'}});
    assert(!frame(offline).text.includes('Стар'));
    state.outputs.hud=false;
    assert(!key(profile(),'cameraTestStart').enabled);
    assert(frame(profile()).text.includes('Проекция HUD выключена'));
    assert(key(profile('map'),'cameraTestStart').enabled);
    for(const code of ['STATIONARY_UNKNOWN','MOTION_CONFLICT','MOVING']){
        const reason='Ограничение '+code;
        state.actions.displayTest=state.actions.cardLayout={allowed:false,code,reason};
        const blocked=profile();
        assert(!key(blocked,'cameraTestStart').enabled);
        assert(!key(blocked,'atlasEdit:cameraCardX').enabled);
        assert(frame(blocked).text.includes(reason));assert(frame(blocked,null,true).text.includes(reason));
        assert.strictEqual(detail.sliderNudge(key(blocked,'atlasEdit:cameraCardX'),1),null);
        assert.strictEqual(detail.reducePanel({},'atlasEdit:cameraCardX',blocked),null);
        assert(profile('map',{sheet:2}).buttons.filter(b=>b.kind==='toggle').every(b=>!b.enabled));
    }
    state.displayTest={active:true,target:'hud'};
    assert.strictEqual(key(profile(),'cameraTestStart').label,'Скрыть тест');
    assert(key(profile(),'cameraTestStart').enabled,'Active test can stop while driving');
    delete state.cardLayout.hud;assert.strictEqual(key(profile(),'atlasEdit:cameraCardX').value,'—');
    delete state.capabilities.cardComposition;
    assert(profile('hud',{sheet:2}).buttons.filter(b=>b.kind==='toggle').every(b=>b.selected===null&&!b.enabled));
    const about=detail.model('about',{state});
    assert(key(about,'atlasCompositionOpen:hud')&&key(about,'atlasCompositionOpen:map'));
    state.commandResult={command:'display-test-stop',phase:'finished'};
    assert(detail.model('cameras',{state}).rows.some(r=>r[1]==='Сохранение не подтверждено'));
    state.storage.settingsSaved=true;
    assert(detail.model('cameras',{state}).rows.some(r=>r[1]==='Сохранён в автомобиле'));
}
async function checkDispatch() {
    const state=service(), h=harness.create(), app=h.app;
    try {
        await app._setupRhmi();
        h.setState(state);
        await h.enter(h.ui.containers[103].name);
        app._atlasAction('cameraMapSetup');
        await new Promise(resolve=>setImmediate(resolve));
        const before=h.commands.length;
        app._atlasAction('atlasValue:cameraCardX:177');
        app._atlasAction('atlasValue:cameraCardY:1');
        app._atlasAction('atlasValue:cameraCardScale:15');
        app._atlasAction('atlasValue:cameraCardBrightness:0');
        app._atlasAction('atlasValue:cameraCardTransparency:18');
        const changes=h.commands.slice(before).filter(msg=>msg.cmd==='card-layout');
        assert.deepStrictEqual(changes.map(msg=>msg.target),['map','map','map','map','map']);
        assert.deepStrictEqual(changes.map((m,i)=>m[['x','y','scalePct','brightnessPct','opacityPct'][i]]),[885,5,150,10,10]);
        const prior=h.commands.length;
        app._atlasAction('atlasValue:cameraCardScale:16');
        app._atlasAction('atlasValue:cameraCardScale:1.5');
        app._atlasAction('atlasValue:cameraWarningDistance:1');
        assert.strictEqual(h.commands.length,prior);
        app._atlasAction('cameraCardSave');
        assert.strictEqual(h.commands[h.commands.length-1].cmd,'display-test-stop');
        assert.strictEqual(h.commands[h.commands.length-1].target,'map');
    } finally {h.close();}
}
checkModel();
checkDispatch().then(()=>console.log('PASS calibration: HUD and cluster sliders, absolute and relative values, live diagram, composition, guards, persistence and native commands')).catch(err=>{console.error(err.stack);process.exitCode=1;});
