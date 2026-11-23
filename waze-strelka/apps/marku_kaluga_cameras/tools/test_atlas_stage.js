// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const atlas = require('../src/atlas-home.js');
const {Stage, targets, width, height} = require('../src/atlas-stage.js');
const {create} = require('./ui_harness.js');

class Display extends EventEmitter {
    static available() { return true; }
    constructor() {
        super();
        this.screen = {w:1920,h:720};
        this.info = {touch:true,controller:true,frontGate:true};
        this.native = this.touch = true;
        this.frames = 0;
    }
    connect() { this.ready = true; this.emit('ready'); }
    place(rect) { this.rect = rect; }
    show(on) { this.visible = on; }
    claim(rects) { this.rects = rects; }
    grab(on) { this.grabbing = on; }
    frame(recorder) { assert(recorder.words().length > 50); this.frames++; }
    front(on) { this.onScreen = on; this.emit('state',{front:on,onScreen:on}); }
    knob(counter,button,tilt) {
        this.emit('ccu',{frontRotaryEncoderOperation:counter,frontRotaryEncoderPushButton:button,frontRotaryEncoderDeflection:tilt||0});
    }
    tap(item) { this.emit('touch',1,item.x+8,item.y+8); this.emit('touch',3,item.x+8,item.y+8); }
    close() { this.ready = false; }
}

const HOME='ST_OnlineApps_StrelkaTrip';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function slot(h,command) {
    const app=h.app, prefix='atlasKey'+app._atlasSurface+'_';
    const key=Object.keys(app._atlasKeys).find(name=>name.startsWith(prefix)&&app._atlasKeys[name]&&app._atlasKeys[name].command===command);
    assert(key,'missing '+command+' on '+app._shownPage);
    return h.byName[key];
}
function press(h,command) {
    const component=slot(h,command);
    assert(component.visible && component.enabled,command+' should accept input');
    delete h.app._lastPress[component.desc.name];
    delete h.app._lastPress[command];
    component.press();
    return component;
}
async function graphics() {
    const h=create(), app=h.app;
    app._atlasStage.driver=Display;
    try {
        await app._setupRhmi();
        await h.enter(HOME);
        const stage=app._atlasStage, display=stage.gpu, menu=atlas.menuTargets();
        assert.deepStrictEqual(display.rect,{x:124,y:82,w:width,h:height,scale:1,ox:0,oy:0});
        assert.deepStrictEqual(display.rects,[{x:0,y:0,w:width,h:height}]);
        assert(!display.grabbing);
        display.tap(menu[1]);
        assert.strictEqual(h.current(),HOME,'background touch discarded');
        display.front(true);
        assert.strictEqual(slot(h,'tripCamera').visible,false);
        slot(h,'tripCamera').press();
        assert.strictEqual(h.current(),HOME,'native duplicate events behind overlay are ignored');
        display.knob(65535,0);
        display.knob(0,0);
        assert.strictEqual(stage.focus.trip,'tripMaps','16-bit rotation wraps');
        display.knob(0,1);
        assert.strictEqual(h.current(),'ST_OnlineApps_WazeCluster');
        assert(display.grabbing && stage.front,'page switching retains the last compositor confirmation');
        assert(targets('main',stage.view).every(item=>item.command!=='atlasNative'));
        display.tap({x:0,y:0});
        assert.strictEqual(h.current(),'ST_OnlineApps_WazeCluster','blank space consumes the touch');
        const back=targets('main',stage.view).find(item=>item.command==='atlasBack');
        display.tap(back);
        assert.strictEqual(h.current(),HOME);
        display.front(true);
        display.emit('touch',1,menu[0].x+9,menu[0].y+9);
        display.emit('touch',3,menu[4].x+9,menu[4].y+9);
        assert.strictEqual(h.current(),HOME,'cross-row drag cancels');
        display.tap(menu[0]);
        assert.strictEqual(h.current(),'ST_OnlineApps_StrelkaCamera');
        await h.back();
        display.front(true);
        const before=display.frames;
        display.waiting=true;stage.present();stage.present();
        assert.strictEqual(display.frames,before);
        display.waiting=false;display.emit('tick');
        assert.strictEqual(display.frames,before+1,'congested updates coalesce');
        display.front(false);
        display.knob(0,0);display.knob(2,1);
        assert.strictEqual(h.current(),HOME);
        assert(slot(h,'tripCamera').visible);
        press(h,'tripCamera');
        assert.strictEqual(h.current(),'ST_OnlineApps_StrelkaCamera');
        app._setVisible(false);
        assert.strictEqual(display.visible,false);
        assert.strictEqual(stage.page,null);
        await h.enter(HOME);
        display.screen.w=1440;
        assert.strictEqual(stage.owns(),false,'unmeasured surface uses native controls');
        display.screen.w=1920;display.info.controller=false;
        assert.strictEqual(stage.owns(),false);
    } finally {app._atlasStage.close();h.close();}
}
async function native(order) {
    const h=create(),app=h.app;
    app._atlasStage.driver={available:()=>false};
    try {
        await app._setupRhmi();
        await h.enter(HOME,order);
        for(const id of Object.keys(h.ui.containers).filter(id=>Number(id)>=100)){
            const state=h.ui.containers[id];
            const components=Object.values(state.components);
            assert(components.length && components.every(c=>/^atlas(Title|Status|Frame|Key)/.test(c.name)),state.name);
            assert.strictEqual(components.filter(c=>/^atlasFrame/.test(c.name)).length,1,state.name);
        }
        const currentFrame=app._atlasSurface;
        h.rhmi.openEntryState=()=>Promise.resolve(); // active tile: no repeated HMI visible signal
        await app._onEntryPointExecute('native-tile');
        assert.strictEqual(app._atlasSurface,currentFrame);
        assert.strictEqual(h.byName.atlasStatus13.visible,true,'status is visible before a PNG arrives');
        const cam=press(h,'tripCamera');
        h.rhmi.emit('userEvent',{eventType:'ACTION',sourceId:cam.id});
        assert.strictEqual(h.current(),'ST_OnlineApps_StrelkaCamera');
        press(h,'tripCameraDiagnostics');
        assert.strictEqual(app._shownPage,'diagnostics');
        await h.back();
        assert.strictEqual(h.current(),'ST_OnlineApps_StrelkaCamera','hardware Back retains the actual caller');
        await h.back();
        assert.strictEqual(h.current(),HOME);
        const state={enabled:true,capabilities:{alertPreferences:true,overspeedPreferences:true},
            overspeedPreferences:Object.assign({},require('../src/view_model').OVERSPEED_RECOMMENDED,{soundDistanceM:400})};
        h.setState(state);
        await app._openCameraPage('overspeed');
        press(h,'atlasEdit:cameraSoundDistance');
        assert(h.current().endsWith('_AtlasEditor'));
        assert.strictEqual(app._atlasStage.view.edit.value,'400 м');
        const button=press(h,'atlasValue:cameraSoundDistance:0');
        h.rhmi.emit('userEvent',{eventType:'ACTION',sourceId:button.id});
        assert.strictEqual(h.commands.filter(command=>command.cmd==='overspeed-preferences').length,1);
        assert.strictEqual(h.commands[h.commands.length-1].soundDistanceM,100);
        h.reset();
        h.setState(Object.assign({},state,{overspeedPreferences:Object.assign({},state.overspeedPreferences,{soundDistanceM:100})}));
        await tick();
        const last=press(h,'atlasValue:cameraSoundDistance:12');
        assert(last.visible);
        assert.strictEqual(h.commands[h.commands.length-1].soundDistanceM,700);
        await h.back();
        assert.strictEqual(app._atlasStage.view.edit,null);
        assert.strictEqual(h.current(),'ST_OnlineApps_CameraOverspeed');
        assert(slot(h,'atlasEdit:cameraSoundDistance').visible);
        await h.back();
        assert.strictEqual(h.current(),HOME);
    } finally {app._atlasStage.close();h.close();}
}
async function run() {
    await graphics();
    await native('hide-first');
    await native('show-first');
    const view=atlas.model({enabled:true,atlasMap:{origin:{lat:54,lon:36},camera:{lat:54.001,lon:36.001},
        roads:[{points:[[54,36],[54.001,36.001]],current:true},{points:[[54,36],['bad',36]]}]}});
    assert.strictEqual(view.roads.length,1);
    assert.strictEqual(view.side,'unknown');
    assert.strictEqual(atlas.model({enabled:true}).roads.length,0);
    assert.strictEqual(atlas.model({enabled:true,atlasMap:{origin:{lat:190,lon:36}}}).origin,null);
    console.log('PASS Atlas standard entry, native/RHMI graphics, rotary and touch isolation, caller/editor Back and 100–700 m settings');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
