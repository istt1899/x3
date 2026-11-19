'use strict';
/**
 * The health check page (cap health, 0.4.0 service): what the service tests on the car (network, sign-in, the
 * fetcher, free space, ...), one row each with ok / failed and its line, then Run again. Text only: nothing to
 * type, so it works driving or parked. Where the HMI runs the screen (no buttons drawn), the menu entry pressed
 * again runs it again. The service sends the rows as each check finishes, then done.
 *
 *   const drawHealth = require('./health')({ model, say, fit, t, message, count, C, focus, X0, TOP, H, W, OFF, OFF2 });
 *   drawHealth(cv)        // from render, mode 'health'
 */
module.exports = function healthPage(o) {
    const { model, say, fit, t, C, TOP, H, W } = o;   // t: translate; o.message: a sentence with {values}; o.X0 per frame (fill)
    const LIT = { literal: true }, LITB = { literal: true, font: 'bold' };
    const GREEN = '#35d07f', GREY = '#5c6380';
    // the service's keys in the order shown (the rows come as each probe ends); others after them, as they came
    const ORDER = ['service', 'node', 'node22', 'python', 'ytdlp', 'uid', 'lease', 'dns', 'tls', 'free', 'audio', 'socket'];
    const rank = (k) => { const i = ORDER.indexOf(k); return i < 0 ? ORDER.length : i; };
    // "... unknown" (e.g. the socket lock before that package lands): not a failure, a grey dash
    const unknown = (r) => !r.ok && /\bunknown\b/i.test(r.text);
    const mark = (cv, x, y, ok, unk) => {
        cv.circle(x, y, 15, ok ? GREEN : unk ? GREY : C.red);
        if (ok) cv.polyline([[x - 7, y], [x - 2, y + 6], [x + 8, y - 6]], 4, '#ffffff');
        else if (unk) cv.line(x - 7, y, x + 7, y, 4, '#ffffff');
        else { cv.line(x - 6, y - 6, x + 6, y + 6, 4, '#ffffff'); cv.line(x - 6, y + 6, x + 6, y - 6, 4, '#ffffff'); }
    };
    return function drawHealth(cv) {
        const X0 = o.X0;
        if (!model.connected) return say(cv, o.OFF, o.OFF2);
        const h = model.health || { items: [], loading: false };
        const bottom = H + (cv.own ? cv.extra : 0), rows = h.items.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r.key) - rank(b.r.key) || a.i - b.i).map((x) => x.r);
        const bad = rows.filter((r) => !r.ok && !unknown(r)).length;
        const head = h.loading ? t('Checking...') : h.error ? t('Health check: ') + t(h.error)
            : !rows.length ? t('No result yet') : bad ? o.count(bad, '{count} check failed', '{count} checks failed', t) : t('Everything works');
        const tw = cv.text(t('Health check'), X0, TOP + 44, 30, '#ffffff', LITB);
        cv.text(fit(cv, head, 22, 700, LIT), X0 + tw + 18, TOP + 44, 22, bad ? '#ff8f8f' : C.dim, LIT);
        // the rows: one column, two when they do not fit (the rest counted)
        const y0 = TOP + 92, pitch = 46, btnH = 76, perCol = Math.max(1, Math.floor((bottom - y0 - btnH - 30) / pitch));
        const cols = rows.length > perCol ? 2 : 1, colW = Math.floor((W - X0 - 40) / cols) - 20, room = perCol * cols;
        rows.slice(0, room).forEach((r, i) => {
            const x = X0 + Math.floor(i / perCol) * (colW + 20), y = y0 + (i % perCol) * pitch;
            const unk = unknown(r);
            mark(cv, x + 15, y - 8, r.ok, unk);
            const kw = cv.text(fit(cv, r.key, 24, 260, LITB), x + 44, y, 24, C.text, LITB);
            if (r.text) cv.text(fit(cv, r.text, 22, colW - 64 - kw, LIT), x + 44 + kw + 14, y, 22, r.ok || unk ? C.dim : '#ffb3b3', LIT);
        });
        if (rows.length > room) cv.text(o.message('+{count} more', { count: rows.length - room }), X0, y0 + perCol * pitch, 22, C.dim, LIT);
        const by = bottom - btnH - 20;
        if (!cv.own) return cv.text(t('To run it again, press Health check in the menu again'), X0, by + 48, 24, C.dim, LIT);
        if (h.loading) return undefined;
        const label = rows.length || h.error ? t('Run again') : t('Run the check'), bw = Math.max(300, cv.textWidth(label, 30, LITB) + 80), f = o.focus() === 'health:run';
        cv.roundRect(X0, by, bw, btnH, 38, f ? '#ffffff' : C.red);
        cv.text(label, X0 + bw / 2, by + 49, 30, f ? '#0f0f0f' : '#ffffff', { literal: true, font: 'bold', align: 'center' });
        cv.target(X0, by, bw, btnH, () => model.runHealth(), 'health:run', 38);
        return undefined;
    };
};
