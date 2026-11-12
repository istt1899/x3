// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const cp = require('child_process');
const path = require('path');
const tests = ['health.test.js', 'warm.test.js', 'hud.test.js', 'home.test.js', 'trips.test.js', 'app_kit.test.js', 'package.test.js'];
for (const test of tests) {
  console.log('== ' + test + ' ==');
  cp.execFileSync(process.execPath, [path.join(__dirname, test)], { stdio: 'inherit', windowsHide: true });
}
