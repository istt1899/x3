# ТЗ: «X3 ↔ Дом» 0.1.0 для MGU

Дата / версия: 12.11.2026, редакция 1.
Статус: Готово к реализации.
Согласования: реализация и публикация разрешены. Внешние команды допустимы только через локальный bridge, явное подтверждение и allowlist; произвольный MQTT/API запрещён.

## Цель и исходное состояние

Приложение показывает несколько разрешённых сцен Home Assistant и отправляет выбранную телеметрию. Токен HA не хранится в приложении и пакете: pairing выполняется через одноразовую страницу bridge в Wi-Fi hotspot автомобиля. Источники: `sources/idrive7-apps/apps/live_data/signals.js`; `media/core/native/jap-ridetube-d/component.json`; `media/core/tools/repack_service.py`; `mgu-five-apps.html#home`.

## Объём

Входит: приложение `marku_x3_home`, tool `marku-home-bridge`, pairing/config через `http://172.16.222.97:38765`, три фиксированные сцены (`arrive`, `leave`, `snapshot`), HA REST, Unix socket app↔bridge, таймаут и запрет авто-повтора, локальный журнал без секретов.

Не входит: MQTT, произвольные entity/service, камеры, голосовой ввод, OpenClaw cloud, облачный аккаунт, выполнение при сне MGU.

Позже: OpenClaw tasks/notifications, геозоны, HA event subscription и отдельный security review перед дверями/замками.

## Требования

| ID | Требование | Основание | Статус |
|---|---|---|---|
| REQ-001 | Приложение требует `marku-home-bridge >= 0.1.0`; bridge требует `jap-node22`, `mgu-uplink`, `mgu-deploy` | Store | обязательное |
| REQ-002 | Bridge читает `/var/opt/marku-home-bridge/state/config.json` только с правами 0600; секрет не пишется в лог и UI | security | обязательное |
| REQ-003 | Pairing выдаёт одноразовый код на 10 минут; страница доступна только по hotspot IP; сохранение одно | least privilege | обязательное |
| REQ-004 | Принимаются только `http://` RFC1918/localhost или `https://` URL; token обязателен; длина и поля валидируются | SSRF/validation | обязательное |
| REQ-005 | App может отправить только `scene_id` из фиксированного allowlist; bridge не принимает domain/service/entity от приложения | command safety | обязательное |
| REQ-006 | «Выезжаю» и подобные сцены требуют отдельного подтверждения в UI; отмена не отправляет команду | confirm gate | обязательное |
| REQ-007 | HTTP имеет timeout; после network error/timeout результат «неизвестен», автоматический повтор запрещён | no duplicate action | обязательное |
| REQ-008 | При восстановлении сети старая команда не выполняется; пользователь запускает заново | no stale action | обязательное |
| REQ-009 | Telemetry preview исключает VIN и координаты; отправка только вручную | privacy | обязательное |
| REQ-010 | Журнал содержит scene/result/time, но не URL, token, response body | privacy/logging | обязательное |
| REQ-011 | Unit/socket закрываются при shutdown; bridge не запускает команды сам | lifecycle | обязательное |

## Приёмка и проверки

| ID | Требования | Условия и действие | Ожидаемый результат | Как проверить |
|---|---|---|---|---|
| AC-001 | REQ-001 | Сборка app и tool | `marku_x3_home@0.1.0.tgz`, `marku-home-bridge@0.1.0.tgz` созданы | `tests/package.test.js` |
| AC-002 | REQ-002 | Config 0644 или token в логе | Bridge отказывается/не логирует секрет | `tests/home_bridge.test.js` |
| AC-003 | REQ-003 | Два pairing save | Второй отклонён; код одноразовый и истекает | `tests/home_bridge.test.js` |
| AC-004 | REQ-004 | `http://8.8.8.8`, `file://`, `ftp://`, malformed URL | Все отклонены до запроса | `tests/home_bridge.test.js` |
| AC-005 | REQ-005 | App отправляет `{"domain":"light","service":"turn_on"}` | Bridge отклоняет payload; только scene_id | `tests/home_bridge.test.js` |
| AC-006 | REQ-006 | Нажать «Выезжаю», затем отмену | Подтверждение открыто; отмена не вызывает HA | `tests/home_app.test.js` |
| AC-007 | REQ-007 | HA не отвечает до timeout | Статус unknown/no auto-retry; одна попытка | `tests/home_bridge.test.js` |
| AC-008 | REQ-008 | Timeout → reconnect → старый action | Новый запрос отсутствует; UI просит повторить | `tests/home_bridge.test.js` |
| AC-009 | REQ-009 | Preview telemetry | Только ignition/12V/service; VIN/coords отсутствуют | `tests/home_app.test.js` |
| AC-010 | REQ-010 | Просмотр лога после успеха/ошибки | Нет token/URL/response body | `tests/home_bridge.test.js` |
| AC-011 | REQ-011 | Shutdown app/bridge | Socket/unit/timer закрыты, процесс завершается | `tests/home_bridge.test.js` |

## Краевые случаи

Bridge не установлен, config отсутствует, hotspot IP недоступен, HA 401/404/500, timeout, Unix socket переполнен, повторный click во время выполнения, смена токена, удаление config, MGU sleep. Ни один случай не приводит к автоматической команде.

## Предположения и вопросы

| ID | Что неизвестно | Влияние | Временный вариант | Блокирует реализацию |
|---|---|---|---|---|
| Q-001 | Адрес HA и токен владельца | Нет живой команды | Pairing вводит их на телефоне | нет |
| Q-002 | Доступность hotspot IP 172.16.222.97 | Pairing может быть недоступен | Показать точную причину и ручной путь | нет |
| Q-003 | Реальные service names сцен | Может не совпасть с HA | Config редактируется в pairing и проверяется dry-run | нет |

## Макеты и переходы

`MAIN`: статус bridge/network, три сцены, telemetry preview, журнал. `CONFIRM` — штатный экран подтверждения опасной сцены. Макет `mgu-five-apps.html#home` принят.

## Определение готовности

Все REQ связаны с AC. Публикация допустима с config-less пакетом; реальная команда выполняется только после pairing владельцем.
