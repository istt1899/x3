'use strict';
const assert = require('assert');
const card = require('../native/marku-kaluga-cameras/files/alert-card');
const input = { captureDirectionVerified: true, cameraLimitKmh: 40, roadConfirmed: true, limitKmh: 40, distanceM: 180, speedKmh: 32 };
for (const target of ['hud', 'map']) {
    for (const side of ['front', 'rear', 'both', 'unknown']) {
        const styles = new Set();
        for (const style of ['beam', 'pulse', 'trail']) {
            const draw = phase => card.card(Object.assign({}, input, {
                captureDirection: side, opticsStyle: style, opticsFrame: phase
            }), target);
            const first = draw(0), next = draw(1.4);
            let changed = 0;
            for (let offset = 0; offset < first.length; offset += 4) {
                if (first.readUInt32LE(offset) === next.readUInt32LE(offset)) continue;
                changed++;
                const x = (offset / 4) % card.width, y = Math.floor(offset / 4 / card.width);
                assert(x >= 209 && x <= 243, 'Animation must stay in its optical diagram');
                assert((side !== 'rear' && y < 24) || (side !== 'front' && y >= 56 && y < 80), 'Only the selected bumper may animate');
            }
            assert.strictEqual(changed > 0, side !== 'unknown');
            styles.add(first.toString('base64'));
        }
        assert.strictEqual(styles.size, side === 'unknown' ? 1 : 3);
    }
}
console.log('Three distinct HUD/cluster animations, stable numbers and neutral unknown direction OK');
