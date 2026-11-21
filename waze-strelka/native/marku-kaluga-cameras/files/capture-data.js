'use strict';
// 0.8.7: one normalized camera-direction field from every source. The
// semantics of each source are fixed in docs/camera-direction-0.8.7.md;
// nothing here guesses beyond what a source states.
//
// capture = {
//   side:      'front' | 'rear' | 'both' | 'unknown'
//              (intrinsic, road-relative: 'front' = контролирует встречный
//               поток и фиксирует передние номера; известно только там, где
//               источник это прямо указывает — сейчас ГИБДД и владелец)
//   facingDeg: куда смотрит объектив, 0..360, null когда неизвестно
//   flowDeg:   азимут контролируемого потока, 0..360, null когда неизвестно
//   source:    'owner' | 'osm-direction' | 'osm-relation' | 'openspeedcam' | 'gibdd-text' | null
//   verified:  true только когда семантика поля подтверждена источником
// }
var orientation = require('./camera-orientation');

function fail(code, message) { var e = new Error(message || code); e.code = code; throw e; }
function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function angle(v) { return Number.isFinite(v) && v >= 0 && v < 360 ? Math.round(v) % 360 : null; }
function diff(a, b) { return Math.abs((a - b + 540) % 360 - 180); }
function bearingDeg(a, b) {
    if (!object(a) || !object(b) || ![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return null;
    var x = (b.lon - a.lon) * Math.cos((a.lat + b.lat) * Math.PI / 360), y = b.lat - a.lat;
    if (!x && !y) return null;
    return Math.round((Math.atan2(x, y) * 180 / Math.PI + 360) % 360);
}

/* OSM enforcement relation: members with roles from/to and geometry describe
 * the monitored traffic flow, not the lens (wiki/Relation:enforcement).
 * Several from-members mean the whole junction is controlled and the flow is
 * ambiguous: no direction is derived instead of picking an arbitrary one. */
function relationFlow(record) {
    var relations = record.enforcementRelations;
    if (!Array.isArray(relations)) return null;
    for (var i = 0; i < relations.length; i++) {
        var members = relations[i] && relations[i].members;
        if (!Array.isArray(members)) continue;
        var from = null, to = null, fromCount = 0;
        for (var j = 0; j < members.length; j++) {
            var m = members[j];
            if (!object(m) || !object(m.position)) continue;
            if (m.role === 'from') { from = m.position; fromCount++; }
            else if (m.role === 'to' && to === null) to = m.position;
        }
        if (fromCount !== 1) continue;
        var flow = bearingDeg(from, to);
        if (flow !== null) return flow;
    }
    return null;
}

/* ГИБДД пишет направление текстом в условиях работы: «Встречное/попутное». */
function gibddSide(text) {
    if (typeof text !== 'string' || !text.trim()) return 'unknown';
    var meet = /встречн/i.test(text), along = /попутн/i.test(text);
    if (meet && along) return 'both';
    if (meet) return 'front';
    if (along) return 'rear';
    return 'unknown';
}

function captureFor(record) {
    if (!object(record)) return null;
    if (record.provenance === 'owner-report') {
        var ownerSide = ['front', 'rear', 'both'].indexOf(record.captureSide) >= 0 ? record.captureSide : 'unknown';
        var ownerFacing = angle(record.facingDeg);
        if (ownerSide === 'unknown' && ownerFacing === null) return null;
        return { side: ownerSide, facingDeg: ownerFacing, flowDeg: null, source: 'owner', verified: true };
    }
    var facing = orientation.describe(record);
    if (facing.state === 'mapped' && Array.isArray(facing.bearingsDeg) && facing.bearingsDeg.length &&
        Number.isFinite(facing.bearingsDeg[0])) {
        // OSM direction / camera:direction — направление обзора объектива.
        return { side: 'unknown', facingDeg: Math.round(facing.bearingsDeg[0]) % 360, flowDeg: null,
            source: 'osm-direction', verified: true };
    }
    var flow = relationFlow(record);
    if (flow !== null) {
        /* Поток подтверждён геометрией relation; объектив на практике смотрит
         * навстречу контролируемому потоку — допущение зафиксировано в docs,
         * поэтому facingDeg здесь с verified=false. */
        return { side: 'unknown', facingDeg: (flow + 180) % 360, flowDeg: flow,
            source: 'osm-relation', verified: false };
    }
    var raw = record.rawDirection;
    if (typeof raw === 'string' && /^[0-9]{1,3}(?:\.[0-9]+)?$/.test(raw) && Number(raw) <= 360) {
        /* OpenSpeedcam, сообщественное соглашение: азимут контролируемого
         * потока. Публичная документация поля отсутствует — verified=false. */
        var oscFlow = Math.round(Number(raw)) % 360;
        return { side: 'unknown', facingDeg: (oscFlow + 180) % 360, flowDeg: oscFlow,
            source: 'openspeedcam', verified: false };
    }
    if (record.provenance === 'Госавтоинспекция' || /^gibdd:/.test(record.id || '')) {
        var side = gibddSide(record.operatingConditions ||
            (object(record.officialSiteContext) ? record.officialSiteContext.operatingConditions : null));
        if (side !== 'unknown') return { side: side, facingDeg: null, flowDeg: null, source: 'gibdd-text', verified: true };
    }
    return null;
}

function augment(database) {
    if (!object(database) || database.region !== 'RU-KLU' || !Array.isArray(database.records)) fail('CAPTURE_DATABASE');
    var result = JSON.parse(JSON.stringify(database));
    result.records = result.records.map(function (record) {
        var capture = captureFor(record);
        if (!capture) return record;
        var next = object(record.capture) ? record : Object.assign({}, record);
        next.capture = capture;
        return next;
    });
    var counts = { facingKnown: 0, sideKnown: 0, verified: 0 };
    result.records.forEach(function (record) {
        var capture = record.capture;
        if (!capture) return;
        if (Number.isFinite(capture.facingDeg)) counts.facingKnown++;
        if (capture.side !== 'unknown') counts.sideKnown++;
        if (capture.verified) counts.verified++;
    });
    result.captureMetadata = { counts: counts, documentedIn: 'docs/camera-direction-0.8.7.md' };
    return result;
}

/* Driver-relative class used by guidance gating and the card label. */
function classify(capture, courseDeg, cameraFacing) {
    if (!object(capture) || !Number.isFinite(courseDeg) || courseDeg < 0 || courseDeg >= 360) return 'unknown';
    if (capture.side === 'both') return 'both';
    var probes = [];
    if (capture.source === 'osm-direction' && cameraFacing && cameraFacing.state === 'mapped') {
        probes = cameraFacing.bearingsDeg.filter(Number.isFinite);
    }
    if (!probes.length && Number.isFinite(capture.facingDeg)) probes.push(capture.facingDeg);
    if (!probes.length && Number.isFinite(capture.flowDeg)) probes.push((capture.flowDeg + 180) % 360);
    if (!probes.length) return 'unknown';
    var front = false, rear = false;
    probes.forEach(function (b) {
        if (diff(b, (courseDeg + 180) % 360) <= 45) front = true;
        if (diff(b, courseDeg) <= 45) rear = true;
    });
    if (front && rear) return 'both';
    if (front) return 'front';
    if (rear) return 'rear';
    return 'cross';
}

module.exports = { augment: augment, captureFor: captureFor, classify: classify, bearingDeg: bearingDeg, gibddSide: gibddSide };
