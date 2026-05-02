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
                    <button class="auth-submit" id="cgNewBtn">+ Single HTML file</button>
                    <button class="auth-submit" id="cgNewMultiBtn">+ Multi-file folder/zip</button>
                    <button class="auth-submit-secondary" id="cgRefreshBtn">Refresh</button>
                </div>
                <div id="cgPane"></div>
            </div>
        `;
        overlay.querySelector('#cgClose').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#cgNewBtn').addEventListener('click', () => renderEditView(overlay, null));
        // Multi-file upload disabled until Firebase Storage is provisioned —
        // the button is no longer rendered, but the function below still
        // exists so it can be re-enabled by reverting the toolbar HTML.
        overlay.querySelector('#cgNewMultiBtn')?.addEventListener('click', () => renderMultiUploadView(overlay));
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
                    const game = games.find(g => g.id === id);
                    // Multi-file games also have files committed to the
                    // repo — ask the worker to remove them in the same
                    // commit as the doc deletion. Single-file games only
                    // need the Firestore doc gone.
                    if (game?._isMulti) {
                        const me = getMe();
                        const idToken = me ? await me.getIdToken() : null;
                        if (idToken) {
                            await fetch(`https://arcad-groq.gatabanumai.workers.dev/uploads/${encodeURIComponent(id)}`, {
                                method: 'DELETE',
                                headers: { Authorization: `Bearer ${idToken}` },
                            }).catch(() => {});
                        }
                    }
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

    // ─── Multi-file upload view ────────────────────────────────
    // Lets admins drop a folder OR a .zip, uploads each file to
    // Firebase Storage under customGames/<gameId>/, writes a
    // manifest doc to Firestore, and the game is playable
    // immediately via player.js.
    function renderMultiUploadView(overlay) {
        const pane = overlay.querySelector('#cgPane');
        let pickedFiles = []; // [{ relpath, file }]

        pane.innerHTML = `
            <div class="cg-edit">
                <div class="cg-edit-banner">Multi-file upload — drop a folder or .zip. Each file becomes a Firebase Storage object. Total cap: 100 MB / 500 files.</div>

                <div class="cg-dropzone" id="cgMultiDrop" tabindex="0">
                    <div class="cg-dropzone-hint">
                        <span class="cg-dropzone-icon">&#128193;</span>
                        Drop a folder or a <code>.zip</code> here, or click to pick a folder
                        <span class="cg-dropzone-sub">Selected: <span id="cgMultiCount">none</span></span>
                    </div>
                </div>
                <input type="file" id="cgFolderPick" webkitdirectory directory multiple style="display:none;">
                <input type="file" id="cgZipPick" accept=".zip,application/zip" style="display:none;">
                <div class="cg-multi-actions">
                    <button class="auth-submit-secondary" id="cgPickFolderBtn">Pick folder</button>
                    <button class="auth-submit-secondary" id="cgPickZipBtn">Pick .zip</button>
                </div>

                <div class="cg-file-list" id="cgFileList"></div>

                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgEntrySelect">Entry HTML <span class="profile-edit-hint">(the file the iframe loads)</span></label>
                    <select id="cgEntrySelect" class="profile-edit-bio" style="min-height:auto;height:38px;"></select>
                </div>

                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgMultiId">Game ID</label>
                    <input type="text" id="cgMultiId" class="auth-input" maxlength="80" placeholder="my-cool-game">
                </div>
                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgMultiTitle">Title</label>
                    <input type="text" id="cgMultiTitle" class="auth-input" maxlength="80" placeholder="My Cool Game">
                </div>
                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgMultiCat">Category</label>
                    <select id="cgMultiCat" class="profile-edit-bio" style="min-height:auto;height:38px;">
                        ${CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
                    </select>
                </div>
                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgMultiTags">Tags</label>
                    <input type="text" id="cgMultiTags" class="auth-input" maxlength="500" placeholder="indie, html5, browser-native">
                </div>
                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgMultiThumb">Thumbnail URL <span class="profile-edit-hint">(optional)</span></label>
                    <input type="url" id="cgMultiThumb" class="auth-input" maxlength="500" placeholder="https://… or auto-pick from cover.png if uploaded">
                </div>
                <div class="profile-edit-row">
                    <label class="profile-edit-label" for="cgMultiDesc">Description</label>
                    <textarea id="cgMultiDesc" class="profile-edit-bio" maxlength="500" placeholder="What's the game?"></textarea>
                </div>

                <div class="cg-progress" id="cgProgress" style="display:none;"></div>

                <div class="cg-edit-actions">
                    <button class="auth-submit-secondary" id="cgMultiCancel">Cancel</button>
                    <button class="auth-submit" id="cgMultiSave">Upload + create game</button>
                </div>
            </div>
        `;

        const drop      = pane.querySelector('#cgMultiDrop');
        const folderPk  = pane.querySelector('#cgFolderPick');
        const zipPk     = pane.querySelector('#cgZipPick');
        const countEl   = pane.querySelector('#cgMultiCount');
        const listEl    = pane.querySelector('#cgFileList');
        const entrySel  = pane.querySelector('#cgEntrySelect');
        const idEl      = pane.querySelector('#cgMultiId');
        const titleEl   = pane.querySelector('#cgMultiTitle');
        const progress  = pane.querySelector('#cgProgress');

        function refreshFileList() {
            countEl.textContent = pickedFiles.length
                ? `${pickedFiles.length} files (${formatBytes(pickedFiles.reduce((a, f) => a + f.file.size, 0))})`
                : 'none';
            listEl.innerHTML = pickedFiles.length
                ? `<div class="cg-file-list-inner">${pickedFiles.slice(0, 30).map(f =>
                    `<div class="cg-file-row"><code>${esc(f.relpath)}</code><span>${formatBytes(f.file.size)}</span></div>`
                  ).join('')}${pickedFiles.length > 30 ? `<div class="cg-file-more">+${pickedFiles.length - 30} more files</div>` : ''}</div>`
                : '';
            // Populate entry-select with HTML files; auto-select index/main
            entrySel.innerHTML = '';
            const htmls = pickedFiles.filter(f => /\.html?$/i.test(f.relpath));
            for (const f of htmls) {
                const o = document.createElement('option');
                o.value = f.relpath; o.textContent = f.relpath;
                entrySel.appendChild(o);
            }
            const auto = htmls.find(f => /(^|\/)index\.html$/i.test(f.relpath))
                      || htmls.find(f => /(^|\/)main\.html$/i.test(f.relpath))
                      || htmls[0];
            if (auto) entrySel.value = auto.relpath;
        }

        function ingestFiles(fileList, prefixToStrip) {
            // Files come from <input webkitdirectory> with .webkitRelativePath
            // populated, OR from a zip extraction with synthetic paths.
            const files = [];
            for (const f of fileList) {
                let rel = f.webkitRelativePath || f.name;
                if (prefixToStrip && rel.startsWith(prefixToStrip)) {
                    rel = rel.slice(prefixToStrip.length);
                }
                // Drop the top-level folder prefix so paths inside the
                // game are clean (e.g. "my-game/index.html" → "index.html")
                if (rel.includes('/')) {
                    const top = rel.split('/')[0];
                    // Only strip if all files share that top-level dir
                    rel = rel.startsWith(top + '/') ? rel.slice(top.length + 1) : rel;
                }
                if (!rel) continue;
                // Skip junk
                if (/(^|\/)(\.DS_Store|Thumbs\.db|\.git\/|node_modules\/)/.test(rel)) continue;
                files.push({ relpath: rel, file: f });
            }
            pickedFiles = files;
            refreshFileList();
            // Auto-suggest id from the top-level folder if any
            const sample = fileList[0]?.webkitRelativePath || '';
            if (sample.includes('/') && !idEl.value) {
                idEl.value = slugify(sample.split('/')[0]);
                if (!titleEl.value) titleEl.value = sample.split('/')[0];
            }
        }

        async function ingestZip(zipFile) {
            // Lazy-load JSZip from CDN
            if (!window.JSZip) {
                await new Promise((resolve, reject) => {
                    const s = document.createElement('script');
                    s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
                    s.onload = resolve; s.onerror = reject;
                    document.head.appendChild(s);
                });
            }
            const zip = await window.JSZip.loadAsync(zipFile);
            const files = [];
            const entries = Object.values(zip.files).filter(e => !e.dir);
            // Detect common top-level folder to strip
            const tops = new Set(entries.map(e => e.name.split('/')[0]));
            const stripTop = tops.size === 1 ? Array.from(tops)[0] + '/' : null;
            for (const entry of entries) {
                let rel = entry.name;
                if (stripTop && rel.startsWith(stripTop)) rel = rel.slice(stripTop.length);
                if (!rel) continue;
                if (/(^|\/)(\.DS_Store|Thumbs\.db|\.git\/|node_modules\/)/.test(rel)) continue;
                const blob = await entry.async('blob');
                // Wrap as a File so the upload code path is uniform
                const file = new File([blob], rel.split('/').pop(), { type: blob.type });
                file.webkitRelativePath = rel; // for consistent display
                files.push({ relpath: rel, file });
            }
            pickedFiles = files;
            refreshFileList();
            // Auto-id from zip filename
            if (!idEl.value) {
                const base = zipFile.name.replace(/\.zip$/i, '');
                idEl.value = slugify(base);
                if (!titleEl.value) titleEl.value = base;
            }
        }

        // Drop-zone wiring
        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
            e.preventDefault(); e.stopPropagation();
            drop.classList.add('is-dragover');
        }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
            e.preventDefault(); e.stopPropagation();
            drop.classList.remove('is-dragover');
        }));
        drop.addEventListener('drop', async e => {
            const dt = e.dataTransfer;
            // Single .zip dropped
            if (dt.files && dt.files.length === 1 && /\.zip$/i.test(dt.files[0].name)) {
                await ingestZip(dt.files[0]);
                return;
            }
            // Folder via DataTransferItemList → use webkitGetAsEntry walk
            if (dt.items && dt.items[0]?.webkitGetAsEntry) {
                const all = [];
                async function walk(entry, prefix) {
                    if (entry.isFile) {
                        await new Promise(r => entry.file(f => {
                            f.webkitRelativePath = (prefix + entry.name);
                            all.push(f); r();
                        }));
                    } else if (entry.isDirectory) {
                        const reader = entry.createReader();
                        const kids = await new Promise(r => reader.readEntries(r));
                        for (const k of kids) await walk(k, prefix + entry.name + '/');
                    }
                }
                for (const item of dt.items) {
                    const entry = item.webkitGetAsEntry();
                    if (entry) await walk(entry, '');
                }
                ingestFiles(all);
                return;
            }
            // Plain file list — treat as flat
            if (dt.files) ingestFiles(dt.files);
        });
        drop.addEventListener('click', () => folderPk.click());

        pane.querySelector('#cgPickFolderBtn').addEventListener('click', () => folderPk.click());
        pane.querySelector('#cgPickZipBtn').addEventListener('click', () => zipPk.click());
        folderPk.addEventListener('change', () => ingestFiles(folderPk.files));
        zipPk.addEventListener('change', () => {
            if (zipPk.files[0]) ingestZip(zipPk.files[0]);
        });

        pane.querySelector('#cgMultiCancel').addEventListener('click', () => renderListView(overlay));
        pane.querySelector('#cgMultiSave').addEventListener('click', async () => {
            const id = slugify(idEl.value);
            const title = titleEl.value.trim().slice(0, 80) || id;
            if (!id || !pickedFiles.length || !entrySel.value) {
                alert('Need: game id, files, and an entry HTML.');
                return;
            }
            const totalBytes = pickedFiles.reduce((a, f) => a + f.file.size, 0);
            if (totalBytes > 100 * 1024 * 1024) {
                alert(`Total upload size is ${formatBytes(totalBytes)}. Cap is 100 MB.`);
                return;
            }

            const btn = pane.querySelector('#cgMultiSave');
            btn.disabled = true;
            progress.style.display = 'block';
            progress.innerHTML = `<div class="cg-progress-bar"><div class="cg-progress-fill" id="cgFill"></div></div><div class="cg-progress-text" id="cgText">Uploading 0 / ${pickedFiles.length}…</div>`;
            const fill = pane.querySelector('#cgFill');
            const text = pane.querySelector('#cgText');

            try {
                // Read every file into base64 in parallel
                text.textContent = `Reading ${pickedFiles.length} files...`;
                const filesPayload = await Promise.all(pickedFiles.map(async (f, i) => {
                    const buf = await f.file.arrayBuffer();
                    return { relpath: f.relpath, contentB64: bufferToBase64(buf) };
                }));

                // Get the user's Firebase ID token to authorize the upload
                const me = getMe();
                if (!me) throw new Error('not signed in');
                const idToken = await me.getIdToken();

                text.textContent = `Pushing ${pickedFiles.length} files to GitHub via worker...`;
                fill.style.width = '50%';

                const WORKER_URL = 'https://arcad-groq.gatabanumai.workers.dev/upload';
                const resp = await fetch(WORKER_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${idToken}`,
                    },
                    body: JSON.stringify({ gameId: id, files: filesPayload }),
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.error || `worker returned ${resp.status}`);
                }
                const result = await resp.json();
                fill.style.width = '85%';

                // Auto-pick a thumbnail if cover.png/.jpg/.webp is present
                let thumbnail = pane.querySelector('#cgMultiThumb').value.trim();
                if (!thumbnail) {
                    const cover = pickedFiles.find(f => /(^|\/)cover\.(png|jpg|jpeg|webp|gif)$/i.test(f.relpath));
                    if (cover) {
                        thumbnail = `games/uploads/${id}/${cover.relpath}`;
                    }
                }

                const tags = pane.querySelector('#cgMultiTags').value
                    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
                if (!tags.includes('html5')) tags.push('html5');
                if (!tags.includes('browser-native')) tags.push('browser-native');

                const myProfile = me ? await window.ArcadeAuth.getProfile(me.uid).catch(() => null) : null;

                await getDb().collection('customGames').doc(id).set({
                    title,
                    description: pane.querySelector('#cgMultiDesc').value.trim().slice(0, 500),
                    category: pane.querySelector('#cgMultiCat').value,
                    tags,
                    thumbnail,
                    isMulti: true,
                    entry: entrySel.value,
                    repoPath: `games/uploads/${id}/`,
                    fileCount: pickedFiles.length,
                    totalBytes,
                    commitSha: result.commitSha,
                    authorUid: me?.uid || null,
                    authorName: myProfile?.username || null,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    addedAt: new Date().toISOString(),
                });

                window.ArcadeCustomGames?.invalidate?.();
                text.textContent = `\u{2705} Pushed to GitHub (commit ${result.commitSha.slice(0,7)}). Game playable in ~1 min once deploy lands.`;
                fill.style.width = '100%';
                setTimeout(() => renderListView(overlay), 1500);
            } catch (e) {
                text.textContent = '\u{274C} Upload failed: ' + e.message;
                btn.disabled = false;
            }
        });
    }

    // ArrayBuffer → base64 — chunked to avoid call-stack overflow on
    // large files when using String.fromCharCode.apply.
    function bufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        const CHUNK = 0x8000;
        let str = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
            str += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(str);
    }

    function formatBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    window.ArcadeCustomGamesAdmin = { showCustomGamesModal };
})();
