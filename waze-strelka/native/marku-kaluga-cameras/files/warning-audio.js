'use strict';
// 0.8.7: the sound scheduler. Playback itself lives behind an adapter: in
// tests an in-process stub, in production a remote adapter whose request the
// HMI executes through the BMW gong service and reports back. Nothing here
// claims a sound the vehicle did not confirm.
var policy=require('./warning-policy');
function prefsOf(a,b){
 if(a&&typeof a==='object'&&!Array.isArray(a))
  return {on:!!a.soundEnabled,threshold:Number.isInteger(a.soundOffsetKmh)&&a.soundOffsetKmh>=0&&a.soundOffsetKmh<=30?a.soundOffsetKmh:20,
      repeatSec:[0,3,5,10].indexOf(a.soundRepeatSec)>=0?a.soundRepeatSec:5,appear:!!a.soundOnCameraAppear};
 return {on:!!a,threshold:Number.isInteger(b)&&b>=0&&b<=30?b:20,repeatSec:0,appear:false};
}
function createAudio(adapter,options){
 adapter=adapter&&typeof adapter.play==='function'?adapter:null; options=options||{};
 var timeoutMs=options.timeoutMs||1500,enabled=false,threshold=0,repeatSec=5,appear=false,closed=false,generation=0,flight=null,records=Object.create(null),lastNow=null,admittedKey=null,seq=0,lastAppearId=null,globalLast=null;
 // A remote (vehicle) channel is honest only after a confirmed playback;
 // an in-process adapter is a test stub and starts ready.
 var remote=!!options.remote,confirmed=!!adapter&&!remote;
 var unconfirmedReason='Звуковой канал BMW не подтверждён; проверьте звук на стоянке. Радио и системная громкость не меняются';
 var state={available:confirmed,enabled:false,thresholdKmh:0,repeatSec:5,appearSound:false,phase:adapter?(confirmed?'ready':'unavailable'):'unavailable',reason:adapter?(confirmed?null:unconfirmedReason):unconfirmedReason,request:null};
 function reject(message){return Promise.reject(new Error(message));}
 function play(test,kind,now,key,record){
  if(!adapter||closed)return reject(state.reason||'Звук недоступен');
  if(flight)return reject('Звуковой запрос ещё не завершён');
  var gen=generation,settled=false,finishPublic,timer,id=++seq;
  var result=new Promise(function(resolve,rejectPublic){finishPublic={resolve:resolve,reject:rejectPublic};});
  var f={id:id,cancel:function(){if(!settled){settled=true;clearTimeout(timer);if(state.request&&state.request.seq===id)state.request=null;finishPublic.reject(new Error('Звуковой канал закрыт'));}}};flight=f;
  state.phase='requested';state.reason=null;state.request={seq:id,test:!!test,kind:kind||'overspeed',atMs:now};
  timer=setTimeout(function(){
   if(settled)return;settled=true;
   if(state.request&&state.request.seq===id)state.request=null;
   if(!closed&&gen===generation){state.phase='outcome-unknown';state.reason='Подтверждение звука не получено; канал занят до завершения запроса';}
   finishPublic.reject(new Error('Результат звука неизвестен; канал занят'));
  },timeoutMs);
  Promise.resolve().then(function(){
   if(closed)throw new Error('Звуковой канал закрыт');
   if(!test&&kind!=='appear'&&(!enabled||gen!==generation||admittedKey!==key))throw new Error('Допуск к звуку отозван');
   return adapter.play({test:!!test,durationMs:250,kind:kind||'overspeed',seq:id});
  }).then(function(value){
   var success=!!value&&value.played===true;
   if(record&&success){record.success=true;if(records[key])records[key].success=true;}
   if(flight===f)flight=null;
   if(state.request&&state.request.seq===id)state.request=null;
   if(!settled){settled=true;clearTimeout(timer);if(success)finishPublic.resolve(value);else finishPublic.reject(new Error('Воспроизведение звука не подтверждено'));}
   if(!closed&&gen===generation){if(success){confirmed=true;state.available=true;}state.phase=success?'played':'error';state.reason=success?null:'Воспроизведение звука не подтверждено';}
  },function(error){
   if(flight===f)flight=null;
   if(state.request&&state.request.seq===id)state.request=null;
   if(!settled){settled=true;clearTimeout(timer);finishPublic.reject(error);}
   if(!closed&&gen===generation){state.phase='error';state.reason=String(error&&error.message||error).slice(0,160);}
  });
  return result;
 }
 function tickClock(now){if(!Number.isFinite(now))return false;if(lastNow!==null&&now<lastNow)return false;lastNow=now;return true;}
 return {
  status:function(){var snapshot=Object.assign({},state,{pending:!!flight});if(!flight&&snapshot.phase==='outcome-unknown')snapshot.reason='Результат предыдущего запроса не относится к текущей сессии';return snapshot;},
  configure:function(a,b){
   var p=prefsOf(a,b);
   if(typeof (a&&typeof a==='object'?a.soundEnabled:a)!=='boolean'&&typeof a!=='object')throw new Error('Некорректные настройки звука');
   if(enabled===p.on&&threshold===p.threshold&&repeatSec===p.repeatSec&&appear===p.appear)return;
   generation++;
   enabled=p.on;threshold=p.threshold;repeatSec=p.repeatSec;appear=p.appear;
   if(!enabled)admittedKey=null;
   state.enabled=enabled;state.thresholdKmh=threshold;state.repeatSec=repeatSec;state.appearSound=appear;
   if(flight&&enabled) {state.phase='outcome-unknown';state.reason='Предыдущий звуковой запрос ещё не завершён';}
   else if(!flight&&adapter&&!closed){state.phase=confirmed?'ready':'unavailable';state.reason=confirmed?null:unconfirmedReason;}
  },
  update:function(alert,fix,now){
   if(!tickClock(now)){admittedKey=null;return;}
   Object.keys(records).forEach(function(k){if((!alert||k!==alert.id+':'+(alert.sign||'road'))&&now-records[k].lastSeen>30000)delete records[k];});
   if(!alert){admittedKey=null;lastAppearId=null;return;}
   var key=alert.id+':'+(alert.sign||'road'),record=records[key];
   if(record&&now-record.lastSeen>30000){delete records[key];record=null;}
   if(!record)record=records[key]={lastSeen:now,success:false,attempts:0,lastAttempt:null,latched:false,rearmed:false};
   record.lastSeen=now;
   var decision=policy.evaluate(alert,fix,now,{soundOffsetKmh:threshold});
   admittedKey=enabled&&decision.soundExceeded?key:null;
   // Optional short signal when a camera appears, regardless of overspeed.
   if(appear&&lastAppearId!==alert.id){lastAppearId=alert.id;if(enabled&&adapter&&!closed&&!flight){globalLast=now;play(false,'appear',now,null,null).catch(function(){});}}
   // Hysteresis: the latch drops only 3 km/h below the boundary.
   if(record.latched&&(!Number.isFinite(decision.soundBoundaryKmh)||!fix||!Number.isFinite(fix.speedKmh)||fix.speedKmh<=decision.soundBoundaryKmh-3)){
    record.latched=false;record.success=false;record.attempts=0;record.lastAttempt=null;record.rearmed=true;
   }
   if(!enabled||!adapter||closed||flight||!decision.soundExceeded)return;
   if(!record.latched){
    // Global quarantine between DIFFERENT cameras; a latched camera's own
    // repeats follow the owner's interval instead.
    if(globalLast!==null&&now-globalLast<12000&&!record.rearmed)return;
    record.rearmed=false;
    if(record.attempts>=3)return; // a failing channel never hammers
    globalLast=now;
    record.attempts++;record.lastAttempt=now;record.latched=true;
    play(false,'overspeed',now,key,record).catch(function(){});
    return;
   }
   // A failed attempt retries on the old 12 s quarantine; a confirmed sound
   // repeats only on the owner's interval (0 = one confirmed signal per
   // overspeed episode).
   if(!record.success){
    if(now-record.lastAttempt>=12000&&record.attempts<3){globalLast=now;record.attempts++;record.lastAttempt=now;play(false,'overspeed',now,key,record).catch(function(){});}
    return;
   }
   var gapMs=repeatSec===0?Infinity:repeatSec*1000;
   if(repeatSec>0&&now-record.lastAttempt>=gapMs&&record.attempts<12){globalLast=now;record.attempts++;record.lastAttempt=now;play(false,'overspeed',now,key,record).catch(function(){});}
  },
  outcome:function(id,played,reason){
   if(!adapter||typeof adapter.outcome!=='function')return false;
   return adapter.outcome(id,played,reason);
  },
  resetEpoch:function(now){
   if(!Number.isFinite(now))throw new Error('Некорректное время сброса звука');
   var shift=lastNow!==null&&now<lastNow?now-lastNow:0;
   if(shift){Object.keys(records).forEach(function(k){records[k].lastSeen+=shift;if(records[k].lastAttempt!==null)records[k].lastAttempt+=shift;});if(globalLast!==null)globalLast+=shift;}
   lastNow=now;generation++;admittedKey=null;
   if(!closed&&adapter){state.phase=flight?'outcome-unknown':confirmed?'ready':'unavailable';state.reason=flight?'Предыдущий звуковой запрос ещё не завершён':confirmed?null:unconfirmedReason;}
  },
  test:function(now){if(!tickClock(now))return reject('Некорректное время звукового теста');return play(true,'test',now,null,null);},
  close:function(){if(closed)return;closed=true;generation++;state.available=false;state.phase='closed';if(flight)flight.cancel();state.request=null;if(adapter&&typeof adapter.close==='function')adapter.close();}
 };
}
module.exports={createAudio:createAudio};
