// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert');
const detail = require('../src/atlas-detail.js');
const harness = require('./ui_harness.js');
const diagnostic = require('../src/diagnostics_view.js');

function stage() {
    const words=[];
    const cv={textWidth:s=>s.length*10,fillRect:()=>{},line:()=>{},roundRect:()=>{},circle:()=>{},
        text(s,x,y,size){assert(Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(size));words.push(s);}};
    return {cv,words};
}
function overlaps(a,b) {
    return Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x) && Math.min(a.y+a.h,b.y+b.h)>Math.max(a.y,b.y);
}
async function main() {
    const h=harness.create(), app=h.app;
    try {
        await app._setupRhmi();
        const base={enabled:true,outputs:{hud:true,cluster:true},alert:{id:'t1',roadConfirmed:true,
            limitKmh:40,distanceM:180,captureClass:'rear'},serviceVersion:'0.11.0'};
        base.regionalDatabase={selectedRegion:'RU-KLU',phase:'listed',regions:[{region:'RU-KLU'},{region:'RU-MOS'}]};
        const input={state:base,version:'0.11.0',serviceReady:true,written:app._written};
        Object.keys(detail.names).forEach(page=>{
            const id=String(detail.pageIds[page]), tree=h.ui.containers[id];
            const image=Object.values(tree.components).find(c=>c.name===detail.names[page]);
            assert(image && image.type==='label' && image.properties.Focusable.value===0 && image.properties.Visible.value===0,page);
            const v=detail.model(page,input),graphics=stage();
            detail.drawDetail(graphics.cv,page,v);
            assert(graphics.words.includes(v.title));
            v.buttons.forEach((b,i)=>{
                if(b.command.indexOf('atlasRegion:')===0){
                    assert.strictEqual(page,'regions');
                    assert(base.regionalDatabase.regions.some(entry=>b.command==='atlasRegion:'+entry.region));
                    assert(h.byName.tripRegionSelector.listenerCount('action')>0);
                }else if(b.command.indexOf('atlasDiagnostic:')===0){
                    assert.strictEqual(page,'diagnostics');
                    assert.strictEqual(diagnostic.PAGE_TITLES[Number(b.command.slice('atlasDiagnostic:'.length))],b.label);
                    assert(h.byName.cameraDiagSelector.listenerCount('action')>0);
                }else{
                    const cmp=Object.keys(tree.components).find(key=>tree.components[key].name===b.command);
                    assert(cmp && app._actionById[Number(cmp)],'No bound native command: '+b.command);
                }
                assert(b.x>=0&&b.x+b.w<=1600&&b.y>=0&&b.y+b.h<=520);
                assert(!v.buttons.slice(i+1).some(c=>overlaps(b,c)),page+' hit regions overlap');
            });
        });
        h.setState(base);
        await h.enter(h.ui.containers['16'].name);
        app._atlasAction('atlasRegion:RU-MOS');
        assert.strictEqual(app._regionView().selected.region,'RU-MOS');
        app._atlasAction('atlasRegion:RU-AAA');
        assert.strictEqual(app._regionView().selected.region,'RU-MOS','An unavailable row cannot change the selection');
        await h.enter(h.ui.containers['4'].name);
        app._atlasAction('atlasDiagnostic:1');
        const liveReport=()=>detail.model('diagnostics',{state:base,written:app._written}).report;
        assert.strictEqual(liveReport().selected,1);assert(liveReport().title.indexOf('GPS')===0);
        const before=liveReport().lines.slice();
        app._atlasAction('cameraDiagMore');
        assert.notDeepStrictEqual(liveReport().lines,before,'Read every native report block from the graphics');
        const updating=Object.assign({},base,{regionalDatabase:Object.assign({},base.regionalDatabase,{phase:'downloading'})});
        const choosing=require('../src/trip_view.js').regionsModel(updating,'RU-MOS',null);
        const pending=detail.model('regions',{state:updating,region:choosing});
        assert(pending.lead.includes('Московская')&&pending.side.includes('Калужская'),'The active download follows its starting region');
        const cam=()=>detail.model('cameraDetail',input);
        assert.strictEqual(cam().lens,'unknown','Traffic bearing alone is not a verified capture side');
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
        delete base.alert;base.outputs.hud=false;
        assert.strictEqual(photo.length,8);assert(photo[7].includes('В спину'));assert.deepStrictEqual(detail.model('diagnosticPhoto',shotInput).photo,photo);
        console.log('PASS Atlas details: 14 actual RHMI pages, native command bindings, geometry, frozen report and verified camera side');
    } finally { h.close(); }
}
main().catch(err=>{console.error(err.stack);process.exitCode=1;});
