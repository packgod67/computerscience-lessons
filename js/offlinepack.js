// PWA offline pack — let users save specific games for offline play.
//
// User flow:
//   1. Click "Save offline" on a game card
//   2. Browser fetches the wrapper HTML + iframe target + all sub-resources
//      via the service worker, caches them in a dedicated CacheStorage
//      bucket (`arcade-offline-<gameId>`), records metadata in IDB
//   3. When offline, the SW serves those cached responses for that game
//   4. "Offline" view in the side menu lists saved games + total storage
//      used + per-game eviction
//
// Limitations honored:
//   - ROM games (gba/snes/nes/etc) skip — ROMs are 5-200 MB each, often
//     fetched through the worker proxy with custom Range/auth handling
//     that we'd duplicate poorly. We only support iframe games (itch
//     HTML5, Newgrounds HTML5, Newgrounds Flash via Ruffle).
//   - Cross-origin iframes have asset-fetch independence — we cache the
//     wrapper HTML, but inner-iframe assets need separate caching the
//     SW does on first run while online.
//   - Storage budget: enforces a 250 MB total cap by oldest-eviction.
//
// Persistence: navigator.storage.persist() is requested on first save
// so the browser doesn't auto-evict during low-storage situations.

(function () {
    const DB_NAME = 'arcade-offline';
    const DB_VERSION = 1;
    const STORE = 'savedGames';
    const TOTAL_BUDGET_BYTES = 250 * 1024 * 1024; // 250 MB
    const CACHE_PREFIX = 'arcade-offline-';

    let dbPromise = null;

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'gameId' });
                    store.createIndex('savedAt', 'savedAt');
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }

    async function getSavedGames() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async function getSavedGame(gameId) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(gameId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function putSavedGame(meta) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(meta);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async function deleteSavedGame(gameId) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(gameId);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    // Detect game type — only iframe-pattern games are eligible.
    function isEligible(game) {
        if (!game) return false;
        if (game.rom) return false; // ROM games skip
        // Heuristic: anything with no `rom` and a path is iframe-based
        return !!game.path;
    }

    // Walk the game's wrapper HTML, find the iframe src, and cache that
    // PLUS the wrapper itself in a dedicated bucket. The actual inner-
    // iframe assets get cached opportunistically by the SW the first
    // time the user plays.
    async function cacheGame(game, onProgress) {
        if (!isEligible(game)) {
            throw new Error('Only iframe games can be saved offline (skip ROMs).');
        }
        // Request persistent storage so the browser doesn't evict our
        // saves under storage pressure.
        if (navigator.storage && navigator.storage.persist) {
            try { await navigator.storage.persist(); } catch {}
        }

        const cacheName = CACHE_PREFIX + game.id;
        const cache = await caches.open(cacheName);

        // 1. Cache the wrapper HTML
        onProgress?.('Caching wrapper…');
        const wrapperUrl = new URL(game.path, location.origin).toString();
        const wrapperResp = await fetch(wrapperUrl);
        if (!wrapperResp.ok) throw new Error(`Wrapper fetch failed: ${wrapperResp.status}`);
        const wrapperHtml = await wrapperResp.clone().text();
        await cache.put(wrapperUrl, wrapperResp.clone());

        // 2. Find the iframe src in the wrapper, fetch + cache it
        const iframeMatch = wrapperHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
        let iframeUrl = null;
        let iframeBytes = 0;
        if (iframeMatch) {
            iframeUrl = iframeMatch[1];
            // Resolve relative URLs (rare but possible)
            if (!/^https?:/.test(iframeUrl)) {
                iframeUrl = new URL(iframeUrl, wrapperUrl).toString();
            }
            onProgress?.('Caching game frame…');
            try {
                const iframeResp = await fetch(iframeUrl);
                if (iframeResp.ok) {
                    const blob = await iframeResp.clone().blob();
                    iframeBytes = blob.size;
                    await cache.put(iframeUrl, iframeResp.clone());
                }
            } catch (e) {
                console.warn('Iframe target fetch failed (will only cache wrapper):', e);
            }
        }

        // 3. Cache thumbnail too (for offline list view)
        if (game.thumbnail) {
            try {
                const thumbResp = await fetch(game.thumbnail);
                if (thumbResp.ok) await cache.put(game.thumbnail, thumbResp.clone());
            } catch {}
        }

        // 4. Record metadata
        const meta = {
            gameId: game.id,
            title: game.title,
            thumbnail: game.thumbnail,
            wrapperUrl,
            iframeUrl,
            estimatedBytes: wrapperHtml.length + iframeBytes,
            savedAt: new Date().toISOString(),
        };
        await putSavedGame(meta);

        // 5. Enforce budget — evict oldest until under cap
        await enforceBudget();

        return meta;
    }

    async function uncacheGame(gameId) {
        await caches.delete(CACHE_PREFIX + gameId);
        await deleteSavedGame(gameId);
    }

    // Sum estimatedBytes across all saved, evict oldest until <= TOTAL_BUDGET_BYTES
    async function enforceBudget() {
        const all = await getSavedGames();
        let total = all.reduce((s, m) => s + (m.estimatedBytes || 0), 0);
        if (total <= TOTAL_BUDGET_BYTES) return;
        // Sort oldest first
        all.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
        for (const m of all) {
            if (total <= TOTAL_BUDGET_BYTES) break;
            await uncacheGame(m.gameId);
            total -= (m.estimatedBytes || 0);
            console.log(`[offline-pack] evicted ${m.gameId} (over budget)`);
        }
    }

    // ─── UI: button on game cards + offline view ──────────────────────
    function renderSavedView(container) {
        getSavedGames().then(games => {
            if (!games.length) {
                container.innerHTML = `
                    <div class="offline-empty">
                        <p>No games saved offline yet.</p>
                        <p class="text-muted">Click "&#128229; Save offline" on any game card to download it for offline play. Up to ${(TOTAL_BUDGET_BYTES / 1024 / 1024).toFixed(0)} MB total.</p>
                    </div>`;
                return;
            }
            const totalMb = (games.reduce((s, m) => s + (m.estimatedBytes || 0), 0) / 1024 / 1024).toFixed(1);
            container.innerHTML = `
                <div class="offline-summary">
                    ${games.length} game${games.length !== 1 ? 's' : ''} saved &middot; ${totalMb} MB used of ${(TOTAL_BUDGET_BYTES / 1024 / 1024).toFixed(0)} MB
                </div>
                <div class="offline-list">
                    ${games.map(m => `
                        <div class="offline-item" data-id="${m.gameId}">
                            <img src="${m.thumbnail || ''}" alt="" class="offline-item-thumb"
                                 onerror="this.style.background='#222';this.removeAttribute('src')">
                            <div class="offline-item-info">
                                <div class="offline-item-title">${m.title || m.gameId}</div>
                                <div class="offline-item-meta">${((m.estimatedBytes || 0) / 1024 / 1024).toFixed(1)} MB &middot; saved ${new Date(m.savedAt).toLocaleDateString()}</div>
                            </div>
                            <a class="offline-item-play" href="play.html?game=${encodeURIComponent(m.gameId)}">Play</a>
                            <button class="offline-item-remove" data-id="${m.gameId}" title="Remove from offline">&times;</button>
                        </div>
                    `).join('')}
                </div>`;
            container.querySelectorAll('.offline-item-remove').forEach(btn => {
                btn.addEventListener('click', async () => {
                    if (!confirm('Remove this game from offline storage?')) return;
                    await uncacheGame(btn.dataset.id);
                    renderSavedView(container);
                });
            });
        });
    }

    window.ArcadeOfflinePack = {
        cacheGame,
        uncacheGame,
        getSavedGames,
        getSavedGame,
        isEligible,
        renderSavedView,
        TOTAL_BUDGET_BYTES,
    };
})();
