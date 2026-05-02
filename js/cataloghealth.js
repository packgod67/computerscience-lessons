// Admin-only catalog health dashboard.
//
// Scans games.json client-side and surfaces entries that look like
// stubs or have data quality issues — missing thumbnails, missing
// descriptions, generic "Cl..." placeholder titles, missing categories,
// etc. Lets admins prioritize which catalog rows to upgrade next.
//
// Tab is added by app.js's buildAdminTagButton() pathway when the
// arcade detects an admin user. The tab id is `cataloghealthView`.

(function () {
    function renderCatalogHealthView() {
        const container = document.getElementById('cataloghealthView');
        if (!container) return;
        if (!window.ArcadeAuth?.isAdmin?.()) {
            container.innerHTML = '<div class="ch-empty">Admin only.</div>';
            return;
        }
        const games = window.ArcadeApp?.getGames?.() || [];
        if (!games.length) {
            container.innerHTML = '<div class="ch-empty">Catalog not loaded yet.</div>';
            return;
        }

        // Build categorized issue lists
        const stubTitle      = games.filter(g => /^Cl[a-z0-9]/.test(g.title || ''));
        const noThumb        = games.filter(g => !g.thumbnail && !g.rom);
        const noDesc         = games.filter(g => !g.description);
        const noCat          = games.filter(g => !g.category || g.category === 'Other');
        const noTags         = games.filter(g => !Array.isArray(g.tags) || g.tags.length < 3);
        const noAddedAt      = games.filter(g => !g.addedAt);
        const broken         = games.filter(g => g.broken);

        const sections = [
            { id: 'broken',    title: 'Broken (dead source)',               list: broken,
              hint: 'Wrapper points at a deleted external repo (schoolstuff1337/supplies, etc). Hidden from the home grid for non-admins. Re-source the ROM and clear the broken flag.' },
            { id: 'stub',      title: 'Stub titles ("Cl…")',                list: stubTitle,
              hint: 'Title still has the auto-generated Cl<id> placeholder. Pick a real title.' },
            { id: 'thumb',     title: 'Missing thumbnails',                 list: noThumb,
              hint: 'No `thumbnail` field. Browser falls back to a placeholder.' },
            { id: 'desc',      title: 'Missing descriptions',               list: noDesc,
              hint: 'No `description`. Tooltip + game info modal show nothing.' },
            { id: 'cat',       title: 'Generic "Other" / no category',      list: noCat,
              hint: 'Category not specific enough — won\'t surface in narrow tab filters.' },
            { id: 'tags',      title: 'Fewer than 3 tags',                  list: noTags,
              hint: 'Need at least 3 tags for the search + recommender to work well.' },
            { id: 'addedat',   title: 'Missing addedAt',                    list: noAddedAt,
              hint: 'No `addedAt` ISO string — game won\'t appear in NEW + can\'t be sorted by recency.' },
        ];

        container.innerHTML = `
            <div class="ch-panel">
                <div class="ch-header">
                    <h2>Catalog health</h2>
                    <button class="ch-export" id="chExportBtn" type="button">Export issues JSON</button>
                </div>
                <div class="ch-summary">
                    Total games: <strong>${games.length}</strong> ·
                    Issues: ${sections.map(s => `<span>${s.title}: <strong>${s.list.length}</strong></span>`).join(' · ')}
                </div>
                <div class="ch-tabs">
                    ${sections.map((s, i) => `<button class="ch-tab${i === 0 ? ' is-active' : ''}" data-section="${s.id}">${s.title} (${s.list.length})</button>`).join('')}
                </div>
                <div class="ch-pane" id="chPane"></div>
            </div>
        `;

        const paneEl = container.querySelector('#chPane');
        let active = sections[0];
        function paint(s) {
            active = s;
            container.querySelectorAll('.ch-tab').forEach(b => b.classList.toggle('is-active', b.dataset.section === s.id));
            if (!s.list.length) {
                paneEl.innerHTML = `<div class="ch-empty">No issues in this category. \u{1F389}</div>`;
                return;
            }
            paneEl.innerHTML = `
                <p class="ch-hint">${s.hint}</p>
                <div class="ch-list">
                    ${s.list.slice(0, 200).map(g => `
                        <div class="ch-row">
                            <span class="ch-row-id">${esc(g.id)}</span>
                            <span class="ch-row-title">${esc(g.title || '<no title>')}</span>
                            <span class="ch-row-cat">${esc(g.category || '—')}</span>
                            <a class="ch-row-open" href="play.html?game=${encodeURIComponent(g.id)}" target="_blank" rel="noopener">Open</a>
                        </div>
                    `).join('')}
                </div>
                ${s.list.length > 200 ? `<p class="ch-hint">Showing first 200 of ${s.list.length}.</p>` : ''}
            `;
        }
        container.querySelectorAll('.ch-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                const s = sections.find(x => x.id === btn.dataset.section);
                if (s) paint(s);
            });
        });
        paint(sections[0]);

        document.getElementById('chExportBtn').addEventListener('click', () => {
            const out = {};
            for (const s of sections) {
                out[s.id] = s.list.map(g => ({ id: g.id, title: g.title, path: g.path }));
            }
            const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'catalog-issues.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    window.ArcadeCatalogHealth = { renderCatalogHealthView };
})();
