// Service worker for background ROM downloads. Lives at the site root with
// scope `/`, but does NOT add COOP/COEP — the only fetch this SW handles is
// the Background Fetch completion. Pages still load normally.
//
// Why a separate SW (not the coi-serviceworker at /play/): Background Fetch
// requires a SW with broad scope to register and handle events. The /play/
// SW is intentionally scoped narrowly so its COOP/COEP rules don't affect
// the rest of the site. Two SWs coexist as long as their scopes don't
// overlap or the more-specific one (/play/coi-serviceworker.js) wins for
// /play/* fetches.

const DB_NAME = 'arcade-play-roms';
const STORE = 'roms';

// Take control of clients ASAP after install — the bg fetch flow needs the
// SW active to receive `fetch()` calls from the page and emit progress
// events back via postMessage.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
    if (event.data?.type === 'skip-waiting') self.skipWaiting();
});

// Open the same IDB our /play/ loader reads from. Same name, same store.
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

// Background Fetch hands us a registration with all the response records.
// We grab the body, write it to IDB keyed by the registration ID (= the
// ROM URL), and notify any open clients so the chip can flip to "Ready".
self.addEventListener('backgroundfetchsuccess', (event) => {
    const reg = event.registration;
    event.waitUntil((async () => {
        try {
            const records = await reg.matchAll();
            if (!records.length) throw new Error('no records');
            const response = await records[0].responseReady;
            if (!response.ok) throw new Error('HTTP ' + response.status);

            const blob = await response.blob();
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(blob, reg.id);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });

            // Tell any open arcade tabs the cache is now hot.
            const clients = await self.clients.matchAll({ includeUncontrolled: true });
            for (const c of clients) {
                c.postMessage({ type: 'preload-cached', id: reg.id, size: blob.size });
            }
            // Update the OS-level notification UI to reflect success.
            event.updateUI?.({ title: 'ROM ready — click your card to play' });
        } catch (e) {
            const clients = await self.clients.matchAll({ includeUncontrolled: true });
            for (const c of clients) {
                c.postMessage({ type: 'preload-failed', id: reg.id, error: e.message });
            }
        }
    })());
});

self.addEventListener('backgroundfetchfail', (event) => {
    const reg = event.registration;
    event.waitUntil((async () => {
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        for (const c of clients) {
            c.postMessage({ type: 'preload-failed', id: reg.id, error: 'fetch failed' });
        }
    })());
});

self.addEventListener('backgroundfetchabort', (event) => {
    const reg = event.registration;
    event.waitUntil((async () => {
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        for (const c of clients) {
            c.postMessage({ type: 'preload-aborted', id: reg.id });
        }
    })());
});

// Clicking the OS-level progress notification reopens the arcade.
self.addEventListener('backgroundfetchclick', (event) => {
    event.waitUntil(self.clients.openWindow('/'));
});
