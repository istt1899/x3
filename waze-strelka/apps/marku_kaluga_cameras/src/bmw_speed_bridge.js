// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const os = require('os');
const INTERFACE = 'de.bmw.infotainment.vehicle.Vehicle2';
const POLL_MS = 750;

class BmwSpeedBridge {
    constructor(builders, control) {
        this.builders = builders;
        this.control = control;
        this.field = null;
        this.pending = false;
        this.timer = null;
        this.generation = 0;
        this.retryAfter = 0;
    }

    start() {
        if (this.timer || !this.builders || typeof this.builders.buildAndInitTypedProxy !== 'function') return;
        const generation = ++this.generation;
        this.timer = setInterval(() => this.poll(generation), POLL_MS);
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
        this.field = null;
        this.generation++;
    }

    poll(generation) {
        const control = this.control, state = control && control.state;
        if (this.pending || !state || !state.capabilities || !state.capabilities.vehicleSpeedTest || control.link !== 'up') return;
        if (!this.field && process.uptime() < this.retryAfter) return;
        const socket = control.sock;
        const live = () => generation === this.generation && socket === control.sock;
        this.pending = true;
        Promise.resolve().then(() => {
            if (this.field) return this.field;
            this.retryAfter = process.uptime() + 10;
            return Promise.resolve(this.builders.buildAndInitTypedProxy(INTERFACE, '1', { timeoutMs: 3000 }))
                .then(proxy => proxy && proxy.statusCarSpeed2);
        }).then(field => {
            if (!live() || !field || typeof field.getValue !== 'function') return;
            this.field = field;
            const sampledAtBootSec = Math.floor(os.uptime());
            const started = process.uptime();
            return Promise.resolve().then(() => field.getValue()).catch(() => null).then(value => {
                if (!live() || process.uptime() - started > POLL_MS / 1000) return;
                const pending = typeof socket.writableLength === 'number' ? socket.writableLength : socket.bufferSize;
                if (pending > 16384) return;
                const raw = value && value.speedVehicleCentreOfGravity;
                control.send({ cmd: 'vehicle-speed', sampledAtBootSec,
                    raw: Number.isInteger(raw) && raw >= 0 && raw < 65535 ? raw : null });
            });
        }).catch(() => { /* An optional interface can be absent on this MGU. */ })
            .then(() => { this.pending = false; });
    }
}

module.exports = { BmwSpeedBridge };
