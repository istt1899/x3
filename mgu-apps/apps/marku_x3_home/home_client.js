// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const net = require('net');

class HomeClient {
  constructor(socketPath, log) {
    this.socketPath = socketPath;
    this.log = log;
    this.socket = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    if (this.socket) return;
    const socket = net.connect(this.socketPath);
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this._data(chunk));
    socket.on('error', (error) => this._fail('socket: ' + error.message));
    socket.on('close', () => this._fail('socket closed'));
  }

  _data(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          pending(message);
        }
      } catch (error) {
        if (this.log) this.log.warn('home bridge response: ' + error);
      }
    }
  }

  _fail(reason) {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    this.socket = null;
    pending.forEach((resolve) => resolve({ ok: false, error: reason, unknown: true }));
  }

  request(payload, timeoutMs) {
    this.connect();
    if (!this.socket) return Promise.resolve({ ok: false, error: 'socket unavailable', unknown: true });
    const id = 'h' + this.nextId++;
    const message = JSON.stringify(Object.assign({ id }, payload)) + '\n';
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'timeout', unknown: true });
      }, timeoutMs || 10000);
      this.pending.set(id, (response) => { clearTimeout(timer); resolve(response); });
      this.socket.write(message);
    });
  }

  close() {
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this._fail('closed');
  }
}

module.exports = { HomeClient };
