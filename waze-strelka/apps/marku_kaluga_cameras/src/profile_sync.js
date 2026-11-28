// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * profile_sync - the map settings per driver profile. Runs from the app's
 * start, page shown or not.
 *
 * Every POLL_MS it reads the head unit's current user account
 * (de.bmw.infotainment.personalization.SessionManager, field
 * currentUserAccountReference: a getter, no notifier), read-only. A profile
 * counts once two reads in a row give the same valid id (PROFILE_ID); no
 * profile counts only when the head unit has no SessionManager proxy or no
 * such field. A read that fails, times out or gives no valid id changes
 * nothing, and a proxy that is slow to set up or fails to start is set up
 * again later. When the profile that counts differs from the one patchd
 * has in effect, it tells patchd {"cmd":"profile","id"} over a short
 * connection of its own. patchd puts that profile's own map settings, or
 * the shared ones, in effect and saves them for the render's next start;
 * when the render is to follow, this moves it to them: through the page's
 * own render connection while the page is open (it owns the render's
 * control socket), else through a short connection of its own. setOwn(on)
 * asks patchd {"cmd":"profile-own","id","on"} the same way, for the Own
 * settings for this driver checkbox; refused, the profile is told again.
 *
 * patchd not running is asked again at the next read; one that does not
 * answer or refuses the command (before profiles) after RETRY_MS. Meanwhile
 * the checkbox is greyed.
 */
'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const { RENDER_PATH, PATCH_PATH, renderMapSettings } = require('./waze_cluster_control.js');

const POLL_MS = 5000;
const RENDER_STATUS_PATH = '/run/waze-on-cluster/status.json';
/* The native service replaces its snapshot about once a second. */
const RENDER_STATUS_MAX_AGE_MS = 5000;
const READ_MS = 3000;
/* a proxy that failed to start: set up again after this, then less often */
const SETUP_RETRY_MS = 10000;
const SETUP_RETRY_MAX_MS = 300000;
const REPLY_MS = 3000;
const RETRY_MS = 60000;
/* how long a short render connection stays for its commands */
const RENDER_HOLD_MS = 800;
const IFACE = 'de.bmw.infotainment.personalization.SessionManager';
const INSTANCE = 'de.bmw.infotainment.personalization.SessionManager';
const FIELD = 'currentUserAccountReference';
/* patchd's PROFILE_ID: what an id may be before it is used as a key */
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+={}-]{0,127}$/;
const NONE = null;

function within(p, ms, what) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
        p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
}

/* A reader of the current user account through the SDK's typed proxy:
 * () -> Promise<id | NONE>. NONE only without the proxy or the field, for
 * good; rejected when the read gives nothing to go by. options: readMs,
 * retryMs, retryMaxMs. */
function sessionReader(someipBuilders, log, options) {
    const o = options || {};
    const readMs = o.readMs || READ_MS;
    const retryMax = o.retryMaxMs || SETUP_RETRY_MAX_MS;
    let retryMs = o.retryMs || SETUP_RETRY_MS;
    let proxy = null;
    let none = false;
    let starting = null;
    let retryAt = 0;
    const warned = {};
    const warn = (why, text) => {
        if (!warned[why]) {
            warned[why] = true;
            log.warn(`driver profiles: ${text}`);
        }
    };
    /* null for good when the head unit has no such proxy or field */
    const setUp = () => {
        if (proxy || none) {
            return Promise.resolve(proxy);
        }
        if (starting) {
            return starting;
        }
        if (Date.now() < retryAt) {
            return Promise.reject(new Error(`${IFACE} proxy: set up again later`));
        }
        starting = within(Promise.resolve()
            .then(() => someipBuilders.buildTypedProxy(IFACE, INSTANCE))
            .then((p) => {
                if (!p || !p[FIELD] || typeof p[FIELD].getValue !== 'function') {
                    none = true;
                    warn('none', `no ${FIELD}; the map settings are shared`);
                    return null;
                }
                return p.init().then(() => p);
            }, (e) => {
                if (!e || !/no interface configuration/i.test(e.message)) throw e;
                none = true;
                warn('none', `no ${IFACE} proxy (${e.message}); the map settings are shared`);
                return null;
            }), readMs, `${IFACE} proxy`)
            .then((p) => {
                starting = null;
                proxy = p;
                return p;
            }, (e) => {
                starting = null;
                retryAt = Date.now() + retryMs;
                log.info(`driver profiles: ${e && e.message}; set up again in ${Math.round(retryMs / 1000)} s`);
                retryMs = Math.min(retryMs * 2, retryMax);
                throw e;
            });
        return starting;
    };
    return () => setUp().then((p) => {
        if (!p) {
            return NONE;
        }
        return within(Promise.resolve()
            .then(() => p.waitUntilAvailable(readMs))
            .then(() => p[FIELD].getValue()), readMs * 2, `reading ${FIELD}`)
            .then((v) => {
                if (typeof v === 'string' && PROFILE_ID.test(v)) {
                    return v;
                }
                if (v !== '') {
                    warn('shape', `${FIELD} is not a profile id`);
                }
                throw new Error('no profile id read');
            });
    });
}

/* One request to a socket on a connection of its own: resolves to the
 * first line done(msg, socket) accepts (obj=null listens for initial status), null when the connection opened and none
 * came, or undefined when it did not open. */
function askOnce(path, obj, done, ms) {
    return new Promise((resolve) => {
        const s = net.connect(path);
        let buf = '';
        let over = false;
        let linked = false;
        const finish = (v) => {
            if (!over) {
                over = true;
                clearTimeout(timer);
                s.destroy();
                resolve(v === null && !linked ? undefined : v);
            }
        };
        const timer = setTimeout(() => finish(null), ms);
        s.setEncoding('utf8');
        s.on('connect', () => {
            linked = true;
            if (obj !== null) s.write(JSON.stringify(obj) + '\n');
        });
        s.on('data', (chunk) => {
            if (over) return;
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                let msg = null;
                try {
                    msg = JSON.parse(buf.slice(0, i));
                } catch (e) {
                    /* not ours */
                }
                buf = buf.slice(i + 1);
                if (msg && done(msg, s)) {
                    finish(msg);
                    return;
                }
            }
        });
        s.on('error', () => finish(null));
        s.on('close', () => finish(null));
    });
}

class ProfileSync extends EventEmitter {
    /* options: control (the page's WazeClusterControl), log, readProfile,
     * patchPath, renderPath, renderStatusPath, pollMs, replyMs, retryMs. Emits 'change' when
     * profile, own or canChooseOwn() may have changed. */
    constructor(options) {
        super();
        const o = options || {};
        this._control = o.control || null;
        this._log = o.log || { info() {}, warn() {} };
        this._read = o.readProfile;
        this._patchPath = o.patchPath || PATCH_PATH;
        this._renderPath = o.renderPath || RENDER_PATH;
        this._renderStatusPath = o.renderStatusPath || RENDER_STATUS_PATH;
        this._pollMs = o.pollMs || POLL_MS;
        this._replyMs = o.replyMs || REPLY_MS;
        this._retryMs = o.retryMs || RETRY_MS;
        /* the profile patchd has put in effect (NONE: none) and whether it
         * has its own settings; undefined and null until patchd has said */
        this.profile = undefined;
        this.own = null;
        this._askedOwn = null;      /* the checkbox as pressed, until patchd answers */
        this._seen = undefined;     /* the last read's id */
        this._confirmed = undefined; /* the profile that counts: two reads agreed, or NONE for good */
        this._differs = false;      /* the last read was another profile than the one that counts */
        this._retryAt = 0;
        this._priorityNeedsSave = false;
        this._chain = Promise.resolve();
        this._timer = null;
        this._stopped = true;
    }

    start() {
        if (this._stopped && this._read) {
            this._stopped = false;
            this._checkOutputs = true;
            this._startupRevision = this._control && this._control.outputRevision;
            this._poll();
        }
    }

    stop() {
        this._stopped = true;
        clearTimeout(this._timer);
        this._timer = null;
    }

    /* The checkbox acts while patchd has the profile that counts in effect
     * and no read names another. */
    canChooseOwn() {
        return typeof this.profile === 'string' && this.profile === this._confirmed && this.own !== null && !this._differs;
    }

    /* The checkbox's tick: as pressed until patchd answers, then patchd's. */
    ownShown() {
        return this._askedOwn !== null ? this._askedOwn : this.own === true;
    }

    setOwn(on) {
        if (!this.canChooseOwn() || this._askedOwn !== null || !!on === this.own) {
            return Promise.resolve();
        }
        this._askedOwn = !!on;
        this.emit('change');
        return this._ask({ cmd: 'profile-own', id: this.profile, on: on ? 1 : 0 });
    }

    mapWriteTarget() {
        if (this._stopped || !this.canChooseOwn() || this._askedOwn !== null) return null;
        return { profile: this.profile, own: Number(this.own) };
    }

    async confirmMapWrite(target) {
        try {
            const id = await this._read();
            const current = this.mapWriteTarget();
            return current && id === target.profile && current.profile === target.profile && current.own === target.own;
        } catch (e) {
            return false;
        }
    }

    /* A restarted patch daemon no longer knows which driver was selected. */
    invalidatePatchProfile() {
        if (this._stopped || (this.profile === undefined && this._retryAt === 0)) return;
        this.profile = undefined;
        this.own = null;
        this._retryAt = 0;
        this.emit('change');
    }

    /* Tells patchd the profile that counts again (the page opened): the
     * checkbox shows what patchd has. */
    refresh() {
        if (!this._stopped && this._confirmed !== undefined && Date.now() >= this._retryAt) {
            this._ask({ cmd: 'profile', id: this._confirmed });
        }
    }

    _poll() {
        Promise.resolve().then(async () => {
            if (!this._stockHudHasPriority()) await this._restoreOutputs();
            return this._read();
        }).then((id) => {
            const agreed = id === NONE || id === this._seen;
            this._seen = id === NONE ? undefined : id;
            const differs = !agreed && id !== this._confirmed;
            if (differs !== this._differs) {
                this._differs = differs;
                this.emit('change');
            }
            if (agreed) {
                this._confirmed = id;
                if ((id !== this.profile || this._checkOutputs || this._priorityNeedsSave) && Date.now() >= this._retryAt) {
                    return this._ask({ cmd: 'profile', id });
                }
            }
            return undefined;
        }, () => {
            /* nothing to go by: the profile that counts stays */
            this._seen = undefined;
        }).then(() => {
            if (!this._stopped) {
                this._timer = setTimeout(() => this._poll(), this._pollMs);
            }
        });
    }

    /* One command at a time; the reply sets profile and own and, when the
     * settings in effect changed, moves the render. */
    _ask(msg) {
        const run = () => {
            if (this._stopped) {
                this._askedOwn = null;
                return undefined;
            }
            const ev = `${msg.cmd}-reply`;
            return askOnce(this._patchPath, msg, (m) => m.ev === ev || (m.ev === 'refused' && m.cmd === msg.cmd), this._replyMs)
                .then(async (r) => {
                    if (this._stopped) return;
                    if (msg.cmd === 'profile-own') {
                        this._askedOwn = null;
                    }
                    if (r && r.ev === ev && r.ok) {
                        this._retryAt = 0;
                        this.profile = r.id;
                        this.own = r.own === true;
                        if (this._control) this._control.setProfileMapWrites(r.own_settings);
                        this._log.info(`driver profile: ${r.own ? 'its own' : 'the shared'} map settings${r.changed ? ', applied' : ''}`);
                        const settings = r.settings;
                        if (r.changed && settings) {
                            this._toRender(settings);
                        } else if ((this._checkOutputs || (settings && settings.hud_keep_shown === 1)) && msg.cmd === 'profile') {
                            this._checkOutputs = !(await this._restoreOutputs(settings));
                        }
                        if (!this._stopped && r.id === msg.id && settings) {
                            if (settings.hud_keep_shown === 1) {
                                const repair = { cmd: 'hud-keep-shown', on: 0, profile: r.id, own: Number(this.own) };
                                const saved = await askOnce(this._patchPath, repair, (m) => m.ev === 'hud-keep-shown-reply', this._replyMs);
                                this._priorityNeedsSave = !saved || !saved.ok || saved.hud_keep_shown !== 0;
                                if (this._priorityNeedsSave) {
                                    this._log.warn('patchd did not save BMW HUD pop-up priority; will retry');
                                    this._retryAt = Date.now() + this._retryMs;
                                }
                            } else {
                                this._priorityNeedsSave = false;
                            }
                        }
                    } else {
                        /* not taken: asked again (patchd not running: at the
                         * next read; not answered or refused: after
                         * RETRY_MS), the checkbox greyed meanwhile */
                        this._log.warn(`patchd did not take ${msg.cmd}: ${r === undefined ? 'not running' : (r && r.reason) || 'no answer'}`);
                        if (msg.cmd === 'profile') {
                            this.profile = undefined;
                            this.own = null;
                            this._retryAt = r === undefined ? 0 : Date.now() + this._retryMs;
                        } else if (r && this._confirmed !== undefined) {
                            /* refused (patchd has another profile in effect): what it has */
                            this._ask({ cmd: 'profile', id: this._confirmed });
                        }
                    }
                    this.emit('change');
                });
        };
        const p = this._chain.then(run, run);
        this._chain = p.catch(() => {});
        return p;
    }

    /* A fresh snapshot can confirm normal operation without claiming the
     * renderer's single control socket. Probe live after restart or if the
     * snapshot cannot confirm BMW's priority. */
    _stockHudHasPriority() {
        const control = this._control;
        if (control && control.render.connected()) {
            return !!control.renderStatus && control.renderStatus.hud_keep_shown === 0;
        }
        try {
            const age = Date.now() - fs.statSync(this._renderStatusPath).mtimeMs;
            if (age < 0 || age > RENDER_STATUS_MAX_AGE_MS) return false;
            const status = JSON.parse(fs.readFileSync(this._renderStatusPath, 'utf8'));
            return status.ev === 'status' && status.hud_keep_shown === 0;
        } catch (e) {
            return false;
        }
    }

    /* A missing settings argument checks only the priority flag. Saved
     * output choices are reconciled separately on startup or profile change. */
    async _restoreOutputs(settings) {
        const control = this._control;
        const outputsSuperseded = () => control && control.outputRevision !== this._startupRevision;
        const known = (s) => s && [s.cluster, s.hud].every((v) => v === 0 || v === 1);
        if (this._stopped) return true;
        const busy = (status) => status.ev === 'status' && status.state === 'error' && status.reason === 'busy';
        const order = settings && settings.hud && !settings.cluster ? ['hud', 'cluster'] : ['cluster', 'hud'];
        let sent = false;
        const reconcile = (status, send) => {
            if (this._stopped) return true;
            if (!status || status.ev !== 'status' || busy(status)) return false;
            const changes = !outputsSuperseded() && known(settings) && known(status)
                ? order.filter((display) => status[display] !== settings[display]) : [];
            const hudCoversStock = status.hud_keep_shown === 1;
            if (!changes.length && !hudCoversStock) return true;
            if (!sent) {
                sent = true;
                if (hudCoversStock) {
                    this._priorityNeedsSave = true;
                    this._log.info('navigation HUD was covering BMW pop-ups; restoring priority');
                    send({ cmd: 'hud', hud_keep_shown: '0' });
                }
                for (const display of changes) send({ cmd: display, on: String(settings[display]) });
            }
            return false; // wait for the renderer to report the requested state
        };
        if (control && control.render.connected()) {
            return reconcile(control.renderStatus, (cmd) => control.render.send(cmd));
        }
        // With the settings page closed, use the renderer's initial status.
        // If the page opens meanwhile, let its connection take over on the next poll.
        let pageOpened = false;
        const reply = await askOnce(this._renderPath, null, (status, socket) => {
            pageOpened = control && control.render.connected();
            return pageOpened || busy(status) || reconcile(status, (cmd) => socket.write(JSON.stringify(cmd) + '\n'));
        }, this._replyMs);
        return !!reply && !pageOpened && !busy(reply);
    }

    /* The render to the settings in effect: a display turned on first, so a
     * switch from one display to the other never passes through neither,
     * then the HUD's size and place. Let BMW's pop-ups take priority. */
    _toRender(s) {
        const cmds = renderMapSettings(s);
        const c = this._control;
        if (c && c.render && c.render.connected()) {
            cmds.forEach((m) => c.render.send(m));
            return;
        }
        /* the render down or owned by another: its next start reads the saved settings */
        const sock = net.connect(this._renderPath);
        const end = setTimeout(() => sock.destroy(), RENDER_HOLD_MS * 3);
        sock.on('connect', () => {
            cmds.forEach((m) => sock.write(JSON.stringify(m) + '\n'));
            setTimeout(() => sock.end(), RENDER_HOLD_MS);
        });
        sock.on('error', () => {});
        sock.on('close', () => clearTimeout(end));
    }
}

module.exports = { ProfileSync, sessionReader, IFACE, INSTANCE, FIELD, POLL_MS };
