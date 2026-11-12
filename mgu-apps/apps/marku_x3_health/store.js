// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const fs = require('fs');
const path = require('path');

function validSnapshot(value) {
  return value && typeof value === 'object' && typeof value.at === 'number' && value.coverage && value.summary;
}

function loadHistory(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = Array.isArray(parsed && parsed.items) ? parsed.items.filter(validSnapshot) : [];
    return { items, corrupted: false };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { items: [], corrupted: false };
    try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch (_) {}
    return { items: [], corrupted: true };
  }
}

function saveHistory(file, items, limit) {
  const safeLimit = [5, 10, 20].includes(Number(limit)) ? Number(limit) : 10;
  const kept = items.filter(validSnapshot).slice(-safeLimit);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ schema: 1, items: kept }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  return kept;
}

module.exports = { loadHistory, saveHistory, validSnapshot };
