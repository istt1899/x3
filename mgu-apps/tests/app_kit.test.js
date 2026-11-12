// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { headUnit } = require('../../media/core/kit/tools/hu-stub.js');

const ROOT = path.resolve(__dirname, '..');
const PUBLISH = path.join(ROOT, 'dist', 'publish', 'mgu-five-apps');
const APPS = ['marku_x3_health', 'marku_x3_warm', 'marku_daily_hud', 'marku_x3_home', 'marku_x3_trips'];

async function runApp(id) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-five-hu-'));
  const archive = path.join(PUBLISH, `${id}@0.1.0.tgz`);
  const unpacked = path.join(temp, 'package');
  fs.mkdirSync(unpacked, { recursive: true });
  cp.execFileSync('tar', ['--force-local', '-xzf', archive], { cwd: temp });
  const stage = path.join(temp, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  fs.renameSync(unpacked, path.join(stage, 'source'));
  const failures = [];
  const hu = headUnit(stage, { dataDir: temp, fresh: true, log: {
    info() {}, warn() {}, debug() {}, error(message, error) { failures.push(error || message); }
  } });
  hu.ctx.app = hu;
  let watches = 0;
  hu.ctx.signals = { watch: async (iface, instance, handlers) => {
    watches += 1;
    if (handlers.statusCarSpeed2) handlers.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
    if (handlers.statusEngineTemperature) handlers.statusEngineTemperature({ temperatureEngineOilDrive: 90, temperatureEngineDrive: 103 });
    if (handlers.statusEngineStatus) handlers.statusEngineStatus({ statusEngineRunDrive: 'MOTOR_LAEUFT' });
    if (handlers.statusBattery2) handlers.statusBattery2({ conditionBatteryChargingCondition: 84 });
    if (handlers.statusRangeTankStatus) handlers.statusRangeTankStatus({ fluidLevelFuelTank: 40 });
    if (handlers.cbsDataServiceList) handlers.cbsDataServiceList([{ cBSDataServiceListEntry: { cBSIdentifier: 1, cBSServcieName: 'Моторное масло', cBSColor: 'GREEN' } }]);
    if (handlers.ExteriorTemperature) handlers.ExteriorTemperature({ temperatureExterior: 66 });
    return { available: true };
  } };
  hu.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert(watches > 0, `${id}: no SOME/IP watches`);
  assert.deepStrictEqual(failures, [], `${id}: runtime errors`);
  hu.emit('shutdown');
  fs.rmSync(temp, { recursive: true, force: true });
}

(async () => {
  for (const id of APPS) await runApp(id);
  console.log('app_kit.test.js: OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });
