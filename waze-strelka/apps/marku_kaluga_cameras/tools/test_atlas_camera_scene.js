// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert=require('assert');
const fs=require('fs'),os=require('os'),path=require('path');
const harness=require('./ui_harness.js');
const CenterScale=require('../src/atlas-center-scale.js');

async function main(){
    const h=harness.create(), app=h.app;
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-center-scale-'));
    app._atlasScale=new CenterScale(directory);
    const stage=app._atlasStage, action=name=>app._atlasAction(name);
    const hud={scalePct:80,brightnessPct:80,opacityPct:100,x:500,y:700};
    const state={enabled:true,outputs:{hud:true,cluster:true},cardLayout:{hud,map:Object.assign({},hud,{scalePct:105})},
        actions:{cardLayout:{allowed:true}},gpsFix:{headingDeg:0},alert:{id:'test',type:'speed',roadConfirmed:true,
            limitKmh:40,distanceM:120,captureDirectionVerified:true,captureDirection:'front'}};
    try{
        await app._setupRhmi();
        h.setState(state);
        await h.enter(h.ui.containers[113].name);
        assert(h.byName.atlasKey13_6.visible);
        assert.strictEqual(app._atlasKeys.atlasKey13_6.command,'atlasCameraOpen');
        await action('atlasCameraOpen');
        assert.strictEqual(stage.view.cameraOutput,'center');
        await action('atlasValue:atlasCenterCameraScale:12');
        assert.strictEqual(stage.view.ride.centralScale,125);
        await action('atlasCameraOutput:hud');
        assert.strictEqual(stage.view.buttons.find(b=>b.kind==='slider').value,'80 %');
        await action('atlasValue:cameraCardScale:2');
        assert(h.commands.some(c=>c.cmd==='card-layout'&&c.target==='hud'&&c.scalePct===85));
        h.reset();
        await action('atlasCameraOutput:map');
        assert.strictEqual(stage.view.buttons.find(b=>b.kind==='slider').value,'105 %');
        await action('atlasValue:cameraCardScale:7');
        assert(h.commands.some(c=>c.cmd==='card-layout'&&c.target==='map'&&c.scalePct===110));
        await action('atlasCameraClose');
        assert.strictEqual(stage.page,'trip');
        assert.strictEqual(stage.view.centralScale,125);
        await action('tripCamera');
        await action('atlasCameraOpen');
        await h.back();
        assert.strictEqual(stage.page,'cameraDetail');
        assert(!stage.view.cameraOutput);
        await action('atlasCameraOpen');
        await action('atlasCameraOutput:map');
        state.actions.cardLayout={allowed:false,reason:'На стоянке'};
        h.setState(state);
        assert.strictEqual(stage.view.buttons.find(b=>b.kind==='slider').enabled,false);
        const count=h.commands.length;
        await action('atlasValue:cameraCardScale:8');
        assert.strictEqual(h.commands.length,count);
        await action('atlasCameraOutput:center');
        await action('atlasCameraClose');
        assert.strictEqual(stage.page,'cameraDetail');
        assert(!stage.view.cameraOutput);
        const restored=new CenterScale(directory);
        assert.strictEqual(restored.get('atlasCenterCameraScale'),125);
        assert.strictEqual(restored.get('atlasCenterMapScale'),100);
        restored.set('atlasCenterMapScale',0);
        assert.strictEqual(new CenterScale(directory).get('atlasCenterCameraScale'),125);
        console.log('PASS Atlas camera editor: trip and detail entry, RHMI fallback, Back, independent HUD/cluster commands, guards and persistent center scale');
    }finally{
        h.close();
        fs.rmSync(directory,{recursive:true,force:true});
    }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
