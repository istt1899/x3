// Offline fixtures for transient MGU uplink, transfer, conversion and reboot.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const download = require('../native/marku-kaluga-cameras/files/speedcam-download');
const fsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-personal-'));
const lease = path.join(fsRoot, 'lease.json');
const file = path.join(fsRoot, 'speedcam-online-auto.json');
const pack = Buffer.from(JSON.stringify({schema: 1, source: 'speedcamonline', version: '2026.11.1',
    directionMeaning: 'vehicle-course', records: [['sco:' + '1'.repeat(20), 54, 37, 80, 60, null, 1]]}));
const source = {version: '2026.11.1', url: 'https://example.test/archive.zip', bytes: 42,
    packSha256: crypto.createHash('sha256').update(pack).digest('hex')};

async function main() {
    const phases = [], failures = [];
    let fetches = 0, conversions = 0, ready = null, installed;
    fs.writeFileSync(file, 'bad old automatic cache');
    fs.writeFileSync(path.join(fsRoot, 'speedcam-private.json'), 'preserved manual file');
    const timeout = setTimeout(() => { throw Error('Installer did not complete'); }, 5000);
    await new Promise((resolve, reject) => {
        function mockExec(node, args, options, callback) {
            assert.strictEqual(node, process.execPath);
            assert.strictEqual(options.timeout, 120000);
            const stdin = new EventEmitter();
            stdin.end = input => setImmediate(() => {
                try {
                    if (input) {
                        const job = JSON.parse(input);
                        assert.deepStrictEqual(args, [__filename]);
                        assert.strictEqual(job.lease, lease);
                        assert.strictEqual(job.url, source.url);
                        assert.strictEqual(job.maxBytes, source.bytes);
                        if (++fetches === 1) { callback(Error('connection cut')); return; }
                        fs.writeFileSync(job.dest, Buffer.alloc(source.bytes));
                    } else {
                        assert.strictEqual(args[1], '--convert');
                        assert.strictEqual(fs.readFileSync(args[2]).length, source.bytes);
                        fs.writeFileSync(args[3], ++conversions === 1 ? 'bad output' : pack);
                    }
                    callback(null);
                } catch (error) { reject(error); }
            });
            return {stdin};
        }
        installed = download.createInstaller({dir: fsRoot, lease, helper: __filename, source, delayMs: 0, retryMs: 2,
            execFile: mockExec, onReady: layer => { ready = layer; }, onStatus: state => {
                phases.push(state.phase);
                if (state.phase === 'retry') {
                    assert.deepStrictEqual(fs.readFileSync(file, 'utf8'), 'bad old automatic cache');
                    failures.push([state.errorCode, state.retryInMs]);
                    if (state.errorCode === 'SPEEDCAM_UPLINK_OFFLINE') fs.writeFileSync(lease, '{"dns":["192.0.2.1"]}');
                }
                if (state.phase === 'ready') resolve();
            }});
    });
    clearTimeout(timeout);
    installed.close();
    assert.deepStrictEqual(failures, [['SPEEDCAM_UPLINK_OFFLINE', 2], ['SPEEDCAM_FETCH_FAILED', 4], ['SPEEDCAM_CHECKSUM', 8]]);
    assert.deepStrictEqual(phases, ['scheduled','retry','downloading','retry','downloading','converting','retry','downloading','converting','ready']);
    assert.strictEqual(ready.rows.length, 1);
    assert.deepStrictEqual(download.cached(fsRoot, source), ready);
    assert.strictEqual(download.cached(fsRoot), null, 'An arbitrary pack cannot pass the release digest');
    assert.deepStrictEqual(fs.readFileSync(file), pack);
    assert.strictEqual(fs.readFileSync(path.join(fsRoot, 'speedcam-private.json'), 'utf8'), 'preserved manual file');
    assert.deepStrictEqual(fs.readdirSync(path.join(fsRoot, '.speedcam-download')), []);
    // A second boot can activate the cache even if the uplink has gone away.
    fs.unlinkSync(lease);
    const boot = await new Promise(resolve => {
        let activated;
        const hold = setTimeout(() => { throw Error('Missing cached layer'); }, 1000);
        const second = download.createInstaller({dir: fsRoot, lease, source, delayMs: 0, onReady: layer => { activated = layer; },
            onStatus: state => { if (state.phase === 'ready') { clearTimeout(hold); second.close(); resolve(activated); } }});
    });
    assert.deepStrictEqual(boot, ready);
    fs.unlinkSync(file);
    fs.unlinkSync(path.join(fsRoot, 'speedcam-private.json'));
    fs.rmdirSync(path.join(fsRoot, '.speedcam-download'));
    fs.rmdirSync(fsRoot);
    console.log('PASS personal camera auto-install: offline start, retry, integrity, atomic replacement and offline restart');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
