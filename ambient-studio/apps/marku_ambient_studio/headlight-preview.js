'use strict';

const modes = [
    { name: 'Вместе', phases: [3] },
    { name: 'По очереди', phases: [1, 2] },
    { name: 'Сериями', phases: [1, 3, 2] },
    { name: 'Световое шоу', phases: [3, 1, 2, 4, 8, 16, 32] },
];
const flashLengths = [50, 80, 100, 150];
const intervals = [1000, 500, 333, 250];
const orders = [[1, 3, 2], [1, 2, 3], [1, 2]];
const orderNames = ['Л → обе → П', 'Л → П → обе', 'Л → П'];
const labels = ['Обе выключены', 'Левая включена', 'Правая включена', 'Обе включены'];
const otherLamps = { 4: 'Противотуманки', 8: 'Габариты', 16: 'Стоп-сигналы', 32: 'Фонари заднего хода' };

function lampLabel(mask) {
    if (otherLamps[mask]) return otherLamps[mask];
    return mask & 4 ? labels[mask & 3] + ' + ПТФ' : labels[mask];
}

function strobeFrames(mode, burst, order, flashMs, every, allLights) {
    const phases = mode === 2 ? orders[order] : mode === 0 && allLights ? [3, 4] : modes[mode].phases;
    const repeats = mode === 3 ? 1 : 2;
    const steps = [];
    for (let cycle = 0; cycle < repeats; cycle++) {
        for (const phase of phases) {
            const pulses = mode === 2 ? burst : 1;
            for (let pulse = 0; pulse < pulses; pulse++) {
                steps.push({ mask: phase, ms: flashMs });
                steps.push({ mask: 0, ms: every - flashMs });
            }
        }
    }
    return steps;
}

function frameAt(steps, point) {
    let end = 0;
    for (let i = 0; i < steps.length; i++) {
        end += steps[i].ms;
        if (point < end) return i;
    }
    return -1;
}

module.exports = { modes, flashLengths, intervals, orderNames, lampLabel, strobeFrames, frameAt };
