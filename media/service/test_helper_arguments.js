'use strict';
const assert = require('assert');
const { Daemon } = require('../core/native/jap-ridetube-d/ytd');
let captured;
const fixture = { spare:null, opts:{ fetcher:['python','fetch.py'] },
    proxyArgs:() => ['--lease','/native/lease.json','--proxy-file','/private/proxy.json'],
    spawnFetchUid:(cmd,args) => { captured = args; return 'child'; } };
assert.strictEqual(Daemon.prototype.spawnJob.call(fixture, ['fetch','--cache-dir','/cache','--','-123_456','/cache/video']), 'child');
assert.deepStrictEqual(captured, ['fetch','--cache-dir','/cache','--lease','/native/lease.json','--proxy-file','/private/proxy.json','--','-123_456','/cache/video']);
console.log('ok: lease and proxy options precede the positional separator, including negative VK IDs');
