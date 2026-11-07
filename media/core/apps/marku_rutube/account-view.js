'use strict';
// Pure account presentation. Tokens never belong to this model; no fallback login host.
const URL = require('url').URL;

function accountView(auth, service) {
    const a = auth || {}, name = service.title;
    if (a.state === 'signed_in') return { kind: 'signed_in', title: 'Аккаунт подключён',
        hint: a.name || name, action: 'Выйти из аккаунта' };
    if (a.state === 'asking' || a.state === 'unknown') return { kind: 'waiting',
        title: 'Подключаем ' + name, hint: 'Ожидаем ответ сервиса…' };
    if (a.state === 'code') {
        let url;
        try {
            const parsed = new URL(a.url || '');
            // This mailbox URL is produced only by the root-configured VK provider.
            // It carries no poll secret/PKCE verifier and has no redirect query.
            const configuredRelay = service.id === 'vk' && service.allowConfiguredRelay === true
                && /^\/s\/[A-Za-z0-9_-]{22}$/.test(parsed.pathname)
                && !parsed.search && !parsed.hash && Buffer.byteLength(parsed.href, 'utf8') <= 62;
            if (parsed.protocol === 'https:' && !parsed.username && !parsed.password
                    && (service.authHosts.indexOf(parsed.hostname) >= 0 || configuredRelay)) url = parsed.href;
        } catch (e) { /* an invalid/missing activation address is not a login code */ }
        if (!url) return { kind: 'error', title: 'Не удалось открыть вход',
            hint: a.msg || 'Сервис не прислал действующий адрес подтверждения.', action: 'Повторить' };
        // The bundled kit supports QR versions 1–4. Never replace a long VK OAuth URL
        // with an unrelated short URL or a Google device page.
        if (Buffer.byteLength(url, 'utf8') > 62) return service.id === 'vk'
            ? { kind: 'setup', title: 'Нужно настроить вход VK ID',
                hint: 'Для подтверждения на телефоне нужен короткий адрес подключения. Поиск доступен без входа.',
                action: 'Проверить подключение' }
            : { kind: 'error', title: 'Адрес входа слишком длинный',
                hint: 'Получите новый код подтверждения RUTUBE.', action: 'Повторить' };
        return { kind: 'code', title: 'Вход в ' + name, hint: 'Отсканируйте QR-код камерой телефона',
            url, code: typeof a.code === 'string' ? a.code : '', expires: Number(a.expires) || 0 };
    }
    if (a.state === 'error' && service.id === 'vk' &&
            (a.code === 'configuration_required' || /client_id|redirect|VK ID.*настро|зарегистрирован|callback/i.test(a.msg || ''))) {
        return { kind: 'setup', title: 'Нужно подключить VK ID',
            hint: a.msg || 'Настройте приложение VK ID и адрес подтверждения. Поиск работает без аккаунта.',
            action: 'Проверить подключение' };
    }
    if (a.state === 'error') return { kind: 'error', title: 'Вход пока недоступен',
        hint: a.msg || 'Проверьте интернет и повторите попытку.', action: 'Повторить' };
    return { kind: 'signed_out', title: 'Аккаунт ' + name,
        hint: 'Публичные видео доступны без входа. Аккаунт подключается отдельно.', action: 'Войти' };
}

module.exports = { accountView };
