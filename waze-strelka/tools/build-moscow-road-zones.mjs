import fs from 'node:fs';
import crypto from 'node:crypto';
import {createOSMStream} from 'osm-pbf-parser-node';

const [pbf, output] = process.argv.slice(2);
if (!pbf || !output) throw Error('Usage: node tools/build-moscow-road-zones.mjs PBF OUTPUT');
const sourceTimestamp = '2026-11-27T00:09:02.000Z';
const pbfMd5 = '21c7ad098ac91721c6e5d303d5261c97';
const digest = crypto.createHash('md5');
for await (const chunk of fs.createReadStream(pbf)) digest.update(chunk);
if (digest.digest('hex') !== pbfMd5) throw Error('Unexpected Moscow PBF checksum');

const snapshot = JSON.parse(fs.readFileSync(new URL('../native/marku-kaluga-cameras/files/moscow-osm.json', import.meta.url)));
const eligible = snapshot.records.filter(r => r.controls.includes('speed') &&
    typeof r.rawDirection === 'string' && /^\d{1,3}$/.test(r.rawDirection) && Number(r.rawDirection) <= 360);
const byNode = new Map(eligible.map(r => [Number(r.id.split(':').pop()), r]));
const cells = new Set();
const cell = (lat, lon) => Math.floor(lat * 100) * 100000 + Math.floor(lon * 100);
for (const {position: {lat, lon}} of eligible) {
    for (let y = -3; y <= 3; y++) {
        for (let x = -4; x <= 4; x++) cells.add(cell(lat + y / 100, lon + x / 100));
    }
}
const vehicleWay = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$|^(unclassified|residential|service|living_street|road|track)$/;
const nodes = new Map(), ways = [], unchanged = new Map();
for await (const item of createOSMStream(pbf)) {
    if (item.type === 'node' && cells.has(cell(item.lat, item.lon))) {
        nodes.set(item.id, [item.lon, item.lat]);
        const record = byNode.get(item.id);
        if (record && item.lat === record.position.lat && item.lon === record.position.lon &&
            item.tags?.highway === 'speed_camera' && item.tags.direction === record.rawDirection &&
            (item.tags['maxspeed:conditional'] || '') === (record.cameraLimitConditional || '') &&
            !Object.keys(item.tags).some(key => key.startsWith('maxspeed:') && key !== 'maxspeed:conditional')) {
            unchanged.set(item.id, item.tags);
        }
    } else if (item.type === 'way' && vehicleWay.test(item.tags?.highway) && item.refs.some(id => nodes.has(id))) {
        ways.push(item);
    }
}
const bearing = ([x, y]) => (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
const difference = (a, b) => Math.abs((a - b + 540) % 360 - 180);
function direction(tags) {
    if (tags.oneway === '-1') return -1;
    if (tags.oneway === 'no') return 0;
    if (tags.oneway === 'yes' || tags.oneway === '1' ||
        !tags.oneway && (tags.highway === 'motorway' || tags.junction === 'roundabout')) return 1;
    return 0;
}
function limit(tags) {
    if (Object.keys(tags).some(key => key.startsWith('maxspeed:') && key !== 'maxspeed:type' && key !== 'maxspeed:source')) return null;
    return typeof tags.maxspeed === 'string' && /^\d{1,3}$/.test(tags.maxspeed) &&
        Number(tags.maxspeed) >= 5 && Number(tags.maxspeed) <= 130 ? Number(tags.maxspeed) : null;
}
const zones = [];
for (const [nodeId, cameraTags] of unchanged) {
    const camera = byNode.get(nodeId);
    const {lat, lon} = camera.position;
    const parents = ways.filter(w => w.refs.includes(nodeId));
    if (parents.length !== 1) continue;
    const way = parents[0];
    const cam = way.refs.indexOf(nodeId);
    if (cam === 0 || cam === way.refs.length - 1 || cam !== way.refs.lastIndexOf(nodeId) ||
        way.tags.oneway && !['yes', 'no', '1', '-1'].includes(way.tags.oneway) ||
        way.tags['oneway:conditional'] || way.tags.junction === 'roundabout') continue;
    const metres = 111320 * Math.cos(lat * Math.PI / 180);
    const xy = ([x,y]) => [Math.round((x - lon) * metres), Math.round((y - lat) * 111320)];
    const approach = (ref) => {
        const p = nodes.get(ref);
        if (!p) return null;
        const [x,y] = xy(p);
        return Math.hypot(x,y) >= 3 ? bearing([-x,-y]) : null;
    };
    const previous = approach(way.refs[cam-1]), next = approach(way.refs[cam+1]);
    const mappedFlow = (Number(camera.rawDirection) + 180) % 360;
    const dir = direction(way.tags);
    const forward = dir !== -1 && previous !== null && difference(previous, mappedFlow) <= 25;
    const reverse = dir !== 1 && next !== null && difference(next, mappedFlow) <= 25;
    if (forward === reverse) continue;
    const roads = [];
    for (const other of ways) {
        let pts = [], cameraIndex = -1;
        function finish() {
            if (pts.length >= 2) roads.push({id:other.id, pts, cam:cameraIndex, dir:direction(other.tags)});
            pts = [];
            cameraIndex = -1;
        }
        for (const ref of other.refs) {
            const ll = nodes.get(ref);
            if (!ll || Math.abs((ll[0] - lon) * metres) > 1700 || Math.abs((ll[1] - lat) * 111320) > 1700) {
                finish();
                continue;
            }
            if (ref === nodeId) cameraIndex = pts.length;
            pts.push(xy(ll));
        }
        finish();
    }
    if (roads.length > 220 || !roads.some(r => r.cam > 0 && r.cam < r.pts.length - 1)) continue;
    const roadLimit = limit(way.tags);
    const record = {id:camera.id, lat, lon, limit:null, coverageRadiusM:500,
        travel:[Math.round(forward ? previous : next)], roads, facing:camera.rawDirection,
        osmVersion:camera.osmVersion, cameraLimitConditional:camera.cameraLimitConditional || null,
        cameraLimitKmh:camera.limitKmh};
    if (roadLimit !== null && !camera.cameraLimitConditional &&
        (camera.limitKmh === null || camera.limitKmh === roadLimit) &&
        (!cameraTags.maxspeed || limit(cameraTags) === roadLimit)) {
        record.roadMapLimitKmh = roadLimit;
        record.roadMapLimitSource = {provider:'openstreetmap', tag:'maxspeed', wayId:way.id, sourceTimestamp};
    }
    zones.push(record);
}
zones.sort((a,b) => a.id.localeCompare(b.id));
fs.writeFileSync(output, JSON.stringify({schema:1, sourceTimestamp, pbfMd5, zones}) + '\n', {flag:'wx'});
console.log(JSON.stringify({eligible:eligible.length, unchanged:unchanged.size, zones:zones.length,
    maxspeed:zones.filter(z => z.roadMapLimitSource).length}));
