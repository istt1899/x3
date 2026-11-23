'use strict';

// Display evidence is scoped to the selected camera by the guidance engine.
// Driving policy reads the independently confirmed road limit.
function valid(value) { return Number.isInteger(value) && value > 0 && value <= 300; }
function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d{1,3})?Z)?$/.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value.slice(0, 10) ? value : null;
}
function select(alert) {
    const candidates = [];
    function add(value, scope, source, sourceDate, dateKind) {
        if (valid(value)) candidates.push({value, scope, source, sourceDate:date(sourceDate), dateKind:dateKind || 'record'});
    }
    const road = alert.roadConfirmed === true;
    const approach = alert.speedcamApproach;
    const mapped = alert.roadMapLimitSource;
    if (road) add(alert.limitKmh, 'road', 'Подтверждённый подход', alert.roadLimitUpdatedAt);
    if (road) add(alert.postedApproachLimitKmh, 'posted', 'Знак на подходе', alert.postedApproachUpdatedAt);
    if (road && mapped && mapped.provider === 'openstreetmap' && mapped.tag === 'maxspeed' &&
        Number.isSafeInteger(mapped.wayId) && mapped.wayId > 0 && String(mapped.wayId) === String(alert.way) && date(mapped.sourceTimestamp)) {
        add(alert.roadMapLimitKmh, 'map', 'OpenStreetMap', mapped.sourceTimestamp, 'edition');
    }
    if (!alert.cameraLimitConditional) {
        if (!alert.gpsHeld && approach && approach.source === 'SpeedCamOnLine' && /^sco:[a-f0-9]{20}$/.test(approach.id) &&
            Number.isInteger(approach.courseDeg) && approach.courseDeg >= 0 && approach.courseDeg < 360) {
            add(approach.limitKmh, 'speedcam', approach.source, approach.sourceDate, 'edition');
        }
        const ref = alert.limitReference;
        if (ref && Array.isArray(ref.records)) {
            ref.records.forEach(record => add(record.valueKmh, 'camera', ref.source, record.sourceDate));
        }
        // A source object is required. A bare speed from a nearby road has no camera identity.
        if (alert.id && alert.provenance && alert.sourceUrl &&
            !(ref && ref.state === 'known' && ref.valueKmh === alert.cameraLimitKmh)) {
            add(alert.cameraLimitKmh, 'camera', alert.provenance, alert.cameraLimitDate, alert.cameraLimitDateKind);
        }
    }
    const values = Array.from(new Set(candidates.map(c => c.value))).sort((a, b) => a - b);
    const empty = {value:null, scope:'unknown', source:null, sourceDate:null, state:'unknown', values};
    if (!values.length) return empty;
    // A source may publish a day rather than an instant. Overlapping time
    // intervals cannot order two conflicting publications within that day.
    const groups = values.map(value => {
        const reports = candidates.filter(c => c.value === value);
        const dated = reports.filter(c => c.sourceDate).sort((a,b) => Date.parse(b.sourceDate) - Date.parse(a.sourceDate));
        const newest = dated[0] || reports[0];
        const lower = newest.sourceDate ? Date.parse(newest.sourceDate) : null;
        const upper = dated.reduce((end,c) => Math.max(end,Date.parse(c.sourceDate) + (c.sourceDate.length === 10 ? 86399999 : 0)), -Infinity);
        return {value, reports, newest, lower, upper};
    });
    const winner = groups.length === 1 ? groups[0] : groups.find(g => g.lower !== null &&
        groups.every(other => other === g || other.lower !== null && g.lower > other.upper));
    if (!winner) return Object.assign(empty, {state:'conflict', scope:'conflict'});
    const chosen = groups.length === 1 ? winner.reports[0] : winner.newest;
    return Object.assign({}, chosen, {state:'known', values});
}
module.exports = {select};
