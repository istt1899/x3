'use strict';
const zlib = require('zlib');
const fonts = require('./camera-font.json').sizes.map(s => Object.assign({}, s, { pixels: zlib.inflateSync(Buffer.from(s.alpha,'base64')) }));
const width = 320, height = 96;
const types = ['speed', 'lane', 'redlight', 'average', 'belt', 'stopline', 'pedestrian', 'phone', 'signs_marking', 'road_position', 'camera'];
const captureSides = ['front', 'rear', 'both'];
function confirmedDirection(alert) {
    if (alert.captureDirectionVerified === true && captureSides.includes(alert.captureDirection)) return alert.captureDirection;
    const capture = alert.capture;
    // The guidance classifier also estimates a lens from monitored traffic flow.
    // That estimate is useful for guidance but cannot identify the photographed bumper.
    if (!capture || capture.verified !== true || !alert.captureClass || alert.captureClass === 'cross') return 'unknown';
    if (captureSides.includes(capture.side)) return capture.side;
    return Number.isFinite(capture.facingDeg) && captureSides.includes(alert.captureClass) ? alert.captureClass : 'unknown';
}
function presentation(alert) {
    alert = alert || {};
    const supported = value => types.indexOf(value) >= 0;
    const known = Array.isArray(alert.controls) ? alert.controls.filter((v,i,a) => supported(v) && a.indexOf(v) === i) : [];
    const controls = known.length ? known.slice(0,3) : [supported(alert.type) ? alert.type : 'camera'];
    const validLimit = value => Number.isInteger(value) && value > 0 && value <= 300;
    const roadLimit = alert.roadConfirmed === true && validLimit(alert.limitKmh) ? Math.round(alert.limitKmh) : null;
    const postedLimit = validLimit(alert.postedApproachLimitKmh) ? Math.round(alert.postedApproachLimitKmh) : null;
    const mapSource = alert.roadMapLimitSource;
    const mapLimit = alert.roadConfirmed === true && validLimit(alert.roadMapLimitKmh) && mapSource &&
        mapSource.provider === 'openstreetmap' && mapSource.tag === 'maxspeed' &&
        Number.isSafeInteger(mapSource.wayId) && mapSource.wayId > 0 && String(mapSource.wayId) === String(alert.way) &&
        typeof mapSource.sourceTimestamp === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(mapSource.sourceTimestamp) &&
        Number.isFinite(Date.parse(mapSource.sourceTimestamp)) ? alert.roadMapLimitKmh : null;
    const approach = alert.speedcamApproach;
    const speedcamLimit = !alert.gpsHeld && approach && approach.source === 'SpeedCamOnLine' &&
        /^sco:[a-f0-9]{20}$/.test(approach.id) && Number.isInteger(approach.courseDeg) &&
        approach.courseDeg >= 0 && approach.courseDeg < 360 && validLimit(approach.limitKmh) ? approach.limitKmh : null;
    const limit = roadLimit !== null ? roadLimit : postedLimit !== null ? postedLimit : mapLimit !== null ? mapLimit : speedcamLimit;
    const limitScope = roadLimit !== null ? 'road' : postedLimit !== null ? 'posted' : mapLimit !== null ? 'map' : speedcamLimit !== null ? 'speedcam' : 'unknown';
    const rawSpeed = Number.isFinite(alert.speedKmh) && alert.speedKmh >= 0 && alert.speedKmh <= 400 ? alert.speedKmh : null;
    const speed = rawSpeed === null ? null : Math.round(rawSpeed), warning = alert.speedWarning || {};
    const overspeed = alert.roadConfirmed === true && alert.overspeed === true && roadLimit !== null && rawSpeed !== null && rawSpeed > roadLimit;
    const hiddenBoundary = Number.isFinite(warning.displayBoundaryKmh) && rawSpeed > warning.displayBoundaryKmh && speed <= warning.displayBoundaryKmh ? warning.displayBoundaryKmh :
        overspeed && speed <= roadLimit ? roadLimit : null;
    const direction = confirmedDirection(alert);
    const distanceStale = alert.gpsHeld === true;
    const distance = Number.isFinite(alert.displayDistanceM) && alert.displayDistanceM >= 0 ? alert.displayDistanceM : alert.distanceM;
    return { controls, extraControls: Math.max(0, known.length - controls.length), limit, limitScope, speed,
        speedText:speed===null?'—':hiddenBoundary===null?String(speed):'>'+hiddenBoundary, direction, captureClass: direction,
        distance: !distanceStale && Number.isFinite(distance) && distance >= 0 ? Math.round(distance) : null, distanceStale,
        mode: alert.positionKind === 'intersection' ? 'Ориентир' : alert.roadConfirmed === true ? (alert.controlScope === 'enforcement-location' ? 'Рубеж' : 'По дороге') : 'Рядом',
        test: alert.test === true, calibration: alert.calibration === true, decoy: !!(alert.decoyReport && alert.decoyReport.state === 'reported'),
        overspeed, flashActive:overspeed&&warning.flashActive===true, flashPhase:overspeed&&warning.flashActive===true&&warning.flashPhase===true };
}
function card(alert, target) {
    const model=presentation(alert), px=Buffer.alloc(width*height*4);
    const white=[244,247,250], amber=[255,190,94], red=[255,90,88], muted=[184,194,204], ink=[12,17,24], teal=[128,220,209];
    function put(x,y,color,alpha) {
        x=Math.round(x);y=Math.round(y);if(x<0||x>=width||y<0||y>=height||alpha<=0)return;
        const off=(y*width+x)*4,a=alpha/255,b=px[off+3]/255,out=a+b*(1-a);
        for(let c=0;c<3;c++)px[off+c]=Math.round((color[c]*a+px[off+c]*b*(1-a))/out);
        px[off+3]=Math.round(out*255);
    }
    function rect(x,y,w,h,color,alpha){for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)put(i,j,color,alpha===undefined?255:alpha);}
    function circle(x,y,r,color){for(let j=-r;j<=r;j++)for(let i=-r;i<=r;i++)if(i*i+j*j<=r*r)put(x+i,y+j,color,255);}
    const f = size => fonts.find(v=>v.size===size);
    function text(value,x,baseline,size,color,maxWidth) {
        const font=f(size), start=x;
        for(const ch of String(value)) {
            const g=font.glyphs[ch.codePointAt(0)]||font.glyphs[63];if(!g)continue;
            if(maxWidth && x-start+g[6]>maxWidth)break;
            for(let j=0;j<g[3];j++)for(let i=0;i<g[2];i++)put(x+g[4]+i,baseline+g[5]+j,color,font.pixels[(g[1]+j)*font.atlasW+g[0]+i]);
            x+=g[6];
        }
    }
    function measure(value, size) {
        const glyphs = f(size).glyphs;
        return Array.from(String(value)).reduce((total, c) => total + (glyphs[c.codePointAt(0)] || glyphs[63])[6], 0);
    }
    function centered(value, x, baseline, size, color) {
        text(value, x - measure(value, size) / 2, baseline, size, color);
    }
    function rightAligned(value, x, baseline, size, color) {
        text(value, x - measure(value, size), baseline, size, color);
    }
    function outline(x,y,w,h,color){rect(x,y,w,1,color);rect(x,y+h-1,w,1,color);rect(x,y,1,h,color);rect(x+w-1,y,1,h,color);}
    function line(x1, y1, x2, y2, color, thickness) {
        const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
        for (let i = 0; i <= steps; i++) {
            const x = Math.round(x1 + (x2 - x1) * i / steps), y = Math.round(y1 + (y2 - y1) * i / steps);
            rect(x, y, thickness, thickness, color);
        }
    }
    function cameraBody(x, y, color) {
        rect(x + 2, y, 9, 7, color);
        rect(x, y + 2, 3, 4, color);
        rect(x + 5, y + 2, 4, 2, ink);
    }
    function drawCapture(side) {
        // Top-down vehicle with its bonnet at the top and red tail lamps at the bottom.
        rect(201, 26, 18, 31, white); rect(203, 22, 14, 36, white);
        rect(206, 20, 8, 39, white); rect(203, 30, 14, 5, ink);
        rect(204, 35, 12, 2, ink); rect(205, 37, 10, 1, ink);
        rect(198, 34, 3, 2, white); rect(219, 34, 3, 2, white);
        rect(204, 48, 12, 5, ink);
        rect(202, 55, 4, 2, red); rect(214, 55, 4, 2, red);
        // The arrow head terminates at the corresponding bumper, not at the lens.
        function beam(front) {
            const cameraY = front ? 4 : 69, tipY = front ? 19 : 60, sign = front ? -1 : 1;
            cameraBody(230, cameraY, teal);
            line(230, cameraY + 3, 214, tipY, teal, 2);
            line(214, tipY, 217, tipY + sign * 6, teal, 2);
            line(214, tipY, 221, tipY - sign, teal, 2);
        }
        if (side === 'front' || side === 'both') beam(true);
        if (side === 'rear' || side === 'both') beam(false);
        if (side === 'unknown') {
            cameraBody(228, 26, muted);
            text('?', 226, 51, 18, muted);
        }
    }
    function icon(type,x,y) {
        outline(x,y,22,22,amber);
        if(type==='redlight') {circle(x+11,y+5,2,red);circle(x+11,y+11,2,amber);circle(x+11,y+17,2,white);}
        else if(type==='speed') {circle(x+11,y+11,7,white);circle(x+11,y+11,5,ink);for(let k=0;k<5;k++)rect(x+11+k,y+12-k,2,2,amber);}
        else if(type==='signs_marking') {rect(x+4,y+16,14,2,white);rect(x+5,y+6,4,2,amber);rect(x+12,y+6,4,2,amber);}
        else if(type==='road_position') {rect(x+4,y+4,2,14,white);rect(x+16,y+4,2,14,white);outline(x+8,y+8,7,8,amber);}
        else if(type==='lane') {rect(x+5,y+4,2,14,white);rect(x+15,y+4,2,14,white);rect(x+10,y+4,2,4,amber);rect(x+10,y+12,2,5,amber);}
        else if(type==='belt') {for(let k=4;k<18;k++)rect(x+k,y+21-k,2,2,white);rect(x+9,y+8,5,5,amber);}
        else if(type==='phone') {outline(x+6,y+3,10,16,white);rect(x+8,y+5,6,9,amber);rect(x+10,y+16,2,1,white);}
        else if(type==='average') {circle(x+11,y+11,7,white);circle(x+11,y+11,5,ink);rect(x+10,y+6,2,6,amber);rect(x+11,y+10,5,2,amber);}
        else if(type==='stopline') {rect(x+4,y+15,14,3,white);rect(x+10,y+4,2,8,amber);}
        else if(type==='pedestrian') {circle(x+11,y+5,2,white);rect(x+10,y+9,2,8,white);rect(x+6,y+12,10,2,amber);}
        else {rect(x+4,y+7,14,10,white);rect(x+6,y+4,6,3,white);circle(x+12,y+12,4,ink);circle(x+12,y+12,2,amber);}
    }
    // Atlas keeps the sign, approach and capture graphic in fixed columns. The only
    // background is the saved alpha of the compact card on the map layer.
    if (target === 'map') {
        const radius = 7;
        for (let y = 0; y < height; y++) {
            const edge = Math.max(radius - Math.min(y, height - 1 - y), 0);
            const inset = Math.round(radius - Math.sqrt(radius * radius - edge * edge));
            rect(inset, y, width - inset * 2, 1, [10,16,24], 232);
        }
    }

    const labelledLimit = ['posted','map','speedcam'].includes(model.limitScope);
    const signColor = model.limitScope === 'road' ? red : labelledLimit ? amber : muted;
    circle(39, 36, 26, signColor);
    circle(39, 36, 21, white);
    centered(model.limit === null ? '—' : model.limit, 39, 44, 24, ink);
    centered('Лимит', 39, labelledLimit ? 78 : 85, 18, muted);
    if (labelledLimit) centered(model.limitScope === 'map' ? 'карта' : model.limitScope === 'speedcam' ? 'база' : 'знак', 39, 94, 18, amber);

    rect(73, 9, 1, 78, [60,77,86]);
    rect(190, 9, 1, 78, [60,77,86]);
    const heading = model.distanceStale ? 'Нет GPS' : model.decoy ? 'Муляж' : model.mode === 'По дороге' ? 'Камера' : model.mode;
    text(heading, 82, 23, 18, model.distanceStale || model.decoy ? amber : teal, 105);
    const kilometers = model.distance !== null && model.distance >= 1000;
    const distanceText = model.distance === null ? '—' : kilometers ? (model.distance / 1000).toFixed(1).replace('.', ',') : String(model.distance);
    const distanceUnits = kilometers ? 'км' : 'м';
    const distanceSize = measure(distanceText, 32) + measure(distanceUnits, 18) + 5 <= 107 ? 32 : 24;
    const roomForDistance = 107 - 5 - measure(distanceUnits, 18);
    text(distanceText, 82, 63, distanceSize, white, roomForDistance);
    text(distanceUnits, 87 + Math.min(measure(distanceText, distanceSize), roomForDistance), 63, 18, muted);
    model.controls.forEach((type, index) => icon(type, 81 + index * 25, 71));
    if (model.extraControls) text('+' + model.extraControls, 155, 89, 18, amber, 35);

    drawCapture(model.direction);
    const speedSize = measure(model.speedText, 32) <= 65 ? 32 : 24;
    const speedColor = model.overspeed && (!model.flashActive || model.flashPhase) ? red : white;
    rightAligned(model.speedText, 308, 55, speedSize, speedColor);
    rightAligned('км/ч', 308, 73, 18, muted);
    const directionLabel = { front: 'В лоб', rear: 'В спину', both: 'Обе стороны', unknown: 'Неизвестно' }[model.direction];
    rightAligned(directionLabel, 313, 94, 18, model.direction === 'unknown' ? muted : teal);
    if (model.test || model.calibration) {
        rightAligned(model.calibration ? 'КАЛИБР.' : 'ТЕСТ', 308, 22, 18, amber);
    }
    if(model.calibration) {
        // Mark only this card's boundary. It cannot obscure the whole panel.
        outline(0,0,width,height,amber);
        [[0,0],[width-9,0],[0,height-9],[width-9,height-9]].forEach(p=>{rect(p[0],p[1],9,2,white);rect(p[0],p[1],2,9,white);});
    }
    return px;
}
module.exports={card,width,height,presentation};
