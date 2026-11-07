'use strict';
const assert = require('assert'), cp = require('child_process');
const native = require('../core/native/jap-ridetube-d/network_native');
const original = cp.execFileSync, getuid = process.getuid;
let wrong = false;
process.getuid = () => 15002;
cp.execFileSync = (file, args) => {
    assert.strictEqual(file, '/sbin/ip'); assert.strictEqual(args[5], '15002');
    return '1.1.1.1 dev ' + (wrong ? 'wlan1' : 'eth2') + ' src 10.0.0.2';
};
try {
    const n = { localAddress:'10.0.0.2', interface:'eth2' };
    const lookup = native.lookupGuard((host, opts, cb) => cb(null, '1.1.1.1', 4), n);
    lookup('fixture.invalid', {}, (e, ip) => { assert.ifError(e); assert.strictEqual(ip,'1.1.1.1'); });
    wrong = true;
    lookup('fixture.invalid', {}, (e) => assert.ok(e && /route changed/.test(e.message)));
    assert.throws(() => native.assertRoute(n, '::1'), /IPv4/);
    assert.throws(() => native.fromLease('missing-builtin-lease.json'), /unavailable/);
    console.log('ok: native Node DNS route guard, UID check and missing-lease failure');
} finally { cp.execFileSync = original; process.getuid = getuid; }
