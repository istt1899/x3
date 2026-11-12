// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const fs = require('fs');
const path = require('path');
const { Trips, validTrip } = require('./model.js');

function load(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { trips: new Trips(value), corrupted: false };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { trips: new Trips(null), corrupted: false };
    try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch (_) {}
    return { trips: new Trips(null), corrupted: true };
  }
}

function save(file, trips) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(trips.toJSON(), null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function saveCsv(file, content) {
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

module.exports = { load, save, saveCsv, validTrip };
