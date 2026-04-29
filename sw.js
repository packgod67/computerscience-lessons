// Service Worker for Arcade — handles offline support + PWA installability.
//
// Strategy:
// - Cache the app shell (HTML/CSS/JS/logo) on install
// - Network-first for games.json (content changes often)
// - Cache-first for static assets (thumbnails etc.)
// - Never touch cross-origin requests (CDNs like libretro, jsdelivr handle
//   their own caching via HTTP headers)

const CACHE_NAME = 'arcade-shell-v99';
const SHELL_ASSETS = [
    './',
    './index.html',
    './play.html',
    './install.html',
    './css/style.css',
    './js/config.js',
    './js/app.js',
    './js/auth.js',
    './js/profiles.js',
    './js/recommender.js',
    './js/chatbot.js',
    './js/themes.js',
    './js/tabs.js',
    './js/users.js',
    './js/gallery.js',
    './js/emojis.js',
    './js/chat.js',
    './js/cheats.js',
    './js/messages.js',
    './js/admintags.js',
    './js/bulkadd.js',
    './js/catalogadmin.js',
    './js/offlinepack.js',
    './js/coop.js',
    './js/install.js',
    './js/lazyload.js',
    './js/friends.js',
    './js/achievements.js',
    './js/comments.js',
    './js/settings.js',
    './js/profile-widgets.js',
    './js/pull-to-refresh.js',
    './js/telemetry.js',
    './js/cataloghealth.js',
    './js/errorsadmin.js',
    './js/save-queue.js',
    './status.html',
    './sitemap.xml',
    './coop.html',
    './js/patchnotes.js',
    './js/saves.js',
    './js/requests.js',
    './js/ps2-preload.js',
    './js/player.js',
    './js/ds-mode.js',
    './assets/logo.png',
    './assets/kirky.jpg',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './assets/icon-maskable-192.png',
    './assets/icon-maskable-512.png',
    './assets/apple-touch-icon.png',
    './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // addAll is all-or-nothing; use individual adds so one missing
            // asset doesn't blow up the whole install
            return Promise.allSettled(
                SHELL_ASSETS.map((url) => cache.add(url).catch(() => {}))
            );
        }).then(() => self.skipWaiting())
    );
});

// Background Sync: when a queued save needs to be flushed and the user
// is offline, saves.js registers `arcade-save-sync`. Chrome / Edge fire
// this event when connectivity returns even if the tab is closed. We
// can't run the Firebase SDK in the SW directly, so instead we wake any
// open client (page) and ask it to drain the queue. If no client is
// open, the page will drain on its own next load via save-queue.js.
self.addEventListener('sync', (event) => {
    if (event.tag !== 'arcade-save-sync') return;
    event.waitUntil((async () => {
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        for (const client of clients) {
            try { client.postMessage({ type: 'drain-save-queue' }); } catch {}
        }
    })());
});

self.addEventListener('activate', (event) => {
    // Clean out old caches from previous versions
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(
                names
                    .filter((n) => n.startsWith('arcade-shell-') && n !== CACHE_NAME)
                    .map((n) => caches.delete(n))
            )
        ).then(() => self.clients.claim())
    );
});

// Offline-pack cache buckets are named `arcade-offline-<gameId>`. When
// the user has saved a game for offline play, we cache its wrapper +
// iframe target + thumbnail in these dedicated buckets. The fetch
// handler below checks these FIRST (across any origin) before falling
// through to network or the shell cache. This is what lets a saved
// itch HTML5 game still load when the user is offline.
async function checkOfflinePackCaches(req) {
    try {
        const names = await caches.keys();
        for (const name of names) {
            if (!name.startsWith('arcade-offline-')) continue;
            const cache = await caches.open(name);
            const match = await cache.match(req, { ignoreVary: true });
            if (match) return match;
        }
    } catch {}
    return null;
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Cross-origin path: only intercept if the URL is in an offline-pack
    // cache (i.e. user explicitly saved this for offline). This lets
    // saved itch / Newgrounds games keep working when network is down,
    // without us proxying every random CDN request the rest of the time.
    if (url.origin !== self.location.origin) {
        event.respondWith((async () => {
            // Try network first (so we still get fresh content when online)
            try {
                const resp = await fetch(req);
                if (resp.ok) return resp;
                // Network OK but error response — fall through to cache
            } catch {
                // Network failed (offline) — fall through to cache
            }
            const cached = await checkOfflinePackCaches(req);
            if (cached) return cached;
            // Re-throw a network error so the iframe shows the standard
            // offline page rather than a fake 200
            return fetch(req);
        })());
        return;
    }

    // Skip Firestore / Firebase live connections (websockets, listens)
    if (url.hostname.includes('firestore.googleapis.com') ||
        url.hostname.includes('firebaseio.com')) return;

    // games.json: network-first, fall back to cache
    if (url.pathname.endsWith('/games.json') || url.pathname.endsWith('games.json')) {
        event.respondWith(
            fetch(req).then((resp) => {
                if (resp.ok) {
                    const copy = resp.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(req, copy));
                }
                return resp;
            }).catch(() => caches.match(req))
        );
        return;
    }

    // HTML navigations: network-first so users get fresh UI, fall back offline.
    //
    // For play.html and /games/*.html ONLY, also inject COOP same-origin +
    // COEP require-corp so the page is cross-origin-isolated — required
    // for Godot 4 / Unity / any engine needing SharedArrayBuffer. The host
    // (Render etc.) doesn't let us configure these headers on .html files,
    // so the SW does it on the way out.
    //
    // Scoped to play.html + game wrappers ONLY (not index.html or other
    // pages) because COEP require-corp would break any cross-origin sub-
    // resource without CORP — Kirky avatar from Firebase Storage, third-
    // party ad scripts, profile pics, etc. The play page only needs
    // resources from same-origin + the Cloudflare worker (which sends CORP),
    // so it's safe there. Pairs with matching headers the worker sends on
    // /itch/ responses.
    const needsCoi = url.pathname === '/play.html'
                  || url.pathname.endsWith('/play.html')
                  || /\/games\/[^/]+\.html$/.test(url.pathname);
    if (req.mode === 'navigate' || req.destination === 'document') {
        event.respondWith((async () => {
            let resp;
            try {
                resp = await fetch(req);
                if (resp.ok) {
                    const copy = resp.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(req, copy));
                }
            } catch {
                resp = await caches.match(req) || await caches.match('./index.html');
                if (!resp) return new Response('offline', { status: 503 });
            }
            if (!needsCoi) return resp;
            // Clone the response so we can rewrite headers without consuming
            // the body. require-corp is stricter than credentialless but
            // more reliably interpreted by Chrome — sub-resources MUST have
            // CORP set, which our worker does for itch responses, and same-
            // origin assets pass automatically.
            const headers = new Headers(resp.headers);
            headers.set('Cross-Origin-Opener-Policy', 'same-origin');
            headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
            return new Response(resp.body, {
                status: resp.status,
                statusText: resp.statusText,
                headers,
            });
        })());
        return;
    }

    // Everything else (CSS, JS, images): cache-first, background update
    event.respondWith(
        caches.match(req).then((cached) => {
            const net = fetch(req).then((resp) => {
                if (resp && resp.ok) {
                    const copy = resp.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(req, copy));
                }
                return resp;
            }).catch(() => cached);
            return cached || net;
        })
    );
});
