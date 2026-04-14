/*! coi-serviceworker - Enables SharedArrayBuffer by injecting COOP/COEP headers via Service Worker */
if (typeof window === 'undefined') {
  // Service Worker context
  self.addEventListener("install", function() { self.skipWaiting(); });
  self.addEventListener("activate", function(e) { e.waitUntil(self.clients.claim()); });
  self.addEventListener("fetch", function(e) {
    if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
    e.respondWith(
      fetch(e.request).then(function(r) {
        if (r.status === 0) return r;
        var h = new Headers(r.headers);
        h.set("Cross-Origin-Embedder-Policy", "credentialless");
        h.set("Cross-Origin-Opener-Policy", "same-origin");
        return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
      }).catch(function() { return fetch(e.request); })
    );
  });
} else {
  // Window context - register this file as a service worker
  (function() {
    if (window.crossOriginIsolated) return; // headers already present
    if (!("serviceWorker" in navigator)) return;
    var swUrl = new URL("coi-serviceworker.js", document.currentScript.src).href;
    navigator.serviceWorker.register(swUrl).then(function(r) {
      if (r.active && !navigator.serviceWorker.controller) {
        window.location.reload(); // reload to activate SW control
      }
    });
  })();
}
