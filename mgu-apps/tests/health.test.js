// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const model = require('../apps/marku_x3_health/model.js');
const store = require('../apps/marku_x3_health/store.js');
const diagnostics = require('../apps/marku_x3_health/diagnostics.js');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-health-test-'));
try {
  const cbs = model.normalizeCbs([
    { cBSDataServiceListEntry: { cBSIdentifier: 1, cBSServcieName: 'Моторное масло', cBSServiceWay: '1 400 km', cBSServiceDate: '03/2027', cBSColor: 'GREEN' } },
    { cBSDataServiceListEntry: { cBSIdentifier: 3, cBSServcieName: 'Тормозная жидкость', cBSServiceDate: '11/2026', cBSColor: 'YELLOW' } }
  ], null);
  assert.strictEqual(cbs.items.length, 2);
  assert.strictEqual(cbs.items[1].color, 'yellow');
  assert.strictEqual(model.normalizeBattery({ conditionBatteryChargingCondition: 84 }), 84);
  assert.strictEqual(model.normalizeBattery({ conditionBatteryChargingCondition: 65535 }), null);
  const first = model.buildSnapshot({ now: 1000, cbs, battery: 84, ecus: model.normalizeEcus({ available: true, ecus: [{ address: 18, sgbd: '0F26E8' }], error: null }) });
  const second = model.buildSnapshot({ now: 2000, cbs, battery: 76, ecus: model.normalizeEcus({ available: true, ecus: [], error: null }) });
  const diff = model.diff(first, second);
  assert.strictEqual(diff.baseline, false);
  assert(diff.changes.some((change) => change.kind === 'battery' && change.direction === 'down'));
  assert(model.formatReport(second, diff).includes('не является общим заключением'));
  const file = path.join(temp, 'health-history.json');
  let kept = store.saveHistory(file, Array.from({ length: 25 }, (_, index) => ({ at: index, coverage: {}, summary: { verdict: 'partial' } })), 20);
  assert.strictEqual(kept.length, 20);
  assert.strictEqual(store.loadHistory(file).items.length, 20);
  fs.writeFileSync(file, '{broken');
  assert.strictEqual(store.loadHistory(file).corrupted, true);
  assert(fs.readdirSync(temp).some((name) => name.includes('.corrupt-')));
  assert.strictEqual(diagnostics.ERROR_CODES.SCAN_EMPTY, 'SCAN_EMPTY');
  console.log('health.test.js: OK');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
