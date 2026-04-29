// Offline-tolerant queue for cloud saves.
//
// When saves.js tries to upload a save and the network call fails (or
// navigator.onLine is false), the save payload is queued to IndexedDB
// instead of being lost. The queue is then drained:
//   - on the `online` event firing (browser regained connectivity)
//   - on page load, if the user is signed in (catches saves that were
//     queued in a previous session)
//   - on a Service Worker `sync` event with tag `arcade-save-sync`,
//     when the browser supports Background Sync (Chrome / Edge desktop)
//
// IDB schema:
//   db `arcade-save-queue` v1
//     store `pending_saves` autoIncrement
//       { uid, label, gameId, gameTitle, filename, mime, size,
//         dataUrl, thumbnail, queuedAt }
//
// The actual Firestore write happens in saves.js (which has the
// firebase-firestore-compat SDK loaded). save-queue.js is just storage
// + drain orchestration. The SW can't directly use the Firebase SDK,
// so on a sync event it just postMessages clients telling them to
// drain — clients run the same code path.

(function () {
    const DB_NAME = 'arcade-save-queue';
    const DB_VERSION = 1;
    const STORE = 'pending_saves';

    function openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function enqueue(payload) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const req = store.add({
                ...payload,
                queuedAt: Date.now(),
            });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function getAll() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async function remove(id) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function count() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).count();
            req.onsuccess = () => resolve(req.result || 0);
            req.onerror = () => reject(req.error);
        });
    }

    // ─── Drain ─────────────────────────────────────────────────────
    // saves.js calls registerUploader(fn) where fn(payload) returns a
    // Promise that resolves on success, throws on failure. drain() then
    // walks the queue and removes successful entries. Throttled so two
    // concurrent drain calls don't double-upload.
    let uploader = null;
    let draining = false;

    function registerUploader(fn) { uploader = fn; }

    async function drain(opts = {}) {
        if (!uploader) return { uploaded: 0, remaining: -1 };
        if (draining) return { uploaded: 0, remaining: -1 };
        if (!navigator.onLine) return { uploaded: 0, remaining: await count() };
        draining = true;
        let uploaded = 0;
        try {
            const items = await getAll();
            for (const item of items) {
                if (!navigator.onLine) break;          // re-check between each
                if (opts.uid && item.uid !== opts.uid) continue; // skip other users' queued saves
                try {
                    await uploader(item);
                    await remove(item.id);
                    uploaded++;
                } catch (e) {
                    // Network or auth failure — leave in queue, retry later.
                    // Don't tight-loop on a poison pill: bail after the
                    // first failure, the next online/sync event will retry.
                    console.warn('save-queue drain failed for', item.id, e);
                    break;
                }
            }
        } finally {
            draining = false;
        }
        return { uploaded, remaining: await count() };
    }

    // ─── Background sync ────────────────────────────────────────────
    // The SW can request a drain via postMessage. We listen here so the
    // SW's sync event handler can wake the page (or any open client) to
    // do the work.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (ev) => {
            if (ev.data && ev.data.type === 'drain-save-queue') {
                drain().then((r) => {
                    if (r.uploaded > 0 && window.ArcadeSaveQueue?.onDrained) {
                        try { window.ArcadeSaveQueue.onDrained(r); } catch {}
                    }
                });
            }
        });
    }

    // Auto-drain on `online` event
    window.addEventListener('online', () => {
        const uid = window.ArcadeAuth?.getUser?.()?.uid;
        if (!uid) return;
        drain({ uid });
    });

    window.ArcadeSaveQueue = {
        enqueue, getAll, remove, count, drain, registerUploader,
        onDrained: null, // optional callback for UI updates
    };
})();
