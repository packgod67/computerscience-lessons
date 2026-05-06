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
                // Hit if any of these exists:
                //   ${key}        single-blob entry
                //   ${key}#meta   either chunked-IDB manifest or
                //                 OPFS-marker (both stored under the
                //                 same suffix; cacheGet disambiguates
                //                 by reading the marker's `opfs` flag)
                const a = tx.objectStore(STORE).getKey(key);
                const b = tx.objectStore(STORE).getKey(key + '#meta');
                let aDone = false, bDone = false, found = false;
                function maybeResolve() {
                    if (aDone && bDone) resolve(found);
                }
                a.onsuccess = () => { if (a.result !== undefined) found = true; aDone = true; maybeResolve(); };
                a.onerror   = () => { aDone = true; maybeResolve(); };
                b.onsuccess = () => { if (b.result !== undefined) found = true; bDone = true; maybeResolve(); };
                b.onerror   = () => { bDone = true; maybeResolve(); };
            });
        } catch { return false; }
    }
    // ─── OPFS path (preferred for large files) ─────────────────────
    // IndexedDB rejects multi-GB blob writes in Chrome with a generic
    // DataError even when there's plenty of free space — its
    // structured-clone serializer + blob storage path have hard caps.
    // OPFS (Origin Private File System) is designed for big files,
    // streams writes via WritableStream, and has its own larger quota.
    // Available in all modern browsers (Chrome 86+, Firefox 111+,
    // Safari 15.2+). We try OPFS first; fall back to IDB only if the
    // browser doesn't expose it or it errors.
    //
    // OPFS filenames can't contain '/' or '?' — we SHA-256 the key to
    // get a deterministic safe filename and remember the mapping in
    // IDB so cacheHas / cacheGet can find it.
    async function keyToOpfsName(key) {
        const bytes = new TextEncoder().encode(key);
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
        return 'ps2-' + hex.slice(0, 32);  // first 16 bytes = plenty unique
    }

    async function opfsAvailable() {
        return !!(navigator.storage && navigator.storage.getDirectory);
    }

    async function opfsPut(key, blob) {
        const root = await navigator.storage.getDirectory();
        const name = await keyToOpfsName(key);
        const handle = await root.getFileHandle(name, { create: true });
        const writer = await handle.createWritable();
        // Pipe the file straight through — never load the whole thing
        // into RAM. Works for files of any size the disk holds.
        await blob.stream().pipeTo(writer);
        // Drop a small marker in IDB so cacheHas/cacheGet know to look
        // in OPFS for this key rather than IDB.
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put({ opfs: true, name, size: blob.size, type: blob.type || 'application/octet-stream' }, key + '#meta');
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
    }

    // ─── IDB fallback path (small files + browsers without OPFS) ───
    // Files larger than this get sharded into chunks because Chrome's
    // single-blob IDB write fails around 2GB even when there's quota.
    const CHUNK_THRESHOLD = 1500 * 1024 * 1024;   // 1.5 GB
    const CHUNK_SIZE      =  256 * 1024 * 1024;   // 256 MB

    async function cachePut(key, blob) {
        // PS2 ISOs are 2-4GB. Default per-origin IndexedDB quotas can
        // be low. Request persistent storage first — sites granted
        // persistence get a much larger quota share (Chrome: up to 60%
        // of available disk).
        try {
            if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
                await navigator.storage.persist();
            }
        } catch {}

        // For files >1.5GB on browsers that support OPFS, write there
        // instead of IDB. OPFS handles multi-GB files cleanly — IDB
        // doesn't on Chrome regardless of chunking strategy.
        if (blob.size > CHUNK_THRESHOLD && await opfsAvailable()) {
            try {
                // Erase any prior IDB-stored version of this key so we
                // don't have stale single-blob OR chunked entries
                // lying around.
                const db = await openDb();
                await new Promise((resolve) => {
                    const tx = db.transaction(STORE, 'readwrite');
                    tx.objectStore(STORE).delete(key);
                    for (let i = 0; i < 32; i++) tx.objectStore(STORE).delete(key + '#' + i);
                    tx.oncomplete = resolve; tx.onerror = resolve;
                });
                await opfsPut(key, blob);
                return;
            } catch (e) {
                console.warn('[ps2-preload] OPFS write failed, falling back to IDB chunks:', e);
                // Fall through to IDB chunked path below
            }
        }

        // Small enough for one transaction → fast path.
        if (blob.size <= CHUNK_THRESHOLD) {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                // Clean up any prior chunked write under this key
                tx.objectStore(STORE).delete(key + '#meta');
                tx.objectStore(STORE).put(blob, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
            return;
        }

        // Large file: shard into chunks. Each chunk is its own IDB
        // entry — the browser stores them on disk independently, so
        // the 2GB single-blob ceiling doesn't apply.
        const chunkCount = Math.ceil(blob.size / CHUNK_SIZE);
        const db = await openDb();
        // Wipe any prior single-blob entry (and prior chunks) for
        // this key so we don't leave orphans.
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(key);
            for (let i = 0; i < 32; i++) tx.objectStore(STORE).delete(key + '#' + i);
            tx.objectStore(STORE).delete(key + '#meta');
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
        // Write chunks one at a time (separate transactions so we
        // don't hold a giant write-lock for many minutes on a 4GB
        // file — and so a single chunk failure doesn't roll back
        // every chunk).
        for (let i = 0; i < chunkCount; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, blob.size);
            const chunk = blob.slice(start, end);
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(chunk, key + '#' + i);
                tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        }
        // Write the manifest LAST so a partially-written file never
        // looks complete. cacheHas checks for the manifest.
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put({
                chunked: true,
                size: blob.size,
                chunkSize: CHUNK_SIZE,
                chunkCount,
                type: blob.type || 'application/octet-stream',
            }, key + '#meta');
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
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
            // Translate the raw IDB error into something actionable. The
            // dialog at app.js:1179 displays e.message, so we have to
            // throw a NEW Error with the friendly text rather than
            // re-throwing the original.
            const isQuota =
                /Quota|storage|exceed/i.test(e?.name || '') ||
                /Quota|storage|exceed/i.test(e?.message || '');
            const friendly = isQuota
                ? 'Browser ran out of storage. PS2 ROMs are 2-4 GB — clear other site data (DevTools → Application → Storage) or use Chrome with more free disk.'
                : `IDB write rejected (${e?.name || 'IOError'}). Try a different browser, or clear site data and retry.`;
            setState(gameId, { state: 'error', error: friendly, _key: key });
            throw new Error(friendly);
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
