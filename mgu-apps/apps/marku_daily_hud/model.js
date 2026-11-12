// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

function number(value) {
  return typeof value === 'number' && isFinite(value) && value !== 255 && value !== 65535 ? value : null;
}

function battery(value) {
  const raw = value && typeof value === 'object' ? value.conditionBatteryChargingCondition : value;
  const n = number(raw);
  return n !== null && n > 0 && n <= 100 ? Math.round(n) : null;
}

function tyre(values, targets) {
  const corners = [
    ['actualValuePressureTyreFLH', 'targetPressureTyreFLH'],
    ['actualValuePressureTyreFRH', 'targetPressureTyreFRH'],
    ['actualValuePressureTyreRLH', 'targetPressureTyreRLH'],
    ['actualValuePressureTyreRRH', 'targetPressureTyreRRH']
  ];
  for (let index = 0; index < corners.length; index += 1) {
    const actualRaw = values && values[corners[index][0]];
    const targetRaw = targets && targets[corners[index][1]];
    const actual = number(actualRaw) === null ? null : number(actualRaw) * 0.1;
    const target = number(targetRaw) === null ? null : number(targetRaw) * 0.1;
    if (actual === null || target === null || target <= 0 || actualRaw >= 65532 || targetRaw >= 65532) continue;
    const delta = Math.round((actual - target) * 100) / 100;
    if (Math.abs(delta) >= 0.25) return { kind: 'tyre', index, delta, text: 'TYRE ' + (delta > 0 ? '+' : '') + delta.toFixed(2) };
  }
  return null;
}

function cbs(value) {
  const array = Array.isArray(value) ? value : value && (value.cbsDataServiceList || value.value) || [];
  for (const entry of array) {
    const wrapped = entry && (entry.cBSDataServiceListEntry || entry);
    const color = String(wrapped && wrapped.cBSColor || '').toUpperCase();
    if (color === 'RED' || color === 'YELLOW' || color === 'ORANGE') {
      return { kind: 'cbs', color: color === 'RED' ? 'red' : 'yellow', text: color === 'RED' ? 'SERVICE NOW' : 'SERVICE SOON' };
    }
  }
  return null;
}

function pickAlert(input) {
  return input.cbsAlert || input.tyreAlert || input.batteryAlert || null;
}

function buildAlerts(input) {
  const batteryValue = battery(input.battery);
  const tyreAlert = tyre(input.tyrePressure, input.tyreTarget);
  const cbsAlert = cbs(input.cbs);
  const batteryAlert = batteryValue !== null && batteryValue < input.batteryThreshold ? { kind: 'battery', text: '12V LOW ' + batteryValue + '%' } : null;
  return { batteryValue, tyreAlert, cbsAlert, batteryAlert, active: pickAlert({ cbsAlert, tyreAlert, batteryAlert }) };
}

module.exports = { number, battery, tyre, cbs, pickAlert, buildAlerts };
