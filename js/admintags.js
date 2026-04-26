// Admin-managed custom tags — lets admins (packgod67) create new tag chips
// (text or image-based), apply them to any game, and have them flow through
// the existing tag filter/search UI alongside the static `tags` array baked
// into games/games.json.
//
// Two Firestore collections:
//   customTags/{tagName}        { name, image (data URL or null), createdAt, createdBy }
//   tagApplications/{gameId}    { tags: [tagName, ...], updatedAt }
//
// Tag NAMES are used as document IDs in customTags so we can do O(1) lookups
// and prevent duplicates atomically. Names are normalized lowercase and
// restricted to a-z, 0-9, _ - to keep them usable in `#tag` search syntax.
//
// Apps don't load this themselves — `js/app.js` calls
// `ArcadeAdminTags.getCustomTagsForGame(id)` during `applyFilters()` and
// `ArcadeAdminTags.getTagDef(name)` when rendering chips, so image tags
// render with `<img>` and text tags render as before.
(function () {
    let db;
    let allTags = [];                  // [{ id, name, image }]
    let tagsByName = new Map();        // name -> { name, image }
    let applicationsByGame = new Map(); // gameId -> Set<tagName>
    let unsubTags = null;
    let unsubApps = null;
    let listenersStarted = false;

    const TAG_IMG_SIZE = 64;
    const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
    const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

    function getDb() {
        if (!db) db = ArcadeAuth.getDb();
        return db;
    }

    function esc(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function normalizeName(raw) {
        return String(raw || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
    }

    // ─── Firestore loaders ────────────────────────────────────────────
    async function loadTags() {
        try {
            const snap = await getDb().collection('customTags').get();
            allTags = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            allTags.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            tagsByName = new Map(allTags.map(t => [t.name, t]));
        } catch {
            allTags = [];
            tagsByName = new Map();
        }
    }

    async function loadApplications() {
        try {
            const snap = await getDb().collection('tagApplications').get();
            applicationsByGame = new Map();
            for (const d of snap.docs) {
                const data = d.data();
                const tags = Array.isArray(data.tags) ? data.tags : [];
                if (tags.length) applicationsByGame.set(d.id, new Set(tags));
            }
        } catch {
            applicationsByGame = new Map();
        }
    }

    function startListeners() {
        if (listenersStarted) return;
        listenersStarted = true;
        unsubTags = getDb().collection('customTags').onSnapshot((snap) => {
            allTags = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            allTags.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            tagsByName = new Map(allTags.map(t => [t.name, t]));
            // Rerender filters so newly-added tags surface immediately
            window.dispatchEvent(new CustomEvent('arcade:custom-tags-changed'));
        }, () => {});
        unsubApps = getDb().collection('tagApplications').onSnapshot((snap) => {
            applicationsByGame = new Map();
            for (const d of snap.docs) {
                const data = d.data();
                const tags = Array.isArray(data.tags) ? data.tags : [];
                if (tags.length) applicationsByGame.set(d.id, new Set(tags));
            }
            window.dispatchEvent(new CustomEvent('arcade:custom-tags-changed'));
        }, () => {});
    }

    // ─── Public lookup API (used by app.js) ───────────────────────────
    function getCustomTagsForGame(gameId) {
        const set = applicationsByGame.get(gameId);
        if (!set) return [];
        return Array.from(set);
    }

    function getAllCustomTags() {
        return allTags.slice();
    }

    function getTagDef(name) {
        return tagsByName.get(name) || null;
    }

    // Render a tag as either text (#name) or an <img> chip if image-tag.
    // Used by app.js for active-tag pills and the game info modal.
    function renderTagInner(name) {
        const def = tagsByName.get(name);
        if (def && def.image) {
            return `<img class="custom-tag-img" src="${esc(def.image)}" alt="#${esc(name)}" title="#${esc(name)}">`;
        }
        return `#${esc(name)}`;
    }

    // ─── Image compression (mirrors emojis.js) ────────────────────────
    function compressImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = TAG_IMG_SIZE;
                    canvas.height = TAG_IMG_SIZE;
                    const ctx = canvas.getContext('2d');
                    const scale = Math.min(TAG_IMG_SIZE / img.width, TAG_IMG_SIZE / img.height);
                    const w = img.width * scale;
                    const h = img.height * scale;
                    const x = (TAG_IMG_SIZE - w) / 2;
                    const y = (TAG_IMG_SIZE - h) / 2;
                    ctx.drawImage(img, x, y, w, h);
                    resolve(canvas.toDataURL('image/png'));
                };
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = e.target.result;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    // ─── Tag library modal (admin) ────────────────────────────────────
    function showTagManagementModal() {
        closeManagementModal();
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'customTagModal';

        const gridHtml = allTags.length ? allTags.map(t => `
            <div class="custom-tag-manage-item">
                <div class="custom-tag-manage-chip">
                    ${t.image
                        ? `<img class="custom-tag-img" src="${esc(t.image)}" alt="#${esc(t.name)}">`
                        : `<span class="custom-tag-text">#${esc(t.name)}</span>`}
                </div>
                <span class="custom-tag-manage-name">#${esc(t.name)}</span>
                <button class="custom-tag-delete-btn" data-id="${esc(t.id)}" data-name="${esc(t.name)}" title="Delete tag">&times;</button>
            </div>`).join('')
            : '<p class="text-muted">No custom tags yet. Create one below!</p>';

        overlay.innerHTML = `
            <div class="modal-box">
                <div class="modal-header">
                    <h2>Manage Custom Tags</h2>
                    <button class="modal-close" id="closeTagModal">&times;</button>
                </div>
                <p class="text-muted" style="margin-top:0;font-size:13px;">
                    Create tags that appear alongside built-in game tags. Optionally attach an image
                    to make a visual tag (renders as a small icon in chips and pills). Apply tags to
                    games from the game info modal's "Edit Tags" button.
                </p>
                <div class="custom-tag-create-form">
                    <input type="text" id="customTagName" placeholder="Tag name (a-z, 0-9, _ -)" class="auth-input" maxlength="32">
                    <div class="custom-tag-upload-row">
                        <button class="auth-submit secondary" id="customTagFileBtn">Choose Image (optional)</button>
                        <input type="file" id="customTagFileInput" accept="image/*" style="display:none;">
                        <span class="custom-tag-file-label" id="customTagFileLabel">No image — text tag</span>
                        <button class="custom-tag-file-clear" id="customTagFileClear" type="button" hidden title="Clear image">&times;</button>
                    </div>
                    <div class="custom-tag-preview-row" id="customTagPreviewRow" style="display:none;">
                        <img id="customTagPreviewImg" class="custom-tag-preview-img" alt="Preview">
                    </div>
                    <button class="auth-submit" id="customTagCreateBtn">Create Tag</button>
                </div>
                <h3 style="margin:18px 0 10px;font-size:14px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;">Existing Tags</h3>
                <div class="custom-tag-manage-grid" id="customTagGrid">${gridHtml}</div>
            </div>`;

        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeManagementModal(); });
        document.getElementById('closeTagModal').addEventListener('click', closeManagementModal);

        let selectedFile = null;

        document.getElementById('customTagFileBtn').addEventListener('click', () => {
            document.getElementById('customTagFileInput').click();
        });

        document.getElementById('customTagFileInput').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (!ALLOWED_TYPES.includes(file.type)) { alert('Only JPEG, PNG, GIF, and WebP allowed.'); return; }
            if (file.size > MAX_FILE_SIZE) { alert('Image must be under 1MB.'); return; }
            selectedFile = file;
            document.getElementById('customTagFileLabel').textContent = file.name;
            document.getElementById('customTagFileClear').hidden = false;
            try {
                const dataUrl = await compressImage(file);
                document.getElementById('customTagPreviewImg').src = dataUrl;
                document.getElementById('customTagPreviewRow').style.display = 'flex';
            } catch {
                document.getElementById('customTagPreviewRow').style.display = 'none';
            }
        });

        document.getElementById('customTagFileClear').addEventListener('click', () => {
            selectedFile = null;
            document.getElementById('customTagFileInput').value = '';
            document.getElementById('customTagFileLabel').textContent = 'No image — text tag';
            document.getElementById('customTagFileClear').hidden = true;
            document.getElementById('customTagPreviewRow').style.display = 'none';
        });

        document.getElementById('customTagCreateBtn').addEventListener('click', async () => {
            const name = normalizeName(document.getElementById('customTagName').value);
            if (!name) { alert('Enter a valid tag name (letters, numbers, _ -)'); return; }
            if (tagsByName.has(name)) { alert('A tag with that name already exists.'); return; }
            try {
                let image = null;
                if (selectedFile) image = await compressImage(selectedFile);
                const uid = ArcadeAuth.getCurrentUser?.()?.uid || null;
                await getDb().collection('customTags').doc(name).set({
                    name,
                    image,
                    createdBy: uid,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                await loadTags();
                showTagManagementModal(); // refresh
            } catch (err) {
                alert('Create failed: ' + err.message);
            }
        });

        // Delete buttons. Also strip the deleted tag from every game it was
        // applied to so we don't leave dangling references in the
        // tagApplications collection.
        document.getElementById('customTagGrid').addEventListener('click', async (e) => {
            const btn = e.target.closest('.custom-tag-delete-btn');
            if (!btn) return;
            const id = btn.dataset.id;
            const name = btn.dataset.name;
            if (!confirm(`Delete tag "#${name}"? It will be removed from every game it was applied to.`)) return;
            try {
                await getDb().collection('customTags').doc(id).delete();
                // Sweep applications: any game that had this tag, remove it
                const batch = getDb().batch();
                let touched = 0;
                for (const [gameId, set] of applicationsByGame.entries()) {
                    if (!set.has(name)) continue;
                    const remaining = Array.from(set).filter(t => t !== name);
                    const ref = getDb().collection('tagApplications').doc(gameId);
                    if (remaining.length) {
                        batch.set(ref, { tags: remaining, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
                    } else {
                        batch.delete(ref);
                    }
                    touched++;
                }
                if (touched) await batch.commit();
                await loadTags();
                await loadApplications();
                showTagManagementModal();
            } catch (err) {
                alert('Delete failed: ' + err.message);
            }
        });
    }

    // ─── Per-game apply modal (admin) ─────────────────────────────────
    // Shows every custom tag as a toggle chip; click to apply/remove on the
    // given game. Real-time so multiple admins won't clobber each other —
    // we read the current set from `applicationsByGame` on every click.
    function showApplyTagsModal(game) {
        closeApplyModal();
        if (!game) return;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'applyTagsModal';

        function buildGrid() {
            const applied = applicationsByGame.get(game.id) || new Set();
            if (allTags.length === 0) {
                return '<p class="text-muted">No custom tags exist yet. Create some from "Manage Tags" first.</p>';
            }
            return `<div class="apply-tags-grid">` + allTags.map(t => {
                const isOn = applied.has(t.name);
                const inner = t.image
                    ? `<img class="custom-tag-img" src="${esc(t.image)}" alt="#${esc(t.name)}">`
                    : '';
                return `<button class="apply-tag-chip${isOn ? ' active' : ''}" data-name="${esc(t.name)}">
                    ${inner}<span>#${esc(t.name)}</span>
                </button>`;
            }).join('') + `</div>`;
        }

        overlay.innerHTML = `
            <div class="modal-box">
                <div class="modal-header">
                    <h2>Edit Tags — ${esc(game.title)}</h2>
                    <button class="modal-close" id="closeApplyTagsModal">&times;</button>
                </div>
                <p class="text-muted" style="margin-top:0;font-size:13px;">
                    Click a tag to toggle it on or off for this game. Changes are live.
                </p>
                <div id="applyTagsBody">${buildGrid()}</div>
            </div>`;

        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeApplyModal(); });
        document.getElementById('closeApplyTagsModal').addEventListener('click', closeApplyModal);

        // Refresh the grid when applications change elsewhere.
        const refreshHandler = () => {
            const body = document.getElementById('applyTagsBody');
            if (body) body.innerHTML = buildGrid();
        };
        window.addEventListener('arcade:custom-tags-changed', refreshHandler);
        // Tear down when modal closes
        const obs = new MutationObserver(() => {
            if (!document.getElementById('applyTagsModal')) {
                window.removeEventListener('arcade:custom-tags-changed', refreshHandler);
                obs.disconnect();
            }
        });
        obs.observe(document.body, { childList: true });

        overlay.addEventListener('click', async (e) => {
            const chip = e.target.closest('.apply-tag-chip');
            if (!chip) return;
            const tagName = chip.dataset.name;
            const ref = getDb().collection('tagApplications').doc(game.id);
            const current = applicationsByGame.get(game.id) || new Set();
            const next = new Set(current);
            if (next.has(tagName)) next.delete(tagName); else next.add(tagName);
            try {
                if (next.size === 0) {
                    await ref.delete();
                } else {
                    await ref.set({
                        tags: Array.from(next),
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    });
                }
                // Local cache update for immediate UI feedback (snapshot
                // listener will reconcile within ~100ms anyway, but this
                // makes the click feel instant).
                if (next.size === 0) applicationsByGame.delete(game.id);
                else applicationsByGame.set(game.id, next);
                refreshHandler();
                window.dispatchEvent(new CustomEvent('arcade:custom-tags-changed'));
            } catch (err) {
                alert('Update failed: ' + err.message);
            }
        });
    }

    function closeManagementModal() { document.getElementById('customTagModal')?.remove(); }
    function closeApplyModal() { document.getElementById('applyTagsModal')?.remove(); }

    window.ArcadeAdminTags = {
        // Loaders
        loadTags,
        loadApplications,
        startListeners,
        // Lookup (called from app.js)
        getCustomTagsForGame,
        getAllCustomTags,
        getTagDef,
        renderTagInner,
        // Admin UI entrypoints
        showTagManagementModal,
        showApplyTagsModal,
    };

    // Bootstrap once auth is ready. Custom tags are public-readable so we
    // could load without auth, but keeping the load behind auth-ready avoids
    // a flash of un-tagged state during the initial sign-in race.
    if (window.ArcadeAuth?.waitForAuth) {
        ArcadeAuth.waitForAuth().then(async () => {
            await Promise.all([loadTags(), loadApplications()]);
            startListeners();
            window.dispatchEvent(new CustomEvent('arcade:custom-tags-changed'));
        });
    }
})();
