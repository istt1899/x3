'use strict';
/**
 * fonts.js - loads the pre-baked glyph atlases (kit/runtime/fonts/*.json,
 * made by kit/tools/bake_fonts.py) and picks the best size for a request.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, 'fonts');
const families = Object.create(null);

function family(name) {
    if (families[name] !== undefined) return families[name];
    let fam = null;
    try {
        const j = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
        fam = j.sizes.map((s) => ({
            size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
            glyphs: s.glyphs, _alpha: s.alpha, alpha: null, family: name, cacheKey: j.cacheKey || '',
        }));
        // mgu-render closes the connection on an atlas over 4096 rows (main.c M_ATLAS), the app then leaves full
        // screen: cjk-titles' 52 px (18403 rows) drops out and its 14 px draws the big titles
        const fits = fam.filter((f) => !(f.atlasH > 4096));
        if (fits.length) fam = fits;
    } catch (e) { fam = null; }
    families[name] = fam;
    return fam;
}

/** Smallest baked size >= requested (downscaling looks better), else largest. */
function get(name, size, text) {
    // Shared supplemental atlases avoid duplicating glyphs in every numeric size.
    if (text && /[\u3000-\u9fff\uff00-\uffef]/.test(text)) {
        name = 'cjk';
        const primary = family(name), titles = family('cjk-titles');
        if (titles && (!primary || Array.from(text).some((ch) => !primary[0].glyphs[ch.codePointAt(0)]))) {
            name = 'cjk-titles';
        }
    }
    // Cyrillic (a title, a channel): the same weight's companion (bake_fonts.py --cyrillic), else the regular one,
    // else a Russian build's own atlas
    else if (text && /[\u0400-\u04ff]/.test(text)) name = family(name + '_cyr') ? name + '_cyr' : family('label_cyr') ? 'label_cyr' : 'cyrillic';
    const fam = family(name) || family('label');
    if (!fam) return null;
    let best = null;
    for (const f of fam) if (f.size >= size && (!best || f.size < best.size)) best = f;
    if (!best) best = fam[fam.length - 1];
    if (!best.alpha) best.alpha = zlib.inflateSync(Buffer.from(best._alpha, 'base64'));
    return best;
}

// A letter the atlas lacks draws as the closest one it has, rather than dropping out of the word: Romanian's
// comma-below ș ț Ș Ț (U+0218-U+021B) as the cedilla ş ţ Ş Ţ every family has ("Știri" kept "tiri"), and an
// accented Latin letter outside the baked ranges (Vietnamese ạ ế, Latin Extended-B and Additional) as its base
// letter. The atlases stay as they are (they are shared between apps by family and size).
const ALIKE = { 0x218: 0x15e, 0x219: 0x15f, 0x21a: 0x162, 0x21b: 0x163 };
const NFD = (() => { try { return 'é'.normalize('NFD').length === 2; } catch (e) { return false; } })();   // a Node without ICU data: no base letters

/** The glyph a character draws with in atlas f: its own, else the closest one (above), else undefined (dropped). */
function glyph(f, ch) {
    const cp = ch.codePointAt(0);
    let g = f.glyphs[cp];
    if (g) return g;
    if (ALIKE[cp] !== undefined && (g = f.glyphs[ALIKE[cp]])) return g;
    if (NFD && cp >= 0xc0 && cp < 0x1f00) {
        const base = ch.normalize('NFD').codePointAt(0);
        if (base !== cp) return f.glyphs[base];
    }
    return undefined;
}

function measure(f, s) {
    let w = 0;
    for (const ch of s) { const g = glyph(f, ch); if (g) w += g[6]; }   // (no glyph: dropped, as drawn)
    return w;
}

module.exports = { get, measure, glyph };
