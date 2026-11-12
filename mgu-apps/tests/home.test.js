// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const bridgeModule = require('../native/marku-home-bridge/home_bridge.js');

assert.throws(() => bridgeModule.validateBaseUrl('http://8.8.8.8:8123'), /local/);
assert.throws(() => bridgeModule.validateBaseUrl('file:///etc/passwd'), /http/);
assert.doesNotThrow(() => bridgeModule.validateBaseUrl('http://192.168.1.10:8123'));
assert.deepStrictEqual(bridgeModule.telemetryPreview({ ignition: 'on', battery: 84, service: '2 items', vin: 'SECRET', coords: 'SECRET' }), { ignition: 'on', battery: '84', service: '2 items' });

function requestJson(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index >= 0) { socket.end(); resolve(JSON.parse(buffer.slice(0, index))); }
    });
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('unix timeout')); }, 5000);
  });
}

function post(url, form) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = new URLSearchParams(form).toString();
    const request = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    }).on('error', reject);
  });
}

async function scenario({ delayMs, timeoutMs, port }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-home-test-'));
  const state = path.join(temp, 'state');
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\mgu-home-test-${port}` : path.join(temp, 'ctl.sock');
  let haRequests = 0;
  const ha = http.createServer((request, response) => {
    haRequests += 1;
    setTimeout(() => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); }, delayMs);
  });
  await new Promise((resolve) => ha.listen(0, '127.0.0.1', resolve));
  const haPort = ha.address().port;
  const child = cp.spawn(process.execPath, [path.join(__dirname, '..', 'native', 'marku-home-bridge', 'home_bridge.js')], {
    env: { ...process.env, MGU_HOME_STATE: state, MGU_HOME_SOCKET: socketPath, MGU_HOME_PAIR_HOST: '127.0.0.1', MGU_HOME_PAIR_PORT: String(port), MGU_HOME_HA_TIMEOUT_MS: String(timeoutMs) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    let page;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { page = await get(`http://127.0.0.1:${port}/pair`); break; }
      catch (_) { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    assert(page && page.status === 200);
    const code = /name="code" value="([A-F0-9]+)"/.exec(page.text)[1];
    const paired = await post(`http://127.0.0.1:${port}/pair`, { code, base_url: `http://127.0.0.1:${haPort}`, token: 'test-token-1234567890' });
    assert.strictEqual(paired.status, 200);
    const status = await requestJson(socketPath, { id: 's1', action: 'status' });
    assert.strictEqual(status.paired, true);
    const scene = await requestJson(socketPath, { id: 's2', action: 'scene', scene: 'leave' });
    if (delayMs > timeoutMs) {
      assert.strictEqual(scene.ok, false);
      assert.strictEqual(scene.unknown, true);
      assert.strictEqual(scene.error, 'timeout');
    } else {
      assert.strictEqual(scene.ok, true);
      assert.strictEqual(scene.state, 'done');
    }
    assert.strictEqual(haRequests, 1);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(state, 'config.json')).mode & 0o777;
      assert.strictEqual(mode, 0o600);
    }
  } finally {
    child.kill('SIGTERM');
    ha.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

(async () => {
  await scenario({ delayMs: 0, timeoutMs: 1000, port: 39871 });
  await scenario({ delayMs: 300, timeoutMs: 100, port: 39872 });
  console.log('home.test.js: OK');
})().catch((error) => { console.error(error); process.exitCode = 1; });
