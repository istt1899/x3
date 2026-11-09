'use strict';
// Read-only end-to-end check of the actual mgu-updater GitHub Releases reader
// and its Node 8 fetch child. No car connection, credentials or legacy source.
const assert = require('assert');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function option(name, fallback) {
    const at = process.argv.indexOf(name);
    if (at < 0) return fallback;
    if (!process.argv[at + 1] || /^--/.test(process.argv[at + 1])) throw new Error(name + ' needs a value');
    return process.argv[at + 1];
}
const version = option('--version', '0.8.0');
const updaterRoot = path.resolve(option('--updater-root', 'D:/BMW/Temp/mgu-updater-0835-reader'));
const node8 = path.resolve(option('--node8', 'D:/BMW/Tools/node-v8.17.0-win-x64/node.exe'));
const expectedCatalog = option('--expected-catalog', null);
const jsDir = path.join(updaterRoot, 'native', 'mgu-updater', 'js');
const sourceFile = path.join(jsDir, 'sources.js');
const fetchFile = path.join(jsDir, 'fetch.js');
const componentFile = path.join(updaterRoot, 'native', 'mgu-updater', 'component.json');
const source = { id: 'x3-release-verify', type: 'github', repo: 'istt1899/x3', channel: 'releases' };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-updater-reader-'));
const requests = [];
let nextDownload = 0;

function git(args) {
    return cp.execFileSync('git', ['-C', updaterRoot].concat(args), { encoding: 'utf8', windowsHide: true }).trim();
}
function proveUnmodified() {
    assert.strictEqual(git(['status', '--porcelain']), '', 'Updater checkout must be clean');
    assert(/^https:\/\/github\.com\/robertnisipeanu\/mgu-store(?:\.git)?$/i.test(git(['remote', 'get-url', 'origin'])),
        'Updater checkout must come from the official upstream');
    ['sources.js', 'fetch.js'].forEach(name => {
        const rel = 'native/mgu-updater/js/' + name;
        // Git's clean filter normalizes the checkout's CRLF on Windows.
        assert.strictEqual(git(['hash-object', '--path=' + rel, path.join(jsDir, name)]),
            git(['rev-parse', 'HEAD:' + rel]), name + ' differs from upstream checkout');
    });
    const component = JSON.parse(fs.readFileSync(componentFile, 'utf8'));
    assert.strictEqual(component.id, 'mgu-updater');
    return { commit: git(['rev-parse', 'HEAD']), version: component.version };
}
function fetchWithOriginalChild(url, headers, name, maxBytes) {
    assert(/^https:\/\//.test(url), 'Updater must request HTTPS');
    assert(!headers || !Object.keys(headers).some(key => key.toLowerCase() === 'authorization'),
        'Token-free source must not send Authorization');
    const dest = path.join(temp, 'download-' + (++nextDownload));
    const accept = headers && headers.Accept || null;
    return new Promise((resolve, reject) => {
        const child = cp.spawn(node8, [fetchFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', finished = false;
        const fail = error => { if (!finished) { finished = true; reject(error); } };
        const timeout = setTimeout(() => child.kill(), 120000);
        child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2000000) child.kill(); });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
        child.on('error', fail);
        child.on('close', code => {
            clearTimeout(timeout);
            if (finished) return;
            let events;
            try { events = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
            catch (error) { fail(new Error('Updater fetch emitted invalid JSON: ' + error.message)); return; }
            const end = events.filter(event => event.done || event.notModified || event.error && !event.retry).slice(-1)[0];
            if (code !== 0 || !end || !end.done) {
                fail(new Error('Updater fetch failed for ' + name + ': ' + JSON.stringify(end || { code, stderr })));
                return;
            }
            try {
                const bytes = fs.readFileSync(dest);
                fs.unlinkSync(dest);
                requests.push({ name, url, accept, status: end.status, bytes: bytes.length, sha256: sha(bytes),
                    retries: events.filter(event => event.retry).length });
                finished = true;
                resolve(bytes);
            } catch (error) { fail(error); }
        });
        // updater.js supplies the uplink's DNS list to fetch.js. On this host
        // there is no car lease, so [] asks fetch.js to use the system resolver.
        child.stdin.end(JSON.stringify({ url, headers: headers || {}, dest, maxBytes, dns: [] }) + '\n');
    });
}
async function main() {
    assert(/^\d+\.\d+\.\d+$/.test(version), 'Expected package version must be x.y.z');
    const updater = proveUnmodified();
    assert(fs.existsSync(node8), 'Node 8 runtime is missing');
    const sources = require(sourceFile);
    const reader = sources.reader(source, { net: { get: fetchWithOriginalChild, cached: fetchWithOriginalChild },
        tokenFor: () => '', githubApi: 'https://api.github.com', version: updater.version,
        maxRepoBytes: 32 << 20, maxBuildBytes: 64 << 20 });
    const catalog = await reader.catalog();
    assert.strictEqual(catalog.mode, 'catalog', 'Reader did not use published catalog.json');
    assert.strictEqual(catalog.channel, 'releases', 'Reader left the configured Releases channel');
    assert.strictEqual(catalog.public, true, 'Reader did not identify a public source');
    const catalogRequest = requests.find(item => item.name === 'catalog.json');
    assert(catalogRequest && /\/istt1899\/x3\/releases\/download\/catalog\/catalog\.json$/.test(catalogRequest.url),
        'Catalog did not come from the x3 catalog release');
    assert.strictEqual(catalogRequest.accept, 'application/octet-stream', 'Catalog Accept changed');
    if (expectedCatalog) {
        const reviewed = fs.readFileSync(path.resolve(expectedCatalog));
        assert.strictEqual(catalogRequest.sha256, sha(reviewed),
            'Published catalog bytes differ from the reviewed local catalog');
    }
    console.log('PASS x3 Releases catalog via unmodified Updater reader/fetch:', catalog.components.length,
        'components, SHA-256', catalogRequest.sha256, 'upstream', updater.version, updater.commit);
    for (const id of ['marku_kaluga_cameras', 'marku-kaluga-cameras']) {
        const entry = catalog.components.find(item => item.id === id);
        assert(entry, id + ' absent from published catalog');
        assert.strictEqual(entry.version, version, id + ' published version');
        assert.strictEqual(entry.artifact.name, id + '@' + version + '.tgz');
        assert(/^[0-9a-f]{64}$/.test(entry.artifact.sha256), id + ' catalog SHA-256 missing');
        assert(Number.isInteger(entry.artifact.size) && entry.artifact.size > 0, id + ' catalog size missing');
        const bytes = await reader.artifact(entry);
        assert.strictEqual(bytes.length, entry.artifact.size, id + ' downloaded size');
        assert.strictEqual(sha(bytes), entry.artifact.sha256, id + ' downloaded SHA-256');
        const request = requests[requests.length - 1];
        assert.strictEqual(request.accept, 'application/octet-stream', id + ' artifact Accept changed');
        assert.strictEqual(request.url, entry.artifact.url, id + ' artifact URL changed');
        console.log('PASS', id, entry.version, bytes.length, 'bytes, SHA-256', sha(bytes));
    }
    // Independent publication check: main's root catalog must match the
    // catalog release byte for byte. This is a direct fetch, not a reader path.
    const mainBytes = await fetchWithOriginalChild('https://raw.githubusercontent.com/istt1899/x3/main/catalog.json',
        { 'User-Agent': 'mgu-updater/' + updater.version, Accept: 'application/octet-stream' },
        'main/catalog.json', 4 << 20);
    assert.strictEqual(sha(mainBytes), catalogRequest.sha256, 'main catalog differs from catalog release');
    console.log('PASS x3 main catalog equals catalog release byte for byte');
    requests.forEach(item => console.log('FETCH', item.name, 'HTTP', item.status, 'Accept', item.accept,
        'bytes', item.bytes, 'retries', item.retries));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).then(() => {
    fs.readdirSync(temp).forEach(name => fs.unlinkSync(path.join(temp, name)));
    fs.rmdirSync(temp);
});
