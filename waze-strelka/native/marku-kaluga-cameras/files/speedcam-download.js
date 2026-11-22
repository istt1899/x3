// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const execFile = require('child_process').execFile;
const converter = require('./speedcam-converter');
const privateLayer = require('./speedcam-private');

const CACHE = 'speedcam-online-auto.json';
const MAX_PACK = 20 * 1024 * 1024;
const STORE_FETCH = '/var/opt/mgu-updater/current/fetch.js';
const UPLINK = '/run/mgu-uplink/lease.json';

function failure(code) { return Object.assign(new Error(code), {code}); }

function checked(file, maximum, digest, size) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > maximum || (size !== undefined && stat.size !== size)) throw failure('SPEEDCAM_SIZE');
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== stat.size || crypto.createHash('sha256').update(bytes).digest('hex') !== digest)
            throw failure('SPEEDCAM_CHECKSUM');
        return bytes;
    } finally { fs.closeSync(fd); }
}
function readLayer(file, source) {
    const bytes = checked(file, MAX_PACK, source.packSha256);
    return privateLayer.decode(JSON.parse(bytes.toString('utf8')));
}
function cached(dir, source) {
    try { return readLayer(path.join(dir, CACHE), source || converter.SOURCE); }
    catch (error) { return null; }
}
// Only the actual Store downloader handles the MGU uplink DNS, TLS chain,
// signed GitHub redirects and retryable Range downloads. It runs as this service's UID.
function createInstaller(options) {
    const dir = options.dir, source = options.source || converter.SOURCE;
    const lease = options.lease || UPLINK, helper = options.helper || STORE_FETCH;
    // The service starts this installer only after acquiring its control socket.
    const work = path.join(dir, '.speedcam-download');
    const archive = path.join(work, 'download.zip'), pack = path.join(work, 'converted.json');
    const retryMs = options.retryMs || 15000;
    let timer = null, child = null, closed = false, failures = 0, prepared = false;
    function status(phase, errorCode, retryInMs) {
        options.onStatus({phase, errorCode: errorCode || null, retryInMs: retryInMs || null, version: source.version});
    }
    function schedule(delay) {
        timer = setTimeout(attempt, delay);
        if (timer.unref) timer.unref();
    }
    function remove(file) {
        try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    function clean() {
        if (!prepared) return;
        remove(archive);
        remove(pack);
    }
    function retry(error) {
        if (closed) return;
        try { clean(); } catch (storageError) { error = storageError; }
        const delay = Math.min(5 * 60000, retryMs * Math.pow(2, Math.min(failures++, 8)));
        status('retry', error.code || 'SPEEDCAM_INSTALL', delay);
        schedule(delay);
    }
    function run(args, job, errorCode, next) {
        child = (options.execFile || execFile)(process.execPath, args, {
            timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, env: {}, cwd: work
        }, function (error) {
            child = null;
            if (closed) return;
            if (error) return retry(failure(error.killed ? 'SPEEDCAM_TIMEOUT' : errorCode));
            try { next(); } catch (err) { retry(err); }
        });
        // EPIPE can occur when the installed helper refuses a job or exits early.
        child.stdin.on('error', function () {});
        child.stdin.end(job ? JSON.stringify(job) : undefined);
    }
    function attempt() {
        timer = null;
        if (closed) return;
        try {
            // A previous session may already have committed the verified file
            // just before hot activation, e.g. during a database reconfiguration.
            const saved = cached(dir, source);
            if (saved) { options.onReady(saved); status('ready'); return; }
            let dns;
            try { dns = JSON.parse(fs.readFileSync(lease, 'utf8')).dns; } catch (ignored) {}
            if (!Array.isArray(dns) || !dns.some(address => typeof address === 'string' && net.isIP(address)))
                throw failure('SPEEDCAM_UPLINK_OFFLINE');
            if (!fs.existsSync(helper)) throw failure('SPEEDCAM_STORE_FETCH_MISSING');
            const base = fs.lstatSync(dir);
            if (!base.isDirectory() || base.isSymbolicLink()) throw failure('SPEEDCAM_STORAGE');
            try { fs.mkdirSync(work, 0o700); } catch (err) { if (err.code !== 'EEXIST') throw err; }
            const stat = fs.lstatSync(work);
            if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw failure('SPEEDCAM_STORAGE');
            prepared = true;
            clean();
            status('downloading');
            run([helper], {url: source.url, dest: archive, maxBytes: source.bytes, lease,
                headers: {'User-Agent': 'Strelka-Pulse', 'Accept-Encoding': 'identity'},
                connectMs: 12000, idleMs: 15000, immutable: true}, 'SPEEDCAM_FETCH_FAILED', function () {
                status('converting');
                run([__filename, '--convert', archive, pack], null, 'SPEEDCAM_SOURCE_INVALID', function () {
                    const layer = readLayer(pack, source);
                    fs.renameSync(pack, path.join(dir, CACHE));
                    remove(archive);
                    options.onReady(layer);
                    status('ready');
                });
            });
        } catch (error) { retry(error); }
    }
    status('scheduled');
    schedule(options.delayMs === undefined ? 4000 : options.delayMs);
    return {close() {
        closed = true;
        clearTimeout(timer);
        if (child) child.kill('SIGKILL');
    }};
}
if (require.main === module) {
    try {
        if (process.argv.length !== 5 || process.argv[2] !== '--convert') throw failure('SPEEDCAM_ARGUMENTS');
        const source = converter.SOURCE;
        const bytes = checked(process.argv[3], source.bytes, source.sha256, source.bytes);
        const fd = fs.openSync(process.argv[4], 'wx', 0o600);
        try { fs.writeFileSync(fd, converter.buildPack(bytes)); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
    } catch (error) { process.exitCode = 1; }
}
module.exports = {cached, createInstaller};
