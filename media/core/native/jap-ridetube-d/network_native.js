'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs'), net = require('net'), cp = require('child_process');
function fromLease(file) {
    if (!file) return null;
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (/builtin-lease\.json$/.test(file)) throw new Error('Native lease is unavailable'); return null; }
    if (value.networkSource !== 'builtin') return null;
    if (net.isIP(value.ip) !== 4 || !/^[A-Za-z0-9_.:-]{1,15}$/.test(value.interface || '')) throw new Error('Invalid native lease');
    return { localAddress: value.ip, interface: value.interface };
}
function assertRoute(native, ip) {
    if (!native) return;
    if (net.isIP(ip) !== 4) throw new Error('Native channel requires IPv4');
    const words = cp.execFileSync('/sbin/ip', ['-4', 'route', 'get', ip, 'uid', String(process.getuid())],
        { encoding:'utf8', timeout:2000, maxBuffer:8192 }).split(/\s+/);
    if (words.indexOf('dev') < 0 || words[words.indexOf('dev')+1] !== native.interface) throw new Error('Native route changed');
}
function lookupGuard(lookup, native) {
    if (!native) return lookup;
    if (!lookup) throw new Error('Native DNS is unavailable');
    return (host, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        lookup(host, opts, (error, address, family) => {
            if (error) return cb(error);
            try {
                (Array.isArray(address) ? address.map((a) => a.address) : [address]).forEach((ip) => assertRoute(native, ip));
                cb(null, address, family);
            } catch (e) { cb(e); }
        });
    };
}
module.exports = { fromLease, assertRoute, lookupGuard };
