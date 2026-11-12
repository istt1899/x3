// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

function temperature(raw, factor, offset) {
  if (typeof raw !== 'number' || !isFinite(raw) || raw === 255 || raw === 65535) return null;
  const value = raw * factor + offset;
  return value >= -50 && value <= 200 ? Math.round(value * 10) / 10 : null;
}

function normalizeTemperatures(value) {
  const oil = temperature(value && value.temperatureEngineOilDrive, 1, -48);
  const coolant = temperature(value && value.temperatureEngineDrive, 1, -48);
  return { oil, coolant, known: oil !== null || coolant !== null };
}

function normalizeOutside(value) {
  const raw = value && typeof value === 'object' ? value.temperatureExterior : value;
  return temperature(raw, 0.5, -40);
}

function normalizeEngine(value) {
  const raw = value && typeof value === 'object' ? value.statusEngineRunDrive : value;
  const map = { MOTOR_AUS: 'off', MOTOR_STARTET: 'starting', MOTOR_LAEUFT: 'running', 0: 'off', 1: 'starting', 2: 'running' };
  return map[raw] || null;
}

class WarmEstimator {
  constructor(saved) {
    const samples = saved && Array.isArray(saved.samples) ? saved.samples : [];
    this.samples = samples.filter((sample) => sample && isFinite(sample.at) && isFinite(sample.value)).slice(-40);
    this.rate = saved && isFinite(saved.rate) ? saved.rate : null;
  }

  add(now, oil, coolant) {
    const value = coolant !== null && coolant >= 0 ? coolant : oil;
    if (value === null || value === undefined) return false;
    const last = this.samples[this.samples.length - 1];
    if (last && now - last.at < 30000 && Math.abs(value - last.value) < 0.5) return false;
    this.samples.push({ at: now, value });
    this.samples = this.samples.slice(-40);
    const first = this.samples[0];
    const minutes = (now - first.at) / 60000;
    if (minutes >= 1 && value > first.value) this.rate = (value - first.value) / minutes;
    return true;
  }

  estimate(now, oil, coolant) {
    this.add(now, oil, coolant);
    const current = coolant !== null ? coolant : oil;
    if (current === null) return { known: false, reason: 'no-data' };
    const target = coolant !== null ? 85 : 80;
    const remaining = Math.max(0, target - current);
    if (remaining <= 0) return { known: true, ready: true, minutes: 0, calculated: true, rate: this.rate };
    if (this.rate !== null && this.rate >= 0.2) {
      return { known: true, ready: false, minutes: Math.ceil(remaining / this.rate), calculated: true, rate: this.rate, remaining };
    }
    const typical = current < 30 ? [10, 18] : current < 50 ? [6, 12] : current < 70 ? [3, 8] : [1, 4];
    return { known: true, ready: false, range: typical, calculated: false, rate: this.rate, remaining };
  }

  toJSON() { return { samples: this.samples, rate: this.rate }; }
}

function recommendation(outside, threshold) {
  if (outside === null) return { level: 0, text: 'Нет данных наружной температуры' };
  if (outside > threshold) return { level: 0, text: 'Порог не достигнут: штатный климат без подогрева' };
  const level = outside <= -10 ? 3 : outside <= -3 ? 2 : 1;
  return { level, text: 'Рекомендация: сиденье ' + level + (level >= 2 ? ', руль 1' : '') + '. Включите штатными кнопками BMW.' };
}

function formatEstimate(estimate) {
  if (!estimate.known) return 'До рабочего диапазона: нет данных';
  if (estimate.ready) return 'Рабочий диапазон достигнут';
  if (estimate.calculated) return 'До рабочего диапазона ≈ ' + estimate.minutes + ' мин (расчёт)';
  return 'До рабочего диапазона ≈ ' + estimate.range[0] + '–' + estimate.range[1] + ' мин (типовой диапазон)';
}

module.exports = { temperature, normalizeTemperatures, normalizeOutside, normalizeEngine, WarmEstimator, recommendation, formatEstimate };
