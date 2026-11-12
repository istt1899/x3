// Host-only source acquisition/normalisation for the OpenSpeedcam community
// point layer. Does not publish or activate a vehicle database. The snapshot
// keeps only static enforcement-related point kinds; mobile ambushes, typical
// police locations and hazard POIs are excluded at import and listed in audit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const SOURCE_URL='https://openspeedcam.net/';
export const API_URL='https://openspeedcam.net/api/points/';
// Generous box around the Kaluga region; region attribution is taken from the
// point itself, neighbouring regions stay out of the snapshot.
export const BOUNDS={x1:33.5,y1:53.3,x2:37.2,y2:55.4};
export const IMPORTED_KINDS=['static_cam','speed_cam','control_cam_red','video_control','dummy','stationary_porst_dps'];
export const MOBILE_KINDS=['mobile_ambush','rec_policeman'];
const ALL_TYPES=['static_cam','control_cam_red','speed_cam','mobile_ambush','dummy','traffic_control_ot','video_control',
    'stationary_porst_dps','railroad_crossing','crosswalk','cautiouslychildren','begin_village','end_village','speed_limit',
    'rec_policeman','bad_road','dang_turn','dang_intersection','dang_other','overtaking_proh'];
function fail(code,message){const error=new Error(message||code);error.code=code;throw error;}
function text(value,max){return typeof value==='string'&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);}
function clean(value,max){return typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max)||null:null;}
async function fetchBounds(fetchImpl,bounds){
    const post=fetchImpl||fetch;
    const response=await post(API_URL,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json',
        'X-Requested-With':'XMLHttpRequest','Referer':SOURCE_URL},
        body:JSON.stringify({type:'bounds',x1:bounds.x1,y1:bounds.y1,x2:bounds.x2,y2:bounds.y2,
            filters:{allSelected:true,selectedTypes:ALL_TYPES,rating:null}})});
    if(!response.ok)fail('OSC_HTTP_'+response.status);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>32*1024*1024)fail('OSC_SIZE');
    let points;try{points=JSON.parse(bytes.toString('utf8'));}catch(e){fail('OSC_JSON');}
    if(!Array.isArray(points)||points.length>100000)fail('OSC_SCHEMA');
    return{points,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
}
function normalizePoint(point){
    if(!point||typeof point!=='object'||Array.isArray(point))return null;
    if(!/^[a-f0-9]{24}$/.test(point._id||'')||!Number.isFinite(point.x)||!Number.isFinite(point.y))return null;
    if(!IMPORTED_KINDS.includes(point.type))return null;
    const flags={},flagSource={bSpeed:'bSpeed',stopLine:'stopLine',stopCrossroad:'stopCrossroad',rows:'rows',markings:'markings',
        pedestrians:'pedestrians',overtaking:'overtaking',inBack:'inBack'};
    for(const[key,field]of Object.entries(flagSource))flags[key]=point[field]===true;
    return{id:'osc:'+point._id,kind:point.type,subType:text(point.subType,64)?point.subType:null,
        position:{lat:point.y,lon:point.x},
        limitKmh:Number.isInteger(point.speed)&&point.speed>=5&&point.speed<=180?point.speed:null,
        dirType:[0,1,2].includes(point.dirType)?point.dirType:null,
        directionDeg:Number.isFinite(point.direction)&&point.direction>=0&&point.direction<360?point.direction:null,
        zoneDistanceM:Number.isInteger(point.distance)&&point.distance>=0&&point.distance<=2000?point.distance:null,
        angleDeg:Number.isFinite(point.angle)&&point.angle>=0&&point.angle<=180?point.angle:null,
        flags,comment:clean(point.comment,250),
        rating:Number.isInteger(point.rating)?point.rating:null,
        created:text(point.created,40)?point.created:null,sourceIndex:Number.isInteger(point.idx)?point.idx:null};
}
export function normalizeSnapshot(points,meta){
    if(!Array.isArray(points))fail('OSC_SCHEMA');
    const excluded=[],records=[],ids=new Set();
    for(const point of points){
        const region=typeof point?.region==='string'?point.region:'';
        const kind=typeof point?.type==='string'?point.type:'unknown';
        if(!/^Калужская область$/i.test(region)){excluded.push({id:/^[a-f0-9]{24}$/.test(point?._id||'')?point._id:null,kind,reason:'other-region'});continue;}
        if(!IMPORTED_KINDS.includes(kind)){excluded.push({id:point._id,kind,reason:MOBILE_KINDS.includes(kind)?'mobile-or-typical-location':'non-enforcement-poi'});continue;}
        const record=normalizePoint(point);
        if(!record){excluded.push({id:point?._id||null,kind,reason:'invalid-point'});continue;}
        if(record.position.lat<53||record.position.lat>56||record.position.lon<33||record.position.lon>38){excluded.push({id:point._id,kind,reason:'outside-region-bounds'});continue;}
        if(ids.has(record.id)){excluded.push({id:point._id,kind,reason:'duplicate-id'});continue;}
        ids.add(record.id);records.push(record);
    }
    return{schema:1,kind:'openspeedcam-snapshot',source:'OpenSpeedcam',region:'RU-KLU',sourceUrl:SOURCE_URL,apiUrl:API_URL,
        retrievedAt:meta.retrievedAt,bounds:Object.assign({},meta.bounds||BOUNDS),rawSha256:meta.rawSha256||null,rawBytes:meta.rawBytes||null,
        reuse:{attributionRequired:true,statement:'OpenSpeedcam — свободно редактируемая открытая база точек; все точки доступны для исправления, обновления и загрузки.',statementUrl:SOURCE_URL},
        counts:{fetched:points.length,imported:records.length,excluded:excluded.length},records,excluded};
}
function main(){
    const args=process.argv.slice(2),outIndex=args.indexOf('--output');
    const output=outIndex>=0?args[outIndex+1]:path.join(path.dirname(fileURLToPath(import.meta.url)),'..','native','marku-kaluga-cameras','files','openspeedcam-kaluga.json');
    const rawIndex=args.indexOf('--raw'),rawOutput=rawIndex>=0?args[rawIndex+1]:null;
    fetchBounds(null,BOUNDS).then(({points,sha256,bytes})=>{
        const snapshot=normalizeSnapshot(points,{retrievedAt:new Date().toISOString(),rawSha256:sha256,rawBytes:bytes});
        const data=JSON.stringify(snapshot,null,1)+'\n';
        fs.mkdirSync(path.dirname(output),{recursive:true});
        fs.writeFileSync(output,data);
        if(rawOutput){fs.mkdirSync(path.dirname(rawOutput),{recursive:true});fs.writeFileSync(rawOutput,JSON.stringify(points)+'\n');}
        console.log(JSON.stringify({file:path.basename(output),imported:snapshot.counts.imported,excluded:snapshot.counts.excluded,
            fetched:snapshot.counts.fetched,sha256:crypto.createHash('sha256').update(data).digest('hex')}));
    }).catch(error=>{console.error(error.code||error.message);process.exit(1);});
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))main();
