// Service Worker for Arcade — handles offline support + PWA installability.
//
// Strategy:
// - Cache the app shell (HTML/CSS/JS/logo) on install
// - Network-first for games.json (content changes often)
// - Cache-first for static assets (thumbnails etc.)
// - Never touch cross-origin requests (CDNs like libretro, jsdelivr handle
//   their own caching via HTTP headers)

const CACHE_NAME = 'arcade-shell-v19';
const SHELL_ASSETS = [
    './',
    './index.html',
    './play.html',
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
    './js/player.js',
    './js/cloud-save.js',
    './js/ds-mode.js',
    './assets/logo.png',
    './assets/kirky.jpg',
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

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Only handle same-origin requests — leave CDNs alone
    if (url.origin !== self.location.origin) return;

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

    // HTML navigations: network-first so users get fresh UI, fall back offline
    if (req.mode === 'navigate' || req.destination === 'document') {
        event.respondWith(
            fetch(req).then((resp) => {
                if (resp.ok) {
                    const copy = resp.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(req, copy));
                }
                return resp;
            }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
        );
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
