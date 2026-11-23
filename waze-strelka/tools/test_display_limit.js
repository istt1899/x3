'use strict';
const assert = require('assert');
const select = require('../native/marku-kaluga-cameras/files/display-limit').select;
const camera = { id: 'a', provenance: 'primary', sourceUrl: 'https://example.org/a', cameraLimitKmh: 40 };
const road = { roadConfirmed: true, limitKmh: 60 };
function choose(record, other) { return select(Object.assign({}, camera, road, record, other)); }
assert.strictEqual(select(camera).value, 40);
assert.strictEqual(choose({}).state, 'conflict');
assert.strictEqual(choose({ cameraLimitDate: '2026-04-02', roadLimitUpdatedAt: '2026-04-01' }).value, 40);
assert.strictEqual(choose({ cameraLimitDate: '2026-04-02', roadLimitUpdatedAt: '2026-04-03' }).value, 60);
assert.strictEqual(choose({ cameraLimitDate: '2026-04-02', roadLimitUpdatedAt: '2026-04-02T19:00:00Z' }).state, 'conflict');
assert.strictEqual(choose({ cameraLimitDate: '2026-02-31', roadLimitUpdatedAt: '2026-03-01' }).state, 'conflict');
assert.strictEqual(select(Object.assign({},camera,{cameraLimitConditional:'school hours'})).state, 'unknown');
assert.strictEqual(select({cameraLimitKmh:60}).state,'unknown');
console.log('Display limits: explicit camera, dated disagreements, overlapping days, conditions and missing evidence OK');
