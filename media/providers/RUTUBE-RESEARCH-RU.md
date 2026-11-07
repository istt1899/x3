# RUTUBE: проверенный протокол и границы интеграции

Проверено 7 ноября 2026 года без входа в личную учётную запись. Код адаптера написан отдельно; исходный код сайта не копируется и не исполняется.

## Публичные запросы

- Поиск `GET https://rutube.ru/api/search/video/?query=NASA&format=json`: HTTP 200, 100 записей. Актуальный TV-клиент использует `/api/search/combined/video_playlist?query=...`; адаптер фильтрует плейлисты и оставляет видео с 32-значным hex ID.
- Главная `GET /api/v2/video/recommendation/main?limit=3&show_hidden_videos=False&show_user_hidden_videos=False`: HTTP 200, три видео.
- Метаданные `/api/video/03a9cb54bac3376af4c5cb0f18444e01/?format=json` и `/api/play/options/.../?format=json`: HTTP 200. В образце HLS с AVC1/AAC-LC, до 1080p. Подписанные CDN-адреса временные и не сохраняются в фикстурах.
- Без токена `/api/accounts/visitor/`, `/api/subscription/video/`, `/api/playlist/future/` отвечают HTTP 401; `/api/video/history/` — HTTP 403. Это `auth_required`, а не успешная пустая лента.

Форматы в существующем `ytdlp.pyz` поддерживаются `RutubeIE`. HLS MPEG-TS и объединённый AVC/AAC требуют подходящего демультиплексора/FFmpeg в общем проигрывателе; старый YouTube-only fMP4 demux нельзя считать совместимым автоматически.

## Авторизация

[Официальный FAQ](https://rutube.ru/info/androidtv/) описывает QR/шестизначный код и `https://rutube.ru/activate/`.

Первичный источник точного сетевого протокола — [актуальное официальное TV-приложение](https://rutube.ru/tv-release/webos.server/webos/). При проверке оно загружало `main.88bf555a.js`. Из него обнаружены пути и публичный client_id для device flow. Адаптер получает актуальную HTML-страницу и JS при входе; имя minified-переменной не фиксируется. Адрес/пароль пользователя не вводятся в автомобиль.

1. `POST /multipass/api/v3/oauth2/device/code/?client=tv`, JSON `{client_id, device_name}`, `x-device-id: UUID`. Реально получен HTTP 200 с `user_code` длиной 6, `device_code`, `verification_uri: https://rutube.ru/activate/`, `interval: 10`, `expires_in: 1200`.
2. Пользователь подтверждает код на официальном сайте с телефона. QR содержит `verification_uri` с `?user_code=...`, как в TV-клиенте.
3. `POST /multipass/api/v3/oauth2/device/token?client=tv`, form `{device_code, client_id, grant_type: device_code}`. До подтверждения реально получен HTTP 400 `{code: "1004003"}`. Нельзя опрашивать чаще выданного `interval`.
4. После токенов адаптер проверяет профиль `GET /api/accounts/visitor/?client=tv` с `Authorization: Bearer ACCESS_TOKEN`. Только успешный профиль с ID означает `signed_in`.
5. Продление из first-party TV-кода: `POST /multipass/api/v3/accounts/token?client=tv`, form `{client_id, refresh_token}`. Logout: `POST /multipass/api/accounts/logout/?client=tv`, JSON `{refresh_token}`.

Техническое получение кода с текущей публичной identity TV-клиента не потребовало регистрации отдельного приложения. Публичная документация не устанавливает отдельного договора стабильности этого API для сторонних приложений. Изменение TV-клиента должно завершаться понятной ошибкой обновления, а не фиктивным входом.

Завершение привязки, настоящий refresh и личные ленты без пользователя **не проверены**. Фикстуры утверждают только форму протокола; сами по себе они не подтверждают работу личного кабинета.

## Контракт адаптера

`RutubeProvider(transport=None, clock=None)` / alias `Provider`:

- `search(q, auth=None, page=1)`, `home(auth=None, page=1)`, `feed(which, auth=None, page=1)` → `{items, next}`.
- Карточка: `{id,title,channel,duration_s,thumbnail,url,is_live}`. Канонический URL строится из ID и не поступает из UI.
- `resolve(id, auth=None)` → карточка + `playback{url,protocol,headers}`. Поле `playback` только для backend; подписанные URL не отправляются в UI и не пишутся в журналы.
- `auth_begin(device_name='BMW MGU', auth=None)`, `auth_poll(private)`, `auth_status(private, verify=False)`, `auth_refresh(private)`, `sign_out(private)` → `{public,private}`.
- `public`: только `state`, `code`, `url`, `expires`, `msg`. Разрешённые состояния `signed_out/code/signed_in/error`.
- `private`: `provider`, `device_id`, `client_id`, `pending{device_code,user_code,verification_url,expires_at,interval,next_poll_at}`, `tokens{access_token,refresh_token,expires_at,verified,profile_id}`. Caller хранит его атомарно с 0600 в отдельном state RUTUBE.
- `AuthRequired.code == 'auth_required'`; остальные ошибки имеют безопасные `code`, `status`, текст без токенов/CDN-подписей.
- Injectable transport: `(method,url,headers,data,timeout) -> Response(status,body,headers)`.

Сеть по умолчанию: `urllib` с `ProxyHandler({})`, проверкой TLS и CA `/var/opt/mgu-python/current/ssl/cacert.pem` при наличии. `DirectTransport(ca_bundle=...)` позволяет общему сервису передать проверенный Mozilla CA bundle. Прокси YouTube и настройки окружения не используются. Bearer уходит только на API `rutube.ru`, не в JS/CDN. Междоменные перенаправления не переносят токен. Refresh сохраняет текущий Bearer, как общий request-wrapper официального TV-клиента; идентификация refresh по-прежнему содержится в form-полях.

Живой запуск нового адаптера при заведомо нерабочих HTTP_PROXY/HTTPS_PROXY/ALL_PROXY на 127.0.0.1:1 подтвердил прямую сеть: home — 40 видео, search NASA — 20, resolve — HLS, auth_begin — настоящий шестизначный код, после ожидания interval=10 auth_poll — сохранённый pending. В образце media playlist не содержал EXT-X-MAP, первый сегмент HTTP 200 имел MPEG-TS sync 0x47 через каждые 188 байт.

## Проверки

`python -m unittest discover -s media/providers/tests -p test_rutube.py -v`

Проверки охватывают динамическую identity, отделение public/private, QR-код, interval/expiry, настоящий pending error, отказ личных лент, успешное подтверждение профиля по fixture, refresh, идентификаторы, DRM/недоверенные URL, секреты и logout.

Полная работа на MGU и воспроизведение через общий медиадвижок требуют отдельной проверки на стоянке.

## Размер миниатюр

В том же [официальном TV bundle](https://rutube.ru/tv-release/webos.server/webos/main.88bf555a.js)
карточки используют `thumbnail_url + "?size=" + videoImgSize`, где `videoImgSize="l"`;
отдельные компактные карточки используют `size=s`. Это проверенный параметр CDN,
а не предположение о произвольных `width`/`height`.

Живая проверка 7 ноября: второе видео поиска NASA вернуло JPEG 2696×1515,
365651 байт. Он превышал текущий предел декодера 4 MP. На том же адресе
`pic.rtbcdn.ru` с `?size=l` получен JPEG 640×359, 39952 байт;
с `?size=s` — 193×108, 5532 байт. Адаптер теперь добавляет `size=l`
только для точного хоста `pic.rtbcdn.ru`, когда исходный URL не содержит query
или fragment. Подписанные адреса, уже заданный размер и другие CDN не изменяются.
Пределы JPEG-декодера 4 MP / 64 MiB и проверки HTTPS/хоста сохраняются.
