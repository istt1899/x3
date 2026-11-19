'use strict';
// On some head units Linux process time is centuries ahead of both iDrive
// and GNSS. A readable RTC is optional. Never write either clock.
var fs = require('fs');
var createReferenceClock = require('./reference-clock').createReferenceClock;
function readRtc() {
  var value = fs.readFileSync('/sys/class/rtc/rtc0/since_epoch', 'utf8').trim();
  return /^\d{10}$/.test(value) ? Number(value) * 1000 : NaN;
}
function createGpsClock(options) {
  options = options || {};
  var wall = options.wallNow || Date.now;
  var mono = options.monotonicNow || function () { return process.uptime() * 1000; };
  var read = options.readRtc || readRtc;
  var phone = createReferenceClock({wallNow:wall, monotonicNow:mono});
  var prev, edge, edges = 0, nextPoll = 0, rtc = false, lastRmc = null, advancedAt = null;
  function clearRtc() { prev = edge = null; edges = 0; rtc = false; }
  function sample() {
    var m = mono(), wallMs = wall();
    if (new Date(wallMs).getUTCFullYear() <= 2099) {
      clearRtc(); lastRmc = advancedAt = null; nextPoll = 0; return;
    }
    if (prev && (m < prev.m || m - prev.m > 1800 || Math.abs((wallMs-prev.wall) - (m-prev.m)) > 250)) {
      clearRtc(); lastRmc = advancedAt = null; nextPoll = 0;
    }
    if (m < nextPoll) return;
    nextPoll = m + 100;
    var value;
    try { value = read(); } catch (err) { clearRtc(); nextPoll = m + 60000; return; }
    if (!Number.isSafeInteger(value) || value % 1000 !== 0 || value < Date.UTC(2020,0,1) || value >= Date.UTC(2100,0,1)) {
      clearRtc(); nextPoll = m + 60000; return;
    }
    if (prev && prev.value !== value) {
      if (value === prev.value + 1000 && m - prev.m <= 650) {
        var mid = (m + prev.m) / 2;
        if (edge && Math.abs((value-edge.utc) - (mid-edge.m)) > 400) clearRtc();
        edge = {utc:value, m:mid}; edges++;
      } else clearRtc();
    } else if (edge && m - edge.m > 1500) clearRtc();
    prev = {value:value, m:m, wall:wallMs};
    if (!rtc && edges >= 2 && advancedAt !== null && m-advancedAt <= 1500 &&
        Math.abs((edge.utc+m-edge.m) - (lastRmc+m-advancedAt)) <= 1250) rtc = true;
  }
  var previousSource = 'system', epoch = 0;
  function snapshot() {
    sample();
    var state = phone.snapshot();
    if (rtc) Object.assign(state,{referenceSource:'rtc',referenceUtcMs:Math.round(edge.utc + mono() - edge.m),
      calibrationTargetUtcMs:null,referenceExpiresInMs:null});
    if (previousSource !== state.referenceSource) { epoch++; previousSource = state.referenceSource; }
    state.referenceEpoch = epoch;
    return state;
  }
  return {
    now:function () { return snapshot().referenceUtcMs; },
    observeRmc:function (utc) {
      if (Number.isFinite(utc) && (lastRmc === null || utc > lastRmc)) {
        advancedAt = lastRmc !== null && utc-lastRmc <= 3000 ? mono() : null;
        lastRmc = utc;
      }
      phone.observeRmc(utc);
    },
    confirm:function (utc) { sample(); return !rtc && phone.confirm(utc); },
    snapshot:snapshot
  };
}
module.exports = {createGpsClock:createGpsClock};
