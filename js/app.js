(function () {
    const gameGrid = document.getElementById('gameGrid');
    const searchInput = document.getElementById('search');
    const categoriesContainer = document.getElementById('categories');
    const emptyState = document.getElementById('emptyState');
    const gameCount = document.getElementById('gameCount');

    let games = [];
    let filtered = [];
    let activeCategory = 'all';
    let activeRomPlatform = 'all'; // sub-filter inside ROMs tab
    // Sub-filter inside the Pokemon category — 'all' shows every pokemon
    // game, other values filter by tag (e.g. 'fakemon' shows only fakedex
    // hacks). Mirrors how activeRomPlatform works for the ROMs category.
    let activePokemonSubtag = 'all';
    let pokemonSubBar = null;
    let currentPage = 0;
    const PAGE_SIZE = 36;
    let loading = false;
    let favBtnEl = null; // Favorites category button
    let romSubBar = null;

    // Platform buckets displayed as ROM sub-tabs, in display order
    const ROM_PLATFORMS = [
        ['all',     'All'],
        ['gba',     'GBA'],
        ['nes',     'NES'],
        ['snes',    'SNES'],
        ['genesis', 'Genesis'],
        ['n64',     'N64'],
        ['ds',      'DS'],
        ['psx',     'PlayStation'],
        ['ps2',     'PS2'],
        ['arcade',  'Arcade'],
        ['atari',   'Atari/Lynx/Jaguar'],
        ['oldsega', 'Older Sega'],
        ['misc',    'Misc'],
    ];

    async function init() {
        try {
            const res = await fetch('games/games.json');
            games = await res.json();
        } catch {
            games = [];
        }
        buildCategories();
        buildRomSubBar();
        buildPokemonSubBar();
        buildDropdownPanel();
        buildAdminTagButton();
        buildPwaMobileToggle();
        applyFilters();
        renderPage();

        // When admin-managed tags / applications change, re-run filtering
        // so newly-applied custom tags surface immediately for everyone.
        // Also re-renders the tag pills in the categories strip.
        window.addEventListener('arcade:custom-tags-changed', () => {
            renderCustomTagPills();
            updateCategoryButtons();
            currentPage = 0;
            gameGrid.innerHTML = '';
            applyFilters();
            renderPage();
            buildAdminTagButton(); // role might've just resolved
        });
        // Auth state can flip after init (login/logout) — re-evaluate the
        // admin button whenever it does.
        if (window.ArcadeAuth?.onAuthChange) {
            ArcadeAuth.onAuthChange(() => buildAdminTagButton());
        }

        searchInput.addEventListener('input', debounce(() => {
            currentPage = 0;
            gameGrid.innerHTML = '';
            applyFilters();
            renderPage();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 250));

        // Infinite scroll — use IntersectionObserver on a sentinel instead of a
        // scroll listener. Much cheaper on mobile because it only fires when
        // the sentinel crosses the viewport, not on every scroll tick.
        let sentinel = document.getElementById('gridSentinel');
        if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.id = 'gridSentinel';
            sentinel.style.cssText = 'height:1px;width:100%;';
            gameGrid.after(sentinel);
        }
        const io = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting && !loading) {
                    const start = (currentPage + 1) * PAGE_SIZE;
                    if (start < filtered.length) {
                        currentPage++;
                        renderPage();
                    }
                }
            }
        }, { rootMargin: '800px 0px' });
        io.observe(sentinel);

        // Star button click delegation
        gameGrid.addEventListener('click', (e) => {
            const btn = e.target.closest('.fav-btn');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();

            if (!ArcadeAuth.isLoggedIn()) return;

            const gameId = btn.dataset.gameId;
            ArcadeAuth.toggleFavorite(gameId).then((isFav) => {
                btn.classList.toggle('fav-active', isFav);
            });
        });

        // Info button click delegation
        gameGrid.addEventListener('click', (e) => {
            const btn = e.target.closest('.info-btn');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(btn.dataset.gameIdx, 10);
            const g = filtered[idx];
            if (!g || !g.description) return;
            showGameInfo(g);
        });

        // Bind auth UI
        ArcadeAuth.bindAuthUI();

        // When auth changes, show/hide favorites button and re-render cards
        ArcadeAuth.onAuthChange((user) => {
            if (favBtnEl) {
                favBtnEl.style.display = user ? '' : 'none';
            }
            // Refresh the mobile dropdown since the Favorites button comes
            // and goes with auth state
            const panel = document.getElementById('catDropdownPanel');
            if (panel && panel._refresh) panel._refresh();
            // If viewing favorites and logged out, switch to All
            if (!user && activeCategory === '__favorites__') {
                activeCategory = 'all';
                updateCategoryButtons();
            }
            // Re-render all cards to add/remove star buttons
            currentPage = 0;
            gameGrid.innerHTML = '';
            applyFilters();
            renderPage();
            window.scrollTo({ top: 0, behavior: 'auto' });
        });

        // Active users bar — expandable, shows currently-playing status per user
        setupActiveUsersBar();

        // Continue Playing strip — re-renders when auth changes or when
        // user's profile recentPlays updates.
        setupContinuePlaying();

        // Random game button
        const randomBtn = document.getElementById('randomGameBtn');
        if (randomBtn) {
            randomBtn.addEventListener('click', () => {
                // Use the filtered list so "random" respects current category
                const pool = filtered.length > 0 ? filtered : games;
                if (pool.length === 0) return;
                const g = pool[Math.floor(Math.random() * pool.length)];
                window.location.href = 'play.html?game=' + encodeURIComponent(g.id);
            });
        }

        // When favorites change, update all visible star buttons
        ArcadeAuth.onFavoritesChange((favs) => {
            document.querySelectorAll('.fav-btn').forEach(btn => {
                btn.classList.toggle('fav-active', favs.has(btn.dataset.gameId));
            });
            // If viewing favorites tab, re-filter
            if (activeCategory === '__favorites__') {
                currentPage = 0;
                gameGrid.innerHTML = '';
                applyFilters();
                renderPage();
            }
        });
    }

    function buildCategories() {
        // Add Favorites button (hidden until logged in)
        favBtnEl = document.createElement('button');
        favBtnEl.className = 'cat-btn cat-btn-fav';
        favBtnEl.dataset.category = '__favorites__';
        favBtnEl.innerHTML = '&#9733; Favorites';
        favBtnEl.style.display = 'none';
        favBtnEl.addEventListener('click', () => {
            activeCategory = '__favorites__';
            updateCategoryButtons();
            currentPage = 0;
            gameGrid.innerHTML = '';
            applyFilters();
            renderPage();
            window.scrollTo({ top: 0, behavior: 'auto' });
        });
        categoriesContainer.appendChild(favBtnEl);

        // Add Popular button (always visible, shown right after Favorites/All)
        const popBtn = document.createElement('button');
        popBtn.className = 'cat-btn cat-btn-popular';
        popBtn.dataset.category = '__popular__';
        popBtn.innerHTML = '&#128293; Popular';
        popBtn.addEventListener('click', () => {
            activeCategory = '__popular__';
            updateCategoryButtons();
            currentPage = 0;
            gameGrid.innerHTML = '';
            applyFilters();
            renderPage();
            window.scrollTo({ top: 0, behavior: 'auto' });
        });
        categoriesContainer.appendChild(popBtn);

        // Add ROMs button. When active it surfaces a secondary bar of platform
        // sub-tabs (GBA / NES / SNES / etc.) that further narrows the filter.
        const romBtn = document.createElement('button');
        romBtn.className = 'cat-btn cat-btn-roms';
        romBtn.dataset.category = '__roms__';
        romBtn.innerHTML = '&#127918; ROMs';
        romBtn.addEventListener('click', () => {
            activeCategory = '__roms__';
            // Keep any previously selected platform sub-tab; default to "all"
            updateCategoryButtons();
            currentPage = 0;
            gameGrid.innerHTML = '';
            applyFilters();
            renderPage();
            window.scrollTo({ top: 0, behavior: 'auto' });
        });
        categoriesContainer.appendChild(romBtn);

        const cats = [...new Set(games.map(g => g.category))].sort();
        cats.forEach(cat => {
            const btn = document.createElement('button');
            btn.className = 'cat-btn';
            btn.dataset.category = cat;
            btn.textContent = cat;
            btn.addEventListener('click', () => {
                activeCategory = cat;
                updateCategoryButtons();
                currentPage = 0;
                gameGrid.innerHTML = '';
                applyFilters();
                renderPage();
            });
            categoriesContainer.appendChild(btn);
        });

        categoriesContainer.querySelector('[data-category="all"]').addEventListener('click', () => {
            activeCategory = 'all';
            updateCategoryButtons();
            currentPage = 0;
            gameGrid.innerHTML = '';
            applyFilters();
            renderPage();
            window.scrollTo({ top: 0, behavior: 'auto' });
        });

        renderCustomTagPills();
    }

    // Render admin-managed custom tags as filter pills appended to the
    // categories strip. Each pill drops `#tagname` into the search box so
    // it flows through the existing tag-filter pipeline (multi-tag AND,
    // active-pill row, etc.). Re-runs whenever Firestore tags change so
    // newly created tags surface live for everyone.
    function renderCustomTagPills() {
        if (!categoriesContainer) return;
        // Wipe previous batch
        categoriesContainer.querySelectorAll('.cat-btn-customtag').forEach(b => b.remove());
        const tags = window.ArcadeAdminTags?.getAllCustomTags?.() || [];
        if (!tags.length) return;
        for (const t of tags) {
            const btn = document.createElement('button');
            btn.className = 'cat-btn cat-btn-customtag';
            btn.dataset.customtag = t.name;
            const inner = t.image
                ? `<img class="custom-tag-img" src="${esc(t.image)}" alt="#${esc(t.name)}"><span>#${esc(t.name)}</span>`
                : `#${esc(t.name)}`;
            btn.innerHTML = inner;
            btn.title = `Filter by #${t.name}`;
            btn.addEventListener('click', () => {
                // Treat tag pill exactly like clicking a tag in the info modal:
                // toggle the tag in the search box, reset category filter, refresh.
                const current = searchInput.value.trim();
                const tagsInBox = current.startsWith('#')
                    ? current.split(/\s+/).filter(x => x.startsWith('#')).map(x => x.slice(1))
                    : [];
                let next;
                if (tagsInBox.includes(t.name)) {
                    next = tagsInBox.filter(x => x !== t.name);
                } else {
                    next = [...tagsInBox, t.name];
                }
                searchInput.value = next.length ? next.map(x => '#' + x).join(' ') : '';
                activeCategory = 'all';
                updateCategoryButtons();
                currentPage = 0;
                gameGrid.innerHTML = '';
                applyFilters();
                renderPage();
                window.scrollTo({ top: 0, behavior: 'auto' });
            });
            categoriesContainer.appendChild(btn);
        }
    }

    function updateCategoryButtons() {
        categoriesContainer.querySelectorAll('.cat-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.category === activeCategory);
        });
        // Also update the mobile dropdown: label + which item is highlighted
        updateDropdownLabel();
        const panel = document.getElementById('catDropdownPanel');
        if (panel) {
            panel.querySelectorAll('.cat-dropdown-item').forEach(b => {
                b.classList.toggle('active', b.dataset.category === activeCategory);
            });
        }
    }

    // Human-readable name for whatever is active. Reads the text content of
    // the real .cat-btn in the strip (that already has correct emoji + text).
    function updateDropdownLabel() {
        const labelEl = document.getElementById('catDropdownLabel');
        if (!labelEl) return;
        const activeBtn = categoriesContainer.querySelector(
            `.cat-btn[data-category="${activeCategory}"]`
        );
        labelEl.textContent = activeBtn ? activeBtn.textContent.trim() : 'All';
    }

    // Build/refresh the mobile dropdown panel. Mirrors the desktop .categories
    // strip — tapping an item does the same as tapping the corresponding
    // cat-btn, then closes the dropdown.
    function buildDropdownPanel() {
        const btn = document.getElementById('catDropdownBtn');
        const panel = document.getElementById('catDropdownPanel');
        if (!btn || !panel) return;

        function refreshItems() {
            panel.innerHTML = '';
            categoriesContainer.querySelectorAll('.cat-btn').forEach(src => {
                const item = document.createElement('button');
                item.className = 'cat-dropdown-item';
                item.dataset.category = src.dataset.category;
                item.innerHTML = src.innerHTML;
                // Match hidden state (favorites button hides when logged out)
                if (src.style.display === 'none') item.style.display = 'none';
                if (src.classList.contains('active')) item.classList.add('active');
                // Preserve color classes so favorites/popular/roms keep their tint
                ['cat-btn-fav', 'cat-btn-popular', 'cat-btn-roms'].forEach(cls => {
                    if (src.classList.contains(cls)) {
                        item.classList.add(cls.replace('cat-btn-', 'cat-dropdown-item-'));
                    }
                });
                item.addEventListener('click', () => {
                    src.click();        // delegate to the real button's click handler
                    closePanel();
                });
                panel.appendChild(item);
            });
            updateDropdownLabel();
        }

        function openPanel() {
            refreshItems();
            panel.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
            btn.classList.add('is-open');
        }
        function closePanel() {
            panel.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
            btn.classList.remove('is-open');
        }
        function togglePanel() {
            if (panel.hidden) openPanel(); else closePanel();
        }

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePanel();
        });
        document.addEventListener('click', (e) => {
            if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) {
                closePanel();
            }
        });

        // Expose a way for other code to keep items in sync when categories
        // are dynamically added (e.g. favorites button appears on login)
        panel._refresh = refreshItems;
    }

    // Levenshtein distance capped at `max` — returns max+1 if the distance
    // exceeds the cap (lets us bail out early on big mismatches).
    function lev(a, b, max) {
        if (a === b) return 0;
        const la = a.length, lb = b.length;
        if (Math.abs(la - lb) > max) return max + 1;
        let prev = new Array(lb + 1);
        for (let j = 0; j <= lb; j++) prev[j] = j;
        for (let i = 1; i <= la; i++) {
            const cur = new Array(lb + 1);
            cur[0] = i;
            let rowMin = cur[0];
            for (let j = 1; j <= lb; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
                if (cur[j] < rowMin) rowMin = cur[j];
            }
            if (rowMin > max) return max + 1;  // early-exit
            prev = cur;
        }
        return prev[lb];
    }

    // Fuzzy-match a query against a title. Returns a score:
    //   0  = exact-contains (unbeatable)
    //   1-N = minimum Levenshtein distance across title words / whole title
    //   Infinity = no match
    function fuzzyScore(title, query) {
        if (!query) return 0;
        const t = title.toLowerCase();
        const q = query.toLowerCase();
        if (t.includes(q)) return 0;

        // Tolerance scales with query length: 1 typo for short words, up to 3 for long
        const tolerance = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;

        // Try against whole title (accept short edits)
        if (q.length >= 4) {
            const d = lev(q, t, tolerance);
            if (d <= tolerance) return d;
        }
        // Try each word in the title (catches "streat" vs "street fighter")
        const words = t.split(/\s+/);
        let best = Infinity;
        for (const w of words) {
            if (w.length < 3) continue;
            const d = lev(q, w, tolerance);
            if (d < best) best = d;
            if (best === 0) return 0;
        }
        return best <= tolerance ? best : Infinity;
    }

    // PWA mobile-only filter toggle. Only renders when the arcade is
    // running in standalone (installed) mode. Lives in the header so
    // it's visible without scrolling. Two states:
    //   - Active (default): filtering, only #mobile games shown.
    //     Pill says "📱 Mobile only" with a "show all" hint.
    //   - Override: localStorage set to 'show-all', filter off,
    //     pill says "📱 Show all" with hint to re-enable filter.
    function buildPwaMobileToggle() {
        if (!isPwaStandalone()) return;
        let btn = document.getElementById('pwaMobileToggle');
        if (btn) btn.remove();
        btn = document.createElement('button');
        btn.id = 'pwaMobileToggle';
        btn.className = 'pwa-mobile-toggle';
        btn.type = 'button';
        const update = () => {
            const filtering = shouldFilterToMobile();
            btn.textContent = filtering ? '\u{1F4F1} Mobile only' : '\u{1F4F1} All games';
            btn.title = filtering
                ? 'Showing only games tagged #mobile (touch-friendly). Tap to show all games.'
                : 'Showing every game in the catalog. Tap to filter to mobile-friendly only.';
            btn.dataset.state = filtering ? 'on' : 'off';
        };
        update();
        btn.addEventListener('click', () => {
            const next = shouldFilterToMobile() ? 'show-all' : 'mobile-only';
            localStorage.setItem('arcade-mobile-only-override', next);
            update();
            currentPage = 0;
            gameGrid.innerHTML = '';
            applyFilters();
            renderPage();
        });
        // Insert into the header, before the auth area.
        const authArea = document.getElementById('authArea');
        if (authArea && authArea.parentNode) {
            authArea.parentNode.insertBefore(btn, authArea);
        }
    }

    // Inject the "Manage Tags" admin button into the controls row, beside
    // the game count. Only visible to admins; idempotent so re-evaluating
    // on auth-change just toggles its presence rather than duplicating.
    function buildAdminTagButton() {
        const isAdmin = !!window.ArcadeAuth?.isAdmin?.();
        let btn = document.getElementById('manageTagsBtn');
        let bulkBtn = document.getElementById('bulkAddBtn');
        if (!isAdmin) {
            if (btn) btn.remove();
            if (bulkBtn) bulkBtn.remove();
            return;
        }
        const countEl = document.getElementById('gameCount');
        if (!countEl || !countEl.parentNode) return;

        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'manageTagsBtn';
            btn.className = 'manage-tags-btn';
            btn.type = 'button';
            btn.title = 'Manage custom tags';
            btn.innerHTML = '&#127991; Manage Tags';
            btn.addEventListener('click', () => {
                window.ArcadeAdminTags?.showTagManagementModal?.();
            });
            countEl.parentNode.insertBefore(btn, countEl);
        }

        // Bulk-add games tool — sits next to Manage Tags. LLM-powered:
        // paste itch URLs, get back catalog-ready entries.
        if (!bulkBtn) {
            bulkBtn = document.createElement('button');
            bulkBtn.id = 'bulkAddBtn';
            bulkBtn.className = 'manage-tags-btn';
            bulkBtn.type = 'button';
            bulkBtn.title = 'Bulk-add games via LLM research';
            bulkBtn.innerHTML = '&#128190; Bulk Add';
            bulkBtn.addEventListener('click', () => {
                window.ArcadeBulkAdd?.showBulkAddModal?.();
            });
            countEl.parentNode.insertBefore(bulkBtn, countEl);
        }

        // Edit Catalog — admin GUI for editing/deleting existing
        // entries. Add is covered by Bulk Add; this fills the rest.
        let editBtn = document.getElementById('editCatalogBtn');
        if (!editBtn) {
            editBtn = document.createElement('button');
            editBtn.id = 'editCatalogBtn';
            editBtn.className = 'manage-tags-btn';
            editBtn.type = 'button';
            editBtn.title = 'Edit existing catalog entries';
            editBtn.innerHTML = '&#9998; Edit Catalog';
            editBtn.addEventListener('click', () => {
                window.ArcadeCatalogAdmin?.showCatalogAdminModal?.();
            });
            countEl.parentNode.insertBefore(editBtn, countEl);
        }
    }

    // Merged tag list for filtering: the baked-in `tags` from games.json
    // plus any admin-applied custom tags from Firestore. Returns a plain
    // array (deduped) so callers can use `Array.includes` and `.every`.
    function effectiveTags(g) {
        const baseline = Array.isArray(g.tags) ? g.tags : [];
        const custom = window.ArcadeAdminTags?.getCustomTagsForGame?.(g.id) || [];
        if (!custom.length) return baseline;
        const merged = baseline.slice();
        for (const t of custom) if (!merged.includes(t)) merged.push(t);
        return merged;
    }

    // PWA mobile-only filter — when the user has installed the arcade
    // and is running it from the home-screen icon, hide every game
    // that isn't tagged `mobile`. Keyboard-required games are
    // unplayable on phones (no on-screen controls), so showing them
    // is just clutter. Toggleable via the "Show all" pill that
    // appears in the header when filter is active. Stored in
    // localStorage so the override persists.
    function isPwaStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true;
    }
    function shouldFilterToMobile() {
        if (!isPwaStandalone()) return false;
        return localStorage.getItem('arcade-mobile-only-override') !== 'show-all';
    }

    function applyFilters() {
        let query = searchInput.value.toLowerCase().trim();
        const mobileOnly = shouldFilterToMobile();

        // Tag-search mode: `#tagname` filters to games tagged with `tagname`.
        // Space-separated tags after the hash require ALL tags ("#rpg #jrpg").
        let tagQueries = null;
        if (query.startsWith('#')) {
            tagQueries = query.split(/\s+/)
                .filter(t => t.startsWith('#') && t.length > 1)
                .map(t => t.slice(1));
            query = ''; // suppress text search when in tag mode
        }
        renderActiveTagPills(tagQueries);

        // First pass: substring matches (fast path, covers 99% of typing)
        const substringMatches = [];
        const fuzzyCandidates = [];

        for (const g of games) {
            // Category filter first (cheaper than text search)
            let matchesCategory;
            if (activeCategory === '__favorites__') {
                matchesCategory = ArcadeAuth.isFavorite(g.id);
            } else if (activeCategory === '__popular__') {
                matchesCategory = !!g.popular;
            } else if (activeCategory === '__roms__') {
                if (!g.rom) matchesCategory = false;
                else if (activeRomPlatform === 'all') matchesCategory = true;
                else matchesCategory = g.rom === activeRomPlatform;
            } else {
                matchesCategory = activeCategory === 'all' || g.category === activeCategory;
            }
            if (!matchesCategory) continue;

            // PWA mobile-only filter: skip any game without the `mobile`
            // tag when the arcade is launched as an installed app and
            // the user hasn't opted into "show all".
            if (mobileOnly) {
                const tags = effectiveTags(g);
                if (!tags.includes('mobile')) continue;
            }

            // Pokemon subtag filter — only active when we're inside the
            // Pokemon category and the user picked a specific subtag.
            if (activeCategory === 'Pokemon' && activePokemonSubtag !== 'all') {
                const tags = effectiveTags(g);
                if (!tags.includes(activePokemonSubtag)) continue;
            }

            if (tagQueries) {
                // Every requested tag must be on the game (either baked-in
                // games.json tags or admin-applied custom tags).
                const tags = effectiveTags(g);
                if (tagQueries.every(t => tags.includes(t))) {
                    substringMatches.push(g);
                }
                continue;
            }

            if (!query) {
                substringMatches.push(g);
                continue;
            }
            if (g.title.toLowerCase().includes(query)) {
                substringMatches.push(g);
            } else {
                fuzzyCandidates.push(g);
            }
        }

        filtered = substringMatches;

        // Second pass: fuzzy fallback ONLY when substring matches are scarce
        // and the query is long enough to be meaningful. Catches typos like
        // "ponemon unbound" or "strret fighter" without flooding normal
        // queries with noise.
        if (query && query.length >= 3 && substringMatches.length < 20) {
            const scored = [];
            for (const g of fuzzyCandidates) {
                const s = fuzzyScore(g.title, query);
                if (s !== Infinity) scored.push([s, g]);
            }
            // Sort by lowest distance, take up to 20 fuzzy matches
            scored.sort((a, b) => a[0] - b[0]);
            for (let i = 0; i < Math.min(20, scored.length); i++) {
                filtered.push(scored[i][1]);
            }
        }

        // Surface recently-added games at the top of the default view.
        // Only when the user hasn't typed a query and isn't filtering by
        // a specific category (otherwise it'd hide expected results).
        // Stable sort: within "new" and "not new" groups, original order
        // is preserved so Pokemon Unbound stays where it always was, etc.
        if (!query && !tagQueries && activeCategory === 'all') {
            filtered.sort((a, b) => {
                const aNew = a.addedAt ? 1 : 0;
                const bNew = b.addedAt ? 1 : 0;
                if (aNew !== bNew) return bNew - aNew;   // new first
                // Among new: sort by date descending (newest first)
                if (aNew) return (b.addedAt || '').localeCompare(a.addedAt || '');
                return 0;   // stable: keep original order for older games
            });
        }

        if (gameCount) {
            gameCount.textContent = `${filtered.length} game${filtered.length !== 1 ? 's' : ''}`;
        }
        if (romSubBar) {
            romSubBar.style.display = activeCategory === '__roms__' ? '' : 'none';
        }
        if (pokemonSubBar) {
            pokemonSubBar.style.display = activeCategory === 'Pokemon' ? '' : 'none';
        }
    }

    function buildRomSubBar() {
        // Insert sub-tab bar right after the main categories row.
        romSubBar = document.createElement('div');
        romSubBar.className = 'rom-subbar';
        romSubBar.style.display = 'none';
        // Count per platform for the labels
        const counts = {};
        for (const g of games) if (g.rom) counts[g.rom] = (counts[g.rom] || 0) + 1;
        const total = Object.values(counts).reduce((a, b) => a + b, 0);

        for (const [key, label] of ROM_PLATFORMS) {
            const btn = document.createElement('button');
            btn.className = 'rom-sub-btn' + (key === activeRomPlatform ? ' active' : '');
            btn.dataset.platform = key;
            const count = key === 'all' ? total : (counts[key] || 0);
            btn.innerHTML = `${label} <span class="rom-sub-count">${count}</span>`;
            btn.addEventListener('click', () => {
                activeRomPlatform = key;
                romSubBar.querySelectorAll('.rom-sub-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.platform === key);
                });
                currentPage = 0;
                gameGrid.innerHTML = '';
                applyFilters();
                renderPage();
                window.scrollTo({ top: 0, behavior: 'auto' });
            });
            romSubBar.appendChild(btn);
        }
        // Place after the .controls block, above the game grid
        const controls = document.querySelector('.controls');
        if (controls && controls.parentNode) {
            controls.parentNode.insertBefore(romSubBar, controls.nextSibling);
        }
    }

    // Sub-filter bar that appears only when the Pokemon category is active.
    // Pills narrow the visible set to a specific subtype — currently just
    // "Fakemon" (full or partial custom-species hacks) but easy to extend.
    // Same styling/placement pattern as the ROMs sub-bar for consistency.
    function buildPokemonSubBar() {
        const SUBTAGS = [
            { key: 'all',      label: 'All',      emoji: '' },
            { key: 'fakemon',  label: 'Fakemon',  emoji: '🧬' },
        ];

        // Count games per subtag for the small number pill on each button.
        const pokemonGames = games.filter(g => g.category === 'Pokemon');
        const counts = {};
        for (const g of pokemonGames) {
            for (const t of (g.tags || [])) {
                counts[t] = (counts[t] || 0) + 1;
            }
        }
        counts.all = pokemonGames.length;

        pokemonSubBar = document.createElement('div');
        // Reuses .rom-subbar styling so the visual matches without new CSS.
        pokemonSubBar.className = 'rom-subbar pokemon-subbar';
        pokemonSubBar.style.display = 'none';

        for (const { key, label, emoji } of SUBTAGS) {
            const btn = document.createElement('button');
            btn.className = 'rom-sub-btn' + (key === activePokemonSubtag ? ' active' : '');
            btn.dataset.subtag = key;
            const count = counts[key] || 0;
            const labelText = emoji ? `${emoji} ${label}` : label;
            btn.innerHTML = `${labelText} <span class="rom-sub-count">${count}</span>`;
            btn.addEventListener('click', () => {
                activePokemonSubtag = key;
                pokemonSubBar.querySelectorAll('.rom-sub-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.subtag === key);
                });
                currentPage = 0;
                gameGrid.innerHTML = '';
                applyFilters();
                renderPage();
                window.scrollTo({ top: 0, behavior: 'auto' });
            });
            pokemonSubBar.appendChild(btn);
        }

        const controls = document.querySelector('.controls');
        if (controls && controls.parentNode) {
            // Insert right after the ROM sub-bar so the two stay visually
            // adjacent — they're mutually exclusive (visibility is toggled
            // by the active category).
            const afterRom = romSubBar?.nextSibling || controls.nextSibling;
            controls.parentNode.insertBefore(pokemonSubBar, afterRom);
        }
    }

    function renderPage() {
        const start = currentPage * PAGE_SIZE;
        const end = start + PAGE_SIZE;
        const pageGames = filtered.slice(start, end);

        if (filtered.length === 0) {
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';

        if (pageGames.length === 0) return;

        loading = true;

        const loggedIn = ArcadeAuth.isLoggedIn();
        let html = '';
        for (let i = 0; i < pageGames.length; i++) {
            const g = pageGames[i];
            const thumb = g.thumbnail
                ? `<img class="card-thumbnail" src="${esc(g.thumbnail)}" alt="${esc(g.title)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${platformFallback(g.rom)}'">`
                : `<div class="card-thumbnail-placeholder"><span>${esc(g.title.charAt(0).toUpperCase())}</span></div>`;
            const favClass = loggedIn && ArcadeAuth.isFavorite(g.id) ? ' fav-active' : '';
            const favBtn = loggedIn
                ? `<button class="fav-btn${favClass}" data-game-id="${esc(g.id)}" title="Favorite">&#9733;</button>`
                : '';
            const infoBtn = g.description
                ? `<button class="info-btn" data-game-idx="${start + i}" title="Game info">&#8942;</button>`
                : '';
            // "NEW" badge for games added within the last 30 days
            const newBadge = g.addedAt && (Date.now() - Date.parse(g.addedAt)) < 30 * 24 * 60 * 60 * 1000
                ? `<span class="card-new-badge">NEW</span>`
                : '';
            // Pre-download button — only for PS2 games that have an
            // archive URL configured. Lets users start the multi-GB
            // download in the background while browsing other cards;
            // /play/'s loader picks up the cached blob and skips
            // straight to boot when they actually click the card.
            // Live state is wired in startObservingPreloads() after
            // the grid is appended to the DOM.
            const ps2PreloadBtn = (g.rom === 'ps2' && g.archiveRomUrl)
                ? `<button class="ps2-preload-btn" data-game-id="${esc(g.id)}" data-state="idle" title="Pre-download so the next click boots instantly">
                       <span class="ps2-preload-label">&#128229; Pre-download</span>
                       <span class="ps2-preload-bar"><span class="ps2-preload-bar-fill"></span></span>
                   </button>`
                : '';
            html += `<a class="game-card" href="play.html?game=${encodeURIComponent(g.id)}">${thumb}${newBadge}${favBtn}${infoBtn}${ps2PreloadBtn}<div class="card-body"><span class="card-category">${esc(g.category)}</span><h3 class="card-title">${esc(g.title)}</h3></div></a>`;
        }

        gameGrid.insertAdjacentHTML('beforeend', html);
        wireUpPs2PreloadButtons(pageGames);
        loading = false;
    }

    // ─── PS2 pre-download wiring ──────────────────────────────────────
    // For each PS2 card just rendered, query the IDB cache once to
    // initialize button state (cached vs idle), wire the click handler,
    // and subscribe to live state events so the button reflects ongoing
    // downloads.
    let ps2PreloadObserved = false;
    function wireUpPs2PreloadButtons(pageGames) {
        const buttons = gameGrid.querySelectorAll('.ps2-preload-btn:not([data-wired="1"])');
        if (!buttons.length || !window.ArcadePs2Preload) return;

        for (const btn of buttons) {
            btn.dataset.wired = '1';
            const gameId = btn.dataset.gameId;
            const game = pageGames.find(x => x.id === gameId)
                || games.find(x => x.id === gameId);
            if (!game || !game.archiveRomUrl) continue;

            // Click → open a modal that lets the user pick auto vs manual.
            // Manual is typically much faster: the browser downloads from
            // archive.org direct from the user's residential IP (not pooled
            // with everyone else through our worker). Auto-download is
            // simpler but throttled.
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const cur = ArcadePs2Preload.getState(gameId);
                if (cur.state === 'cached' || cur.state === 'downloading' || cur.state === 'saving') return;
                showPs2GetModal(game);
            });

            // Initial state — async cache check.
            ArcadePs2Preload.getInitialState(gameId, game.archiveRomUrl).then((state) => {
                renderPs2ButtonState(btn, state);
            });
        }

        // Subscribe once to broadcast live state changes to all buttons.
        if (!ps2PreloadObserved) {
            ps2PreloadObserved = true;
            ArcadePs2Preload.onChange((gameId, state) => {
                gameGrid.querySelectorAll(`.ps2-preload-btn[data-game-id="${gameId.replace(/"/g, '\\"')}"]`)
                    .forEach((b) => renderPs2ButtonState(b, state));
            });
        }
    }

    // ─── Active tag-filter pills ──────────────────────────────────────
    // Renders the tags the user is currently filtering by as removable
    // chips below the search bar. Each chip has × to drop just that tag.
    // Hidden when there are no tags active. Helps users see what's
    // narrowing their results and combine multiple tags discoverably.
    function renderActiveTagPills(tagQueries) {
        const wrap = document.getElementById('activeTagPills');
        if (!wrap) return;
        if (!tagQueries || tagQueries.length === 0) {
            wrap.hidden = true;
            wrap.innerHTML = '';
            return;
        }
        wrap.hidden = false;
        function pillInner(tag) {
            const def = window.ArcadeAdminTags?.getTagDef?.(tag);
            if (def && def.image) {
                return `<img class="custom-tag-img" src="${esc(def.image)}" alt="#${esc(tag)}"><span class="active-tag-pill-name">#${esc(tag)}</span>`;
            }
            return `<span class="active-tag-pill-name">#${esc(tag)}</span>`;
        }
        wrap.innerHTML = tagQueries.map(tag => `
            <button class="active-tag-pill" data-tag="${esc(tag)}" title="Remove this tag from filter">
                ${pillInner(tag)}
                <span class="active-tag-pill-x">&times;</span>
            </button>
        `).join('') + (tagQueries.length > 1 ? `
            <button class="active-tag-pill active-tag-pill-clear" id="clearAllTagsBtn" title="Clear all tag filters">Clear all</button>
        ` : '');
        wrap.querySelectorAll('.active-tag-pill[data-tag]').forEach(btn => {
            btn.addEventListener('click', () => {
                const remaining = tagQueries.filter(t => t !== btn.dataset.tag);
                searchInput.value = remaining.length ? remaining.map(t => '#' + t).join(' ') : '';
                currentPage = 0;
                gameGrid.innerHTML = '';
                applyFilters();
                renderPage();
            });
        });
        const clearBtn = document.getElementById('clearAllTagsBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                searchInput.value = '';
                currentPage = 0;
                gameGrid.innerHTML = '';
                applyFilters();
                renderPage();
            });
        }
    }

    // ─── PS2 "Get ROM" modal ──────────────────────────────────────────
    // Shown when a user clicks the pre-download chip on a PS2 card.
    // Two routes: auto (Background Fetch via worker) or manual (download
    // direct from archive.org, drop the file back). Manual is faster
    // because each user's residential IP gets its own archive.org rate
    // limit pool; the worker's pool is shared across all arcade users.
    function showPs2GetModal(game) {
        document.getElementById('ps2GetModal')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'ps2GetModal';
        overlay.innerHTML = `
            <div class="modal-box ps2-get-modal">
                <div class="modal-header">
                    <h2>Get ${esc(game.title)}</h2>
                    <button class="modal-close" id="ps2GetClose">&times;</button>
                </div>
                <div class="ps2-get-body">
                    <section class="ps2-get-option">
                        <h3>&#9881;&#65039; Auto-download</h3>
                        <p>We download via our proxy. Survives navigation but may be slow when archive.org is throttling our IP.</p>
                        <button class="auth-submit" id="ps2GetAuto">Start auto-download</button>
                    </section>

                    <div class="ps2-get-divider"><span>OR</span></div>

                    <section class="ps2-get-option">
                        <h3>&#128640; Manual (typically much faster)</h3>
                        <ol class="ps2-get-steps">
                            <li>
                                <a href="${esc(game.archiveRomUrl)}" download target="_blank" rel="noopener" class="ps2-get-direct">
                                    &#128229; Download ROM from archive.org
                                </a>
                                <span class="ps2-get-substep">(saves to your Downloads folder — ~2-5 GB)</span>
                            </li>
                            <li>
                                <span>Drop the file here when it's done:</span>
                                <label class="ps2-get-dropzone" id="ps2GetDropzone">
                                    <input type="file" id="ps2GetFile" accept=".iso,.chd,.bin,.cso,.isz,.elf" hidden>
                                    <span class="ps2-get-dropzone-label">Click or drag a .iso file here</span>
                                </label>
                            </li>
                        </ol>
                        <div class="ps2-get-status" id="ps2GetStatus" hidden></div>
                    </section>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.getElementById('ps2GetClose').addEventListener('click', close);

        document.getElementById('ps2GetAuto').addEventListener('click', () => {
            ArcadePs2Preload.startPreload(game.id, game.archiveRomUrl, game.title);
            close();
        });

        const fileInput = document.getElementById('ps2GetFile');
        const dropzone = document.getElementById('ps2GetDropzone');
        const status = document.getElementById('ps2GetStatus');

        function setStatus(msg, visible) {
            if (!status) return;
            status.textContent = msg;
            status.hidden = !visible;
        }

        function handleFile(file) {
            if (!file) return;
            setStatus(`Saving ${file.name} to cache…`, true);
            ArcadePs2Preload.cacheUploadedFile(game.id, game.archiveRomUrl, file)
                .then(() => {
                    setStatus(`✅ Ready! Close this dialog and click the card to play.`, true);
                    setTimeout(close, 1800);
                })
                .catch((e) => {
                    setStatus(`Save failed: ${e.message || 'storage full?'}`, true);
                });
        }

        fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('drag-over');
        });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('drag-over');
            handleFile(e.dataTransfer.files[0]);
        });
    }

    function renderPs2ButtonState(btn, state) {
        const labelEl = btn.querySelector('.ps2-preload-label');
        const fillEl = btn.querySelector('.ps2-preload-bar-fill');
        if (!labelEl) return;
        btn.dataset.state = state.state || 'idle';
        switch (state.state) {
            case 'cached':
                labelEl.innerHTML = '&#10003; Ready';
                if (fillEl) fillEl.style.width = '100%';
                btn.title = 'Already downloaded — clicking the card boots instantly';
                break;
            case 'downloading': {
                // Show the actual MB transferred — early-stage downloads round
                // to "0%" and the user can't tell if anything is happening.
                // Layout: "230 / 4382 MB • 10.6 MB/s" when total is known,
                //         "230 MB • 10.6 MB/s" when total is unknown.
                // The visual bar still fills based on percentage.
                const mb = (n) => (n / 1048576).toFixed(0);
                const received = state.received || 0;
                const total = state.total || 0;
                const speed = state.speed
                    ? (state.speed >= 1048576
                        ? (state.speed / 1048576).toFixed(1) + ' MB/s'
                        : (state.speed / 1024).toFixed(0) + ' KB/s')
                    : '';
                let primary;
                if (received <= 0) {
                    primary = 'starting…';
                } else if (total) {
                    primary = `${mb(received)}/${mb(total)} MB`;
                } else {
                    primary = `${mb(received)} MB`;
                }
                const pct = total ? (received / total) * 100 : 0;
                labelEl.textContent = `${primary}${speed ? ' • ' + speed : ''}`;
                if (fillEl) fillEl.style.width = pct + '%';
                btn.title = state._backgrounded
                    ? 'Downloading in background — you can navigate or close the tab'
                    : 'Downloading… stay on this page';
                break;
            }
            case 'saving':
                labelEl.textContent = 'Saving…';
                if (fillEl) fillEl.style.width = '100%';
                break;
            case 'error':
                labelEl.textContent = 'Retry';
                if (fillEl) fillEl.style.width = '0%';
                btn.title = 'Download failed: ' + (state.error || 'unknown') + '. Click to retry.';
                break;
            case 'idle':
            default:
                labelEl.innerHTML = '&#128229; Pre-download';
                if (fillEl) fillEl.style.width = '0%';
                btn.title = 'Pre-download so the next click boots instantly';
                break;
        }
    }

    function esc(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Used by card/info thumbnails as an onerror fallback — if a remote cover
    // (libretro CDN, etc.) 404s, swap to the platform icon instead of showing
    // a broken image.
    function platformFallback(rom) {
        const map = {
            gba: 'gba', gbc: 'gba', gb: 'gba',
            ds: 'ds', n64: 'n64', snes: 'snes', nes: 'nes',
            psx: 'psx', ps2: 'psx', genesis: 'genesis', arcade: 'arcade', atari: 'atari',
        };
        const p = map[rom] || 'misc';
        return `assets/thumbnails/platforms/${p}.png`;
    }

    function debounce(fn, ms) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }

    // Heuristic similar-game scorer. Looks at every other game in the
    // catalog and ranks by:
    //   +N for each tag in common (deduped, lowercase)
    //   +3 for matching category
    //   +2 for matching ROM platform
    //   +1 if both are popular (popular games tend to recommend popular)
    // Skips the source game itself + games whose tags overlap is 0
    // (no shared tags = nothing to recommend, even if same category).
    // Returns top N results.
    function computeRecs(source, n) {
        if (!source || !games.length) return [];
        const sourceTags = new Set(effectiveTags(source).map(t => t.toLowerCase()));
        if (sourceTags.size === 0) return [];
        const scored = [];
        for (const g of games) {
            if (g.id === source.id) continue;
            // Skip stub entries (no real metadata)
            if (!g.tags && !g.thumbnail) continue;
            const gtags = effectiveTags(g);
            let overlap = 0;
            for (const t of gtags) if (sourceTags.has(t.toLowerCase())) overlap++;
            if (overlap === 0) continue;
            let score = overlap;
            if (g.category && g.category === source.category) score += 3;
            if (g.rom && g.rom === source.rom) score += 2;
            if (g.popular && source.popular) score += 1;
            scored.push([score, g]);
        }
        scored.sort((a, b) => b[0] - a[0]);
        return scored.slice(0, n).map(([, g]) => g);
    }

    function showGameInfo(g) {
        const existing = document.getElementById('gameInfoOverlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'gameInfoOverlay';
        overlay.className = 'game-info-overlay';

        const thumb = g.thumbnail
            ? `<img class="game-info-thumb" src="${esc(g.thumbnail)}" alt="${esc(g.title)}" decoding="async" onerror="this.onerror=null;this.src='${platformFallback(g.rom)}'">`
            : '';

        // Render tags as clickable pills. Clicking one runs a tag search.
        // Merge baked-in games.json tags with admin-applied custom tags.
        // Custom tags can carry an image — render <img> inside the chip
        // when present (fallback to `#name` text otherwise).
        const tags = effectiveTags(g);
        function renderInfoTagInner(t) {
            const def = window.ArcadeAdminTags?.getTagDef?.(t);
            if (def && def.image) {
                return `<img class="custom-tag-img" src="${esc(def.image)}" alt="#${esc(t)}"><span>#${esc(t)}</span>`;
            }
            return `#${esc(t)}`;
        }
        const tagsHtml = tags.length ? `
            <div class="game-info-tags">
                ${tags.map(t =>
                    `<button class="game-info-tag" data-tag="${esc(t)}">${renderInfoTagInner(t)}</button>`
                ).join('')}
            </div>` : '';

        const isAdmin = !!window.ArcadeAuth?.isAdmin?.();
        const adminTagBtn = isAdmin ? `
            <button class="game-info-edit-tags" id="gameInfoEditTagsBtn" title="Edit custom tags for this game">&#9998; Edit Tags</button>
        ` : '';

        // Save Offline button — only for iframe games (ROM games can't
        // be cached by our SW pattern). Async-checks if already saved
        // to render the right label, but starts as "Save offline" and
        // updates after a beat.
        const offlineBtn = window.ArcadeOfflinePack?.isEligible?.(g)
            ? `<button class="game-info-offline-btn" id="gameInfoOfflineBtn" data-id="${esc(g.id)}" title="Save this game so it works offline">&#128229; Save offline</button>`
            : '';

        // Co-op button — share your screen so a friend can watch.
        // Hidden on mobile since getDisplayMedia isn't supported there
        // and the UX would be confusing. Only shown when signed in
        // (Firestore signaling needs auth).
        const canCoop = !!navigator.mediaDevices?.getDisplayMedia
            && !!window.ArcadeAuth?.isLoggedIn?.()
            && !!window.ArcadeCoop;
        const coopBtn = canCoop
            ? `<button class="game-info-coop-btn" id="gameInfoCoopBtn" title="Share your screen with a friend so they can watch you play">&#128106; Co-op</button>`
            : '';

        // Smart recommendations — score every other game in the catalog
        // by tag overlap with the current game, give a boost for matching
        // category + matching ROM platform, and surface the top 6.
        // Pure heuristic, no API call, instant. Works even with the LLM
        // worker offline.
        const recs = computeRecs(g, 6);
        const recsHtml = recs.length ? `
            <div class="game-info-recs-wrap">
                <div class="game-info-recs-label">Liked this? Try also&hellip;</div>
                <div class="game-info-recs">
                    ${recs.map(r => `
                        <button class="game-info-rec" data-id="${esc(r.id)}">
                            <img class="game-info-rec-thumb"
                                 src="${esc(r.thumbnail || platformFallback(r.rom))}"
                                 alt="${esc(r.title)}"
                                 onerror="this.onerror=null;this.src='${platformFallback(r.rom)}'">
                            <span class="game-info-rec-title">${esc(r.title)}</span>
                        </button>
                    `).join('')}
                </div>
            </div>` : '';

        overlay.innerHTML = `
            <div class="game-info-modal">
                <button class="game-info-close">&times;</button>
                ${thumb}
                <h2 class="game-info-title">${esc(g.title)}</h2>
                <span class="game-info-category">${esc(g.category)}</span>
                ${tagsHtml}
                ${adminTagBtn}
                <p class="game-info-desc">${esc(g.description)}</p>
                <a class="game-info-play" href="play.html?game=${encodeURIComponent(g.id)}">Play Now</a>
                ${offlineBtn}
                ${coopBtn}
                ${recsHtml}
            </div>`;

        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        overlay.querySelector('.game-info-close').addEventListener('click', () => overlay.remove());

        // Admin: open the per-game custom-tag picker. Modal stacks on top
        // of the game info modal — closing it returns to the info view.
        const editBtn = overlay.querySelector('#gameInfoEditTagsBtn');
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.ArcadeAdminTags?.showApplyTagsModal?.(g);
            });
        }

        // Tag clicks → ADD `#tag` to the search box. If the search already
        // has tags, append to narrow the filter further (multi-tag AND).
        // If the same tag is already there, remove it (toggle).
        overlay.querySelectorAll('.game-info-tag').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tag = btn.dataset.tag;
                const current = searchInput.value.trim();
                const tagsInBox = current.startsWith('#')
                    ? current.split(/\s+/).filter(t => t.startsWith('#')).map(t => t.slice(1))
                    : [];
                let nextTags;
                if (tagsInBox.includes(tag)) {
                    // Already filtering by this tag — clicking again removes it (toggle).
                    nextTags = tagsInBox.filter(t => t !== tag);
                } else {
                    // Add to existing filter (or start a new one if the box was empty).
                    nextTags = [...tagsInBox, tag];
                }
                searchInput.value = nextTags.length ? nextTags.map(t => '#' + t).join(' ') : '';
                activeCategory = 'all';
                updateCategoryButtons();
                currentPage = 0;
                gameGrid.innerHTML = '';
                applyFilters();
                renderPage();
                overlay.remove();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });

        // Co-op button — opens a host modal where the user grants screen
        // share, gets a 6-char room code + invite link, and waits for a
        // friend to join. Stream goes peer-to-peer via WebRTC.
        const coopButton = overlay.querySelector('#gameInfoCoopBtn');
        if (coopButton && window.ArcadeCoop) {
            coopButton.addEventListener('click', () => {
                window.ArcadeCoop.startCoopAsHost(g);
            });
        }

        // Save-offline button — fetches the wrapper + iframe target +
        // thumbnail through the SW so they're available when offline.
        const offlineButton = overlay.querySelector('#gameInfoOfflineBtn');
        if (offlineButton && window.ArcadeOfflinePack) {
            // Initial state: check if already saved
            ArcadeOfflinePack.getSavedGame(g.id).then(saved => {
                if (saved) {
                    offlineButton.innerHTML = '&#10003; Saved offline';
                    offlineButton.dataset.state = 'saved';
                }
            });
            offlineButton.addEventListener('click', async () => {
                if (offlineButton.dataset.state === 'saved') {
                    if (!confirm('Remove this game from offline storage?')) return;
                    offlineButton.disabled = true;
                    offlineButton.textContent = 'Removing…';
                    await ArcadeOfflinePack.uncacheGame(g.id);
                    offlineButton.disabled = false;
                    offlineButton.innerHTML = '\u{1F4E5} Save offline';
                    offlineButton.dataset.state = '';
                    return;
                }
                offlineButton.disabled = true;
                offlineButton.textContent = 'Saving…';
                try {
                    await ArcadeOfflinePack.cacheGame(g, (msg) => {
                        offlineButton.textContent = msg;
                    });
                    offlineButton.innerHTML = '\u{2713} Saved offline';
                    offlineButton.dataset.state = 'saved';
                } catch (e) {
                    alert('Save failed: ' + e.message);
                    offlineButton.innerHTML = '\u{1F4E5} Save offline';
                } finally {
                    offlineButton.disabled = false;
                }
            });
        }

        // Rec card click → open the recommended game's info modal in place
        // of the current one. Lets users browse a recommendation chain
        // without going back to the grid each time.
        overlay.querySelectorAll('.game-info-rec').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const recId = btn.dataset.id;
                const recGame = games.find(x => x.id === recId);
                if (recGame) {
                    overlay.remove();
                    showGameInfo(recGame);
                }
            });
        });
    }

    function buildPartNav() {
        const nav = document.getElementById('partNav');
        if (!nav || !window.ARCADE_PARTS) return;
        const parts = window.ARCADE_PARTS;
        const current = window.ARCADE_CURRENT || 1;
        let html = '';
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            const active = p.part === current ? ' active' : '';
            html += `<a class="part-link${active}" href="${esc(p.url)}">Part ${p.part}</a>`;
        }
        nav.innerHTML = html;
    }

    // Games index by id — populated on first call of getGameById().
    // Used to look up titles for the "playing X" label in the active users bar.
    let gamesById = null;
    function getGameById(id) {
        if (!gamesById) {
            gamesById = {};
            games.forEach(g => { gamesById[g.id] = g; });
        }
        return gamesById[id];
    }

    // Render the user's "Continue Playing" strip on the home view. Data
    // lives on their profile (`recentPlays: [{gameId, at}, ...]`) which
    // player.js updates every time they load a game.
    async function renderContinuePlaying() {
        const section = document.getElementById('continuePlaying');
        const strip = document.getElementById('continueStrip');
        if (!section || !strip) return;

        if (!ArcadeAuth.isLoggedIn()) {
            section.hidden = true;
            return;
        }
        const uid = ArcadeAuth.getUser()?.uid;
        if (!uid) { section.hidden = true; return; }

        let profile;
        try { profile = await ArcadeAuth.getProfile(uid); }
        catch { section.hidden = true; return; }

        const plays = Array.isArray(profile && profile.recentPlays) ? profile.recentPlays : [];
        if (plays.length === 0) { section.hidden = true; return; }

        // Resolve gameId → game entry, keep the first 8 that still exist in
        // the catalog. Preserves original order (most-recent-first).
        const byId = {};
        for (const g of games) byId[g.id] = g;
        const resolved = [];
        const seen = new Set();
        for (const p of plays) {
            const g = byId[p.gameId];
            if (!g || seen.has(g.id)) continue;
            seen.add(g.id);
            resolved.push(g);
            if (resolved.length >= 8) break;
        }
        if (resolved.length === 0) { section.hidden = true; return; }

        strip.innerHTML = resolved.map(g => {
            const thumb = g.thumbnail
                ? `<img class="continue-thumb" src="${esc(g.thumbnail)}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${platformFallback(g.rom)}'">`
                : `<div class="continue-thumb continue-thumb-placeholder">${esc(g.title.charAt(0).toUpperCase())}</div>`;
            return `<a class="continue-card" href="play.html?game=${encodeURIComponent(g.id)}" title="${esc(g.title)}">
                ${thumb}
                <span class="continue-title">${esc(g.title)}</span>
            </a>`;
        }).join('');

        section.hidden = false;
    }

    function setupContinuePlaying() {
        renderContinuePlaying();
        // Re-render when auth state changes
        if (ArcadeAuth && ArcadeAuth.onAuthChange) {
            ArcadeAuth.onAuthChange(() => renderContinuePlaying());
        }
        // Clear-history button: empty the user's recentPlays field
        const clearBtn = document.getElementById('continueClearBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                if (!confirm('Clear your Continue Playing history?')) return;
                try {
                    // updateProfile whitelists avatar/bio/wallpaper/accent/showcase.
                    // We need a direct Firestore write for recentPlays.
                    const db = ArcadeAuth.getDb();
                    const uid = ArcadeAuth.getUser()?.uid;
                    if (db && uid) {
                        await db.collection('users').doc(uid).update({ recentPlays: [] });
                        renderContinuePlaying();
                    }
                } catch (e) { alert('Clear failed: ' + e.message); }
            });
        }
    }

    function setupActiveUsersBar() {
        const bar = document.getElementById('activeUsersBar');
        const textEl = document.getElementById('activeUsersText');
        if (!bar || !textEl) return;

        // Insert expand caret + detail panel
        let caret = bar.querySelector('.active-users-caret');
        if (!caret) {
            caret = document.createElement('span');
            caret.className = 'active-users-caret';
            caret.innerHTML = '&#9662;'; // ▾
            bar.appendChild(caret);
        }
        bar.classList.add('active-users-bar-interactive');

        let panel = document.getElementById('activeUsersPanel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'activeUsersPanel';
            panel.className = 'active-users-panel';
            panel.style.display = 'none';
            bar.insertAdjacentElement('afterend', panel);
        }

        let latestUsers = [];
        let expanded = false;

        function renderPanel() {
            if (!latestUsers.length) {
                panel.innerHTML = '<div class="active-users-empty">Nobody else is online right now.</div>';
                return;
            }
            const self = ArcadeAuth.getUser()?.uid;
            // Users with a currentGame first, then the rest
            const sorted = latestUsers.slice().sort((a, b) => {
                if (!!b.currentGame - !!a.currentGame) return !!b.currentGame - !!a.currentGame;
                return (a.username || '').localeCompare(b.username || '');
            });
            let html = '';
            for (const u of sorted) {
                const isSelf = u.uid === self;
                const game = u.currentGame ? getGameById(u.currentGame) : null;
                const status = game
                    ? `<span class="active-users-playing">Playing <a class="active-users-game" href="play.html?game=${encodeURIComponent(u.currentGame)}">${esc(game.title)}</a></span>`
                    : '<span class="active-users-idle">Browsing</span>';
                html += `<div class="active-users-row${isSelf ? ' is-self' : ''}">
                    <span class="active-users-dot active-users-dot-small"></span>
                    <span class="active-users-name" data-open-profile-uid="${esc(u.uid)}" role="button" tabindex="0">${esc(u.username || 'unknown')}${isSelf ? ' <span class="active-users-you">(you)</span>' : ''}</span>
                    ${status}
                </div>`;
            }
            panel.innerHTML = html;
        }

        bar.addEventListener('click', () => {
            expanded = !expanded;
            panel.style.display = expanded ? 'block' : 'none';
            caret.classList.toggle('expanded', expanded);
            if (expanded) renderPanel();
        });

        if (ArcadeAuth.listenActiveUsersDetailed) {
            ArcadeAuth.listenActiveUsersDetailed((users) => {
                latestUsers = users;
                textEl.textContent = `${users.length} active user${users.length !== 1 ? 's' : ''}`;
                // Count of users currently playing something
                const playing = users.filter(u => u.currentGame).length;
                if (playing > 0) {
                    textEl.textContent += ` · ${playing} playing`;
                }
                if (expanded) renderPanel();
            });
        } else if (ArcadeAuth.listenActiveUsers) {
            // Fallback for older code paths
            ArcadeAuth.listenActiveUsers((count) => {
                textEl.textContent = `${count} active user${count !== 1 ? 's' : ''}`;
            });
        }
    }

    // ===== PWA: service worker + install prompt =====
    // Registers the worker on first visit, captures the beforeinstallprompt
    // event so we can show our own install button in the header.
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch((e) => {
                console.warn('SW register failed:', e);
            });
        });
    }

    let deferredInstallPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        showInstallButton();
    });
    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        const btn = document.getElementById('pwaInstallBtn');
        if (btn) btn.remove();
    });

    function showInstallButton() {
        if (document.getElementById('pwaInstallBtn')) return;
        const header = document.querySelector('.header-content');
        if (!header) return;
        const btn = document.createElement('button');
        btn.id = 'pwaInstallBtn';
        btn.className = 'pwa-install-btn';
        btn.title = 'Install Arcade as an app';
        btn.innerHTML = '&#128229; Install';
        btn.addEventListener('click', async () => {
            if (!deferredInstallPrompt) return;
            deferredInstallPrompt.prompt();
            try {
                const { outcome } = await deferredInstallPrompt.userChoice;
                if (outcome === 'accepted') btn.remove();
            } catch {}
            deferredInstallPrompt = null;
        });
        const authArea = header.querySelector('.auth-area');
        if (authArea) header.insertBefore(btn, authArea);
        else header.appendChild(btn);
    }

    buildPartNav();
    init();
})();
