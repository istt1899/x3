// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert');
const model = require('../apps/marku_daily_hud/model.js');
const render = require('../apps/marku_daily_hud/render.js');

assert.strictEqual(model.battery({ conditionBatteryChargingCondition: 84 }), 84);
assert.strictEqual(model.battery({ conditionBatteryChargingCondition: 65535 }), null);
const alerts = model.buildAlerts({
  battery: { conditionBatteryChargingCondition: 55 },
  tyrePressure: { actualValuePressureTyreFLH: 20, actualValuePressureTyreFRH: 22, actualValuePressureTyreRLH: 27, actualValuePressureTyreRRH: 26 },
  tyreTarget: { targetPressureTyreFLH: 23, targetPressureTyreFRH: 22, targetPressureTyreRLH: 27, targetPressureTyreRRH: 27 },
  cbs: [{ cBSDataServiceListEntry: { cBSIdentifier: 1, cBSColor: 'YELLOW' } }],
  batteryThreshold: 60
});
assert.strictEqual(alerts.active.kind, 'cbs');
assert.strictEqual(alerts.tyreAlert.delta, -0.3);
assert.strictEqual(alerts.batteryAlert.text, '12V LOW 55%');
assert.strictEqual(model.buildAlerts({ battery: null, tyrePressure: null, tyreTarget: null, cbs: null, batteryThreshold: 60 }).active, null);
const frame = render.rgbaAlert('12V LOW 55%', 'yellow');
assert.strictEqual(frame.width, 480);
assert.strictEqual(frame.height, 96);
assert.strictEqual(frame.pixels.length, 480 * 96 * 4);
assert(frame.pixels.some((value) => value === 255));
console.log('hud.test.js: OK');
