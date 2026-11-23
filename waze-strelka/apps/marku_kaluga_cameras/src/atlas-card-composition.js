'use strict';

var OPTIONS = [
    { key: 'limit', label: 'Лимит', description: 'Знак ограничения скорости и его источник. Прочерк означает, что лимит уточнить не удалось.' },
    { key: 'distance', label: 'Расстояние', description: 'До камеры в метрах или километрах. Без достоверного GPS выводится прочерк.' },
    { key: 'types', label: 'Виды контроля', description: 'До трёх значков контроля камеры. Число со знаком «+» показывает остальные виды.' },
    { key: 'direction', label: 'Куда снимает камера', description: 'Схема и подпись показывают съёмку в лоб, в спину или с двух сторон. «Неизвестно» означает, что направление уточнить не удалось.' },
    { key: 'speed', label: 'Скорость', description: 'Текущая скорость в км/ч. При включённой индикации цифры могут выделяться при превышении.' },
    { key: 'status', label: 'Статус камеры и GPS', description: '«Камера», «Рубеж», «Ориентир», «Рядом», «Муляж» или «Нет GPS» поясняют состояние предупреждения.' }
];

function rows(target, state) {
    if (target !== 'hud' && target !== 'map') return [];
    var composition = state && state.cardComposition;
    var profile = composition && composition[target];
    return OPTIONS.map(function (option) {
        return {
            key: option.key,
            label: option.label,
            description: option.description,
            enabled: profile && typeof profile[option.key] === 'boolean' ? profile[option.key] : true,
            command: 'atlasComposition:' + option.key
        };
    });
}

module.exports = { OPTIONS: OPTIONS, rows: rows };
