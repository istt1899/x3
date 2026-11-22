'use strict';
const fs = require('fs');
const ID = /^sco:[a-f0-9]{20}$/;
const SOURCE = 'SpeedCamOnLine';
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 150000;
const DEG = Math.PI / 180;
function empty(phase) {
    return { phase, sourceDate: null, added: 0, enriched: 0, approaches: 0 };
}
function decode(data) {
    if (!data || data.schema !== 1 || data.source !== 'speedcamonline' || data.directionMeaning !== 'vehicle-course' ||
        typeof data.version !== 'string' || !/^20\d\d\.\d{1,2}\.\d{1,2}$/.test(data.version) ||
        !Array.isArray(data.records) || !data.records.length || data.records.length > MAX_ROWS) throw new Error('SPEEDCAM_SCHEMA');
    const parts = data.version.split('.').map(Number);
    const date = new Date(Date.UTC(parts[0], parts[1]-1, parts[2]));
    if (date.getUTCMonth()+1 !== parts[1] || date.getUTCDate() !== parts[2]) throw new Error('SPEEDCAM_DATE');
    const seen = new Set();
    for (const row of data.records) {
        if (!Array.isArray(row) || row.length !== 7) throw new Error('SPEEDCAM_ROW');
        const [id,lat,lon,course,limit,target,type] = row;
        if (typeof id !== 'string' || !ID.test(id) || seen.has(id) ||
            !Number.isFinite(lat) || lat < 40 || lat > 83 || !Number.isFinite(lon) ||
            !(lon >= 18 && lon <= 180 || lon >= -180 && lon <= -165) ||
            !Number.isInteger(course) || course < 0 || course >= 360 ||
            limit !== null && !(Number.isInteger(limit) && limit > 0 && limit <= 300) ||
            target !== null && !(typeof target === 'string' && target.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(target) && !ID.test(target)) ||
            ![1,6,12].includes(type)) throw new Error('SPEEDCAM_ROW');
        seen.add(id);
    }
    return { phase:'active', sourceDate:date.toISOString().slice(0,10), rows:data.records };
}
function load(paths) {
    for (const file of paths) {
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('SPEEDCAM_SIZE');
            return decode(JSON.parse(fs.readFileSync(file,'utf8')));
        } catch (e) {
            if (e.code !== 'ENOENT') return empty('invalid');
        }
    }
    return empty('absent');
}
function lonDelta(a,b) { const d=a-b; return d>180?d-360:d< -180?d+360:d; }
function distance(a,b) {
    return Math.hypot((a.lat-b.lat)*111320, lonDelta(a.lon,b.lon)*111320*Math.cos((a.lat+b.lat)*DEG/2));
}
// Check overlap again when a regional update adds a site after the private pack was built.
function indexBase(records) {
    const grid=new Map(), cell=(y,x)=>y+','+((x+36000)%36000);
    records.forEach(r=>{
        const key=cell(Math.floor(r.position.lat*100),Math.floor((r.position.lon+180)*100));
        if (!grid.has(key)) grid.set(key,[]);
        grid.get(key).push(r);
    });
    return position=>{
        const y=Math.floor(position.lat*100), x=Math.floor((position.lon+180)*100);
        const cols=Math.min(18000,Math.ceil(75/(1113*Math.max(0.001,Math.cos(position.lat*DEG))))+1);
        const matches=[];
        for (let dy=-1;dy<=1;dy++) for(let dx=-cols;dx<=cols;dx++) {
            const bucket=grid.get(cell(y+dy,x+dx));
            if (bucket) bucket.forEach(r=>{ if(distance(position,r.position)<=75) matches.push(r); });
        }
        return matches;
    };
}
function merge(bundle, layer) {
    const status=Object.assign(empty(layer.phase),{sourceDate:layer.sourceDate});
    if (layer.phase!=='active') return Object.assign({},bundle,{speedcamOnline:status});
    const near=indexBase(bundle.records), extras=[], linked=new Map();
    for (const row of layer.rows) {
        const [id,lat,lon,courseDeg,limitKmh,target,typeCode]=row;
        const position={lat,lon}, approach={id,courseDeg,limitKmh,position,typeCode};
        const matches=near(position);
        if (target===null) {
            if (matches.length) continue;
            // Neoline 6 is also used for weight enforcement and the converter's
            // generic fallback; 1/12 identify device families, not violations.
            extras.push({id,position,type:'camera',controls:[],providerId:'speedcamonline',provenance:SOURCE,
                positionKind:'community-point',sourceUrl:'https://speedcamonline.ru/',limitKmh:null,speedcamApproaches:[approach]});
        } else {
            if (matches.length!==1 || matches[0].id!==target || distance(position,matches[0].position)>35) continue;
            if (!linked.has(target)) linked.set(target,[]);
            linked.get(target).push(approach);
        }
        status.approaches++;
    }
    status.added=extras.length; status.enriched=linked.size;
    const records=bundle.records.map(r=>linked.has(r.id) ? Object.assign({},r,{speedcamApproaches:linked.get(r.id)}) : r).concat(extras);
    return Object.assign({},bundle,{records,speedcamOnline:status});
}
// Archive headings are vehicle courses. An opposed course never becomes a match.
// Compare the point on this approach, since a junction may have four offset posts.
function matchApproach(record, fix, course, roadConfirmed) {
    if (!record.speedcamApproaches || !Number.isFinite(course)) return null;
    const heading=course*DEG, sin=Math.sin(heading), cos=Math.cos(heading);
    let best=null, error=Infinity, conflict=false;
    for (const row of record.speedcamApproaches) {
        const delta=Math.abs((row.courseDeg-course+540)%360-180);
        if (delta>22.5) continue;
        const dx=lonDelta(row.position.lon,fix.lon)*111320*Math.cos(fix.lat*DEG);
        const dy=(row.position.lat-fix.lat)*111320;
        if (!roadConfirmed && (Math.abs(dx*cos-dy*sin)>9 || dx*sin+dy*cos < -6)) continue;
        if (best && best.limitKmh!==row.limitKmh) conflict=true;
        if (delta<error) {best=row;error=delta;}
    }
    return conflict ? null : best;
}
function applicable(row,alert) {
    if (!row || !Number.isFinite(row.limitKmh) || alert.cameraLimitConditional) return null;
    const ref=alert.limitReference;
    if (ref && (ref.state==='conflict' || ref.state==='known' && ref.valueKmh!==row.limitKmh)) return null;
    if ([alert.cameraLimitKmh,alert.limitKmh,alert.postedApproachLimitKmh,alert.roadMapLimitKmh].some(v=>Number.isFinite(v)&&v!==row.limitKmh)) return null;
    return {id:row.id,courseDeg:row.courseDeg,limitKmh:row.limitKmh,typeCode:row.typeCode,source:SOURCE};
}
module.exports={load,decode,merge,matchApproach,applicable};
