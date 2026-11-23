'use strict';
const KEYS = Object.freeze(['limit', 'distance', 'types', 'direction', 'speed', 'status']);
const TARGETS = Object.freeze(['hud', 'map']);

function normalizeProfile(value) {
    const profile = {};
    for (const key of KEYS) {
        profile[key] = value && typeof value[key] === 'boolean' ? value[key] : true;
    }
    return profile;
}

function normalize(value) {
    return {
        hud: normalizeProfile(value && value.hud),
        map: normalizeProfile(value && value.map)
    };
}

function hasContent(profile) {
    return KEYS.some(key => profile[key]);
}

function set(current, target, key, value) {
    if (!TARGETS.includes(target)) throw new Error('Выберите приборы или HUD');
    if (!KEYS.includes(key) || typeof value !== 'boolean') throw new Error('Неверный параметр состава карточки');
    const next = normalize(current);
    next[target][key] = value;
    return next;
}

module.exports = { KEYS, TARGETS, normalize, normalizeProfile, hasContent, set };
