'use strict';
/**
 * A PKCE callback mailbox, not an OAuth token service. No dependencies, passwords,
 * access/refresh tokens, code verifiers, request logging or persistent sessions.
 * See README.md and VKCOM/vkid-web-sdk/src/auth/auth.ts for the protocol source.
 */
const http = require('node:http');
const crypto = require('node:crypto');

const SAFE = /^[A-Za-z0-9_-]+$/;
const KEY = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_BODY = 4096;

class RelayError extends Error {
    constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function required(value, code) {
    if (typeof value !== 'string' || !value) throw new Error(code);
    return value;
}

function validateConfig(config) {
    const base = new URL(required(config.publicBaseUrl, 'PUBLIC_BASE_URL_REQUIRED'));
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
            || base.pathname !== '/' || base.hostname === 'localhost') throw new Error('PUBLIC_BASE_URL_MUST_BE_HTTPS_ORIGIN');
    // 16 random bytes => 22 URL-safe characters. Stay within the MGU kit's QR v4 capacity.
    const publicBaseUrl = base.origin;
    if (Buffer.byteLength(publicBaseUrl + '/s/' + 'x'.repeat(22)) > 62) throw new Error('PUBLIC_BASE_URL_TOO_LONG_FOR_MGU_QR');
    const clientId = required(config.clientId, 'VK_CLIENT_ID_REQUIRED');
    if (!/^[1-9][0-9]{0,19}$/.test(clientId)) throw new Error('VK_CLIENT_ID_INVALID');
    const redirectUri = required(config.redirectUri, 'VK_REDIRECT_URI_REQUIRED');
    const redirect = new URL(redirectUri);
    if (redirect.origin !== base.origin || redirect.username || redirect.password || redirect.search || redirect.hash
            || !/^\/[A-Za-z0-9/_-]{1,100}$/.test(redirect.pathname)
            || redirect.pathname.startsWith('/v1/') || redirect.pathname.startsWith('/s/')) throw new Error('VK_REDIRECT_URI_INVALID');
    const apiKey = required(config.apiKey, 'BROKER_API_KEY_REQUIRED');
    if (!KEY.test(apiKey)) throw new Error('BROKER_API_KEY_MUST_BE_32_TO_128_URLSAFE_CHARACTERS');
    const scope = config.scope || 'video';
    if (typeof scope !== 'string' || !/^[A-Za-z0-9_. ]{1,128}$/.test(scope)) throw new Error('VK_SCOPE_INVALID');
    const ttlMs = config.ttlMs === undefined ? 600000 : Number(config.ttlMs);
    const maxSessions = config.maxSessions === undefined ? 128 : Number(config.maxSessions);
    const pollIntervalMs = config.pollIntervalMs === undefined ? 5000 : Number(config.pollIntervalMs);
    if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 600000) throw new Error('SESSION_TTL_INVALID');
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 1024) throw new Error('MAX_SESSIONS_INVALID');
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 30000) throw new Error('POLL_INTERVAL_INVALID');
    return { publicBaseUrl, clientId, redirectUri: redirect.href, callbackPath: redirect.pathname,
        apiKeyHash: hash(apiKey), scope, ttlMs, maxSessions, pollIntervalMs };
}

function loadConfig(env = process.env) {
    return validateConfig({ publicBaseUrl: env.PUBLIC_BASE_URL, clientId: env.VK_CLIENT_ID,
        redirectUri: env.VK_REDIRECT_URI, apiKey: env.BROKER_API_KEY, scope: env.VK_SCOPE,
        ttlMs: env.SESSION_TTL_SEC === undefined ? undefined : Number(env.SESSION_TTL_SEC) * 1000,
        maxSessions: env.MAX_SESSIONS, pollIntervalMs: env.POLL_INTERVAL_SEC === undefined ? undefined : Number(env.POLL_INTERVAL_SEC) * 1000 });
}

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest(); }
function equalHash(value, expected) { return typeof value === 'string' && crypto.timingSafeEqual(hash(value), expected); }

function setHeaders(response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
}

function json(response, status, body) {
    setHeaders(response);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
}

function page(response, status, success) {
    setHeaders(response);
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    // Constant HTML: no reflected state, code, device ID or query string.
    response.end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
        + '<title>Подключение VK ID</title><body><h1>'
        + (success ? 'Вернитесь в автомобиль' : 'Не удалось подтвердить вход')
        + '</h1><p>' + (success ? 'Ответ передан приложению. Это окно можно закрыть.' : 'Начните вход заново на экране автомобиля.')
        + '</p></body></html>');
}

function uniqueParameters(params) {
    const value = Object.create(null);
    for (const [key, item] of params) {
        if (Object.hasOwn(value, key)) throw new RelayError(400, 'duplicate_parameter');
        value[key] = item;
    }
    return value;
}

function containsForbidden(value) {
    return value && ['access_token', 'refresh_token', 'password', 'code_verifier'].some((key) => key in value);
}

async function body(request, form = false) {
    const contentType = (request.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json' && !(form && contentType === 'application/x-www-form-urlencoded')) {
        throw new RelayError(415, 'unsupported_content_type');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) throw new RelayError(413, 'body_too_large');
        chunks.push(chunk);
    }
    try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const value = contentType === 'application/json' ? JSON.parse(raw) : uniqueParameters(new URLSearchParams(raw));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        return value;
    } catch (error) { throw new RelayError(400, 'invalid_body'); }
}

function createRelay(input, options = {}) {
    const config = input.apiKeyHash ? input : validateConfig(input);
    const now = options.now || Date.now;
    const sessions = new Map(), stateIndex = new Map(), rates = new Map();

    function remove(id) {
        const session = sessions.get(id);
        if (session) stateIndex.delete(session.state);
        sessions.delete(id);
    }
    function prune() {
        const at = now();
        for (const [id, session] of sessions) if (session.expiresAt <= at) remove(id);
        for (const [ip, rate] of rates) if (rate.until <= at) rates.delete(ip);
    }
    function rate(request, group, limit) {
        // No trust in client-supplied X-Forwarded-For. Behind Caddy this deliberately
        // applies one bounded aggregate limit to the reverse proxy's loopback address.
        const key = (request.socket.remoteAddress || 'unknown') + ':' + group;
        const at = now();
        let value = rates.get(key);
        if (!value || value.until <= at) {
            if (rates.size >= 1024 && !rates.has(key)) throw new RelayError(429, 'rate_limited');
            rates.set(key, value = { count: 0, until: at + 60000 });
        }
        if (++value.count > limit) throw new RelayError(429, 'rate_limited');
    }
    function authenticate(request) {
        const authorization = request.headers.authorization || '';
        if (!authorization.startsWith('Bearer ') || !equalHash(authorization.slice(7), config.apiKeyHash)) {
            throw new RelayError(401, 'unauthorized');
        }
    }
    function own(id, token) {
        const session = sessions.get(id);
        if (!session || !equalHash(token, session.pollHash)) throw new RelayError(404, 'session_not_found');
        return session;
    }
    function validateCreate(value) {
        const allowed = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope'];
        if (Object.keys(value).some((key) => !allowed.includes(key))) throw new RelayError(400, 'unexpected_field');
        if (String(value.client_id) !== config.clientId || value.redirect_uri !== config.redirectUri
                || (value.scope !== undefined && value.scope !== config.scope)) throw new RelayError(400, 'application_not_allowed');
        if (typeof value.state !== 'string' || value.state.length < 32 || value.state.length > 128 || !SAFE.test(value.state)
                || typeof value.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.code_challenge)
                || !['S256', 's256'].includes(value.code_challenge_method)) throw new RelayError(400, 'invalid_pkce');
    }

    const server = http.createServer(async (request, response) => {
        let callback = false;
        try {
            prune();
            if (request.url.length > 8192) throw new RelayError(414, 'uri_too_long');
            const url = new URL(request.url, config.publicBaseUrl);
            callback = url.pathname === config.callbackPath;
            rate(request, 'all', 240);
            if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { status: 'ok' });

            if (request.method === 'POST' && url.pathname === '/v1/sessions') {
                authenticate(request); rate(request, 'create', 20);
                const value = await body(request);
                validateCreate(value);
                if (sessions.size >= config.maxSessions) throw new RelayError(503, 'session_capacity');
                if (stateIndex.has(value.state)) throw new RelayError(409, 'state_already_used');
                const id = crypto.randomBytes(16).toString('base64url');
                const pollToken = crypto.randomBytes(32).toString('base64url');
                const session = { state: value.state, challenge: value.code_challenge,
                    pollHash: hash(pollToken), expiresAt: now() + config.ttlMs, lastPollAt: -Infinity,
                    callback: null, opened: false };
                sessions.set(id, session); stateIndex.set(value.state, id);
                return json(response, 201, { session_id: id, poll_token: pollToken,
                    url: config.publicBaseUrl + '/s/' + id, expires_in: Math.floor(config.ttlMs / 1000),
                    poll_interval: Math.ceil(config.pollIntervalMs / 1000) });
            }

            const short = /^\/s\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
            if (request.method === 'GET' && short) {
                rate(request, 'browser', 60);
                const session = sessions.get(short[1]);
                if (!session || session.callback) throw new RelayError(404, 'session_not_found');
                const authorize = new URL('https://id.vk.ru/authorize');
                const params = { client_id: config.clientId, redirect_uri: config.redirectUri,
                    response_type: 'code', scope: config.scope, state: session.state,
                    code_challenge: session.challenge, code_challenge_method: 's256' };
                for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value);
                session.opened = true;
                setHeaders(response); response.writeHead(302, { Location: authorize.href });
                return response.end();
            }

            if (callback && ['GET', 'POST'].includes(request.method)) {
                rate(request, 'callback', 60);
                let value = request.method === 'GET' ? uniqueParameters(url.searchParams) : await body(request, true);
                if (containsForbidden(value)) throw new RelayError(400, 'invalid_callback');
                if (value.payload !== undefined) {
                    if (typeof value.payload !== 'string' || value.payload.length > MAX_BODY) throw new RelayError(400, 'invalid_callback');
                    try { value = JSON.parse(value.payload); } catch (error) { throw new RelayError(400, 'invalid_callback'); }
                }
                if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.state !== 'string') throw new RelayError(400, 'invalid_callback');
                const id = stateIndex.get(value.state), session = id && sessions.get(id);
                if (!session || !session.opened || session.callback) throw new RelayError(400, 'invalid_callback');
                if (!crypto.timingSafeEqual(hash(value.state), hash(session.state))) throw new RelayError(400, 'invalid_callback');
                if (containsForbidden(value)) throw new RelayError(400, 'invalid_callback');
                if (value.error) {
                    session.callback = { state: session.state, error: 'access_denied' };
                    return page(response, 400, false);
                }
                if (typeof value.code !== 'string' || !value.code || value.code.length > 2048
                        || typeof value.device_id !== 'string' || !value.device_id || value.device_id.length > 512) throw new RelayError(400, 'invalid_callback');
                // No tokens/verifier/password are accepted into this mailbox.
                session.callback = { state: session.state, code: value.code, device_id: value.device_id };
                return page(response, 200, true);
            }

            const poll = /^\/v1\/sessions\/([A-Za-z0-9_-]{22})(\/poll)?$/.exec(url.pathname);
            if (poll && ((request.method === 'POST' && poll[2]) || (request.method === 'DELETE' && !poll[2]))) {
                authenticate(request);
                const value = await body(request);
                if (Object.keys(value).some((key) => key !== 'poll_token')) throw new RelayError(400, 'unexpected_field');
                const session = own(poll[1], value.poll_token);
                if (request.method === 'DELETE') { remove(poll[1]); return json(response, 200, { status: 'deleted' }); }
                if (now() < session.lastPollAt + config.pollIntervalMs) {
                    response.setHeader('Retry-After', Math.ceil(config.pollIntervalMs / 1000));
                    return json(response, 429, { status: 'pending', error: 'slow_down', poll_after: Math.ceil(config.pollIntervalMs / 1000) });
                }
                session.lastPollAt = now();
                if (!session.callback) return json(response, 200, { status: 'pending',
                    expires_in: Math.max(0, Math.floor((session.expiresAt - now()) / 1000)),
                    poll_after: Math.ceil(config.pollIntervalMs / 1000) });
                const result = session.callback;
                remove(poll[1]); // atomic one-time handoff before writing response
                return json(response, 200, { status: 'complete', ...result });
            }
            throw new RelayError(404, 'not_found');
        } catch (error) {
            if (response.headersSent) { response.end(); return; }
            if (callback) return page(response, error instanceof RelayError ? error.status : 500, false);
            return json(response, error instanceof RelayError ? error.status : 500,
                { error: error instanceof RelayError ? error.code : 'internal_error' });
        }
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 15000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 32;
    return { server, stats: () => ({ sessions: sessions.size, rateBuckets: rates.size }) };
}

if (require.main === module) {
    try {
        const config = loadConfig();
        const port = Number(process.env.PORT || 8787);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT_INVALID');
        const relay = createRelay(config);
        relay.server.listen(port, '127.0.0.1', () => process.stdout.write('VK auth relay listening on loopback.\n'));
        relay.server.on('error', () => { process.stderr.write('VK auth relay could not start.\n'); process.exit(1); });
        process.on('SIGTERM', () => relay.server.close());
    } catch (error) {
        // Configuration names are safe; never print a URL/key/query or a request stack.
        process.stderr.write('VK auth relay configuration is missing or invalid. See README.md.\n');
        process.exit(1);
    }
}

module.exports = { createRelay, loadConfig, validateConfig };
