// Lazy-load helper for scripts that aren't needed on initial render.
//
// Many of our admin / optional feature scripts (bulkadd, catalogadmin,
// coop, offlinepack, chatbot) only run when the user clicks a specific
// entry-point. Loading them eagerly on every page burns ~80KB of JS
// parsing on the critical path — visible as ~150ms of dead time on
// low-end Android.
//
// Usage:
//   await loadScript('js/coop.js');
//   ArcadeCoop.startCoopAsHost(game);
//
// Caches by URL — calling it twice for the same script reuses the
// in-flight promise and resolves to the same result.

(function () {
    const cache = new Map();

    function loadScript(url) {
        if (cache.has(url)) return cache.get(url);
        const p = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.async = false; // execute in order if multiple are pending
            s.onload = () => resolve();
            s.onerror = () => {
                cache.delete(url); // allow retry on next call
                reject(new Error(`Failed to load ${url}`));
            };
            document.head.appendChild(s);
        });
        cache.set(url, p);
        return p;
    }

    window.ArcadeLazyLoad = { loadScript };
})();
