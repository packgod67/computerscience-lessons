// ===== PS2 ROM preload manager =====
// Lets users download a PS2 ROM in the background from the home page,
// so by the time they click the card the emulator boots instantly from
// IndexedDB instead of staring at a 2-5 minute progress bar.
//
// Architecture:
// - PS2 game cards (rom: 'ps2') get a "📥 Pre-download" button via app.js
// - Click → enqueues a download here
// - Module fetches the ROM (parallel Range requests, same logic as /play/)
// - Writes to the SAME IndexedDB store /play/ reads from, keyed by the
//   exact worker URL /play/'s loader expects (so cache HIT is guaranteed
//   on the next click).
// - Emits state change events so the card UI can show progress / Ready
//   without the cards code knowing the internals.
//
// Limitations:
// - Downloads are tied to the home page session — navigating to
//   play.html for a different game cancels them. Background Fetch API
//   would survive nav but is Chrome-only and adds complexity; we'll
//   add it later if there's demand.
// - Storage quota: each PS2 ISO is 1.8-5.3 GB. Browsers usually allow
//   ~60% of free disk. If the write fails (quota exceeded), state goes
//   to 'error' and the button can be retried.

(function () {
    const WORKER = 'https://arcad-groq.gatabanumai.workers.dev/rom';
    const DB_NAME = 'arcade-play-roms';   // SAME db /play/ uses
    const STORE = 'roms';
    // Higher parallel = better chance of beating archive.org's per-connection
    // throttle. 4 is the sweet spot — 8+ tends to trip per-IP limits.
    const PARALLEL = 4;

    // gameId → { state, pct, received, total, speed, error }
    const downloads = new Map();
    const listeners = new Set();

    function emit(gameId) {
        const state = downloads.get(gameId);
        for (const cb of listeners) {
            try { cb(gameId, state); } catch {}
        }
    }
    function setState(gameId, patch) {
        const prev = downloads.get(gameId) || {};
        downloads.set(gameId, { ...prev, ...patch });
        emit(gameId);
    }

    // ─── IDB helpers (mirror /play/index.html's) ───────────────────────
    function openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) {
                    req.result.createObjectStore(STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async function cacheHas(key) {
        try {
            const db = await openDb();
            return await new Promise((resolve) => {
                const tx = db.transaction(STORE, 'readonly');
                const req = tx.objectStore(STORE).getKey(key);
                req.onsuccess = () => resolve(req.result !== undefined);
                req.onerror = () => resolve(false);
            });
        } catch { return false; }
    }
    async function cachePut(key, blob) {
        // PS2 ISOs are 2-4GB. Default per-origin IndexedDB quotas can
        // be as low as 1-2GB on some browsers. Request persistent
        // storage first — sites granted persistence get a much larger
        // quota share (Chrome: up to 60% of available disk).
        try {
            if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
                await navigator.storage.persist();
            }
        } catch {}

        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(blob, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    // Estimate available IDB quota and how much we'd need. Used to give
    // the user a clear "you don't have room for this" message before we
    // burn an hour streaming a 3GB ROM.
    async function checkQuotaForBytes(bytesNeeded) {
        if (!navigator.storage?.estimate) return { ok: true, free: Infinity };
        try {
            const e = await navigator.storage.estimate();
            const free = (e.quota || 0) - (e.usage || 0);
            return { ok: free >= bytesNeeded, free, quota: e.quota, usage: e.usage };
        } catch {
            return { ok: true, free: Infinity };
        }
    }

    // ─── Build the same worker URL /play/'s loader receives ───────────
    function workerUrlFor(archiveRomUrl) {
        return `${WORKER}?src=${encodeURIComponent(archiveRomUrl)}`;
    }

    // ─── Parallel Range downloader ─────────────────────────────────────
    // Same approach /play/ uses: probe with a 2-byte Range to get total
    // size + confirm range support, then split into N parallel chunks.
    async function downloadBlob(url, onProgress) {
        // Probe
        const probe = await fetch(url, { mode: 'cors', headers: { Range: 'bytes=0-1' } });
        if (probe.status !== 206) {
            probe.body?.cancel().catch(() => {});
            throw new Error('range not supported');
        }
        const cr = probe.headers.get('content-range') || '';
        const total = parseInt((cr.match(/\/(\d+)$/) || [])[1] || '0', 10);
        probe.body?.cancel().catch(() => {});
        if (!total) throw new Error('no total size');

        const chunkSize = Math.ceil(total / PARALLEL);
        const buffers = new Array(PARALLEL);
        let received = 0;

        const WIN = 2000;
        const samples = [{ t: performance.now(), bytes: 0 }];
        function tick() {
            const now = performance.now();
            samples.push({ t: now, bytes: received });
            while (samples.length > 1 && (now - samples[0].t) > WIN) samples.shift();
            const w0 = samples[0];
            const dt = (now - w0.t) / 1000;
            const speed = dt > 0.1 ? (received - w0.bytes) / dt : 0;
            onProgress?.(received, total, speed);
        }

        await Promise.all(Array.from({ length: PARALLEL }, async (_, i) => {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize - 1, total - 1);
            if (start > end) { buffers[i] = new Blob([]); return; }
            const resp = await fetch(url, {
                mode: 'cors',
                headers: { Range: `bytes=${start}-${end}` },
            });
            if (!resp.ok && resp.status !== 206) throw new Error('chunk HTTP ' + resp.status);
            const reader = resp.body.getReader();
            const chunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                tick();
            }
            buffers[i] = new Blob(chunks);
        }));

        return new Blob(buffers);
    }

    // ─── Public API ────────────────────────────────────────────────────
    async function getInitialState(gameId, archiveRomUrl) {
        // Already in flight?
        const live = downloads.get(gameId);
        if (live && (live.state === 'downloading' || live.state === 'saving')) return live;
        // Already cached?
        const key = workerUrlFor(archiveRomUrl);
        if (await cacheHas(key)) return { state: 'cached' };
        return { state: 'idle' };
    }

    // ─── Background Fetch API support (Chrome/Edge) ────────────────────
    // Lets the download survive page navigation — user can browse, click
    // other games, even close the tab, and the OS continues the fetch in
    // the background. On completion the SW writes to IDB and notifies any
    // open arcade tabs.
    let swReadyPromise = null;
    function ensureSw() {
        if (swReadyPromise) return swReadyPromise;
        if (!('serviceWorker' in navigator)) {
            return Promise.reject(new Error('no SW support'));
        }
        swReadyPromise = navigator.serviceWorker.register('/preload-sw.js', { scope: '/' })
            .then(() => navigator.serviceWorker.ready);
        return swReadyPromise;
    }

    function bgFetchSupported() {
        return 'serviceWorker' in navigator && 'BackgroundFetchManager' in self;
    }

    // Listen for SW → page messages so we can flip the chip to 'cached' /
    // 'error' when a backgrounded download finishes.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data || {};
            if (data.type === 'preload-cached') {
                // Map the worker URL back to a gameId via our active downloads.
                for (const [gid, st] of downloads.entries()) {
                    if (st && st._key === data.id) {
                        setState(gid, { state: 'cached' });
                        return;
                    }
                }
            } else if (data.type === 'preload-failed' || data.type === 'preload-aborted') {
                for (const [gid, st] of downloads.entries()) {
                    if (st && st._key === data.id) {
                        setState(gid, { state: 'error', error: data.error || 'aborted' });
                        return;
                    }
                }
            }
        });
    }

    async function trackBgFetch(gameId, key, bgFetch) {
        setState(gameId, {
            state: 'downloading',
            pct: 0,
            received: 0,
            total: bgFetch.downloadTotal || 0,
            speed: 0,
            _key: key,
            _backgrounded: true,
        });
        bgFetch.addEventListener('progress', () => {
            const total = bgFetch.downloadTotal || 0;
            const received = bgFetch.downloaded || 0;
            // BG fetch doesn't expose live speed — derive a moving average.
            const now = performance.now();
            const st = downloads.get(gameId) || {};
            const last = st._lastSample;
            let speed = st.speed || 0;
            if (last && (now - last.t) > 250) {
                speed = (received - last.bytes) / ((now - last.t) / 1000);
            }
            setState(gameId, {
                state: 'downloading',
                received,
                total,
                pct: total ? (received / total) * 100 : 0,
                speed,
                _key: key,
                _backgrounded: true,
                _lastSample: last && (now - last.t) <= 250 ? last : { t: now, bytes: received },
            });
        });
        // Final state transitions are handled via SW postMessage above —
        // this lets backgrounded fetches that complete after the user
        // closed the tab still flip to 'cached' on next visit.
    }

    async function startPreload(gameId, archiveRomUrl, displayName) {
        const live = downloads.get(gameId);
        if (live && (live.state === 'downloading' || live.state === 'saving')) {
            console.log('[ps2-preload] already running:', gameId);
            return;
        }
        const key = workerUrlFor(archiveRomUrl);

        if (await cacheHas(key)) {
            setState(gameId, { state: 'cached', _key: key });
            return;
        }

        // Try Background Fetch first — survives nav/tab close.
        if (bgFetchSupported()) {
            try {
                const reg = await ensureSw();
                // Pick up an existing fetch for this URL (resume after reload)
                let bg = await reg.backgroundFetch.get(key);
                if (!bg) {
                    // Probe for total size BEFORE starting BG fetch — passing
                    // downloadTotal lets the browser compute percentage and
                    // the progress event carries useful numbers. Without it
                    // we'd be stuck at 0% forever.
                    let downloadTotal = 0;
                    try {
                        const probe = await fetch(key, { mode: 'cors', headers: { Range: 'bytes=0-1' } });
                        if (probe.status === 206) {
                            const cr = probe.headers.get('content-range') || '';
                            const m = cr.match(/\/(\d+)$/);
                            if (m) downloadTotal = parseInt(m[1], 10);
                        }
                        probe.body?.cancel().catch(() => {});
                    } catch (_) { /* fall through with 0 — UI handles it */ }

                    bg = await reg.backgroundFetch.fetch(key, [key], {
                        title: displayName || 'PS2 ROM',
                        downloadTotal,
                    });
                }
                console.log('[ps2-preload] background fetch started for', gameId, '(total:', bg.downloadTotal, ')');
                trackBgFetch(gameId, key, bg);
                return;
            } catch (e) {
                console.warn('[ps2-preload] BG fetch unavailable, falling back to in-page:', e);
            }
        }

        // Fallback: in-page download (Firefox/Safari, or BG fetch refused).
        setState(gameId, {
            state: 'downloading', pct: 0, received: 0, total: 0, speed: 0, _key: key,
        });
        let blob;
        try {
            blob = await downloadBlob(key, (received, total, speed) => {
                setState(gameId, {
                    state: 'downloading',
                    received,
                    total,
                    pct: total ? (received / total) * 100 : 0,
                    speed,
                    _key: key,
                });
            });
        } catch (e) {
            console.warn('[ps2-preload] download failed:', e);
            setState(gameId, { state: 'error', error: e.message, _key: key });
            return;
        }

        setState(gameId, { state: 'saving', _key: key });
        try {
            await cachePut(key, blob);
            setState(gameId, { state: 'cached', _key: key });
        } catch (e) {
            console.warn('[ps2-preload] cache write failed:', e);
            setState(gameId, { state: 'error', error: 'storage full', _key: key });
        }
    }

    // Cache a user-supplied File (manual download path). Same IDB key as
    // the auto-download flow so /play/'s loader picks it up identically.
    // The file picker accepts any .iso/.chd/.bin/.cso — we don't validate
    // contents, just trust the user dropped the right thing. /play/ will
    // surface a real error if Play! can't boot it.
    async function cacheUploadedFile(gameId, archiveRomUrl, file) {
        const key = workerUrlFor(archiveRomUrl);
        setState(gameId, { state: 'saving', _key: key });
        // Pre-flight: check that we have room for this file. Better to
        // tell the user "your browser only has 800 MB free and this is
        // a 3 GB game" than to half-write and IOError.
        try {
            const q = await checkQuotaForBytes(file.size);
            if (!q.ok) {
                const freeMB = Math.round((q.free || 0) / 1024 / 1024);
                const needMB = Math.round(file.size / 1024 / 1024);
                const msg = `Browser storage too small: you have ~${freeMB} MB free but this ROM is ${needMB} MB. Free up site data (DevTools → Application → Storage → Clear) or use a different browser.`;
                setState(gameId, { state: 'error', error: msg, _key: key });
                throw new Error(msg);
            }
        } catch (e) {
            // checkQuotaForBytes failure → fall through and try the
            // write anyway (no estimate API available).
            if (/storage too small/i.test(e?.message || '')) throw e;
        }
        try {
            await cachePut(key, file);
            setState(gameId, { state: 'cached', _key: key });
            return true;
        } catch (e) {
            console.warn('[ps2-preload] manual cache write failed:', e);
            // QuotaExceededError gets translated into something the user
            // can act on. Other DataErrors get a generic but clearer msg.
            const isQuota = /Quota|storage|exceed/i.test(e?.name || '') || /Quota|storage|exceed/i.test(e?.message || '');
            const msg = isQuota
                ? 'Your browser ran out of storage. Clear other site data or use Chrome with more free disk.'
                : `Save failed (${e?.name || 'IOError'}: ${e?.message || 'unknown'}). Try a different browser.`;
            setState(gameId, { state: 'error', error: msg, _key: key });
            throw e;
        }
    }

    function getState(gameId) {
        return downloads.get(gameId) || { state: 'idle' };
    }

    function onChange(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
    }

    window.ArcadePs2Preload = {
        startPreload,
        cacheUploadedFile,
        getInitialState,
        getState,
        onChange,
    };
})();
