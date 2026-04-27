// Game comments — community discussion thread per game.
//
// Lazy-loaded by app.js when the user opens a game info modal. Single
// public entry point: ArcadeComments.mount(containerEl, game) renders
// the thread inline and wires up posting/deleting.
//
// Firestore schema:
//   game_comments/{commentId}
//     gameId      — game id (e.g. "clkrunker"), indexed
//     authorUid
//     authorName  — cached at write time
//     text        — <= 1500 chars
//     createdAt   — server timestamp
//
// Required Firestore rule (paste into Firebase Console):
//   match /game_comments/{id} {
//     allow read: if request.auth != null;
//     allow create: if request.auth != null
//       && request.resource.data.authorUid == request.auth.uid
//       && request.resource.data.text is string
//       && request.resource.data.text.size() <= 1500;
//     allow update: if false;
//     allow delete: if request.auth != null && (
//       resource.data.authorUid == request.auth.uid
//       || get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin'
//     );
//   }

(function () {
    function getDb() { return window.ArcadeAuth?.getDb?.(); }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function timeAgo(ms) {
        if (!ms) return '';
        const s = Math.floor((Date.now() - ms) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm';
        if (s < 86400) return Math.floor(s / 3600) + 'h';
        return Math.floor(s / 86400) + 'd';
    }

    // Top-level state — per-mount, kept in a WeakMap so multiple modals
    // can coexist (e.g. recommendations chain) without clobbering each
    // other's listeners.
    const mounts = new WeakMap();

    function mount(container, game) {
        if (!container || !game) return;
        // Tear down any previous mount on this container (re-mount on
        // tab switch, etc.).
        const prev = mounts.get(container);
        if (prev?.unsub) try { prev.unsub(); } catch {}

        const isAdmin = !!window.ArcadeAuth?.isAdmin?.();
        const uid = window.ArcadeAuth?.getUser?.()?.uid;
        const username = window.ArcadeAuth?.getUsername?.() || '';

        container.innerHTML = `
            <div class="game-comments">
                <h3 class="game-comments-title">Comments</h3>
                <div class="game-comments-list" id="gameCommentsList_${esc(game.id)}">
                    <div class="game-comments-loading">Loading…</div>
                </div>
                ${uid ? `
                <div class="game-comments-compose">
                    <textarea class="game-comments-input"
                        placeholder="Share a tip, ask a question…"
                        maxlength="1500"
                        id="gameCommentsInput_${esc(game.id)}"></textarea>
                    <div class="game-comments-compose-row">
                        <span class="game-comments-counter" id="gameCommentsCounter_${esc(game.id)}">0 / 1500</span>
                        <button class="game-comments-post" id="gameCommentsPost_${esc(game.id)}">Post</button>
                    </div>
                </div>` : `
                <div class="game-comments-loggedout">Log in to post a comment.</div>
                `}
            </div>`;

        const listEl = container.querySelector('#gameCommentsList_' + game.id);
        const inputEl = container.querySelector('#gameCommentsInput_' + game.id);
        const postEl = container.querySelector('#gameCommentsPost_' + game.id);
        const counterEl = container.querySelector('#gameCommentsCounter_' + game.id);

        const db = getDb();
        if (!db) {
            listEl.innerHTML = '<div class="game-comments-empty">Firestore unavailable.</div>';
            return;
        }

        const unsub = db.collection('game_comments')
            .where('gameId', '==', game.id)
            .onSnapshot((snap) => {
                const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                items.sort((a, b) => {
                    const at = a.createdAt?.toMillis?.() || 0;
                    const bt = b.createdAt?.toMillis?.() || 0;
                    return bt - at;
                });
                renderList(listEl, items, uid, isAdmin, db);
            }, (err) => {
                console.warn('comments listener:', err);
                listEl.innerHTML = '<div class="game-comments-empty">Could not load comments. (Firestore rule for game_comments may be missing.)</div>';
            });

        if (inputEl) {
            inputEl.addEventListener('input', () => {
                counterEl.textContent = `${inputEl.value.length} / 1500`;
            });
        }
        if (postEl) {
            postEl.addEventListener('click', async () => {
                const text = (inputEl.value || '').trim().slice(0, 1500);
                if (!text) return;
                postEl.disabled = true;
                postEl.textContent = 'Posting…';
                try {
                    await db.collection('game_comments').add({
                        gameId: game.id,
                        authorUid: uid,
                        authorName: username,
                        text,
                        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    });
                    inputEl.value = '';
                    counterEl.textContent = '0 / 1500';
                } catch (e) {
                    alert('Post failed: ' + (e?.message || e));
                } finally {
                    postEl.disabled = false;
                    postEl.textContent = 'Post';
                }
            });
        }

        mounts.set(container, { unsub });
    }

    function renderList(listEl, items, uid, isAdmin, db) {
        if (!items.length) {
            listEl.innerHTML = '<div class="game-comments-empty">Be the first to comment.</div>';
            return;
        }
        listEl.innerHTML = items.map(c => {
            const mine = c.authorUid === uid;
            const canDelete = mine || isAdmin;
            const ts = c.createdAt?.toMillis?.() || 0;
            return `
            <div class="game-comment" data-id="${esc(c.id)}">
                <div class="game-comment-head">
                    <span class="game-comment-author"
                          data-open-profile-uid="${esc(c.authorUid || '')}"
                          role="button" tabindex="0">${esc(c.authorName || 'unknown')}</span>
                    <span class="game-comment-time">${esc(timeAgo(ts))}</span>
                    ${canDelete ? `<button class="game-comment-del" data-id="${esc(c.id)}" title="Delete">&times;</button>` : ''}
                </div>
                <div class="game-comment-text">${esc(c.text || '')}</div>
            </div>`;
        }).join('');

        listEl.querySelectorAll('.game-comment-del').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm('Delete this comment?')) return;
                try { await db.collection('game_comments').doc(btn.dataset.id).delete(); }
                catch (e) { alert('Delete failed: ' + (e?.message || e)); }
            });
        });
    }

    window.ArcadeComments = { mount };
})();
