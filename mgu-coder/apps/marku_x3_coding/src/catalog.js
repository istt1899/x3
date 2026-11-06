// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

// Editorial shortlist for the G01/F97. Requirements are from the public
// BimmerCode G01 catalogue; no CAFD offsets or coding values are asserted.
const FEATURES = Object.freeze([
  {
    id: 'start_stop', title: 'Старт-стоп', ecu: 'DME', address: 0x12,
    summary: 'Запоминание последнего состояния или отключение функции.',
    requirement: 'Нужен подходящий DME. На бензиновом I-Level 23-3+ отключение игнорируется.',
    caution: 'Текущий I-Level и вариант DME нужно прочитать на этой машине.'
  },
  {
    id: 'drive_mode', title: 'Режим при запуске', ecu: 'BDC_BODY3', address: 0x40,
    summary: 'Выбор режима движения по умолчанию, в том числе SPORT INDIVIDUAL.',
    requirement: 'В каталоге G01 указан BDC_BODY2; совместимость BDC_BODY3 этой X3 проверить.',
    caution: 'SPORT INDIVIDUAL — официальный обход ограничения старт-стоп на новых бензиновых ПО.'
  },
  {
    id: 'belt_chime', title: 'Сигнал ремня', ecu: 'ACSM5', address: 0x01,
    summary: 'Настройка только начального звукового сигнала после запуска.',
    requirement: 'Нужен совместимый ACSM5. Визуальные предупреждения сохраняются.',
    caution: 'Функция влияет на напоминание о безопасности; сначала проверьте местные правила.'
  },
  {
    id: 'ambient', title: 'Цвета подсветки', ecu: 'BDC_BODY3', address: 0x40,
    summary: 'Дополнительные цветовые сочетания салонной подсветки.',
    requirement: 'Нужна штатная подсветка; совместимость BDC_BODY3 проверить.',
    caution: 'Число цветов зависит от аппаратной комплектации.'
  },
  {
    id: 'mirrors', title: 'Складывание зеркал', ecu: 'BDC_BODY3', address: 0x40,
    summary: 'Складывание при комфортном закрытии автомобиля.',
    requirement: 'Нужны электроскладываемые зеркала; BDC_BODY3 проверить.',
    caution: 'Поведение может отличаться по рынку и версии BDC.'
  },
  {
    id: 'asd', title: 'Искусственный звук', ecu: 'RAM / ASD_01', address: 0x37,
    summary: 'Отключение штатного Active Sound Design.',
    requirement: 'Нужен установленный ASD через RAM или отдельный ASD_01.',
    caution: 'При отсутствии штатного ASD функция недоступна.'
  },
  {
    id: 'tires', title: 'Шины на приборке', ecu: 'HU_MGU', address: 0x63,
    summary: 'Виджет давления и температуры шин.',
    requirement: 'Нужны датчики давления и совместимая приборная панель.',
    caution: 'Наличие опции 2VB само по себе не подтверждает вывод температуры.'
  },
  {
    id: 'sport', title: 'Спорт-показатели', ecu: 'HU_MGU', address: 0x63,
    summary: 'Выбор показываемых спортивных значений в iDrive.',
    requirement: 'Нужна поддержка в HU_MGU; некоторые данные DME могут не поступать.',
    caution: 'Отображение меню не гарантирует реальные показания.'
  },
  {
    id: 'speed', title: 'Цифровая скорость', ecu: 'DKOMBI4', address: 0x60,
    summary: 'Частота обновления цифровой скорости: 2, 5 или 10 Гц.',
    requirement: 'Нужен DKOMBI4 с соответствующей опцией кодирования.',
    caution: 'Оформление зависит от приборной панели.'
  },
  {
    id: 'startup_volume', title: 'Громкость при запуске', ecu: 'HU_MGU', address: 0x63,
    summary: 'Ограничение громкости, которую iDrive восстанавливает при запуске.',
    requirement: 'Нужен совместимый HU_MGU. В каталоге G01 указаны 10–50%.',
    caution: 'Точное значение и текущая настройка требуют чтения кодировки.'
  }
]);

module.exports = { FEATURES };
