// Achievements — milestone badges shown on user profiles.
//
// CATALOG-DRIVEN: definitions live in this file (so we can ship new
// achievements via git push without a Firestore migration). Unlocks
// are persisted on the user's doc as `achievements: [<id>, ...]`.
//
// CHECK CADENCE: a single check() function walks the catalog and
// awards anything newly satisfied. We call it on page load + after
// every play tracked, save uploaded, favorite added, etc. Idempotent
// — already-unlocked entries are skipped via the user's doc.
//
// EVENTS: dispatches `arcade:achievement-unlocked` with the def in
// detail.achievement so the UI can pop a toast.
//
// FIRESTORE: writes to `users/{uid}.achievements` field via merge.
// Same security rule as the rest of the user doc — self-write only,
// no admin/banned/approved escalation. (Note: the existing rule guard
// in your ruleset blocks role/banned/approved changes but allows
// arbitrary other fields, so achievements writes are fine.)

(function () {
    // ─── Catalog ─────────────────────────────────────────────────────
    // Keep IDs short + stable. Once shipped, never reuse an ID for a
    // different meaning — old users will keep the old badge.
    //
    // Each achievement has a `check(profile, allGames)` predicate that
    // returns true once the milestone is satisfied. Pure functions —
    // no side effects, no async — so we can run them all in O(n) on
    // every call without burning Firestore reads.
    const CATALOG = [
        {
            id: 'first-play',
            title: 'First Play',
            desc: 'Open your first game.',
            icon: '\u{1F3AE}', // 🎮
            check: p => Array.isArray(p.recentPlays) && p.recentPlays.length >= 1,
        },
        {
            id: 'ten-plays',
            title: 'Getting Hooked',
            desc: 'Play 10 different games.',
            icon: '\u{1F525}', // 🔥
            check: p => Array.isArray(p.recentPlays) && p.recentPlays.length >= 10,
        },
        {
            id: 'play-50-different',
            title: 'Catalog Crawler',
            desc: 'Play 50 different games (lifetime).',
            icon: '\u{1F4DA}', // 📚
            check: p => p.playCounts && Object.keys(p.playCounts).length >= 50,
        },
        {
            id: 'first-favorite',
            title: 'I Like It',
            desc: 'Favorite your first game.',
            icon: '\u{2B50}', // ⭐
            check: p => Array.isArray(p.favorites) && p.favorites.length >= 1,
        },
        {
            id: 'ten-favorites',
            title: 'Curator',
            desc: 'Favorite 10 games.',
            icon: '\u{1F48E}', // 💎
            check: p => Array.isArray(p.favorites) && p.favorites.length >= 10,
        },
        {
            id: 'first-bio',
            title: 'Open Book',
            desc: 'Add a bio to your profile.',
            icon: '\u{1F4DD}', // 📝
            check: p => typeof p.bio === 'string' && p.bio.trim().length >= 5,
        },
        {
            id: 'first-avatar',
            title: 'Picture-Perfect',
            desc: 'Set a profile avatar.',
            icon: '\u{1F4F8}', // 📸
            check: p => typeof p.avatar === 'string' && p.avatar.length > 0,
        },
        {
            id: 'pokemon-fan',
            title: 'Gotta Catch ‘Em',
            desc: 'Play 5 different Pokemon games.',
            icon: '\u{1F9E1}', // 🧡
            check: (p, allGames) => {
                if (!p.playCounts) return false;
                const ids = Object.keys(p.playCounts);
                let count = 0;
                for (const id of ids) {
                    const g = allGames.byId[id];
                    if (g && (g.category === 'Pokemon' || (g.tags || []).includes('pokemon'))) count++;
                    if (count >= 5) return true;
                }
                return false;
            },
        },
        {
            id: 'rom-runner',
            title: 'ROM Runner',
            desc: 'Play 10 different ROM games.',
            icon: '\u{1F4BE}', // 💾
            check: (p, allGames) => {
                if (!p.playCounts) return false;
                const ids = Object.keys(p.playCounts);
                let count = 0;
                for (const id of ids) {
                    const g = allGames.byId[id];
                    if (g && g.rom) count++;
                    if (count >= 10) return true;
                }
                return false;
            },
        },
        {
            id: 'multi-genre',
            title: 'Genre Hopper',
            desc: 'Play games in 5 different categories.',
            icon: '\u{1F30D}', // 🌍
            check: (p, allGames) => {
                if (!p.playCounts) return false;
                const cats = new Set();
                for (const id of Object.keys(p.playCounts)) {
                    const g = allGames.byId[id];
                    if (g?.category) cats.add(g.category);
                }
                return cats.size >= 5;
            },
        },
        {
            id: 'theme-creator',
            title: 'Designer',
            desc: 'Share a custom theme.',
            icon: '\u{1F3A8}', // 🎨
            // Approximation — we'd need to query themes/{} where uid==self.
            // Mark from the profile's `sharedThemeCount` counter (set by
            // themes.js on share). Default 0 → check fails.
            check: p => (p.sharedThemeCount || 0) >= 1,
        },
        {
            id: 'social-butterfly',
            title: 'Social Butterfly',
            desc: 'Have 5 friends.',
            icon: '\u{1F98B}', // 🦋
            check: p => Array.isArray(p.friends) && p.friends.length >= 5,
        },
        {
            id: 'first-comment',
            title: 'Speaking Up',
            desc: 'Post your first game comment.',
            icon: '\u{1F4AC}', // 💬
            check: p => (p.commentCount || 0) >= 1,
        },
        {
            id: 'first-coop',
            title: 'Couch Co-op',
            desc: 'Host your first co-op session.',
            icon: '\u{1F465}', // 👥
            check: p => (p.coopHostCount || 0) >= 1,
        },
        {
            id: 'first-cloudsave',
            title: 'Cloud Saver',
            desc: 'Upload your first cloud save.',
            icon: '\u{2601}\u{FE0F}', // ☁️
            check: p => (p.cloudSaveCount || 0) >= 1,
        },
        {
            id: 'completionist',
            title: 'Completionist',
            desc: 'Earn 10 achievements.',
            icon: '\u{1F3C6}', // 🏆
            check: p => Array.isArray(p.achievements) && p.achievements.length >= 10,
        },
    ];

    function byIds(ids) {
        if (!Array.isArray(ids)) return [];
        const map = {};
        for (const a of CATALOG) map[a.id] = a;
        return ids.map(id => map[id]).filter(Boolean);
    }

    // ─── Engine ──────────────────────────────────────────────────────
    let inflightCheck = null;

    async function checkAndAward() {
        if (!window.ArcadeAuth?.isLoggedIn?.()) return;
        if (inflightCheck) return inflightCheck;
        inflightCheck = (async () => {
            try {
                const db = window.ArcadeAuth.getDb();
                const uid = window.ArcadeAuth.getUser()?.uid;
                if (!db || !uid) return;
                const ref = db.collection('users').doc(uid);
                const snap = await ref.get();
                const profile = snap.exists ? snap.data() : {};
                const owned = new Set(profile.achievements || []);

                // Build a games index — cheap dict over ArcadeApp.getGames().
                const games = window.ArcadeApp?.getGames?.() || [];
                const byId = {};
                for (const g of games) byId[g.id] = g;
                const allGames = { byId, list: games };

                const newlyUnlocked = [];
                for (const def of CATALOG) {
                    if (owned.has(def.id)) continue;
                    let pass = false;
                    try { pass = !!def.check(profile, allGames); } catch {}
                    if (pass) {
                        owned.add(def.id);
                        newlyUnlocked.push(def);
                    }
                }
                if (!newlyUnlocked.length) return;

                await ref.set({ achievements: Array.from(owned) }, { merge: true });

                // Surface a toast for each, staggered. Tiny UX delight.
                newlyUnlocked.forEach((def, i) => {
                    setTimeout(() => showToast(def), i * 800);
                    try {
                        window.dispatchEvent(new CustomEvent('arcade:achievement-unlocked', {
                            detail: { achievement: def },
                        }));
                    } catch {}
                });
            } catch (e) {
                console.warn('achievements check failed:', e);
            } finally {
                inflightCheck = null;
            }
        })();
        return inflightCheck;
    }

    // ─── Toast ───────────────────────────────────────────────────────
    function showToast(def) {
        const t = document.createElement('div');
        t.className = 'arcade-ach-toast';
        t.style.cssText = [
            'position:fixed', 'bottom:24px', 'right:24px',
            'background:linear-gradient(135deg,#7c3aed,#a855f7)',
            'color:#fff', 'padding:14px 18px', 'border-radius:12px',
            'box-shadow:0 8px 24px rgba(0,0,0,0.35)',
            'z-index:99999', 'min-width:240px', 'max-width:340px',
            'display:flex', 'align-items:center', 'gap:12px',
            'font:14px/1.4 system-ui,sans-serif',
            'animation:ach-toast-in 0.35s ease-out',
        ].join(';');
        t.innerHTML = `
            <div style="font-size:32px;line-height:1;">${def.icon || '\u{1F3C6}'}</div>
            <div style="flex:1;">
                <div style="font-weight:700;font-size:13px;opacity:0.85;">Achievement unlocked</div>
                <div style="font-weight:700;font-size:15px;">${def.title}</div>
                <div style="opacity:0.85;font-size:12px;margin-top:2px;">${def.desc}</div>
            </div>
        `;
        document.body.appendChild(t);
        setTimeout(() => {
            t.style.transition = 'opacity 0.4s, transform 0.4s';
            t.style.opacity = '0';
            t.style.transform = 'translateY(10px)';
            setTimeout(() => t.remove(), 450);
        }, 4500);
    }

    // ─── Wireup ──────────────────────────────────────────────────────
    // Run a check on page load (catches things that happened in other
    // sessions) + on key events: play tracked, favorite toggled, save
    // uploaded, profile edited, comment posted, friend added.
    function init() {
        // Initial check after auth resolves
        if (window.ArcadeAuth?.waitForAuth) {
            window.ArcadeAuth.waitForAuth().then(checkAndAward);
        } else {
            setTimeout(checkAndAward, 1500);
        }
        ['arcade:play-tracked',
         'arcade:favorite-changed',
         'arcade:save-uploaded',
         'arcade:profile-edited',
         'arcade:comment-posted',
         'arcade:friend-added',
         'arcade:coop-hosted',
         'arcade:theme-shared',
        ].forEach(ev => window.addEventListener(ev, () => {
            // Debounce: collapse multi-event bursts into a single check.
            clearTimeout(init._t);
            init._t = setTimeout(checkAndAward, 300);
        }));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.ArcadeAchievements = {
        catalog: CATALOG,
        byIds,
        checkAndAward,
    };
})();
