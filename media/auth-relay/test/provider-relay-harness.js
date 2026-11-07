'use strict';
// Test-only loopback listener. Configuration is read from stdin, never argv.
const readline = require('node:readline');
const { createRelay } = require('../server');
const input = readline.createInterface({ input: process.stdin });
input.once('line', (line) => {
    input.close();
    const relay = createRelay(JSON.parse(line));
    relay.server.listen(0, '127.0.0.1', () => {
        process.stdout.write(JSON.stringify({ port: relay.server.address().port }) + '\n');
    });
    process.on('SIGTERM', () => relay.server.close());
});
