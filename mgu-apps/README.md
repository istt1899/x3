# Пять приложений MGU 0.1.0

Безопасные первые выпуски для BMW X3 G01 / MGU ID7. Каждое приложение собирается как App Kit source-only npm package; BMW SDK не включён. Store линкует SDK на автомобиле из штатного donor-приложения.

- `marku_x3_health` — CBS, 12 В и read-only обнаружение ECU с локальной историей.
- `marku_x3_warm` — прогрев масла/ОЖ и рекомендация климата без записи в блоки.
- `marku_daily_hud` — один слой отклонений через `cluster-render`, по умолчанию выключен.
- `marku_x3_home` + `marku-home-bridge` — allowlist-сцены Home Assistant через локальный pairing bridge.
- `marku_x3_trips` — локальные поездки, категории и CSV.

## Сборка и проверка

Требуются Node.js 18+, Python 3.11+ и полный клон `istt1899/x3`.

```sh
cd mgu-apps
npm run build
npm test
npm run catalog:github
npm run publish:check
```

`MGU_STORE` нужен только для пересборки tool-пакета bridge: `MGU_STORE=../../sources/mgu-store`. `MGU_NODE8` включает проверку синтаксиса пакетов Node 8.17.

## Границы

Это независимые host integration и package checks, не испытание автомобиля. Ни одно приложение 0.1.0 не выполняет запись в ECU, не очищает DTC/CBS и не обещает remote start. `marku_daily_hud` не включает HUD до явного выбора владельца. `marku-home-bridge` не содержит токен: pairing выполняет владелец.

## Документы

ТЗ: `../specs/mgu-five-apps-0.1/`. Версии, evidence и ограничения выпуска: `RELEASE-NOTES.md`, `dist/publish/mgu-five-apps/build-evidence.json`.
