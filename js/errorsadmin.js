// Admin-only client-error dashboard.
//
// Reads the `errors` Firestore collection (populated by telemetry.js)
// and surfaces grouped client crashes so admins can triage breakage in
// production. Includes:
//   - Group by message + source so 100 occurrences of the same bug are
//     one row with a count + last-seen timestamp
//   - Filter by signed-in uid (some bugs only fire for one user)
//   - Per-row expand to see stack trace, href, UA, and user
//   - Export JSON button — shipping the dump straight to Claude/anyone
//     debugging without copy-pasting Firestore console rows
//   - Delete (admin) button per row to clear stale errors after a fix
//
// Tab is added by tabs.js when the arcade detects an admin user.
// The tab id is `errorsadminView`.

(function () {
    let cachedErrors = [];
    let unsubLive = null;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function fmtDate(ts) {
        if (!ts) return '—';
        try {
            const d = ts.toDate ? ts.toDate() : new Date(ts);
            return d.toLocaleString();
        } catch { return '—'; }
    }

    function fmtRelative(ts) {
        if (!ts) return '—';
        try {
            const d = ts.toDate ? ts.toDate() : new Date(ts);
            const ago = Date.now() - d.getTime();
            const m = Math.floor(ago / 60000);
            if (m < 1) return 'just now';
            if (m < 60) return `${m}m ago`;
            const h = Math.floor(m / 60);
            if (h < 24) return `${h}h ago`;
            const days = Math.floor(h / 24);
            return `${days}d ago`;
        } catch { return '—'; }
    }

    async function loadErrors() {
        const db = window.ArcadeAuth?.getDb?.();
        if (!db) return [];
        try {
            // Most recent 500 errors. createdAt indexed descending.
            const snap = await db.collection('errors')
                .orderBy('createdAt', 'desc')
                .limit(500)
                .get();
            cachedErrors = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            return cachedErrors;
        } catch (e) {
            console.warn('errors load failed:', e);
            return [];
        }
    }

    // Group identical (message + source) errors and count occurrences.
    function groupErrors(errs) {
        const groups = new Map();
        for (const e of errs) {
            const key = (e.message || '') + '|' + (e.source || '') + '|' + (e.lineno || '');
            if (!groups.has(key)) {
                groups.set(key, {
                    key,
                    message: e.message,
                    source: e.source,
                    lineno: e.lineno,
                    colno: e.colno,
                    stack: e.stack,
                    count: 0,
                    firstSeen: e.createdAt,
                    lastSeen: e.createdAt,
                    occurrences: [],
                });
            }
            const g = groups.get(key);
            g.count++;
            g.occurrences.push(e);
            // createdAt is server timestamp — toMillis() comparison
            try {
                const ms = e.createdAt?.toMillis?.() || 0;
                const lastMs = g.lastSeen?.toMillis?.() || 0;
                const firstMs = g.firstSeen?.toMillis?.() || Infinity;
                if (ms > lastMs) g.lastSeen = e.createdAt;
                if (ms < firstMs) g.firstSeen = e.createdAt;
            } catch {}
        }
        return Array.from(groups.values()).sort((a, b) => b.count - a.count);
    }

    async function renderErrorsAdminView() {
        const container = document.getElementById('errorsadminView');
        if (!container) return;
        if (!window.ArcadeAuth?.isAdmin?.()) {
            container.innerHTML = '<div class="ch-empty">Admin only.</div>';
            return;
        }

        // Sub-tab shell. Errors view is the default; "Broken games" is
        // the secondary sub-tab that lists every catalog entry with
        // broken=true so admins can re-source them.
        container.innerHTML = `
            <div class="ea-subtabs">
                <button class="ea-subtab is-active" data-subtab="errors">\u{1F6A8} Client errors</button>
                <button class="ea-subtab"           data-subtab="broken">\u{1F480} Broken games</button>
            </div>
            <div id="eaSubpane"></div>
        `;
        const subpane = container.querySelector('#eaSubpane');
        const subtabs = container.querySelectorAll('.ea-subtab');
        subtabs.forEach(btn => {
            btn.addEventListener('click', () => {
                subtabs.forEach(b => b.classList.toggle('is-active', b === btn));
                if (btn.dataset.subtab === 'errors') renderErrorsPane(subpane);
                else                                 renderBrokenPane(subpane);
            });
        });
        renderErrorsPane(subpane); // default
    }

    async function renderErrorsPane(container) {
        container.innerHTML = '<div class="ch-empty">Loading errors…</div>';
        const errs = await loadErrors();
        const groups = groupErrors(errs);

        container.innerHTML = `
            <div class="ch-panel">
                <div class="ch-header">
                    <h2>Client errors</h2>
                    <div class="ea-header-actions">
                        <button class="ch-export" id="eaRefreshBtn" type="button">Refresh</button>
                        <button class="ch-export" id="eaExportBtn" type="button">Export JSON</button>
                        <button class="ch-export ea-danger" id="eaPurgeBtn" type="button">Delete all</button>
                    </div>
                </div>
                <div class="ch-summary">
                    Total errors: <strong>${errs.length}</strong> ·
                    Distinct: <strong>${groups.length}</strong>
                    ${errs.length === 500 ? ' · <span class="ea-cap">(showing latest 500)</span>' : ''}
                </div>
                <div class="ea-filter-row">
                    <input type="text" id="eaFilter" class="auth-input" placeholder="Filter by message, source, uid…">
                </div>
                <div class="ea-list" id="eaList"></div>
            </div>
        `;

        const listEl = container.querySelector('#eaList');
        const filterEl = container.querySelector('#eaFilter');

        function paint() {
            const q = (filterEl.value || '').toLowerCase();
            const filtered = q
                ? groups.filter(g =>
                    (g.message || '').toLowerCase().includes(q) ||
                    (g.source || '').toLowerCase().includes(q) ||
                    g.occurrences.some(o => (o.uid || '').toLowerCase().includes(q)))
                : groups;

            if (!filtered.length) {
                listEl.innerHTML = '<div class="ch-empty">No errors. \u{1F389}</div>';
                return;
            }

            listEl.innerHTML = filtered.map((g, i) => `
                <details class="ea-row" data-key="${esc(g.key)}">
                    <summary class="ea-row-summary">
                        <span class="ea-count">${g.count}×</span>
                        <span class="ea-msg">${esc((g.message || '<no message>').slice(0, 200))}</span>
                        <span class="ea-source">${esc(shortSource(g.source))}${g.lineno ? ':' + g.lineno : ''}</span>
                        <span class="ea-time">${fmtRelative(g.lastSeen)}</span>
                    </summary>
                    <div class="ea-row-body">
                        ${g.stack ? `<pre class="ea-stack">${esc(g.stack)}</pre>` : ''}
                        <div class="ea-meta">
                            <div><strong>First seen:</strong> ${fmtDate(g.firstSeen)}</div>
                            <div><strong>Last seen:</strong> ${fmtDate(g.lastSeen)}</div>
                            <div><strong>Occurrences:</strong> ${g.count}</div>
                        </div>
                        <div class="ea-occ-list">
                            ${g.occurrences.slice(0, 10).map(o => `
                                <div class="ea-occ">
                                    <code>${esc((o.href || '').slice(0, 120))}</code>
                                    <span>uid: ${esc(o.uid || '—')}</span>
                                    <span>${fmtDate(o.createdAt)}</span>
                                    <button class="ea-occ-del" data-id="${esc(o.id)}" title="Delete this occurrence">&times;</button>
                                </div>
                            `).join('')}
                            ${g.occurrences.length > 10 ? `<div class="ea-occ-more">+${g.occurrences.length - 10} more</div>` : ''}
                        </div>
                    </div>
                </details>
            `).join('');
        }

        filterEl.addEventListener('input', paint);
        paint();

        container.querySelector('#eaRefreshBtn').addEventListener('click', () => renderErrorsPane(container));

        container.querySelector('#eaExportBtn').addEventListener('click', () => {
            const out = {
                exportedAt: new Date().toISOString(),
                total: errs.length,
                distinct: groups.length,
                groups: groups.map(g => ({
                    message: g.message,
                    source: g.source,
                    lineno: g.lineno,
                    colno: g.colno,
                    stack: g.stack,
                    count: g.count,
                    firstSeen: fmtDate(g.firstSeen),
                    lastSeen: fmtDate(g.lastSeen),
                    sampleHrefs: [...new Set(g.occurrences.map(o => o.href).filter(Boolean))].slice(0, 5),
                    sampleUas: [...new Set(g.occurrences.map(o => o.ua).filter(Boolean))].slice(0, 3),
                    affectedUids: [...new Set(g.occurrences.map(o => o.uid).filter(Boolean))],
                })),
            };
            const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `arcade-errors-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });

        container.querySelector('#eaPurgeBtn').addEventListener('click', async () => {
            if (!confirm(`Delete ALL ${errs.length} errors? Use this after shipping fixes.`)) return;
            const db = window.ArcadeAuth.getDb();
            // Firestore batches max 500 ops; we already cap at 500.
            const batch = db.batch();
            for (const e of errs) batch.delete(db.collection('errors').doc(e.id));
            try {
                await batch.commit();
                renderErrorsPane(container);
            } catch (err) {
                alert('Purge failed: ' + err.message);
            }
        });

        // Per-occurrence delete
        listEl.addEventListener('click', async (e) => {
            const btn = e.target.closest('.ea-occ-del');
            if (!btn) return;
            e.preventDefault(); e.stopPropagation();
            const id = btn.dataset.id;
            try {
                await window.ArcadeAuth.getDb().collection('errors').doc(id).delete();
                cachedErrors = cachedErrors.filter(x => x.id !== id);
                btn.closest('.ea-occ').remove();
            } catch (err) {
                alert('Delete failed: ' + err.message);
            }
        });
    }

    // ─── Broken-games sub-pane ─────────────────────────────────────
    // Pulls the catalog from app state (already loaded), filters to
    // entries with broken=true, and renders a searchable list with
    // a "Rescue" hint per row (current source + suggested platform).
    // Includes "Clear broken flag" + "Open wrapper" + "Copy id" actions.
    function renderBrokenPane(container) {
        container.innerHTML = '<div class="ch-empty">Loading broken games…</div>';
        // The catalog is loaded by app.js. For non-admins it's pre-filtered
        // (broken games removed); admins see the full list.
        const games = window.ArcadeApp?.getGames?.() || [];
        const broken = games.filter(g => g.broken);

        // Group by category for at-a-glance triage
        const byCat = {};
        for (const g of broken) {
            const c = g.category || 'Other';
            (byCat[c] = byCat[c] || []).push(g);
        }
        const cats = Object.entries(byCat).sort((a, b) => b[1].length - a[1].length);

        container.innerHTML = `
            <div class="ch-panel">
                <div class="ch-header">
                    <h2>Broken games (${broken.length})</h2>
                    <div class="ea-header-actions">
                        <button class="ch-export" id="bgExportBtn" type="button">Export JSON</button>
                    </div>
                </div>
                <div class="ch-summary">
                    Catalog entries marked <code>broken: true</code> — wrappers point at deleted external repos
                    (schoolstuff1337/supplies, kaklikOf13/resurviv, MopNop/jello). Hidden from non-admins.
                    Re-source the ROM, update the wrapper, then clear the <code>broken</code> flag in
                    <code>games.json</code>.
                </div>
                <div class="ea-filter-row">
                    <input type="text" id="bgFilter" class="auth-input" placeholder="Filter by title, id, category, tag…">
                </div>
                <div class="ea-broken-cats">
                    ${cats.map(([cat, list]) => `
                        <div class="ea-broken-cat">
                            <h3>${esc(cat)} <span class="ea-broken-cat-count">(${list.length})</span></h3>
                            <div class="ea-broken-list">
                                ${list.map(g => brokenRow(g)).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;

        const filterEl = container.querySelector('#bgFilter');
        filterEl?.addEventListener('input', () => {
            const q = filterEl.value.toLowerCase().trim();
            container.querySelectorAll('.ea-broken-row').forEach(row => {
                const hay = (row.dataset.hay || '').toLowerCase();
                row.style.display = !q || hay.includes(q) ? '' : 'none';
            });
        });

        container.querySelector('#bgExportBtn')?.addEventListener('click', () => {
            const out = {
                exportedAt: new Date().toISOString(),
                count: broken.length,
                games: broken.map(g => ({
                    id: g.id, title: g.title, category: g.category,
                    path: g.path, rom: g.rom, tags: g.tags,
                })),
            };
            const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `arcade-broken-games-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });

        container.addEventListener('click', (e) => {
            const copy = e.target.closest('.ea-broken-copy');
            if (copy) {
                navigator.clipboard?.writeText(copy.dataset.id);
                const old = copy.textContent;
                copy.textContent = 'Copied!';
                setTimeout(() => { copy.textContent = old; }, 1200);
            }
        });
    }

    function brokenRow(g) {
        const tags = (g.tags || []).slice(0, 5).join(', ');
        const hay = `${g.id} ${g.title} ${g.category} ${(g.tags || []).join(' ')}`;
        return `
            <div class="ea-broken-row" data-hay="${esc(hay)}">
                <div class="ea-broken-meat">
                    <div class="ea-broken-title">${esc(g.title || g.id)}</div>
                    <div class="ea-broken-meta">
                        <code>${esc(g.id)}</code>
                        ${g.rom ? `· <span class="ea-broken-rom">${esc(g.rom)}</span>` : ''}
                        ${tags ? `· <span class="ea-broken-tags">${esc(tags)}</span>` : ''}
                    </div>
                </div>
                <div class="ea-broken-actions">
                    <a class="ea-broken-action" href="${esc(g.path)}" target="_blank" rel="noopener">Open wrapper</a>
                    <a class="ea-broken-action" href="play.html?game=${encodeURIComponent(g.id)}" target="_blank" rel="noopener">Try in player</a>
                    <button class="ea-broken-action ea-broken-copy" data-id="${esc(g.id)}" type="button">Copy id</button>
                </div>
            </div>
        `;
    }

    // Trim "https://example.com/js/foo.js?v=1" → "foo.js"
    function shortSource(s) {
        if (!s) return '—';
        try {
            const u = new URL(s);
            return u.pathname.split('/').pop() || u.hostname;
        } catch {
            return s.slice(0, 60);
        }
    }

    window.ArcadeErrorsAdmin = { renderErrorsAdminView, loadErrors };
})();
