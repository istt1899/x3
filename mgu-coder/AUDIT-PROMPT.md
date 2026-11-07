# Повторный аудит Bimmer Code 0.2.0

Репозиторий https://github.com/istt1899/x3, тег marku_x3_coding@0.2.0, общий релиз catalog. Сделай чистый клон, зафиксируй SHA тега/main, OS и версии Node/Python. Прочитай REBUILD-SPEC.md, COUNCIL-AUDIT-0.2.0.md и native/apps/marku_x3_coding.

1. Node.js 18+, Python 3.11+: `cd mgu-coder`, `npm run build`, `npm test`. Сверь повторные tgz побайтово, размер/SHA с каталогом. Публикуемый общий catalog.json сравни с корневым файлом, компонент Bimmer Code — с dist/publish/x3-coding/catalog.github.json. Остальные VK/RUTUBE/RideTube должны сохраниться.
2. Распакуй фактический tgz: package/, main=javascript/app.js, CommonJS и kit/runtime. Нет mgu-app.json, handwritten runner, BMW SDK/FA/SVT/NCD/VIN/ключей. Сверь kit с media/core/kit и build-evidence.json, проверь flags загрузчиков и ID/UUID обновления.
3. Проследи новый lifecycle: kit await app.start → RHMI/resources/map → app.initialized → open. Он не должен ждать собственного initialized event, как 0.1.x. Проверь native_runtime.test на настоящем распакованном kit и SDK-shaped stub без этого события; не считай заглушку реальным firmware.
4. Проверь настоящий preparePackage, flat output и созданный SDK module из синтетического donor. Запусти Node8 parse через MGU_NODE8. Раздели проверку формата/API shape и неподтверждённый штатный donor MGU.
5. Проверь MAIN 2×5 карточек, DETAIL/Back, отсутствие autoscan, фиксированный 22 F1 50 к 0xDF, оба allowlist, таймаут, ошибки и shutdown. Кодирование не реализовано; ответ ECU не означает поддержку CAFD.
6. Только при отдельном разрешении и безопасном доступе к стоящей машине: установка → плитка → MAIN → DETAIL/Back → возврат после Home. Чтение ECU после успешного UI. Без доступа все проверки автомобиля NOT TESTED. Никаких записей/reset/flash/clear.

Отчёт на русском: отдельные вердикты о воспроизводимости, установке/открытии на реальной MGU, чтении ECU и реализации кодирования; таблица PASS/FAIL/NOT TESTED. Замечания P0/P1/P2 с путь:строкой, воспроизведением и доказательствами. P1-01 прежнего аудита оставлен открытым по указанию владельца. Ничего не исправлять/публиковать без отдельной задачи.
