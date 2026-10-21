/**
 * @name mini-player
 * @author gothmiku
 * @version 1.3.1
 * @description Mosaic mini player. The layout collapses automatically when the window gets small.
 * @license MIT
 * @homepage https://github.com/gothmiku/soundcloud-rpc-miniplayerplug
 */

// ─── Settings ────────────────────────────────────────────────────────────────
const CFG = {
    pluginId: 'mini_player',                     // filename without .js, dashes -> underscores
    breakpoint: { width: 560, height: 420 },     // below either value -> mini layout (content size, px)
    minWindow: { width: 300, height: 240 },      // lowest size the window may be dragged to while enabled
    alwaysOnTop: true,                           // float above other windows while the window is small
    topInset: 0,                                 // px left uncovered at the top (custom title bar buttons)
    speedPluginFile: 'playback-speed.js',        // if this file sits next to this one, a speed button is shown
};

// ─── Main process ───────────────────────────────────────────────────────────
// Lets the window shrink far enough for the mini layout, and keeps it floating while small.
const tracked = new Map();
let createdHandler = null;

function getElectron() {
    try {
        const e = require('electron');
        return e && e.BrowserWindow ? e : null;
    } catch (err) {
        return null;
    }
}

function isSmall(win) {
    const [w, h] = win.getContentSize();
    return w < CFG.breakpoint.width || h < CFG.breakpoint.height;
}

function syncFloat(rec) {
    if (!CFG.alwaysOnTop || rec.win.isDestroyed() || rec.win.isMinimized()) return; // minimised windows report odd sizes
    const small = isSmall(rec.win);
    if (small === rec.floating) return;
    rec.floating = small;
    if (small) rec.win.setAlwaysOnTop(true, 'floating');
    else rec.win.setAlwaysOnTop(rec.savedTop);
}

function attach(win) {
    if (!win || win.isDestroyed() || tracked.has(win)) return;
    const rec = {
        win,
        floating: false,
        savedTop: win.isAlwaysOnTop(),
        originalMin: win.getMinimumSize(),
    };
    rec.onResize = () => syncFloat(rec);
    // After a minimise / restore Chromium can leave a window showing stale or empty content: ask for a full repaint.
    rec.onRestore = () => {
        syncFloat(rec);
        try { if (!win.isDestroyed()) win.webContents.invalidate(); } catch (err) { /* ignore */ }
    };
    win.on('resize', rec.onResize);
    win.on('restore', rec.onRestore);
    win.on('show', rec.onRestore);
    win.once('closed', () => tracked.delete(win));
    win.setMinimumSize(CFG.minWindow.width, CFG.minWindow.height);
    tracked.set(win, rec);
    syncFloat(rec);
}

function detachAll(electron) {
    for (const rec of tracked.values()) {
        const win = rec.win;
        if (win.isDestroyed()) continue;
        win.removeListener('resize', rec.onResize);
        win.removeListener('restore', rec.onRestore);
        win.removeListener('show', rec.onRestore);
        if (rec.floating) win.setAlwaysOnTop(rec.savedTop);
        win.setMinimumSize(rec.originalMin[0], rec.originalMin[1]);
    }
    tracked.clear();
    if (createdHandler && electron && electron.app) {
        electron.app.removeListener('browser-window-created', createdHandler);
    }
    createdHandler = null;
}

// Is the Playback Speed plugin sitting in the same folder as this file?
// true / false, or null when the folder can't be inspected from here.
function detectSpeedPlugin() {
    try {
        if (typeof __dirname !== 'string') return null;
        return require('fs').existsSync(require('path').join(__dirname, CFG.speedPluginFile));
    } catch (err) {
        return null;
    }
}

// ─── Page: runs inside the SoundCloud page ──────────────────────────────────
// Written as a real function (so there is no escaping of backticks) and stringified
// by contentScript(). It must not reference anything outside its own body.
function pageScript(cfg) {
    'use strict';
    if (window.__miniPlayerLoaded) return;
    window.__miniPlayerLoaded = true;

    const ROOT_ID = 'scmp-root';
    const STYLE_ID = 'scmp-style';
    const PENDING_KEY = 'scmp-pending-play';
    const API_HOST = 'api-v2.soundcloud.com';
    const DEFAULT_PALETTE = ['rgb(255, 85, 0)', 'rgb(110, 60, 190)'];
    const REVEAL_REACH = 140; // px from the cursor within which a surface's edge starts to glow
    const $ = (sel, scope) => (scope || document).querySelector(sel);

    // ── Session sniffing (used only to list your playlists) ─────────────────
    const auth = { clientId: null, header: null };
    const grabClientId = (url) => {
        const m = /[?&]client_id=(\w+)/.exec(url || '');
        if (m) auth.clientId = m[1];
    };
    const realFetch = window.fetch;
    const realOpen = XMLHttpRequest.prototype.open;
    const realSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    function patchedFetch(input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
            if (url.indexOf(API_HOST) > -1) {
                grabClientId(url);
                const h = (init && init.headers) || (input && input.headers);
                const a = h && (typeof h.get === 'function' ? h.get('Authorization') : h.Authorization || h.authorization);
                if (a) auth.header = a;
            }
        } catch (e) { /* never break the page */ }
        return realFetch.apply(this, arguments);
    }
    function patchedOpen(method, url) {
        try {
            this.__scmpApi = String(url).indexOf(API_HOST) > -1;
            if (this.__scmpApi) grabClientId(String(url));
        } catch (e) { /* ignore */ }
        return realOpen.apply(this, arguments);
    }
    function patchedSetHeader(k, v) {
        try {
            if (this.__scmpApi && /^authorization$/i.test(k) && v) auth.header = v;
        } catch (e) { /* ignore */ }
        return realSetHeader.apply(this, arguments);
    }
    window.fetch = patchedFetch;
    XMLHttpRequest.prototype.open = patchedOpen;
    XMLHttpRequest.prototype.setRequestHeader = patchedSetHeader;

    let perfObs = null;
    try {
        perfObs = new PerformanceObserver((list) => {
            list.getEntries().forEach((e) => { if (e.name.indexOf(API_HOST) > -1) grabClientId(e.name); });
        });
        perfObs.observe({ type: 'resource', buffered: true });
    } catch (e) { /* not available */ }

    const cookieAuth = () => {
        const m = /(?:^|;\s*)oauth_token=([^;]+)/.exec(document.cookie);
        return m ? 'OAuth ' + decodeURIComponent(m[1]) : null;
    };

    async function api(path, params) {
        const header = auth.header || cookieAuth();
        if (!auth.clientId || !header) throw new Error('no-session');
        const qs = new URLSearchParams(Object.assign({ client_id: auth.clientId }, params));
        const res = await realFetch.call(window, `https://${API_HOST}${path}?${qs}`, { headers: { Authorization: header } });
        if (!res.ok) throw new Error('http-' + res.status);
        return res.json();
    }

    const toPlaylists = (data) =>
        (Array.isArray(data) ? data : (data && data.collection) || [])
            .map((i) => (i && (i.playlist || i)) || null)
            .filter((p) => p && p.permalink_url && p.title)
            .map((p) => ({
                title: p.title,
                url: p.permalink_url,
                count: p.track_count,
                art: p.artwork_url || (p.tracks && p.tracks[0] && p.tracks[0].artwork_url) || null,
            }));

    async function fetchPlaylists() {
        const attempts = [
            () => api('/me/playlists/liked_and_owned', { limit: 100 }),
            async () => {
                const me = await api('/me');
                return api(`/users/${me.id}/playlists_without_albums`, { limit: 100 });
            },
        ];
        let lastErr = null;
        for (const run of attempts) {
            try {
                const items = toPlaylists(await run());
                if (items.length) return items;
            } catch (e) { lastErr = e; }
        }
        if (lastErr) throw lastErr;
        return [];
    }

    // ── Volume: the knob drives the page's real <audio> element(s) ──────────
    // SoundCloud's audio elements are usually created in script and never attached to the page, so
    // they are picked up when they start playing. While the mini player is showing and the knob
    // has been touched, the knob wins if SoundCloud resets the volume (e.g. on a new track).
    const media = new Set();
    let volume = 1;
    let lastVolume = 1;
    let volumeOwned = false;
    let dragging = null;
    let flashTimer = null;
    const realPlay = HTMLMediaElement.prototype.play;
    const ARC = 89.54, CIRC = 119.38; // 270° sweep of the knob ring (r = 19)

    function paintKnob() {
        const v = Math.max(0, Math.min(1, volume));
        const pct = Math.round(v * 100);
        els.knobArc.style.strokeDasharray = (ARC * v).toFixed(2) + ' ' + CIRC;
        els.knobArc.style.opacity = v > 0.005 ? '1' : '0';
        els.knobCap.style.setProperty('--deg', (-135 + 270 * v).toFixed(1) + 'deg');
        els.knobVal.textContent = pct;
        els.knob.setAttribute('aria-valuenow', String(pct));
    }
    function flashKnob() {
        els.knob.classList.add('show');
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => { if (!dragging) els.knob.classList.remove('show'); }, 900);
    }
    function readScVolume() {
        const s = $('.volume__sliderWrapper');
        if (!s) return null;
        const now = parseFloat(s.getAttribute('aria-valuenow'));
        const max = parseFloat(s.getAttribute('aria-valuemax')) || 1;
        return isFinite(now) ? Math.max(0, Math.min(1, now / max)) : null;
    }
    // Last resort when no audio element has been seen yet: click SoundCloud's own (vertical) slider.
    function sliderSync(v) {
        const wrap = $('.volume__sliderWrapper');
        if (!wrap) return;
        const r = wrap.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height * (1 - v) };
        wrap.dispatchEvent(new MouseEvent('mousedown', opts));
        document.dispatchEvent(new MouseEvent('mouseup', opts));
    }
    function pushVolume(el) {
        try {
            el.volume = volume;
            if (volume > 0 && el.muted) el.muted = false;
        } catch (e) { /* ignore */ }
    }
    function setVolume(v) {
        volume = Math.max(0, Math.min(1, v));
        if (volume > 0) lastVolume = volume;
        volumeOwned = true;
        paintKnob();
        flashKnob();
        if (media.size) media.forEach(pushVolume);
        else sliderSync(volume);
    }
    function adoptVolume() {
        let v = null;
        media.forEach((el) => { v = el.volume; }); // the most recently seen element wins
        if (v === null) v = readScVolume();
        if (v !== null) { volume = v; if (v > 0) lastVolume = v; }
        paintKnob();
    }
    function onMediaVolume(e) {
        const el = e.target;
        if (Math.abs(el.volume - volume) < 0.005) return;
        if (volumeOwned && active) pushVolume(el); // mini mode: the knob is in charge
        else { volume = el.volume; if (volume > 0) lastVolume = volume; paintKnob(); } // otherwise follow SoundCloud
    }
    function trackMedia(el) {
        if (!(el instanceof HTMLMediaElement) || media.has(el)) return;
        media.add(el);
        if (media.size > 8) {
            const old = media.values().next().value;
            old.removeEventListener('volumechange', onMediaVolume);
            media.delete(old);
        }
        el.addEventListener('volumechange', onMediaVolume);
        if (volumeOwned && active) pushVolume(el);
        else if (!volumeOwned) { volume = el.volume; paintKnob(); }
    }
    let disposed = false;
    function patchedPlay() {
        try { if (!disposed) trackMedia(this); } catch (e) { /* never break playback */ }
        return realPlay.apply(this, arguments);
    }
    HTMLMediaElement.prototype.play = patchedPlay;
    // SoundCloud reads currentTime constantly to draw its own timeline, so hooking that getter finds the
    // audio element even when the plugin is switched on in the middle of a song.
    const timeProto = HTMLMediaElement.prototype;
    const timeDesc = Object.getOwnPropertyDescriptor(timeProto, 'currentTime');
    let patchedTimeGet = null;
    if (timeDesc && timeDesc.get && timeDesc.configurable) {
        patchedTimeGet = function () {
            try { if (!disposed) trackMedia(this); } catch (e) { /* ignore */ }
            return timeDesc.get.call(this);
        };
        try {
            Object.defineProperty(timeProto, 'currentTime', Object.assign({}, timeDesc, { get: patchedTimeGet }));
        } catch (e) { patchedTimeGet = null; }
    }

    // ── Seeking ─────────────────────────────────────────────────────────────
    const fmtTime = (sec) => {
        const t = Math.max(0, Math.round(sec) || 0);
        const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = t % 60;
        const two = (n) => String(n).padStart(2, '0');
        return h ? `${h}:${two(m)}:${two(ss)}` : `${m}:${two(ss)}`;
    };
    // The element that is actually playing (SoundCloud may also keep a preloading one around).
    function activeMedia() {
        let best = null;
        media.forEach((el) => {
            const usable = isFinite(el.duration) && el.duration > 0;
            if (!el.paused) best = el;
            else if (usable && !(best && !best.paused)) best = el;
        });
        return best;
    }
    function getDuration() {
        const m = activeMedia();
        if (m && isFinite(m.duration) && m.duration > 0) return m.duration;
        return toSec(cur.total);
    }
    // Fallback when no audio element has been captured: click SoundCloud's own timeline.
    function timelineClick(ratio) {
        const bar = $('.playbackTimeline__progressWrapper');
        if (!bar) return;
        const r = bar.getBoundingClientRect();
        if (!r.width) return;
        const opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width * ratio, clientY: r.top + r.height / 2 };
        bar.dispatchEvent(new MouseEvent('mousedown', opts));
        document.dispatchEvent(new MouseEvent('mouseup', opts));
        bar.dispatchEvent(new MouseEvent('click', opts));
    }
    let holdProgressUntil = 0; // keep our own position on screen briefly so the bar doesn't jump back
    function seekToSeconds(sec) {
        const dur = getDuration();
        if (!dur) return;
        sec = Math.max(0, Math.min(dur, sec));
        const m = activeMedia();
        if (m) { try { m.currentTime = sec; } catch (e) { /* ignore */ } }
        else timelineClick(sec / dur);
        holdProgressUntil = Date.now() + 800;
        els.fill.style.width = (sec / dur * 100).toFixed(1) + '%';
        els.cur.textContent = fmtTime(sec);
    }
    function seekBy(dt) {
        const m = activeMedia();
        seekToSeconds((m ? m.currentTime : toSec(cur.passed)) + dt);
    }

    // ── Reading the real player ─────────────────────────────────────────────
    const toSec = (s) => (s || '').trim().split(':').reduce((a, n) => a * 60 + (parseInt(n, 10) || 0), 0);

    function readTrack() {
        const titleEl = $('.playbackSoundBadge__titleLink');
        const authorEl = $('.playbackSoundBadge__lightLink');
        const artEl = $('.playbackSoundBadge__avatar [style*="background-image"]');
        const playBtn = $('.playControls__play');
        const passedEl = $('.playbackTimeline__timePassed span[aria-hidden="true"]');
        const totalEl = $('.playbackTimeline__duration span[aria-hidden="true"]');
        const bar = $('.playbackTimeline__progressWrapper');

        let art = null;
        if (artEl) {
            const m = /url\(["']?([^"')]+)["']?\)/.exec(artEl.style.backgroundImage || '');
            if (m) art = m[1].replace(/-t\d+x\d+\./, '-t500x500.');
        }
        const passed = passedEl ? passedEl.textContent.trim() : '0:00';
        const total = totalEl ? totalEl.textContent.trim() : '0:00';
        let pct = 0;
        const now = bar && parseFloat(bar.getAttribute('aria-valuenow'));
        const max = bar && parseFloat(bar.getAttribute('aria-valuemax'));
        if (now >= 0 && max > 0) pct = (now / max) * 100;
        else if (toSec(total) > 0) pct = (toSec(passed) / toSec(total)) * 100;

        return {
            title: titleEl ? titleEl.getAttribute('title') || titleEl.textContent.trim() : '',
            author: authorEl ? authorEl.textContent.trim() : '',
            art,
            playing: !!playBtn && (playBtn.classList.contains('playing') || /pause/i.test(playBtn.title || '')),
            passed,
            total,
            pct: Math.max(0, Math.min(100, Math.round(pct * 10) / 10)),
            liked: readLiked(),
        };
    }

    // SoundCloud's own like button (in its player bar). null = there is none, so there is nothing to like.
    const LIKE_BTN = '.playbackSoundBadge__like';
    function readLiked() {
        const el = $(LIKE_BTN);
        if (!el) return null;
        const label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
        return el.classList.contains('sc-button-selected') || el.getAttribute('aria-pressed') === 'true' || /\bunlike\b/i.test(label);
    }

    const clickSC = (sel) => { const el = $(sel); if (el) el.click(); };

    // ── Accent colour from the artwork ──────────────────────────────────────
    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        let h = 0, s = 0;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h /= 6;
        }
        return [h, s, l];
    }
    function hslToRgb(h, s, l) {
        if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        const f = (t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
    }
    // Keep colours rich but dark enough that white text stays readable on top of them.
    function tune(rgb, lo, hi) {
        let [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
        if (s > 0.12) s = Math.min(0.9, Math.max(0.45, s));
        l = Math.min(hi, Math.max(lo, l));
        const [r, g, b] = hslToRgb(h, s, l);
        return `rgb(${r}, ${g}, ${b})`;
    }
    function paletteFromImage(img) {
        const S = 48;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = S;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, S, S);
        const px = ctx.getImageData(0, 0, S, S).data; // throws when the canvas is tainted (no CORS)
        const BINS = 12;
        const bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
        let ar = 0, ag = 0, ab = 0, n = 0;
        for (let i = 0; i < px.length; i += 4) {
            if (px[i + 3] < 200) continue;
            const r = px[i], g = px[i + 1], b = px[i + 2];
            ar += r; ag += g; ab += b; n++;
            const [h, s, l] = rgbToHsl(r, g, b);
            const w = s * s * (1 - Math.abs(2 * l - 1)); // vivid, mid-lightness pixels count most
            if (w < 0.02) continue;
            const bin = bins[Math.min(BINS - 1, Math.floor(h * BINS))];
            bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
        }
        if (!n) return null;
        const ranked = bins.map((b, i) => Object.assign({ i }, b)).filter((b) => b.w > 0).sort((x, y) => y.w - x.w);
        const avg = (b) => [b.r / b.w, b.g / b.w, b.b / b.w];
        if (!ranked.length) { // greyscale artwork
            const grey = [ar / n, ag / n, ab / n];
            return [tune(grey, 0.3, 0.5), tune(grey, 0.2, 0.35)];
        }
        const first = ranked[0];
        const second = ranked.find((b) => {
            const d = Math.abs(b.i - first.i);
            return Math.min(d, BINS - d) >= 2 && b.w >= first.w * 0.25;
        });
        const primary = avg(first);
        let secondary;
        if (second) secondary = avg(second);
        else {
            const [h, s, l] = rgbToHsl(primary[0], primary[1], primary[2]);
            secondary = hslToRgb((h + 0.08) % 1, s, l);
        }
        return [tune(primary, 0.34, 0.52), tune(secondary, 0.28, 0.44)];
    }
    // Used when the artwork can't be read (cross-origin) so each track still gets its own colour.
    function hashPalette(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
        const h = (hash % 360) / 360;
        const a = hslToRgb(h, 0.7, 0.45), b = hslToRgb((h + 0.12) % 1, 0.65, 0.34);
        return [`rgb(${a.join(', ')})`, `rgb(${b.join(', ')})`];
    }

    // The card: the primary accent, dark enough for white controls, and a bit see-through so the background shows through.
    const CARD_ALPHA = 0.86;
    function cardTone(pal) {
        const [h, s] = rgbToHsl.apply(null, pxParse(pal[0]));
        const c = hslToRgb(h, s > 0.12 ? Math.min(0.72, Math.max(0.4, s * 0.85)) : s, 0.2);
        return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${CARD_ALPHA})`;
    }

    // ── Pixel background ────────────────────────────────────────────────────
    // The artwork is flattened to a luminance map, cut into rectangular blocks (big where the
    // art is flat, small where it is busy), and each block is painted from a four-tone ramp
    // built from the artwork's accent colours: ink → deep accent → accent → pale tint.
    // Tones that sit between two steps become a crosshatch of both. White halftone dots drift
    // over the top. Everything is drawn on one canvas; only the dots move once a track has loaded.
    const PX_BREAKS = [0.15, 0.36, 0.76]; // (equalised) luminance where the ramp steps up
    const PX_HATCH = 0.045;               // half-width of the crosshatch band around each step
    const PX_REVEAL_MS = 1100;            // blocks pop in from the top-left on every track change
    const PX_TICK_MS = 125;               // dot animation step while playing (8 fps, deliberately chunky)
    const PX_IDLE_MS = 450;               // ... and while paused

    function pxHash(x, y, s) {
        let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2246822519)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }
    function pxSeed(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
        return h | 0;
    }
    const pxParse = (css) => (/(\d+)\D+(\d+)\D+(\d+)/.exec(css) || [0, 0, 0, 0]).slice(1, 4).map(Number);
    const pxCss = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

    // A field is a square grid of 0..1 values, sampled with bilinear filtering.
    function pxSample(f, u, v) {
        const n = f.n;
        const x = Math.min(n - 1.001, Math.max(0, u * (n - 1))), y = Math.min(n - 1.001, Math.max(0, v * (n - 1)));
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * n + x0;
        const top = f.d[i] + (f.d[i + 1] - f.d[i]) * fx;
        const bot = f.d[i + n] + (f.d[i + n + 1] - f.d[i + n]) * fx;
        return top + (bot - top) * fy;
    }
    // Same, but coordinates mirror at the edges so a drifting sample window never hits a seam.
    const pxMirror = (x) => 1 - Math.abs((((x % 2) + 2) % 2) - 1);
    const pxSampleR = (f, u, v) => pxSample(f, pxMirror(u), pxMirror(v));

    function pxNoise(seed, n, base) {
        const d = new Float32Array(n * n);
        let amp = 1, freq = base;
        for (let o = 0; o < 3; o++, amp *= 0.5, freq *= 2) {
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) {
                    const gx = (x / (n - 1)) * freq, gy = (y / (n - 1)) * freq;
                    const x0 = Math.floor(gx), y0 = Math.floor(gy);
                    let fx = gx - x0, fy = gy - y0;
                    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
                    const a = pxHash(x0, y0, seed + o), b = pxHash(x0 + 1, y0, seed + o);
                    const c = pxHash(x0, y0 + 1, seed + o), e = pxHash(x0 + 1, y0 + 1, seed + o);
                    d[y * n + x] += amp * (a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy);
                }
            }
        }
        return pxStretch({ n, d }, 0.02, 0.98);
    }
    // Rescale so the chosen percentiles land on 0 and 1: every cover then uses the full ramp.
    function pxStretch(f, loP, hiP) {
        const s = Float32Array.from(f.d).sort();
        const lo = s[Math.floor(loP * (s.length - 1))], hi = s[Math.floor(hiP * (s.length - 1))];
        const span = Math.max(1e-4, hi - lo);
        for (let i = 0; i < f.d.length; i++) f.d[i] = Math.min(1, Math.max(0, (f.d[i] - lo) / span));
        f.range = hi - lo;
        return f;
    }
    // Histogram equalisation (blended with the original): whatever the cover's brightness, every tone
    // of the ramp gets a similar share of the area. Flat regions stay flat, they don't turn into noise.
    function pxEqualize(f, mix) {
        const B = 64, n = f.d.length, hist = new Float32Array(B), cdf = new Float32Array(B + 1), d = new Float32Array(n);
        for (let i = 0; i < n; i++) hist[Math.min(B - 1, (f.d[i] * B) | 0)]++;
        for (let i = 0; i < B; i++) cdf[i + 1] = cdf[i] + hist[i] / n;
        for (let i = 0; i < n; i++) {
            const p = Math.min(B - 1e-6, f.d[i] * B), b = p | 0;
            d[i] = mix * (cdf[b] + (cdf[b + 1] - cdf[b]) * (p - b)) + (1 - mix) * f.d[i];
        }
        return { n: f.n, d, range: f.range };
    }
    function pxBlur(f, r, passes) {
        const n = f.n;
        let src = f.d, dst = new Float32Array(n * n);
        for (let p = 0; p < passes; p++) {
            for (let y = 0; y < n; y++) { // horizontal
                for (let x = 0; x < n; x++) {
                    let sum = 0, k = 0;
                    for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < n) { sum += src[y * n + xx]; k++; } }
                    dst[y * n + x] = sum / k;
                }
            }
            src = dst; dst = new Float32Array(n * n);
            for (let y = 0; y < n; y++) { // vertical
                for (let x = 0; x < n; x++) {
                    let sum = 0, k = 0;
                    for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy >= 0 && yy < n) { sum += src[yy * n + x]; k++; } }
                    dst[y * n + x] = sum / k;
                }
            }
            src = dst; dst = new Float32Array(n * n);
        }
        return { n, d: src };
    }
    // Luminance of the artwork on a 64×64 grid (centre-cropped to a square). Throws if the canvas is tainted.
    function lumaGrid(img) {
        const N = 64;
        const c = document.createElement('canvas');
        c.width = c.height = N;
        const g = c.getContext('2d', { willReadFrequently: true });
        const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height, side = Math.min(sw, sh);
        g.drawImage(img, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, N, N);
        const px = g.getImageData(0, 0, N, N).data;
        const d = new Float32Array(N * N);
        for (let i = 0; i < d.length; i++) d[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
        return pxStretch({ n: N, d }, 0.04, 0.96);
    }

    // Shared by the background and the cover-art mosaic, so both are cut from the same cloth.
    function pxHatchTile(base, line, p, lw) { // p×p tile: `base` with hard-edged diagonal lines of `line`
        const t = document.createElement('canvas');
        t.width = t.height = p;
        const g = t.getContext('2d');
        g.fillStyle = pxCss(base); g.fillRect(0, 0, p, p);
        g.fillStyle = pxCss(line);
        for (let y = 0; y < p; y++) {
            for (let x = 0; x < p; x++) {
                if ((x + y) % p < lw || (((x - y) % p) + p) % p < lw) g.fillRect(x, y, 1, 1);
            }
        }
        return t;
    }
    function buildRamp(pal) { // ink → deep accent → accent → pale tint
        const a = pxParse(pal[0]), b = pxParse(pal[1]);
        const [h, sat, l] = rgbToHsl(a[0], a[1], a[2]);
        const ink = hslToRgb(h, Math.min(sat, 0.5) * 0.25, 0.08);
        const deepA = hslToRgb(h, Math.min(1, sat * 0.95), l * 0.62);
        const deep = deepA.map((v, i) => Math.round(v + (b[i] - v) * 0.35)); // a hint of the secondary accent
        const pale = hslToRgb(h, Math.min(0.3, sat * 0.3), 0.82);
        return [ink, deep, a, pale];
    }
    // Which ramp tone a (equalised) luminance maps to: 0..3 = flat tone, 4..9 = crosshatch between two tones.
    function classify(v) {
        for (let i = 0; i < 3; i++) {
            if (v < PX_BREAKS[i] - PX_HATCH) return i;
            if (v < PX_BREAKS[i] + PX_HATCH) return 4 + i * 2 + (v < PX_BREAKS[i] ? 0 : 1);
        }
        return 3;
    }

    function createPixelBg(canvas, host, isPlaying, reduceMotion) {
        const ctx = canvas.getContext && canvas.getContext('2d', { alpha: false });
        if (!ctx) return { show() {}, wake() {}, destroy() {} }; // no 2D canvas: leave the plain backdrop
        const stage = document.createElement('canvas'); // what the mosaic currently looks like
        const sg = stage.getContext('2d', { alpha: false });
        const t0 = performance.now();
        let W = 0, H = 0, dpr = 1, cs = 12, cols = 0, rows = 0;
        let state = null, needLayout = false, wantReveal = false;
        let leaves = [], order = [], ptr = 0, revealing = false, revealStart = 0;
        let raf = 0, timer = 0, destroyed = false, ro = null;

        const visible = () => !destroyed && !document.hidden && host.classList.contains('scmp-on');

        // ── palette → ramp + crosshatch tiles ───────────────────────────────
        const makeHatch = (base, line, p, lw) => sg.createPattern(pxHatchTile(base, line, p, lw), 'repeat');
        function buildPatterns(ramp) {
            const lw = Math.max(1, Math.round(dpr)), p = Math.round(5 * dpr);
            const out = [];
            for (let i = 0; i < 3; i++) out.push(makeHatch(ramp[i], ramp[i + 1], p, lw), makeHatch(ramp[i + 1], ramp[i], p, lw));
            return out; // [i*2] = tier i with lines of tier i+1, [i*2+1] = tier i+1 with lines of tier i
        }

        // ── sizing ──────────────────────────────────────────────────────────
        function ensureSize() {
            const w = host.clientWidth, h = host.clientHeight;
            if (!w || !h) return false;
            const d = Math.min(2, window.devicePixelRatio || 1);
            if (w === W && h === H && d === dpr) return true;
            W = w; H = h; dpr = d;
            canvas.width = stage.width = Math.round(W * dpr);
            canvas.height = stage.height = Math.round(H * dpr);
            cs = Math.round(Math.min(22, Math.max(10, Math.round(Math.min(W, H) / 26))) * dpr);
            cols = Math.ceil(canvas.width / cs);
            rows = Math.ceil(canvas.height / cs);
            if (state) {
                state.patterns = buildPatterns(state.ramp);
                sg.fillStyle = state.rampCss[0]; sg.fillRect(0, 0, stage.width, stage.height);
            }
            needLayout = true;
            return true;
        }

        // ── blocks ──────────────────────────────────────────────────────────
        function paintLeaf(L) {
            const x = L.c * cs, y = L.r * cs;
            sg.fillStyle = L.code < 4 ? state.rampCss[L.code] : state.patterns[L.code - 4];
            sg.fillRect(x, y, L.w * cs, L.h * cs);
        }
        function layout(animate) {
            needLayout = false;
            if (revealing) { while (ptr < order.length) paintLeaf(order[ptr++]); revealing = false; }
            const S = Math.max(canvas.width, canvas.height), ox = (canvas.width - S) / 2, oy = (canvas.height - S) / 2;
            const stride = cols + 1;
            const sum = new Float64Array(stride * (rows + 1)), sq = new Float64Array(stride * (rows + 1));
            const val = new Float32Array(cols * rows);
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const u = ((c + 0.5) * cs - ox) / S, v = ((r + 0.5) * cs - oy) / S;
                    const x = pxSample(state.art, u, v) + (pxHash(c, r, state.seed) - 0.5) * 0.07; // a little grain between neighbours
                    val[r * cols + c] = x;
                    const i = (r + 1) * stride + c + 1;
                    sum[i] = x + sum[i - 1] + sum[i - stride] - sum[i - stride - 1];
                    sq[i] = x * x + sq[i - 1] + sq[i - stride] - sq[i - stride - 1];
                }
            }
            const area = (t, c, r, w, h) => t[(r + h) * stride + c + w] - t[r * stride + c + w] - t[(r + h) * stride + c] + t[r * stride + c];
            leaves = [];
            (function split(c, r, w, h) {
                const n = w * h, mean = area(sum, c, r, w, h) / n, variance = area(sq, c, r, w, h) / n - mean * mean;
                if (n === 1 || (n <= 48 && variance < 0.0042)) {
                    leaves.push({ c, r, w, h, code: classify(mean), d: ((c / cols) * 0.5 + (r / rows) * 0.5) * 0.68 + pxHash(c, r, 7) * 0.32 });
                } else if (w >= h && w > 1) {
                    const hw = w >> 1;
                    split(c, r, hw, h); split(c + hw, r, w - hw, h);
                } else {
                    const hh = h >> 1;
                    split(c, r, w, hh); split(c, r + hh, w, h - hh);
                }
            })(0, 0, cols, rows);
            order = leaves.slice().sort((a, b) => a.d - b.d);
            ptr = 0;
            if (animate) {
                revealing = true;
                revealStart = performance.now();
            } else {
                for (const L of order) paintLeaf(L);
                ptr = order.length;
            }
        }

        // ── dots ────────────────────────────────────────────────────────────
        function drawDots(now, revealP) {
            const cw = canvas.width, ch = canvas.height;
            const dp = Math.max(5, Math.round(cs / 2)), ds = Math.max(2, Math.round(dp * 0.46));
            const ti = Math.floor((now - t0) / PX_TICK_MS), t = ti * (PX_TICK_MS / 1000);
            const S = Math.max(cw, ch), ex = (cw - S) / 2, ey = (ch - S) / 2;
            const du = t * 0.018, dv = Math.sin(t * 0.23) * 0.02 + t * 0.006;
            const alpha = (isPlaying() ? 0.92 : 0.55) * Math.min(1, revealP * 1.6);
            if (alpha <= 0.01) return;
            const thr = state.thr, soft = state.soft, nz = state.noise, sd = state.seed;
            ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
            ctx.beginPath();
            for (let j = 0, y = 0; y < ch; j++, y = j * dp) {
                for (let i = 0, x = 0; x < cw; i++, x = i * dp) {
                    const u = (x - ex) / S + du, v = (y - ey) / S + dv;
                    const f = 0.6 * pxSampleR(soft, u, v) + 0.4 * pxSampleR(nz, u * 1.3 + 0.17, v * 1.3);
                    if (f > thr || (f > thr - 0.05 && pxHash(i, j, ti ^ sd) < 0.35)) ctx.rect(x, y, ds, ds); // edge pixels flicker
                }
            }
            ctx.fill();
        }
        function composite(now) {
            if (revealing) {
                const p = Math.min(1, (now - revealStart) / PX_REVEAL_MS);
                while (ptr < order.length && order[ptr].d <= p) paintLeaf(order[ptr++]);
                if (p >= 1) { while (ptr < order.length) paintLeaf(order[ptr++]); revealing = false; }
            }
            ctx.drawImage(stage, 0, 0);
            drawDots(now, revealing ? Math.min(1, (now - revealStart) / PX_REVEAL_MS) : 1);
        }

        // ── loop ────────────────────────────────────────────────────────────
        function schedule() {
            cancelAnimationFrame(raf); clearTimeout(timer);
            if (!visible() || !state) return;
            if (revealing) raf = requestAnimationFrame(loop);
            else if (!reduceMotion()) timer = setTimeout(loop, isPlaying() ? PX_TICK_MS : PX_IDLE_MS);
        }
        function loop() {
            if (!visible()) return;
            if (ensureSize() && needLayout) layout(false);
            composite(performance.now());
            schedule();
        }
        function wake() {
            if (!state || !visible() || !ensureSize()) return;
            if (needLayout) {
                layout(wantReveal && !reduceMotion());
                wantReveal = false;
            }
            composite(performance.now());
            schedule();
        }

        if (typeof ResizeObserver === 'function') {
            ro = new ResizeObserver(() => { if (state && visible()) wake(); });
            ro.observe(host);
        }

        return {
            // grid: luminance field of the artwork (or null if it can't be read); seed: stable string for the fallback pattern.
            show(pal, grid, seed) {
                const sd = pxSeed(seed || 'idle');
                const noise = pxNoise(sd, 32, 4);
                let art = grid;
                if (!art) art = pxNoise(sd + 101, 64, 3.2);
                else if (art.range < 0.12) { // (nearly) flat artwork: fade to a soft procedural texture, otherwise stretched noise shows up as speckle
                    const w = Math.max(0, (art.range - 0.04) / 0.08), tex = pxNoise(sd + 101, art.n, 3.2);
                    art = { n: art.n, d: Float32Array.from(art.d, (x, i) => w * x + (1 - w) * tex.d[i]), range: art.range };
                }
                art = pxEqualize(art, 0.7);
                const soft = pxBlur(art, 3, 2);
                const probe = [];
                for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) probe.push(0.6 * pxSampleR(soft, x / 39, y / 39) + 0.4 * pxSampleR(noise, (x / 39) * 1.3 + 0.17, (y / 39) * 1.3));
                probe.sort((p, q) => p - q);
                const ramp = buildRamp(pal);
                state = {
                    seed: sd, art, soft, noise, ramp, rampCss: ramp.map(pxCss),
                    patterns: [], thr: probe[Math.floor(probe.length * 0.88)], // dots cover roughly the top 12%
                };
                if (W) state.patterns = buildPatterns(ramp);
                needLayout = true;
                wantReveal = true;
                wake();
            },
            wake,
            destroy() {
                destroyed = true;
                cancelAnimationFrame(raf); clearTimeout(timer);
                if (ro) ro.disconnect();
            },
        };
    }
    // ── end pixel background ────────────────────────────────────────────────

    // ── Cover-art tiles ─────────────────────────────────────────────────────
    // The whole artwork area is ONE canvas (the <img> is only the pixel source), so there is no seam between "image" and "tiles"
    // anywhere: the cover is painted once, and only the SEAM at its lower edge moves. The seam is a band of tiles, cut like the
    // background (hard-edged blocks, the same ramp and crosshatch): next to the artwork nearly every tile is a piece of the
    // cover, further down they turn into accent tiles and gaps, and they keep re-rolling slowly while music plays, until only
    // the card is left.
    // The same tiles do the track-change transition. The canvas still holds the old cover, so play() just paints the new one on
    // top of it, a wave sweeping in from the left. Every tile first shows the new cover, an accent tile, or nothing at all (the old
    // cover stays visible there), and then settles into what the seam shows at that spot. When the last tile has settled, no pixel
    // of the old cover is left.
    const AM_WAVE_MS = 520;                         // how long the wave takes to cross the cover
    const AM_HOLD_MIN = 100, AM_HOLD_RANGE = 240;   // accent / see-through tiles settle after HOLD_MIN .. HOLD_MIN + HOLD_RANGE ms
    const AM_SHARE_COVER = 0.42, AM_SHARE_ACCENT = 0.34; // first face of a tile in the transition; the rest (24%) are see-through
    const SEAM_MAX_CELLS = 1;                       // the seam is at most this many tiles deep ...
    const SEAM_MAX_SHARE = 0.38;                    // ... and at most this share of the artwork
    const SEAM_ACCENT = 0.46;                       // share of accent tiles in the middle of the seam
    const SEAM_PERIOD_MIN = 1500, SEAM_PERIOD_RANGE = 3500; // a seam tile re-rolls every PERIOD_MIN .. PERIOD_MIN + PERIOD_RANGE ms
    const SEAM_TICK_MS = 110;                       // seam animation step (about 9 fps, chunky like the background)
    const ART_FOCUS_Y = 0.36;                       // the artwork area is not square: which part of the cover stays in view (0 = top, 1 = bottom)

    function createArtTiles(host, img, isPlaying, reduceMotion, visible) {
        const cv = document.createElement('canvas');
        cv.className = 'scmp-cover';
        cv.setAttribute('aria-hidden', 'true');
        host.appendChild(cv);
        const ctx = cv.getContext('2d');
        let theme = null;                  // { pal, grid, seed } of the artwork on screen
        let L = null;                      // tile layout for the current theme + size
        let bandCover = null;              // just the seam's part of the cover (the tiles' pixel source)
        let animT = 0, lastNow = 0, timer = 0, raf = 0, rz = 0, ro = null, destroyed = false;
        let held = false, run = null;      // held: a track change owns the canvas
        let waiting = false, imgFresh = false, themeFresh = false; // the cover is repainted once the new artwork AND its palette are in
        const hasSrc = () => !!img.getAttribute('src');
        const loaded = () => hasSrc() && img.complete && img.naturalWidth > 0;

        // The artwork at full size, "object-fit: cover"; 1:1 with the canvas, so tiles cut from it have no seams between them.
        function makeCover() {
            if (!L || !loaded()) return null;
            try {
                const c = document.createElement('canvas');
                c.width = L.PW; c.height = L.PH;
                const nw = img.naturalWidth, nh = img.naturalHeight;
                const k = Math.max(L.PW / nw, L.PH / nh), sw = L.PW / k, sh = L.PH / k;
                const g = c.getContext('2d');
                g.imageSmoothingQuality = 'high';
                g.drawImage(img, (nw - sw) * 0.5, (nh - sh) * ART_FOCUS_Y, sw, sh, 0, 0, L.PW, L.PH);
                return c;
            } catch (e) { return null; }
        }
        function cropBand(cover) {
            bandCover = null;
            if (!cover || !L) return;
            const c = document.createElement('canvas');
            c.width = L.bw; c.height = L.bh;
            c.getContext('2d').drawImage(cover, L.ox, L.oy, L.bw, L.bh, 0, 0, L.bw, L.bh);
            bandCover = c;
        }

        // ── layout ──────────────────────────────────────────────────────────
        function buildLayout(th) {
            const cw = host.clientWidth, ch = host.clientHeight;
            if (!th || !cw || !ch) return null;
            const dpr = Math.min(3, window.devicePixelRatio || 1);
            const PW = Math.round(cw * dpr), PH = Math.round(ch * dpr);
            const axis = (getComputedStyle(host).getPropertyValue('--sd') || '').trim() === 'x' ? 'x' : 'y'; // which way the seam runs
            const cs = Math.max(4, Math.round(Math.max(10, Math.min(18, Math.round(Math.min(cw, ch) / 16))) * dpr));
            const len = axis === 'y' ? PH : PW;
            const Lc = Math.max(3, Math.min(SEAM_MAX_CELLS, Math.round((len * SEAM_MAX_SHARE) / cs)));
            const bandLen = Lc * cs, bandStart = len - bandLen;
            const cols = Math.ceil(PW / cs), rows = Math.ceil(PH / cs);
            // the grid hangs off the seam's far edge, so the seam is exactly Lc tiles deep
            const gx0 = axis === 'x' ? PW - cols * cs : 0, gy0 = axis === 'y' ? PH - rows * cs : 0;
            const sd = pxSeed(th.seed || 'idle');
            const ramp = buildRamp(th.pal);
            const pp = Math.round(5 * dpr), lw = Math.max(1, Math.round(dpr)), patterns = [];
            for (let i = 0; i < 3; i++) {
                patterns.push(ctx.createPattern(pxHatchTile(ramp[i], ramp[i + 1], pp, lw), 'repeat'),
                              ctx.createPattern(pxHatchTile(ramp[i + 1], ramp[i], pp, lw), 'repeat'));
            }
            const lum = th.grid ? pxEqualize(th.grid, 0.7) : null;
            const side = Math.max(PW, PH), vx = PW / side, vy = PH / side; // visible share of the (square) cover per axis
            const inBand = (c, r) => (axis === 'y' ? r >= rows - Lc : c >= cols - Lc);
            const taken = new Uint8Array(cols * rows), blocks = [];
            const free = (c, r, w, h) => {
                if (c + w > cols || r + h > rows) return false;
                const here = inBand(c, r);
                for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (taken[(r + j) * cols + c + i] || inBand(c + i, r + j) !== here) return false;
                return true;
            };
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    if (taken[r * cols + c]) continue;
                    const m = pxHash(c, r, sd + 11);
                    let w = 1, h = 1;
                    if (m < 0.14 && free(c, r, 2, 2)) { w = 2; h = 2; }
                    else if (m < 0.34 && free(c, r, 2, 1)) w = 2;
                    else if (m < 0.52 && free(c, r, 1, 2)) h = 2;
                    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) taken[(r + j) * cols + c + i] = 1;
                    const gx = gx0 + c * cs, gy = gy0 + r * cs, gw = w * cs, gh = h * cs;
                    const x = Math.max(0, gx), y = Math.max(0, gy), x2 = Math.min(PW, gx + gw), y2 = Math.min(PH, gy + gh);
                    if (x2 <= x || y2 <= y) continue;
                    const cx = Math.min(PW, Math.max(0, gx + gw / 2)), cy = Math.min(PH, Math.max(0, gy + gh / 2));
                    const band = inBand(c, r);
                    const s = band ? Math.min(1, Math.max(0, ((axis === 'y' ? cy : cx) - bandStart) / bandLen)) : 0; // 0 at the artwork, 1 at the card
                    const k = pxHash(c, r, sd + 23);
                    const type = k < AM_SHARE_COVER ? 0 : k < AM_SHARE_COVER + AM_SHARE_ACCENT ? 1 : 2; // first face in the transition
                    let v = lum ? pxSample(lum, (1 - vx) * 0.5 + (cx / PW) * vx, (1 - vy) * ART_FOCUS_Y + (cy / PH) * vy) : pxHash(c, r, sd + 31);
                    v = Math.min(1, Math.max(0, v + (pxHash(c, r, sd + 37) - 0.5) * 0.08));
                    const code = classify(Math.min(0.78, 0.12 + 0.88 * v)); // accent tiles follow the artwork's own light and dark (lifted: solid ink would look like holes; capped: solid pale would look like a glitch, as a crosshatch it is fine)
                    const at = ((cx / PW) * 0.72 + pxHash(c, r, sd + 41) * 0.28) * AM_WAVE_MS; // left → right, with jitter
                    const settle = type === 0 && !band ? at : at + AM_HOLD_MIN + pxHash(c, r, sd + 47) * AM_HOLD_RANGE;
                    blocks.push({ x, y, w: x2 - x, h: y2 - y, c, r, band, s, type, code, at, settle,
                        period: SEAM_PERIOD_MIN + pxHash(c, r, sd + 53) * SEAM_PERIOD_RANGE, phase: pxHash(c, r, sd + 59) * SEAM_PERIOD_MIN * 4 });
                }
            }
            const seam = blocks.filter((b) => b.band);
            return {
                th, PW, PH, dpr, axis, cs, bandStart, bandLen, sd, blocks, seam,
                ox: axis === 'x' ? bandStart : 0, oy: axis === 'y' ? bandStart : 0,
                bw: axis === 'x' ? bandLen : PW, bh: axis === 'y' ? bandLen : PH,
                rampCss: ramp.map(pxCss), patterns, last: new Uint8Array(seam.length).fill(255), tmp: new Uint8Array(seam.length),
            };
        }
        function ensureLayout() {
            if (!theme) return null;
            const cw = host.clientWidth, ch = host.clientHeight;
            if (L && L.th === theme && L.PW === Math.round(cw * L.dpr) && L.PH === Math.round(ch * L.dpr)) return L;
            L = buildLayout(theme);
            if (L && (cv.width !== L.PW || cv.height !== L.PH)) { cv.width = L.PW; cv.height = L.PH; } // (resizing clears it; the same size keeps what is on it)
            return L;
        }

        // ── painting ────────────────────────────────────────────────────────
        // What a seam tile shows at time t: 0 cover, 1 accent, 2 gap. Each tile re-rolls on its own clock, so they change one by one.
        function seamState(b, t) {
            const u = pxHash(b.c, b.r, L.sd + 13 + Math.floor((t + b.phase) / b.period) * 7919);
            const pCover = Math.pow(1 - b.s, 1.4), pAccent = SEAM_ACCENT * Math.sin(Math.PI * b.s);
            return u < pCover ? 0 : u < pCover + pAccent ? 1 : 2;
        }
        // src: a canvas holding the cover at (sox, soy) in artwork coordinates.
        function paintBlock(g, b, face, src, sox, soy) {
            g.clearRect(b.x, b.y, b.w, b.h);
            if (face === 2) return;
            if (face === 0 && src) { g.drawImage(src, b.x - sox, b.y - soy, b.w, b.h, b.x, b.y, b.w, b.h); return; }
            g.fillStyle = b.code < 4 ? L.rampCss[b.code] : L.patterns[b.code - 4]; // (no cover to show yet: hold the place with its accent tile)
            g.fillRect(b.x, b.y, b.w, b.h);
        }
        function drawSeam(force) {
            if (!L) return;
            let changed = !!force;
            for (let i = 0; i < L.seam.length; i++) {
                const s = seamState(L.seam[i], animT);
                L.tmp[i] = s;
                if (s !== L.last[i]) changed = true;
            }
            if (!changed) return;
            ctx.clearRect(L.ox, L.oy, L.bw, L.bh);
            for (let i = 0; i < L.seam.length; i++) paintBlock(ctx, L.seam[i], L.tmp[i], bandCover, L.ox, L.oy);
            L.last.set(L.tmp);
        }
        // The whole artwork area, settled: the cover above the seam (or a plain accent gradient if there is no artwork), and the seam.
        function paintAll() {
            if (!L) return;
            ctx.clearRect(0, 0, L.PW, L.PH);
            const above = L.axis === 'y' ? [0, 0, L.PW, L.bandStart] : [0, 0, L.bandStart, L.PH];
            const cover = makeCover();
            if (cover) {
                ctx.drawImage(cover, above[0], above[1], above[2], above[3], above[0], above[1], above[2], above[3]);
            } else if (!hasSrc()) {
                const g = ctx.createLinearGradient(0, 0, L.PW, L.PH);
                g.addColorStop(0, L.th.pal[0]); g.addColorStop(1, L.th.pal[1]);
                ctx.fillStyle = g;
                ctx.fillRect(above[0], above[1], above[2], above[3]);
            }
            cropBand(cover);
            if (cover) cover.width = 0; // (free it: only the band is kept)
            L.last.fill(255);
            drawSeam(true);
        }

        // ── seam animation ──────────────────────────────────────────────────
        function schedule() {
            clearTimeout(timer); timer = 0;
            if (destroyed || held || !L || !visible() || reduceMotion()) return;
            timer = setTimeout(tick, SEAM_TICK_MS);
        }
        function tick() {
            timer = 0;
            if (held || !L || !visible()) return;
            const now = performance.now(), dt = Math.min(300, now - lastNow);
            lastNow = now;
            if (isPlaying() && !reduceMotion()) animT += dt; // the seam only moves while music plays
            drawSeam(false);
            schedule();
        }
        function showCover(fade) {
            const st = cv.style;
            st.transition = 'none';
            st.opacity = fade ? '0' : '1';
            if (fade) { void cv.offsetWidth; st.transition = 'opacity .35s'; st.opacity = '1'; }
        }
        function refresh(fade) {
            if (held || destroyed || !visible() || !ensureLayout()) return;
            paintAll();
            showCover(fade);
            lastNow = performance.now();
            schedule();
        }
        function tryShow() {
            if (!waiting || held || !themeFresh || !(imgFresh || !hasSrc())) return; // (no src at all = deliberately no artwork)
            waiting = false;
            L = null;
            refresh(true); // fades in, once
        }

        // ── transition ──────────────────────────────────────────────────────
        function end() {
            if (!held) return;
            cancelAnimationFrame(raf);
            const r = run;
            run = null; held = false;
            if (r) {
                while (r.idx < r.ev.length) r.paint(r.ev[r.idx++]);
                animT = r.D;
                const cover = r.cover();
                cropBand(cover);
                if (cover) cover.width = 0;
                for (let i = 0; i < L.seam.length; i++) L.last[i] = seamState(L.seam[i], r.D); // exactly what the settled tiles show
                if (!cover && hasSrc()) { waiting = true; imgFresh = false; themeFresh = true; } // the artwork never arrived: finish when it does
            } else {
                tryShow(); // nothing was assembled (aborted / no artwork): paint what is available, or wait for it
            }
            lastNow = performance.now();
            schedule();
            if (r) r.resolve();
        }
        // A track change starts: the canvas keeps the old cover (and its seam) while the artwork underneath changes.
        function hold() {
            end();
            if (destroyed || !visible() || !ensureLayout()) return;
            held = true;
            clearTimeout(timer); timer = 0;
            showCover(false); // (an unfinished fade-in would hide the old cover)
        }
        // pal / grid / seed: the new artwork's palette, luminance field (or null) and a stable string. Resolves once the cover is in place.
        function play(pal, grid, seed) {
            return new Promise((resolve) => {
                if (!held) { resolve(); return; }
                theme = { pal, grid, seed };
                L = null; waiting = false;
                if (!ensureLayout()) { end(); resolve(); return; }
                let cover = null;
                const haveCover = () => { if (!cover) cover = makeCover(); return !!cover; };
                let total = 0;
                const ev = [];
                for (const b of L.blocks) {
                    ev.push({ t: b.at, b, k: 0 });
                    if (b.settle > b.at) ev.push({ t: b.settle, b, k: 1 });
                    total = Math.max(total, b.settle);
                }
                ev.sort((a, b) => a.t - b.t);
                const D = total + 40;
                const paint = (e) => {
                    const b = e.b, src = haveCover() ? cover : null;
                    if (e.k === 0) { if (b.type !== 2) paintBlock(ctx, b, b.type, src, 0, 0); } // type 2: leave the old cover showing through
                    else paintBlock(ctx, b, b.band ? seamState(b, D) : 0, src, 0, 0);            // settle into what the seam shows
                };
                run = { resolve, ev, idx: 0, D, paint, cover: () => cover };
                const t0 = performance.now();
                const loop = () => {
                    if (!run) return;
                    const t = performance.now() - t0;
                    while (run.idx < ev.length && ev[run.idx].t <= t) {
                        if (!loaded() && t < D + 400) break; // wait for the artwork rather than paint placeholders
                        paint(ev[run.idx++]);
                    }
                    if (run.idx >= ev.length) end(); else raf = requestAnimationFrame(loop);
                };
                raf = requestAnimationFrame(loop);
            });
        }

        if (typeof ResizeObserver === 'function') {
            ro = new ResizeObserver(() => {
                cancelAnimationFrame(rz);
                rz = requestAnimationFrame(() => {
                    const cw = host.clientWidth, ch = host.clientHeight;
                    if (L && L.PW === Math.round(cw * L.dpr) && L.PH === Math.round(ch * L.dpr)) return; // nothing actually changed (e.g. the first notification)
                    if (held) end();
                    L = null;
                    if (!waiting) refresh(false);
                });
            });
            ro.observe(host);
        }

        return {
            // New palette for the artwork on screen.
            setTheme(pal, grid, seed) {
                theme = { pal, grid, seed };
                themeFresh = true;
                if (held) return;
                if (waiting) tryShow(); else { L = null; refresh(false); } // (palette of art that is already showing: just repaint)
            },
            // The <img> finished loading.
            imageLoaded() { imgFresh = true; if (!held) tryShow(); },
            // The artwork is about to change. Outside a transition the old cover goes at once and the new one fades in when it and its palette are there.
            reset() {
                waiting = true; imgFresh = false; themeFresh = false;
                bandCover = null;
                if (held) return;
                cv.style.transition = 'none'; cv.style.opacity = '0';
            },
            wake() { if (!held && !waiting) refresh(false); },
            busy: () => held,
            hold, play, cancel: end,
            destroy() { destroyed = true; end(); clearTimeout(timer); cancelAnimationFrame(rz); if (ro) ro.disconnect(); cv.remove(); },
        };
    }
    // ── end cover-art tiles ─────────────────────────────────────────────────

    // ── DOM ─────────────────────────────────────────────────────────────────
    const ICON = {
        burger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        play: '<svg class="i-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
        pause: '<svg class="i-pause" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/></svg>',
        next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6l9 6-9 6V6zM17 6h2v12h-2z"/></svg>',
        prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 6l-9 6 9 6V6zM5 6h2v12H5z"/></svg>',
        heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
        note: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>',
        queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h12M4 12h7M4 17h7"/><path d="M14.5 13.5v7l5.5-3.5z" fill="currentColor"/></svg>',
    };
    // Film grain over the whole card (artwork + the accent shade below it): a tiled SVG noise texture (white specks, alpha = GRAIN_STRENGTH * noise).
    const GRAIN_STRENGTH = 0.08; // 0 = none, ~0.16 and beyond = heavy
    const GRAIN_URI = 'data:image/svg+xml,' + encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>" +
        "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/>" +
        "<feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 " + GRAIN_STRENGTH + " 0'/></filter>" +
        "<rect width='100%' height='100%' filter='url(#n)'/></svg>");

    const CSS = `
@property --scmp-a { syntax: '<color>'; inherits: true; initial-value: rgb(255, 85, 0); }
@property --scmp-b { syntax: '<color>'; inherits: true; initial-value: rgb(110, 60, 190); }
@property --scmp-cs { syntax: '<color>'; inherits: true; initial-value: rgba(66, 24, 4, .86); }

#scmp-root, #scmp-root * { box-sizing: border-box; }
#scmp-root {
  --scmp-a: rgb(255, 85, 0);
  --scmp-b: rgb(110, 60, 190);
  --scmp-cs: rgba(66, 24, 4, .86);  /* the card: a dark shade of the accent, a bit see-through (see cardTone) */
  --scmp-inset: 0px;
  position: fixed; left: 0; right: 0; bottom: 0; top: var(--scmp-inset);
  z-index: 2147483000; display: none; overflow: hidden; overflow: clip;
  color: #fff; background: #0e0c10;
  font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-user-select: none; user-select: none; cursor: default;
  transition: --scmp-a .9s ease, --scmp-b .9s ease, --scmp-cs .9s ease;
}
#scmp-root.scmp-on { display: block; }

/* ── background: pixel-mosaic + halftone render of the artwork, painted on a canvas (see createPixelBg) ── */
.scmp-pixels { position: absolute; inset: 0; width: 100%; height: 100%; display: block; pointer-events: none;
  image-rendering: pixelated; }

@keyframes scmp-pulse {
  0%, 100% { scale: .78; opacity: .35; }
  50% { scale: 1.08; opacity: .8; }
}

/* darkens the edges and the top / bottom so the controls stay readable over the lighter blocks */
.scmp-vignette { position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(125% 90% at 50% 45%, rgba(6,5,9,0) 40%, rgba(6,5,9,.5) 100%),
    linear-gradient(180deg, rgba(6,5,9,.34), rgba(6,5,9,.06) 30%, rgba(6,5,9,.12) 62%, rgba(6,5,9,.44)); }

/* ── cursor reveal: edges (and a soft spotlight) follow the pointer, Fluent-style ── */
.scmp-reveal::before, .scmp-reveal::after {
  content: ''; position: absolute; pointer-events: none; border-radius: inherit;
  opacity: 0; transition: opacity .22s ease; }
.scmp-reveal::before { inset: var(--ri, 0px); padding: 1.5px;
  background: radial-gradient(circle calc(var(--rr, 80px) * (.6 + .4 * var(--gain, 1))) at var(--mx, 50%) var(--my, 50%),
    rgba(255,255,255,calc(var(--ra, .9) * var(--gain, 1))) 0%,
    rgba(255,255,255,calc(var(--ra, .9) * var(--gain, 1) * .25)) 50%,
    rgba(255,255,255,0) 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude; }
.scmp-reveal::after { inset: 0;
  background: radial-gradient(circle var(--fr, 100px) at var(--mx, 50%) var(--my, 50%), rgba(255,255,255,var(--fa, .14)), rgba(255,255,255,0)); }
.scmp-reveal.lit::before, .scmp-reveal.hot::after { opacity: 1; }
#scmp-root.scmp-reveal { --rr: 100px; --ra: .6; --fa: 0; }
#scmp-root.scmp-reveal::before { z-index: 20; }

/* z-index: 1 makes the shell one stacking context, so the z-indexes used inside it (body, like button, lit edges)
   can no longer outrank the scrim and drawers, which sit above it (30 / 31). */
.scmp-shell { position: absolute; z-index: 1; inset: 0; display: flex; flex-direction: column; gap: 10px; padding: 10px 14px 14px; }
.scmp-top { flex: none; height: 36px; display: flex; align-items: center; gap: 10px; -webkit-app-region: drag; }
.scmp-menu .scmp-top, .scmp-queue .scmp-top { -webkit-app-region: no-drag; }
.scmp-label { flex: 1; text-align: center; font-weight: 600; opacity: .8; text-shadow: 0 1px 8px rgba(0,0,0,.5); }

.scmp-btn { --rr: 56px; -webkit-app-region: no-drag; appearance: none; border: 0; padding: 0; margin: 0; background: transparent;
  color: inherit; cursor: pointer; position: relative; display: grid; place-items: center; border-radius: 999px;
  transition: transform .15s, background .2s; }
.scmp-btn:hover { background: rgba(255,255,255,.1); }
.scmp-btn:active { transform: scale(.92); }
.scmp-btn:focus-visible, .scmp-item:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.scmp-btn svg { width: 100%; height: 100%; display: block; }
.scmp-icon { width: 36px; height: 36px; padding: 8px; }
/* like: a round button on the artwork's top right (it mirrors SoundCloud's own like button) */
.scmp-like { position: absolute; z-index: 6; top: 14px; right: 14px; width: 40px; height: 40px; padding: 10px; border-radius: 50%;
  color: #fff; background: rgba(10,10,16,.42); border: 1px solid rgba(255,255,255,.14); --rr: 48px;
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
.scmp-like:hover { background: rgba(10,10,16,.62); }
.scmp-like[hidden] { display: none; }
.scmp-like svg path { fill: transparent; stroke: currentColor; stroke-width: 2.1; stroke-linejoin: round; transition: fill .2s, stroke .2s; }
.scmp-like.is-liked { color: #ff4d6a; }
.scmp-like.is-liked svg path { fill: #ff4d6a; stroke: #ff4d6a; }
.scmp-like.is-liked svg { filter: drop-shadow(0 0 5px rgba(255,77,106,.55)); }
.scmp-like.pop svg { animation: scmp-pop .42s cubic-bezier(.2, .9, .3, 1.4); }
@keyframes scmp-pop { 0% { scale: 1; } 40% { scale: 1.35; } 100% { scale: 1; } }

/* ── the card: a translucent shade of the accent; the cover sits on top, and a seam of tiles separates the two ── */
.scmp-card { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; border-radius: 24px;
  background: url("${GRAIN_URI}") 0 0 / 160px 160px, var(--scmp-cs);
  border: 1px solid rgba(255,255,255,.14); box-shadow: 0 18px 46px rgba(0,0,0,.45);
  --ri: -1px; --rr: 105px; --ra: .9; --fr: 230px; --fa: .06; }
.scmp-card.scmp-reveal::before, .scmp-card.scmp-reveal::after { z-index: 5; } /* lit edge + spotlight sit above the artwork */
/* Upper part of the card = the artwork, painted on ONE canvas (see createArtTiles): the cover, and at its lower edge a seam of
   tiles through which the card shows. The <img> inside .scmp-art is only the pixel source and never shown.
   --sd = which way the seam runs: y = along the bottom edge, x = along the right edge (compact layout). */
.scmp-art-wrap { position: relative; z-index: 0; flex: 1 1 0; min-height: 0; overflow: hidden; border-radius: 23px 23px 0 0; --sd: y; }
.scmp-art-wrap::after { content: ''; position: absolute; inset: 0; z-index: 4; pointer-events: none;
  background: url("${GRAIN_URI}") 0 0 / 160px 160px; }
.scmp-art { display: none; }
.scmp-cover { position: absolute; inset: 0; z-index: 2; width: 100%; height: 100%; display: block; pointer-events: none;
  image-rendering: pixelated; }

/* no z-index here on purpose: a z-index would make the body its own stacking context and trap the speed popup (z-index 7)
   below the like button (6), which is a sibling of the body */
.scmp-body { position: relative; flex: none; display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 8px 20px 20px; }
.scmp-meta { min-width: 0; text-align: center; }
.scmp-title { font-size: 17px; font-weight: 700; letter-spacing: -.01em; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; text-shadow: 0 1px 10px rgba(0,0,0,.35); }
.scmp-author { margin-top: 2px; opacity: .72; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.scmp-seek { position: relative; padding: 9px 0; margin: -9px 0; cursor: pointer; touch-action: none; outline: none; -webkit-app-region: no-drag; }
.scmp-seek:focus-visible { outline: 2px solid #fff; outline-offset: -2px; border-radius: 8px; }
.scmp-bar { height: 5px; border-radius: 99px; background: rgba(255,255,255,.22); overflow: hidden; transition: scale .15s ease; }
.scmp-seek:hover .scmp-bar, .scmp-seek.dragging .scmp-bar { scale: 1 1.7; }
.scmp-seektip { position: absolute; bottom: 100%; left: 0; translate: -50% 2px; padding: 2px 8px; border-radius: 99px;
  background: rgba(0,0,0,.45); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; opacity: 0; pointer-events: none;
  transition: opacity .12s; -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
.scmp-seek:hover .scmp-seektip, .scmp-seek.dragging .scmp-seektip { opacity: 1; }
.scmp-bar i { display: block; height: 100%; width: 0; border-radius: inherit; background: #fff;
  box-shadow: 0 0 12px rgba(255,255,255,.55); transition: width .45s linear; }
.scmp-times { display: flex; justify-content: space-between; margin-top: 6px; font-size: 11.5px; opacity: .78;
  font-variant-numeric: tabular-nums; }

/* knob | transport | speed. minmax(0, 1fr) keeps the two outer columns equal even when their content is wider than the
   space left, so the transport stays centred exactly under the timeline (plain 1fr would shove it sideways). */
.scmp-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; }
.scmp-transport { display: flex; align-items: center; justify-self: center; gap: 16px; }
.scmp-knobcell { justify-self: start; }
.scmp-skip { width: 46px; height: 46px; padding: 11px; }

/* volume knob */
.scmp-knob { position: relative; width: 46px; height: 46px; border-radius: 50%; cursor: ns-resize; touch-action: none;
  outline: none; -webkit-app-region: no-drag; }
.scmp-knob svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.scmp-knob circle { fill: none; stroke-width: 3; stroke-linecap: round; }
.scmp-knob .trk { stroke: rgba(255,255,255,.22); }
.scmp-knob .val { stroke: #fff; filter: drop-shadow(0 0 4px var(--scmp-a)); }
.scmp-cap { position: absolute; inset: 8px; border-radius: 50%; transform: rotate(var(--deg, 135deg));
  background: linear-gradient(145deg, rgba(255,255,255,.3), rgba(255,255,255,.08));
  border: 1px solid rgba(255,255,255,.22);
  box-shadow: 0 4px 10px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.3); transition: background .2s; }
.scmp-cap::after { content: ''; position: absolute; left: 50%; top: 3px; width: 3px; height: 7px; margin-left: -1.5px;
  border-radius: 2px; background: #fff; }
.scmp-knob:hover .scmp-cap { background: linear-gradient(145deg, rgba(255,255,255,.4), rgba(255,255,255,.12)); }
.scmp-knob:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
.scmp-knobval { position: absolute; left: 50%; bottom: calc(100% + 8px); translate: -50% 4px; padding: 2px 9px; border-radius: 99px;
  background: rgba(0,0,0,.45); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; opacity: 0; pointer-events: none;
  transition: opacity .15s, translate .15s; -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
.scmp-knob:hover .scmp-knobval, .scmp-knob.show .scmp-knobval, .scmp-knob:focus-visible .scmp-knobval { opacity: 1; translate: -50% 0; }

/* playback speed (only shown when the Playback Speed plugin is installed next to this one) */
.scmp-speedcell { position: relative; justify-self: end; }
.scmp-speedcell[hidden] { display: none; }
.scmp-speedbtn { width: 46px; height: 46px; font-size: 12.5px; font-weight: 700; letter-spacing: -.01em; font-variant-numeric: tabular-nums;
  border: 1px solid rgba(255,255,255,.2); background: rgba(255,255,255,.08); }
.scmp-speedbtn.is-active { background: #fff; color: #14141c; border-color: #fff; }
.scmp-speedbtn.is-off { opacity: .5; }
.scmp-speedpop { position: absolute; right: 0; bottom: calc(100% + 12px); z-index: 7; width: 232px; padding: 12px; border-radius: 18px;
  background: linear-gradient(145deg, rgba(255,255,255,.16), rgba(255,255,255,.05)), rgba(14,14,22,.78);
  border: 1px solid rgba(255,255,255,.2); box-shadow: 0 14px 40px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.25);
  -webkit-backdrop-filter: blur(26px) saturate(170%); backdrop-filter: blur(26px) saturate(170%);
  transform-origin: 100% 100%; scale: .92; opacity: 0; pointer-events: none; transition: opacity .18s, scale .18s; }
.scmp-speedpop.open { scale: 1; opacity: 1; pointer-events: auto; }
.scmp-speedhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-weight: 600; }
.scmp-speedreset { appearance: none; border: 0; padding: 3px 10px; border-radius: 99px; background: rgba(255,255,255,.16); color: inherit;
  font: inherit; font-weight: 700; font-variant-numeric: tabular-nums; cursor: pointer; }
.scmp-speedslider { -webkit-appearance: none; appearance: none; display: block; width: 100%; height: 18px; margin: 0; background: transparent; cursor: pointer; }
.scmp-speedslider::-webkit-slider-runnable-track { height: 4px; border-radius: 99px;
  background: linear-gradient(90deg, #fff var(--p, 33%), rgba(255,255,255,.25) var(--p, 33%)); }
.scmp-speedslider::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: -6px; border-radius: 50%;
  background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
.scmp-presets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 10px; }
.scmp-chipbtn { --rr: 50px; position: relative; appearance: none; border: 0; padding: 7px 0; border-radius: 10px; background: rgba(255,255,255,.1);
  color: inherit; font: inherit; font-weight: 600; font-variant-numeric: tabular-nums; cursor: pointer; transition: background .15s; }
.scmp-chipbtn.on { background: #fff; color: #14141c; }
.scmp-speedmsg { display: none; margin: 0; line-height: 1.45; opacity: .85; }
.scmp-speedpop.no-api .scmp-speedmsg { display: block; }
.scmp-speedpop.no-api .scmp-speedslider, .scmp-speedpop.no-api .scmp-presets, .scmp-speedpop.no-api .scmp-speedreset { display: none; }
.scmp-play { width: 62px; height: 62px; padding: 17px; background: #fff; color: #14141c;
  box-shadow: 0 8px 22px rgba(0,0,0,.35), 0 0 30px var(--scmp-a); }
.scmp-play:hover { background: #fff; transform: scale(1.06); }
.scmp-play .i-pause, .is-playing .scmp-play .i-play { display: none; }
.is-playing .scmp-play .i-pause { display: block; }

/* burger drawer */
.scmp-scrim { position: absolute; z-index: 30; inset: 0; background: rgba(0,0,0,.4); opacity: 0; pointer-events: none; transition: opacity .25s; }
.scmp-menu .scmp-scrim, .scmp-queue .scmp-scrim { opacity: 1; pointer-events: auto; }
.scmp-drawer { position: absolute; z-index: 31; top: 0; bottom: 0; left: 0; width: min(88%, 310px); display: flex; flex-direction: column;
  transform: translateX(-104%); visibility: hidden; /* hidden while closed: its shadow would otherwise leak onto the card */
  transition: transform .3s cubic-bezier(.2,.8,.2,1), visibility 0s linear .3s;
  background: linear-gradient(160deg, rgba(255,255,255,.2), rgba(255,255,255,.06)), rgba(14,14,22,.4);
  border-right: 1px solid rgba(255,255,255,.16); border-radius: 0 26px 26px 0;
  box-shadow: 20px 0 60px rgba(0,0,0,.4);
  --ri: 0px; --rr: 100px; --ra: .8; --fr: 230px; --fa: .05;
  -webkit-backdrop-filter: blur(34px) saturate(180%); backdrop-filter: blur(34px) saturate(180%); }
.scmp-drawer.right { left: auto; right: 0; transform: translateX(104%); border-right: 0; border-left: 1px solid rgba(255,255,255,.16);
  border-radius: 26px 0 0 26px; box-shadow: -20px 0 60px rgba(0,0,0,.4); }
.scmp-menu .scmp-drawer.left, .scmp-queue .scmp-drawer.right { transform: translateX(0); visibility: visible; transition-delay: 0s; }
/* while a panel is open, the surfaces underneath stop glowing so their lit edges can't show through the glass */
.scmp-menu .scmp-shell .scmp-reveal::before, .scmp-menu .scmp-shell .scmp-reveal::after,
.scmp-queue .scmp-shell .scmp-reveal::before, .scmp-queue .scmp-shell .scmp-reveal::after { opacity: 0 !important; }
.scmp-dh { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 14px 12px 8px 18px;
  font-size: 15px; font-weight: 700; }
.scmp-list { flex: 1; overflow-y: auto; padding: 2px 10px 14px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.3) transparent; }
.scmp-sec { padding: 14px 8px 6px; font-size: 12px; font-weight: 600; opacity: .6; }
.scmp-item { position: relative; width: 100%; display: flex; align-items: center; gap: 11px; padding: 8px; border: 0; border-radius: 14px;
  background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer;
  transition: background .15s, transform .12s; }
.scmp-item:hover { background: rgba(255,255,255,.07); }
.scmp-item:active { transform: scale(.985); }
.scmp-thumb { flex: none; width: 42px; height: 42px; padding: 11px; border-radius: 10px; background-size: cover; background-position: center;
  background-image: linear-gradient(135deg, var(--scmp-a), var(--scmp-b)); }
.scmp-thumb.has-art { padding: 0; }
.scmp-thumb svg { width: 100%; height: 100%; display: block; }
.scmp-txt { min-width: 0; }
.scmp-txt b { display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scmp-txt small { opacity: .62; font-size: 11.5px; }
.scmp-note { padding: 12px 10px; line-height: 1.5; opacity: .8; }
.scmp-retry { margin-top: 10px; width: auto; padding: 7px 14px; border-radius: 99px; background: rgba(255,255,255,.14);
  font-weight: 600; }
.scmp-item.is-current { background: rgba(255,255,255,.13); }
.scmp-item .scmp-eq { display: none; flex: none; align-items: flex-end; gap: 2px; height: 14px; margin-left: auto; }
.scmp-item.is-current .scmp-eq { display: flex; }
.scmp-eq i { display: block; width: 3px; height: 100%; border-radius: 2px; background: #fff; transform-origin: 50% 100%; scale: 1 .35; }
.is-playing .scmp-eq i { animation: scmp-eq .9s ease-in-out infinite alternate; }
.scmp-eq i:nth-child(2) { animation-delay: -.3s; }
.scmp-eq i:nth-child(3) { animation-delay: -.6s; }
@keyframes scmp-eq { from { scale: 1 .25; } to { scale: 1 1; } }

/* narrow window: smaller controls, so the knob, transport and speed button never crowd each other */
@media (max-width: 380px) {
  .scmp-body { padding-left: 14px; padding-right: 14px; }
  .scmp-transport { gap: 8px; }
  .scmp-skip { width: 40px; height: 40px; padding: 9px; }
  .scmp-play { width: 54px; height: 54px; padding: 15px; }
  .scmp-knob, .scmp-speedbtn { width: 40px; height: 40px; }
}

/* very short window: art on the left, controls on the right */
@media (max-height: 360px) {
  .scmp-card { flex-direction: row; border-radius: 22px; }
  /* the art never takes more than 40% of the width, so the controls always get room */
  .scmp-art-wrap { flex: none; align-self: stretch; width: min(max(110px, calc(100vh - var(--scmp-inset) - 92px)), 40%); margin: 0;
    border-radius: 21px 0 0 21px; }
  .scmp-art-wrap { --sd: x; }
  .scmp-like { top: 10px; right: 10px; width: 34px; height: 34px; padding: 8px; }
  /* title, timeline and volume knob share one left edge; the right padding keeps the title clear of the like button */
  .scmp-body { flex: 1; justify-content: center; gap: 10px; padding: 12px 18px; }
  .scmp-meta { padding: 0 30px 0 0; text-align: left; }
  /* same three-column row as the tall layout: the transport sits centred under the timeline */
  .scmp-transport { gap: 6px; }
  .scmp-skip { width: 36px; height: 36px; padding: 8px; }
  .scmp-play { width: 48px; height: 48px; padding: 13px; }
  .scmp-knob, .scmp-speedbtn { width: 36px; height: 36px; }
}
@media (max-height: 360px) and (max-width: 380px) {
  .scmp-body { padding-left: 14px; padding-right: 14px; }
  .scmp-meta { padding-right: 26px; }
  .scmp-transport { gap: 2px; }
  .scmp-skip { width: 32px; height: 32px; padding: 7px; }
  .scmp-play { width: 42px; height: 42px; padding: 11px; }
  .scmp-knob, .scmp-speedbtn { width: 32px; height: 32px; }
}
@media (max-height: 360px) and (max-width: 340px) { /* smallest windows: less art, tighter controls */
  .scmp-art-wrap { width: min(max(90px, calc(100vh - var(--scmp-inset) - 92px)), 30%); }
  .scmp-skip { width: 30px; height: 30px; padding: 7px; }
  .scmp-play { width: 40px; height: 40px; padding: 11px; }
  .scmp-knob, .scmp-speedbtn { width: 28px; height: 28px; }
  .scmp-cap { inset: 6px; }
}
@media (prefers-reduced-motion: reduce) {
  #scmp-root, #scmp-root * { transition: none !important; }
  .scmp-eq i, .scmp-like.pop svg { animation: none !important; }
}
`;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'scmp-reveal';
    root.style.setProperty('--scmp-inset', cfg.topInset + 'px');
    root.innerHTML = `
      <canvas class="scmp-pixels" aria-hidden="true"></canvas>
      <div class="scmp-vignette"></div>
      <div class="scmp-shell">
        <header class="scmp-top">
          <button class="scmp-btn scmp-icon scmp-reveal" data-act="menu" aria-label="Open playlists">${ICON.burger}</button>
          <div class="scmp-label">Now playing</div>
          <button class="scmp-btn scmp-icon scmp-reveal" data-act="queue" aria-label="Open queue">${ICON.queue}</button>
        </header>
        <section class="scmp-card scmp-reveal">
          <button class="scmp-btn scmp-like scmp-reveal" data-act="like" aria-label="Like" aria-pressed="false" title="Like" hidden>${ICON.heart}</button>
          <div class="scmp-art-wrap"><div class="scmp-art"><img alt=""></div></div>
          <div class="scmp-body">
            <div class="scmp-meta"><div class="scmp-title"></div><div class="scmp-author"></div></div>
            <div class="scmp-progress">
              <div class="scmp-seek" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                <div class="scmp-bar"><i></i></div>
                <span class="scmp-seektip">0:00</span>
              </div>
              <div class="scmp-times"><span class="scmp-cur">0:00</span><span class="scmp-tot">0:00</span></div>
            </div>
            <div class="scmp-controls">
              <div class="scmp-knobcell">
                <div class="scmp-knob" role="slider" tabindex="0" aria-label="Volume" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100">
                  <svg viewBox="0 0 46 46" aria-hidden="true">
                    <circle class="trk" cx="23" cy="23" r="19" transform="rotate(135 23 23)" stroke-dasharray="89.54 119.38"/>
                    <circle class="val" cx="23" cy="23" r="19" transform="rotate(135 23 23)" stroke-dasharray="89.54 119.38"/>
                  </svg>
                  <span class="scmp-cap"></span>
                  <span class="scmp-knobval">100</span>
                </div>
              </div>
              <div class="scmp-transport">
                <button class="scmp-btn scmp-skip scmp-reveal" data-act="prev" aria-label="Previous track">${ICON.prev}</button>
                <button class="scmp-btn scmp-play" data-act="play" aria-label="Play or pause">${ICON.play}${ICON.pause}</button>
                <button class="scmp-btn scmp-skip scmp-reveal" data-act="next" aria-label="Next track">${ICON.next}</button>
              </div>
              <div class="scmp-speedcell" hidden>
                <button class="scmp-btn scmp-speedbtn scmp-reveal" data-act="speed" aria-label="Playback speed" aria-haspopup="true" aria-expanded="false"><span class="scmp-speedval">1×</span></button>
                <div class="scmp-speedpop" role="dialog" aria-label="Playback speed">
                  <div class="scmp-speedhead"><span>Playback speed</span><button class="scmp-speedreset" data-act="speed-reset" title="Reset to 1×">1×</button></div>
                  <input class="scmp-speedslider" type="range" min="0.5" max="2" step="0.05" value="1" aria-label="Playback speed">
                  <div class="scmp-presets">
                    <button class="scmp-chipbtn scmp-reveal" data-act="speed-set" data-value="0.5">0.5×</button>
                    <button class="scmp-chipbtn scmp-reveal" data-act="speed-set" data-value="0.75">0.75×</button>
                    <button class="scmp-chipbtn scmp-reveal" data-act="speed-set" data-value="1">1×</button>
                    <button class="scmp-chipbtn scmp-reveal" data-act="speed-set" data-value="1.25">1.25×</button>
                    <button class="scmp-chipbtn scmp-reveal" data-act="speed-set" data-value="1.5">1.5×</button>
                    <button class="scmp-chipbtn scmp-reveal" data-act="speed-set" data-value="2">2×</button>
                  </div>
                  <p class="scmp-speedmsg"></p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
      <div class="scmp-scrim" data-act="close"></div>
      <aside class="scmp-drawer left scmp-reveal" aria-label="Playlists">
        <div class="scmp-dh"><span>Your library</span>
          <button class="scmp-btn scmp-icon scmp-reveal" data-act="close" aria-label="Close playlists">${ICON.close}</button></div>
        <div class="scmp-list"></div>
      </aside>
      <aside class="scmp-drawer right scmp-reveal" aria-label="Queue">
        <div class="scmp-dh"><span>Up next</span>
          <button class="scmp-btn scmp-icon scmp-reveal" data-act="close" aria-label="Close queue">${ICON.close}</button></div>
        <div class="scmp-list"></div>
      </aside>`;
    document.body.appendChild(root);

    const els = {
        canvas: $('.scmp-pixels', root),
        img: $('.scmp-art img', root),
        art: $('.scmp-art', root),
        artWrap: $('.scmp-art-wrap', root),
        like: $('.scmp-like', root),
        meta: $('.scmp-meta', root),
        knob: $('.scmp-knob', root),
        knobArc: $('.scmp-knob .val', root),
        knobCap: $('.scmp-cap', root),
        knobVal: $('.scmp-knobval', root),
        title: $('.scmp-title', root),
        author: $('.scmp-author', root),
        fill: $('.scmp-bar i', root),
        cur: $('.scmp-cur', root),
        tot: $('.scmp-tot', root),
        list: $('.scmp-drawer.left .scmp-list', root),
        qlist: $('.scmp-drawer.right .scmp-list', root),
        seek: $('.scmp-seek', root),
        seekTip: $('.scmp-seektip', root),
        speedCell: $('.scmp-speedcell', root),
        speedBtn: $('.scmp-speedbtn', root),
        speedVal: $('.scmp-speedval', root),
        speedPop: $('.scmp-speedpop', root),
        speedSlider: $('.scmp-speedslider', root),
        speedReset: $('.scmp-speedreset', root),
        speedMsg: $('.scmp-speedmsg', root),
        speedPresets: Array.from(root.querySelectorAll('.scmp-chipbtn')),
    };
    els.img.addEventListener('load', () => artTiles.imageLoaded()); // (the tiles decide when the new cover is painted)
    const pixelBg = createPixelBg(els.canvas, root, () => root.classList.contains('is-playing'),
        () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
    const artTiles = createArtTiles(els.artWrap, els.img, () => root.classList.contains('is-playing'),
        () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
        () => !document.hidden && root.classList.contains('scmp-on'));

    // ── Cursor reveal ───────────────────────────────────────────────────────
    // Every .scmp-reveal surface gets its own local cursor position. Surfaces within reach of the
    // cursor get a lit edge ("lit"); the one directly under it also gets a soft spotlight ("hot").
    let pointer = null;
    let revealRaf = 0;
    function paintReveal() {
        revealRaf = 0;
        const surfaces = [root].concat(Array.from(root.querySelectorAll('.scmp-reveal'))); // root = window edge
        if (!pointer) {
            surfaces.forEach((el) => { el.classList.remove('lit'); el.classList.remove('hot'); });
            return;
        }
        const x = pointer.x, y = pointer.y;
        surfaces.forEach((el) => {
            const r = el.getBoundingClientRect();
            const dx = Math.max(r.left - x, 0, x - r.right);
            const dy = Math.max(r.top - y, 0, y - r.bottom);
            const dist = Math.hypot(dx, dy);
            const near = dist < REVEAL_REACH;
            if (near) {
                const k = 1 - dist / REVEAL_REACH; // 1 at the surface, 0 at the edge of reach
                el.style.setProperty('--mx', (x - r.left).toFixed(1) + 'px');
                el.style.setProperty('--my', (y - r.top).toFixed(1) + 'px');
                el.style.setProperty('--gain', (k * k * (3 - 2 * k)).toFixed(3));
            }
            el.classList.toggle('lit', near);
            el.classList.toggle('hot', dx === 0 && dy === 0);
        });
    }
    const scheduleReveal = () => { if (!revealRaf) revealRaf = requestAnimationFrame(paintReveal); };
    root.addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; scheduleReveal(); });
    root.addEventListener('pointerleave', () => { pointer = null; scheduleReveal(); });
    els.list.addEventListener('scroll', scheduleReveal, { passive: true });
    root.addEventListener('transitionend', (e) => {
        if (e.target.classList && e.target.classList.contains('scmp-drawer')) scheduleReveal();
    });

    // ── Palette + artwork ───────────────────────────────────────────────────
    function setPalette(pal) {
        root.style.setProperty('--scmp-a', pal[0]);
        root.style.setProperty('--scmp-b', pal[1]);
        root.style.setProperty('--scmp-cs', cardTone(pal));
    }
    let paletteToken = 0;
    // What the cover mosaic needs from the palette pass. It arrives a little after the <img> itself, so a swap waits for it (briefly).
    let artPal = DEFAULT_PALETTE, artGrid = null, palPending = false, palWaiters = [];
    function palSettle(pal, grid, seed) {
        artPal = pal; artGrid = grid; palPending = false;
        artTiles.setTheme(pal, grid, seed);
        const w = palWaiters; palWaiters = [];
        w.forEach((f) => f());
    }
    function waitPal(ms) {
        if (!palPending) return Promise.resolve();
        return new Promise((resolve) => {
            let done = false;
            const fin = () => { if (!done) { done = true; resolve(); } };
            palWaiters.push(fin);
            setTimeout(fin, ms);
        });
    }
    function updatePalette(url, fallbackSeed) {
        const token = ++paletteToken;
        const seed = fallbackSeed || url || 'idle';
        if (!url) { setPalette(DEFAULT_PALETTE); palSettle(DEFAULT_PALETTE, null, seed); pixelBg.show(DEFAULT_PALETTE, null, seed); return; }
        palPending = true;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            if (token !== paletteToken) return;
            let pal = null, grid = null;
            try { pal = paletteFromImage(img); } catch (e) { /* tainted canvas */ }
            try { grid = lumaGrid(img); } catch (e) { /* tainted canvas: the background falls back to a seeded pattern */ }
            pal = pal || hashPalette(seed);
            setPalette(pal);
            palSettle(pal, grid, seed);
            pixelBg.show(pal, grid, seed);
        };
        img.onerror = () => {
            if (token !== paletteToken) return;
            const pal = hashPalette(seed);
            setPalette(pal);
            palSettle(pal, null, seed);
            pixelBg.show(pal, null, seed);
        };
        img.src = url;
    }
    function setArt(url, seed) {
        artTiles.reset(); // the old cover goes (or, in a track change, stays until the tiles replace it); the new one is painted once it and its palette are in
        if (url) els.img.src = url; else els.img.removeAttribute('src');
        updatePalette(url, seed);
    }

    // ── Like ────────────────────────────────────────────────────────────────
    // Mirrors SoundCloud's like button. A press clicks the real one; the heart flips at once (SoundCloud takes a moment to
    // confirm) and the polled state takes over again after a short hold, or as soon as it agrees.
    let likeHold = null, curId = '';
    function paintLike(liked) {
        const b = els.like, label = liked ? 'Unlike' : 'Like';
        b.hidden = liked === null;
        b.classList.toggle('is-liked', liked === true);
        b.setAttribute('aria-pressed', liked === true ? 'true' : 'false');
        b.setAttribute('aria-label', label);
        b.title = label;
    }
    function toggleLike() {
        const btn = $(LIKE_BTN);
        if (!btn) return;
        const next = cur.liked !== true;
        btn.click();
        likeHold = { value: next, until: Date.now() + 1800, id: curId };
        cur.liked = next;
        paintLike(next);
        if (next && !reduceMotion()) { // a little pop
            els.like.classList.remove('pop');
            void els.like.offsetWidth;
            els.like.classList.add('pop');
        }
    }

    // ── Render loop ─────────────────────────────────────────────────────────
    let cur = {};
    let painted = {};      // title / author / art currently on screen
    let shown = null;      // track currently on screen
    let target = null;     // newest track data from SoundCloud
    let swapping = false;
    let swapAnims = [];
    let swapToken = 0;
    let swapStart = 0;
    const trackId = (t) => t.title + '\u0000' + t.author;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const finish = (anims, max) => Promise.race([Promise.all(anims.map((a) => a.finished.catch(() => {}))), sleep(max)]);

    function paintText(t) {
        if (t.title !== painted.title) {
            els.title.textContent = t.title || 'Nothing playing';
            els.title.title = t.title;
        }
        if (t.author !== painted.author) els.author.textContent = t.author || 'Pick a track from your library';
        painted.title = t.title; painted.author = t.author;
    }
    function paintArt(t) {
        if (t.art !== painted.art) setArt(t.art, t.title + t.author);
        painted.art = t.art;
    }
    function paintTrack(t) { paintText(t); paintArt(t); }
    function waitArt(ms) {
        const img = els.img;
        if (!img.getAttribute('src') || (img.complete && img.naturalWidth)) return Promise.resolve();
        return new Promise((resolve) => {
            const done = () => { img.removeEventListener('load', done); img.removeEventListener('error', done); resolve(); };
            img.addEventListener('load', done);
            img.addEventListener('error', done);
            setTimeout(done, ms);
        });
    }
    // Track change. The old title blurs and shrinks to 80% while fading out, then the new title slides in from the right
    // while fading in. The old cover does not leave at all: it is frozen as it is, and the new cover is assembled on top of
    // it, tile by tile, sweeping in from the left (see createArtTiles). That starts right away, alongside the title, as soon
    // as the new artwork is loaded. When the last tile has settled the frozen old cover is thrown away.
    // It is built to fail safe: a minimised window stops animating and throttles timers, so a swap there is dropped
    // (the new track is simply painted) instead of being left half-done with the art or title invisible.
    function abortSwap() {
        swapToken++; // a swap that is still awaiting something stops touching the page
        swapAnims.forEach((a) => { try { a.cancel(); } catch (e) { /* ignore */ } });
        swapAnims = [];
        artTiles.cancel(); // finishes a half-built cover (shows the real image) before the newest track is painted
        swapping = false;
        if (target) { shown = target; paintTrack(target); }
    }
    async function runSwap() {
        const token = ++swapToken;
        swapStart = Date.now();
        try {
            const next = target;
            const outs = [els.meta.animate(
                [{ opacity: 1, filter: 'blur(0px)', scale: 1 }, { opacity: 0, filter: 'blur(14px)', scale: 0.8 }],
                { duration: 280, easing: 'cubic-bezier(.4, 0, .8, .4)', fill: 'forwards' })];
            swapAnims = outs;
            artTiles.hold();   // old cover (and its seam) stay on screen as a snapshot
            shown = next;
            paintArt(next);    // the <img> (hidden under the snapshot) and the palette start loading now
            const built = (async () => {
                await waitArt(350);
                await waitPal(250);
                if (token !== swapToken) return;
                if (!els.img.getAttribute('src')) { artTiles.cancel(); return; } // no artwork: nothing to assemble
                await Promise.race([artTiles.play(artPal, artGrid, next.title + next.author), sleep(1800)]);
            })();
            await finish(outs, 700);
            if (token !== swapToken) return;
            paintText(next);
            const ins = [els.meta.animate(
                [{ opacity: 0, translate: '56px 0', filter: 'blur(0px)', scale: 1 }, { opacity: 1, translate: '0 0', filter: 'blur(0px)', scale: 1 }],
                { duration: 460, delay: 60, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'both' })];
            swapAnims = swapAnims.concat(ins);
            await Promise.all([finish(ins, 1200), built]);
            artTiles.cancel(); // no-op when it finished; settles it if the window stalled
        } catch (e) {
            artTiles.cancel();
            if (token === swapToken) { shown = target; paintTrack(shown); }
        }
        if (token !== swapToken) return;
        swapAnims.forEach((a) => { try { a.cancel(); } catch (e) { /* ignore */ } });
        swapAnims = [];
        swapping = false;
        if (target && shown && trackId(target) !== trackId(shown)) showTrack(target);
    }
    function showTrack(t) {
        target = t;
        if (swapping && (document.hidden || Date.now() - swapStart > 2500)) abortSwap(); // stalled or hidden
        if (swapping) return; // the running swap paints the newest data at its midpoint
        const instant = document.hidden || !shown || !shown.title || !active || reduceMotion() || !els.art.animate || trackId(t) === trackId(shown);
        if (instant) { shown = t; paintTrack(t); return; }
        swapping = true;
        runSwap();
    }

    function render(t) {
        showTrack(t);
        if (seeking || Date.now() < holdProgressUntil) { t.pct = cur.pct; t.passed = cur.passed; } // we are showing the seek position
        if (t.playing !== cur.playing) root.classList.toggle('is-playing', t.playing);
        curId = trackId(t);
        if (likeHold) { // keep what the user just pressed on screen until SoundCloud agrees (or a moment has passed, or the track changed)
            if (likeHold.id !== curId || t.liked === likeHold.value || t.liked === null || Date.now() > likeHold.until) likeHold = null;
            else t.liked = likeHold.value;
        }
        if (t.liked !== cur.liked) paintLike(t.liked);
        if (t.passed !== cur.passed) els.cur.textContent = t.passed;
        if (t.total !== cur.total) els.tot.textContent = t.total;
        if (t.pct !== cur.pct) {
            if (cur.pct > 3 && t.pct < cur.pct - 3) { // new track: snap back instead of sweeping backwards
                els.fill.style.transition = 'none';
                els.fill.style.width = t.pct + '%';
                void els.fill.offsetWidth;
                els.fill.style.transition = '';
            } else els.fill.style.width = t.pct + '%';
            els.seek.setAttribute('aria-valuenow', String(Math.round(t.pct || 0)));
        }
        cur = t;
    }
    const tick = () => {
        render(readTrack());
        paintSpeed();
        if (!volumeOwned && !media.size) { // no audio element captured yet: follow SoundCloud's slider
            const v = readScVolume();
            if (v !== null && Math.abs(v - volume) > 0.005) { volume = v; paintKnob(); }
        }
    };

    // ── Burger menu ─────────────────────────────────────────────────────────
    let plCache = null;
    function itemButton(act, value, thumbHtml, thumbArt, title, sub) {
        const b = document.createElement('button');
        b.className = 'scmp-item scmp-reveal';
        b.dataset.act = act;
        b.dataset.value = value;
        const thumb = document.createElement('span');
        thumb.className = 'scmp-thumb' + (thumbArt ? ' has-art' : '');
        if (thumbArt) thumb.style.backgroundImage = `url("${thumbArt.replace(/"/g, '%22')}")`;
        else thumb.innerHTML = thumbHtml;
        const txt = document.createElement('span');
        txt.className = 'scmp-txt';
        const bold = document.createElement('b');
        bold.textContent = title;
        const small = document.createElement('small');
        small.textContent = sub;
        txt.append(bold, small);
        b.append(thumb, txt);
        return b;
    }
    function renderList(status, items) {
        const list = els.list;
        list.textContent = '';
        list.appendChild(itemButton('open', '/you/likes', ICON.heart, null, 'Liked tracks', 'Play your likes'));
        const sec = document.createElement('div');
        sec.className = 'scmp-sec';
        sec.textContent = 'Playlists';
        list.appendChild(sec);
        const note = (text) => {
            const n = document.createElement('div');
            n.className = 'scmp-note';
            n.textContent = text;
            list.appendChild(n);
            return n;
        };
        if (status === 'loading') note('Loading your playlists…');
        else if (status === 'empty') note('No playlists yet. Create one on SoundCloud and it will show up here.');
        else if (status === 'error') {
            const n = note('Couldn’t load playlists. SoundCloud hasn’t shared your session with the plugin yet; play or open any track, then try again.');
            const retry = document.createElement('button');
            retry.className = 'scmp-item scmp-retry scmp-reveal';
            retry.dataset.act = 'retry';
            retry.textContent = 'Try again';
            n.appendChild(retry);
        } else {
            items.forEach((p) => {
                let path = p.url;
                try { path = new URL(p.url, location.origin).pathname; } catch (e) { /* keep as is */ }
                const sub = typeof p.count === 'number' ? `${p.count} ${p.count === 1 ? 'track' : 'tracks'}` : 'Playlist';
                list.appendChild(itemButton('open', path, ICON.note, p.art, p.title, sub));
            });
        }
        scheduleReveal();
    }
    async function loadMenu(force) {
        if (!force && plCache && Date.now() - plCache.at < 5 * 60 * 1000) {
            renderList(plCache.items.length ? 'ok' : 'empty', plCache.items);
            return;
        }
        renderList('loading');
        try {
            const items = await fetchPlaylists();
            plCache = { at: Date.now(), items };
            renderList(items.length ? 'ok' : 'empty', items);
        } catch (e) {
            renderList('error');
        }
    }

    // ── Queue (read from SoundCloud's own "Up next" panel) ──────────────────
    // SoundCloud only renders the queue while its panel is open. The mini player covers the page,
    // so it opens that panel behind the scenes, mirrors the list, and closes it again afterwards.
    const QUEUE_TOGGLE = [
        '.playbackSoundBadge__showQueue', '.playbackSoundBadge__queueCircle',
        '.playControls [title*="queue" i]', '.playControls [aria-label*="queue" i]',
        '.playControls [title*="next up" i]', '.playControls [aria-label*="next up" i]',
        '.playbackSoundBadge [title*="next up" i]', '.playbackSoundBadge [aria-label*="next up" i]',
    ].join(', ');
    const queueNodes = () => Array.from(document.querySelectorAll('.queueItemView'));
    const textOf = (n, sel) => { const e = n.querySelector(sel); return e ? e.textContent.trim() : ''; };
    function readQueue() {
        return queueNodes().map((n, index) => {
            const art = n.querySelector('[style*="background-image"]');
            const m = art && /url\(["']?([^"')]+)["']?\)/.exec(art.style.backgroundImage || '');
            return {
                index,
                title: textOf(n, '[class*="queueItemView__title"]'),
                author: textOf(n, '[class*="queueItemView__username"]'),
                art: m ? m[1] : null,
            };
        }).filter((q) => q.title);
    }
    let queueOwned = false;   // true while SoundCloud's panel is open because WE clicked it (and so we must close it again)
    let queueTimer = null;
    let queueSig = '';
    let queueRun = 0;         // bumped on every start, so an older, slower start can't overwrite a newer one
    const queueReady = () => readQueue().length > 0; // rows that already carry a title (not just empty placeholders)
    // Opens SoundCloud's panel once and waits for it to fill. It never clicks the toggle a second time while we
    // already own an open panel: the button is a toggle, so a second blind click would close the panel again.
    // Resolves true (rows are there), false (the panel never filled) or null (there is no queue button to click).
    async function ensureQueueOpen() {
        if (queueReady()) return true;                  // already open and filled (e.g. opened by hand earlier)
        if (!queueOwned && !queueNodes().length) {
            const toggle = $(QUEUE_TOGGLE);
            if (!toggle) { console.warn('[mini-player] SoundCloud\u2019s queue button wasn\u2019t found, so the queue can\u2019t be read.'); return null; }
            toggle.click();
            queueOwned = true;
        }
        // At a small window size the panel can take a while to render its rows.
        for (let i = 0; i < 34 && !queueReady(); i++) await sleep(150);
        return queueNodes().length > 0;
    }
    function releaseQueue() {
        if (!queueOwned) return;
        queueOwned = false;
        const toggle = $(QUEUE_TOGGLE);
        if (toggle) toggle.click();
    }
    function renderQueue(status, items) {
        const list = els.qlist;
        const keep = list.scrollTop;
        list.textContent = '';
        const note = (text, retryAct) => {
            const n = document.createElement('div');
            n.className = 'scmp-note';
            n.textContent = text;
            if (retryAct) {
                const r = document.createElement('button');
                r.className = 'scmp-item scmp-retry scmp-reveal';
                r.dataset.act = retryAct;
                r.textContent = 'Try again';
                n.appendChild(r);
            }
            list.appendChild(n);
        };
        if (status === 'loading') note('Reading your queue…');
        else if (status === 'error') note('Couldn’t read the queue from SoundCloud. Start a track, then try again.', 'retry-queue');
        else if (status === 'no-button') note('Couldn’t find SoundCloud’s queue button at this window size. Open the queue once in a larger window and it will show up here.', 'retry-queue');
        else if (!items.length) note('Nothing is queued up yet.');
        else {
            items.forEach((q) => {
                const b = itemButton('queue-play', String(q.index), ICON.note, q.art, q.title, q.author || 'Unknown artist');
                if (q.title === cur.title) b.classList.add('is-current');
                b.insertAdjacentHTML('beforeend', '<span class="scmp-eq"><i></i><i></i><i></i></span>');
                list.appendChild(b);
            });
        }
        list.scrollTop = keep;
        scheduleReveal();
    }
    function refreshQueue(force) {
        const items = readQueue();
        const sig = items.map((q) => q.title + '|' + q.author).join('\n') + '#' + (cur.title || '');
        if (!force && sig === queueSig) return;
        queueSig = sig;
        renderQueue('ok', items);
    }
    async function startQueue() {
        clearInterval(queueTimer);
        queueTimer = null;
        queueSig = '';
        const run = ++queueRun;
        renderQueue('loading');
        const ok = await ensureQueueOpen();
        if (run !== queueRun) return;                   // a newer start (retry, reopen) took over
        if (panelOf() !== 'queue') { releaseQueue(); return; } // closed while we were opening it
        if (!ok) {
            releaseQueue();                             // put SoundCloud's panel back, so a retry starts from a known state
            renderQueue(ok === null ? 'no-button' : 'error');
            return;
        }
        refreshQueue(true);
        const current = els.qlist.querySelector('.is-current'); // centre it inside the list only (scrollIntoView would also scroll the player)
        if (current) {
            const lr = els.qlist.getBoundingClientRect(), cr = current.getBoundingClientRect();
            els.qlist.scrollTop += (cr.top - lr.top) - (lr.height - cr.height) / 2;
        }
        queueTimer = setInterval(() => refreshQueue(false), 1000);
    }
    function stopQueue() {
        queueRun++;                                     // cancels a start that is still waiting for the panel
        clearInterval(queueTimer);
        queueTimer = null;
        releaseQueue();
    }
    function playQueueItem(i) {
        const node = queueNodes()[i];
        if (!node) return;
        const btn = node.querySelector('button[class*="play" i], a[class*="play" i]') || node.querySelector('[class*="avatar"]') || node;
        btn.click();
        setTimeout(tick, 300);
    }

    // ── Side panels: library (left) and queue (right), one open at a time ───
    const panelOf = () => (root.classList.contains('scmp-menu') ? 'menu' : root.classList.contains('scmp-queue') ? 'queue' : null);
    function setPanel(name) {
        const was = panelOf();
        if (was === name) return;
        if (name) closeSpeed();
        root.classList.toggle('scmp-menu', name === 'menu');
        root.classList.toggle('scmp-queue', name === 'queue');
        if (was === 'queue') stopQueue();
        if (name === 'menu') loadMenu(false);
        if (name === 'queue') startQueue();
    }
    const togglePanel = (name) => setPanel(panelOf() === name ? null : name);

    // ── Play a library entry ────────────────────────────────────────────────
    // Navigates inside SoundCloud's single-page app (so music keeps playing), then presses the
    // page's own play button. The target is kept in sessionStorage in case a full reload happens.
    let pendingTimer = null;
    function finishPending() {
        clearInterval(pendingTimer);
        pendingTimer = null;
        try { sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
    }
    function startPending() {
        clearInterval(pendingTimer);
        let path = null;
        try { path = sessionStorage.getItem(PENDING_KEY); } catch (e) { /* ignore */ }
        if (!path) return;
        const clean = (p) => p.replace(/\/$/, '');
        let polls = 0, matched = 0;
        pendingTimer = setInterval(() => {
            polls++;
            if (clean(location.pathname) === clean(path)) {
                matched++;
                if (matched >= 3) { // give the new page a moment to replace the old one
                    const btn = Array.from(document.querySelectorAll('.sc-button-play'))
                        .find((b) => !b.closest('.playControls, #' + ROOT_ID));
                    if (btn) { btn.click(); finishPending(); return; }
                }
            }
            if (polls > 50) finishPending();
        }, 300);
    }
    function go(path) {
        try { sessionStorage.setItem(PENDING_KEY, path); } catch (e) { /* ignore */ }
        const a = document.createElement('a');
        a.href = path;
        a.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(a);
        a.click();
        a.remove();
        startPending();
    }

    // ── Events ──────────────────────────────────────────────────────────────
    root.addEventListener('click', (e) => {
        if (speedOpen && !e.target.closest('.scmp-speedcell')) closeSpeed();
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const act = el.dataset.act;
        if (act === 'speed') toggleSpeed();
        else if (act === 'speed-reset') setSpeed(1);
        else if (act === 'speed-set') setSpeed(parseFloat(el.dataset.value));
        else if (act === 'menu') togglePanel('menu');
        else if (act === 'queue') togglePanel('queue');
        else if (act === 'close') setPanel(null);
        else if (act === 'retry') loadMenu(true);
        else if (act === 'retry-queue') startQueue();
        else if (act === 'open') { setPanel(null); go(el.dataset.value); }
        else if (act === 'queue-play') playQueueItem(parseInt(el.dataset.value, 10));
        else if (act === 'play') clickSC('.playControls__play');
        else if (act === 'next') clickSC('.playControls__next, .skipControl__next');
        else if (act === 'prev') clickSC('.playControls__prev, .skipControl__previous');
        else if (act === 'like') toggleLike();
        if (act === 'play' || act === 'next' || act === 'prev' || act === 'like') setTimeout(tick, 150);
        if (el.blur) el.blur(); // keeps Space from double-triggering SoundCloud's own shortcut
    });
    root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeSpeed(); setPanel(null); }
        if ((e.key === ' ' || e.code === 'Space') && e.target.closest && e.target.closest('button')) e.stopPropagation();
    });

    // Volume knob: drag up/down, scroll, arrow keys, double-click to mute / unmute.
    els.knob.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try { els.knob.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        dragging = { y: e.clientY, v: volume };
        els.knob.classList.add('show');
    });
    els.knob.addEventListener('pointermove', (e) => {
        if (dragging) setVolume(dragging.v + (dragging.y - e.clientY) / 160);
    });
    const endDrag = () => { if (!dragging) return; dragging = null; flashKnob(); };
    els.knob.addEventListener('pointerup', endDrag);
    els.knob.addEventListener('pointercancel', endDrag);
    els.knob.addEventListener('wheel', (e) => {
        e.preventDefault();
        setVolume(volume - Math.max(-0.08, Math.min(0.08, e.deltaY / 1500)));
    }, { passive: false });
    els.knob.addEventListener('dblclick', () => setVolume(volume > 0 ? 0 : lastVolume || 0.7));
    els.knob.addEventListener('keydown', (e) => {
        const step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05, PageUp: 0.1, PageDown: -0.1 }[e.key];
        if (step !== undefined) setVolume(volume + step);
        else if (e.key === 'Home') setVolume(0);
        else if (e.key === 'End') setVolume(1);
        else return;
        e.preventDefault();
        e.stopPropagation();
    });

    // Timeline: click or drag to skip ahead (or back); arrow keys nudge by 5 seconds.
    let seeking = null;
    const seekRatio = (e) => {
        const r = els.seek.getBoundingClientRect();
        return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
    };
    function previewSeek(ratio) {
        const r = els.seek.getBoundingClientRect();
        const t = fmtTime(ratio * getDuration());
        els.seekTip.style.left = Math.max(0, Math.min(r.width, ratio * r.width)) + 'px';
        els.seekTip.textContent = t;
        if (seeking) {
            els.fill.style.width = (ratio * 100).toFixed(1) + '%';
            els.cur.textContent = t;
        }
    }
    function endSeek(commit) {
        if (!seeking) return;
        const ratio = seeking.ratio;
        seeking = null;
        els.seek.classList.remove('dragging');
        if (commit) seekToSeconds(ratio * getDuration());
    }
    els.seek.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try { els.seek.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        seeking = { ratio: seekRatio(e) };
        els.seek.classList.add('dragging');
        previewSeek(seeking.ratio);
    });
    els.seek.addEventListener('pointermove', (e) => {
        const ratio = seekRatio(e);
        if (seeking) seeking.ratio = ratio;
        previewSeek(ratio);
    });
    els.seek.addEventListener('pointerup', () => endSeek(true));
    els.seek.addEventListener('pointercancel', () => endSeek(false));
    els.seek.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') seekBy(5);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') seekBy(-5);
        else if (e.key === 'Home') seekToSeconds(0);
        else if (e.key === 'End') seekToSeconds(Math.max(0, getDuration() - 1));
        else return;
        e.preventDefault();
        e.stopPropagation();
    });

    // ── Playback speed ──────────────────────────────────────────────────────
    // Talks to the "Playback Speed" plugin through the small API it publishes on window. The button
    // appears when that plugin's file sits next to this one (cfg.speedPlugin) or its API is present;
    // it is dimmed, with an explanation, if the file is there but the plugin isn't switched on.
    const RATE_MIN = 0.5, RATE_MAX = 2, RATE_STEP = 0.05;
    const speedApi = () => window.__scrpcPlaybackSpeedApi || null;
    const fmtRate = (v) => (Math.round(v * 100) / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1') + '×';
    let speedOpen = false;
    let speedSig = '';
    function paintSpeed() {
        const api = speedApi();
        const rate = api ? Number(api.getRate()) || 1 : 1;
        const visible = cfg.speedPlugin === true || !!api;
        const sig = [visible, !!api, rate].join('|');
        if (sig === speedSig) return;
        speedSig = sig;
        els.speedCell.hidden = !visible;
        if (!visible) { closeSpeed(); return; }
        els.speedBtn.classList.toggle('is-off', !api);
        els.speedBtn.classList.toggle('is-active', !!api && Math.abs(rate - 1) > 0.001);
        els.speedVal.textContent = fmtRate(rate);
        els.speedReset.textContent = fmtRate(rate);
        els.speedSlider.value = String(rate);
        els.speedSlider.style.setProperty('--p', (((rate - RATE_MIN) / (RATE_MAX - RATE_MIN)) * 100).toFixed(1) + '%');
        els.speedPop.classList.toggle('no-api', !api);
        els.speedMsg.textContent = api ? '' : 'The Playback Speed plugin is installed but not switched on. Enable it in your plugin list.';
        els.speedPresets.forEach((b) => b.classList.toggle('on', Math.abs(parseFloat(b.dataset.value) - rate) < 0.001));
    }
    function setSpeed(v) {
        const api = speedApi();
        if (!api || !isFinite(v)) return;
        api.setRate(Math.max(RATE_MIN, Math.min(RATE_MAX, v)));
        speedSig = '';
        paintSpeed();
    }
    function openSpeed(on) {
        speedOpen = on;
        els.speedPop.classList.toggle('open', on);
        els.speedBtn.setAttribute('aria-expanded', String(on));
        if (on) setPanel(null);
    }
    function closeSpeed() { if (speedOpen) openSpeed(false); }
    function toggleSpeed() { openSpeed(!speedOpen); }
    const speedWheel = (e) => {
        const api = speedApi();
        if (!api) return;
        e.preventDefault();
        setSpeed((Number(api.getRate()) || 1) - Math.sign(e.deltaY) * RATE_STEP);
    };
    els.speedSlider.addEventListener('input', (e) => setSpeed(parseFloat(e.target.value)));
    els.speedBtn.addEventListener('wheel', speedWheel, { passive: false });
    els.speedSlider.addEventListener('wheel', speedWheel, { passive: false });

    // ── Layout switching: purely driven by the window size ──────────────────
    const isSmall = () => {
        // a minimised window can report 0 x 0: keep whatever layout we had
        if (!window.innerWidth || !window.innerHeight) return active;
        return window.innerWidth < cfg.breakpoint.width || window.innerHeight < cfg.breakpoint.height;
    };
    let active = false;
    let poll = null;
    let raf = 0;

    function apply() {
        const mini = isSmall();
        if (mini === active) return;
        active = mini;
        root.classList.toggle('scmp-on', mini);
        document.documentElement.classList.toggle('scmp-mini', mini);
        if (mini) {
            pixelBg.wake();
            artTiles.wake();
            cur = {}; painted = {}; shown = null; target = null;
            volumeOwned = false;
            adoptVolume();
            tick();
            poll = setInterval(tick, 400);
        } else {
            clearInterval(poll);
            pointer = null;
            paintReveal();
            setPanel(null);
            closeSpeed();
            volumeOwned = false;
        }
    }
    function onResize() {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(apply);
    }
    // Minimising stops painting and throttles timers. When the window comes back: re-check the size,
    // finish or drop any half-run animation, refresh from the player and nudge Chromium to repaint.
    function onVisible() {
        if (document.hidden) return;
        apply();
        if (!active) return;
        pixelBg.wake();
        artTiles.wake();
        if (swapping) abortSwap();
        tick();
        root.style.opacity = '0.999';
        requestAnimationFrame(() => { root.style.opacity = ''; });
    }

    document.querySelectorAll('audio, video').forEach(trackMedia);
    paintKnob();
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    apply();
    startPending();

    // Called by the host when the plugin is disabled.
    window['__scrpc_cleanup_' + cfg.pluginId] = function () {
        clearInterval(poll);
        clearInterval(pendingTimer);
        cancelAnimationFrame(raf);
        cancelAnimationFrame(revealRaf);
        pixelBg.destroy();
        artTiles.destroy();
        window.removeEventListener('resize', onResize);
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
        disposed = true;
        if (perfObs) perfObs.disconnect();
        if (HTMLMediaElement.prototype.play === patchedPlay) HTMLMediaElement.prototype.play = realPlay;
        if (patchedTimeGet) {
            const nowDesc = Object.getOwnPropertyDescriptor(timeProto, 'currentTime');
            if (nowDesc && nowDesc.get === patchedTimeGet) Object.defineProperty(timeProto, 'currentTime', timeDesc);
        }
        media.forEach((el) => el.removeEventListener('volumechange', onMediaVolume));
        media.clear();
        clearTimeout(flashTimer);
        stopQueue();
        if (window.fetch === patchedFetch) window.fetch = realFetch;
        if (XMLHttpRequest.prototype.open === patchedOpen) XMLHttpRequest.prototype.open = realOpen;
        if (XMLHttpRequest.prototype.setRequestHeader === patchedSetHeader) XMLHttpRequest.prototype.setRequestHeader = realSetHeader;
        root.remove();
        style.remove();
        document.documentElement.classList.remove('scmp-mini');
        delete window.__miniPlayerLoaded;
        delete window['__scrpc_cleanup_' + cfg.pluginId];
    };
}

// ─── Plugin entry ───────────────────────────────────────────────────────────
module.exports = {
    onEnable() {
        const electron = getElectron();
        if (!electron) {
            console.warn('[mini-player] Electron APIs unavailable here; the window won\'t be allowed to shrink below its normal minimum size.');
            return;
        }
        const wins = electron.BrowserWindow.getAllWindows();
        const main = wins.find((w) => /soundcloud\.com/.test(w.webContents.getURL())) || wins[0];
        if (main) {
            attach(main);
        } else if (electron.app) {
            createdHandler = (_event, win) => attach(win);
            electron.app.once('browser-window-created', createdHandler);
        }
    },

    onDisable() {
        detachAll(getElectron());
    },

    // Kept so the host can call every hook; the page reads track state from the DOM itself.
    onTrackChange() {},
    onThemeChange() {},

    contentScript() {
        const pageCfg = {
            pluginId: CFG.pluginId,
            breakpoint: CFG.breakpoint,
            topInset: CFG.topInset,
            speedPlugin: detectSpeedPlugin(),
        };
        return '(' + pageScript.toString() + ')(' + JSON.stringify(pageCfg) + ');';
    },
};
