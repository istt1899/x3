'use strict';
// The HMI displays entry-point PNGs at their native size. Match kit/make_icon.js:
// 140x140 RGBA, transparent margins, white anti-aliased strokes and one accent.
const fs = require('fs');
const { Canvas } = require('../core/kit/runtime/canvas');
const service = process.argv[2], out = process.argv[3];
if (!out || ['vk', 'rutube'].indexOf(service) < 0) throw new Error('Usage: make_video_icon.js vk|rutube out.png');
const c = new Canvas(140, 140), white = '#ffffff';
c.strokeRoundRect(16, 16, 108, 108, 23, 5, white);
if (service === 'vk') {
    c.polyline([[34, 49], [47, 88], [60, 49]], 7, white);
    c.line(77, 49, 77, 88, 7, white);
    c.polyline([[101, 49], [78, 69], [102, 88]], 7, white);
    c.roundRect(43, 103, 54, 6, 3, '#0077ff');
} else {
    c.line(40, 49, 40, 89, 7, white);
    c.polyline([[40, 49], [59, 49], [69, 56], [69, 65], [59, 72], [40, 72]], 7, white);
    c.line(56, 72, 72, 89, 7, white);
    c.triangle([[86, 51], [107, 69], [86, 87]], '#f02f43');
    c.roundRect(43, 103, 54, 6, 3, '#f02f43');
}
fs.writeFileSync(out, c.png(9));
