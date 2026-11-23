'use strict';

const G = require('./kit/gauges');
const { drawCabin } = require('./cabin');
const { sample } = require('./lin');
const scenes = require('./scenes');

const sequences = [
    { name: 'Вместе', frames: [0, 3, 0, 3] },
    { name: 'По очереди', frames: [1, 0, 2, 0] },
    { name: 'Осмотр', frames: [1, 2, 3, 0] },
];
const presets = [
    { name: 'Янтарь', upper: [255, 156, 50], lower: [192, 77, 32], bright: 65 },
    { name: 'Ледник', upper: [80, 186, 242], lower: [54, 100, 220], bright: 55 },
    { name: 'Сумерки', upper: [162, 109, 244], lower: [57, 69, 156], bright: 35 },
];
const holds = [500, 1000, 1500, 2000];
const defaultTimes = [1000, 1000, 1000, 1000];
const seconds = (ms) => String(ms / 1000).replace('.', ',') + ' с';
const sections = ['Фары и эффекты', 'Салон', 'Проверка'];
const masks = ['Обе выключены', 'Левая включена', 'Правая включена', 'Обе включены'];
const validFrames = (xs) => Array.isArray(xs) && xs.length === 4 && xs.every((v) => Number.isInteger(v) && v >= 0 && v <= 3);
const lookFor = (p) => ({ kind: 'solid', upper: { rgb: p.upper.slice(), bright: p.bright }, lower: { rgb: p.lower.slice(), bright: p.bright }, speed: 2 });

// The diagram is a still image. Only a user action can change the selected frame.
function drawFront(cv, mask) {
    const edge = '#516171', metal = '#a1aebb', dark = '#19222d', off = '#394554', beam = '#8edbff';
    cv.roundRect(163, 236, 438, 88, 34, dark);
    cv.polyline([[170,265],[186,232],[222,219],[256,172],[285,159],[478,159],[513,173],[545,218],[581,232],[596,265]], 4, edge);
    cv.polyline([[236,215],[267,178],[285,171],[475,171],[500,181],[531,215],[236,215]], 3, edge);
    cv.polyline([[185,281],[212,298],[310,305],[456,305],[552,296],[579,282]], 3, edge);
    [337,391].forEach((x) => {
        cv.strokeRoundRect(x, 247, 45, 29, 8, 2, metal);
        [10,18,26,34].forEach((dx) => cv.line(x + dx, 253, x + dx, 270, 2, edge));
    });
    [[203, 2], [455, 1]].forEach(([x, bit]) => {
        const on = !!(mask & bit);
        if (on) cv.roundRect(x - 8, 238, 116, 40, 16, '#274456');
        cv.roundRect(x, 244, 100, 26, 10, on ? '#3a677e' : '#242f3a');
        cv.polyline([[x+8,250],[x+23,260],[x+50,261],[x+60,253],[x+72,261],[x+91,257]], 5, on ? beam : off);
    });
}
function lightStudio(ctx, control, lights, redraw, go) {
    const { settings } = ctx;
    let section = 0, frame = 0, report = null, saved = false;
    const chosen = () => {
        const value = settings.get('studioSequence');
        return Number.isInteger(value) && value >= 0 && value <= 3 ? value : 2;
    };
    const custom = () => validFrames(settings.get('studioFrames')) ? settings.get('studioFrames').slice() : [0, 0, 0, 0];
    const frames = () => chosen() === 3 ? custom() : sequences[chosen()].frames;
    function durations() {
        const value = settings.get('studioTimes');
        return chosen() === 3 && Array.isArray(value) && value.length === 4 &&
            value.every((n) => holds.includes(n)) ? value.slice() : defaultTimes.slice();
    }
    function edit(bit) {
        const xs = frames().slice(), times = durations();
        if (bit) xs[frame] ^= bit;
        else times[frame] = holds[(holds.indexOf(times[frame]) + 1) % holds.length];
        settings.set('studioFrames', xs);
        settings.set('studioTimes', times);
        settings.set('studioSequence', 3);
    }
    function check() {
        const model = sample();
        const colour = scenes.lightAt(lookFor(presets[0]), { part: 'upper', y: 0 }, 0);
        report = [
            ['Модель салона', model.some((l) => l.part === 'upper') && model.some((l) => l.part === 'lower')],
            ['Цвет и яркость', scenes.hex(colour.rgb) === '#ff9c32' && colour.bright === 65],
            ['Кадры фар', validFrames(frames()) && sequences.every((s) => validFrames(s.frames))],
        ];
    }
    return function draw(cv, t) {
        const label = (value, x, y, size, color, opts) => cv.text(value, x, y, size, color || t.text, opts);
        const button = (x,y,w,h,name,key,fn,on) => G.button(cv,t,x,y,w,h,name,() => { fn(); return redraw(); }, { key: 'studio-' + key, primary: !!on });
        const title = (name,x,y) => label(name,x,y,32,t.text,{ font: 'bold' });
        const card = (x,y,w,h) => cv.roundRect(x,y,w,h,15,'#151d26');
        let tabX = 26;
        [306,174,210].forEach((width, i) => {
            button(tabX,43,width,46,sections[i],'section'+i,() => { section=i; saved=false; },section===i);
            tabX += width + 12;
        });
        label(ctx.preview ? 'Эмулятор iDrive' : 'Предпросмотр', 1554,75,23,t.dim,{ align:'right' });
        card(24,104,720,397); card(760,104,816,397);
        if (section === 0) {
            title('Дальний свет',52,151);
            drawFront(cv, frames()[frame]);
            label(masks[frames()[frame]],384,365,26,t.text,{ align:'center' });
            button(162,386,446,49,'Время кадра · ' + seconds(durations()[frame]),'hold',() => edit(0));
            label('Вид спереди. Стороны указаны по ходу движения.',384,463,19,t.dim,{ align:'center' });
            title('Сценарий',790,151);
            label('Длина сцены · ' + seconds(durations().reduce((a,b) => a+b,0)),1515,148,22,t.dim,{align:'right'});
            sequences.map((s) => s.name).concat('Свой').forEach((name,i) => {
                button(788+i*192,174,180,44,name,'seq'+i,() => { settings.set('studioSequence',i); frame=0; }, chosen()===i);
            });
            label('Кадр',790,263,24,t.dim);
            frames().forEach((m,i) => {
                const x = 790+i*187;
                button(x,280,172,61,String(i+1),'frame'+i,() => { frame=i; },i===frame);
                [1,2].forEach((bit,j) => cv.roundRect(x+60+30*j,351,21,5,2,(m & bit) ? '#8edbff' : '#465463'));
            });
            label('Изменить выбранный кадр',790,410,23,t.dim);
            button(790,427,355,48,'Левая фара','left',() => edit(1),frames()[frame]&1);
            button(1163,427,355,48,'Правая фара','right',() => edit(2),frames()[frame]&2);
        } else if (section === 1) {
            title('Подсветка салона',52,151);
            drawCabin(cv,t,{x:42,y:176,w:349,h:287},sample(),(l) => lights.scene ? lights.at(l) : null,{rhd:settings.get('drive') === 'rhd'});
            const look = control.look();
            label(control.on() ? 'Своя сцена' : 'Штатный свет',413,230,27,t.text,{font:'bold'});
            [look.upper, look.lower].forEach((zone,i) => {
                cv.roundRect(416,260+i*57,33,33,7,control.on() ? zone.rgb : '#65707e');
                label((i ? 'Низ' : 'Верх') + (control.on() ? '  '+zone.bright+'%' : ''),467,285+i*57,24,t.dim);
            });
            title('Быстрые сцены',790,151);
            presets.forEach((p,i) => {
                const selected = control.on() && JSON.stringify(control.look()) === JSON.stringify(lookFor(p));
                button(790+i*248,177,232,54,p.name,'preset'+i,() => { control.setLook(lookFor(p)); saved=false; },selected);
                cv.roundRect(821+i*248,241,169,5,2,p.upper);
            });
            label('Настройка верхней и нижней зон',790,303,24,t.dim);
            button(790,324,348,53,'Цвет и яркость','colour',() => go(0));
            button(1162,324,356,53,'Штатный свет','stock',() => { control.carColour(); saved=false; },!control.on());
            if (control.on()) button(790,415,490,51,saved ? 'Сцена сохранена' : 'Сохранить в избранное','save',() => {
                if (!control.favs().some((v) => JSON.stringify(v) === JSON.stringify(control.look()))) control.saveFav();
                saved=true;
            },saved);
        } else {
            title('Подключение',52,151);
            label('Источник',52,218,23,t.dim);
            label(ctx.preview ? 'Локальная модель' : 'Среда iDrive',52,257,32,t.text,{font:'bold'});
            label('Фары автомобиля',52,331,23,t.dim);
            label('Поддержка не проверена',52,370,29,t.text);
            label('Проверка выполняется на экране.',52,444,21,t.dim);
            title('Самопроверка',790,151);
            if (report) report.forEach(([name,ok],i) => {
                label(name,790,214+i*54,24);
                label(ok ? 'Пройдено' : 'Ошибка',1510,214+i*54,23,ok ? '#89d5ac' : t.crit,{align:'right'});
            });
            else label('Проверить зоны салона, цвет и кадры фар.',790,233,24,t.dim);
            button(790,403,474,56,report ? 'Проверить снова' : 'Запустить проверку','check',check);
        }
    };
}
module.exports = { lightStudio, validFrames };
