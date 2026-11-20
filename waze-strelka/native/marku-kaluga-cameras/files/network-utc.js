'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns');
const net = require('net');

const providers = ['time.google.com', 'time.cloudflare.com'];
const ntpEpoch = Date.UTC(1900, 0, 1);
const ntpEraSeconds = 0x100000000;
const earliestUtc = Date.UTC(2020, 0, 1);
const brokenWall = Date.UTC(2100, 0, 1);
const maxClockGapMs = 5000;
const maxClockDisagreementMs = 250;
const maxRoundTripMs = 600;
const maxPairDisagreementMs = 250;
const timeoutMs = 2000;
const renewAfterMs = 5 * 60000;
const expireAfterMs = 10 * 60000;
const retryAfterMs = 60000;
const maxRetryMs = 15 * 60000;

function readTimestamp(packet, offset) {
    const seconds = packet.readUInt32BE(offset), fractional = packet.readUInt32BE(offset + 4);
    if (!seconds && !fractional) return NaN;
    const eraZero = ntpEpoch + (seconds + fractional / ntpEraSeconds) * 1000;
    const utc = eraZero < earliestUtc ? eraZero + ntpEraSeconds * 1000 : eraZero;
    return utc >= earliestUtc && utc < brokenWall ? utc : NaN;
}

function parseReply(packet, nonce, elapsed) {
    if (!Buffer.isBuffer(packet) || packet.length !== 48 || packet[0] !== 0x24 ||
        packet[1] < 1 || packet[1] > 15 || !packet.slice(24, 32).equals(nonce) ||
        elapsed < 0 || elapsed > maxRoundTripMs) return null;
    const rootDelay = packet.readInt32BE(4) * 1000 / 65536;
    const rootDispersion = packet.readUInt32BE(8) * 1000 / 65536;
    const received = readTimestamp(packet, 32), sent = readTimestamp(packet, 40);
    const processing = sent - received;
    if (!Number.isFinite(processing) || processing < 0 || processing > elapsed ||
        rootDelay < 0 || rootDelay > 1000 || rootDispersion > 250) return null;
    const pathDelay = elapsed - processing;
    if ((pathDelay + rootDelay) / 2 + rootDispersion > 500) return null;
    return sent + pathDelay / 2;
}

function publicAddress(address) {
    if (net.isIP(address) !== 4) return false;
    const octets = address.split('.').map(Number), first = octets[0], second = octets[1];
    return first > 0 && first < 224 && first !== 10 && first !== 127 &&
        !(first === 100 && second >= 64 && second <= 127) && !(first === 169 && second === 254) &&
        !(first === 172 && second >= 16 && second <= 31) && !(first === 192 && second === 168) &&
        !(first === 198 && (second === 18 || second === 19));
}

function createNetworkUtc(options) {
    options = options || {};
    const wallNow = options.wallNow || Date.now;
    const monotonicNow = options.monotonicNow || (() => process.uptime() * 1000);
    const lookup = options.lookup || dns.lookup;
    const createSocket = options.createSocket || dgram.createSocket;
    const setTimeoutFn = options.setTimeout || setTimeout;
    const clearTimeoutFn = options.clearTimeout || clearTimeout;
    let previous = null, baseline = null, anchor = null, active = null;
    let nextProbe = -Infinity, retry = retryAfterMs, closed = false;
    let status = 'WAIT';

    function cancel() {
        if (!active) return;
        const batch = active;
        active = null;
        clearTimeoutFn(batch.timer);
        batch.sockets.forEach(socket => {
            try { socket.close(); } catch (error) {} // Pending bind/send can already have closed it.
        });
    }

    function read() {
        const mono = monotonicNow(), wall = wallNow();
        if (!Number.isFinite(mono) || !Number.isFinite(wall) || wall < brokenWall) {
            anchor = previous = baseline = null;
            cancel();
            status = 'CLOCK';
            return null;
        }
        const stamp = {mono, wall};
        if (!baseline) baseline = stamp;
        if (previous && (mono < previous.mono || mono - previous.mono > maxClockGapMs ||
            Math.abs((wall - baseline.wall) - (mono - baseline.mono)) > maxClockDisagreementMs)) {
            anchor = null;
            nextProbe = mono + retryAfterMs;
            baseline = stamp;
            cancel();
            status = 'CLOCK';
        }
        previous = stamp;
        return mono;
    }

    function finish(batch, mono, result, outcome) {
        if (active !== batch) return;
        cancel();
        status = outcome;
        if (result) {
            anchor = result;
            nextProbe = mono + renewAfterMs;
            retry = retryAfterMs;
        } else {
            anchor = null;
            nextProbe = mono + retry;
            retry = Math.min(retry * 2, maxRetryMs);
        }
    }

    function probe(mono) {
        const batch = {sockets: [], samples: [], invalidReply: false, timer: null};
        active = batch;
        status = 'PROBE';
        nextProbe = mono + retryAfterMs;
        const fail = reason => {
            if (active !== batch) return;
            const at = read();
            if (at !== null) finish(batch, at, null, reason);
        };
        const timeoutReason = () => batch.samples.length ? 'ONE_REPLY' : batch.invalidReply ? 'BAD_REPLY' : 'TIMEOUT';
        batch.timer = setTimeoutFn(() => fail(timeoutReason()), timeoutMs);
        if (batch.timer && typeof batch.timer.unref === 'function') batch.timer.unref();
        providers.forEach(host => {
            if (active !== batch) return;
            try {
                lookup(host, 4, (error, address) => {
                    if (active !== batch) return;
                    if (error || !publicAddress(address)) { fail('DNS'); return; }
                    const sentAt = read();
                    if (sentAt === null || active !== batch) return;
                    if (sentAt - mono >= timeoutMs) { fail(timeoutReason()); return; }
                    try {
                        const socket = createSocket('udp4');
                        batch.sockets.push(socket);
                        socket.on('error', () => fail('UDP'));
                        const nonce = crypto.randomBytes(8);
                        if (nonce.equals(Buffer.alloc(8))) { fail('NONCE'); return; }
                        const request = Buffer.alloc(48);
                        request[0] = 0x23; // NTPv4 client. Other fields carry no system time or GPS data.
                        nonce.copy(request, 40);
                        let accepted = false;
                        socket.on('message', (packet, peer) => {
                            if (active !== batch || accepted || peer.port !== 123 || peer.address !== address) return;
                            const at = read();
                            if (at === null || active !== batch) return;
                            if (at - mono >= timeoutMs) { fail(timeoutReason()); return; }
                            const utc = parseReply(packet, nonce, at - sentAt);
                            if (utc === null) { batch.invalidReply = true; return; }
                            accepted = true;
                            if (!batch.samples.length) { batch.samples.push({utc, at, address}); return; }
                            const prior = batch.samples[0];
                            const alignedPrior = prior.utc + at - prior.at;
                            const agrees = prior.address !== address && Math.abs(alignedPrior - utc) <= maxPairDisagreementMs;
                            const combined = (alignedPrior + utc) / 2;
                            const continuous = !anchor || Math.abs(anchor.utc + at - anchor.at - combined) <= maxClockDisagreementMs;
                            const valid = agrees && continuous;
                            finish(batch, at, valid ? {utc: combined, at} : null, valid ? 'OK' : 'DISAGREE');
                        });
                        socket.send(request, 0, request.length, 123, address, error => { if (error) fail('UDP'); });
                    } catch (error) { fail('UDP'); }
                });
            } catch (error) { fail('DNS'); }
        });
    }

    return {
        now() {
            if (closed) return null;
            const mono = read();
            if (mono === null) return null;
            if (anchor && mono - anchor.at >= expireAfterMs) { anchor = null; status = 'EXPIRED'; }
            if (!active && mono >= nextProbe) probe(mono);
            return anchor ? Math.round(anchor.utc + mono - anchor.at) : null;
        },
        status() { return status; },
        close() {
            closed = true;
            anchor = null;
            cancel();
        }
    };
}

module.exports = {createNetworkUtc};
