'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// One shared player, three separate app sockets. No phone passwords in the UI.
const path = require('path');
const fs = require('fs');
const { Gateway, DaemonPlayer, createYouTubeProvider } = require('./gateway');
const { PythonProvider } = require('./python_provider');
const { NetworkAccess } = require('./network_access');

function create(options) {
    const o = options || {};
    const root = path.resolve(__dirname, '..');
    const core = path.join(root, 'core', 'native', 'jap-ridetube-d');
    const stateDir = o.stateDir || '/var/opt/jap-ridetube-d/state';
    const cacheDir = o.cacheDir || '/var/opt/jap-ridetube-d/cache';
    const python = o.python || '/var/opt/mgu-python/current/bin/python3';
    const node22 = o.node22 || '/var/opt/jap-node22/current/bin/node';
    const log = o.log || ((message) => console.error(String(message).slice(0, 1000)));
    const engine = Object.assign({ stateDir, cacheDir,
        accountFile: path.join(stateDir, 'account.json'), proxyFile: path.join(stateDir, 'proxy.json'),
        logDir: o.logDir || '/var/opt/jap-ridetube-d/log', log,
        ytdec: path.join(core, 'ytdec'),
        fetcher: [python, path.join(core, 'ytfetch.py')],
        thumbCmd: [node22, path.join(core, 'thumb.js')],
        fetchCmd: [process.execPath, '--max-http-header-size=65536', path.join(core, 'ytd.js'), '--fetch']
    }, o.engine || {});
    const player = new DaemonPlayer(engine);
    const externalUid = player.engine.uid.bind(player.engine);
    const network = new NetworkAccess({ stateDir, cacheDir, python, getExternalUid: externalUid,
        uidOptions: player.engine.opts });
    player.engine.uid = () => network.uid();
    const youtube = createYouTubeProvider(engine);
    youtube.daemon.uid = () => network.uid();
    youtube.networkChanged({ cacheDir: network.cache(youtube.context.cacheDir),
        leaseFile: network.source === 'builtin' ? path.join(network.runtimeDir, 'builtin-lease.json') : '/run/mgu-uplink/lease.json' });
    const bridgeOptions = {
        python, node22, log, getUid: () => player.engine.uid(),
        pyz: path.join(core, 'ytdlp.pyz'), caBundle: path.join(root, 'runtime', 'cacert.pem'),
        ffmpeg: o.ffmpeg || path.join(root, 'runtime', 'ffmpeg')
    };
    const vk = new PythonProvider(Object.assign({}, bridgeOptions, { id: 'vk' }));
    const rutube = new PythonProvider(Object.assign({}, bridgeOptions, { id: 'rutube' }));
    return new Gateway({ player, providers: [youtube, vk, rutube], stateDir, cacheDir, network,
        sockets: o.sockets, log });
}

async function main() {
    const gateway = create();
    let closing = false;
    let exitCode = 0;
    const close = async (code) => {
        if (Number.isInteger(code) && code > exitCode) exitCode = code;
        if (closing) return;
        closing = true;
        try { await gateway.close(); }
        catch (error) { exitCode = 1; }
        finally { process.exit(exitCode); }
    };
    process.on('SIGTERM', close);
    process.on('SIGINT', close);
    process.on('uncaughtException', (error) => {
        console.error('media service fault: ' + error.name);
        close(1);
    });
    process.on('unhandledRejection', () => {
        console.error('media service request failed');
        close(1);
    });
    await gateway.start();
    console.error('MGU media service ready: youtube, vk, rutube');
    return gateway;
}

module.exports = { create, main };
if (require.main === module) main().catch((error) => {
    console.error('media service startup failed: ' + error.name);
    process.exit(1);
});
