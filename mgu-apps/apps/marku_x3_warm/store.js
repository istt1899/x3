// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const fs = require('fs');
const path = require('path');

function load(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      estimator: value && value.estimator,
      records: Array.isArray(value && value.records) ? value.records.filter((item) => item && isFinite(item.at)).slice(-20) : [],
      corrupted: false
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { estimator: null, records: [], corrupted: false };
    try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch (_) {}
    return { estimator: null, records: [], corrupted: true };
  }
}

function save(file, estimator, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ schema: 1, estimator, records: records.slice(-20) }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  return records.slice(-20);
}

module.exports = { load, save };
