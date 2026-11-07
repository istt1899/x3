'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createYouTubeProvider = require('./gateway').createYouTubeProvider;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-logout-'));
    const state = path.join(root, 'state'), cache = path.join(root, 'cache');
    fs.mkdirSync(state); fs.mkdirSync(cache);
    const events = [];
    const provider = createYouTubeProvider({ stateDir: state, cacheDir: cache, noSetuid: true, log() {} });
    provider.attach((event) => events.push(event));
    const daemon = provider.daemon;
    daemon.account.token = async () => 'synthetic-user-token';
    const search = deferred(), thumb = deferred();
    daemon.account.json = async () => search.promise;
    daemon.thumbFetch = async () => thumb.promise;
    const pendingSearch = provider.search('private query');
    const pendingThumb = provider.thumb('abcdefghijk');
    await turn();
    await provider.signOut();
    const afterLogout = events.length;
    search.resolve({ status: 200, j: JSON.parse(fs.readFileSync(path.join(__dirname,
        '../core/native/jap-ridetube-d/test/search_tvhtml5.json'), 'utf8')) });
    thumb.resolve(Buffer.alloc(230400));
    await Promise.all([pendingSearch, pendingThumb]);
    assert.strictEqual(events.slice(afterLogout).some(event => event.ev === 'results' || event.ev === 'thumb'), false);
    assert.strictEqual(fs.existsSync(path.join(cache, 'thumbs', 'abcdefghijk.rgba')), false);
    await provider.close();
    const base = path.resolve(root), allowed = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(base.indexOf(allowed) === 0 && path.basename(base).indexOf('youtube-logout-') === 0);
    function clean(directory) {
        fs.readdirSync(directory).forEach((name) => {
            const file = path.join(directory, name), stat = fs.lstatSync(file);
            if (stat.isDirectory() && !stat.isSymbolicLink()) clean(file); else fs.unlinkSync(file);
        });
        fs.rmdirSync(directory);
    }
    clean(base);
    console.log('ok: YouTube adapter drops old authenticated search and thumbnail replies after logout');
})().catch((error) => { console.error(error); process.exit(1); });
