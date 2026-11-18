'use strict';
// 0.8.7: visual flash keeps its strict road-confirmed semantics; the sound
// path additionally honors a known camera/road limit (limitReference), the
// owner's control distance and the per-camera repeat interval.
var DEFAULTS=Object.freeze({visualFlash:true,visualOffsetKmh:0,soundEnabled:true,soundOffsetKmh:20,
    soundDistanceM:400,soundRepeatSec:5,soundOnCameraAppear:false});
var keys=Object.keys(DEFAULTS);
function object(v){return !!v&&typeof v==='object'&&!Array.isArray(v);}
function valid(k,v){
    if(k==='visualFlash'||k==='soundEnabled'||k==='soundOnCameraAppear')return typeof v==='boolean';
    if(k==='soundDistanceM')return typeof v==='number'&&Number.isInteger(v)&&v>=100&&v<=700&&v%50===0;
    if(k==='soundRepeatSec')return [0,3,5,10].indexOf(v)>=0;
    return typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=30;
}
function normalize(raw){var result={};keys.forEach(function(k){result[k]=object(raw)&&Object.prototype.hasOwnProperty.call(raw,k)&&valid(k,raw[k])?raw[k]:DEFAULTS[k];});return result;}
function patch(previous,partial){
 if(!object(partial))throw new Error('Некорректные настройки превышения: ожидается объект');
 Object.keys(partial).forEach(function(k){if(keys.indexOf(k)<0||!valid(k,partial[k]))throw new Error('Некорректный параметр превышения: '+k);});
 var result=normalize(previous);Object.keys(partial).forEach(function(k){result[k]=partial[k];});return result;
}
function validLimit(value){return Number.isFinite(value)&&value>0&&value<=300;}
function soundFixOk(fix,now){
 return !!fix&&[fix.lat,fix.lon,fix.accuracyM,fix.timeMs,now].every(Number.isFinite)&&Math.abs(fix.lat)<=90&&Math.abs(fix.lon)<=180&&
     fix.accuracyM>0&&fix.accuracyM<=15&&now-fix.timeMs<=3000&&fix.timeMs<=now+500&&
     (!Object.prototype.hasOwnProperty.call(fix,'motionTimeMs')||Number.isFinite(fix.motionTimeMs)&&now-fix.motionTimeMs<=3000&&fix.motionTimeMs<=now+500)&&
     Number.isFinite(fix.speedKmh)&&fix.speedKmh>=0&&fix.speedKmh<=400;
}
function evaluate(alert,fix,now,raw){
 var p=normalize(raw), out={eligible:false,reason:null,limitKmh:null,speedKmh:null,overspeed:false,visualBoundaryKmh:null,soundBoundaryKmh:null,flashActive:false,flashPhase:false,soundExceeded:false,displayBoundaryKmh:null,
     effectiveLimitKmh:null,soundEligible:false};
 if(!alert){out.reason='NO_ALERT';return out;}
 if(alert.test||alert.calibration){out.reason='TEST';return out;}
 if(alert.filterMatched===false){out.reason='TYPE_DISABLED';return out;}
 var roadLimit=alert.roadConfirmed===true&&validLimit(alert.limitKmh)?alert.limitKmh:null;
 var reference=alert.limitReference&&alert.limitReference.state==='known'&&validLimit(alert.limitReference.valueKmh)?alert.limitReference.valueKmh:null;
 var effective=roadLimit!==null?roadLimit:reference;
 out.effectiveLimitKmh=effective;
 out.soundBoundaryKmh=effective!==null?effective+p.soundOffsetKmh:null;
 // The sound path works for any active camera with a known applicable limit,
 // including an honest nearby notice with a confirmed reference limit, while
 // the car is inside the owner's control distance.
 out.soundEligible=effective!==null&&p.soundEnabled===true&&
     (!Number.isFinite(alert.distanceM)||(alert.distanceM>=0&&alert.distanceM<=p.soundDistanceM));
 if(alert.roadConfirmed!==true){
   out.reason=out.reason||'ROAD_UNCONFIRMED';
   if(out.soundEligible&&soundFixOk(fix,now)&&out.soundBoundaryKmh!==null)out.soundExceeded=fix.speedKmh>out.soundBoundaryKmh;
   return out;
 }
 if(!validLimit(alert.limitKmh)){out.reason='LIMIT_UNKNOWN';return out;}
 if(!fix||![fix.lat,fix.lon,fix.accuracyM,fix.timeMs,now].every(Number.isFinite)||Math.abs(fix.lat)>90||Math.abs(fix.lon)>180||fix.accuracyM<=0||fix.accuracyM>15){out.reason='GPS_INVALID';return out;}
 if(now-fix.timeMs>3000||fix.timeMs>now+500){out.reason='GPS_STALE';return out;}
 if(Object.prototype.hasOwnProperty.call(fix,'motionTimeMs')&&(!Number.isFinite(fix.motionTimeMs)||now-fix.motionTimeMs>3000||fix.motionTimeMs>now+500)){out.reason='MOTION_STALE';return out;}
 if(!Number.isFinite(fix.speedKmh)||fix.speedKmh<0||fix.speedKmh>400){out.reason='SPEED_INVALID';return out;}
 out.eligible=true;out.reason='READY';out.limitKmh=alert.limitKmh;out.speedKmh=fix.speedKmh;
 out.visualBoundaryKmh=out.limitKmh+p.visualOffsetKmh;
 out.overspeed=out.speedKmh>out.limitKmh;out.flashActive=p.visualFlash&&out.speedKmh>out.visualBoundaryKmh;
 out.flashPhase=out.flashActive&&Math.floor(now/500)%2===0;
 if(out.soundEligible&&out.soundBoundaryKmh!==null)out.soundExceeded=fix.speedKmh>out.soundBoundaryKmh;
 [out.limitKmh,out.visualBoundaryKmh,out.soundBoundaryKmh].forEach(function(boundary){if(out.speedKmh>boundary&&Math.round(out.speedKmh)<=boundary&&(out.displayBoundaryKmh===null||boundary>out.displayBoundaryKmh))out.displayBoundaryKmh=boundary;});
 return out;
}
module.exports={DEFAULTS:DEFAULTS,normalize:normalize,patch:patch,evaluate:evaluate};
