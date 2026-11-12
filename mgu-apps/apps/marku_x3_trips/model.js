// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const END_MS = 10 * 60000;
const MAX_DT = 5000;
const KEEP = 20;
const CATEGORIES = ['Не выбрана', 'Личное', 'Работа', 'Клиент'];
const DAY = 86400000;
const pad = (n) => (n < 10 ? '0' : '') + n;
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const isNum = (x) => typeof x === 'number' && isFinite(x);
const round = (x, d) => Math.round(x * Math.pow(10, d)) / Math.pow(10, d);

function validTrip(trip) {
  return trip && isNum(trip.start) && isNum(trip.end) && isNum(trip.km);
}

class Trips {
  constructor(saved) {
    const value = saved && typeof saved === 'object' ? saved : {};
    this.cur = value.cur && isNum(value.cur.start) && isNum(value.cur.end) ? value.cur : null;
    this.trips = Array.isArray(value.trips) ? value.trips.filter(validTrip).slice(-KEEP) : [];
    this.days = value.days && typeof value.days === 'object' ? value.days : {};
    this.price = isNum(value.price) ? value.price : 66;
    this.last = null;
    this.ver = 0;
  }

  feed(now, sample) {
    const speed = isNum(sample.speed) && sample.speed > 0 ? sample.speed : 0;
    const moving = speed > 2;
    const on = sample.running === 'running' || sample.running === 'starting';
    let ended = null;
    if (this.cur && now - this.cur.end > END_MS) ended = this.finish();
    if (!this.cur) {
      this.last = now;
      if (!on && !moving) return { started: false, ended };
      this.cur = { start: now, end: now, km: 0, driveMs: 0, idleMs: 0, vmax: 0,
        tank0: isNum(sample.tank) ? sample.tank : null, tank1: isNum(sample.tank) ? sample.tank : null,
        category: 'Не выбрана', price: this.price };
      this.ver += 1;
      return { started: true, ended };
    }
    const current = this.cur;
    const dt = this.last === null ? 0 : now - this.last;
    this.last = now;
    if (on || moving) current.end = now;
    if (isNum(sample.tank)) {
      if (current.tank0 === null) current.tank0 = sample.tank;
      current.tank1 = sample.tank;
    }
    if (dt <= 0 || dt > MAX_DT) return { started: false, ended };
    current.km += speed * dt / 3600000;
    if (moving) current.driveMs += dt;
    else if (on) current.idleMs += dt;
    if (speed > current.vmax) current.vmax = speed;
    this.ver += 1;
    return { started: false, ended };
  }

  finish() {
    const current = this.cur;
    this.cur = null;
    this.ver += 1;
    if (!current || current.km < 0.1) return null;
    const fuel = current.tank0 !== null && current.tank1 !== null && current.tank1 < current.tank0 ?
      round(current.tank0 - current.tank1, 2) : null;
    const trip = {
      id: 'trip-' + current.start, start: current.start, end: current.end, km: round(current.km, 3), fuel,
      driveMs: current.driveMs, idleMs: current.idleMs, vmax: round(current.vmax, 1),
      category: CATEGORIES.includes(current.category) ? current.category : 'Не выбрана', price: current.price || null,
      cost: fuel !== null && current.price ? round(fuel * current.price, 2) : null
    };
    this.trips.push(trip);
    while (this.trips.length > KEEP) this.trips.shift();
    const key = dayKey(trip.start);
    this.days[key] = this.days[key] || { n: 0, km: 0, fuel: 0, cost: 0, unknownFuel: 0 };
    const day = this.days[key];
    day.n += 1; day.km += trip.km;
    if (trip.fuel === null) day.unknownFuel += 1; else { day.fuel += trip.fuel; day.cost += trip.cost || 0; }
    const oldest = dayKey(Date.now() - 30 * DAY);
    Object.keys(this.days).forEach((dayKeyValue) => { if (dayKeyValue < oldest) delete this.days[dayKeyValue]; });
    return trip;
  }

  setCategory(id, category) {
    if (!CATEGORIES.includes(category)) return false;
    const trip = this.trips.find((item) => item.id === id);
    if (!trip) return false;
    trip.category = category;
    this.ver += 1;
    return true;
  }

  setPrice(price) {
    if (!isNum(price) || price <= 0) return false;
    this.price = round(price, 2);
    if (this.cur) this.cur.price = this.price;
    this.ver += 1;
    return true;
  }

  total(kind, now) {
    const days = { today: 1, week: 7, month: 30 }[kind];
    const from = days ? dayKey(now - (days - 1) * DAY) : null;
    const output = { n: 0, km: 0, fuel: 0, cost: 0, unknownFuel: 0 };
    const add = (trip) => {
      output.n += 1; output.km += trip.km;
      if (trip.fuel === null) output.unknownFuel += 1;
      else { output.fuel += trip.fuel; output.cost += trip.cost || 0; }
    };
    if (kind === 'all') this.trips.forEach(add);
    else this.trips.filter((trip) => dayKey(trip.start) >= from).forEach(add);
    if (this.cur && (kind === 'all' || dayKey(this.cur.start) >= from)) {
      output.n += 1; output.km += this.cur.km;
      const fuel = this.cur.tank0 !== null && this.cur.tank1 !== null && this.cur.tank1 < this.cur.tank0 ? this.cur.tank0 - this.cur.tank1 : null;
      if (fuel === null) output.unknownFuel += 1; else output.fuel += fuel;
    }
    output.km = round(output.km, 2); output.fuel = round(output.fuel, 2); output.cost = round(output.cost, 2);
    return output;
  }

  toJSON() { return { schema: 1, price: this.price, cur: this.cur, trips: this.trips, days: this.days }; }
}

function csv(trips, price) {
  const rows = [['date', 'start', 'end', 'distance_km', 'fuel_l', 'price_rub_l', 'cost_rub', 'category', 'source']];
  trips.forEach((trip) => rows.push([
    dayKey(trip.start), new Date(trip.start).toISOString(), new Date(trip.end).toISOString(), trip.km,
    trip.fuel === null ? '' : trip.fuel, trip.price || price || '', trip.cost === null ? '' : trip.cost,
    trip.category, 'MGU local'
  ]));
  return rows.map((row) => row.map((value) => '"' + String(value).split('"').join('""') + '"').join(';')).join('\r\n') + '\r\n';
}

module.exports = { Trips, END_MS, KEEP, CATEGORIES, dayKey, csv, validTrip };
