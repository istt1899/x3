'use strict';
// The translation credit in the corner: translated packages with a credit only. Its text is in their
// locale.json (build.py, from kit/localization/credit.<language>.json); other packages carry none.
// A package with a run-time Language setting carries each catalog's credit (credits), drawn while that one is chosen.
const locale = require('./locale.json');
const { getLanguage } = require('./i18n');
const CREDIT = typeof locale.credit === 'string' ? locale.credit : '';
const CREDITS = locale.credits || {};
function drawCredit(canvas, x, baseline) {
    const credit = CREDIT || (Object.prototype.hasOwnProperty.call(CREDITS, getLanguage()) ? String(CREDITS[getLanguage()]) : '');
    if (!credit) return;
    canvas.text(credit, x, baseline, 12, '#ffffff40', { align: 'right', font: 'label' });
}
module.exports = { CREDIT, drawCredit };
