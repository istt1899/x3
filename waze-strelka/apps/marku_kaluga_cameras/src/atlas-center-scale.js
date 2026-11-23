// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const fs = require('fs');
const path = require('path');
const fields = ['atlasCenterCameraScale', 'atlasCenterMapScale'];
const valid = n => Number.isInteger(n) && n >= 65 && n <= 125 && (n - 65) % 5 === 0;

// OAP sets the working directory to this application's persistent data directory.
class CenterScale {
    constructor(directory) {
        this.directory = directory || process.cwd();
        this.values = {};
        this.error = '';
        for (const field of fields) {
            try {
                const n = JSON.parse(fs.readFileSync(this.file(field), 'utf8'));
                if (!valid(n)) throw new Error('invalid scale');
                this.values[field] = n;
            } catch (err) {
                if (err.code !== 'ENOENT') this.error = 'Не удалось прочитать сохранённый размер';
            }
        }
    }
    file(field) {
        if (!fields.includes(field)) throw new Error('Unknown display scale');
        return path.join(this.directory, field + '.json');
    }
    get(field) { return this.values[field] || 100; }
    set(field, step) {
        const file = this.file(field);
        if (!Number.isInteger(step) || step < 0 || step > 12) throw new RangeError('Invalid scale step');
        const pct = 65 + 5 * step, temporary = file + '.' + process.pid + '.tmp';
        try {
            fs.writeFileSync(temporary, String(pct) + '\n', { mode: 0o600 });
            fs.renameSync(temporary, file);
        } catch (err) {
            try { fs.unlinkSync(temporary); } catch (_) {}
            this.error = 'Не удалось сохранить размер в автомобиле';
            throw err;
        }
        this.error = '';
        this.values[field] = pct;
    }
}
module.exports = CenterScale;
