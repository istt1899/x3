'use strict';
const assert = require('assert');
const { FEATURES } = require('../apps/marku_x3_coding/src/catalog');
const { model } = require('../apps/marku_x3_coding/src/view_model');
const { ERROR_CODES } = require('../apps/marku_x3_coding/src/diagnostics');

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
assert.strictEqual(first.text.codingFooter, 'Только на стоянке; скорость приложением не проверяется');

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

const failures = [
  [ERROR_CODES.TRANSPORT_SETUP_FAILED, 'Не удалось открыть диагностический канал'],
  [ERROR_CODES.RESPONSE_SUBSCRIBE_FAILED, 'Не удалось получать ответы блоков'],
  [ERROR_CODES.SERVICE_UNAVAILABLE, 'Диагностический сервис недоступен'],
  [ERROR_CODES.RESPONSE_ERROR, 'Диагностический сервис сообщил об ошибке'],
  [ERROR_CODES.TRANSPORT_REJECTED, 'Диагностический сервис отклонил запрос'],
  [ERROR_CODES.REQUEST_REFUSED, 'Запрос обнаружения отклонён'],
  [ERROR_CODES.REQUEST_FAILED, 'Не удалось отправить запрос обнаружения'],
  [ERROR_CODES.SCAN_TIMEOUT, 'Превышено время ожидания ответа'],
  [ERROR_CODES.SCAN_EMPTY, 'Блоки не ответили на проверку'],
  [ERROR_CODES.SCAN_CLOSED, 'Проверка остановлена'],
  [ERROR_CODES.UNKNOWN_ERROR, 'Диагностика не удалась. Повторите проверку.'],
];
failures.forEach(([code, message]) => {
  const view = model({ available: true, ecus: [], error: code, technicalError: 'VIN_SECRET_123' }, 0, 0);
  assert.strictEqual(view.text.codingStatus, 'Диагностика: ' + message);
  assert(/не проверена/.test(view.text.detailStatus));
  assert(!/не ответил/.test(view.text.detailStatus));
  assert(!/VIN_SECRET_123/.test(JSON.stringify(view.text)));
});

const unknown = model({ available: false, ecus: [], error: 'RAW_UNKNOWN_SECRET' }, 0, 0);
assert.strictEqual(unknown.text.codingStatus,
  'Диагностика: Диагностика не удалась. Повторите проверку.');
assert(!/RAW_UNKNOWN_SECRET/.test(JSON.stringify(unknown.text)));

console.log('view_model.test.js: OK');
