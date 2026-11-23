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
    cameraAlertsLink:'Оповещения', cameraTypesLink:'Типы контроля', cameraHudSetup:'Проекция HUD', cameraMapSetup:'Приборы',
    cameraDatabaseLink:'База автомобиля', cameraDiagnostics:'Диагностика', cameraEnable:'Предупреждения',
    cameraWarningDistance:'Дальность предупреждения', cameraDistanceRecommended:'Установить 1000 м', cameraOverspeedLink:'Мигание и звук',
    cameraAlertsResultMore:'Подробнее о команде', cameraTypesAll:'Включить все типы', cameraSoundEnabled:'Звуковой сигнал',
    cameraVisualFlash:'Мигание при превышении', cameraVisualOffset:'Порог мигания', cameraSoundOffset:'Порог звука',
    cameraSoundDistance:'Дистанция сигнала', cameraSoundRepeat:'Повтор сигнала', cameraSoundAppear:'Звук при появлении',
    cameraDiagAudio:'Проверить звук', cameraOverspeedRecommended:'Рекомендуемые параметры', cameraOverspeedResultMore:'Подробнее о команде',
    cameraCardOutput:'Вывод предупреждений', cameraCardScale:'Размер карточки', cameraCardBrightness:'Яркость', cameraCardTransparency:'Прозрачность',
    cameraTestStart:'Тест изображения', cameraCardPosition:'Положение карточки', cameraCardReset:'Базовый профиль', cameraCardSave:'Готово',
    cameraCardLeft:'Сместить влево', cameraCardRight:'Сместить вправо', cameraCardUp:'Сместить вверх', cameraCardDown:'Сместить вниз',
    cameraCardX:'По горизонтали', cameraCardY:'По вертикали', cameraPositionTest:'Тест изображения', cameraResultMore:'Подробнее о команде',
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
        ['Профиль экрана',['cameraCardOutput','cameraTestStart','cameraCardPosition','cameraCardScale','cameraCardBrightness','cameraCardTransparency']],
        ['Завершение',['cameraCardSave','cameraCardReset']]
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
    function regular(ids){return ids.map(id=>action(id,written));}
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
        v.buttons.push(nav('atlasEditClose','Готово',762,394));
        return v;
    }
    v.buttons=mapTargets(items);
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
    if(command==='atlasEditClose')return {sheet:view.sheet,edit:null};
    if(command.indexOf('atlasSheet:')===0)return {sheet:Number(command.slice(11)),edit:null};
    if(command.indexOf('atlasEdit:')===0)return {sheet:view.sheet,edit:command.slice(10)};
    return null;
}
module.exports={apply,reducePanel,sliders,formatStep};
