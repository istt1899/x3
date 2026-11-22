'use strict';
const pack = require('./road-zones.json');
const reviewedRoads = require('./reviewed-road-zones.json');
let qleverRoads = { zones: [] };
try {
    const supplement = require('./qlever-road-zones.json');
    if (supplement.schema === 1 && Array.isArray(supplement.zones)) qleverRoads = supplement;
} catch (error) {
    // The packaged supplement may be missing or corrupt after a partial installation.
    // Its failure must not prevent the ordinary and reviewed camera zones from loading.
}
const database = require('./kaluga-speed.json');
const info = require('./camera-info');
const preferences = require('./alert-preferences');
const captureData = require('./capture-data');
const { validPosition, navigationAccuracyReady } = require('./gps-source');
function angle(x, y) { return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360; }
function diff(a, b) { return Math.abs((a - b + 540) % 360 - 180); }
function longitudeDelta(to, from) {
    const delta = to - from;
    return delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta;
}
function distance(a, b) {
    const x = longitudeDelta(b.lon, a.lon) * 111320 * Math.cos((a.lat + b.lat) * Math.PI / 360), y = (b.lat - a.lat) * 111320;
    return Math.hypot(x, y);
}
// Keep source order on exact ties and allocate only when an item makes top k.
function insertNearest(nearest, record, distanceM, limit) {
    let index = nearest.length;
    if (index === limit) {
        if (distanceM >= nearest[index - 1].distanceM) return;
        index--;
    }
    while (index > 0 && distanceM < nearest[index - 1].distanceM) {
        nearest[index] = nearest[index - 1];
        index--;
    }
    nearest[index] = { record, distanceM };
}
function prepare(z) {
    return Object.assign({}, z, { roads: z.roads.map(r => {
        const lengths = [0], segments = [];
        for (let i = 1; i < r.pts.length; i++) {
            const a = r.pts[i - 1], b = r.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
            lengths.push(lengths[i - 1] + len);
            if (len) segments.push({ x: a[0], y: a[1], dx, dy, len, s: lengths[i - 1], bearing: angle(dx, dy) });
        }
        return { segments, id: r.id, cam: r.cam < 0 ? null : lengths[r.cam], dir: r.dir };
    }) });
}
function project(road, x, y) {
    let nearest = null;
    for (const seg of road.segments) {
        const t = Math.max(0, Math.min(1, ((x - seg.x) * seg.dx + (y - seg.y) * seg.dy) / (seg.len * seg.len)));
        const error = Math.hypot(x - seg.x - t * seg.dx, y - seg.y - t * seg.dy);
        if (!nearest || error < nearest.error) nearest = { road, error, s: seg.s + t * seg.len, bearing: seg.bearing };
    }
    return nearest;
}
// A connecting approach can end at the camera's junction without containing
// the camera node. Its endpoint must be ahead, close to the actual device,
// and in a permitted travel direction.
function connectsAtCamera(hit, fix, travel) {
    const forward = diff(hit.bearing, fix.headingDeg) <= 32;
    const reverse = diff((hit.bearing + 180) % 360, fix.headingDeg) <= 32;
    if (!forward && !reverse) return false;
    const road = hit.road, sign = forward ? 1 : -1;
    if (road.dir && road.dir !== sign) return false;
    const end = forward ? road.segments[road.segments.length - 1] : road.segments[0];
    const x = end.x + (forward ? end.dx : 0), y = end.y + (forward ? end.dy : 0);
    const bearing = (end.bearing + (forward ? 0 : 180)) % 360;
    return Math.hypot(x, y) <= 10 && travel.some(h => diff(h, bearing) <= 35);
}
function candidate(z, fix, range, diagnostic, tracking) {
    const x = longitudeDelta(fix.lon, z.lon) * 111320 * Math.cos(z.lat * Math.PI / 180), y = (fix.lat - z.lat) * 111320;
    const reject = reason => { if (diagnostic) diagnostic.reason = reason; return null; };
    if (z.roadMapLimitSource) {
        range = Math.min(range, z.coverageRadiusM);
        if (!Number.isFinite(fix.accuracyM) || fix.accuracyM > 10) return reject('MAP_ACCURACY');
    }
    if (x * x + y * y > (range + 20) * (range + 20)) return reject('OUT_OF_RANGE');
    const hits = z.roads.map(r => project(r, x, y)).filter(Boolean).sort((a, b) => a.error - b.error), hit = hits[0];
    if (diagnostic && hit) { diagnostic.way = hit.road.id; diagnostic.lateralErrorM = hit.error; }
    // Retention never expands the source road corridor or its heading gates.
    const corridor = z.roadMapLimitSource ? Math.min(6, Math.max(3, fix.accuracyM)) :
        fix.accuracyM === null ? 6 : Math.min(12, Math.max(6, fix.accuracyM));
    if (!hit || hit.error > corridor) return reject('OFF_ROAD');
    if (hit.road.cam === null) {
        if (diagnostic) diagnostic.connectingWay = connectsAtCamera(hit, fix, z.travel);
        return reject('CAMERA_WAY_MISSING');
    }
    // Without metre uncertainty admit only well-separated roads.
    const ambiguityMargin = z.roadMapLimitSource ? Math.max(12, fix.accuracyM + 6) :
        fix.accuracyM === null ? ADMISSION_ACCURACY_M + 3 : Math.max(8, fix.accuracyM + 3);
    const tied = hits.slice(1).filter(other => other.error - hit.error < ambiguityMargin);
    if (tied.length) {
        if (diagnostic) diagnostic.unrelatedWay = tied.some(other =>
            other.road.cam === null && other.error - hit.error <= 4 &&
            !connectsAtCamera(other, fix, z.travel));
        return reject('AMBIGUOUS_ROAD');
    }
    if (tracking && hit.road.id !== tracking.way) return reject('ROAD_CHANGED');
    const offset = hit.road.cam - hit.s, sign = tracking ? tracking.sign : offset > 0 ? 1 : -1;
    const signedDistance = offset * sign, distanceM = Math.max(0, signedDistance);
    // A confirmed approach continues up to the actual point. Admission still
    // needs a camera at least eight metres ahead, not a just-passed point.
    if ((!tracking && distanceM < 8) || distanceM > range + 0.000001) return reject('OUT_OF_RANGE');
    if (hit.road.dir && hit.road.dir !== sign) return reject('ONEWAY_MISMATCH');
    if (diff((hit.bearing + (sign < 0 ? 180 : 0)) % 360, fix.headingDeg) > 32) return reject('HEADING_MISMATCH');
    const end = hit.road.cam - sign;
    const at = hit.road.segments.find(s => s.s <= end && end <= s.s + s.len);
    if (!at || !z.travel.some(h => diff(h, (at.bearing + (sign < 0 ? 180 : 0)) % 360) <= 35)) return reject('CAMERA_DIRECTION');
    if (tracking && signedDistance < -passMargin(fix)) {
        if (diagnostic) diagnostic.pastCamera = -signedDistance;
        return reject('CAMERA_PASSED');
    }
    const result = { id: z.id, way: hit.road.id, sign, distanceM, limitKmh: z.limit, confidence: 'road', roadConfirmed: true };
    if (z.roadMapLimitSource && hit.road.id === z.roadMapLimitSource.wayId) {
        result.roadMapLimitKmh = z.roadMapLimitKmh;
        result.roadMapLimitSource = z.roadMapLimitSource;
    }
    return result;
}
const ADMISSION_ACCURACY_M = 15;
/* Once a road approach is confirmed, brief GNSS quality degradation must not
 * flicker the warning. Road geometry, heading, freshness and distance
 * hysteresis still apply; this extends only the metric quality bound. */
const RETENTION_ACCURACY_M = 30;
/* Nearby mode (0.8.6): a camera without a road zone warns when it lies ahead
 * inside the owner's distance. Admission needs motion, the ahead cone and a
 * camera facing our stream when known; release needs the camera behind, a
 * recede beyond the jitter margin, or three consecutive growing distances.
 * Closer than AT_CAMERA the bearing is noise: the car is at the point. */
const NEARBY_ADMISSION_LATERAL_M = 18, NEARBY_RETENTION_LATERAL_M = 32;
const NEARBY_AHEAD_MAX_DEG = 40, NEARBY_BEHIND_DEG = 100, NEARBY_FACING_DEG = 45, NEARBY_AT_CAMERA_M = 15, NEARBY_GROWTH_EXIT = 3;
function key(item) { return item.id + ':' + item.way + ':' + item.sign; }
function mode(item) { return !item ? 'none' : item.roadConfirmed ? 'road' : 'nearby'; }
function passMargin(fix) { return fix.accuracyM === null ? 5 : Math.min(5, Math.max(2, fix.accuracyM / 2)); }
function jitter(fix) { return fix.accuracyM === null ? 6 : Math.max(6, Math.min(15, fix.accuracyM * 2)); }
function plausible(previous, next, fix, dt) {
    return previous && dt > 0 && dt <= 3 && Math.abs(previous.distanceM - next.distanceM) <= fix.speedKmh / 3.6 * dt * 2 + 6;
}
function approaches(previous, next, fix, dt) {
    return plausible(previous, next, fix, dt) && previous.distanceM - next.distanceM > .5;
}
// An accepted position may precede a brief gap in accuracy. Bound progress
// by both endpoint speeds and by the elapsed time since that position.
function reachable(from, to) {
    const seconds = (to.timeMs - from.timeMs) / 1000;
    const speed = Math.max(from.speedKmh || 0, to.speedKmh || 0) / 3.6;
    return seconds > 0 && distance(from, to) <= speed * seconds * 1.5 + 8;
}
function travelBearing(from, to) {
    return angle(longitudeDelta(to.lon, from.lon) * Math.cos(from.lat * Math.PI / 180), to.lat - from.lat);
}
function createGuidance(data) {
    const suppliedZones = (data || pack).zones;
    const records = data && data.records || (data ? data.zones.map(z => ({ id: z.id, position: { lat: z.lat, lon: z.lon },
        type: 'speed', controls: ['speed'], limitKmh: z.limit })) : database.records);
    const byId = {}, zoneById = {};
    records.forEach(r => { byId[r.id] = r; });
    const covered = new Set(suppliedZones.map(z => z.id));
    const reviewed = reviewedRoads.zones.filter(z => {
        const record = byId[z.id];
        return record && !covered.has(z.id) && record.position.lat === z.lat && record.position.lon === z.lon;
    });
    reviewed.forEach(z => covered.add(z.id));
    const mapZones = qleverRoads.zones.filter(z => {
        const record = byId[z.id];
        return record && !covered.has(z.id) && record.providerId === 'osm-russia' &&
            record.sourcePublishedAt === qleverRoads.sourceTimestamp &&
            record.position.lat === z.lat && record.position.lon === z.lon;
    });
    const zones = suppliedZones.map(prepare)
        .concat(reviewed.map(z => prepare(Object.assign({}, z, { roadOnly: true }))), mapZones.map(prepare));
    zones.forEach(z => { zoneById[z.id] = z; });
    const describeCamera = info.createDescriber(records);
    let prior = {}, priorNearby = {}, active = null, anchor = null, closest = null, heading = null, lastTime = null, lastSource = null, settingsKey = null;
    let enabledIds = null;
    function recordEnabled(record) {
        return !!record && (!enabledIds || enabledIds.has(record.id));
    }
    // A passed or wrong-road camera cannot instantly return via proximity.
    let passed = {}, passedRoad = {}, lastTransition = null, lastClear = null;
    // Consecutive fresh samples with a growing distance for the retained
    // nearby camera; three in a row release the warning.
    let nearbyGrowth = 0, pendingExit = null;
    /* 0.8.7 anti-flicker floor: a shown card lives at least this long unless
     * the camera was physically passed. */
    let activeSinceMs = null;
    let state = { mode: 'none', reason: 'WAITING_GPS', zoneCount: zones.length, cameraCount: records.length };
    function transition(previous, reason, f, gpsReason) {
        const changed = mode(previous) !== mode(active) || previous && active && previous.id !== active.id;
        const code = active ? !previous ? 'ENTERED' : 'SWITCHED' : previous ? 'CLEARED_' + reason : 'WAITING';
        if (changed || !lastTransition) lastTransition = { from: mode(previous), to: mode(active), reason: code,
            cameraId: active ? active.id : previous ? previous.id : null, timeMs: f && Number.isFinite(f.timeMs) ? f.timeMs : null };
        if (previous && (!active || previous.id !== active.id)) {
            lastClear = { reason, cameraId: previous.id, timeMs: f && Number.isFinite(f.timeMs) ? f.timeMs : null };
            if (gpsReason) lastClear.gpsReason = gpsReason;
        }
        // Routine 1 Hz ticks must not overwrite the explanation of a withdrawal.
        state.transition = Object.assign({}, lastTransition);
        state.lastClear = lastClear && Object.assign({}, lastClear);
    }
    function clear(reason, f, restart, gpsReason) {
        const previous = active;
        prior = {}; priorNearby = {}; active = anchor = closest = heading = null;
        pendingExit = null; nearbyGrowth = 0; activeSinceMs = null;
        if (restart) { lastTime = lastSource = null; settingsKey = null; passed = {}; passedRoad = {}; lastTransition = lastClear = null; nearbyGrowth = 0; activeSinceMs = null; }
        state = { mode: 'none', reason, zoneCount: zones.length, cameraCount: records.length };
        if (f && Number.isFinite(f.timeMs)) state.fixTimeMs = f.timeMs;
        transition(previous, reason, f, gpsReason); return null;
    }
    return { evaluate(f, now, enabled, rawPreferences) {
        if (f && Number.isFinite(f.extrapolatedMs)) return enabled ? active : clear('DISABLED', f);
        if (!enabled) return clear('DISABLED', f);
        const accuracyLimit = active ? RETENTION_ACCURACY_M : ADMISSION_ACCURACY_M;
        if (!validPosition(f, now, accuracyLimit)) {
            const why = !f ? 'FIX_MISSING' : !navigationAccuracyReady(f) && (!Number.isFinite(f.accuracyM) || f.accuracyM <= 0) ? 'ACCURACY_MISSING' :
                f.accuracyM > accuracyLimit ? (accuracyLimit === RETENTION_ACCURACY_M ? 'ACCURACY_EXCEEDS_30M' : 'ACCURACY_EXCEEDS_15M') :
                !Number.isFinite(f.timeMs) || !Number.isFinite(now) ? 'UTC_MISSING' : now - f.timeMs > 3000 ? 'UTC_EXPIRED' : f.timeMs > now + 500 ? 'UTC_FUTURE' : 'POSITION_INVALID';
            clear('GPS_INVALID', f, false, why); state.gpsReason = why;
            return null;
        }
        const prefs = preferences.normalize(rawPreferences), signature = JSON.stringify(prefs);
        const changedSettings = settingsKey !== null && signature !== settingsKey;
        if (changedSettings) { prior = {}; priorNearby = {}; nearbyGrowth = 0; }
        if (settingsKey !== signature) {
            enabledIds = Object.keys(prefs.cameraTypes).every(type => prefs.cameraTypes[type]) ? null :
                new Set(records.filter(record => preferences.matches(record, prefs)).map(record => record.id));
            settingsKey = signature;
        }
        const fresh = lastTime === null || f.timeMs > lastTime;
        const dt = fresh && lastTime !== null ? (f.timeMs - lastTime) / 1000 : 0;
        if (!fresh) {
            if (active && !recordEnabled(byId[active.id])) return clear('TYPE_DISABLED', f);
            if (active && active.distanceM > prefs.warningDistanceM + 0.000001) return clear('OUT_OF_RANGE', f);
            const replay = f.timeMs < lastTime || distance(f, lastSource) > jitter(f);
            if (replay && active && lastTime <= now + 500 && now - lastTime <= 3000) {
                state = Object.assign({}, state, { holdReason: 'GPS_REPLAY', observedAtMs: now });
            } else if (replay) return clear('GPS_REPLAY', f);
            return active;
        }
        if (fresh) { lastTime = f.timeMs; lastSource = { lat: f.lat, lon: f.lon }; }
        const previous = active, range = prefs.warningDistanceM;
        const moving = Number.isFinite(f.speedKmh) && f.speedKmh >= 8 && Number.isFinite(f.headingDeg) && f.headingDeg >= 0 && f.headingDeg < 360;
        const trackingMoving = Number.isFinite(f.speedKmh) && f.speedKmh >= 3 && Number.isFinite(f.headingDeg) && f.headingDeg >= 0 && f.headingDeg < 360;
        const stopped = Number.isFinite(f.speedKmh) && f.speedKmh >= 0 && f.speedKmh < 3;
        // Retain the three diagnostics and nearest enabled point anywhere.
        // Admission still sees every enabled point within the warning range.
        const nearestRecords = [], inRange = [];
        let nearestEnabled = null;
        records.forEach((record, order) => {
            const distanceM = distance(f, record.position);
            insertNearest(nearestRecords, record, distanceM, 3);
            if (!recordEnabled(record)) return;
            if (!nearestEnabled || distanceM < nearestEnabled.distanceM) nearestEnabled = { record, distanceM };
            if (distanceM <= range + 0.000001) inRange.push({ record, distanceM, order });
        });
        inRange.sort((a, b) => a.distanceM - b.distanceM || a.order - b.order);
        const nearest = nearestEnabled || nearestRecords[0] || null, debug = {};
        const ownZone = nearest && zoneById[nearest.record.id];
        if (moving && ownZone) candidate(ownZone, f, range, debug);
        // Nearby (0.8.6) admission pre-pass: one rejection reason per in-range
        // enabled record, shared by the status, the candidate list and the
        // selection below. Out-of-range records are not candidates at all.
        const anchorRadius = f.accuracyM === null ? 15 : Math.max(15, Math.min(25, f.accuracyM * 2));
        const anchored = previous && anchor && distance(f, anchor) <= anchorRadius;
        const stationary = stopped && f.speedKmh <= 1;
        const course = trackingMoving ? f.headingDeg : stopped && anchored && Number.isFinite(heading) ? heading : null;
        const nearbyBlockReason = (r, d) => {
            if (!moving) return 'STATIONARY';
            if (course === null) return 'COURSE_UNKNOWN';
            if (d > range + 0.000001) return 'OUT_OF_RANGE';
            if (d <= NEARBY_AT_CAMERA_M) return null;
            const dx = longitudeDelta(r.position.lon, f.lon) * Math.cos(f.lat * Math.PI / 180), dy = r.position.lat - f.lat;
            const delta = diff(angle(dx, dy), course);
            if (delta > NEARBY_BEHIND_DEG) return 'BEHIND';
            if (delta > NEARBY_AHEAD_MAX_DEG) return 'OFF_COURSE';
            if (d * Math.sin(delta * Math.PI / 180) > NEARBY_ADMISSION_LATERAL_M) return 'OFF_ROUTE';
            // 0.8.7: warn from either side; a camera verified to look across
            // the road (not at our stream) is rejected as DIRECTION.
            const { capture, cameraFacing } = describeCamera(r);
            if (capture && capture.verified === true &&
                captureData.classify(capture, course, cameraFacing) === 'cross') return 'DIRECTION';
            return null;
        };
        const nearbyReject = {};
        let candidateCount = 0;
        for (const item of inRange) {
            // A camera with a road zone belongs to the road logic; nearby is
            // only for zone-less records and never preempts road confirmation.
            if (zoneById[item.record.id]) continue;
            candidateCount++;
            nearbyReject[item.record.id] = nearbyBlockReason(item.record, item.distanceM);
        }
        state = { mode: 'none', reason: !nearestEnabled && nearestRecords.length ? 'TYPE_DISABLED' : !moving ? 'WAITING_MOTION' : debug.reason || (ownZone ? 'WAITING_APPROACH' : nearest ? (nearbyReject[nearest.record.id] || 'NO_ROAD_ZONE') : 'NO_ROAD_ZONE'),
            zoneCount: zones.length, cameraCount: records.length, cameraId: nearest && nearest.record.id,
            distanceM: nearest && nearest.distanceM, way: debug.way || null, lateralErrorM: debug.lateralErrorM,
            fixTimeMs: f.timeMs, observedAtMs: now, approachSamples: 0, warningDistanceM: range,
            candidateCount: candidateCount, nearestReject: nearest ? nearbyReject[nearest.record.id] || null : null };
        state.roadReason = state.reason;
        state.candidates = nearestRecords.map(item => {
            const zone = zoneById[item.record.id], detail = {};
            if (moving && zone) candidate(zone, f, range, detail);
            return { id: item.record.id, distanceM: Math.round(item.distanceM), reason: !recordEnabled(item.record) ? 'TYPE_DISABLED' :
                item.distanceM > range + 0.000001 ? 'OUT_OF_RANGE' : !moving ? 'WAITING_MOTION' : zone ? detail.reason || 'WAITING_APPROACH' :
                (nearbyReject[item.record.id] || 'NO_ROAD_ZONE'),
                way: detail.way || null, lateralErrorM: detail.lateralErrorM === undefined ? null : detail.lateralErrorM };
        });
        const roadCandidates = moving ? zones.filter(z => recordEnabled(byId[z.id])).map(z => candidate(z, f, range)).filter(Boolean).sort((a, b) => a.distanceM - b.distanceM) : [];
        let selected = null, retained = false, clearReason = null, pastCamera = null;
        const whyJump = previous && anchor && fresh && !stationary && !reachable(anchor, f);
        if (previous && !recordEnabled(byId[previous.id])) clearReason = 'TYPE_DISABLED';
        else if (previous && previous.distanceM > range + 0.000001 && changedSettings) clearReason = 'OUT_OF_RANGE';
        else if (whyJump) clearReason = 'POSITION_JUMP';
        if (previous && stationary && !clearReason) {
            // Parked fixes can wander outside the road corridor. Keep the last
            // accepted geometry and distance within the stationary anchor.
            if (anchored) {
                selected = Object.assign({}, previous, { stopped: true });
                retained = true;
                if (previous.roadConfirmed) state.approachSamples = 2;
            } else clearReason = 'POSITION_JUMP';
        }
        if (previous && previous.roadConfirmed && !selected && !clearReason) {
            const detail = {}, zone = zoneById[previous.id];
            let tracking = null;
            if (course !== null && zone) tracking = candidate(zone, Object.assign({}, f, { headingDeg: course }), range, detail, previous);
            else detail.reason = 'WAITING_MOTION';
            if (tracking && closest !== null && tracking.distanceM > closest + jitter(f)) detail.reason = 'APPROACH_LOST';
            else if (tracking) { selected = tracking; retained = true; state.approachSamples = 2; }
            if (!selected) {
                clearReason = detail.reason || 'APPROACH_LOST';
                pastCamera = detail.pastCamera;
            }
        }
        // Independent histories avoid nearest-camera switching resetting entry.
        const canAdmit = !whyJump && validPosition(f, now);
        const confirmed = fresh && canAdmit ? roadCandidates.filter(next => {
            const traversal = key(next);
            return !passedRoad[traversal] && approaches(prior[traversal], next, f, dt);
        }) : [];
        // A reviewed official location can be upgraded to its verified OSM
        // approach. Distinct cameras remain locked to their own warnings.
        const upgrade = previous && !previous.roadConfirmed && confirmed.find(next => {
            const context = byId[next.id].officialSiteContext;
            return next.id === previous.id || context && context.scope === 'enforcement-location' &&
                context.sourceRecordId === previous.id;
        });
        const nextRoad = upgrade || confirmed[0] || null;
        if (nextRoad && (!previous || clearReason || upgrade) && !selected) {
            selected = nextRoad; retained = false; state.approachSamples = 2;
        } else if (!selected && roadCandidates.length) state.approachSamples = fresh && prior[key(roadCandidates[0])] ? 2 : 1;
        const nearbyCandidates = [];
        if (!selected && !(previous && stationary) && (!data || data.nearby !== false)) {
            const possible = [];
            for (const item of inRange) {
                const r = item.record, d = item.distanceM;
                const tracked = previous && !previous.roadConfirmed && previous.id === r.id;
                if (tracked ? clearReason === 'POSITION_JUMP' || clearReason === 'OUT_OF_RANGE' && changedSettings : !canAdmit) continue;
                const next = { id: r.id, distanceM: d, confidence: 'nearby', roadConfirmed: false, limitKmh: null };
                const zone = zoneById[r.id];
                if (zone) {
                    if (zone.roadOnly || course === null) continue;
                    const detail = {};
                    candidate(zone, Object.assign({}, f, { headingDeg: course }), range, detail);
                    // A positive match onto a different road vetoes proximity,
                    // including near the device where the angle alone is weak.
                    const differentRoad = detail.reason === 'CAMERA_WAY_MISSING' && !detail.connectingWay;
                    const wrongDirection = ['ONEWAY_MISMATCH', 'HEADING_MISMATCH', 'CAMERA_DIRECTION'].indexOf(detail.reason) >= 0;
                    const ambiguousMapRoad = zone.roadMapLimitSource && detail.reason === 'AMBIGUOUS_ROAD';
                    if (differentRoad || detail.unrelatedWay || wrongDirection || ambiguousMapRoad) {
                        if (tracked) clearReason = detail.reason;
                        continue;
                    }
                    const dx = longitudeDelta(r.position.lon, f.lon) * Math.cos(f.lat * Math.PI / 180), dy = r.position.lat - f.lat;
                    const delta = diff(angle(dx, dy), course);
                    const lateral = d * Math.sin(delta * Math.PI / 180);
                    const aligned = lateral <= NEARBY_ADMISSION_LATERAL_M;
                    const immediate = moving && d <= 120 && aligned && (d <= 0.000001 || delta <= NEARBY_AHEAD_MAX_DEG);
                    const entry = moving && delta <= 25 && aligned;
                    const approaching = fresh && entry && approaches(priorNearby[r.id], next, f, dt);
                    if (entry) nearbyCandidates.push(next);
                    const continuation = delta <= NEARBY_AHEAD_MAX_DEG && lateral <= NEARBY_RETENTION_LATERAL_M;
                    const stable = tracked && !clearReason && closest !== null && d <= closest + jitter(f) &&
                        continuation;
                    if (stable) { next.retained = true; possible.push(next); }
                    else if ((!tracked && immediate && !passed[r.id] || approaching) && !(previous && previous.roadConfirmed && previous.id === r.id && clearReason)) {
                        if (approaching) delete passed[r.id];
                        possible.push(next);
                    } else if (tracked && !clearReason) {
                        clearReason = d > (closest === null ? d : closest) + jitter(f) ? 'APPROACH_LOST' : 'BEARING_CHANGED';
                    }
                    continue;
                }
                if (tracked) {
                    // Retention: the warning holds until the camera is behind,
                    // beyond the closest-sample release margin, or receding
                    // three fresh samples in a row. Stationary keeps it.
                    let reject = null;
                    const dx = longitudeDelta(r.position.lon, f.lon) * Math.cos(f.lat * Math.PI / 180), dy = r.position.lat - f.lat;
                    const delta = course === null ? null : diff(angle(dx, dy), course);
                    const passedCamera = delta !== null && delta > NEARBY_BEHIND_DEG &&
                        (d > NEARBY_AT_CAMERA_M || d * Math.cos(delta * Math.PI / 180) < -passMargin(f));
                    // Release distance is the owner's range plus the accuracy
                    // jitter; an all-time-minimum ratchet would flicker under
                    // ±10 m GNSS noise.
                    if (passedCamera) {
                        const alongApproach = anchor && Number.isFinite(heading) && diff(heading, course) <= 55;
                        const consistentMotion = pendingExit && pendingExit.reason === 'BEHIND' ? pendingExit.fix : anchor;
                        const forward = consistentMotion && distance(consistentMotion, f) > 0.5 &&
                            diff(travelBearing(consistentMotion, f), course) <= 55;
                        reject = alongApproach && forward ? 'BEHIND' : 'BEARING_CHANGED';
                    }
                    else if (d > range + jitter(f)) reject = 'OUT_OF_RANGE';
                    else if (delta !== null && d * Math.sin(delta * Math.PI / 180) > NEARBY_RETENTION_LATERAL_M) reject = 'OFF_ROUTE';
                    else if (fresh) {
                        if (previous && d > previous.distanceM + 0.000001) nearbyGrowth++;
                        else nearbyGrowth = 0;
                        if (nearbyGrowth >= NEARBY_GROWTH_EXIT) reject = 'RECEEDING';
                    }
                    if (reject) {
                        // Three-second show floor: geometry noise must not
                        // blink the card right after it appeared. Passing the
                        // camera (BEHIND) and impossible jumps stay critical.
                        if (activeSinceMs !== null && f.timeMs - activeSinceMs < 3000 && reject !== 'BEHIND' && reject !== 'POSITION_JUMP' && reject !== 'OFF_ROUTE' &&
                            d <= range + jitter(f) && !passedCamera) reject = null;
                    }
                    if (reject) {
                        clearReason = clearReason || reject;
                        nearbyGrowth = 0;
                    } else { next.retained = true; possible.push(next); }
                } else if (!passed[r.id] && nearbyReject[r.id] === null &&
                    !(previous && previous.roadConfirmed && previous.id === r.id && clearReason)) {
                    // Admission: motion, the ahead cone and the facing gate from
                    // the pre-pass on a fresh valid sample. A camera the car
                    // already passed as a road camera waits for a new approach.
                    possible.push(next);
                }
            }
            const old = possible.find(item => previous && !previous.roadConfirmed && item.id === previous.id && item.retained);
            const waitingForRoad = !previous && roadCandidates.some(item => {
                const traversal = key(item);
                return !passedRoad[traversal] && !prior[traversal];
            });
            const first = waitingForRoad ? null : possible[0] || null;
            selected = old || first;
            if (selected) { retained = !!selected.retained; delete selected.retained; }
            else nearbyGrowth = 0;
        } else nearbyGrowth = 0;
        const promoted = upgrade && selected === upgrade;
        if (previous && (!selected || selected.id !== previous.id && !promoted)) {
            const immediate = clearReason === 'TYPE_DISABLED' || changedSettings && clearReason === 'OUT_OF_RANGE' || clearReason === 'RECEEDING';
            const reason = clearReason || 'APPROACH_LOST';
            const routeDeparture = ['OFF_ROAD', 'AMBIGUOUS_ROAD', 'ROAD_CHANGED', 'CAMERA_WAY_MISSING', 'OFF_ROUTE',
                'HEADING_MISMATCH', 'ONEWAY_MISMATCH', 'CAMERA_DIRECTION', 'DIRECTION', 'BEARING_CHANGED',
                'APPROACH_LOST', 'OUT_OF_RANGE'];
            const sameDeparture = pendingExit && routeDeparture.includes(reason) && routeDeparture.includes(pendingExit.reason);
            const last = pendingExit && (pendingExit.reason === reason || sameDeparture) ? pendingExit.fix : null;
            const confirmedProgress = reason !== 'CAMERA_PASSED' || pendingExit && pastCamera > pendingExit.pastCamera + 0.5;
            const confirms = reason !== 'POSITION_JUMP' && last && f.timeMs - last.timeMs <= 3000 &&
                reachable(last, f) && confirmedProgress;
            if (!immediate && !confirms) {
                if (fresh) {
                    pendingExit = { reason, fix: f, pastCamera };
                    if (!whyJump) {
                        prior = {}; roadCandidates.forEach(item => { prior[key(item)] = item; });
                        priorNearby = {}; nearbyCandidates.forEach(item => { priorNearby[item.id] = item; });
                    }
                }
                state.mode = mode(previous); state.reason = reason; state.holdReason = reason;
                state.cameraId = previous.id; state.distanceM = previous.distanceM;
                state.way = previous.way || null;
                transition(previous, reason, f);
                if (previous.roadMapLimitSource && (routeDeparture.includes(reason) || reason === 'MAP_ACCURACY' || reason === 'POSITION_JUMP')) {
                    const held = Object.assign({}, previous);
                    delete held.roadMapLimitKmh;
                    delete held.roadMapLimitSource;
                    active = held;
                    return held;
                }
                return previous;
            }
            if (reason === 'BEHIND' || reason === 'CAMERA_PASSED') {
                passed[previous.id] = true;
                if (previous.displayId) passed[previous.displayId] = true;
                if (previous.roadConfirmed) passedRoad[key(previous)] = previous.id;
            }
            clearReason = reason;
        }
        if (fresh) pendingExit = null;
        if (fresh) {
            prior = {}; roadCandidates.forEach(item => { prior[key(item)] = item; });
            // A later return outside the approach range permits a new visit.
            Object.keys(passed).forEach(id => {
                if (distance(f, byId[id].position) > range + 20) delete passed[id];
            });
            Object.keys(passedRoad).forEach(traversal => {
                if (!passed[passedRoad[traversal]]) delete passedRoad[traversal];
            });
            priorNearby = {}; nearbyCandidates.forEach(item => { priorNearby[item.id] = item; });
        }
        active = selected ? Object.assign({}, describeCamera(byId[selected.id]), selected) : null;
        if (active && (!previous || previous.id !== active.id || mode(previous) !== mode(active))) activeSinceMs = f.timeMs;
        if (!active) activeSinceMs = null;
        if (active) {
            const same = previous && previous.id === active.id && mode(previous) === mode(active);
            closest = same && closest !== null ? Math.min(closest, active.distanceM) : active.distanceM;
            const sameDisplay = previous && (previous.id === active.id || promoted);
            active.displayId = sameDisplay ? previous.displayId : active.id;
            active.displayDistanceM = active.distanceM;
            if (sameDisplay) {
                active.displayDistanceM = previous.displayDistanceM;
                if (fresh && !stationary) active.displayDistanceM = Math.min(active.displayDistanceM, active.distanceM);
            }
            state.mode = mode(active);
            state.reason = active.stopped ? 'STOPPED_APPROACH' : active.roadConfirmed ? retained ? 'TRACKING_APPROACH' : 'ROAD_APPROACH' : retained ? 'NEARBY_TRACKING' : 'NEARBY_ONLY';
            if (active.roadConfirmed) state.roadReason = state.reason;
            else if (previous && previous.roadConfirmed && clearReason) state.roadReason = clearReason;
            state.cameraId = active.id; state.distanceM = active.distanceM;
            if (active.roadConfirmed) {
                state.way = active.way;
            }
            if (fresh && !stationary) {
                anchor = f;
                if (course !== null) heading = course;
            }
            else if (!same) { anchor = f; heading = null; }
            state.candidates.forEach(c => { if (c.id === active.id) c.reason = state.reason; });
        } else {
            anchor = closest = heading = null;
            if (previous) state.reason = state.roadReason = clearReason || (nearest && nearest.distanceM > range ? 'OUT_OF_RANGE' : state.reason);
        }
        transition(previous, clearReason || state.reason, f);
        return active;
    }, reset: () => clear('RESET', null, true), diagnostic: () => Object.assign({}, state), count: zones.length };
}
module.exports = { createGuidance, validPosition, longitudeDelta, insertNearest };
