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
})();
