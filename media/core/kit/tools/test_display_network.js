'use strict';
// Display visibility when the HMI keeps VIEW in the stack beneath NETWORK.
const assert = require('assert');
process.env.MGU_RENDERER = 'software'; // construct without a renderer socket, then use a deterministic GPU stand-in
const { Display } = require('../runtime/display');

const visible = new Set(['VIEW']), handlers = [], shows = [];
const ui = {
    onVisible: (fn) => handlers.push(fn),
    isVisible: (name) => visible.has(name),
};
const spec = { id: 'marku_vk_video', title: 'VK Видео', screens: [
    { name: 'VIEW', kind: 'canvas', buttons: [['BTN_NETWORK', 'Интернет']] },
    { name: 'NETWORK', kind: 'menu' },
] };
const log = { info() {}, warn() {}, error(e) { throw e; } };
const display = new Display(ui, log, spec, { get() {}, onChange() {} }, () => ({ bg: '#000000' }));
display.gpu = {
    ready: true, visible: true, native: false,
    show(on) { this.visible = on; shows.push(on); },
};
display.place = { full: false, scale: 1 };
const setVisible = (name, on) => {
    if (on) visible.add(name); else visible.delete(name);
    handlers.forEach((fn) => fn(name, on));
};

(async () => {
    try {
        assert(display.active('VIEW'), 'VIEW starts on the GPU');
        setVisible('NETWORK', true);
        assert(visible.has('VIEW'), 'the HMI may leave VIEW in its stack');
        assert.strictEqual(display.active('VIEW'), false, 'NETWORK covers VIEW even when both are visible');
        assert.strictEqual(display.gpu.visible, false, 'GPU surface is hidden for the HMI menu');
        assert.strictEqual(shows[shows.length - 1], false);
        setVisible('NETWORK', false);
        assert(display.active('VIEW'), 'VIEW becomes the active screen again');
        await new Promise((resolve) => setTimeout(resolve, 450));
        assert.strictEqual(display.gpu.visible, true, 'GPU surface returns after the HMI transition');
        assert.strictEqual(shows[shows.length - 1], true);
        setVisible('SETTINGS', true);
        assert.strictEqual(display.gpu.visible, false, 'existing Settings behavior remains');
    } finally { clearTimeout(display.showTimer); }
    console.log('ok: NETWORK hides GPU above a stacked VIEW and return restores it');
})().catch((e) => { console.error(e); process.exitCode = 1; });
