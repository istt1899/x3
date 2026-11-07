'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Existing cluster-render client only. Never patches CarPlay, KOMBI or firmware.
const fs = require('fs');
const net = require('net');
const WIDTH = 544, HEIGHT = 240;
function packet(type, data) {
    const out = Buffer.alloc(5 + data.length);
    out.writeUInt32LE(data.length + 1, 0); out[4] = type;
    data.copy(out, 5); return out;
}
function atlas(file) {
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const h = Buffer.alloc(64);
        if (fs.readSync(fd, h, 0, 64, 0) !== 64) return null;
        const w = h.readUInt32LE(8), height = h.readUInt32LE(12), seq = h.readUInt32LE(16);
        const slot = h.readUInt32LE(20), count = h.readUInt32LE(24);
        if (h.readUInt32LE(0) !== 0x4656474d || h.readUInt32LE(4) !== 1 || !seq ||
            w < 16 || w > 2048 || height < 16 || height > 2048 || w % 2 || height % 2 ||
            count < 1 || count > 4 || slot >= count) return null;
        const size = w * height * 3 / 2, st = fs.fstatSync(fd);
        if (!st.isFile() || (st.uid !== 0 && st.uid !== 65534) || st.size !== 64 + size * count) return null;
        const src = Buffer.alloc(size);
        if (fs.readSync(fd, src, 0, size, 64 + slot * size) !== size) return null;
        const again = Buffer.alloc(64);
        if (fs.readSync(fd, again, 0, 64, 0) !== 64 || !h.equals(again)) return null;
        const out = Buffer.alloc(WIDTH * HEIGHT * 3 / 2);
        out.fill(16, 0, WIDTH * HEIGHT); out.fill(128, WIDTH * HEIGHT);
        const scale = Math.min(WIDTH / w, HEIGHT / height);
        const dw = Math.max(4, Math.floor(w * scale / 4) * 4), dh = Math.max(2, Math.floor(height * scale / 2) * 2);
        const ox = Math.floor((WIDTH - dw) / 4) * 2, oy = Math.floor((HEIGHT - dh) / 4) * 2;
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++)
            out[(y + oy) * WIDTH + x + ox] = src[Math.floor(y * height / dh) * w + Math.floor(x * w / dw)];
        const half = w / 2, quarter = w * height / 4;
        for (let y = 0; y < dh / 2; y++) for (let x = 0; x < dw / 2; x++) {
            const from = Math.floor(y * height / dh) * half + Math.floor(x * w / dw);
            const to = WIDTH * HEIGHT + (y + oy / 2) * WIDTH + x + ox / 2;
            out[to] = src[w * height + from];
            out[to + WIDTH / 2] = src[w * height + quarter + from];
        }
        return { data: out, seq: seq, ino: st.ino };
    } finally { fs.closeSync(fd); }
}
class ClusterOutput {
    constructor(options) {
        const o = options || {};
        this.socket = o.socket || '/dev/shm/cluster-render/render.sock';
        this.file = o.file || '/dev/shm/mgu-video-ridetube';
        this.report = o.report || function () {};
        this.now = o.now || Date.now;
        this.active = o.active || (() => false);
        this.peer = null; this.ready = false; this.lease = 0; this.on = false;
        this.frame = 0; this.last = 0; this.retry = 0;
        this.timer = setInterval(() => this.tick(), 100);
        this.timer.unref();
    }
    available() { try { return fs.statSync(this.socket).isSocket(); } catch (e) { return false; } }
    heartbeat(on) {
        this.on = !!on; this.lease = this.now();
        if (!on) this.hide();
    }
    send(value) { if (this.peer && !this.peer.destroyed) this.peer.write(packet(0x4a, Buffer.from(JSON.stringify(value)))); }
    hide() {
        if (this.peer) this.peer.destroy();
        this.peer = null; this.ready = false;
    }
    tick() {
        if (!this.on || !this.active() || this.now() - this.lease > 1200) { this.hide(); return; }
        if (!this.peer) {
            if (this.now() < this.retry) return;
            this.retry = this.now() + 3000;
            const peer = this.peer = net.connect(this.socket);
            let buffer = Buffer.alloc(0);
            peer.on('connect', () => { if (this.peer === peer) this.send({ op: 'hello', app: 'mgu-video', proto: 1 }); });
            peer.on('data', (chunk) => {
                if (this.peer !== peer) return;
                buffer = Buffer.concat([buffer, chunk]);
                if (buffer.length > 65536) { this.hide(); return; }
                while (buffer.length >= 5) {
                    const length = buffer.readUInt32LE(0);
                    if (length < 1 || length > 65532) { this.hide(); return; }
                    if (buffer.length < length + 4) break;
                    if (buffer[4] === 0x4a) {
                        try {
                            const event = JSON.parse(buffer.slice(5, length + 4).toString());
                            if (event.ev === 'hello') {
                                if (event.backend !== 'id7' || !/(^|,)map:1088x480(,|$)/.test(event.targets || '')) {
                                    this.on = false; this.hide(); this.report('unsupported'); return;
                                }
                                this.ready = true;
                                this.send({ op: 'layer', ref: 1, target: 'map', kind: 'video', vw: WIDTH, vh: HEIGHT,
                                    fps: 5, class: 'content', z: 10, visible: 1, contend: 1, guide_hold: 0, stall_ms: 1000 });
                            } else if (event.ev === 'error') { this.on = false; this.hide(); this.report('error'); return; }
                            else if (event.ev === 'target' && event.target === 'map') this.report(event.state === 'shown' ? 'shown' : 'waiting');
                        } catch (e) { this.hide(); return; }
                    }
                    buffer = buffer.slice(length + 4);
                }
            });
            peer.on('error', () => this.report('unavailable'));
            peer.on('close', () => { if (this.peer === peer) { this.peer = null; this.ready = false; } });
        }
        if (!this.ready || (this.peer.writableLength || this.peer.bufferSize || 0) > 512 * 1024 || this.now() - this.last < 200) return;
        try {
            const image = atlas(this.file);
            if (!image) return;
            const head = Buffer.alloc(14); head.writeUInt32LE(1, 0);
            head.writeUInt32LE(++this.frame >>> 0, 4); // high frame word and rect count stay zero
            this.peer.write(packet(0x46, Buffer.concat([head, image.data])));
            this.last = this.now();
        } catch (e) { /* No fresh valid frame: renderer's stall guard hides it. */ }
    }
    close() { clearInterval(this.timer); this.on = false; this.hide(); }
}
module.exports = { ClusterOutput, atlas, packet };
