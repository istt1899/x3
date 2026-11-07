// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const mgu = require('./kit/mgu');
const { DiagnosticProbe } = require('./diagnostics.js');
const { FEATURES } = require('./catalog.js');
const { model, PAGE_SIZE } = require('./view_model.js');

mgu.run({
    async start(ctx) {
        const { app, ui, log } = ctx;
        const probe = new DiagnosticProbe();
        let scanResult = null;
        let page = 0;
        let selected = null;

        // The probe creates its own fixed UDS discovery request. No vehicle
        // operation runs until the user presses the scan button.
        app.on('shutdown', () => {
            Promise.resolve().then(() => probe.close())
                .catch((error) => log.warn('diagnostics close: ' + String(error && error.message || error)));
        });

        function render() {
            const view = model(scanResult, page, selected);
            const writes = [];
            const write = (name, action) => Promise.resolve().then(action).catch((error) => {
                log.warn('UI ' + name + ': ' + String(error && error.message || error).slice(0, 160));
            });
            Object.keys(view.text).forEach((name) => {
                const component = name === 'codingTitle' ? 'detailTitle' : name;
                writes.push(write(component, () => ui.text(component, view.text[name])));
            });
            Object.keys(view.visible).forEach((name) => {
                writes.push(write(name, () => ui.visible(name, view.visible[name])));
            });
            Object.keys(view.enabled).forEach((name) => {
                writes.push(write(name, () => ui.enabled(name, view.enabled[name])));
            });
            return Promise.all(writes);
        }

        function scan() {
            if (scanResult && scanResult.scanning) return;
            scanResult = { scanning: true };
            render();
            return Promise.resolve().then(() => probe.scan()).then((result) => {
                if (result.technicalError) log.warn('diagnostics ' + result.error + ': ' +
                    String(result.technicalError).replace(/[\r\n\t]/g, ' ').slice(0, 160));
                scanResult = { available: result.available, ecus: result.ecus, error: result.error };
                return render();
            }).catch((error) => {
                log.warn('diagnostics: ' + String(error && error.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 160));
                scanResult = { available: false, ecus: [], error: 'UNKNOWN_ERROR' };
                return render();
            });
        }

        ui.onClick('codingScan', scan);
        for (let slot = 0; slot < PAGE_SIZE; slot++) {
            ui.onClick('codingSlot' + (slot + 1), () => {
                const index = page * PAGE_SIZE + slot;
                if (index >= FEATURES.length) return;
                selected = index;
                return render().then(() => ui.open('DETAIL'));
            });
        }
        ui.onClick('codingPrev', () => { page = 0; return render(); });
        ui.onClick('codingNext', () => { page = 1; return render(); });
        ui.onClick('codingBack', () => {
            selected = null;
            return render().then(() => ui.close('DETAIL'));
        });

        // AppKit maps the entry point, loads screen resources and calls
        // OnlineApp.initialized() after start() returns. Keep this path prompt.
        render();
    },
});
