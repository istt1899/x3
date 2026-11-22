'use strict';
var assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
var events = require('events'), stream = require('stream'), crypto = require('crypto');
var download = require('../native/marku-kaluga-cameras/files/database-download');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-map-resume-'));
var bytes = Buffer.from('verified offline map');
var item = { url: 'https://raw.githubusercontent.com/owner/example/hash/map.json', size: bytes.length,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
var offset = 6, calls = [], response;
var options = { dir: dir, requests: [], timeout: 5000, ensureOpen: function () {}, allow: function (url) { assert.strictEqual(url, item.url); },
  get: function (options, cb) {
    calls.push(options.headers.Range);
    var req = new events.EventEmitter(); req.destroy = function () {};
    process.nextTick(function () {
      var res = new stream.PassThrough();
      res.statusCode = response.status;
      res.headers = response.headers || {};
      cb(res);
      if (res.destroyed || !res.writable) return;
      if (response.interrupt) { res.write(response.data); res.emit('aborted'); }
      else res.end(response.data);
    });
    return req;
  } };
async function main() {
  async function interrupt() {
    response = { status: 200, data: bytes.slice(0, offset), interrupt: true };
    try { await download(item, options); assert.fail('expected interrupted download'); }
    catch (e) { assert.strictEqual(e.code, 'UPDATE_INTERRUPTED'); }
    assert.strictEqual(fs.statSync(path.join(dir, fs.readdirSync(dir)[0])).size, offset);
  }
  await interrupt();
  var otherBytes = Buffer.from('another region'), other = { url: item.url, size: otherBytes.length,
    sha256: crypto.createHash('sha256').update(otherBytes).digest('hex') };
  response = { status: 200, data: otherBytes };
  assert.deepStrictEqual(await download(other, options), otherBytes);
  response = { status: 206, headers: { 'content-range': 'bytes 2-5/9' }, data: bytes.slice(offset) };
  try { await download(item, options); assert.fail('expected wrong offset'); }
  catch (e) { assert.strictEqual(e.code, 'UPDATE_RANGE'); }
  response = { status: 206, headers: { 'content-range': 'bytes '+offset+'-'+(bytes.length-1)+'/'+bytes.length }, data: bytes.slice(offset) };
  assert.deepStrictEqual(await download(item, options), bytes);
  assert.deepStrictEqual(calls, [undefined,undefined,'bytes=6-','bytes=6-']);
  assert.strictEqual(fs.readdirSync(dir).length, 0);
  await interrupt();
  response = { status: 200, data: bytes };
  assert.deepStrictEqual(await download(item, options), bytes);
  response = { status: 200, data: Buffer.alloc(bytes.length) };
  try { await download(item, options); assert.fail('expected checksum failure'); }
  catch (e) { assert.strictEqual(e.code, 'UPDATE_CHECKSUM'); }
  assert.strictEqual(fs.readdirSync(dir).length, 0);
  assert.strictEqual(options.requests.length, 0);
  fs.rmdirSync(dir);
  console.log('PASS interrupted map resumes across sessions, exact byte ranges, complete fallback and corrupted downloads');
}
main().catch(function (err) { console.error(err); process.exitCode = 1; });
