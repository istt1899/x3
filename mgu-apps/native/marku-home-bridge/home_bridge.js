#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { URL } = require('url');

const STATE_DIR = process.env.MGU_HOME_STATE || '/var/opt/marku-home-bridge/state';
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const SOCKET_PATH = process.env.MGU_HOME_SOCKET || '/run/marku-home-bridge/ctl.sock';
const PAIR_HOST = process.env.MGU_HOME_PAIR_HOST || '172.16.222.97';
const PAIR_PORT = Number(process.env.MGU_HOME_PAIR_PORT || 38765);
const PAIR_TTL_MS = 10 * 60 * 1000;
const HA_TIMEOUT_MS = Number(process.env.MGU_HOME_HA_TIMEOUT_MS || 8000);
const VERSION = '0.1.0';

const SCENES = Object.freeze({
  arrive: { label: 'Возвращаюсь', domain: 'scene', service: 'turn_on', entity: 'scene.mgu_arrive' },
  leave: { label: 'Выезжаю', domain: 'scene', service: 'turn_on', entity: 'scene.mgu_leave' },
  snapshot: { label: 'Снимок автомобиля', domain: 'sensor', service: 'set_state', entity: 'sensor.mgu_x3_snapshot' }
});

let config = null;
let pairing = null;
let busy = false;
let httpServer = null;
let unixServer = null;

function safeMode(file) {
  try { return fs.statSync(file).mode & 0o777; } catch (_) { return null; }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  const mode = safeMode(CONFIG_FILE);
  if (mode !== 0o600) throw new Error('config.json must have mode 0600');
  const value = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!value || typeof value.baseUrl !== 'string' || typeof value.token !== 'string' || !value.token) {
    throw new Error('config.json is incomplete');
  }
  validateBaseUrl(value.baseUrl);
  return value;
}

function validateBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch (_) { throw new Error('invalid Home Assistant URL'); }
  if (parsed.protocol === 'https:' && parsed.hostname) return parsed;
  if (parsed.protocol !== 'http:') throw new Error('only http/https Home Assistant URLs are allowed');
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1' || /^10\./.test(parsed.hostname) || /^192\.168\./.test(parsed.hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(parsed.hostname);
  if (!local) throw new Error('plain HTTP is allowed only for a local/Home Assistant address');
  return parsed;
}

function writeConfig(value) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(STATE_DIR, 0o700); } catch (_) {}
  const temporary = CONFIG_FILE + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, CONFIG_FILE);
  fs.chmodSync(CONFIG_FILE, 0o600);
  config = value;
}

function newPairing() {
  pairing = { code: crypto.randomBytes(4).toString('hex').toUpperCase(), expires: Date.now() + PAIR_TTL_MS, used: false };
  return pairing;
}

function pairPage(message) {
  const code = pairing ? pairing.code : '';
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>X3 Home pairing</title><body style="font:16px/1.5 sans-serif;max-width:620px;margin:40px auto;padding:0 20px"><h1>X3 ↔ Дом</h1><p>${message || 'Введите URL Home Assistant и долгоживущий токен. Они сохраняются только на MGU с правами 0600.'}</p><form method="post" action="/pair"><input type="hidden" name="code" value="${code}"><p><label>Код<br><input name="code_visible" value="${code}" disabled style="width:100%"></label></p><p><label>Home Assistant URL<br><input name="base_url" placeholder="http://192.168.1.10:8123" required style="width:100%"></label></p><p><label>Long-lived token<br><input name="token" type="password" required minlength="20" style="width:100%"></label></p><button type="submit">Сохранить</button></form></body></html>`;
}

function readForm(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16384) { reject(new Error('pairing payload too large')); request.destroy(); }
    });
    request.on('end', () => resolve(new URLSearchParams(body)));
    request.on('error', reject);
  });
}

function startPairingServer() {
  httpServer = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (url.pathname !== '/pair') { response.writeHead(404); response.end('Not found'); return; }
      if (config) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(pairPage('Уже настроено. Повторная запись отклонена.')); return; }
      if (!pairing || pairing.used || Date.now() > pairing.expires) newPairing();
      if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(pairPage()); return; }
      if (request.method !== 'POST') { response.writeHead(405); response.end('Method not allowed'); return; }
      const form = await readForm(request);
      if (pairing.used || Date.now() > pairing.expires || form.get('code') !== pairing.code) {
        response.writeHead(403); response.end('Pairing code expired or invalid'); return;
      }
      const baseUrl = String(form.get('base_url') || '').trim().replace(/\/$/, '');
      const token = String(form.get('token') || '').trim();
      validateBaseUrl(baseUrl);
      if (token.length < 20 || token.length > 512) throw new Error('token length is invalid');
      pairing.used = true;
      writeConfig({ schema: 1, baseUrl, token, pairedAt: new Date().toISOString(), scenes: SCENES });
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><title>Сохранено</title><body style="font:16px sans-serif;padding:40px"><h1>Сохранено</h1><p>Вернитесь в приложение X3 ↔ Дом.</p></body>');
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(String(error.message || error));
    }
  });
  httpServer.on('error', (error) => console.error('marku-home-bridge pair server: ' + error.message));
  httpServer.listen(PAIR_PORT, PAIR_HOST);
}

function haRequest(method, route, body) {
  return new Promise((resolve, reject) => {
    if (!config) { reject(new Error('not paired')); return; }
    const target = new URL(route, config.baseUrl);
    const transport = target.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const request = transport.request(target, {
      method,
      timeout: HA_TIMEOUT_MS,
      headers: Object.assign({ Authorization: 'Bearer ' + config.token, Accept: 'application/json' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; if (text.length > 65536) response.destroy(); });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function runScene(id) {
  const scene = SCENES[id];
  if (!scene || !config) return { ok: false, error: 'not paired' };
  const body = scene.domain === 'sensor' ? { state: 'OK', attributes: id === 'snapshot' ? scene.payload || {} : {} } : { entity_id: scene.entity };
  try {
    const response = await haRequest('POST', `/api/services/${scene.domain}/${scene.service}`, body);
    if (response.status < 200 || response.status >= 300) return { ok: false, error: 'HA_HTTP_' + response.status, unknown: false };
    return { ok: true, state: 'done' };
  } catch (error) {
    return { ok: false, error: error.message === 'timeout' ? 'timeout' : 'network_error', unknown: true };
  }
}

function telemetryPreview(payload) {
  const clean = {};
  for (const key of ['ignition', 'battery', 'service']) {
    if (payload && payload[key] !== undefined && payload[key] !== null) clean[key] = String(payload[key]).slice(0, 120);
  }
  return clean;
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || typeof message.id !== 'string') return null;
  if (message.action === 'status') {
    return { id: message.id, ok: true, paired: !!config, version: VERSION, pairHost: PAIR_HOST, pairPort: PAIR_PORT,
      pairCode: !config && pairing ? pairing.code : null, scenes: Object.keys(SCENES) };
  }
  if (busy) return { id: message.id, ok: false, error: 'busy' };
  if (message.action === 'scene' && Object.prototype.hasOwnProperty.call(SCENES, message.scene)) {
    busy = true;
    try { return Object.assign({ id: message.id }, await runScene(message.scene)); }
    finally { busy = false; }
  }
  if (message.action === 'telemetry') {
    busy = true;
    try {
      const attributes = telemetryPreview(message.payload);
      const response = await haRequest('POST', '/api/states/sensor.mgu_x3_snapshot', { state: 'OK', attributes });
      if (response.status < 200 || response.status >= 300) return { id: message.id, ok: false, error: 'HA_HTTP_' + response.status, unknown: false };
      return { id: message.id, ok: true, state: 'done', sent: Object.keys(attributes) };
    } catch (error) {
      return { id: message.id, ok: false, error: error.message === 'timeout' ? 'timeout' : 'network_error', unknown: true };
    } finally { busy = false; }
  }
  return { id: message.id, ok: false, error: 'unknown_action' };
}

function startUnixServer() {
  const windowsPipe = process.platform === 'win32';
  if (!windowsPipe) {
    fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
    try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}
  }
  unixServer = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const response = await handleMessage(JSON.parse(line));
          if (response) socket.write(JSON.stringify(response) + '\n');
        } catch (error) {
          socket.write(JSON.stringify({ id: 'unknown', ok: false, error: 'bad_request' }) + '\n');
        }
      }
    });
  });
  unixServer.listen(SOCKET_PATH, () => { if (!windowsPipe) { try { fs.chmodSync(SOCKET_PATH, 0o660); } catch (_) {} } });
}

function shutdown() {
  try { if (httpServer) httpServer.close(); } catch (_) {}
  try { if (unixServer) unixServer.close(); } catch (_) {}
}

function main() {
  config = loadConfig();
  if (!config) newPairing();
  startPairingServer();
  startUnixServer();
  console.log(`marku-home-bridge ${VERSION} started; paired=${!!config}`);
}

process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('SIGINT', () => { shutdown(); process.exit(0); });
if (require.main === module) main();

module.exports = { SCENES, validateBaseUrl, telemetryPreview, handleMessage, runScene, newPairing };
