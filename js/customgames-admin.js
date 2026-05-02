// Admin UI for adding / editing / deleting custom games.
//
// Workflow:
//   1. Admin clicks "Add custom game" in Settings → Admin tools
//   2. Modal opens with a drop-zone for the .html file + form fields
//   3. Drop the file → reads it, autofills title from <title> tag,
//      shows a preview of the first chars
//   4. Fill in metadata (description, category, tags, thumbnail)
//   5. Submit → writes to Firestore /customGames/{slug}
//
// Edit/delete: list view of existing custom games with inline edit/del.

(function () {
    function isAdmin() { return window.ArcadeAuth?.isAdmin?.(); }
    function getDb()   { return window.ArcadeAuth?.getDb?.(); }
    function getMe()   { return window.ArcadeAuth?.getUser?.(); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Slug a string into a safe Firestore doc id. Lowercase, alpha-num
    // + hyphens. Capped at 80 chars. Empty → 'untitled'.
    function slugify(s) {
        return String(s || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80) || 'untitled';
    }

    function extractTitleFromHtml(html) {
        const m = String(html || '').match(/<title[^>]*>([^<]+)<\/title>/i);
        return m ? m[1].trim() : '';
    }

    const CATEGORIES = [
        'Pokemon', 'Racing', 'Adventure', 'Action', 'Sports', 'Puzzle',
        'Strategy', 'Simulation', 'Shooter', 'Platformer', 'Fighting',
        'Horror', 'Mario', 'Sonic', 'Minecraft', 'Other',
    ];

    async function showCustomGamesModal() {
        if (!isAdmin()) return;
        document.getElementById('customGamesModal')?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'customGamesModal';
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);

        renderShell(overlay);
        await renderListView(overlay);
    }

    function renderShell(overlay) {
        overlay.innerHTML = `
            <div class="modal-box modal-box-wide">
                <div class="modal-header">
                    <h2>Custom games</h2>
                    <button class="modal-close" id="cgClose">&times;</button>
                </div>
                <div class="cg-toolbar">
                    <button class="auth-submit" id="cgNewBtn">+ Add custom game</button>
                    <button class="auth-submit-secondary" id="cgRefreshBtn">Refresh</button>
                </div>
                <div id="cgPane"></div>
            </div>
        `;
        overlay.querySelector('#cgClose').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#cgNewBtn').addEventListener('click', () => renderEditView(overlay, null));
        overlay.querySelector('#cgRefreshBtn').addEventListener('click', () => {
            window.ArcadeCustomGames?.invalidate?.();
            renderListView(overlay);
        });
    }

    async function renderListView(overlay) {
        const pane = overlay.querySelector('#cgPane');
        pane.innerHTML = '<div class="cg-empty">Loading…</div>';
        try {
            const games = (await window.ArcadeCustomGames.fetch()) || [];
            if (!games.length) {
                pane.innerHTML = '<div class="cg-empty">No custom games yet. Click "Add custom game" to upload your first one.</div>';
                return;
            }
            pane.innerHTML = `
                <div class="cg-list">
                    ${games.map(g => `
                        <div class="cg-row">
                            ${g.thumbnail
                                ? `<img class="cg-thumb" src="${esc(g.thumbnail)}" alt="">`
                                : `<div class="cg-thumb cg-thumb-placeholder">${esc((g.title||'?').charAt(0).toUpperCase())}</div>`}
                            <div class="cg-meat">
                                <div class="cg-title">${esc(g.title)}</div>
                                <div class="cg-meta">
                                    <code>${esc(g.id)}</code> · ${esc(g.category || 'Other')}
                                    · ${(g.tags || []).slice(0, 3).map(esc).join(', ') || '<em>no tags</em>'}
                                </div>
                            </div>
                            <div class="cg-actions">
                                <a class="cg-action" href="play.html?game=${encodeURIComponent(g.id)}" target="_blank" rel="noopener">Play</a>
                                <button class="cg-action" data-edit="${esc(g.id)}">Edit</button>
                                <button class="cg-action cg-action-danger" data-del="${esc(g.id)}">Delete</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
            pane.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
                const game = games.find(g => g.id === b.dataset.edit);
                renderEditView(overlay, game);
            }));
            pane.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
                const id = b.dataset.del;
                if (!confirm(`Delete custom game "${id}"? This cannot be undone.`)) return;
                try {
                    await getDb().collection('customGames').doc(id).delete();
                    window.ArcadeCustomGames?.invalidate?.();
                    await renderListView(overlay);
                } catch (e) {
                    alert('Delete failed: ' + e.message);
                }
            }));
        } catch (e) {
            pane.innerHTML = `<div class="cg-empty">Error: ${esc(e.message)}</div>`;
        }
    }

    function renderEditView(overlay, existing) {
        const pane = overlay.querySelector('#cgPane');
        const isEdit = !!existing;
        // For edit mode we need the html field. customGames.fetch()
        // already includes _html for our cache.
        const html = existing?._html || '';
        pane.innerHTML = `
            <div class="cg-edit">
                ${isEdit ? `<div class="cg-edit-banner">Editing <code>${esc(existing.id)}</code></div>` : ''}

                <div class="cg-dropzone" id="cgDrop" tabindex="0">
                    <div class="cg-dropzone-hint">
                        <span class="cg-dropzone-icon">&#128190;</span>
                        Drop your <code>.html</code> file here, or click to pick
                        <span class="cg-dropzone-sub">Captured: <span id="cgFileName">${html ? '<em>(loaded)</em>' : 'nothing'}</span></span>
                    </div>
                </div>
                <input type="file" id="cgFile" accept=".html,.htm,text/html" style="display:none;">

                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgIdInput">Game ID <span class="profile-edit-hint">(URL slug, lowercase letters/digits/dashes)</span></label>
                    <input type="text" id="cgIdInput" class="auth-input" maxlength="80"
                           placeholder="my-cool-game"
                           value="${esc(existing?.id || '')}"
                           ${isEdit ? 'readonly' : ''}>
                </div>

                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgTitleInput">Title</label>
                    <input type="text" id="cgTitleInput" class="auth-input" maxlength="80"
                           placeholder="My Cool Game"
                           value="${esc(existing?.title || '')}">
                </div>

                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgCatInput">Category</label>
                    <select id="cgCatInput" class="profile-edit-bio" style="min-height:auto;height:38px;">
                        ${CATEGORIES.map(c => `<option value="${c}" ${(existing?.category || 'Other') === c ? 'selected' : ''}>${c}</option>`).join('')}
                    </select>
                </div>

                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgTagsInput">Tags <span class="profile-edit-hint">(comma-separated)</span></label>
                    <input type="text" id="cgTagsInput" class="auth-input" maxlength="500"
                           placeholder="puzzle, indie, html5"
                           value="${esc((existing?.tags || []).join(', '))}">
                </div>

                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgThumbInput">Thumbnail URL <span class="profile-edit-hint">(optional)</span></label>
                    <input type="url" id="cgThumbInput" class="auth-input" maxlength="500"
                           placeholder="https://… png/jpg/gif/webp"
                           value="${esc(existing?.thumbnail || '')}">
                </div>

                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgDescInput">Description</label>
                    <textarea id="cgDescInput" class="profile-edit-bio" maxlength="500"
                              placeholder="What's the game?">${esc(existing?.description || '')}</textarea>
                </div>

                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgHtmlInput">Wrapper HTML <span class="profile-edit-hint">(loaded from drop above, or paste/edit here. Capped at 500KB.)</span></label>
                    <textarea id="cgHtmlInput" class="profile-edit-bio cg-html-textarea"
                              placeholder="<!DOCTYPE html>...">${esc(html)}</textarea>
                    <div class="cg-size" id="cgSize">0 KB / 500 KB</div>
                </div>

                <div class="cg-edit-actions">
                    <button class="auth-submit-secondary" id="cgCancelBtn">Cancel</button>
                    <button class="auth-submit" id="cgSaveBtn">${isEdit ? 'Save changes' : 'Create game'}</button>
                </div>
            </div>
        `;

        // ─── Drop-zone wiring ───────────────────────────────────
        const drop = pane.querySelector('#cgDrop');
        const fileInput = pane.querySelector('#cgFile');
        const fileNameEl = pane.querySelector('#cgFileName');
        const htmlEl = pane.querySelector('#cgHtmlInput');
        const sizeEl = pane.querySelector('#cgSize');
        const titleEl = pane.querySelector('#cgTitleInput');
        const idEl = pane.querySelector('#cgIdInput');

        function updateSize() {
            const bytes = new Blob([htmlEl.value]).size;
            sizeEl.textContent = `${(bytes / 1024).toFixed(1)} KB / 500 KB`;
            sizeEl.style.color = bytes > 500 * 1024 ? '#fca5a5' : '';
        }
        htmlEl.addEventListener('input', updateSize);
        updateSize();

        function ingest(file) {
            if (!file) return;
            if (!/\.html?$/i.test(file.name) && file.type !== 'text/html') {
                alert('Pick an .html file.');
                return;
            }
            if (file.size > 500 * 1024) {
                alert(`File is ${(file.size / 1024).toFixed(0)} KB. Cap is 500 KB.`);
                return;
            }
            const reader = new FileReader();
            reader.onload = e => {
                htmlEl.value = String(e.target.result || '');
                updateSize();
                fileNameEl.textContent = file.name;
                // Auto-extract title from <title> tag if title input is empty
                if (!titleEl.value.trim()) {
                    const t = extractTitleFromHtml(htmlEl.value);
                    if (t) titleEl.value = t;
                }
                // Auto-slug if id input is empty (and not edit mode)
                if (!isEdit && !idEl.value.trim() && titleEl.value) {
                    idEl.value = slugify(titleEl.value);
                }
            };
            reader.readAsText(file);
        }

        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
            e.preventDefault(); e.stopPropagation();
            drop.classList.add('is-dragover');
        }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
            e.preventDefault(); e.stopPropagation();
            drop.classList.remove('is-dragover');
        }));
        drop.addEventListener('drop', e => {
            const f = e.dataTransfer?.files?.[0];
            if (f) ingest(f);
        });
        drop.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            const f = fileInput.files?.[0];
            if (f) ingest(f);
        });

        // Auto-derive id from title when title changes (only in create mode)
        if (!isEdit) {
            titleEl.addEventListener('input', () => {
                if (!idEl.value.trim() || idEl.dataset.autoSlug === '1') {
                    idEl.value = slugify(titleEl.value);
                    idEl.dataset.autoSlug = '1';
                }
            });
            idEl.addEventListener('input', () => {
                idEl.dataset.autoSlug = '0';
            });
        }

        // ─── Save ───────────────────────────────────────────────
        pane.querySelector('#cgCancelBtn').addEventListener('click', () => renderListView(overlay));
        pane.querySelector('#cgSaveBtn').addEventListener('click', async () => {
            const id = slugify(idEl.value);
            const title = titleEl.value.trim().slice(0, 80) || id;
            const category = pane.querySelector('#cgCatInput').value;
            const tags = pane.querySelector('#cgTagsInput').value
                .split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
            const thumbnail = pane.querySelector('#cgThumbInput').value.trim().slice(0, 500);
            const description = pane.querySelector('#cgDescInput').value.trim().slice(0, 500);
            const html = htmlEl.value;
            if (!id) { alert('Need a game ID.'); return; }
            if (!title) { alert('Need a title.'); return; }
            if (!html) { alert('Need wrapper HTML — drop a file or paste it.'); return; }
            const bytes = new Blob([html]).size;
            if (bytes > 500 * 1024) {
                alert(`HTML is ${(bytes / 1024).toFixed(0)} KB. Cap is 500 KB.`);
                return;
            }

            const me = getMe();
            const myProfile = me ? await window.ArcadeAuth.getProfile(me.uid).catch(() => null) : null;
            const payload = {
                title, description, category, tags, thumbnail, html,
                authorUid: me?.uid || null,
                authorName: myProfile?.username || null,
                addedAt: new Date().toISOString(),
            };
            if (!isEdit) {
                payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            }

            const btn = pane.querySelector('#cgSaveBtn');
            btn.disabled = true; btn.textContent = 'Saving…';
            try {
                await getDb().collection('customGames').doc(id).set(payload, { merge: true });
                window.ArcadeCustomGames?.invalidate?.();
                await renderListView(overlay);
            } catch (e) {
                alert('Save failed: ' + e.message);
                btn.disabled = false;
                btn.textContent = isEdit ? 'Save changes' : 'Create game';
            }
        });
    }

    window.ArcadeCustomGamesAdmin = { showCustomGamesModal };
})();
