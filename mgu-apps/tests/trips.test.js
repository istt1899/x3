// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Trips, END_MS, csv } = require('../apps/marku_x3_trips/model.js');
const store = require('../apps/marku_x3_trips/store.js');

const trips = new Trips(null);
trips.feed(0, { speed: 0, running: 'running', tank: 40 });
for (let now = 5000; now <= 600000; now += 5000) {
  trips.feed(now, { speed: 60, running: 'running', tank: 40 - 5 * now / 600000 });
}
trips.feed(600000 + END_MS + 1, { speed: 0, running: 'off', tank: 35 });
assert.strictEqual(trips.trips.length, 1);
assert.strictEqual(trips.trips[0].km, 10);
assert.strictEqual(trips.trips[0].fuel, 5);
trips.setCategory(trips.trips[0].id, 'Работа');
assert.strictEqual(trips.trips[0].category, 'Работа');
trips.setPrice(70);
assert.strictEqual(trips.trips[0].cost, 330);
assert(csv(trips.trips, 70).includes('Работа'));
assert(csv(trips.trips, 70).includes('330'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-trips-test-'));
try {
  const file = path.join(temp, 'trips.json');
  store.save(file, trips);
  assert.strictEqual(store.load(file).trips.trips.length, 1);
  fs.writeFileSync(file, '{bad');
  assert.strictEqual(store.load(file).corrupted, true);
  console.log('trips.test.js: OK');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
