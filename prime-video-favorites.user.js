// ==UserScript==
// @name         Prime Video Live TV - Favorites Only
// @namespace    https://github.com/gearheaded
// @version      0.7.1
// @description  Adds a favorites-only view to the Prime Video Live TV guide in the browser
// @match        https://www.primevideo.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    // ######## Config
    const CACHE_KEY = 'pvfav.cache.v1';
    const ENABLED_KEY = 'pvfav.enabled';
    const THUMBS_KEY = 'pvfav.thumbs';
    const WINDOW_MIN = 180;              // timeline span shown, in minutes
    const STALE_SNAPSHOT_MS = 3 * 3600e3; // guide snapshot older than this counts as stale
    const REFRESH_GUARD_MS = 30 * 60e3;  // never background-refresh more often than this
    const DATA_LOW_MS = 60 * 60e3;       // stale if any favorite's schedule ends within this
    const DATA_CRITICAL_MS = 15 * 60e3;  // reload even while you're active if data ends this soon
    const IDLE_MS = 5 * 60e3;            // "not using the page" after this long without input
    const RELOAD_GUARD_MS = 30 * 60e3;   // never auto-reload more often than this
    const RELOAD_KEY = 'pvfav.lastAutoReload';
    const PAGE_DELAY_MS = 150;           // delay between pagination requests
    const UNDO_MS = 8000;                // how long a removed favorite stays as an Undo strip
    const NOW_COL_PX = 220;              // with pictures on, every row reserves this much for "on now"
    const LOG = (...a) => console.log('[pvfav]', ...a);

    // ######## State
    let favs = [];                       // [{ id, name, logo, url, schedule: [{ start, end, title }] }]
    let order = [];                      // favorite station ids in display order
    let actions = new Map();             // station id -> playbackAction (memory only - holds expiring tokens)
    let favMeta = new Map();             // station id -> { csrfToken, itemAnalytics } for un/re-favoriting (memory only)
    const removing = new Map();          // station id -> { timer, failed } while the Undo strip is showing
    let lastScan = 0;
    let scanDurMs = 0;
    const pageLoadedAt = Date.now();
    let snapshotAt = pageLoadedAt;       // when the data we last scanned from was taken (cached)
    let lastRefreshTry = 0;
    let lastInput = Date.now();
    let scanning = false;
    let scanStatus = '';
    let scannedStore = null;
    let panel = null;

    // ######## Storage helpers
    const enabled = () => {
        try { return localStorage.getItem(ENABLED_KEY) !== '0'; } catch { return true; }
    };
    const thumbsOn = () => {
        try { return localStorage.getItem(THUMBS_KEY) !== '0'; } catch { return true; }
    };
    const setThumbs = on => {
        try { localStorage.setItem(THUMBS_KEY, on ? '1' : '0'); } catch {}
    };
    const setEnabled = on => {
        try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch {}
    };
    const loadCache = () => {
        try {
            const c = JSON.parse(localStorage.getItem(CACHE_KEY));
            if (Array.isArray(c?.favs)) {
                favs = c.favs;
                order = c.order ?? favs.map(f => f.id);
                lastScan = c.ts ?? 0;
                scanDurMs = c.dur ?? 0;
                snapshotAt = c.snap ?? c.ts ?? 0;   // cached guide is as old as its snapshot, not "now"
            }
        } catch {}
    };
    const saveCache = () => {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: lastScan, dur: scanDurMs, snap: snapshotAt, order, favs })); } catch {}
    };

    // ######## Small utilities
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const decode = s => {
        const t = document.createElement('textarea');
        t.innerHTML = s ?? '';
        return t.value;
    };
    const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const fmtLeft = ms => {
        const m = Math.max(1, Math.round(ms / 60000));
        return m >= 60 ? `${Math.floor(m / 60)}hr ${m % 60}min left` : `${m} min left`;
    };
    const h = (tag, attrs = {}, ...kids) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;
            if (k === 'style') el.style.cssText = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v);
        }
        for (const k of kids.flat()) if (k != null) el.append(k);
        return el;
    };

    // ######## React fiber access
    const fiberOf = el => {
        if (!el) return null;
        const k = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
        return k ? el[k] : null;
    };

    const findApi = () => {
        const anchor = document.querySelector('[data-testid="station-carousel"]');
        let paginate = null, store = null, onPlay = null;
        for (let f = fiberOf(anchor); f && !(paginate && store && onPlay); f = f.return) {
            const v = f.memoizedProps?.value;
            if (!paginate && typeof v?.paginateContainer === 'function') paginate = v.paginateContainer;
            if (!onPlay && typeof v?.onPlay === 'function') onPlay = v.onPlay;
            if (!store && typeof v?.getState === 'function') {
                try { if (v.getState()?.preparations) store = v; } catch {}
            }
        }
        return paginate && store ? { paginate, store, onPlay } : null;
    };

    const blockTitleOf = el => {
        for (let f = fiberOf(el), d = 0; f && d < 40; f = f.return, d++) {
            const p = f.memoizedProps;
            if (p && typeof p === 'object' && 'blockTitle' in p) return p.blockTitle;
        }
        return null;
    };

    // ######## Find Amazon's "Your stations" section element
    const findYourStationsEl = () => {
        const marked = document.querySelector('[data-pvfav="ys"]');
        if (marked) return marked;
        for (const c of document.querySelectorAll('[data-testid="epg-container"]')) {
            if (blockTitleOf(c.querySelector('[data-testid="station-carousel"]')) === 'Your stations') {
                c.setAttribute('data-pvfav', 'ys');
                return c;
            }
        }
        return null;
    };

    // ######## Data shaping
    const imgUrl = v => typeof v === 'string' ? v : (v?.url ?? v?.src ?? v?.uri ?? null);
    const toFav = e => ({
        id: e.station.id,
        name: decode(e.station.name),
        logo: e.station.logo,
        url: e.playbackAction?.fallbackUrl ?? null,
        schedule: (e.station.schedule ?? []).map(p => ({
            start: p.start,
            end: p.end,
            title: decode(p.metadata?.title ?? ''),
            series: p.metadata?.hideSeriesTitle ? '' : decode(p.metadata?.seriesTitle ?? ''),
            image: imgUrl(p.metadata?.image)
        }))
    });

    // ######## Stable order: existing favorites keep their place, new ones go to the end
    // (Amazon's Your stations order shifts over time - Recently Watched pulls stations out and
    // puts them back, and watch history may affect it - that shouldn't reshuffle the panel)
    const mergeOrder = (current, prev) => {
        const now = new Set(current);
        const kept = prev.filter(id => now.has(id));
        const keptSet = new Set(kept);
        return [...kept, ...current.filter(id => !keptSet.has(id))];
    };

    // ######## Fresh guide snapshot from the page's server-side hydration JSON (no reload)
    const fetchSnapshot = async () => {
        const res = await fetch(location.pathname, { credentials: 'include' });
        if (!res.ok) throw new Error(`snapshot fetch failed: HTTP ${res.status}`);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const node = doc.getElementById('dv-web-page-hydration-data');
        if (!node) throw new Error('hydration data not found in fetched page');
        const cs = JSON.parse(node.textContent)?.init?.preparations?.body?.containers;
        if (!Array.isArray(cs)) throw new Error('unexpected hydration data shape');
        return cs;
    };

    // ######## Full scan: seed from a snapshot (store or fetched), paginate from 0 with its token
    const scan = async (api, snapshot = null) => {
        if (scanning || !api) return false;
        scanning = true;
        const scanStart = Date.now();
        try {
            const cs = snapshot ?? api.store.getState().preparations.body.containers;
            const c = cs.find(x => x.title === 'Your stations');
            const rw = cs.find(x => x.title === 'Recently watched');
            if (!c) throw new Error('"Your stations" container not found in snapshot');

            const seen = new Map();
            const add = e => {
                const id = e?.station?.id;
                if (id && !seen.has(id)) seen.set(id, e);
            };
            c.entities?.forEach(add);

            const total = c.estimatedTotal ?? 0;
            let token = c.paginationServiceToken;
            let start = 0;
            let pages = 0;
            while (token && pages < 300) {
                const r = await api.paginate({
                    paginationTargetId: c.paginationTargetId,
                    serviceToken: token,
                    startIndex: start,
                    journeyIngressContext: c.journeyIngressContext
                });
                r.entities?.forEach(add);
                pages++;
                scanStatus = `Updating... ${seen.size}/${total || '?'}`;
                renderStatus();

                const nt = r.pagination?.queryParameters?.serviceToken;
                if (nt) token = nt;
                if (!r.hasMoreItems || !r.entities?.length || r.startIndex <= start) break;
                start = r.startIndex;
                await sleep(PAGE_DELAY_MS);
            }

            // ######## Favorites in Amazon's order, plus any only present in Recently watched
            const favEntities = new Map();
            for (const [id, e] of seen) if (e.feedbackAction?.isFavorite) favEntities.set(id, e);
            const fresh = [...favEntities.keys()];
            const extras = [];
            for (const e of rw?.entities ?? []) {
                const id = e?.station?.id;
                if (id && e.feedbackAction?.isFavorite && !favEntities.has(id)) {
                    favEntities.set(id, e);
                    extras.push(id);
                }
            }
            if (!favEntities.size) throw new Error(`scan found 0 favorites in ${seen.size} stations`);
            if (total && seen.size < total * 0.95) {
                throw new Error(`incomplete scan: ${seen.size}/${total} stations - keeping cached favorites`);
            }

            order = mergeOrder([...fresh, ...extras], order);
            favs = order.map(id => toFav(favEntities.get(id)));
            actions = new Map(order.map(id => [id, favEntities.get(id).playbackAction]).filter(([, pa]) => pa));
            favMeta = new Map(order.map(id => {
                const e = favEntities.get(id);
                return [id, { csrfToken: e.feedbackAction?.csrfToken, itemAnalytics: e.metrics?.csm?.itemAnalytics }];
            }));
            lastScan = Date.now();
            scanDurMs = lastScan - scanStart;
            snapshotAt = snapshot ? scanStart : pageLoadedAt;
            saveCache();
            scanStatus = '';
            LOG(`scan done in ${(scanDurMs / 1000).toFixed(1)}s${snapshot ? ' (background snapshot)' : ''}: ${pages} pages, ${seen.size} stations, ${favs.length} favorites`);
            return true;
        } catch (err) {
            scanStatus = 'Update failed - see console';
            console.warn('[pvfav]', err);
            return false;
        } finally {
            scanning = false;
            render();
        }
    };

    // ######## Rebuild Amazon's playback config (mirrors its internal playbackAction -> config converter)
    const buildPlayConfig = (pa, withEnvelope) => {
        const e = { ...pa, ...pa.playbackExperienceMetadata };
        const envelope = e.playbackEnvelope ?? e.envelope;
        const expiration = e.expiryTime ?? e.expiration;
        return {
            playbackUrl: e.fallbackUrl,
            fallbackUrl: e.appFallbackUrl,
            appPlaybackUrl: e.appPlaybackUrl,
            signInUrl: e.signInUrl,
            stayOnPage: true,
            playbackStatus: undefined,
            refMarker: undefined,
            contentConfig: {
                asin: e.channelId,
                videoType: e.videoMaterialType,
                trailer: false,
                position: e.resumeTime || 0,
                wallClockStartMs: e.wallClockStartMs,
                ref: e.refMarker,
                playbackEnvelope: withEnvelope && e.correlationId && envelope && expiration ? {
                    correlationId: e.correlationId,
                    envelope,
                    expiration,
                    playbackResourceType: e.playbackResourceType
                } : undefined,
                playbackExperiences: e.playbackExperiences,
                videoColorVariant: e.videoColorVariant,
                playerUISpec: e.playerUISpec
            }
        };
    };

    const envelopeValid = pa => {
        const m = pa?.playbackExperienceMetadata;
        const exp = m?.expiryTime ?? m?.expiration;
        return !!exp && exp - Date.now() > 60e3;
    };

    // ######## Amazon's favorites manager (what its heart buttons call), found via any rendered heart
    const findFavManager = () => {
        const isMgr = v => v && typeof v === 'object' && v.stations instanceof Map && typeof v.toggleFavorite === 'function';
        const seen = new WeakSet();
        const scanObj = (o, depth) => {
            if (!o || typeof o !== 'object' || seen.has(o) || depth > 4) return null;
            seen.add(o);
            if (isMgr(o)) return o;
            for (const k of Object.keys(o)) {
                if (k === 'children' || k.startsWith('_')) continue;
                let r = null; try { r = scanObj(o[k], depth + 1); } catch {}
                if (r) return r;
            }
            return null;
        };
        for (const btn of document.querySelectorAll('button[aria-pressed]')) {
            for (let f = fiberOf(btn), d = 0; f && d < 8; f = f.return, d++) {
                const m = scanObj(f.memoizedProps, 0);
                if (m) return m;
                for (let hk = f.memoizedState, i = 0; hk && i < 40; hk = hk.next, i++) {
                    const m2 = scanObj(hk.memoizedState, 0);
                    if (m2) return m2;
                }
            }
        }
        return null;
    };

    // ######## Set a station's favorite state through Amazon's manager; resolves to the final state
    const setFavorite = async (f, want) => {
        const mgr = findFavManager();
        const meta = favMeta.get(f.id);
        if (!mgr) throw new Error('favorites manager not found');
        if (!mgr.stations.has(f.id)) {
            if (!meta?.csrfToken) throw new Error('no favorite token for this station yet - wait for the scan');
            mgr.stations.set(f.id, { csrfToken: meta.csrfToken, isFavorite: !want });
        }
        // ######## toggleFavorite flips state, so only call it when the state actually differs
        if (mgr.stations.get(f.id).isFavorite !== want) {
            const origClick = mgr.emitClickstream;
            mgr.emitClickstream = function (...a) { try { return origClick?.apply(this, a); } catch {} };
            try { mgr.toggleFavorite(f.id, f.name, meta?.itemAnalytics, 'mouse'); }
            finally { mgr.emitClickstream = origClick; }
        }
        // ######## Wait for Amazon's request to settle (it reverts state on failure)
        for (let i = 0; i < 50 && mgr.inFlight?.has(f.id); i++) await sleep(200);
        return mgr.stations.get(f.id)?.isFavorite;
    };

    const finishRemoval = id => {
        removing.delete(id);
        order = order.filter(x => x !== id);
        favs = favs.filter(x => x.id !== id);
        saveCache();
        render();
    };

    const unfavorite = async f => {
        if (removing.has(f.id)) return;
        const entry = { timer: null, failed: false, index: order.indexOf(f.id), fav: f };
        removing.set(f.id, entry);
        render();
        try {
            const state = await setFavorite(f, false);
            if (state !== false) throw new Error('Amazon kept it as a favorite');
        } catch (err) {
            console.warn('[pvfav] unfavorite failed:', err);
            entry.failed = true;
            removing.delete(f.id);
            scanStatus = `Couldn't remove ${f.name} - see console`;
            render();
            return;
        }
        if (removing.get(f.id) === entry) entry.timer = setTimeout(() => finishRemoval(f.id), UNDO_MS);
    };

    const undoUnfavorite = async f => {
        const entry = removing.get(f.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        removing.delete(f.id);
        render();
        try {
            const state = await setFavorite(f, true);
            if (state !== true) throw new Error('Amazon did not re-add it');
            if (!order.includes(f.id)) {
                const at = Math.min(Math.max(entry.index, 0), order.length);
                order.splice(at, 0, f.id);
                favs = order.map(id => id === f.id ? entry.fav : favs.find(x => x.id === id)).filter(Boolean);
                saveCache();
                render();
            }
        } catch (err) {
            console.warn('[pvfav] undo failed:', err);
            scanStatus = `Couldn't re-add ${f.name} - see console`;
            finishRemoval(f.id);
        }
    };

    // ######## Start a station through Amazon's own player
    const play = async id => {
        const api = findApi();
        if (!api?.onPlay) {
            scanStatus = 'Player not available - try reloading';
            renderStatus();
            return;
        }
        let pa = actions.get(id);
        if (!pa) {
            // ######## Panel drawn from cache and the scan hasn't finished yet
            scanStatus = 'Loading stream info...';
            renderStatus();
            if (!scanning) scan(api);
            while (scanning) await sleep(200);
            pa = actions.get(id);
            if (!pa) {
                scanStatus = 'No stream info for this station';
                renderStatus();
                return;
            }
        }
        const valid = envelopeValid(pa);
        if (!valid) LOG('playback envelope expired - launching without it');
        api.onPlay(buildPlayConfig(pa, valid));
    };

    // ######## Styles
    const ensureStyle = () => {
        if (document.getElementById('pvfav-style')) return;
        document.head.append(h('style', { id: 'pvfav-style' }, `
            .pvfav-hidden { display: none !important; }
            .pvfav-logo, .pvfav-prog { cursor: pointer; }
            #pvfav-panel { margin: 24px 0; color: #fff; font-family: inherit; }
            .pvfav-head { display: flex; align-items: center; gap: 12px; margin: 0 0 12px; }
            .pvfav-head h2 { font-size: 20px; font-weight: 700; margin: 0; }
            .pvfav-status { margin-left: auto; opacity: .6; font-size: 13px; }
            .pvfav-toggle { background: rgba(255,255,255,.16); color: #fff; border: 1px solid rgba(255,255,255,.35);
                border-radius: 999px; padding: 6px 16px; cursor: pointer; font: inherit; font-size: 14px; font-weight: 600; }
            .pvfav-mini { background: none; border: 0; color: #fff; opacity: .6; cursor: pointer;
                font: inherit; font-size: 13px; padding: 4px 6px; }
            .pvfav-mini:hover { opacity: 1; text-decoration: underline; }
            .pvfav-toggle:hover { background: rgba(255,255,255,.28); border-color: rgba(255,255,255,.6); }
            .pvfav-ticks { position: relative; height: 20px; margin-left: 136px; font-size: 12px; opacity: .6; overflow: hidden; }
            .pvfav-ticks span { position: absolute; top: 0; padding-left: 4px; border-left: 1px solid rgba(255,255,255,.3); white-space: nowrap; }
            .pvfav-row { display: flex; gap: 8px; height: 76px; margin-bottom: 8px; }
            .pvfav-logo { flex: 0 0 128px; display: flex; align-items: center; justify-content: center;
                background: rgba(255,255,255,.08); border-radius: 6px; color: #fff; text-decoration: none;
                font-size: 12px; text-align: center; }
            .pvfav-logo img { max-width: 104px; max-height: 52px; }
            .pvfav-track { position: relative; flex: 1; overflow: hidden; }
            .pvfav-prog { position: absolute; top: 0; bottom: 0; box-sizing: border-box;
                border-right: 6px solid transparent; background-clip: padding-box;
                background-color: rgba(255,255,255,.08); border-radius: 6px; padding: 6px 10px 12px;
                color: #fff; text-decoration: none; overflow: hidden;
                display: flex; flex-direction: column; justify-content: center; }
            .pvfav-prog.current { background-color: rgba(255,255,255,.14); }
            .pvfav-prog.has-thumb { flex-direction: row; justify-content: flex-start; align-items: stretch;
                padding: 0; container-type: inline-size; }
            .pvfav-thumb { flex: 0 0 auto; height: 100%; aspect-ratio: 16 / 9; object-fit: cover;
                border-radius: 6px 0 0 6px; background: rgba(255,255,255,.05); }
            .pvfav-info { position: relative; min-width: 0; flex: 1; display: flex; flex-direction: column;
                justify-content: center; }
            .pvfav-prog.has-thumb .pvfav-info { padding: 6px 10px 12px; }
            .pvfav-prog.has-thumb .pvfav-bar { left: 10px; bottom: 7px; width: calc(100% - 20px); }
            @container (max-width: 200px) { .pvfav-thumb { display: none; } }

            .pvfav-prog:hover { background-color: rgba(255,255,255,.24); }
            .pvfav-meta { font-size: 12px; opacity: .75; white-space: nowrap; }
            .pvfav-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .pvfav-episode { font-size: 12px; opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .pvfav-meta, .pvfav-title, .pvfav-episode { line-height: 1.3; }
            .pvfav-bar { position: absolute; left: 0; bottom: -5px; height: 3px; width: 100%; max-width: 120px;
                background: rgba(255,255,255,.2); border-radius: 2px; }
            .pvfav-bar i { display: block; height: 100%; background: #e5243b; border-radius: 2px; }
            .pvfav-empty { opacity: .6; font-size: 14px; padding: 12px 0; }
            .pvfav-logo { position: relative; }
            .pvfav-heart { position: absolute; top: 4px; left: 4px; width: 22px; height: 22px; padding: 0;
                display: flex; align-items: center; justify-content: center; background: none; border: 0;
                color: #fff; cursor: pointer; opacity: 0; border-radius: 50%; transition: opacity 150ms ease; }
            .pvfav-logo:hover .pvfav-heart, .pvfav-heart:focus-visible { opacity: .85; }
            .pvfav-heart:hover { opacity: 1; background: rgba(0,0,0,.35); }
            .pvfav-heart svg { width: 14px; height: 14px; }
            .pvfav-undo { display: flex; align-items: center; gap: 14px; height: 36px; margin-bottom: 8px;
                padding: 0 14px; border-radius: 6px; background: rgba(255,255,255,.06); font-size: 14px; }
            .pvfav-undo span { opacity: .75; }
            .pvfav-undo button { background: none; border: 0; color: #fff; font: inherit; font-weight: 700;
                cursor: pointer; text-decoration: underline; padding: 0; }
        `));
    };

    // ######## Rendering
    const idleStatus = () => lastScan
        ? `Updated ${fmtTime(lastScan)}${scanDurMs ? ` - scan took ${Math.round(scanDurMs / 1000)}s` : ''}`
        : '';
    const renderStatus = () => {
        const s = panel?.querySelector('.pvfav-status');
        if (s) s.textContent = scanStatus || idleStatus();
    };

    // ######## Map a 0-1 time fraction to a CSS position; the "now" strip offsets everything equally
    const nowCol = () => thumbsOn() ? NOW_COL_PX : 0;
    const xAt = (frac, col) => col ? `calc(${col}px + (100% - ${col}px) * ${frac})` : `${frac * 100}%`;

    const renderRow = (f, now, span) => {
        const winEnd = now + span;
        const thumbs = thumbsOn();
        const col = nowCol();
        const progs = f.schedule
            .filter(p => p.end > now && p.start < winEnd)
            .map(p => {
                const fl = (Math.max(p.start, now) - now) / span;
                const fr = (Math.min(p.end, winEnd) - now) / span;
                const leftCss = p.start <= now ? '0px' : xAt(fl, col);
                const rightCss = xAt(fr, col);
                const current = p.start <= now;
                const pct = current ? Math.min(100, (now - p.start) / (p.end - p.start) * 100) : 0;
                const thumb = current && thumbs && p.image;
                const hasSeries = !!p.series && p.series !== p.title;
                const cell = h('div', {
                        class: `pvfav-prog${current ? ' current' : ''}${thumb ? ' has-thumb' : ''}`,
                        role: 'button',
                        onclick: () => play(f.id),
                        title: `${hasSeries ? `${p.series}\n` : ''}${p.title}\n${fmtTime(p.start)} - ${fmtTime(p.end)}`,
                        style: `left:${leftCss};width:calc(${rightCss} - ${leftCss})`
                    },
                    thumb ? h('img', { class: 'pvfav-thumb', src: p.image, alt: '', loading: 'lazy' }) : null,
                    h('div', { class: 'pvfav-info' },
                        h('span', { class: 'pvfav-meta' }, current ? fmtLeft(p.end - now) : fmtTime(p.start)),
                        h('span', { class: 'pvfav-title' }, hasSeries ? p.series : p.title),
                        hasSeries ? h('span', { class: 'pvfav-episode' }, p.title) : null,
                        current ? h('span', { class: 'pvfav-bar' }, h('i', { style: `width:${pct}%` })) : null
                    )
                );
                return cell;
            });

        if (removing.has(f.id)) {
            return h('div', { class: 'pvfav-undo' },
                h('span', {}, `Removed ${f.name}`),
                h('button', { onclick: () => undoUnfavorite(f) }, 'Undo'));
        }

        const heart = h('button', {
            class: 'pvfav-heart',
            title: 'Remove from favorites',
            'aria-label': `Remove ${f.name} from favorites`,
            onclick: ev => { ev.stopPropagation(); unfavorite(f); }
        });
        heart.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.9 4.5 6.6 4.1c2.1-.2 3.9.9 5.4 2.7 1.5-1.8 3.3-2.9 5.4-2.7 3.7.4 5.7 4.3 4.2 7.7C19.5 16.4 12 21 12 21z"/></svg>';

        return h('div', { class: 'pvfav-row' },
            h('div', { class: 'pvfav-logo', role: 'button', title: f.name, onclick: () => play(f.id) },
                f.logo ? h('img', { src: f.logo, alt: f.name }) : f.name,
                heart),
            h('div', { class: 'pvfav-track' },
                progs.length ? progs : h('div', { class: 'pvfav-empty' }, 'No schedule data'))
        );
    };

    const render = () => {
        if (!panel) return;
        const on = enabled();
        const now = Date.now();
        const span = WINDOW_MIN * 60e3;

        // ######## Header
        const head = h('div', { class: 'pvfav-head' },
            h('h2', {}, on ? 'Favorites' : 'Your stations'),
            h('button', {
                class: 'pvfav-toggle',
                onclick: () => { setEnabled(!enabled()); render(); ensure(); }
            }, on ? 'Show all channels' : 'Show favorites only'),
            on ? h('button', {
                class: 'pvfav-mini',
                onclick: () => { setThumbs(!thumbsOn()); render(); }
            }, thumbsOn() ? 'Hide pictures' : 'Show pictures') : null,
            h('span', { class: 'pvfav-status' }, scanStatus || idleStatus())
        );
        panel.replaceChildren(head);
        if (!on) return;

        if (!favs.length) {
            panel.append(h('div', { class: 'pvfav-empty' }, scanning ? 'Loading favorites...' : 'No favorites found yet.'));
            return;
        }

        // ######## Half-hour ticks across the timeline
        const ticks = h('div', { class: 'pvfav-ticks' });
        const step = 30 * 60e3;
        for (let t = Math.ceil(now / step) * step; t < now + span; t += step) {
            ticks.append(h('span', { style: `left:${xAt((t - now) / span, nowCol())}` }, fmtTime(t)));
        }
        panel.append(ticks, ...favs.map(f => renderRow(f, now, span)));
    };

    // ######## Keep panel inserted and Amazon's section hidden as React re-renders
    const ensure = () => {
        if (!location.pathname.includes('livetv')) return;
        const ys = findYourStationsEl();
        if (!ys || !ys.parentNode) return;

        ensureStyle();
        if (!panel) {
            panel = h('section', { id: 'pvfav-panel' });
            render();
        }
        if (panel.nextElementSibling !== ys) ys.parentNode.insertBefore(panel, ys);
        ys.classList.toggle('pvfav-hidden', enabled());

        const api = findApi();
        if (api && api.store !== scannedStore) {
            scannedStore = api.store;
            scan(api);
        }
    };

    // ######## Boot
    loadCache();
    let pending = null;
    new MutationObserver(() => {
        if (pending) return;
        pending = setTimeout(() => { pending = null; ensure(); }, 250);
    }).observe(document.body, { childList: true, subtree: true });

    // ######## Keep data fresh: background snapshot first, page reload only as a fallback
    const videoPlaying = () => [...document.querySelectorAll('video')]
        .some(v => !v.paused && !v.ended && v.readyState > 2);

    const earliestDataEnd = () => {
        const ends = favs.map(f => f.schedule.at(-1)?.end).filter(Boolean);
        return ends.length ? Math.min(...ends) : 0;
    };

    const staleness = () => {
        const now = Date.now();
        const dataEnd = earliestDataEnd();
        return {
            dataLow: !!(favs.length && dataEnd && dataEnd - now < DATA_LOW_MS),
            critical: !!(favs.length && dataEnd && dataEnd - now < DATA_CRITICAL_MS),
            snapshotOld: now - snapshotAt > STALE_SNAPSHOT_MS
        };
    };

    const maybeRefresh = async reason => {
        if (!location.pathname.includes('livetv') || scanning) return;
        const { dataLow, snapshotOld } = staleness();
        if (!dataLow && !snapshotOld) return;
        if (Date.now() - lastRefreshTry < REFRESH_GUARD_MS) return;
        lastRefreshTry = Date.now();

        LOG(`background refresh (${reason}): ${dataLow ? 'schedule data running out' : 'snapshot is old'}`);
        let ok = false;
        try {
            const snap = await fetchSnapshot();
            ok = await scan(findApi(), snap);
        } catch (err) {
            console.warn('[pvfav] background refresh failed:', err);
        }
        if (!ok) maybeReload(reason);
    };

    const maybeReload = reason => {
        if (!location.pathname.includes('livetv') || scanning || videoPlaying()) return;
        const now = Date.now();
        const { dataLow, critical, snapshotOld } = staleness();
        if (!dataLow && !snapshotOld) return;

        // ######## Don't yank the page out from under you unless data is about to run out
        const idle = document.hidden || now - lastInput > IDLE_MS || reason === 'visible';
        if (!idle && !critical) return;

        let last = 0;
        try { last = +sessionStorage.getItem(RELOAD_KEY) || 0; } catch {}
        if (now - last < RELOAD_GUARD_MS) return;
        try { sessionStorage.setItem(RELOAD_KEY, String(now)); } catch {}

        LOG(`fallback reload (${reason}): ${dataLow ? 'schedule data running out' : 'snapshot is old'}`);
        location.reload();
    };

    for (const ev of ['pointerdown', 'keydown', 'wheel']) {
        addEventListener(ev, () => { lastInput = Date.now(); }, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) maybeRefresh('visible');
    });

    setInterval(() => {
        render();
        maybeRefresh('timer');
    }, 60e3);

    ensure();
})();