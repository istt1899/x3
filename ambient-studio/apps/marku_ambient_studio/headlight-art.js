'use strict';

const path = require('path');
const { open } = require('./kit/pack');
const { makeLayer, softLayer } = require('./kit/record');

// mgu-render/1 has no IMAGE operation. Upload the prepared photo tiles as a
// cached layer once, and use the same layer in the software renderer.
let front;
function frontLayer() {
    if (front !== undefined) return front;
    const { width, height, rects } = open(path.join(__dirname, 'headlight-assets')).json('front.json');
    front = width > 0 && height > 0 && Array.isArray(rects) ? makeLayer(width, height, (layer) => {
        layer.clear('#121b23');
        for (let i = 0; i < rects.length; i += 5) layer.fillRect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3], rects[i + 4]);
    }) : null;
    return front;
}

function lamps(cv, xs, color) {
    xs.forEach((points) => {
        cv.polyline(points, 18, color === '#ff7575' ? '#553035' : '#254c62');
        cv.polyline(points, 8, color);
        cv.polyline(points, 3, '#f5faff');
    });
}

function drawHeadlights(cv, mask) {
    if (mask & 48) {
        cv.roundRect(151, 239, 325, 89, 26, '#263640');
        cv.strokeRoundRect(151, 239, 325, 89, 26, 2, '#546674');
        cv.strokeRoundRect(237, 210, 153, 54, 13, 2, '#546674');
        cv.roundRect(270, 278, 87, 32, 5, '#18222a');
        if (mask & 16) lamps(cv, [[[174, 267], [232, 270]], [[397, 270], [452, 267]]], '#ff7575');
        else lamps(cv, [[[174, 285], [215, 287]], [[413, 287], [453, 285]]], '#c1e8fa');
        return;
    }
    const art = frontLayer();
    if (art) cv.blit(cv.words ? art : softLayer(art), 159, 180);
    const right = [[180, 274], [197, 279], [220, 280]];
    const left = [[408, 280], [431, 279], [448, 274]];
    if (mask & 2) lamps(cv, [right], '#b8e8fa');
    if (mask & 1) lamps(cv, [left], '#b8e8fa');
    if (mask & 4) lamps(cv, [[[192, 316], [223, 321]], [[404, 321], [436, 316]]], '#c1d9f8');
    if (mask & 8) {
        cv.polyline(right, 4, '#d5e4ec');
        cv.polyline(left, 4, '#d5e4ec');
    }
}

module.exports = { drawHeadlights };
