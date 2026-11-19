'use strict';
// Local display translation only. Never use this on signal names, IDs or stored settings.
const fs = require('fs');
const path = require('path');
const locale = require('./locale.json');
const dict = Object.assign({}, locale.strings || {});   // changed in place by setLanguage (callers keep this object)
const BAKED = locale.language || 'en';
let language = BAKED;
let localizedValues, folded, phrases, pattern;
const cache = new Map();
function getLanguage() { return language; }
// Plural forms live in the locale catalogs: "fault|faults<TAB>ошибка|ошибки|ошибок".
// The key is the English text for 1 and for many, exactly as English shows it (both the same
// when English does not change, e.g. "items|items"). Without a row the English form is returned
// and the drawn line goes through t() as before, so catalogs without plural rows (zh-CN) render unchanged.
// The rule picks the form index; Node 8 on the car has no Intl.PluralRules.
const PLURAL_RULES = {
    en: (n) => (n === 1 ? 0 : 1),
    ru: (n) => { // one | few | many
        const mod100 = Math.abs(n) % 100, mod10 = mod100 % 10;
        if (mod100 >= 11 && mod100 <= 14) return 2;
        if (mod10 === 1) return 0;
        return mod10 >= 2 && mod10 <= 4 ? 1 : 2;
    },
    'zh-CN': () => 0,
};
function plural(n, one, other, lang) {
    const key = one + '|' + other, lng = lang || language;
    const translated = lng !== 'en' && Object.prototype.hasOwnProperty.call(dict, key) && (!lang || lang === language);
    if (!translated) return n === 1 ? one : other;
    const forms = dict[key].split('|'), rule = PLURAL_RULES[lng] || PLURAL_RULES.en;
    return forms[Math.min(rule(n), forms.length - 1)];
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function index() {
    localizedValues = new Set(Object.values(dict));
    folded = Object.create(null);
    Object.keys(dict).forEach((key) => { folded[key.toLowerCase()] = dict[key]; });
    phrases = Object.keys(dict).filter((s) => s.length >= 4 && s.indexOf('|') < 0).sort((a, b) => b.length - a.length);
    pattern = new RegExp('(^|[^A-Za-z0-9_./])(' + phrases.map(escape).join('|') + ')(?=$|[^A-Za-z0-9_./])', 'gi');
    cache.clear();
}
index();
/** The catalogs a package carries (locales/<tag>.json), English always. */
function languages() {
    let tags = [];
    try { tags = fs.readdirSync(path.join(__dirname, 'locales')).filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f)).map((f) => f.slice(0, -5)); } catch (e) { /* none */ }
    return ['en'].concat(tags.filter((x) => x !== 'en'), tags.indexOf(BAKED) < 0 && BAKED !== 'en' ? [BAKED] : []);
}
/** Switch the display language at run time (a Language setting): the baked locale.json, locales/<lang>.json, or
 *  English. Unknown or unreadable: nothing changes, false. */
function setLanguage(lang) {
    if (lang === language) return true;
    let strings = null;
    if (lang === 'en') strings = {};
    else if (lang === BAKED) strings = locale.strings || {};
    else if (languages().indexOf(lang) >= 0) {
        try { strings = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', lang + '.json'), 'utf8')); } catch (e) { return false; }
    } else return false;
    Object.keys(dict).forEach((k) => { delete dict[k]; });
    Object.assign(dict, strings);
    language = lang;
    index();
    return true;
}
function t(value) {
    const s = String(value == null ? '' : value);
    if (language === 'en') return s;
    if (!/[A-Za-z]/.test(s)) return s; // numeric telemetry / already translated labels: hot path
    if (s.trim() === 'rpm') return s; // preserve the physical unit; uppercase RPM headings may translate
    if (cache.has(s)) return cache.get(s);
    const key = s.trim();
    if (localizedValues.has(key)) return s;
    let out;
    if (Object.prototype.hasOwnProperty.call(dict, key)) {
        out = s.slice(0, s.indexOf(key)) + dict[key] + s.slice(s.indexOf(key) + key.length);
    } else if (Object.prototype.hasOwnProperty.call(folded, key.toLowerCase())) {
        out = s.slice(0, s.indexOf(key)) + folded[key.toLowerCase()] + s.slice(s.indexOf(key) + key.length);
    } else {
        // Short words need context: "min 70" is a minimum, "12 min" is minutes.
        out = language === 'zh-CN' ? s.replace(/\bmin(?=\s+-?\d)/g, '最小').replace(/\bmax(?=\s+-?\d)/g, '最大')
            .replace(/\bAVG(?=\s+[+-]?\d)/g, '平均').replace(/\bACC\b/g, '加速') :
            language === 'ru' ? s.replace(/\bmin(?=\s+-?\d)/g, 'мин.').replace(/\bmax(?=\s+-?\d)/g, 'макс.')
                .replace(/\bAVG(?=\s+[+-]?\d)/g, 'СРЕД.').replace(/\bACC\b/g, 'РАЗГОН') : s;
        out = out.replace(pattern, (_, before, word) => before + (dict[word] || folded[word.toLowerCase()]));
    }
    if (cache.size >= 2048) cache.clear();
    cache.set(s, out);
    return out;
}
module.exports = { t, plural, PLURAL_RULES, dict, getLanguage, setLanguage, languages, BAKED };
