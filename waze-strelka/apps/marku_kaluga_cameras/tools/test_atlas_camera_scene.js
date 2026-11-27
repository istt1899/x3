// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert=require('assert');
const harness=require('./ui_harness.js');

async function main(){
    const h=harness.create(), app=h.app, stage=app._atlasStage;
    const action=name=>app._atlasAction(name);
    const hud={scalePct:80,brightnessPct:80,opacityPct:100,x:500,y:700};
    const state={enabled:true,outputs:{hud:true,cluster:true},cardLayout:{hud,map:Object.assign({},hud,{scalePct:105})},
        capabilities:{layoutPreview:true},actions:{cardLayout:{allowed:true}},gpsFix:{headingDeg:0},
        alert:{id:'test',type:'speed',roadConfirmed:true,limitKmh:40,distanceM:120,captureDirectionVerified:true,captureDirection:'front'}};
    try{
        await app._setupRhmi();
        h.setState(state);
        await h.enter(h.ui.containers[113].name);
        assert(h.byName.atlasKey13_6.visible);
        assert.strictEqual(app._atlasKeys.atlasKey13_6.command,'atlasCameraOpen');
        await action('atlasCameraOpen');
        assert.strictEqual(stage.view.cameraOutput,'all');
        assert.strictEqual(stage.view.buttons[0].enabled,false);
        await action('atlasPreviewStart');
        const start=h.commands.find(c=>c.cmd==='layout-preview-start');
        assert(start&&start.session);
        state.layoutPreview={session:start.session,revision:0,scalePct:null,alert:state.alert,
            cards:{hud:'abc',map:'def'},profiles:state.cardLayout};
        h.setState(state);
        assert.deepStrictEqual(stage.view.previewCards,state.layoutPreview.cards);
        assert.strictEqual(stage.view.buttons[0].enabled,true);
        await action('atlasValue:cameraCardScale:10');
        assert.strictEqual(stage.view.sample.centralScale,125);
        assert.strictEqual(stage.view.previewOverride,125);
        await action('atlasPreviewSave');
        const edit=h.commands.find(c=>c.cmd==='layout-preview');
        const save=h.commands.find(c=>c.cmd==='layout-preview-save');
        assert.deepStrictEqual([edit.session,edit.revision,edit.scalePct],[start.session,1,125]);
        assert.deepStrictEqual([save.session,save.revision],[start.session,1]);
        delete state.layoutPreview;
        state.commandResult={requestId:save.requestId,phase:'finished'};
        state.centerCameraScalePct=125;
        h.setState(state);
        assert.strictEqual(stage.view.feedback,'Размер уведомлений сохранён');
        await action('atlasCameraClose');
        assert.strictEqual(stage.page,'trip');
        assert.strictEqual(stage.view.centralScale,125);
        await action('tripCamera');
        await action('atlasCameraOpen');
        await h.back();
        assert.strictEqual(stage.page,'cameraDetail');
        assert(!stage.view.cameraOutput);
        await action('atlasCameraOpen');
        state.actions.cardLayout={allowed:false,reason:'На стоянке'};
        h.setState(state);
        const count=h.commands.length;
        await action('atlasPreviewStart');
        assert.strictEqual(h.commands.length,count);
        await action('atlasCameraClose');
        assert.strictEqual(stage.page,'cameraDetail');
        assert(!stage.view.cameraOutput);
        console.log('PASS Atlas editor RHMI entry, shared draft, ordered save, back and stationary gate');
    }finally{
        app._stopAtlasPreview(true);
        h.close();
    }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
