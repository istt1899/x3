// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Честный проигрыватель штатного гонга BMW. SDK из этой среды недоступен,
// поэтому ничего не гарантируем заранее: сначала read-only проба сервиса
// (getAllSampleSets, без requestGong), затем сигнал запрашивается только по
// команде службы, и любой отражается явным состоянием с русской причиной.
const GONG = 'de.bmw.infotainment.gp.gongplayer.IGPCommand';
const INSTANCE = '1';

class BmwGongPlayer {
    constructor(options) {
        const o = options || {};
        this.builders = o.builders;
        this.timeoutMs = o.timeoutMs || 8000;
        this.state = 'unavailable';
        this.reason = 'Звуковой сервис BMW ещё не проверен';
        this.samples = null;
        this.proxy = null;
        this.played = 0;
        this.failures = 0;
    }
    status() {
        return { state: this.state, reason: this.reason, played: this.played, failures: this.failures,
            sampleCount: this.samples ? this.samples.length : null };
    }
    probe() {
        if (!this.builders || typeof this.builders.buildAndInitTypedProxy !== 'function') {
            this.state = 'unavailable';
            this.reason = 'SDK не предоставляет прокси гонга';
            return Promise.resolve(this.status());
        }
        let proxy;
        return Promise.resolve()
            .then(() => this.builders.buildAndInitTypedProxy(GONG, INSTANCE, { timeoutMs: this.timeoutMs }))
            .then((p) => {
                proxy = p;
                if (!proxy || typeof proxy.getAllSampleSets !== 'function') throw Object.assign(new Error('GONG_PROBE_UNAVAILABLE'), { code: 'GONG_PROBE_UNAVAILABLE' });
                return proxy.getAllSampleSets();
            })
            .then((result) => {
                this.proxy = proxy;
                const names = result && result.listSampleNames;
                this.samples = Array.isArray(names) ? names.slice(0, 50) : [];
                this.state = 'ready';
                this.reason = null;
                return this.status();
            })
            .catch((error) => {
                this.state = 'unavailable';
                this.reason = 'Сервис гонга BMW недоступен: ' + String(error && error.code || error && error.message || error).slice(0, 120);
                return this.status();
            });
    }
    /* Запрос сигнала. Сигнатура requestGong из доступных источников не
     * подтверждена: вызываем самый консервативный вариант и честно репортуем
     * отказ. Успех возвращается только по реальному ответу сервиса. */
    play(request) {
        if (this.state !== 'ready' || !this.proxy) {
            return Promise.reject(new Error(this.reason || 'Звуковой сервис BMW не готов'));
        }
        if (typeof this.proxy.requestGong !== 'function') {
            this.failures++;
            this.state = 'unavailable';
            this.reason = 'Интерфейс гонга не подтвердил requestGong; безопасный сигнал недоступен';
            return Promise.reject(new Error(this.reason));
        }
        return Promise.resolve()
            .then(() => this.proxy.requestGong({ durationMs: request && Number.isInteger(request.durationMs) ? request.durationMs : 250 }))
            .then(() => { this.played++; return { played: true }; })
            .catch((error) => {
                this.failures++;
                this.reason = 'Гонг не воспроизведён: ' + String(error && error.code || error && error.message || error).slice(0, 120);
                throw new Error(this.reason);
            });
    }
}

module.exports = { BmwGongPlayer, GONG };
