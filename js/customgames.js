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
                    const isMulti = !!data.isMulti;
                    return {
                        id: d.id,
                        title: data.title || d.id,
                        description: data.description || '',
                        category: data.category || 'Other',
                        tags: Array.isArray(data.tags) ? data.tags : [],
                        thumbnail: data.thumbnail || '',
                        addedAt: data.addedAt || null,
                        custom: true,
                        // Single-file games carry HTML inline (Firestore string).
                        // Multi-file games carry the entry-point URL synthesized
                        // from Storage — player.js iframes that URL directly.
                        _html: data.html || '',
                        _isMulti: isMulti,
                        _entry: data.entry || 'index.html',
                        _storagePrefix: data.storagePrefix || `customGames/${d.id}/`,
                        // For multi-file games, expose the entry URL so player
                        // can set iframe.src to the Storage download URL.
                        _entryUrl: isMulti
                            ? `https://firebasestorage.googleapis.com/v0/b/${
                                firebase.app().options.storageBucket
                              }/o/${
                                encodeURIComponent((data.storagePrefix || `customGames/${d.id}/`) + (data.entry || 'index.html'))
                              }?alt=media`
                            : '',
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
