// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const CBS_NAMES = {
  0x01: 'Моторное масло', 0x02: 'Передние тормозные колодки', 0x03: 'Тормозная жидкость',
  0x05: 'Service Inclusive', 0x06: 'Задние тормозные колодки', 0x07: 'Сажевый фильтр',
  0x0A: 'Свечи / накал', 0x11: 'Осмотр', 0x20: 'Техосмотр', 0x21: 'Экологический контроль',
  0x23: 'Масло АКПП', 0x31: 'Шины', 0x64: 'Проверка автомобиля'
};
const COLORS = { RED: 'red', YELLOW: 'yellow', ORANGE: 'yellow', GREEN: 'green', DEFAULT: 'unknown' };

function pick(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  if (object[key] !== undefined) return object[key];
  const wrapped = object[key === 'cBSServiceName' ? 'cBSServcieName' : key];
  if (wrapped !== undefined) return wrapped;
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object') {
      const found = pick(value, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    for (const key of ['value', 'text', 'cBSServiceName', 'cBSServcieName', 'cBSDataSBAText']) {
      if (value[key] !== undefined) return text(value[key]);
    }
    return '';
  }
  return String(value).trim();
}

function color(value) {
  const key = text(value).toUpperCase();
  return COLORS[key] || 'unknown';
}

function normalizeCbs(listValue, summaryValue) {
  const array = Array.isArray(listValue) ? listValue :
    (listValue && (listValue.cbsDataServiceList || listValue.value)) || [];
  const items = array.map((entry) => ({
    id: pick(entry, 'cBSIdentifier'),
    name: text(pick(entry, 'cBSServiceName') || pick(entry, 'cBSServcieName')),
    way: text(pick(entry, 'cBSServiceWay')),
    date: text(pick(entry, 'cBSServiceDate')),
    color: color(pick(entry, 'cBSColor'))
  })).filter((item) => item.id !== undefined && item.id !== null && item.name);
  const summary = summaryValue ? {
    name: text(pick(summaryValue, 'cBSDataSBAText')),
    way: text(pick(summaryValue, 'cBSDataSBADistance')),
    date: text(pick(summaryValue, 'cBSDataSBADate')),
    color: color(pick(summaryValue, 'cBSDataSBAColor'))
  } : null;
  return { items, summary, known: items.length > 0 || !!summary };
}

function normalizeBattery(value) {
  const raw = value && typeof value === 'object' ? value.conditionBatteryChargingCondition : value;
  if (typeof raw !== 'number' || !isFinite(raw) || raw <= 0 || raw > 100) return null;
  return Math.round(raw);
}

function normalizeEcus(result) {
  if (!result || !Array.isArray(result.ecus)) return { known: false, items: [], error: result && result.error || null };
  return { known: true, items: result.ecus.map((ecu) => ({ address: ecu.address, sgbd: ecu.sgbd })), error: result.error || null };
}

function itemLine(item) {
  const parts = [item.name || (CBS_NAMES[item.id] || 'CBS ' + item.id)];
  if (item.way) parts.push(item.way);
  if (item.date) parts.push(item.date);
  if (item.color === 'red' || item.color === 'yellow') parts.push(item.color === 'red' ? 'срочно' : 'скоро');
  return parts.join(' · ');
}

function buildSnapshot(input) {
  const cbs = input.cbs || { known: false, items: [], summary: null };
  const battery = input.battery === undefined ? null : input.battery;
  const ecus = input.ecus || { known: false, items: [], error: null };
  const urgent = cbs.items.filter((item) => item.color === 'red' || item.color === 'yellow');
  const next = urgent[0] || cbs.items[0] || null;
  return {
    schema: 1,
    at: input.now,
    cbs,
    battery,
    ecus,
    coverage: {
      cbs: cbs.known ? 'read' : 'unknown',
      battery: battery === null ? 'unknown' : 'read',
      ecus: ecus.known ? 'read' : 'unknown'
    },
    summary: {
      urgentCount: urgent.length,
      nextService: next ? itemLine(next) : null,
      verdict: urgent.length ? 'attention' : (cbs.known || battery !== null || ecus.known ? 'partial' : 'unknown')
    }
  };
}

function diff(previous, current) {
  if (!previous) return { baseline: true, changes: [] };
  const changes = [];
  if (previous.battery !== null && current.battery !== null && previous.battery !== current.battery) {
    changes.push({ kind: 'battery', from: previous.battery, to: current.battery,
      direction: current.battery < previous.battery ? 'down' : 'up' });
  }
  const before = new Map((previous.cbs.items || []).map((item) => [item.id, item]));
  for (const item of current.cbs.items || []) {
    const old = before.get(item.id);
    if (!old) changes.push({ kind: 'cbs-new', item });
    else if (old.color !== item.color || old.way !== item.way || old.date !== item.date) {
      changes.push({ kind: 'cbs-changed', from: old, to: item });
    }
  }
  if (previous.ecus.known && current.ecus.known && previous.ecus.items.length !== current.ecus.items.length) {
    changes.push({ kind: 'ecus', from: previous.ecus.items.length, to: current.ecus.items.length });
  }
  return { baseline: false, changes };
}

function formatReport(snapshot, comparison) {
  const lines = ['Здоровье X3 · ' + new Date(snapshot.at).toLocaleString('ru-RU'), ''];
  lines.push('Покрытие: CBS ' + snapshot.coverage.cbs + ' · 12 В ' + snapshot.coverage.battery + ' · ECU ' + snapshot.coverage.ecus);
  lines.push('12 В: ' + (snapshot.battery === null ? 'нет данных' : snapshot.battery + ' %'));
  if (snapshot.cbs.items.length) snapshot.cbs.items.slice(0, 5).forEach((item) => lines.push('CBS: ' + itemLine(item)));
  else lines.push('CBS: нет данных');
  lines.push('Ответили ECU: ' + (snapshot.ecus.known ? snapshot.ecus.items.length : 'не проверено'));
  if (comparison.baseline) lines.push('Первый снимок — базовая линия.');
  else if (!comparison.changes.length) lines.push('Изменений от базовой линии нет.');
  else comparison.changes.slice(0, 5).forEach((change) => lines.push('Изменение: ' + change.kind));
  lines.push('Остальные системы не проверялись; отчёт не является общим заключением об исправности.');
  return lines.join('\n');
}

module.exports = { CBS_NAMES, normalizeCbs, normalizeBattery, normalizeEcus, buildSnapshot, diff, formatReport, itemLine };
