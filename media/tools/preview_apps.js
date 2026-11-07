'use strict';
// Local UI simulation only. The head unit, speeds, videos and accounts here are fixtures.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const assert = require('assert');
const { headUnit } = require('../core/kit/tools/hu-stub');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'preview');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function preview(provider) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-media-preview-'));
    const stage = path.join(tmp, 'stage');
    const app = provider === 'vk' ? 'marku_vk_video' : 'marku_rutube';
    fs.cpSync(path.join(ROOT, 'core', 'dist', app), stage, { recursive: true });
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\media-preview-' + path.basename(tmp) : path.join(tmp, 'control.sock');
    const cfgFile = path.join(stage, 'source', 'javascript', 'service-config.js');
    const cfg = require(cfgFile);
    fs.writeFileSync(cfgFile, 'module.exports=' + JSON.stringify(Object.assign({}, cfg, { socket })) + ';');
    delete require.cache[require.resolve(cfgFile)];
    const cards = ['Наука и открытия', 'Путешествие по России', 'Автомобили: большой тест', 'Музыка в дороге'].map((title, i) => ({
        id: provider === 'vk' ? '-123_' + (100 + i) : (i + 1).toString(16).repeat(32),
        title, channel: 'Демонстрационный канал', duration_s: 240 + i * 60
    }));
    let client;
    const send = (data) => client && client.write(JSON.stringify(data) + '\n');
    const server = net.createServer((stream) => {
        client = stream;
        let input = '';
        stream.setEncoding('utf8');
        stream.on('error', () => {});
        stream.on('data', (part) => {
            input += part;
            let index;
            while ((index = input.indexOf('\n')) >= 0) {
                const request = JSON.parse(input.slice(0, index)); input = input.slice(index + 1);
                if (request.cmd === 'status') send({ ev: 'state', state: 'idle' });
                if (request.cmd === 'auth_status') send({ ev: 'auth', state: 'signed_out' });
                if (request.cmd === 'feed') send({ ev: 'feed', which: 'home', items: provider === 'rutube' ? cards : [] });
                if (request.cmd === 'search') send({ ev: 'results', q: request.q, items: cards });
            }
        });
    });
    await new Promise((resolve) => server.listen(socket, resolve));
    let latest, failures = [];
    const log = { info() {}, warn() {}, debug() {}, error(message, error) { failures.push(error || message); } };
    const hu = headUnit(stage, { dataDir: tmp, fresh: true, image: (_name, canvas) => { latest = canvas; return Promise.resolve(); }, log });
    hu.ui.isVisible = (name) => name === 'VIEW';
    hu.ctx.signals = { watch: async (_interface, _instance, handlers) => {
        if (handlers && handlers.statusCarSpeed2) handlers.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
        return {};
    } };
    hu.ctx.hideButton = (id, hidden) => hu.display.hideButton(id, hidden);
    hu.ctx.onPageFocus = (handler) => { hu.display.onPageFocus = handler; };
    hu.ctx.focus = (key) => hu.display.focusPage(key);
    hu.start();
    await sleep(150);
    assert.ok(client, 'preview app must connect to its provider fixture');
    await hu.ui.open('VIEW');
    await hu.loopFn();
    if (latest && latest.png) fs.writeFileSync(path.join(OUT, provider + '-home.png'), latest.png());
    hu.handlers.BTN_S1();
    await sleep(100);
    await hu.loopFn();
    if (latest && latest.png) fs.writeFileSync(path.join(OUT, provider + '-search.png'), latest.png());
    hu.handlers.BTN_ACCOUNT();
    if (provider === 'rutube') send({ ev: 'auth', state: 'code', code: '123456', url: 'https://rutube.ru/activate/', expires: 1200 });
    else send({ ev: 'auth', state: 'error', code: 'configuration_required', msg: 'Настройте приложение VK ID и HTTPS-адрес подтверждения.' });
    await sleep(100);
    await hu.loopFn();
    if (latest && latest.png) fs.writeFileSync(path.join(OUT, provider + '-account.png'), latest.png());
    assert.deepStrictEqual(failures, [], 'native app simulation errors');
    if (client) client.destroy();
    server.close();
    return tmp;
}

(async () => {
    await preview('vk');
    await preview('rutube');
    console.log('UI simulation PNGs:', OUT);
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
