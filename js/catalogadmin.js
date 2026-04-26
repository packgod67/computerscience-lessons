// Catalog admin GUI — edit and delete entries in games.json.
//
// games.json is served as a static file; we can't write to it from the
// browser. So this works the bulk-add way: load the catalog into
// memory, let admin edit/delete entries, then export a fresh full
// games.json the admin commits manually. Same pattern as bulk-add for
// the export-and-commit step.
//
// What it covers:
//   - Search across all 220+ entries by title/id/tag
//   - Click a row to edit any field (title, category, description,
//     thumbnail, tags, popular flag, addedAt)
//   - Delete an entry (also removes the corresponding wrapper HTML
//     suggestion in the export bundle)
//   - Export: download `games.json.patched` plus a list of any
//     wrapper-HTML files to delete
//
// Add is covered by `js/bulkadd.js`. Combined with this module, an
// admin has full CRUD over the catalog from the browser, with a
// commit step preserving git history.

(function () {
    let modalOpen = false;
    let workingCatalog = null;  // in-memory copy with edits
    let originalCatalog = null; // unmodified for diff
    let pendingDeletions = new Set(); // game IDs to delete (also remove wrapper)

    function esc(s) {
        if (!s && s !== '') return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function loadCatalog() {
        const r = await fetch('games/games.json');
        if (!r.ok) throw new Error('Failed to load games.json');
        return await r.json();
    }

    async function showCatalogAdminModal() {
        if (modalOpen) return;
        modalOpen = true;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'catalogAdminModal';
        overlay.innerHTML = `
            <div class="modal-box catalog-admin-modal">
                <div class="modal-header">
                    <h2>Edit Catalog</h2>
                    <button class="modal-close" id="closeCatalogAdmin">&times;</button>
                </div>
                <div class="catalog-admin-toolbar">
                    <input type="text" id="catalogAdminSearch"
                           placeholder="Search by title, id, or tag…"
                           class="auth-input" autocomplete="off">
                    <span id="catalogAdminCount" class="text-muted"></span>
                    <button class="auth-submit secondary" id="catalogAdminExport">&#128190; Export changes</button>
                </div>
                <div class="catalog-admin-status" id="catalogAdminStatus">Loading…</div>
                <div class="catalog-admin-table" id="catalogAdminTable"></div>
            </div>`;

        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
        document.getElementById('closeCatalogAdmin').addEventListener('click', closeModal);

        try {
            // Always load fresh so we don't operate on stale data
            originalCatalog = await loadCatalog();
            workingCatalog = JSON.parse(JSON.stringify(originalCatalog));
            pendingDeletions = new Set();
            document.getElementById('catalogAdminStatus').textContent = `Loaded ${workingCatalog.length} entries.`;
        } catch (e) {
            document.getElementById('catalogAdminStatus').textContent = 'Failed to load catalog: ' + e.message;
            return;
        }

        const searchInput = document.getElementById('catalogAdminSearch');
        searchInput.addEventListener('input', () => renderTable(searchInput.value));
        document.getElementById('catalogAdminExport').addEventListener('click', exportChanges);
        renderTable('');
    }

    function renderTable(query) {
        const q = (query || '').toLowerCase().trim();
        const matches = workingCatalog.filter(g => {
            if (pendingDeletions.has(g.id)) return false;
            if (!q) return true;
            const hay = `${g.id} ${g.title} ${(g.tags || []).join(' ')} ${g.category}`.toLowerCase();
            return hay.includes(q);
        });
        const tableEl = document.getElementById('catalogAdminTable');
        const countEl = document.getElementById('catalogAdminCount');
        countEl.textContent = `${matches.length} of ${workingCatalog.length - pendingDeletions.size}`;

        // Cap visible rows for perf — show top 100 matching
        const visible = matches.slice(0, 100);
        tableEl.innerHTML = visible.map((g, i) => `
            <div class="catalog-admin-row" data-id="${esc(g.id)}">
                <img src="${esc(g.thumbnail || '')}" alt="" class="catalog-admin-thumb"
                     onerror="this.style.background='#222';this.removeAttribute('src')">
                <div class="catalog-admin-info">
                    <div class="catalog-admin-title">${esc(g.title || g.id)}</div>
                    <div class="catalog-admin-meta">
                        <code>${esc(g.id)}</code> &middot;
                        ${esc(g.category || 'Other')} &middot;
                        ${(g.tags || []).length} tags${g.popular ? ' &middot; <strong style="color:var(--accent)">popular</strong>' : ''}
                    </div>
                </div>
                <button class="catalog-admin-edit" data-id="${esc(g.id)}">Edit</button>
                <button class="catalog-admin-delete" data-id="${esc(g.id)}" title="Delete">&times;</button>
            </div>
        `).join('') + (matches.length > 100 ? `
            <div class="catalog-admin-more">${matches.length - 100} more not shown — refine search</div>
        ` : '');

        tableEl.querySelectorAll('.catalog-admin-edit').forEach(btn => {
            btn.addEventListener('click', () => editEntry(btn.dataset.id));
        });
        tableEl.querySelectorAll('.catalog-admin-delete').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const g = workingCatalog.find(x => x.id === id);
                if (!confirm(`Delete "${g.title || id}" from catalog?\n\nThis also flags the wrapper file games/${id}.html for deletion. Action is recorded in the export bundle but not applied until you commit.`)) return;
                pendingDeletions.add(id);
                renderTable(document.getElementById('catalogAdminSearch').value);
            });
        });
    }

    function editEntry(id) {
        const g = workingCatalog.find(x => x.id === id);
        if (!g) return;

        // Inline edit overlay — lives on top of the catalog admin modal
        const editOverlay = document.createElement('div');
        editOverlay.className = 'modal-overlay';
        editOverlay.id = 'catalogEditOverlay';
        editOverlay.innerHTML = `
            <div class="modal-box catalog-edit-modal">
                <div class="modal-header">
                    <h2>Edit: ${esc(g.title || g.id)}</h2>
                    <button class="modal-close" id="closeCatalogEdit">&times;</button>
                </div>
                <div class="catalog-edit-form">
                    <label>ID (read-only)<input type="text" value="${esc(g.id)}" disabled></label>
                    <label>Title<input type="text" id="ce-title" value="${esc(g.title || '')}"></label>
                    <label>Category<input type="text" id="ce-category" value="${esc(g.category || '')}"
                        list="ce-categories"></label>
                    <datalist id="ce-categories">
                        <option>Pokemon</option><option>Racing</option><option>Adventure</option>
                        <option>Action</option><option>Sports</option><option>Puzzle</option>
                        <option>Strategy</option><option>Simulation</option><option>Shooter</option>
                        <option>Platformer</option><option>Fighting</option><option>Horror</option>
                        <option>Mario</option><option>Sonic</option><option>Minecraft</option>
                        <option>Other</option><option>Retro</option>
                    </datalist>
                    <label>Description<textarea id="ce-description" rows="3">${esc(g.description || '')}</textarea></label>
                    <label>Thumbnail URL<input type="text" id="ce-thumbnail" value="${esc(g.thumbnail || '')}"></label>
                    <label>ROM platform (e.g. gba, snes)<input type="text" id="ce-rom" value="${esc(g.rom || '')}"></label>
                    <label>Tags (comma-separated)<input type="text" id="ce-tags" value="${esc((g.tags || []).join(', '))}"></label>
                    <label class="catalog-edit-checkbox">
                        <input type="checkbox" id="ce-popular" ${g.popular ? 'checked' : ''}> Popular
                    </label>
                    <label>addedAt (ISO timestamp)<input type="text" id="ce-addedAt" value="${esc(g.addedAt || '')}"></label>
                </div>
                <div class="catalog-edit-actions">
                    <button class="auth-submit" id="ce-save">Save</button>
                    <button class="auth-submit secondary" id="ce-cancel">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(editOverlay);

        editOverlay.addEventListener('click', (e) => { if (e.target === editOverlay) editOverlay.remove(); });
        document.getElementById('closeCatalogEdit').addEventListener('click', () => editOverlay.remove());
        document.getElementById('ce-cancel').addEventListener('click', () => editOverlay.remove());

        document.getElementById('ce-save').addEventListener('click', () => {
            const updated = {
                ...g,
                title: document.getElementById('ce-title').value.trim(),
                category: document.getElementById('ce-category').value.trim() || 'Other',
                description: document.getElementById('ce-description').value.trim(),
                thumbnail: document.getElementById('ce-thumbnail').value.trim() || undefined,
                rom: document.getElementById('ce-rom').value.trim() || null,
                tags: document.getElementById('ce-tags').value.split(',').map(t => t.trim()).filter(Boolean),
                popular: document.getElementById('ce-popular').checked,
                addedAt: document.getElementById('ce-addedAt').value.trim() || undefined,
            };
            // Drop undefined keys to keep JSON clean
            for (const k of Object.keys(updated)) {
                if (updated[k] === undefined) delete updated[k];
            }
            const idx = workingCatalog.findIndex(x => x.id === g.id);
            if (idx >= 0) workingCatalog[idx] = updated;
            editOverlay.remove();
            renderTable(document.getElementById('catalogAdminSearch').value);
        });
    }

    function exportChanges() {
        // Build the fresh games.json by:
        //   1. Removing entries marked for deletion
        //   2. Using the workingCatalog values (with edits)
        const finalCatalog = workingCatalog.filter(g => !pendingDeletions.has(g.id));

        // Diff vs original for the user's reference
        const editedIds = [];
        for (const orig of originalCatalog) {
            if (pendingDeletions.has(orig.id)) continue;
            const cur = finalCatalog.find(g => g.id === orig.id);
            if (!cur) continue;
            if (JSON.stringify(orig) !== JSON.stringify(cur)) {
                editedIds.push(cur.id);
            }
        }
        const deletedIds = Array.from(pendingDeletions);

        if (editedIds.length === 0 && deletedIds.length === 0) {
            alert('No changes to export.');
            return;
        }

        // Download the full updated games.json (replaces in-place)
        const jsonBlob = new Blob([JSON.stringify(finalCatalog, null, 2)], { type: 'application/json' });
        const jsonUrl = URL.createObjectURL(jsonBlob);
        const jsonA = document.createElement('a');
        jsonA.href = jsonUrl;
        jsonA.download = 'games.json';
        jsonA.click();
        setTimeout(() => URL.revokeObjectURL(jsonUrl), 1000);

        // Also download a CHANGELOG with deletion targets
        const changelog = [
            `# Catalog edit — ${new Date().toISOString()}`,
            ``,
            `## Edits (${editedIds.length})`,
            ...editedIds.map(id => `- ${id}`),
            ``,
            `## Deletions (${deletedIds.length})`,
            ...deletedIds.map(id => `- ${id} — ALSO DELETE games/${id}.html`),
            ``,
            `## Apply`,
            `1. Replace games/games.json with the downloaded games.json file`,
            `2. For each ID in deletions, delete the matching games/<id>.html wrapper`,
            `3. Run \`node validate-catalog.mjs\` to confirm`,
            `4. git add . && git commit && git push`,
        ].join('\n');
        const cBlob = new Blob([changelog], { type: 'text/markdown' });
        const cUrl = URL.createObjectURL(cBlob);
        const cA = document.createElement('a');
        cA.href = cUrl;
        cA.download = 'catalog-changelog.md';
        cA.click();
        setTimeout(() => URL.revokeObjectURL(cUrl), 1000);
    }

    function closeModal() {
        document.getElementById('catalogAdminModal')?.remove();
        modalOpen = false;
        workingCatalog = null;
        originalCatalog = null;
        pendingDeletions.clear();
    }

    window.ArcadeCatalogAdmin = {
        showCatalogAdminModal,
    };
})();
