'use strict';
// Decoder only, no network. Runs in the internet UID, input bounded to 2 MiB.
const thumb = require('../core/native/jap-ridetube-d/thumb.js');
let size = 0;
const chunks = [];
process.stdin.on('data', (chunk) => {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) process.exit(1);
    chunks.push(chunk);
});
process.stdin.on('end', () => {
    try { process.stdout.write(thumb.thumbRgba(Buffer.concat(chunks))); }
    catch (error) { process.exitCode = 1; }
});
