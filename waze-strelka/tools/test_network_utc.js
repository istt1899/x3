// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const {createNetworkUtc} = require('../native/marku-kaluga-cameras/files/network-utc');

const wrongWall = Date.UTC(2179, 0, 1);
const actualUtc = Date.UTC(2026, 10, 19, 12);
const baseNtp = Date.UTC(1900, 0, 1);
const addresses = {'time.google.com': '216.239.35.0', 'time.cloudflare.com': '162.159.200.1'};

function writeTime(packet, offset, utc) {
    const time = (utc - baseNtp) / 1000;
    packet.writeUInt32BE(Math.floor(time) >>> 0, offset);
    packet.writeUInt32BE(Math.floor((time % 1) * 0x100000000), offset + 4);
}

function fixture(sourceUtc = actualUtc, initialWall = wrongWall) {
    const timers = new Map(), sockets = [], queries = [];
    let mono = 0, wall = initialWall;
    const clock = createNetworkUtc({
        wallNow: () => wall,
        monotonicNow: () => mono,
        lookup(host, family, callback) {
            assert.strictEqual(family, 4);
            assert(Object.prototype.hasOwnProperty.call(addresses, host));
            queries.push(host);
            callback(null, addresses[host]);
        },
        createSocket(type) {
            assert.strictEqual(type, 'udp4');
            const socket = new EventEmitter();
            socket.send = (request, offset, length, port, address, callback) => {
                assert.strictEqual(offset, 0);
                assert.strictEqual(length, 48);
                assert.strictEqual(port, 123);
                assert.strictEqual(request[0], 0x23);
                assert(request.slice(1, 40).equals(Buffer.alloc(39)), 'Request discloses no wall clock or GPS data');
                assert(!request.slice(40).equals(Buffer.alloc(8)));
                socket.address = address;
                socket.nonce = request.slice(40);
                socket.sent = mono;
                callback();
            };
            socket.close = () => { socket.closed = true; };
            sockets.push(socket);
            return socket;
        },
        setTimeout(callback, ms) {
            const key = {};
            timers.set(key, {callback, expires: mono + ms});
            return key;
        },
        clearTimeout: key => timers.delete(key)
    });

    function advance(ms, wallDelta = ms) {
        mono += ms;
        wall += wallDelta;
        for (const [key, timer] of timers) {
            if (timer.expires <= mono) {
                timers.delete(key);
                timer.callback();
            }
        }
    }

    function advanceWhileRunning(ms) {
        while (ms > 0) {
            const step = Math.min(ms, 1000);
            advance(step);
            clock.now();
            ms -= step;
        }
    }

    function reply(socket, opts = {}) {
        const packet = Buffer.alloc(48);
        packet[0] = 0x24;
        packet[1] = 2;
        packet.writeUInt32BE(32, 4);
        packet.writeUInt32BE(32, 8);
        socket.nonce.copy(packet, 24);
        const midpoint = sourceUtc + (socket.sent + mono) / 2 + (opts.skew || 0);
        writeTime(packet, 32, midpoint - 1);
        writeTime(packet, 40, midpoint + 1);
        if (opts.modify) opts.modify(packet);
        socket.emit('message', opts.length ? packet.slice(0, opts.length) : packet,
            {address: opts.address || socket.address, port: opts.port || 123});
    }

    return {clock, timers, sockets, queries, advance, advanceWhileRunning, reply,
        nowUtc: () => sourceUtc + mono, setWall: value => { wall = value; }};
}

function validate(f) {
    assert.strictEqual(f.clock.now(), null);
    assert.strictEqual(f.clock.status(), 'PROBE');
    assert.deepStrictEqual(f.queries, Object.keys(addresses));
    assert.notDeepStrictEqual(f.sockets[0].nonce, f.sockets[1].nonce);
    f.advance(20);
    f.reply(f.sockets[0]);
    assert.strictEqual(f.clock.now(), null, 'One provider cannot anchor UTC');
    f.advance(30);
    f.reply(f.sockets[1]);
    assert.strictEqual(f.clock.now(), f.nowUtc());
    assert.strictEqual(f.clock.status(), 'OK');
    assert(f.sockets.every(socket => socket.closed));
    assert.strictEqual(f.timers.size, 0);
}

for (const outcome of ['TIMEOUT', 'ONE_REPLY', 'BAD_REPLY', 'UDP']) {
    const f = fixture();
    f.clock.now();
    f.advance(20);
    if (outcome === 'ONE_REPLY') f.reply(f.sockets[0]);
    if (outcome === 'BAD_REPLY') f.reply(f.sockets[0], {length:47});
    if (outcome === 'UDP') f.sockets[0].emit('error', new Error('send failed'));
    f.advance(2000);
    assert.strictEqual(f.clock.now(), null);
    assert.strictEqual(f.clock.status(), outcome);
}

{
    const f = fixture(actualUtc, actualUtc);
    assert.strictEqual(f.clock.now(), null);
    assert.deepStrictEqual(f.queries, []);
    f.setWall(wrongWall);
    validate(f);
    f.advance(1500);
    assert.strictEqual(f.clock.now(), f.nowUtc());
    f.setWall(actualUtc);
    assert.strictEqual(f.clock.now(), null, 'Corrected system wall retires the network anchor');
    assert.strictEqual(f.queries.length, 2);
}

{
    const f = fixture(Date.UTC(2041, 0, 1));
    validate(f);
    f.advanceWhileRunning(5 * 60000);
    assert.strictEqual(f.sockets.length, 4);
    assert.notDeepStrictEqual(f.sockets[0].nonce, f.sockets[2].nonce);
    f.advance(50);
    f.reply(f.sockets[0]); // Delayed callback for a closed probe.
    f.reply(f.sockets[2]);
    f.reply(f.sockets[3]);
    assert.strictEqual(f.clock.now(), f.nowUtc(), 'NTP era wrap and continuous refresh preserve UTC');
    f.advanceWhileRunning(5 * 60000);
    f.advance(50);
    f.reply(f.sockets[4], {skew: 3000});
    f.reply(f.sockets[5], {skew: 3000});
    assert.strictEqual(f.clock.now(), null, 'A paired step cannot move an existing monotonic anchor');
}

for (const bad of [
    {length: 47},
    {modify: packet => { packet[0] = 0x23; }}, // Client rather than server mode.
    {modify: packet => { packet[0] = 0x1c; }}, // NTPv3.
    {modify: packet => { packet[0] = 0xe4; }}, // Leap alarm.
    {modify: packet => { packet[0] = 0x64; }}, // Announced leap, mixed smeared and ordinary UTC.
    {modify: packet => { packet[1] = 0; }}, // Kiss-o'-Death / unsynchronized.
    {modify: packet => { packet[1] = 16; }},
    {modify: packet => { packet[24] ^= 0xff; }},
    {modify: packet => { packet.writeUInt32BE(65536, 8); }},
    {modify: packet => { packet.writeInt32BE(100000, 4); }},
    {modify: packet => { packet.fill(0, 40); }},
    {modify: packet => { writeTime(packet, 32, Date.UTC(2050, 0, 1)); }},
    {modify: packet => { writeTime(packet, 40, Date.UTC(2110, 0, 1)); }},
    {address: '162.159.200.123'},
    {port: 124},
    {skew: 251}
]) {
    const f = fixture();
    f.clock.now();
    f.advance(50);
    f.reply(f.sockets[0]);
    f.reply(f.sockets[1], bad);
    assert.strictEqual(f.clock.now(), null);
    f.advance(2000);
    assert.strictEqual(f.clock.now(), null);
    assert.strictEqual(f.queries.length, 2, 'Backoff prevents immediate retries');
    assert(f.sockets.every(socket => socket.closed));
    assert.strictEqual(f.timers.size, 0);
}

{
    const f = fixture();
    f.clock.now();
    f.advance(601);
    f.reply(f.sockets[0]);
    f.reply(f.sockets[1]);
    assert.strictEqual(f.clock.now(), null, 'A slow pair cannot anchor UTC');
    f.advance(2000);
    f.advanceWhileRunning(60000);
    assert.strictEqual(f.queries.length, 4);
    const current = f.sockets.slice(2);
    f.clock.close();
    f.advance(30);
    current.forEach(socket => f.reply(socket));
    assert.strictEqual(f.clock.now(), null);
    assert(f.sockets.every(socket => socket.closed));
    assert.strictEqual(f.timers.size, 0);
}

for (const [mono, wall] of [[5001, 5001], [50, 500], [-1, -1]]) {
    const f = fixture();
    validate(f);
    f.advance(mono, wall);
    assert.strictEqual(f.clock.now(), null, 'Clock discontinuity retires the anchor');
    assert.strictEqual(f.sockets.length, 2);
}

{
    const f = fixture();
    f.clock.now();
    f.advance(20);
    f.reply(f.sockets[0]);
    f.advance(30, 281);
    f.reply(f.sockets[1]);
    assert.strictEqual(f.clock.now(), null, 'A wall jump during a probe retires both pending samples');
    assert(f.sockets.every(socket => socket.closed));
}

{
    const f = fixture();
    f.clock.now();
    f.advance(20);
    f.reply(f.sockets[0]);
    f.setWall(actualUtc);
    assert.strictEqual(f.clock.now(), null);
    f.setWall(wrongWall + 20);
    f.advance(30);
    f.reply(f.sockets[1]);
    assert.strictEqual(f.clock.now(), null, 'A delayed reply cannot cross a corrected-wall period');
    assert.strictEqual(f.queries.length, 2, 'Mode flips cannot bypass request throttling');
    assert(f.sockets.every(socket => socket.closed));
}

{
    const f = fixture();
    f.clock.now();
    f.advance(20);
    f.reply(f.sockets[0]);
    f.advance(5001);
    f.reply(f.sockets[1]);
    assert.strictEqual(f.clock.now(), null, 'A delayed reply cannot anchor UTC after a paused service');
    assert.strictEqual(f.queries.length, 2);
    assert(f.sockets.every(socket => socket.closed));
}

console.log('PASS bounded dual-provider NTP, nonce and packet checks, monotonic UTC and fail-closed lifecycle');
