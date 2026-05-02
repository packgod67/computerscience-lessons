// Custom games — admin-uploaded game wrappers stored in Firestore.
//
// Schema:
//   customGames/{gameId}
//     {
//       id, title, description, category, tags[],
//       thumbnail, html (the wrapper HTML, capped at 500KB),
//       authorUid, authorName, createdAt, addedAt
//     }
//
// The runtime in this file exposes two things to the rest of the app:
//   - ArcadeCustomGames.fetch() — Promise<game[]> in the same shape as
//     games.json so app.js can concat them after loading static games.
//   - ArcadeCustomGames.getById(id) — used by player.js to detect
//     custom games and load their HTML via iframe.srcdoc instead of
//     iframe.src (since custom games have no path on disk).
//
// Firestore rule to add:
//   match /customGames/{gameId} {
//     allow read:  if true;
//     allow write: if isAdmin();
//   }

(function () {
    let cache = null; // Promise<game[]>

    function getDb() { return window.ArcadeAuth?.getDb?.(); }

    async function fetchAll() {
        if (cache) return cache;
        cache = (async () => {
            const db = getDb();
            if (!db) return [];
            try {
                const snap = await db.collection('customGames').get();
                return snap.docs.map(d => {
                    const data = d.data();
                    return {
                        id: d.id,
                        title: data.title || d.id,
                        description: data.description || '',
                        category: data.category || 'Other',
                        tags: Array.isArray(data.tags) ? data.tags : [],
                        thumbnail: data.thumbnail || '',
                        addedAt: data.addedAt || null,
                        // Marker so the rest of the app knows this is custom.
                        // path stays null — player.js checks `custom` and uses
                        // srcdoc with the html field instead of src=path.
                        custom: true,
                        // We carry the raw html along on this object so the
                        // player can srcdoc it without an extra Firestore call.
                        // app.js strips this from any cached/serialized list.
                        _html: data.html || '',
                    };
                });
            } catch (e) {
                console.warn('customGames load failed:', e);
                return [];
            }
        })();
        return cache;
    }

    function invalidate() { cache = null; }

    async function getById(id) {
        const all = await fetchAll();
        return all.find(g => g.id === id) || null;
    }

    window.ArcadeCustomGames = { fetch: fetchAll, getById, invalidate };
})();
