'use strict';
const assert = require('assert');
const { createGpsClock, readRtc } = require('../native/marku-kaluga-cameras/files/gps-utc-clock');
const utc = Date.UTC(2026, 10, 19, 17, 18, 50);
const broken = Date.UTC(2179, 5, 5);

const proc = 'rtc_time\t: 17:18:50\nrtc_date\t: 2026-11-19\nalarm_IRQ\t: no\n';
assert.strictEqual(readRtc(path => {
  if (path === '/proc/driver/rtc') return proc;
  throw new Error('sysfs unavailable');
}), utc);
assert.strictEqual(readRtc(path => path.endsWith('/since_epoch') ? String(broken / 1000) : proc), utc);
assert.strictEqual(readRtc(() => proc.replace('11-19', '02-31')), null);
assert.strictEqual(readRtc(() => proc.replace('rtc_date', 'alrm_date')), null);
assert.strictEqual(readRtc(path => { assert(path.endsWith('/since_epoch')); return String(utc / 1000); }), utc);

let m = 0, base = broken, enabled = true, opened = 0, closed = 0, offset = 0;
const clock = createGpsClock({wallNow:() => base + m, monotonicNow:() => m,
  readRtc:() => null, createNetworkUtc:() => {
    opened++;
    return { now:() => enabled ? utc + m + offset : null, close() { closed++; } };
  }});
const snapshot = () => clock.snapshot();
const advance = ms => { m += ms; return snapshot(); };
const feed = (time = utc + m) => { clock.observeRmc(time); return snapshot(); };
assert.strictEqual(snapshot().referenceState, 'waiting');
assert.strictEqual(opened, 0);
advance(4000);
assert.strictEqual(opened, 1);
const oldRmc = utc - 14000;
feed(oldRmc);
advance(1000);
assert.strictEqual(feed(oldRmc).referenceState, 'waiting');
offset = -60000;
feed(); advance(1000);
assert.strictEqual(feed().referenceState, 'waiting');
offset = 0;
assert.strictEqual(snapshot().referenceSource, 'network');
assert.strictEqual(clock.now(), utc + m);
const activeEpoch = snapshot().referenceEpoch;
enabled = false;
assert.strictEqual(snapshot().referenceState, 'waiting');
assert(snapshot().referenceEpoch > activeEpoch);
advance(6000);
assert.strictEqual(closed, 1);
enabled = true;
advance(4000);
assert.strictEqual(snapshot().referenceState, 'waiting', 'Resume must see new RMC');
feed();
advance(1000);
assert.strictEqual(feed().referenceSource, 'network');
base = utc;
assert.strictEqual(snapshot().referenceSource, 'system');
assert.strictEqual(snapshot().referenceState, 'ready');
clock.close();
assert.strictEqual(opened, closed);
const healthy = createGpsClock({wallNow:() => utc, monotonicNow:() => 0,
  readRtc:() => { throw new Error('healthy wall must remain local'); },
  createNetworkUtc:() => { throw new Error('healthy wall must remain offline'); }});
assert.strictEqual(healthy.now(), utc);
healthy.close();
console.log('PASS automatic clock selection, read-only RTC interfaces, frozen/mismatched RMC, unavailable network, resume and recovery to healthy system');
