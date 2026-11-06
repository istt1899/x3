'use strict';
const assert = require('assert');
const { FEATURES } = require('../apps/marku_x3_coding/src/catalog');
const { model } = require('../apps/marku_x3_coding/src/view_model');

assert.strictEqual(FEATURES.length, 10);
assert.strictEqual(new Set(FEATURES.map((item) => item.id)).size, 10);
assert(FEATURES.every((item) => item.ecu && item.requirement && item.caution));

const first = model(null, 0, null);
assert.strictEqual(first.text.codingPage, 'Функции 1–5 из 10');
assert.strictEqual(first.visible.codingPrev, false);
assert.strictEqual(first.visible.codingNext, true);
assert.strictEqual(first.visible.codingSlot1, true);
assert.strictEqual(first.visible.detailStatus, false);
assert(/запись пока недоступна/.test(first.text.codingGate));

const second = model(null, 1, null);
assert.strictEqual(second.text.codingPage, 'Функции 6–10 из 10');
assert.strictEqual(second.visible.codingPrev, true);
assert.strictEqual(second.visible.codingNext, false);
assert(/Искусственный звук/.test(second.text.codingSlot1));

const diagnostic = { available: true, ecus: [{ address: 0x12, sgbd: '0F26E8' }] };
const detail = model(diagnostic, 0, 0);
assert.strictEqual(detail.visible.codingSlot1, false);
assert.strictEqual(detail.visible.detailStatus, true);
assert(/0x12 ответил; кодировка не прочитана/.test(detail.text.detailStatus));
assert(/DME/.test(detail.text.detailEcu));
assert(/23-3/.test(detail.text.detailRequirement));

const unanswered = model(diagnostic, 0, 2);
assert(/не ответил; вариант не определён/.test(unanswered.text.detailStatus));
assert(!/недоступен/.test(unanswered.text.detailStatus));

const failed = model({ available: false, ecus: [], error: 'TASU service unavailable' }, 0, 0);
assert(/TASU service unavailable/.test(failed.text.codingStatus));
assert(/не проверена/.test(failed.text.detailStatus));

const refused = model({ available: true, ecus: [], error: 'TASU transport refused discovery' }, 0, 0);
assert(/не проверена/.test(refused.text.detailStatus));
assert(!/не ответил/.test(refused.text.detailStatus));

console.log('view_model.test.js: OK');
