# VK Видео: потребительский TV-вход с телефона

Проверено 7 ноября 2026 года. Это вход владельца в свой аккаунт VK, как на
телевизоре: автомобиль показывает QR/код, владелец подтверждает вход на телефоне.
Собственное приложение разработчика VK ID, callback-сервер, cookie, пароль,
client_secret и подтверждение чужого аккаунта для этой ветки не требуются.

## Первичные источники

- [Официальная инструкция VK Видео для телевизоров](https://vkvideo.ru/landings/tv_instructions/index.html)
  с прямой ссылкой на [официальный APK](https://vk.ru/atv).
- Полученный APK: пакет `com.vk.tv`, Android TV/LEANBACK; 60803647 байт,
  SHA-256 `939bee05ac4c576d4cbf6b08c145c1bbb535fc071f5130909736ae04103808ed`.
  Не устанавливался и не исполнялся. Публичная identity `8114066` взята из
  `AndroidManifest.xml`, meta-data `api_id`; код инициализации передаёт этот
  integer в `VKApiConfig`. Значение native `client_secret` не использовалось.
- [Официальный VK ID web SDK](https://static.vk.com/vkid/1.1.1429/auth.js),
  SHA-256 `1260808862a52c8989153a5b423aea5d83ae32eacf319b4a88cb1e4999b5b294`:
  `getAnonymTokenRequest` запрашивает анонимный токен с `client_id` и `device_id`,
  без client_secret. Публичная web identity `52461373` получала anonymous token,
  но не получила TV-код: `auth.getAuthCode` вернул ошибку 100. Поэтому приложение
  использует доказанную публичную TV identity, без её встроенного native секрета.

REA выполнил статическую проверку структуры APK-подписи: v2/v3 объявляют один
cert SHA-256 `057d974412032066f1b5edb1fdb550f71854189815c806b27c4d486fb4f1ef32`,
объявленные content digests соответствуют файлу. Это не криптографическая
проверка подписи и не самостоятельное доказательство подлинности. Источник
скачивания — официальный VK URL. REA Android/JADX provider оказался не настроен;
после чтения recovery использован отдельный официальный portable JADX CLI 1.5.6
для статического чтения выбранных DEX, без изменения конфигурации REA.

## Реальный протокол

Все запросы — POST с form body, прямой HTTPS на `https://api.vk.ru/method/`,
`v=5.267`, `Origin/Referer: https://vkvideo.ru/`. Авторизационные данные не
передаются в URL процесса, окружении, журналах или UI.

1. `auth.getAnonymToken`: `client_id=8114066`, случайный постоянный для устройства
   `device_id` UUID. Реально получен HTTP 200, `response{token,expired_at}`.
   Поля client_secret и cookie отсутствуют.
2. `auth.getAuthCode`: `anonymous_token`, пустой `access_token`, те же
   `client_id/device_id`, `device_name=BMW MGU`, `scope=video,offline`,
   `need_qr_code=1`, `force_regenerate=1`. Реально получен HTTP 200 с
   `auth_code`, `auth_hash`, `auth_id`, `auth_url`, `expires_in`, `qr_code_url`.
   Сервер принял имя **BMW MGU**. Права wall/groups/notifications не запрашиваются.
3. `auth_url` имеет точную форму `https://qr.vk.ru/ca?q=<6 ASCII букв/цифр>`:
   28 UTF-8 байт, `q` совпадает с видимым кодом. Приватный `auth_hash` в URL
   не содержится. QR рисует существующий локальный MGU QR kit; полученный
   сервером адрес картинки на Google Chart игнорируется, запросов к нему нет.
4. `auth.checkAuthCode`: тот же anonymous token, пустой access token и приватный
   `auth_hash`. Неподтверждённый код реально вернул HTTP 200, `response.status=0`.
   В официальном APK enum: `0 CREATED`, `1 OPENED`, `2 APPROVED`,
   `3 DECLINED`, `4 EXPIRED`. Открытие QR на телефоне ещё не означает вход.
5. Только для `status=2` с access token и user ID запускается отдельная проверка
   `users.get` от имени текущего токена и `video.get`. Сверяется user ID,
   проверяется фактический доступ Video API. Без неё `signed_in` не выставляется.

Методы и поля подтверждены статическим кодом официального APK: `AuthService.kt`
(`ir0.a`), `TvAuthSource.kt`, `TvEmbeddedDataRepositoryImpl.kt`,
`AuthGetAuthCodeResponseDto`, `AuthCheckAuthCodeResponseDto`, `TvAuthCodeStatus`.
Параметры `auth_code_type/auth_code_flow` необязательны; один настоящий native
callsite вызывает их с `null/null`. `auth.getExchangeToken` существует, но не
является polling-методом этого входа и не нужен для выдачи TV access token.

## Время, сохранение и отмена

В живом ответе `getAuthCode.expires_in` оказался **Unix timestamp**, несмотря
на имя поля: оставалось около двух минут. Helper превращает epoch в ограниченный
TTL для UI, а приватно сохраняет deadline. Проверка допускает также bounded TTL;
уже истёкшие, NaN/Infinity и неправдоподобные значения не создают вечного входа.
В отсутствие отдельного интервала сервера используется консервативный polling
раз в 5 секунд, при rate limit — увеличение до 60 секунд. Частота не заявляется
официальной гарантией API.

`TvAuth` получает direct transport и callback проверки аккаунта. Методы
`begin/poll/status/sign_out` возвращают `{public,private}`, копируют входное
состояние и не изменяют его на месте. В private находятся anonymous token,
auth hash, device UUID, deadlines и выданный user token. Public содержит только
состояние, видимый код, проверенный URL, TTL и безопасный текст.

Временная ошибка polling сохраняет pending до его deadline. Временная ошибка
проверки уже выданного user token сохраняет его с `verification_pending`,
чтобы безопасно повторить проверку. Переход к `signed_in` требует реального
callback с подтверждённым Video API, тем же токеном и тем же user ID.

Для конечного срока user token helper требует новый QR после истечения.
Неограниченный offline срок принимается только при явном `expires_in=0` и
успешной проверке аккаунта; отсутствие expiry даёт консервативный час.
Рабочий native refresh/revoke без подтверждённого аккаунта не установлен:
helper не подменяет его relay OAuth endpoint и не придумывает запросы.
Выход очищает локальное состояние; root bridge отменяет polling generations,
так что запоздалый worker не может восстановить удалённый аккаунт. Это не
обещание глобального отзыва уже выданного токена на стороне VK.

## Проверки и границы

`python media/providers/tests/test_vk_tv.py -v` — offline тесты протокола,
epoch/TTL, polling/expiry, URL allowlist, отделения секретов, обязательной
проверки пользователя и сохранения токена при временном сбое.

Живой запуск именно нового helper с `device_name=BMW MGU` выполнил
`begin → ожидание 5 с → poll`: настоящий шестизначный код выдан, pending
сохранён; HTTP_PROXY/HTTPS_PROXY/ALL_PROXY на неработающий 127.0.0.1:1
игнорировались direct transport. Значения кода, anonymous token и auth hash
в репозиторий и журнал проверки не помещались.

**Не проверены владельцем:** подтверждение аккаунта, фактический user token
после approval, личные видео и долговременная работа на MGU. Fixture с успешным
approval проверяет контракт, а не подтверждает реальный личный вход.
