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
    // Persist the collapse preference so expanding once doesn't revert on
    // every refresh. null = use default (collapse if >1 post).
    const COLLAPSE_KEY = 'arcade-patchnotes-collapsed';
    let collapsed = (function () {
        const v = localStorage.getItem(COLLAPSE_KEY);
        if (v === 'true') return true;
        if (v === 'false') return false;
        return null;
    })();

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
    // double \n → new <p>. No markdown, but we DO run `:emojiname:` through
    // the shared emoji system so patchnotes can use custom arcade emojis
    // just like chat.
    function renderBody(text) {
        const escaped = esc(text || '');
        const paragraphs = escaped
            .split(/\n{2,}/)
            .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
            .join('');
        return (window.ArcadeEmojis?.replaceEmojis)
            ? ArcadeEmojis.replaceEmojis(paragraphs)
            : paragraphs;
    }

    // Same compression budget as DM images — 600px long side, JPEG 0.72.
    // Keeps the doc comfortably under the 1 MB Firestore ceiling.
    const PATCHNOTE_IMAGE_MAX_DIM = 600;
    const PATCHNOTE_IMAGE_QUALITY = 0.72;
    const PATCHNOTE_IMAGE_SOURCE_MAX = 8 * 1024 * 1024;
    function compressImage(file) {
        return new Promise((resolve, reject) => {
            if (!file.type.startsWith('image/')) { reject(new Error('Not an image')); return; }
            if (file.size > PATCHNOTE_IMAGE_SOURCE_MAX) { reject(new Error('Image too large')); return; }
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    let w = img.width, h = img.height;
                    if (w > PATCHNOTE_IMAGE_MAX_DIM || h > PATCHNOTE_IMAGE_MAX_DIM) {
                        if (w > h) { h = Math.round(h * PATCHNOTE_IMAGE_MAX_DIM / w); w = PATCHNOTE_IMAGE_MAX_DIM; }
                        else       { w = Math.round(w * PATCHNOTE_IMAGE_MAX_DIM / h); h = PATCHNOTE_IMAGE_MAX_DIM; }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                    resolve(canvas.toDataURL(mime, PATCHNOTE_IMAGE_QUALITY));
                };
                img.onerror = () => reject(new Error('Decode failed'));
                img.src = e.target.result;
            };
            reader.onerror = () => reject(new Error('Read failed'));
            reader.readAsDataURL(file);
        });
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

        // Click any rendered image to zoom — reuses the same lightbox that
        // DM / group messages use so it's one consistent behavior.
        block.querySelectorAll('.patchnote-image').forEach(img => {
            img.addEventListener('click', () => {
                if (window.ArcadeMessages?.showImageLightbox) {
                    ArcadeMessages.showImageLightbox(img.src);
                } else {
                    window.open(img.src, '_blank');
                }
            });
        });

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
            try { localStorage.setItem(COLLAPSE_KEY, String(collapsed)); } catch {}
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
        const imageHtml = p.imageUrl
            ? `<img class="patchnote-image" src="${esc(p.imageUrl)}" alt="" loading="lazy">`
            : '';
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
                ${imageHtml}
                <div class="patchnote-body">${renderBody(p.body)}</div>
            </article>
        `;
    }

    // ─────────────────────────────────────────────────────────────
    // Editor modal (admin only)
    // ─────────────────────────────────────────────────────────────

    function showEditor(existing) {
        // Start with the existing image if editing; null otherwise. "remove"
        // lets the admin explicitly clear an image on an existing post.
        let pendingImage = existing?.imageUrl || null;
        let imageCleared = false;

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
                <div class="patchnote-editor-toolbar">
                    <button type="button" class="patchnote-toolbar-btn" id="patchnoteImageBtn">&#128247; Add image</button>
                    <button type="button" class="patchnote-toolbar-btn emoji-picker-btn" id="patchnoteEmojiBtn">&#128512; Emoji</button>
                    <input type="file" id="patchnoteImageFile" accept="image/*" style="display:none;">
                </div>
                <div class="patchnote-image-preview" id="patchnoteImagePreview" style="${pendingImage ? '' : 'display:none;'}">
                    <img id="patchnoteImagePreviewImg" src="${esc(pendingImage || '')}" alt="">
                    <button type="button" class="patchnote-image-preview-clear" id="patchnoteImagePreviewClear">Remove</button>
                </div>
                <textarea id="patchnoteBody" class="auth-input patchnote-body-input" rows="10" placeholder="Write your announcement — blank lines become new paragraphs. Plain text with :emoji: codes supported." maxlength="4000">${esc(existing?.body || '')}</textarea>
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

        const bodyInput = document.getElementById('patchnoteBody');
        const previewEl = document.getElementById('patchnoteImagePreview');
        const previewImg = document.getElementById('patchnoteImagePreviewImg');
        const fileInput = document.getElementById('patchnoteImageFile');

        document.getElementById('patchnoteImageBtn').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
            const f = fileInput.files?.[0];
            fileInput.value = '';
            if (!f) return;
            try {
                const dataUrl = await compressImage(f);
                pendingImage = dataUrl;
                imageCleared = false;
                previewImg.src = dataUrl;
                previewEl.style.display = 'flex';
            } catch (err) { alert('Image failed: ' + err.message); }
        });
        document.getElementById('patchnoteImagePreviewClear').addEventListener('click', () => {
            pendingImage = null;
            imageCleared = true;
            previewImg.src = '';
            previewEl.style.display = 'none';
        });
        document.getElementById('patchnoteEmojiBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.ArcadeEmojis?.renderEmojiPicker) {
                ArcadeEmojis.renderEmojiPicker(overlay.querySelector('.patchnote-editor'), bodyInput);
            }
        });

        document.getElementById('patchnoteSaveBtn').addEventListener('click', async () => {
            const title = document.getElementById('patchnoteTitle').value.trim().slice(0, 120);
            const body = bodyInput.value.trim().slice(0, 4000);
            const pinned = document.getElementById('patchnotePinned').checked;
            // Title still required, but body is optional when there's an image
            if (!title) { alert('Title required.'); return; }
            if (!body && !pendingImage) { alert('Add a body or an image.'); return; }
            const user = ArcadeAuth.getUser();
            try {
                if (existing) {
                    const update = { title, body, pinned };
                    // If the user picked a new image OR explicitly cleared the
                    // existing one, update the field. Otherwise leave it alone.
                    if (pendingImage && pendingImage !== existing.imageUrl) {
                        update.imageUrl = pendingImage;
                    } else if (imageCleared) {
                        update.imageUrl = firebase.firestore.FieldValue.delete();
                    }
                    await getDb().collection('patchnotes').doc(existing.id).update(update);
                } else {
                    const doc = {
                        title, body, pinned,
                        authorUid: user.uid,
                        authorName: ArcadeAuth.getUsername(),
                        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    };
                    if (pendingImage) doc.imageUrl = pendingImage;
                    await getDb().collection('patchnotes').add(doc);
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
