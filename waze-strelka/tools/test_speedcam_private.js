'use strict';
// Synthetic source records exercise the public software without redistributing private data.
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const emitter=require('events'),files='../native/marku-kaluga-cameras/files/';
const layer=require(files+'speedcam-private'),guidance=require(files+'vehicle-guidance'),cards=require(files+'alert-card');
const point={lat:55,lon:37},target='official:fixture';
const id=n=>'sco:'+('00000000000000000000'+n.toString(16)).slice(-20);
function row(n,course,limit,linked){return [id(n),point.lat,point.lon,course,limit,linked,6];}
function payload(records){return {schema:1,source:'speedcamonline',version:'2026.11.1',directionMeaning:'vehicle-course',records};}
const rows=[row(1,0,40,target),row(2,180,40,target),row(3,90,60,target),row(4,270,60,target)];
const single=row(5,90,70,null); single[2]+=0.02;
const publicRecord={id:target,type:'camera',position:point,provenance:'fixture'};
const base={zones:[],records:[publicRecord]},stamp=new Date('2026-11-22T09:00:00Z').getTime();
const pack=payload(rows.concat([single])),packed=layer.decode(pack),merged=layer.merge(base,packed);
assert.deepStrictEqual(merged.speedcamOnline,{phase:'active',sourceDate:'2026-11-01',added:1,enriched:1,approaches:5});
assert.strictEqual(merged.records.length,2);assert.deepStrictEqual(base.records,[publicRecord]);assert(!publicRecord.speedcamApproaches);
function fix(p,heading,metres,lateral=0,speed=25,time=stamp){
    const rad=heading*Math.PI/180,dx=-metres*Math.sin(rad)+lateral*Math.cos(rad),dy=-metres*Math.cos(rad)-lateral*Math.sin(rad);
    return {lat:p.lat+dy/111320,lon:p.lon+dx/(111320*Math.cos(p.lat*Math.PI/180)),timeMs:time,headingDeg:heading,accuracyM:5,speedKmh:speed};
}
function run(g,f){return g.evaluate(f,f.timeMs,true);}
for (const r of rows){
    const g=guidance.createGuidance(merged),a=run(g,fix(point,r[3],70));
    assert.strictEqual(a.id,target);assert.strictEqual(a.speedcamApproach.limitKmh,r[4]);
    const model=cards.presentation(Object.assign({},a,{speedKmh:104,overspeed:true}));
    assert.strictEqual(model.limit,r[4]);assert.strictEqual(model.limitScope,'speedcam');assert.strictEqual(model.overspeed,false);
    assert.strictEqual(cards.presentation(Object.assign({},a,{gpsHeld:true})).limit,null);
    const stopped=run(g,fix(point,r[3],70,0,0,stamp+1000));
    assert.strictEqual(stopped.speedcamApproach.id,r[0]);
}
const standalone=merged.records[1].position;
for (const [direction,lateral] of [[270,0],[0,0],[90,22]]) {
    assert.strictEqual(run(guidance.createGuidance(merged),fix(standalone,direction,5,lateral)),null);
}
const good=run(guidance.createGuidance(merged),fix(standalone,90,100));
assert.strictEqual(good.id,id(5));assert.strictEqual(good.speedcamApproach.limitKmh,70);assert.strictEqual(good.speedcamApproach.typeCode,6);
const preferences=require(files+'alert-preferences');
assert.strictEqual(preferences.matches(merged.records[1],{cameraTypes:{other:false,speed:true}}),false);
assert.strictEqual(preferences.matches(merged.records[1],{cameraTypes:{other:true,speed:false}}),true);

assert.strictEqual(cards.presentation(Object.assign({},good,{roadConfirmed:true,limitKmh:50})).limit,50);
assert.strictEqual(layer.applicable({limitKmh:40},{limitReference:{state:'known',valueKmh:60}}),null);
assert.strictEqual(layer.applicable({limitKmh:40},{cameraLimitConditional:'school hours'}),null);
const uncertain=rows.concat([row(6,4,30,target)]);
const conflict=layer.merge(base,layer.decode(payload(uncertain)));
assert(!run(guidance.createGuidance(conflict),fix(point,0,50)).speedcamApproach);
const newer={records:[Object.assign({},publicRecord,{id:'unrelated'}),{id:'another',position:standalone}],zones:[]};
assert.deepStrictEqual(layer.merge(newer,packed).records,newer.records,'New public neighbours block isolated additions and orphan links');
assert.throws(()=>layer.decode(payload(rows.concat([rows[0]]))),/SPEEDCAM_ROW/);
for(const cell of [[1,85],[2,200],[3,360],[4,-1],[5,{}],[6,11]]){
    const bad=row(9,0,40,target);bad[cell[0]]=cell[1];assert.throws(()=>layer.decode(payload([bad])),/SPEEDCAM_ROW/);
}
async function daemon(){
    const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'speedcam-private-')),file=path.join(tmp,'speedcam-private.json');
    const fallback=path.join(tmp,'pack.json'),empty=path.join(tmp,'missing');
    fs.writeFileSync(fallback,JSON.stringify(pack));
    assert.strictEqual(layer.load([empty,fallback]).phase,'active');
    fs.writeFileSync(file,'{');
    assert.strictEqual(layer.load([file,fallback]).phase,'invalid');
    fs.unlinkSync(file);assert.strictEqual(layer.load([file,empty]).phase,'absent');
    // Exercise the real service startup and reboot with a point far from real catalogued roads.
    const ref={lat:65.12,lon:132.34},r=row(12,90,50,null);r[1]=ref.lat;r[2]=ref.lon;
    fs.writeFileSync(file,JSON.stringify(payload([r])));
    const service=require(files+'marku-kaluga-cameras');
    try{
        for(let restart=0;restart<2;restart++){
            const gps=new emitter();gps.close=gps.start=()=>{};
            gps.current=()=>fix(ref,90,60,0,32,Date.now());
            let app,shown=null;
            try{
                await new Promise((resolve,reject)=>{app=service.start({dataDir:tmp,socket:path.join(tmp,'ctl.sock'),gps,onListening:resolve,onError:reject,
                    display:{update(a){shown=a;},status(){return 'off';},close(){}},dimmer:{update(){},status(){return 'off';},close(){}}});});
                assert.strictEqual(app.state().database.speedcamOnline.added,1);
                assert.strictEqual(app.state().alert.id,id(12));assert.strictEqual(cards.presentation(shown).limit,50);
                assert.strictEqual(app.state().alert.overspeed,false);
            } finally {if(app) app.close();}
        }
    } finally {fs.rmSync(tmp,{recursive:true,force:true});}
}
daemon().then(()=>console.log('PASS private SpeedCam merge, direction, HUD limit, conflicts, overlap, file validation and service restart')).catch(e=>{console.error(e);process.exitCode=1;});
