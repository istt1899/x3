# VK ID: короткий QR-адрес для MGU

**Необязательный режим для собственного VK ID приложения.** В выпуске MGU Video
0.4.1 стандартный вход VK использует телевизионный QR/код и не требует этого
посредника. Обычному владельцу достаточно [инструкции Store](../INSTALL-STORE-RU.md).

Это готовый к настройке посредник обратного вызова OAuth PKCE. Он не является VPN,
прокси видео или сервером токенов. Поиск и воспроизведение VK идут из автомобиля
напрямую. Посредник нужен, потому что длинный URL официальной авторизации VK ID
не помещается в QR версии 4, поддерживаемый библиотекой MGU.

**Без собственного APP_ID, зарегистрированного HTTPS redirect URI и развёрнутого
посредника вход не включён.** Публичный поиск доступен без аккаунта. Код и тесты
не подтверждают реальную выдачу разрешений VK пользовательскому приложению:
после настройки требуется вход своим аккаунтом и проверка API видео.

## Что потребуется

1. Собственное приложение в [кабинете VK ID](https://id.vk.com/about/business/go),
   его `APP_ID` и доступ к API видео. Чужие идентификаторы приложений не используются.
2. Короткий домен, например `vk-login.example.com`, с DNS на вашем VPS.
   Сервер проверяет, что итоговый QR `https://домен/s/<22 символа>` не длиннее
   62 байт. Схема — только HTTPS, без пользователя, пароля, query и fragment.
3. Разрешённый VK HTTPS redirect URI, например
   `https://vk-login.example.com/callback`. Он должен совпасть побайтно в кабинете
   VK ID, сервере и приватной конфигурации автомобиля. Callback принадлежит
   тому же origin, что и короткий адрес. CORS и встроенный браузер MGU не нужны.
4. VPS с поддерживаемой версией Node.js (код совместим с Node 18+, без npm
   зависимостей), HTTPS reverse proxy Caddy и приватный случайный `broker_key`.
   По умолчанию разрешение `video`; если вашему приложению VK разрешил другой
   набор scope, одинаково настройте его с обеих сторон. Вход считается успешным
   только после `user_info` и успешного `video.get` пользовательским токеном.

Регистрация VK ID сама по себе не гарантирует доступ к VK Video API. Если VK
откажет в разрешении или проверке API, приложение покажет ошибку доступа, а не
фиктивное состояние «Аккаунт подключён». Личная рекомендательная лента и приватные
веб-видео не подменяются гостевым поиском; OAuth-токен не превращается в web cookie.

## Поток авторизации

1. MGU генерирует случайные `state` и PKCE `code_verifier`. Verifier остаётся
   в приватном файле аккаунта автомобиля. Сервер получает только SHA256 challenge,
   state, зарегистрированные client_id/redirect_uri и API key в заголовке.
2. Сервер возвращает короткий URL, TTL и секретный poll token. В интерфейс MGU
   попадает только URL; poll token, API key и verifier остаются внутри службы.
3. QR на телефоне открывает короткий URL. Сервер отвечает 302 на официальный
   `https://id.vk.ru/authorize` с PKCE. Пароль вводится исключительно на VK ID.
4. VK возвращает `code`, `device_id`, `state` на зарегистрированный callback.
   Посредник проверяет сессию и state и хранит ответ в оперативной памяти.
5. MGU забирает ответ ровно один раз, предъявляя API key и секретный poll token.
   MGU проверяет state и срок, самостоятельно обменивает код на токены через VK ID,
   затем проверяет пользователя и доступ к API видео.

Посредник не получает PKCE verifier, пароль, access_token или refresh_token.
Входящие поля с такими именами отклоняются. Хранится SHA256 poll token; callback
удаляется перед одноразовой выдачей. Нет БД, файлов с сессиями и журналов запросов.
Перезапуск сервера отменяет незавершённые входы; уже выданные MGU токены остаются
в приватном аккаунте автомобиля.

## API посредника

Все управляющие вызовы требуют `Authorization: Bearer <broker_key>` и
`Content-Type: application/json`. Не передавайте ключ в URL.

| Запрос | Ответ |
| --- | --- |
| `POST /v1/sessions` с `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method: "S256"` | `201 {session_id, poll_token, url, expires_in, poll_interval}` |
| `GET /s/<session_id>` без ключа | `302` на официальный VK ID; короткий URL не содержит code, verifier или poll token |
| `GET /callback?code=…&device_id=…&state=…` либо callback POST | Статичная страница, без отражения параметров. Поддерживается также официальный JSON `payload` |
| `POST /v1/sessions/<session_id>/poll` с `poll_token` | `200 {status:"pending",expires_in,poll_after}` либо одноразовый `200 {status:"complete",code,device_id,state}` |
| `DELETE /v1/sessions/<session_id>` с `poll_token` | `200 {status:"deleted"}` |
| `GET /health` | `200 {status:"ok"}`, без диагностических секретов |

Отклонённая авторизация даёт одноразовый `status:"complete",error:"access_denied"`.
Неверный API key — 401. Неизвестная, истёкшая, использованная или не принадлежащая
poll token сессия — 404. Повторный ранний poll — 429 с `Retry-After`.
Сессия живёт максимум 600 секунд, по умолчанию максимум 128 сессий одновременно
(настройка не более 1024), тело запроса не более 4 КиБ. Есть общий лимит запросов,
созданий и callback; `X-Forwarded-For` не считается доверенным источником адреса.
За Caddy лимиты применяются суммарно к loopback; для личного автомобиля этого
достаточно. Поллинг со стороны MGU — не чаще серверного интервала, минимум 5 секунд.

## Установка на VPS

Файлы приложения скопируйте в `/opt/mgu-vk-auth-relay`, владельцем оставьте root;
служба использует `DynamicUser` и не должна менять собственный код. Установите
актуальную поддерживаемую Node.js и Caddy из их официальных источников.
Пример для подготовленного Linux VPS, из каталога `media/auth-relay`:

```sh
sudo install -d -m 0755 /opt/mgu-vk-auth-relay
sudo install -m 0644 server.js package.json LICENSE /opt/mgu-vk-auth-relay/
sudo install -m 0600 .env.example /etc/mgu-vk-auth-relay.env
sudo install -m 0644 mgu-vk-auth-relay.service /etc/systemd/system/
sudoedit /etc/mgu-vk-auth-relay.env
```

Замените все заглушки в env. Приватный ключ можно сгенерировать локально командой
`node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"`.
Сохраните его в env и в приватной конфигурации MGU, не в репозитории или чате.
`PUBLIC_BASE_URL`, `VK_CLIENT_ID`, `VK_REDIRECT_URI`, `BROKER_API_KEY` обязательны;
с неправильными или отсутствующими настройками служба не запустится.

Настройте DNS и HTTPS по `Caddyfile.example`. Пример рассчитан на отдельный Caddy:
он отключает access и runtime логирование, чтобы query callback не попали в журнал.
Если на VPS уже есть Caddy/Nginx/CDN/WAF, объедините конфигурацию так, чтобы ни один
слой не записывал URL callback, Location, тела запросов и Authorization. Не включайте
debug или HTTP tracing для действующих входов. Порт 8787 слушает только 127.0.0.1;
наружу нужны HTTPS 443 и, для стандартного выпуска сертификата Caddy, HTTP 80.

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now mgu-vk-auth-relay.service
sudo systemctl reload caddy
curl --fail https://vk-login.example.com/health
```

Секреты не передаются через argv. Не делайте публичную копию env. Команда health
не создаёт аккаунт и не подтверждает VK API: она проверяет только сеть/TLS/процесс.
Не разворачивайте несколько реплик без закрепления сессий: хранилище находится
в RAM одного процесса. Приложение намеренно не имеет функции дампа сессий.

## Приватная настройка MGU

В отдельном состоянии провайдера VK создайте `config.json` с правами 0600 и владельцем
root. При стандартной конфигурации путь — `/var/opt/jap-ridetube-d/state/vk/config.json`.
Точный корневой каталог задаёт общая служба (`ctx.stateDir`), файл аккаунта находится
рядом как `account.json`. Не редактируйте настройки YouTube-прокси.

```json
{
  "client_id": "ВАШ_ЧИСЛОВОЙ_APP_ID",
  "redirect_uri": "https://vk-login.example.com/callback",
  "callback_broker": "https://vk-login.example.com",
  "broker_key": "ТОТ_ЖЕ_ПРИВАТНЫЙ_СЛУЧАЙНЫЙ_КЛЮЧ",
  "scope": "video"
}
```

Это схема с заглушками. Ничего из неё не следует публиковать с настоящим ключом.
Общая служба должна передавать поля приватно Python worker через stdin; `broker_key`
и `broker_poll_token` не должны попадать в публичное состояние, argv, QR или логи.
Изменив конфигурацию, перезапустите общую службу, откройте «Аккаунт» VK Видео и
нажмите «Войти». Сканирование QR запускается вручную; публичный поиск входа не требует.

## Проверки перед реальным входом

```sh
node --test media/auth-relay/test/*.test.js
python -m unittest discover -s media/providers/tests -p test_vk.py -v
python -m unittest discover -s media/auth-relay/test -p test_provider_relay.py -v
```

Первые тесты работают через настоящий HTTP сервер на loopback. Сквозной тест запускает
настоящий Node relay и настоящий Python HTTP транспорт; только VK ID/API заменены
обезличенными ответами. Он не обращается к пользовательским аккаунтам. Перед
использованием на MGU отдельно подтвердите реальный APP_ID/redirect, выдачу scope,
вход, перезапуск службы, refresh, выход и повторный вход. На работающем автомобиле
видеопроверки выполняются на стоянке с сохранённой блокировкой видео в движении.

## Первичные источники протокола

Проверено 7 ноября 2026. Сверьте при обновлениях:

- [VKCOM/vkid-web-sdk, auth.ts](https://github.com/VKCOM/vkid-web-sdk/blob/master/src/auth/auth.ts):
  authorize и PKCE `s256`; `exchangeCode`, `refreshToken`, `userInfo`, `logout`.
  У SDK параметры grant/client/redirect/state/device/verifier находятся в query,
  а code, refresh_token или access_token — в form POST body. Код провайдера повторяет
  это разделение, проверяет возвращённый state и не использует client_secret.
- [VK API schema, video methods](https://github.com/VKCOM/vk-api-schema/blob/master/video/methods.json):
  пользовательские разрешения методов видео. Публичный web-поиск VK и OAuth API —
  разные каналы, веб-API может меняться.
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https),
  [Caddy log directive](https://caddyserver.com/docs/caddyfile/directives/log) и
  [global log option](https://caddyserver.com/docs/caddyfile/options#log).

Лицензия кода: GPL-3.0-or-later, как в общем проекте. Код SDK VK не копируется.
