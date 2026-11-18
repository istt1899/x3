# Направление камеры: что означает каждый источник (0.8.7)

Нормализация живёт в `native/marku-kaluga-cameras/files/capture-data.js`, поле записи:

```
capture = { side: 'front'|'rear'|'both'|'unknown',
            facingDeg: 0..360|null,   // куда смотрит объектив
            flowDeg: 0..360|null,     // азимут контролируемого потока
            source: 'owner'|'osm-direction'|'osm-relation'|'openspeedcam'|'gibdd-text'|null,
            verified: bool }
```

`side` — внутреннее, относительно контролируемой дороги: `front` = камера контролирует
встречный поток и фиксирует передние номера («в лицо»), `rear` = попутный поток,
задние номера («в спину»), `both` = оба. Водителю относительный класс считает
`capture-data.classify(capture, courseDeg)` → `front|rear|both|unknown|cross`
(`cross` = камера смотрит поперёк нашего курса — не предупреждаем).

Приоритет источников: запись владельца → OSM `direction` → OSM enforcement
relation → OpenSpeedcam → текст Госавтоинспекции.

## 1. OpenStreetMap

### 1.1. `direction` / `camera:direction` на точке камеры
- Значение — направление, **куда смотрит камера** (объектив), 0..359, север = 0.
- Источник семантики: [wiki/Key:camera:direction](https://wiki.openstreetmap.org/wiki/Key:camera:direction)
  («the direction the camera faces»), [wiki/Tag:highway=speed_camera](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dspeed_camera).
- Кардинальные направления (N, NE, …) и числа принимаются; список через `;` —
  берётся первый для поля `facingDeg` (все хранятся в `cameraFacing.bearingsDeg`).
- `verified: true`, `source: 'osm-direction'`, `flowDeg: null`, `side: 'unknown'`.

### 1.2. Отношение `type=enforcement`
- Члены с ролями `from` и `to` с геометрией задают **контролируемый поток
  движения** (от `from` к `to`), а не направление объектива:
  [wiki/Relation:enforcement](https://wiki.openstreetmap.org/wiki/Relation:enforcement).
- `flowDeg` = азимут from→to (геометрия подтверждена, `verified: true` для потока).
- `facingDeg = (flowDeg + 180) % 360` — стандартная постановка устройства
  навстречу контролируемому потоку; это **допущение**, поэтому поле `facingDeg`
  для relation получает `verified: false`. В `classify` при наличии `flowDeg`
  класс считается от потока без допущения об объективе.
- `side: 'unknown'`, `source: 'osm-relation'`.

## 2. OpenSpeedcam (openspeedcam.net)

Поля точки: `direction` (0..360), `dirType` (0/1/2), `angle` (0..180, сектор),
`inBack` (bool). Импортёр хранит `directionDeg` только при `dirType === 1`
(одно направление); `dirType 2` встречается у 24 точек и семантика публично не
подтверждена — не используется.

- **Семантика `direction`: азимут контролируемого потока** (направления движения
  контролируемых ТС), не объектива. Это соглашение сообщества OpenSpeedcam
  (наследие «Антикам»): на карте точка рисуется стрелкой направления движения,
  пара соседних камер на одной дороге несут противоположные азимуты (например
  271° и 109° у пары точек `619c87ee…`), что соответствует двум направлениям
  потока, а не двум объективам.
- **Публичная документация API, подтверждающая семантику, не найдена**
  (openspeedcam.net не публикует описания полей; разделов help/faq нет).
  Поэтому `verified: false`, `source: 'openspeedcam'`, `flowDeg = direction`,
  `facingDeg = (direction + 180) % 360` с пометкой неподтверждённости,
  `side: 'unknown'`. Флаг `inBack` («снимает в спину») в запись не переносится:
  без подтверждённой семантики не используется, чтобы не угадывать.

## 3. Госавтоинспекция (перечень Калужской области, xlsx)

- Отдельной колонки направления нет. Направление контроля пишется текстом в
  условиях работы (`operatingConditions`), например «Круглосуточно Встречное/
  попутное» (таких строк во всём перечне 155 из 155).
- Правила разбора (`capture-data.gibddSide`, регистронезависимо):
  - есть «встречн» и «попутн» → `both`;
  - только «встречн» → `front` (контроль встречного потока, «в лицо»);
  - только «попутн» → `rear` (контроль попутного потока, «в спину»);
  - иначе → `unknown`.
- `verified: true` (текст первоисточника), `source: 'gibdd-text'`,
  `facingDeg: null`, `flowDeg: null` (азимута в перечне нет).

## 4. Камеры владельца (`reported-cameras.json`)

- С 0.8.7 запись может содержать опциональные `captureSide`
  ('front'|'rear'|'both') и/или `facingDeg` (0..360). Валидация — в
  `camera-info.supplement`, доказательство при необходимости —
  `captureSideSourceUrl`/`captureSideVerifiedAt` (по умолчанию — узел
  перекрёстка из `positionSourceUrl`).
- `verified: true`, `source: 'owner'`.

## Покрытие

Считается в `database-coverage.summarize`:
- `facingKnown` — записи с известным `facingDeg` (capture или OSM-объектив);
- `captureSideKnown` — записи с `side !== 'unknown'`.

До 0.8.7: **20 / 0**. После (база 2026.11.12.1, 486 записей): см. отчёт к релизу —
файл `data/camera-database-2026.11.18.1.json` и тест `tools/test_camera_direction.js`.

## Что остаётся «неизвестно»

- Камеры без каких-либо данных о направлении (часть OSM-точек без тега,
  `dirType 2` у OpenSpeedcam) → класс `unknown`, предупреждение показывается,
  в карточке — «Напр. ?».
- Абсолютное (не водителю-относительное) `side` известно только Госавтоинспекции
  и владельцу; у OSM/OSC безbearing дороги side не выводится — не угадываем.
