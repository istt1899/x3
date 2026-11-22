// Verify a packaged service on the host using the same control socket check as Store.
'use strict';
const assert = require('assert');
const path = require('path');
const EventEmitter = require('events');
const [files, dataDir, version] = process.argv.slice(2);
const service = require(path.join(files, 'marku-kaluga-cameras.js'));
const probe = require(path.join(files, 'check.js')).probe;
const gps = new EventEmitter();
gps.current = () => null;
gps.start = gps.close = () => {};
const socket = path.join(dataDir, 'check.sock');
const app = service.start({ dataDir, socket, gps });
probe({ socket, version, checkPermissions: false }).then(state => {
    const status = state.database.speedcamOnline;
    assert(status && status.phase === 'active', 'Private layer did not load from packaged service');
    assert(status.approaches > 0 && status.added + status.enriched > 0, 'Empty SpeedCamOnline layer');
    console.log('PASS installed service control probe', version, JSON.stringify(status));
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
}).then(() => app.close());
