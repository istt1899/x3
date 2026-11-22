// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
var fs = require('fs'), path = require('path'), https = require('https'), crypto = require('crypto');
var URL = require('url').URL;

function failure(code) { return Object.assign(new Error(code), { code: code }); }

// The immutable manifest digest names the partial file. Interrupted downloads
// may survive a head-unit restart; only verified bytes can leave this module.
function download(artifact, options) {
  var filename = 'camera-download-' + artifact.sha256 + '.part';
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 1) throw failure('UPDATE_MANIFEST');
  var file = path.join(options.dir, filename);
  var flags = fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0);
  // Keep interrupted downloads for the last four other regions when roaming.
  var partials = fs.readdirSync(options.dir).filter(function (name) {
    return name !== filename && /^camera-download-[a-f0-9]{64}\.part$/.test(name);
  }).map(function (name) {
    var target = path.join(options.dir, name);
    return { path: target, age: fs.lstatSync(target).mtime.getTime() };
  });
  partials.sort(function (left, right) { return right.age - left.age; });
  partials.slice(4).forEach(function (entry) { fs.unlinkSync(entry.path); });
  var fd = fs.openSync(file, flags, 384);
  function verified() {
    var bytes = fs.readFileSync(fd);
    if (bytes.length !== artifact.size || crypto.createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      fs.unlinkSync(file);
      throw failure('UPDATE_CHECKSUM');
    }
    fs.unlinkSync(file);
    return bytes;
  }
  function receive(url, offset) {
    options.ensureOpen();
    options.allow(url);
    var parsed = new URL(url), headers = { 'User-Agent': 'Strelka-Pulse', Accept: 'application/json', 'Accept-Encoding': 'identity' };
    if (offset) headers.Range = 'bytes=' + offset + '-';
    return new Promise(function (resolve, reject) {
      var req, timer, finished = false;
      function finish(err, value) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        var i = options.requests.indexOf(req);
        if (i >= 0) options.requests.splice(i, 1);
        if (err) reject(err); else resolve(value);
      }
      var get = options.get || https.get;
      req = get({ protocol: 'https:', hostname: parsed.hostname, path: parsed.pathname, headers: headers }, function (res) {
        if (finished) { res.destroy(); return; }
        function stop(err) { finish(err); res.destroy(); }
        if ([301,302,303,307,308].indexOf(res.statusCode) >= 0) {
          res.resume();
          try { return finish(null, { redirect: new URL(res.headers.location, url).toString() }); }
          catch (err) { return stop(failure('UPDATE_REDIRECT')); }
        }
        var start = offset;
        try {
          options.ensureOpen();
          if (res.statusCode === 200) { start = 0; fs.ftruncateSync(fd, 0); }
          else if (res.statusCode === 206) {
            var expected = 'bytes ' + offset + '-' + (artifact.size - 1) + '/' + artifact.size;
            if (res.headers['content-range'] !== expected) throw failure('UPDATE_RANGE');
          } else throw failure('UPDATE_HTTP_' + res.statusCode);
          if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') throw failure('UPDATE_ENCODING');
          if (res.headers['content-length'] !== undefined && Number(res.headers['content-length']) !== artifact.size - start) throw failure('UPDATE_SIZE');
        } catch (err) { return stop(err); }
        var position = start;
        res.on('data', function (chunk) {
          if (finished) return;
          try {
            options.ensureOpen();
            if (position + chunk.length > artifact.size) throw failure('UPDATE_SIZE');
            var n = 0;
            while (n < chunk.length) {
              var written = fs.writeSync(fd, chunk, n, chunk.length - n, position);
              if (!written) throw failure('UPDATE_STORAGE');
              n += written; position += written;
            }
          } catch (err) { stop(err); }
        });
        res.on('end', function () {
          if (position !== artifact.size) return finish(failure('UPDATE_INTERRUPTED'));
          finish(null, { complete: true });
        });
        res.on('aborted', function () { finish(failure('UPDATE_INTERRUPTED')); });
        res.on('error', finish);
        res.on('close', function () { if (!finished) finish(failure('UPDATE_INTERRUPTED')); });
      });
      options.requests.push(req);
      req.on('error', finish);
      timer = setTimeout(function () { finish(failure('UPDATE_TIMEOUT')); req.destroy(); }, options.timeout);
    });
  }
  function request(url, offset, redirects) {
    return receive(url, offset).then(function (result) {
      if (!result.redirect) return verified();
      if (redirects >= 2) throw failure('UPDATE_REDIRECT');
      return request(result.redirect, offset, redirects + 1);
    });
  }
  return Promise.resolve().then(function () {
    var stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw failure('UPDATE_STORAGE');
    if (stat.size === artifact.size) return verified();
    if (stat.size > artifact.size) fs.ftruncateSync(fd, 0);
    return request(artifact.url, stat.size > artifact.size ? 0 : stat.size, 0);
  }).then(function (result) { fs.closeSync(fd); return result; }, function (err) { fs.closeSync(fd); throw err; });
}
module.exports = download;
