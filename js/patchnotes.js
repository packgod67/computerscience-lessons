// ===== Patchnotes / announcements =====
// Admin-authored posts that appear at the top of the Games view for
// everyone. Useful for "new games added", "scheduled maintenance",
// "feature X just shipped" — short blog-style announcements.
//
// Schema — `patchnotes/{id}`:
//   title       string (<=120 chars)
//   body        string (<=4000 chars, plain text — line breaks preserved)
//   authorUid   creator uid
//   authorName  creator username cached at post time
//   createdAt   server timestamp
//   pinned      boolean — pinned posts sort above the rest
//
// Required Firestore rule:
//   match /patchnotes/{id} {
//     allow read: if request.auth != null;
//     allow write: if request.auth != null
//       && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
//   }

(function () {
    let db = null;
    let posts = [];
    let unsub = null;
    let collapsed = null;  // null = use default, true/false = user choice

    function getDb() {
        if (!db) db = ArcadeAuth.getDb();
        return db;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Render plain text with paragraph breaks preserved. Single \n → <br>,
    // double \n → new <p>. No markdown — keep the blast radius small.
    function renderBody(text) {
        const escaped = esc(text || '');
        return escaped
            .split(/\n{2,}/)
            .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
            .join('');
    }

    function timeAgo(ms) {
        if (!ms) return '';
        const s = Math.floor((Date.now() - ms) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        const days = Math.floor(s / 86400);
        if (days < 30) return days + 'd ago';
        return new Date(ms).toLocaleDateString();
    }

    // ─────────────────────────────────────────────────────────────
    // Rendering
    // ─────────────────────────────────────────────────────────────

    function mount() {
        // Insert patchnotes block once, as the very first child of the Games
        // view (above the search controls so it's the first thing people see).
        if (document.getElementById('patchnotesBlock')) return;
        const gamesView = document.getElementById('gamesView');
        if (!gamesView) return;
        const block = document.createElement('section');
        block.id = 'patchnotesBlock';
        block.className = 'patchnotes-block';
        block.style.display = 'none';  // render() will reveal it if there are posts
        gamesView.insertBefore(block, gamesView.firstChild);
    }

    function render() {
        const block = document.getElementById('patchnotesBlock');
        if (!block) return;

        const isAdmin = ArcadeAuth.isAdmin?.();

        // Sort: pinned first, then newest-first
        const sorted = [...posts].sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            const ta = a.createdAt?.toMillis?.() || 0;
            const tb = b.createdAt?.toMillis?.() || 0;
            return tb - ta;
        });

        if (sorted.length === 0 && !isAdmin) {
            block.style.display = 'none';
            return;
        }
        block.style.display = '';

        const adminBar = isAdmin
            ? `<button class="patchnotes-new-btn" id="patchnotesNewBtn" type="button">+ New patchnote</button>`
            : '';

        // When collapsed, we only show the first post. Toggle flips to "show
        // all" and back. Default: collapsed if more than 1 post.
        const isCollapsed = collapsed === null ? sorted.length > 1 : collapsed;
        const visible = isCollapsed ? sorted.slice(0, 1) : sorted;

        const toggleBtn = sorted.length > 1
            ? `<button class="patchnotes-toggle" id="patchnotesToggle" type="button">
                    ${isCollapsed ? `Show all ${sorted.length} posts` : 'Collapse'}
               </button>`
            : '';

        const postsHtml = visible.map(p => renderPost(p, isAdmin)).join('');
        const emptyHtml = sorted.length === 0
            ? `<div class="patchnotes-empty">No announcements yet — click "New patchnote" to post the first one.</div>`
            : '';

        block.innerHTML = `
            <div class="patchnotes-header">
                <h2 class="patchnotes-title">&#128226; Announcements</h2>
                ${adminBar}
            </div>
            <div class="patchnotes-list">${postsHtml}${emptyHtml}</div>
            ${toggleBtn}
        `;

        if (isAdmin) {
            document.getElementById('patchnotesNewBtn')?.addEventListener('click', () => showEditor(null));
            block.querySelectorAll('.patchnote-edit').forEach(b => {
                b.addEventListener('click', () => {
                    const id = b.dataset.id;
                    showEditor(posts.find(p => p.id === id));
                });
            });
            block.querySelectorAll('.patchnote-delete').forEach(b => {
                b.addEventListener('click', async () => {
                    if (!confirm('Delete this patchnote?')) return;
                    try {
                        await getDb().collection('patchnotes').doc(b.dataset.id).delete();
                    } catch (e) { alert('Delete failed: ' + e.message); }
                });
            });
            block.querySelectorAll('.patchnote-pin').forEach(b => {
                b.addEventListener('click', async () => {
                    const id = b.dataset.id;
                    const p = posts.find(x => x.id === id);
                    if (!p) return;
                    try {
                        await getDb().collection('patchnotes').doc(id)
                            .update({ pinned: !p.pinned });
                    } catch (e) { alert('Pin failed: ' + e.message); }
                });
            });
        }

        const toggle = document.getElementById('patchnotesToggle');
        if (toggle) toggle.addEventListener('click', () => {
            collapsed = !isCollapsed;
            render();
        });
    }

    function renderPost(p, isAdmin) {
        const ts = p.createdAt?.toMillis?.();
        const adminBtns = isAdmin ? `
            <span class="patchnote-actions">
                <button class="patchnote-pin" data-id="${esc(p.id)}" title="${p.pinned ? 'Unpin' : 'Pin'}">${p.pinned ? '&#128276;' : '&#128205;'}</button>
                <button class="patchnote-edit" data-id="${esc(p.id)}" title="Edit">&#9998;</button>
                <button class="patchnote-delete" data-id="${esc(p.id)}" title="Delete">&times;</button>
            </span>` : '';
        return `
            <article class="patchnote-card${p.pinned ? ' is-pinned' : ''}">
                <header class="patchnote-header">
                    <h3 class="patchnote-title">${p.pinned ? '<span class="patchnote-pin-badge">PINNED</span> ' : ''}${esc(p.title || 'Untitled')}</h3>
                    ${adminBtns}
                </header>
                <div class="patchnote-meta">
                    <span class="patchnote-author">${esc(p.authorName || 'admin')}</span>
                    <span class="patchnote-time">${esc(timeAgo(ts))}</span>
                </div>
                <div class="patchnote-body">${renderBody(p.body)}</div>
            </article>
        `;
    }

    // ─────────────────────────────────────────────────────────────
    // Editor modal (admin only)
    // ─────────────────────────────────────────────────────────────

    function showEditor(existing) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'patchnoteEditor';
        overlay.innerHTML = `
            <div class="modal-box patchnote-editor">
                <div class="modal-header">
                    <h2>${existing ? 'Edit' : 'New'} patchnote</h2>
                    <button class="modal-close" id="patchnoteCloseBtn">&times;</button>
                </div>
                <input type="text" id="patchnoteTitle" class="auth-input" placeholder="Title (e.g. 'Added 50 new Pokemon games')" maxlength="120" value="${esc(existing?.title || '')}">
                <textarea id="patchnoteBody" class="auth-input patchnote-body-input" rows="10" placeholder="Write your announcement — blank lines become new paragraphs. No HTML or markdown, just plain text." maxlength="4000">${esc(existing?.body || '')}</textarea>
                <label class="patchnote-pin-toggle">
                    <input type="checkbox" id="patchnotePinned" ${existing?.pinned ? 'checked' : ''}>
                    Pin to top
                </label>
                <div class="patchnote-editor-actions">
                    <button class="auth-submit" id="patchnoteSaveBtn">${existing ? 'Save changes' : 'Post'}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.getElementById('patchnoteCloseBtn').addEventListener('click', close);

        document.getElementById('patchnoteSaveBtn').addEventListener('click', async () => {
            const title = document.getElementById('patchnoteTitle').value.trim().slice(0, 120);
            const body = document.getElementById('patchnoteBody').value.trim().slice(0, 4000);
            const pinned = document.getElementById('patchnotePinned').checked;
            if (!title || !body) {
                alert('Title and body required.');
                return;
            }
            const user = ArcadeAuth.getUser();
            try {
                if (existing) {
                    await getDb().collection('patchnotes').doc(existing.id)
                        .update({ title, body, pinned });
                } else {
                    await getDb().collection('patchnotes').add({
                        title, body, pinned,
                        authorUid: user.uid,
                        authorName: ArcadeAuth.getUsername(),
                        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    });
                }
                close();
            } catch (e) { alert('Save failed: ' + e.message); }
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Listener + bootstrap
    // ─────────────────────────────────────────────────────────────

    function startListener() {
        if (unsub) return;
        unsub = getDb().collection('patchnotes').onSnapshot((snap) => {
            posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            render();
        }, (err) => console.warn('Patchnotes listener error:', err));
    }

    function stopListener() {
        if (unsub) { unsub(); unsub = null; }
        posts = [];
    }

    ArcadeAuth.waitForAuth().then(() => {
        mount();
        ArcadeAuth.onAuthChange(() => {
            stopListener();
            if (ArcadeAuth.isLoggedIn()) startListener();
            else render();  // hide block for logged-out users
        });
        if (ArcadeAuth.isLoggedIn()) startListener();
    });

    window.ArcadePatchnotes = {
        render,
    };
})();
