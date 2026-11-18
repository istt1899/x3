// Host-only converter: the Moscow oblast OSM camera source snapshot ->
// native/marku-kaluga-cameras/files/moscow-osm.json (kaluga-speed.json shape,
// region RU-MOW). Records are source facts only; no zone or limit inference.
// Usage: node tools/build-moscow-osm.mjs [--input FILE] [--output FILE]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INPUT_DEFAULT=path.join(ROOT,'data/source-snapshots/moscow-osm-camera-source-2026-11-18.json');
const OUTPUT_DEFAULT=path.join(ROOT,'native/marku-kaluga-cameras/files/moscow-osm.json');
const PBF_MD5='0a503217c6e6f7cadd10756c1b6b377e';
const PROVIDER_URL='https://download.openstreetmap.fr/extracts/russia/central_federal_district/moscow_oblast.osm.pbf';
const OSM_RELATION=51490;
// MKAD-approximate box for the inMoscowCity flag, same spirit as inKalugaCity.
const CITY={latMin:55.45,latMax:56.05,lonMin:37.25,lonMax:37.95};
function fail(code,message){const e=new Error(message||code);e.code=code;throw e;}
export function convert(snapshot){
    if(!snapshot||snapshot.kind!=='osm-camera-source'||snapshot.region!=='RU-MOW'||!Array.isArray(snapshot.records))fail('MOW_SCHEMA');
    const seen=new Set(),records=[];
    for(const r of snapshot.records){
        if(!/^osm:node:[0-9]+$/.test(r.id||'')||seen.has(r.id))fail('MOW_ID');
        seen.add(r.id);
        const inCity=r.position.lat>=CITY.latMin&&r.position.lat<=CITY.latMax&&r.position.lon>=CITY.lonMin&&r.position.lon<=CITY.lonMax;
        const record={id:r.id,type:r.type,controls:r.controls.slice(),position:{lat:r.position.lat,lon:r.position.lon},region:'RU-MOW',
            limitKmh:Number.isInteger(r.limitKmh)&&r.limitKmh>=5&&r.limitKmh<=180?r.limitKmh:null,
            inMoscowCity:inCity,directionKnown:!!r.rawDirection,rawDirection:r.rawDirection||null};
        if(typeof r.description==='string'&&r.description.trim())record.description=r.description.trim().slice(0,250);
        records.push(record);
    }
    records.sort((a,b)=>a.id.localeCompare(b.id));
    return{schemaVersion:1,version:Date.parse(snapshot.sourceTimestamp)||0,sourceTimestamp:snapshot.sourceTimestamp||null,
        generatedAt:new Date().toISOString(),source:'OpenStreetMap',licence:'ODbL-1.0',region:'RU-MOW',osmRelation:OSM_RELATION,
        providerUrl:PROVIDER_URL,pbfMd5:PBF_MD5,records};
}
function main(){
    const args=process.argv.slice(2),opts={};for(let i=0;i<args.length;i+=2){if(!['--input','--output'].includes(args[i])||!args[i+1])throw Error('Usage: --input FILE --output FILE');opts[args[i]]=args[i+1];}
    const input=opts['--input']||INPUT_DEFAULT,output=opts['--output']||OUTPUT_DEFAULT;
    const snapshot=JSON.parse(fs.readFileSync(input,'utf8')),db=convert(snapshot);
    const data=JSON.stringify(db)+'\n';
    if(fs.existsSync(output)&&Buffer.from(fs.readFileSync(output,'utf8').replace(/\r\n/g,'\n')).equals(Buffer.from(data))){console.log(JSON.stringify({unchanged:true,records:db.records.length}));return;}
    if(fs.existsSync(output))throw Error('Refusing to replace existing moscow-osm.json with different bytes');
    fs.writeFileSync(output,data);
    console.log(JSON.stringify({file:path.basename(output),records:db.records.length,inMoscowCity:db.records.filter(r=>r.inMoscowCity).length,size:data.length}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
