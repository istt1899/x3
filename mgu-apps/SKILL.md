# SKILL: создание MGU-приложений (BMW iDrive 7, HU_MGU)

Стандарт разработки пользовательских приложений для головного устройства BMW
MGU ID7 в репозитории `istt1899/x3` (каталог `mgu-apps/`). Основан на разборе
топ-5 графических приложений upstream: `docs/top5-graphical-apps-analysis.md`.

## Когда применять

Любая новая разработка или переработка MGU-приложений владельца: новый экран,
новое приложение, доработка существующего. Читать ПЕРЕД написанием app.json.

## 1. Железное правило: никаких текстовых приложений

- Экран с данными = **canvas-экран** (`"kind": "canvas"`): весь контент рисуется
  приложением через kit-виджеты на OEM-стиле (панели, циферблаты, полосы,
  таблицы, графики).
- Текстовые/menu-экраны допустимы только для: списка настроек, длинных
  текстовых списков (логи, архивы), credits.
- Каждое приложение обязано иметь: PNG-иконку (`icon.png` или `iconGlyph`),
  акцентную визуализацию главного параметра, touch-интерактив (табы или
  кнопки), DEMO-режим без машины с бейджем.

## 2. Скелет приложения

```
mgu-apps/apps/<id>/
  app.json      # манифест: screens(kind!), buttons bar, settings, signals, startWidget
  main.js       # mgu.run({start(ctx)}) + отрисовка
  model.js      # чистая бизнес-логика (без UI) — по необходимости
  store.js      # persist JSON в ctx.dataDir — по необходимости
  <модули>.js   # клиенты сокетов/сервисов
  icon.png      # 192x192 (или iconGlyph в app.json)
```

Минимальный main.js:

```js
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const W = 1600, H = 520;

mgu.run({
  async start(ctx) {
    const { ui, settings, log } = ctx;
    function render() {
      const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
      // ... G.panel / G.radial / G.bar / G.chart ...
      G.frame(cv, t, ['Обзор', 'История'], page, [demo && { text: 'DEMO' }]);
      return ui.image('MAIN_GFX', cv);
    }
    ctx.onTab((i) => { page = i; render(); });
    ctx.loop('MAIN', 10, render);   // 60 fps с renderd, 10 fps PNG-fallback
  },
});
```

## 3. app.json: экраны и интерактив

- `"kind": "canvas"` — полноэкранная графика. Имя graphic-компонента по
  умолчанию `<SCREEN>_GFX` (его и передавать в `ui.image`).
- `"buttons": [["BTN_OK","Действие"], ...]` — bar-кнопки экрана (джойстик+тач),
  события через `ui.onClick('BTN_OK', fn)`.
- `"settings": [{key, label, type: bool|choice|number, default, options}]` —
  схема настроек, persist в `data/settings.json`, доступ через `settings.get/set`,
  автоматический экран настроек (чекбоксы/дропдауны).
- `"startWidget"` — виджет домашнего экрана (опционально): cells + image.
- `"signals"` — SOME/IP-интерфейсы с атрибутами/методами/бродкастами
  (`_instances`, `_methods`, `_broadcasts`). Чтение через `ctx.signals.watch`.
- `"popups"` — модальные попапы (type/widget в манифесте, `<NAME>_TEXT`, `<NAME>_OK`).

## 4. Визуальный слой (kit/runtime, требуется `./kit/*` в пакете)

Канва: `ctx.canvas(W, H)` → `cv.clear/fillRect/roundRect/arc/circle/line/polyline/
quad/text/blit/clip`. Пиксельный буфер 1600×520 RGBA, кодируется PNG
(`cv.png()`) или уходит renderd как команды.

Виджеты (`require('./kit/gauges')`):
- `G.panel(cv,t,x,y,w,h,title)` — карточка в стиле G20; статика кешируется слоем.
- `G.radial/needle/ring` — круглые приборы; `G.bar/segBar` — полосы (OEM slant);
  `G.stat` — плитка значение+история; `G.readout` — label+большое число.
- `G.chart` — оси+серии (`series:[{pts,color,fill,width}]`, `marks` для порогов).
- `G.table` — колонки/строки; `G.pill` — статусные бейджи; `G.tyres`, `G.gmeter`.
- `G.frame` — табы страниц (пишет `cv.tabRects` для тача); `G.header/menuBar` —
  шапка/бар; `G.button` — кнопка на канве (`{confirm, busy, color, primary}`,
  подтверждение двойным нажатием 5 с); `G.stripes` — M-полосы.

Темы: `ctx.theme()` → `t.bg/accent/accent2/text/dim/tick/track/warn/crit/ok/
sel/bar/ramp/hotRamp/stripes/name`. Цветовые зоны виджета: `zones:[{from,to,color}]`.

Плавность: значения пружинят `G.smooth` (внутри виджетов), числа перерисовывать
не чаще 5–10 Гц через `G.hold(key, v, ms)`. Кадр строить за <8 мс в JS.

## 5. Данные и взаимодействие

- Сигналы: `ctx.signals.watch(iface, inst, {attr: fn}, log, {pollMs})`; значения
  кешировать, render по изменению; не чаще 1–4 Гц для цифр, 60 fps только
  анимациям.
- Контроллер: `ctx.controller.grab(true)` + `ctx.controller.onInput(fn)` — только
  где реально нужен (игры, спец-навигация); обычным приложениям хватает
  bar-кнопок и `ctx.onTab`.
- Тач: `ctx.onTap(fn(x,y))` по координатам канвы; тач-зоны кнопок регистрирует
  `cv.target` через `G.button`.
- Persist: JSON в `ctx.dataDir`, debounce ≥5 с, flush на exit; битый файл →
  резервная копия + чистый старт.
- DEMO: при отсутствии сигналов показывать правдоподобные данные + бейдж DEMO.

## 6. Безопасность (стоп-условия)

- Read-only по умолчанию. Любая запись в ECU/сервисы — только отдельным
  явным решением владельца, с confirm и read-back.
- Никаких секретов в коде/пакетах: токены — в data/ после pairing (0600).
- Разрушительные действия — `G.button(...,{confirm:true})`.
- `ui.enabled(name,false)` на время выполнения операции (busy), без блокировки кадра.

## 7. Сборка, проверка, публикация

```sh
cd mgu-apps
npm run build          # tools/build.js → tools/build.py → tgz в dist/publish/mgu-five-apps
npm test               # tests/run.js: компонентные тесты + host-проверки пакетов
npm run catalog:github # catalog.json + catalog.github.json
npm run publish:check  # проверка готовности публикации
```

- Версии семантические; bump всех тронутых приложений; catalog и evidence
  пересобираются только штатным билдом.
- Публикация: только `istt1899/x3`, общий релиз `catalog` (см. корневой
  AGENTS.md репозитория). Не трогать другие компоненты каталога.
- Перед пушем: `npm test` зелёный, пакеты пересобраны, размеры/SHA-256 в
  catalog сошлись с файлами.

## Антипаттерны (брак)

- Текстовые экраны там, где нужны приборы/графики.
- Рисование «вручную» того, что есть виджетом kit.
- Перерисовка 60 fps статики; PNG-push чаще 10 fps без renderd.
- Блокировка кадра сетевыми вызовами (всё async + timeout).
- Новые зависимости без крайней нужды; только Node 8.17-совместимый синтаксис
  в пакетах (проверка `MGU_NODE8=1`).
- Отправка данных наружу без штатного механизма и явного решения владельца.
