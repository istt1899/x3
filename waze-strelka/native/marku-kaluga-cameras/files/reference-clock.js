'use strict';

const FIRST_PLAUSIBLE_RMC = Date.UTC(2020, 0, 1);
const IMPLAUSIBLE_WALL = Date.UTC(2100, 0, 1);
const MINUTE_MS = 60000;
const OFFER_LEAD_MS = 10000;
const OFFER_GRACE_MS = 120000;
const CONFIRM_EARLY_MS = 30000;
const CONFIRM_LATE_MS = 10000;
const REFERENCE_LIFE_MS = 60 * MINUTE_MS;
const MAX_SAMPLE_GAP_MS = 5000;
const MAX_WALL_DEVIATION_MS = 250;

function steadyNow() {
    const time = process.hrtime();
    return time[0] * 1000 + time[1] / 1000000;
}

function createReferenceClock(options) {
    const wallNow = (options && options.wallNow) || Date.now;
    const monotonicNow = (options && options.monotonicNow) || steadyNow;
    let previous = null, baseline = null, rmc = null, phone = null;
    let offered = [], generation = 0, lastDiscontinuity = null;

    function invalidate(reason) {
        rmc = null;
        phone = null;
        offered = [];
        generation++;
        lastDiscontinuity = reason;
    }

    function read() {
        const wall = wallNow(), mono = monotonicNow();
        const stamp = { wall, mono };
        if (!baseline) baseline = stamp;
        if (previous) {
            const gap = mono - previous.mono;
            const deviation = (wall - baseline.wall) - (mono - baseline.mono);
            let reason = null;
            if (gap < 0) reason = 'MONOTONIC_CLOCK_JUMP';
            else if (gap > MAX_SAMPLE_GAP_MS) reason = 'SERVICE_PAUSE';
            else if (Math.abs(deviation) > MAX_WALL_DEVIATION_MS) reason = 'WALL_CLOCK_JUMP';
            if (reason) {
                invalidate(reason);
                baseline = stamp;
            }
        }
        previous = stamp;
        if (phone && mono - phone.mono >= REFERENCE_LIFE_MS) invalidate('REFERENCE_EXPIRED');
        if (wall < IMPLAUSIBLE_WALL && (phone || rmc)) {
            invalidate('SYSTEM_CLOCK_RESTORED');
            baseline = stamp;
        }
        return stamp;
    }

    function forecast(stamp) {
        return rmc.utc + (stamp.mono - rmc.mono);
    }

    function offer(stamp) {
        if (!rmc || phone) return null;
        const estimatedUtc = forecast(stamp);
        offered = offered.filter(utc => utc >= estimatedUtc - OFFER_GRACE_MS);
        const latest = offered[offered.length - 1];
        if (latest !== undefined && latest >= estimatedUtc - CONFIRM_LATE_MS) return latest;
        const next = Math.ceil((estimatedUtc + OFFER_LEAD_MS) / MINUTE_MS) * MINUTE_MS;
        offered.push(next);
        return next;
    }

    return {
        now() {
            const stamp = read();
            return phone ? phone.utc + Math.floor(stamp.mono - phone.mono) : stamp.wall;
        },
        observeRmc(sourceUtcMs) {
            const stamp = read();
            if (stamp.wall < IMPLAUSIBLE_WALL || phone || rmc || !Number.isSafeInteger(sourceUtcMs) ||
                sourceUtcMs < FIRST_PLAUSIBLE_RMC || sourceUtcMs >= IMPLAUSIBLE_WALL) return;
            // RMC provides a suggestion only. A repeating sentence cannot move the clock.
            rmc = { utc: sourceUtcMs, mono: stamp.mono };
        },
        confirm(targetUtcMs) {
            const stamp = read();
            if (!rmc || phone || stamp.wall < IMPLAUSIBLE_WALL || offered.indexOf(targetUtcMs) === -1) return false;
            const offset = forecast(stamp) - targetUtcMs;
            if (offset < -CONFIRM_EARLY_MS || offset > CONFIRM_LATE_MS) return false;
            // The driver confirms when an independent clock reaches the displayed UTC minute.
            // The forecast only bounds the action window and never sets the effective UTC.
            phone = { utc: targetUtcMs, mono: stamp.mono };
            generation++;
            lastDiscontinuity = null;
            return true;
        },
        snapshot() {
            const stamp = read();
            return {
                calibrationTargetUtcMs: offer(stamp),
                referenceSource: phone ? 'phone' : 'system',
                referenceUtcMs: phone ? phone.utc + Math.floor(stamp.mono - phone.mono) : stamp.wall,
                referenceExpiresInMs: phone ? REFERENCE_LIFE_MS - (stamp.mono - phone.mono) : null,
                systemWallMs: stamp.wall,
                generation,
                lastDiscontinuity
            };
        }
    };
}

module.exports = { createReferenceClock };
