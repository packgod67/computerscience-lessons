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
                    // Multi-file games are committed to the arcade's git repo
                    // by the upload worker. Their files live at the relative
                    // path the doc records and are served by the same hosts
                    // that serve the rest of the arcade — so iframe src is
                    // just the same-origin path.
                    const entry = data.entry || 'index.html';
                    const repoPath = data.repoPath || `games/uploads/${d.id}/`;
                    return {
                        id: d.id,
                        title: data.title || d.id,
                        description: data.description || '',
                        category: data.category || 'Other',
                        tags: Array.isArray(data.tags) ? data.tags : [],
                        thumbnail: data.thumbnail || '',
                        addedAt: data.addedAt || null,
                        custom: true,
                        _html: data.html || '',
                        _isMulti: isMulti,
                        _entry: entry,
                        _repoPath: repoPath,
                        // Same-origin URL — relative paths inside the entry
                        // HTML resolve naturally to other files in the folder.
                        _entryUrl: isMulti ? (repoPath + entry) : '',
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
