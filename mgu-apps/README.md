# Пять приложений MGU 0.2.0

Графические приложения для BMW X3 G01 / MGU ID7: canvas-приборные панели в
стиле OEM на kit/runtime (GPU 60 fps через renderd, автоматический PNG-fallback).
Каждое приложение собирается как App Kit source-only npm package; BMW SDK не
включён. Store линкует SDK на автомобиле из штатного donor-приложения.

- `marku_x3_health` — приборы CBS, 12 В (с трассой истории) и блоков ECU; вкладки Обзор/История/Отчёт.
- `marku_x3_warm` — радиальные приборы масла/ОЖ, кольцо готовности, климат-рекомендация.
- `marku_daily_hud` — слой отклонений на приборной панели/HUD через `cluster-render`, с живым превью; по умолчанию выключен.
- `marku_x3_home` + `marku-home-bridge` — сцены Home Assistant кнопками на экране, allowlist-only, pairing bridge.
- `marku_x3_trips` — поездки: текущая поездка, итоги за период, журнал, категории, CSV.

## Сборка и проверка

Требуются Node.js 18+, Python 3.11+ и полный клон `istt1899/x3`.

```sh
cd mgu-apps
npm run build            # tgz пакетов + catalog (версии берутся из app.json)
npm test                 # логика + загрузка пакетов в head-unit stub
node tools/preview-apps.js  # PNG всех экранов в dist/preview/
npm run publish:check
```

`MGU_STORE` нужен только для пересборки tool-пакета bridge: `MGU_STORE=../../sources/mgu-store`. `MGU_NODE8` включает проверку синтаксиса пакетов Node 8.17.

## Стандарт разработки

`SKILL.md` — обязательный стандарт: canvas-first (никаких текстовых экранов
для данных), виджеты kit, интерактив (табы, bar-кнопки, тач), плавность,
безопасность (read-only, confirm, без секретов). Разбор эталонных приложений:
`docs/top5-graphical-apps-analysis.md`.

## Границы

Это независимые host integration и package checks, не испытание автомобиля.
Ни одно приложение не выполняет запись в ECU, не очищает DTC/CBS и не обещает
remote start. `marku_daily_hud` не включает HUD до явного выбора владельца.
`marku-home-bridge` не содержит токен: pairing выполняет владелец.

## Документы

Версии, evidence и ограничения выпуска: `RELEASE-NOTES.md`,
`dist/publish/mgu-five-apps/build-evidence.json`.
