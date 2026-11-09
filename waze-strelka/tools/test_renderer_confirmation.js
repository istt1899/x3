'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),EventEmitter=require('events');
const service=require('../native/marku-kaluga-cameras/files/marku-kaluga-cameras');

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'camera-render-confirmation-'));
const socket=process.platform==='win32'?'\\\\.\\pipe\\camera-render-confirmation-'+process.pid:path.join(dir,'ctl.sock');
const gps=new EventEmitter();gps.start=gps.close=()=>{};
gps.current=()=>({lat:54.4932,lon:36.2282,timeMs:Date.now(),motionTimeMs:Date.now(),accuracyM:5,speedKmh:0,headingDeg:0,source:'bmw-nmea'});
const details={connection:'ready',map:null,hud:null};
const display={update:()=>{},status:()=>'ready',diagnostics:()=>JSON.parse(JSON.stringify(details)),close:()=>{}};

async function main(){
 let app;
 try{
  await new Promise((resolve,reject)=>{app=service.start({dataDir:dir,socket,gps,
   guidance:{evaluate:()=>null},display,dimmer:{update:()=>{},status:()=>'off',close:()=>{}},
   storeFactory:options=>({current:()=>options.initial,status:()=>({phase:'idle'}),close:()=>{}}),
   onListening:resolve,onError:reject});});
  app.command({cmd:'outputs',cluster:true,hud:false});

  function start(id,target){
   if(app.state().displayTest.active)app.command({cmd:'display-test-stop'});
   app.command({cmd:'display-test',target:target||'map',requestId:id});
   assert.strictEqual(app.state().commandResult.requestId,id,'the test result keeps the caller requestId');
   return app.state().commandResult;
  }
  function expect(id,phase){
   const result=app.state().commandResult;
   assert.strictEqual(result.requestId,id,'a later renderer event keeps the same requestId');
   assert.strictEqual(result.command,'display-test');
   assert.strictEqual(result.phase,phase,result.message);
   return result;
  }

  details.map={state:'shown',target:'shown',rendering:'checking'};
  start('render-checking');
  expect('render-checking','requested');
  details.map={state:'shown',target:'shown',rendering:'verified'};
  app.tick();
  const verified=expect('render-checking','shown');
  assert(!/renderer подтвердил показ/i.test(verified.message),'a subscription must not be described as physical display');

  details.map={state:'shown',target:'waiting',rendering:'verified'};
  start('render-target-waiting');
  expect('render-target-waiting','requested');
  details.map={state:'shown',target:'shown',rendering:'verified'};
  app.tick();
  expect('render-target-waiting','shown');

  details.map={state:'shown',target:'shown',rendering:'unobservable'};
  start('render-unobservable');
  expect('render-unobservable','unconfirmed');

  details.map={state:'shown',target:'shown'};
  start('render-missing');
  assert(['requested','unconfirmed'].indexOf(app.state().commandResult.phase)>=0,
   'a renderer without rendering evidence must never return success');
  assert.strictEqual(app.state().commandResult.requestId,'render-missing');

  details.map={state:'shown',target:'shown',rendering:'none'};
  start('render-none');
  expect('render-none','requested');

  details.map={state:'отказ',target:'unavailable',rendering:'none',reason:'RENDERER_DENIED'};
  start('render-refused');
  const refused=expect('render-refused','error');
  assert(refused.message.includes('RENDERER_DENIED'));

  if(app.state().displayTest.active)app.command({cmd:'display-test-stop'});
  app.command({cmd:'outputs',cluster:true,hud:true});
  details.map={state:'shown',target:'shown',rendering:'verified'};
  details.hud={state:'shown',target:'shown',rendering:'checking'};
  app.command({cmd:'display-test',requestId:'render-both'});
  expect('render-both','requested');
  details.hud={state:'shown',target:'shown',rendering:'verified'};
  app.tick();
  expect('render-both','shown');
  console.log('PASS renderer confirmation: checking, verified, target waiting, unobservable, absent, none, refusal, both targets and requestId');
 }finally{
  if(app)app.close();
  fs.readdirSync(dir).forEach(name=>fs.unlinkSync(path.join(dir,name)));
  fs.rmdirSync(dir);
 }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
