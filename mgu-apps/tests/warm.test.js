// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const model = require('../apps/marku_x3_warm/model.js');
const store = require('../apps/marku_x3_warm/store.js');

assert.deepStrictEqual(model.normalizeTemperatures({ temperatureEngineOilDrive: 90, temperatureEngineDrive: 103 }), { oil: 42, coolant: 55, known: true });
assert.strictEqual(model.normalizeTemperatures({ temperatureEngineOilDrive: 255, temperatureEngineDrive: 65535 }).known, false);
assert.strictEqual(model.normalizeOutside({ temperatureExterior: 66 }), -7);
assert.strictEqual(model.normalizeEngine({ statusEngineRunDrive: 'MOTOR_LAEUFT' }), 'running');
const estimator = new model.WarmEstimator(null);
let estimate = estimator.estimate(0, 20, 30);
assert.strictEqual(estimate.calculated, false);
estimator.add(60000, 20, 40);
estimator.add(120000, 20, 50);
estimate = estimator.estimate(120000, 20, 50);
assert.strictEqual(estimate.calculated, true);
assert.strictEqual(estimate.minutes, 4);
assert.strictEqual(model.recommendation(-7, 5).level, 2);
assert.strictEqual(model.recommendation(10, 5).level, 0);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-warm-test-'));
try {
  const file = path.join(temp, 'warm.json');
  store.save(file, estimator.toJSON(), Array.from({ length: 25 }, (_, index) => ({ at: index, minutes: 8 })));
  assert.strictEqual(store.load(file).records.length, 20);
  console.log('warm.test.js: OK');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
