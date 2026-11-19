'use strict';

const fs = require('fs');
const { createNetworkUtc } = require('./network-utc');
const MIN_UTC = Date.UTC(2020, 0, 1);
const MAX_UTC = Date.UTC(2100, 0, 1);

function plausible(utc) {
  return Number.isSafeInteger(utc) && utc >= MIN_UTC && utc < MAX_UTC;
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
  let lastRmc = null, advancing = false, lastSample = null, waitingSince = null;
  let source = null, epoch = 0;

  function clearRtc() { previous = edge = null; edges = 0; }
  function closeNetwork() { if (network) network.close(); network = null; }
  function reset() {
    clearRtc(); closeNetwork(); nextPoll = 0; lastRmc = null; advancing = false; waitingSince = null;
  }
  function pollRtc(m) {
    if (m < nextPoll) return;
    nextPoll = m + 100;
    let value;
    try { value = read(); } catch (err) { value = null; }
    if (!plausible(value) || value % 1000 !== 0) {
      clearRtc(); nextPoll = m + 60000; return;
    }
    if (previous && previous.value !== value) {
      if (value === previous.value + 1000 && m - previous.m <= 650) {
        const mid = (m + previous.m) / 2;
        if (edge && Math.abs((value - edge.utc) - (mid - edge.m)) > 400) clearRtc();
        edge = { utc:value, m:mid }; edges++;
      } else clearRtc();
    } else if (edge && m - edge.m > 1500) clearRtc();
    previous = { value, m };
  }
  function agrees(utc, m) {
    return advancing && m - lastRmc.m <= 1500 && Math.abs(utc - (lastRmc.utc + m - lastRmc.m)) <= 1250;
  }
  function snapshot() {
    const m = mono(), wallMs = wall();
    let selected = 'system', utc = wallMs;
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
      if (rtcUtc !== null && (source === 'rtc' || agrees(rtcUtc, m))) {
        selected = 'rtc'; utc = rtcUtc; closeNetwork();
      } else if (m - waitingSince >= 4000) {
        if (!network) network = openNetwork({ wallNow:wall, monotonicNow:mono });
        const networkUtc = network.now();
        if (plausible(networkUtc) && (source === 'network' || agrees(networkUtc, m))) {
          selected = 'network'; utc = networkUtc;
        }
      }
    } else if (waitingSince !== null) reset();
    if (source !== null && selected !== source) epoch++;
    source = selected;
    return { referenceState:source === 'waiting' ? 'waiting' : 'ready',
      referenceSource:source === 'waiting' ? 'system' : source,
      referenceUtcMs:utc, referenceEpoch:epoch, systemWallMs:wallMs };
  }
  function observeRmc(utc) {
    if (closed || wall() < MAX_UTC || !plausible(utc)) return;
    const m = mono();
    if (lastRmc && utc === lastRmc.utc) return;
    const step = lastRmc && utc - lastRmc.utc, elapsed = lastRmc && m - lastRmc.m;
    advancing = !!lastRmc && step > 0 && step <= 3000 && elapsed >= 100 && Math.abs(step - elapsed) <= 500;
    lastRmc = { utc, m };
  }
  return { now:() => snapshot().referenceUtcMs, observeRmc, snapshot,
    close() { closed = true; reset(); } };
}
module.exports = { createGpsClock, readRtc };
