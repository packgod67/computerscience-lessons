(function () {
    const gameGrid = document.getElementById('gameGrid');
    const searchInput = document.getElementById('search');
    const categoriesContainer = document.getElementById('categories');
    const emptyState = document.getElementById('emptyState');
    const gameCount = document.getElementById('gameCount');

    let games = [];
    let filtered = [];
    let activeCategory = 'all';
    let currentPage = 0;
    const PAGE_SIZE = 36;
    let loading = false;
    let favBtnEl = null; // Favorites category button

    async function init() {
        try {
            const res = await fetch('games/games.json');
            games = await res.json();
        } catch {
            games = [];
        }
        buildCategories();
        applyFilters();
        renderPage();

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
    }

    function updateCategoryButtons() {
        categoriesContainer.querySelectorAll('.cat-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.category === activeCategory);
        });
    }

    function applyFilters() {
        const query = searchInput.value.toLowerCase().trim();
        filtered = games.filter(g => {
            const matchesSearch = !query || g.title.toLowerCase().includes(query);
            let matchesCategory;
            if (activeCategory === '__favorites__') {
                matchesCategory = ArcadeAuth.isFavorite(g.id);
            } else if (activeCategory === '__popular__') {
                matchesCategory = !!g.popular;
            } else {
                matchesCategory = activeCategory === 'all' || g.category === activeCategory;
            }
            return matchesSearch && matchesCategory;
        });
        if (gameCount) {
            gameCount.textContent = `${filtered.length} game${filtered.length !== 1 ? 's' : ''}`;
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
                ? `<img class="card-thumbnail" src="${esc(g.thumbnail)}" alt="${esc(g.title)}" loading="lazy">`
                : `<div class="card-thumbnail-placeholder"><span>${esc(g.title.charAt(0).toUpperCase())}</span></div>`;
            const favClass = loggedIn && ArcadeAuth.isFavorite(g.id) ? ' fav-active' : '';
            const favBtn = loggedIn
                ? `<button class="fav-btn${favClass}" data-game-id="${esc(g.id)}" title="Favorite">&#9733;</button>`
                : '';
            const infoBtn = g.description
                ? `<button class="info-btn" data-game-idx="${start + i}" title="Game info">&#8942;</button>`
                : '';
            html += `<a class="game-card" href="play.html?game=${encodeURIComponent(g.id)}">${thumb}${favBtn}${infoBtn}<div class="card-body"><span class="card-category">${esc(g.category)}</span><h3 class="card-title">${esc(g.title)}</h3></div></a>`;
        }

        gameGrid.insertAdjacentHTML('beforeend', html);
        loading = false;
    }

    function esc(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function debounce(fn, ms) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }

    function showGameInfo(g) {
        const existing = document.getElementById('gameInfoOverlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'gameInfoOverlay';
        overlay.className = 'game-info-overlay';

        const thumb = g.thumbnail
            ? `<img class="game-info-thumb" src="${esc(g.thumbnail)}" alt="${esc(g.title)}">`
            : '';

        overlay.innerHTML = `
            <div class="game-info-modal">
                <button class="game-info-close">&times;</button>
                ${thumb}
                <h2 class="game-info-title">${esc(g.title)}</h2>
                <span class="game-info-category">${esc(g.category)}</span>
                <p class="game-info-desc">${esc(g.description)}</p>
                <a class="game-info-play" href="play.html?game=${encodeURIComponent(g.id)}">Play Now</a>
            </div>`;

        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        overlay.querySelector('.game-info-close').addEventListener('click', () => overlay.remove());
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

    buildPartNav();
    init();
})();
