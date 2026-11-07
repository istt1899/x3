// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const { FEATURES } = require('./catalog.js');
const { ERROR_CODES } = require('./diagnostics.js');
const PAGE_SIZE = 5;

const ERROR_MESSAGES = Object.freeze({
  [ERROR_CODES.TRANSPORT_SETUP_FAILED]: 'Не удалось открыть диагностический канал',
  [ERROR_CODES.RESPONSE_SUBSCRIBE_FAILED]: 'Не удалось получать ответы блоков',
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 'Диагностический сервис недоступен',
  [ERROR_CODES.RESPONSE_ERROR]: 'Диагностический сервис сообщил об ошибке',
  [ERROR_CODES.TRANSPORT_REJECTED]: 'Диагностический сервис отклонил запрос',
  [ERROR_CODES.REQUEST_REFUSED]: 'Запрос обнаружения отклонён',
  [ERROR_CODES.REQUEST_FAILED]: 'Не удалось отправить запрос обнаружения',
  [ERROR_CODES.SCAN_TIMEOUT]: 'Превышено время ожидания ответа',
  [ERROR_CODES.SCAN_EMPTY]: 'Блоки не ответили на проверку',
  [ERROR_CODES.SCAN_CLOSED]: 'Проверка остановлена',
  [ERROR_CODES.UNKNOWN_ERROR]: 'Диагностика не удалась. Повторите проверку.',
});

function errorMessage(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code) ?
    ERROR_MESSAGES[code] : ERROR_MESSAGES[ERROR_CODES.UNKNOWN_ERROR];
}

function hex(address) { return '0x' + Number(address).toString(16).toUpperCase().padStart(2, '0'); }
function oneLine(value, max) { return String(value || '').replace(/[\r\n\t]/g, ' ').slice(0, max || 160); }

function model(scan, page, selected) {
  const result = scan || null;
  const ecus = result && Array.isArray(result.ecus) ? result.ecus : [];
  const addresses = new Set(ecus.map((e) => e.address));
  const failed = result && result.error;
  const scanning = result && result.scanning;
  const status = scanning ? 'Проверка блоков…' : failed ? 'Диагностика: ' + errorMessage(failed) :
    result && result.available ? 'Диагностика: ответили ' + ecus.length + ' адресов' : 'Диагностика ещё не запущена';
  const detail = selected == null ? null : FEATURES[selected];
  const start = Math.max(0, Math.min(1, page || 0)) * PAGE_SIZE;
  const items = FEATURES.slice(start, start + PAGE_SIZE);
  const text = {
    codingTitle: detail ? detail.title : 'Bimmer Code',
    codingStatus: status,
    codingGate: 'Чтение блоков; запись пока недоступна',
    codingPage: 'Функции ' + (start + 1) + '–' + (start + items.length) + ' из ' + FEATURES.length,
    codingScan: scanning ? 'Проверка выполняется' : 'Проверить блоки на стоянке',
    codingPrev: 'Предыдущие функции', codingNext: 'Следующие функции',
    codingBack: 'К списку функций',
    detailEcu: '', detailSummary: '', detailRequirement: '', detailCaution: '', detailStatus: '',
    codingFooter: 'Только на стоянке; скорость приложением не проверяется'
  };
  items.forEach((feature, i) => { text['codingSlot' + (i + 1)] = feature.title + '  ·  ' + feature.ecu; });
  if (detail) {
    const answered = addresses.has(detail.address);
    text.detailEcu = 'Блок: ' + detail.ecu;
    text.detailSummary = oneLine(detail.summary);
    text.detailRequirement = 'Условие: ' + oneLine(detail.requirement);
    text.detailCaution = 'Проверить: ' + oneLine(detail.caution);
    text.detailStatus = result && result.available && !result.error ?
      (answered ? 'Адрес ' + hex(detail.address) + ' ответил; кодировка не прочитана' :
        'Адрес ' + hex(detail.address) + ' не ответил; вариант не определён') :
      'Диагностика не завершена; доступность не проверена';
  }
  const list = detail == null;
  const visible = {
    codingPage: list, codingScan: list, codingPrev: list && start > 0,
    codingNext: list && start + PAGE_SIZE < FEATURES.length,
    detailEcu: !list, detailSummary: !list, detailRequirement: !list,
    detailCaution: !list, detailStatus: !list, codingBack: !list,
  };
  for (let i = 1; i <= PAGE_SIZE; i++) visible['codingSlot' + i] = list;
  return { text, visible, enabled: { codingScan: list && !scanning } };
}

module.exports = { model, hex, PAGE_SIZE, ERROR_MESSAGES };
