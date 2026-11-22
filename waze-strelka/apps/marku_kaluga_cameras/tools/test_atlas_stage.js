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

async function run() {
    const h = create(), app = h.app;
    app._atlasStage.driver = Display;
    try {
        await app._setupRhmi();
        await h.enter('ST_OnlineApps_StrelkaTrip');
        const stage=app._atlasStage, display=stage.gpu, menu=atlas.menuTargets();
        assert.deepStrictEqual(display.rect,{x:124,y:82,w:width,h:height,scale:1,ox:0,oy:0});
        assert.strictEqual(display.rects.length,6);
        assert(!display.grabbing);
        display.tap(menu[1]);
        assert.strictEqual(h.current(),'ST_OnlineApps_StrelkaTrip','background touch discarded');
        display.front(true);
        display.knob(65535,0);
        display.knob(0,0);
        assert.strictEqual(stage.focus.trip,'tripMaps','16-bit rotation wraps');
        display.knob(0,1);
        assert.strictEqual(h.current(),'ST_OnlineApps_WazeCluster');
        display.front(true);
        const reveal = targets('main',stage.view).filter(t=>t.command==='atlasNative')[0];
        display.tap(reveal);
        assert.strictEqual(stage.nativePage,'main');
        assert.strictEqual(display.visible,false);
        assert.strictEqual(display.grabbing,false);
        assert.deepStrictEqual(display.rects,[]);
        await h.back();
        assert.strictEqual(stage.page,'trip');
        display.front(true);
        display.emit('touch',1,menu[0].x+9,menu[0].y+9);
        display.emit('touch',3,menu[4].x+9,menu[4].y+9);
        assert.strictEqual(h.current(),'ST_OnlineApps_StrelkaTrip','cross-row drag cancels');
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
        assert.strictEqual(h.current(),'ST_OnlineApps_StrelkaTrip');
        app._setVisible(false);
        assert.strictEqual(display.visible,false);
        assert.strictEqual(stage.page,null);
        await h.enter('ST_OnlineApps_StrelkaTrip');
        display.front(true);
        h.byName.atlasMenuOpen.press();
        assert.strictEqual(h.current(),'ST_OnlineApps_AtlasMenu');
        assert.strictEqual(display.visible,false,'native sections sheet owns input');
        const page=h.ui.containers['17'];
        assert.strictEqual(Object.values(page.components).filter(c=>c.type==='button').length,6);
        assert(h.byName.atlasMenuMaps.press());
        assert.strictEqual(h.current(),'ST_OnlineApps_WazeCluster');
        await h.back();
        await h.enter('ST_OnlineApps_AtlasMenu');
        assert(h.byName.atlasMenuCamera.press());
        assert.strictEqual(h.current(),'ST_OnlineApps_StrelkaCamera');
        await h.back();
        const state={enabled:true,atlasMap:{origin:{lat:54,lon:36},camera:{lat:54.001,lon:36.001},
            roads:[{points:[[54,36],[54.001,36.001]],current:true},{points:[[54,36],['bad',36]]}]}};
        const view=atlas.model(state);
        assert.strictEqual(view.roads.length,1);
        assert.strictEqual(view.side,'unknown');
        assert.strictEqual(atlas.model({enabled:true}).roads.length,0);
        assert.strictEqual(atlas.model({enabled:true,atlasMap:{origin:{lat:190,lon:36}}}).origin,null);
        display.screen.w=1440;
        assert.strictEqual(stage.owns(),false,'unmeasured surface uses the RHMI resource');
        display.screen.w=1920; display.info.controller=false;
        assert.strictEqual(stage.owns(),false,'native input remains accessible without controller support');
        console.log('PASS Atlas native entry, geographic evidence, touch, wrapped rotary, overlay, fallback sections, back and frame coalescing');
    } finally {
        app._atlasStage.close();
        h.close();
    }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
