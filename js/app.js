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
        }, 250));

        // Infinite scroll
        window.addEventListener('scroll', () => {
            if (loading) return;
            if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 800) {
                currentPage++;
                renderPage();
            }
        });
    }

    function buildCategories() {
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
            const matchesCategory = activeCategory === 'all' || g.category === activeCategory;
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

        // Build HTML string (faster than DOM creation for large lists)
        let html = '';
        for (let i = 0; i < pageGames.length; i++) {
            const g = pageGames[i];
            const thumb = g.thumbnail
                ? `<img class="card-thumbnail" src="${esc(g.thumbnail)}" alt="${esc(g.title)}" loading="lazy">`
                : `<div class="card-thumbnail-placeholder"><span>${esc(g.title.charAt(0).toUpperCase())}</span></div>`;
            html += `<a class="game-card" href="play.html?game=${encodeURIComponent(g.id)}">${thumb}<div class="card-body"><span class="card-category">${esc(g.category)}</span><h3 class="card-title">${esc(g.title)}</h3></div></a>`;
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

    // Build part navigation if ARCADE_PARTS config exists
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

    buildPartNav();
    init();
})();
