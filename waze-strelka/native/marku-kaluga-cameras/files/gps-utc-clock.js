'use strict';

const fs = require('fs');
const { createNetworkUtc } = require('./network-utc');
const MIN_UTC = Date.UTC(2020, 0, 1);
const MAX_UTC = Date.UTC(2100, 0, 1);
const DAY_MS = 86400000;
const MAX_RMC_STEP_MS = 3000;
const MAX_RMC_AGE_MS = 1500;
const RMC_HISTORY_MS = MAX_RMC_STEP_MS + MAX_RMC_AGE_MS + 500;

function plausible(utc) {
  return Number.isSafeInteger(utc) && utc >= MIN_UTC && utc < MAX_UTC;
}

// Some BMW RMC streams carry an obsolete year. Keep their UTC time of day
// and require the same month and day on the independent clock, including
// packets received just across midnight.
function alignBmwRmc(utc, reference) {
  if (!Number.isSafeInteger(utc) || utc >= MIN_UTC || !plausible(reference)) return utc;
  const timeOfDay = utc % DAY_MS;
  const candidate = Math.round((reference - timeOfDay) / DAY_MS) * DAY_MS + timeOfDay;
  const reported = new Date(utc), aligned = new Date(candidate);
  return reported.getUTCMonth() === aligned.getUTCMonth() &&
    reported.getUTCDate() === aligned.getUTCDate() ? candidate : utc;
}

// Both kernel interfaces expose the hardware clock. Read date and time in one
// procfs snapshot so that midnight cannot combine two different calendar days.
function readRtc(readFile) {
  try {
    const seconds = readFile('/sys/class/rtc/rtc0/since_epoch', 'utf8').trim();
    if (/^\d{10}$/.test(seconds) && plausible(Number(seconds) * 1000)) return Number(seconds) * 1000;
  } catch (err) {}
  try {
    const status = readFile('/proc/driver/rtc', 'utf8');
    const day = /^rtc_date\s*:\s*(\d{4}-\d\d-\d\d)\s*$/m.exec(status);
    const time = /^rtc_time\s*:\s*(\d\d:\d\d:\d\d)\s*$/m.exec(status);
    if (day && time) {
      const stamp = day[1] + 'T' + time[1] + '.000Z';
      const utc = Date.parse(stamp);
      if (plausible(utc) && new Date(utc).toISOString() === stamp) return utc;
    }
  } catch (err) {}
  return null;
}

function createGpsClock(options) {
  options = options || {};
  const wall = options.wallNow || Date.now;
  const mono = options.monotonicNow || (() => process.uptime() * 1000);
  const read = options.readRtc || (() => readRtc(fs.readFileSync));
  const openNetwork = options.createNetworkUtc || createNetworkUtc;
  let network = null, closed = false;
  let previous = null, edge = null, edges = 0, nextPoll = 0;
  let rtcStatus = null;
  let rmcHistory = [], lastSample = null, waitingSince = null;
  let source = null, epoch = 0;

  function clearRtc() { previous = edge = null; edges = 0; }
  function closeNetwork() { if (network) network.close(); network = null; }
  function reset() {
    clearRtc(); closeNetwork(); nextPoll = 0; rmcHistory = []; waitingSince = null;
    rtcStatus = null;
  }
  function pollRtc(m) {
    if (m < nextPoll) return;
    nextPoll = m + 100;
    let value;
    try { value = read(); } catch (err) { value = null; }
    if (!plausible(value) || value % 1000 !== 0) {
      clearRtc(); rtcStatus = 'NO_UTC'; nextPoll = m + 60000; return;
    }
    if (previous && previous.value !== value) {
      if (value === previous.value + 1000 && m - previous.m <= 650) {
        const mid = (m + previous.m) / 2;
        if (edge && Math.abs((value - edge.utc) - (mid - edge.m)) > 400) clearRtc();
        edge = { utc:value, m:mid }; edges++;
      } else clearRtc();
    } else if (edge && m - edge.m > 1500) clearRtc();
    previous = { value, m };
    rtcStatus = edges >= 2 ? 'OK' : 'CHECK';
  }
  function agrees(utc, m) {
    // Only compare UTC values that match this independent clock at receipt.
    // An interleaved replay or a change of year must not break live progression.
    const matching = [];
    for (const sample of rmcHistory) {
      const age = m - sample.m;
      if (age < 0 || age > RMC_HISTORY_MS) continue;
      const expected = utc - age;
      const aligned = alignBmwRmc(sample.utc, expected);
      if (Math.abs(expected - aligned) > 1250) continue;
      if (age <= MAX_RMC_AGE_MS && matching.some(prior => {
        const step = aligned - prior.utc;
        const elapsed = sample.m - prior.m;
        return step > 0 && step <= MAX_RMC_STEP_MS && elapsed >= 100 && Math.abs(step - elapsed) <= 500;
      })) return true;
      matching.push({utc: aligned, m: sample.m});
    }
    return false;
  }
  function snapshot() {
    const m = mono(), wallMs = wall();
    let selected = 'system', utc = wallMs, referenceCandidate = null;
    if (lastSample && (wallMs >= MAX_UTC || lastSample.wall >= MAX_UTC) &&
        (m < lastSample.m || m - lastSample.m > 5000 ||
        Math.abs(wallMs - lastSample.wall - (m - lastSample.m)) > 250)) {
      reset();
      // An active source reacquired on this same tick still needs new fixes.
      epoch++; source = 'system';
    }
    lastSample = { m, wall:wallMs };
    if (!closed && wallMs >= MAX_UTC) {
      if (waitingSince === null) waitingSince = m;
      selected = 'waiting';
      pollRtc(m);
      const rtcUtc = edges >= 2 ? Math.round(edge.utc + m - edge.m) : null;
      if (rtcUtc !== null) referenceCandidate = 'rtc';
      if (rtcUtc !== null && (source === 'rtc' || agrees(rtcUtc, m))) {
        selected = 'rtc'; utc = rtcUtc; closeNetwork();
      } else if (m - waitingSince >= 4000) {
        if (!network) network = openNetwork({ wallNow:wall, monotonicNow:mono });
        const networkUtc = network.now();
        if (plausible(networkUtc)) {
          if (referenceCandidate === null) referenceCandidate = 'network';
          if (source === 'network' || agrees(networkUtc, m)) {
            selected = 'network'; utc = networkUtc;
          }
        }
      }
    } else if (waitingSince !== null) reset();
    if (source !== null && selected !== source) epoch++;
    source = selected;
    return { referenceState:source === 'waiting' ? 'waiting' : 'ready',
      referenceSource:source === 'waiting' ? 'system' : source,
      referenceCandidate:source === 'waiting' ? referenceCandidate : null,
      referenceUtcMs:utc, referenceEpoch:epoch, systemWallMs:wallMs, rtcStatus,
      networkStatus:network && typeof network.status === 'function' ? network.status() : null };
  }
  function observeRmc(utc) {
    if (closed || wall() < MAX_UTC || !Number.isSafeInteger(utc)) return;
    const m = mono();
    rmcHistory = rmcHistory.filter(sample => m - sample.m <= RMC_HISTORY_MS);
    if (rmcHistory.some(sample => sample.utc === utc)) return;
    rmcHistory.push({utc, m});
    if (rmcHistory.length > 64) rmcHistory.shift();
  }
  return { now:() => snapshot().referenceUtcMs, observeRmc, snapshot,
    bmwRmcUtc(utc, reference) {
      return wall() >= MAX_UTC && (source === 'rtc' || source === 'network') ? alignBmwRmc(utc, reference) : utc;
    },
    close() { closed = true; reset(); } };
}
module.exports = { createGpsClock, readRtc };
