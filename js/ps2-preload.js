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
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(blob, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
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

    function getState(gameId) {
        return downloads.get(gameId) || { state: 'idle' };
    }

    function onChange(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
    }

    window.ArcadePs2Preload = {
        startPreload,
        getInitialState,
        getState,
        onChange,
    };
})();
