'use strict';

const EventEmitter = require('events');
const { Control } = require('./control');
const { Ambient } = require('./ambient');
const { sample } = require('./lin');
const scenes = require('./scenes');

// The desktop preview uses the same saved looks and scene renderer as the car.
// It never starts the signal client, diagnostic scanner or vehicle light drivers.
function previewCabin(ctx) {
    const ambient = new Ambient({ settings: ctx.settings, log: ctx.log });
    const lights = new EventEmitter();
    lights.lights = sample();
    lights.state = 'preview';
    let since = Date.now();
    lights.show = (scene) => { lights.scene = scene; since = Date.now(); lights.emit('change'); };
    lights.carColour = () => lights.show(null);
    lights.at = (l) => lights.scene ? scenes.lightAt(lights.scene, l, Date.now() - since) : null;
    const control = new Control({ settings: ctx.settings, log: ctx.log, ambient, lights });
    if (ctx.settings.get('keep') === false) control.carColour();
    else control.apply();
    scenes.setDecor(ctx.settings.get('decorWith'));
    ctx.settings.onChange((key) => { if (key === 'decorWith') scenes.setDecor(ctx.settings.get(key)); });
    return { lights, control, ambient, others: new EventEmitter() };
}
module.exports = { previewCabin };
