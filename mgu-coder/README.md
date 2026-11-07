# Bimmer Code 0.2.0

Новая оболочка использует тот же App Kit, runtime и генератор экранов, что работающие на X3 VK/RUTUBE. Сохранены ID `marku_x3_coding` и UUID приложения/плитки. Источник Store: **istt1899/x3**, GitHub Releases.

Каталог десяти функций и диагностика ECU работают только на чтение. **Запись кодировок не реализована.** Открытие 0.2.0 на конкретной MGU ещё должен подтвердить владелец; тесты компьютера этого не доказывают.

## Сборка

В полном клоне репозитория нужны Node.js 18+ и Python 3.11+. Из папки `mgu-coder`: `npm run build`, затем `npm test`. Для проверки Node 8 задайте путь `MGU_NODE8`; без него проверка синтаксиса явно сообщает skip.

`tools/build-native.py` использует `media/core/kit/tools/build.py` в SDK-free source-only режиме. Поставляется npm-layout `package/javascript/app.js` с CommonJS и неизменённым kit/runtime. Store готовит штатный SDK на автомобиле через module-mode `oap_link.preparePackage`. Собственный runner, browserify source bundle и ожидание события initialized больше не используются. `apps/marku_x3_coding/src/coding_app.js` и `tools/prepare.js` сохранены только как история 0.1.x.

В `dist/publish/x3-coding` находятся tgz, относительный USB-каталог, каталог компонента GitHub и `build-evidence.json` с хешами kit. Публикуется общий **корневой catalog.json**, сохраняющий остальные приложения. Его компонент Bimmer Code должен совпадать с `catalog.github.json`. После commit/push публикация запускается `node tools/publish-github.js --publish`; загрузчик проверяет чистоту Git, байты коммита, SHA тега и сохранность других компонентов.

## Установка и интерфейс

Store → Settings → Check now → Bimmer Code → версия 0.2.0 → Update. Для USB используйте содержимое `../output/x3-coding-usb`. Требуются iDrive 7, работающий Store, mgu-deploy 0.7.11+ и совместимый штатный SDK donor.

MAIN показывает пять функций и переход к следующим пяти; DETAIL открывает описание и закрывается кнопкой Назад через штатный стек HMI. Диагностика запускается вручную и посылает только UDS `22 F1 50` от 0xF2 к 0xDF. Два allowlist, русские ошибки и отмена сохранены. Автоматических запросов, VIN, записи/reset/clear нет. Выполнять на стоянке; скорость приложением самостоятельно не проверяется. Ответ ECU не подтверждает возможность кодирования.

## Документы

- [ТЗ исправления запуска](REBUILD-SPEC.md)
- [Глубокий аудит совета](COUNCIL-AUDIT-0.2.0.md)
- [Десять функций и условия будущего кодирования](SPEC.md)
- [История исправлений](AUDIT-FIXES.md)
- [Инструкция независимому аудитору](AUDIT-PROMPT.md)

Производственные исходники: `native/apps/marku_x3_coding`. Тесты проверяют callback UI, настоящий kit/runtime из распакованного архива с заглушкой внешнего SDK, реальную подготовку пакета с синтетическим donor, Node 8 и read-only allowlist. Это host integration, не испытание firmware автомобиля. Существующие GPL/MIT-лицензии kit сохраняются. BMW SDK, файлы машины и данные BimmerCode не распространяются. P1-01 прежнего аудита оставлен открытым по указанию владельца.
