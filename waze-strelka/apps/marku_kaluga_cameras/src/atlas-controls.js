// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

// These are RHMI slider steps. Service-side units can differ from the widget value.
const sliders = {
    cameraWarningDistance: [19, 50, 50, 'м'],
    cameraVisualOffset: [30, 0, 1, 'км/ч'],
    cameraSoundOffset: [30, 0, 1, 'км/ч'],
    cameraSoundDistance: [12, 100, 50, 'м'],
    cameraSoundRepeat: [3, 0, 1, 'с'],
    cameraCardScale: [15, 75, 5, '%'],
    cameraCardBrightness: [18, 10, 5, '%'],
    cameraCardTransparency: [18, 0, 5, '%'],
    cameraCardX: [200, 0, 0.5, '%'],
    cameraCardY: [200, 0, 0.5, '%'],
    wocHudSize: [11, 30, 5, '%'],
    wocHudOpacity: [18, 0, 5, '%']
};
const cardFields = {
    cameraCardX: 'x', cameraCardY: 'y', cameraCardScale: 'scalePct',
    cameraCardBrightness: 'brightnessPct', cameraCardTransparency: 'opacityPct'
};
function profilePercent(name, profile) {
    const value = profile && profile[cardFields[name]], spec = sliders[name];
    if (!Number.isFinite(value) || !spec) return null;
    const display = name === 'cameraCardTransparency' ? 100 - value :
        name === 'cameraCardX' || name === 'cameraCardY' ? value / 10 : value;
    return display < spec[1] || display > spec[1] + spec[0] * spec[2] ? null : display;
}
function sliderCommand(button, x) {
    if (!button || button.kind !== 'slider' || !button.enabled || !button.track || !Number.isFinite(x)) return null;
    const ratio = Math.max(0, Math.min(1, (x - button.track.x) / button.track.w));
    return 'atlasValue:' + button.source + ':' + Math.round(button.max * ratio);
}
function sliderNudge(button, delta) {
    if (!button || button.kind !== 'slider' || !button.enabled || !Number.isInteger(button.step) ||
        !Number.isInteger(delta) || delta === 0) return null;
    const step = Math.max(0, Math.min(button.max, button.step + delta));
    return step === button.step ? null : 'atlasValue:' + button.source + ':' + step;
}
const outputs = ['Приборная панель', 'Проекция HUD', 'Приборы и HUD', 'Выключить вывод'];
function formatStep(name, step) {
    if (!Number.isInteger(step) || !sliders[name]) return '—';
    if (name === 'cameraSoundRepeat') return ['Один раз', '3 с', '5 с', '10 с'][step];
    const spec = sliders[name];
    return String(spec[1] + step * spec[2]).replace('.', ',') + ' ' + spec[3];
}
const labels = {
    atlasMenuCamera:'Камера', atlasMenuMaps:'Карты телефона', tripDatabase:'Базы и регионы', tripDiagnostics:'Диагностика',
    tripSettings:'Настройки', tripAbout:'О приложении', tripCameraDiagnostics:'Диагностика камеры',
    wocShowOn:'Куда вывести карту', wocGuide:'Скрывать подсказки BMW', wocProfile:'Настройки водителя',
    wocHudKeep:'Сохранять карту на HUD', wocAaCard:'Скрывать карточку Android Auto', wocHudSize:'Размер карты на HUD',
    wocHudOpacity:'Прозрачность карты', wocAaZoomOut:'Отдалить карту', wocAaZoomIn:'Приблизить карту',
    wocHudLeft:'Сместить влево', wocHudRight:'Сместить вправо', wocHudUp:'Сместить вверх', wocHudDown:'Сместить вниз',
    wocHudCentre:'По центру', wocCameras:'Настройки камер', wocLogs:'Журнал приложения', wocCapture:'Запись журнала', wocLogsSave:'Сохранить журнал',
    cameraAlertsLink:'Оповещения', cameraTypesLink:'Типы контроля', cameraHudSetup:'Калибровка HUD', cameraMapSetup:'Калибровка приборов',
    cameraDatabaseLink:'База автомобиля', cameraDiagnostics:'Диагностика', cameraEnable:'Предупреждения',
    cameraWarningDistance:'Дальность предупреждения', cameraDistanceRecommended:'Установить 1000 м', cameraOverspeedLink:'Мигание и звук',
    cameraAlertsResultMore:'Подробнее о команде', cameraTypesAll:'Включить все типы', cameraSoundEnabled:'Звуковой сигнал',
    cameraVisualFlash:'Мигание при превышении', cameraVisualOffset:'Порог мигания', cameraSoundOffset:'Порог звука',
    cameraSoundDistance:'Дистанция сигнала', cameraSoundRepeat:'Повтор сигнала', cameraSoundAppear:'Звук при появлении',
    cameraDiagAudio:'Проверить звук', cameraOverspeedRecommended:'Рекомендуемые параметры', cameraOverspeedResultMore:'Подробнее о команде',
    cameraCardOutput:'Вывод предупреждений', cameraCardScale:'Размер карточки', cameraCardBrightness:'Яркость', cameraCardTransparency:'Прозрачность',
    cameraTestStart:'Тест изображения', cameraCardPosition:'Положение карточки', cameraCardReset:'Базовый профиль', cameraCardSave:'Сохранить и выйти',
    cameraCardLeft:'Сместить влево', cameraCardRight:'Сместить вправо', cameraCardUp:'Сместить вверх', cameraCardDown:'Сместить вниз',
    cameraCardX:'X · Горизонталь', cameraCardY:'Y · Вертикаль', cameraPositionTest:'Тест изображения', cameraResultMore:'Подробнее о команде',
    cameraUpdate:'Проверить обновление', cameraRollback:'Вернуть прежнюю базу', cameraDatabaseResultMore:'Подробнее о команде',
    cameraCoverageDetails:'Проверить покрытие', cameraDiagFreeze:'Снимок для фото', cameraDiagMore:'Следующие строки',
    cameraDiagTest:'Тест изображения', cameraDiagCalibration:'Калибровать экран', cameraDiagResultMore:'Подробнее о команде',
    cameraDiagExport:'Сохранить JSON', cameraGpsReset:'Сбросить GPS', tripRegionPage:'Следующие регионы',
    tripRegionRefresh:'Обновить список', tripRegionDownload:'Загрузить пакет', tripRegionRollback:'Откатить пакет',
    tripLegacyDatabase:'База автомобиля', tripAboutLogs:'Журнал приложения'
};
const checks = ['wocGuide','wocProfile','wocHudKeep','wocAaCard','cameraCardOutput','cameraVisualFlash','cameraSoundEnabled','cameraSoundAppear'];
const groups = {
    atlasMenu:[['Разделы',['atlasMenuCamera','atlasMenuMaps','tripDatabase','tripDiagnostics','tripSettings','tripAbout']]],
    main:[
        ['Вывод навигации',['wocShowOn','wocProfile','wocGuide','wocHudKeep','wocAaCard']],
        ['Вид карты',['wocHudSize','wocHudOpacity','wocAaZoomOut','wocAaZoomIn']],
        ['Положение карты на HUD',['wocHudLeft','wocHudRight','wocHudUp','wocHudDown','wocHudCentre']],
        ['Другие разделы',['wocCameras','wocLogs']]
    ],
    logs:[['Запись и сохранение',['wocCapture','wocLogsSave']]],
    cameras:[['Настройки предупреждений',['cameraAlertsLink','cameraTypesLink','cameraHudSetup','cameraMapSetup','cameraDatabaseLink','cameraDiagnostics']]],
    cameraDetail:[['Данные камеры',['tripCameraDiagnostics']]],
    about:[['Приложение',['tripAboutLogs']]],
    alerts:[['Настройки предупреждений',['cameraEnable','cameraWarningDistance','cameraOverspeedLink','cameraDistanceRecommended','cameraAlertsResultMore']]],
    database:[['Управление базой',['cameraUpdate','cameraCoverageDetails','cameraRollback','cameraDatabaseResultMore']]],
    calibration:[
        ['Положение и вид',['cameraCardX','cameraCardY','cameraCardScale','cameraCardBrightness','cameraCardTransparency','cameraTestStart','cameraCardSave']],
        ['Вывод и состав',['cameraCardOutput','cameraCardPosition','cameraCardReset']]
    ],
    position:[
        ['Расположение карточки',['cameraCardLeft','cameraCardRight','cameraCardUp','cameraCardDown','cameraCardX','cameraCardY']],
        ['Тест и результат',['cameraPositionTest','cameraResultMore']]
    ],
    overspeed:[
        ['Сигналы',['cameraVisualFlash','cameraVisualOffset','cameraSoundEnabled','cameraSoundOffset','cameraSoundDistance','cameraSoundRepeat']],
        ['Проверка звука',['cameraSoundAppear','cameraDiagAudio','cameraOverspeedRecommended','cameraOverspeedResultMore']]
    ],
    diagnosticPhoto:[['Зафиксированные данные',[]]]
};
function action(name,written,extra) {
    const source=extra&&extra.source||name;
    const obj=Object.assign({command:name,source,label:labels[name]||name,enabled:written['enabled:'+source]!==false},extra||{});
    if (written['visible:'+source]===false) return null;
    if (sliders[name] || name==='wocShowOn') {
        obj.command='atlasEdit:'+name;
        obj.kind='editor';
        obj.step=written[name==='wocShowOn'?'cell:'+name+':SelectedItem':'cell:'+name+':0:Value'];
        obj.value=name==='wocShowOn'?outputs[obj.step]||'—':formatStep(name,obj.step);
        if(name==='wocShowOn'&&written['cell:'+name+':'+obj.step+':ItemText']==='—')obj.value='—';
        const desc=written['cell:'+name+':0:TextDescription'];
        if (name==='wocHudSize' && typeof desc==='string' && desc.indexOf(':')>=0)
            obj.value=desc.slice(desc.indexOf(':')+1).trim();
        if (!obj.enabled && (!Number.isInteger(obj.step)|| /недоступ|нет данных|не подтвержд/i.test(String(desc)))) obj.value='—';
    } else if (checks.indexOf(name)>=0 || name.indexOf('cameraType_')===0) {
        obj.kind='toggle';
        const selected=written['selected:'+source];
        if(typeof selected==='boolean')obj.selected=selected;
    }
    return obj;
}
function sheetGroups(page,v,written) {
    function group(label,items){return [label,items.filter(Boolean)];}
    function regular(ids) {
        return ids.map(id => {
            const item = action(id,written);
            if (!item || !v.calibration) return item;
            const c = v.calibration;
            if (cardFields[id]) {
                const percent = profilePercent(id, c.profile), spec = sliders[id];
                item.step = percent === null ? null : Math.round((percent - spec[1]) / spec[2]);
                item.value = percent === null ? '—' : String(percent).replace('.',',') + ' %';
                item.enabled = item.enabled && c.layout.allowed && item.step !== null;
                item.max = sliders[id][0];
                item.kind = 'slider';
            } else if (id === 'cameraTestStart' || id === 'cameraPositionTest') {
                item.label = c.testActive ? 'Скрыть тест' : 'Тест изображения';
                item.enabled = item.enabled && c.test.allowed;
            } else if (id === 'cameraCardSave') {
                item.enabled = item.enabled && c.save.allowed;
            } else if (id === 'cameraCardReset') {
                item.enabled = item.enabled && c.layout.allowed;
            } else if (id === 'cameraCardOutput') {
                item.selected = c.output;
                item.enabled = item.enabled && c.canOutput;
            }
            return item;
        });
    }
    if (page === 'about') {
        return [group('Справка и настройки', [
            {command:'atlasCompositionOpen:hud',label:'Состав уведомления HUD',enabled:true},
            {command:'atlasCompositionOpen:map',label:'Состав на приборах',enabled:true}
        ].concat(regular(['tripAboutLogs'])))];
    }
    if (page === 'calibration') {
        const sheets = groups.calibration.map(pair => group(pair[0], regular(pair[1])));
        sheets.push(group('Состав уведомления', v.calibration.composition));
        return sheets;
    }
    if(page==='types'){
        const choices=v.types.map(t=>action(t.control.command,written,{label:t.label,selected:t.on,enabled:t.control.enabled}));
        return [group('Типы контроля',choices.slice(0,6)),group('Типы контроля',choices.slice(6).concat(regular(['cameraTypesAll'])))];
    }
    if(page==='regions'){
        const entries=v.regionRows.map(r=>action(r.control.command,written,{label:r.name,selected:r.selected,kind:'choice',source:'tripRegionSelector'}));
        return [group('Пакеты региона',regular(['tripRegionDownload','tripRegionRefresh','tripRegionRollback','tripLegacyDatabase'])),
            group('Выбор региона · '+v.regionPage,entries)];
    }
    if(page==='diagnostics'){
        const tabs=v.report.tabs.map((t,i)=>action(t.command,written,{label:t.label,kind:'choice',selected:i===v.report.selected,source:'cameraDiagSelector'}));
        return [group('Раздел отчёта',tabs),group('Действия с отчётом',regular(['cameraDiagFreeze','cameraDiagMore','cameraDiagTest','cameraDiagCalibration','cameraDiagExport','cameraDiagResultMore'])),
            group('Приёмник GPS',regular(['cameraGpsReset']))];
    }
    return (groups[page]||[]).map(pair=>group(pair[0],regular(pair[1])));
}
function mapTargets(items) {
    return items.map((item,i)=>Object.assign({},item,{
        x:762+(i%2)*408, y:130+Math.floor(i/2)*107, w:394,h:93
    }));
}
function sliderGeometry(item,x,y,w,h,wide) {
    const left = x + (wide ? 274 : 18), right = x + w - (wide ? 117 : 18);
    return Object.assign({},item,{x,y,w,h,track:{x:left,y:y+h-20,w:right-left,h:8,wide:!!wide}});
}
function calibrationTargets(items) {
    const sliders = items.filter(b => b.kind === 'slider');
    const others = items.filter(b => b.kind !== 'slider');
    return sliders.map((b,i) => sliderGeometry(b,638,89+i*60,926,55,true)).concat(
        others.map((b,i) => Object.assign({},b,{x:638+i*470,y:394,w:456,h:55,kind:'bar'})));
}
function nav(command,label,x,w) {return {command,label,x,y:450,w,h:58,enabled:true,kind:'nav'};}
function apply(v,context) {
    const all=sheetGroups(v.page,v,context.written||{});
    if(v.resultLines){
        for(let i=0;i<v.resultLines.length;i+=8){
            all.push(['Результат команды'+(v.resultLines.length>8?' · '+(Math.floor(i/8)+1):''),[],v.resultLines.slice(i,i+8)]);
        }
    }
    const panel=context.atlasPanel||{};
    const index=Number.isInteger(panel.sheet)?Math.max(0,Math.min(all.length-1,panel.sheet)):0;
    const sheet=all[index]||['',[]];
    const items=sheet[1];
    if(sheet[2])v.resultBlock=sheet[2];
    const editor=panel.edit&&items.find(it=>it.command==='atlasEdit:'+panel.edit && it.enabled);
    v.sheet=index;v.sheets=all.length;v.group=sheet[0];v.edit=null;
    if(editor){
        const name=editor.source,step=editor.step;
        v.edit={name,label:editor.label,value:editor.value,step,max:sliders[name]?sliders[name][0]:outputs.length-1};
        const choices=name==='wocShowOn'?outputs.map((label,row)=>({
            command:'atlasChoice:'+name+':'+row,label,kind:'choice',selected:step===row,enabled:true
        })):numericChoices(name,step);
        v.buttons=mapTargets(choices);
        if (editor.kind === 'slider') {
            const rail = Object.assign({},editor,{command:'atlasSlider:'+name});
            v.buttons.unshift(sliderGeometry(rail,49,277,661,70,false));
        }
        v.buttons.push(nav('atlasEditClose','К параметрам',762,394));
        return v;
    }
    v.buttons=v.page==='calibration'&&index===0 ? calibrationTargets(items) :
        mapTargets(items).map(b => b.kind==='slider' ? sliderGeometry(b,b.x,b.y,b.w,b.h,false) : b);
    if (v.calibration && v.page==='calibration' && index===2) v.compositionSheet=true;
    v.buttons.push(nav('atlasBack','Назад',24,190));
    if(index>0)v.buttons.push(nav('atlasSheet:'+(index-1),'Назад по разделу',762,394));
    if(index+1<all.length)v.buttons.push(nav('atlasSheet:'+(index+1),all[index+1][0],1170,394));
    if(v.page==='regions'&&index===1){
        const next=action('tripRegionPage',context.written||{});
        if(next)v.buttons.push(Object.assign(nav(next.command,next.label,1170,394),next));
    }
    return v;
}
function numericChoices(name,step) {
    const spec=sliders[name], max=spec[0];
    if(!Number.isInteger(step)||step<0||step>max)return [];
    if(name==='cameraSoundRepeat'){
        return [0,1,2,3].map(i=>({command:'atlasValue:'+name+':'+i,label:formatStep(name,i),kind:'choice',selected:step===i,enabled:true}));
    }
    const moves=[['dec',step-1,'Уменьшить'],['inc',step+1,'Увеличить']];
    if(max>=100)moves.push(['dec10',step-10,'Крупный шаг назад'],['inc10',step+10,'Крупный шаг вперёд']);
    if(max>3)moves.push(['min',0,'Минимум'],['max',max,'Максимум']);
    return moves.map(move=>{
        const goal=move[1], valid=goal>=0&&goal<=max&&goal!==step;
        const central=move[0]==='min'||move[0]==='max';
        const distinct=valid&&!(central&&(Math.abs(goal-step)===1||max>=100&&Math.abs(goal-step)===10));
        const command=distinct?'atlasValue:'+name+':'+goal:'atlasBound:'+name+':'+move[0];
        return {command,label:move[2],value:formatStep(name,Math.max(0,Math.min(max,goal))),enabled:distinct,kind:'number',focusKey:name+':'+move[0]};
    });
}
function reducePanel(panel,command,view) {
    if(!view || !view.buttons.some(b=>b.command===command&&b.enabled!==false))return null;
    if(command==='atlasEditClose'||(view.edit&&command==='atlasSlider:'+view.edit.name))return {sheet:view.sheet,edit:null};
    if(command.indexOf('atlasSheet:')===0)return {sheet:Number(command.slice(11)),edit:null};
    if(command.indexOf('atlasEdit:')===0)return {sheet:view.sheet,edit:command.slice(10)};
    return null;
}
module.exports={apply,reducePanel,sliders,formatStep,sliderCommand,sliderNudge};
