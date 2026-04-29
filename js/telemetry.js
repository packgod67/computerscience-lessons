// Lightweight client-side error reporting.
//
// Catches uncaught errors + unhandled promise rejections and writes them
// to the `errors` Firestore collection so admins can triage real
// breakage in production without needing to coordinate with affected
// users. Console-only errors (warnings, logs) are NOT captured — only
// thrown exceptions and rejections.
//
// Throttled to one write every 30 seconds to keep Firestore costs
// bounded if a regression is firing every render. Same-message dedup
// across the lifetime of the page so a single recurring error doesn't
// produce thousands of writes.
//
// Firestore rule (paste into console — append to the existing ruleset):
//   match /errors/{id} {
//     allow read: if isAdmin();
//     allow create: if signedIn()
//       && request.resource.data.message is string
//       && request.resource.data.message.size() <= 2000;
//     allow update: if false;
//     allow delete: if isAdmin();
//   }

(function () {
    const SEEN = new Set();
    let lastWrite = 0;
    const THROTTLE_MS = 30_000;

    function getDb() { return window.ArcadeAuth?.getDb?.(); }

    async function record(payload) {
        try {
            const db = getDb();
            if (!db) return;
            const now = Date.now();
            if (now - lastWrite < THROTTLE_MS) return;
            const key = (payload.message || '') + '|' + (payload.source || '');
            if (SEEN.has(key)) return;
            SEEN.add(key);
            lastWrite = now;
            const user = window.ArcadeAuth?.getUser?.();
            await db.collection('errors').add({
                message: String(payload.message || '').slice(0, 2000),
                source: String(payload.source || '').slice(0, 200),
                lineno: Number.isFinite(payload.lineno) ? payload.lineno : null,
                colno: Number.isFinite(payload.colno) ? payload.colno : null,
                stack: String(payload.stack || '').slice(0, 4000),
                href: location.href.slice(0, 500),
                ua: navigator.userAgent.slice(0, 300),
                uid: user?.uid || null,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
        } catch {
            // Suppress — telemetry must never throw.
        }
    }

    window.addEventListener('error', (ev) => {
        // Skip CORS / network errors that aren't real bugs in our code
        if (!ev.message && !ev.error) return;
        record({
            message: ev.message,
            source: ev.filename,
            lineno: ev.lineno,
            colno: ev.colno,
            stack: ev.error?.stack,
        });
    });

    window.addEventListener('unhandledrejection', (ev) => {
        const r = ev.reason;
        record({
            message: (r && (r.message || String(r))) || 'unhandledrejection',
            stack: r?.stack,
            source: 'promise',
        });
    });

    // ─── Iframe error capture (game wrappers) ───────────────────────
    // Errors thrown inside a same-origin iframe don't bubble to the
    // parent's `error` event. Without this hook, every game crash
    // (including the maeExportApis_ TypeError that affected 551
    // wrappers) was invisible — admin "Errors" tab kept reporting zero.
    //
    // Strategy: every time the gameFrame `load`s a new wrapper, we
    // attach error + unhandledrejection listeners on its contentWindow.
    // We also listen for ANY iframe added to the DOM (some wrappers
    // create their own nested iframes — e.g. the /play/ PS2 host) so
    // crashes one level deeper still get captured. Cross-origin frames
    // throw on contentWindow access; we silently skip those (the
    // browser's own error reporting still applies).
    function hookIframe(iframe) {
        if (!iframe || iframe.dataset.telemetryHooked === '1') return;
        iframe.dataset.telemetryHooked = '1';
        const attach = () => {
            let win;
            try { win = iframe.contentWindow; } catch { return; }
            if (!win) return;
            try {
                win.addEventListener('error', (ev) => {
                    if (!ev.message && !ev.error) return;
                    record({
                        message: '[iframe] ' + ev.message,
                        source: ev.filename || iframe.src,
                        lineno: ev.lineno,
                        colno: ev.colno,
                        stack: ev.error?.stack,
                    });
                });
                win.addEventListener('unhandledrejection', (ev) => {
                    const r = ev.reason;
                    record({
                        message: '[iframe-promise] ' + ((r && (r.message || String(r))) || 'unhandledrejection'),
                        source: iframe.src,
                        stack: r?.stack,
                    });
                });
            } catch {
                // Cross-origin — can't hook. Browser still logs to console.
            }
        };
        // Attach immediately (in case the frame already loaded) and on
        // every subsequent navigation within the iframe.
        attach();
        iframe.addEventListener('load', attach);
    }
    // Hook any iframe currently in the DOM
    document.querySelectorAll('iframe').forEach(hookIframe);
    // ...and any added later (gameFrame is in HTML at boot, but games
    // sometimes nest more frames via their own scripts).
    const mo = new MutationObserver((records) => {
        for (const r of records) {
            for (const node of r.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'IFRAME') hookIframe(node);
                else if (node.querySelectorAll) {
                    node.querySelectorAll('iframe').forEach(hookIframe);
                }
            }
        }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
})();
