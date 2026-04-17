(function () {
    const gameTitle = document.getElementById('gameTitle');
    const gameCategory = document.getElementById('gameCategory');
    const gameFrame = document.getElementById('gameFrame');
    const gameLoading = document.getElementById('gameLoading');
    const loadingText = document.getElementById('loadingText');
    const gameError = document.getElementById('gameError');
    const errorDetail = document.getElementById('errorDetail');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const playerContainer = document.getElementById('playerContainer');
    const favBtn = document.getElementById('favBtn');

    const LARGE_SIZE_MB = 30;
    let currentGameId = null;

    async function init() {
        const params = new URLSearchParams(window.location.search);
        const gameId = params.get('game');
        const forceLoad = params.get('force') === '1';
        currentGameId = gameId;

        // Record the play in the user's profile (fire-and-forget)
        if (gameId) {
            ArcadeAuth.waitForAuth().then(() => {
                if (ArcadeAuth.isLoggedIn() && ArcadeAuth.trackPlay) {
                    ArcadeAuth.trackPlay(gameId);
                }
            });
        }

        if (!gameId) {
            gameTitle.textContent = 'No game selected';
            gameLoading.innerHTML = '<p>No game specified. <a href="index.html" style="color: #7c3aed;">Go back to arcade</a></p>';
            return;
        }

        let games = [];
        try {
            const res = await fetch('games/games.json');
            games = await res.json();
        } catch {
            gameTitle.textContent = 'Error';
            gameLoading.innerHTML = '<p>Could not load game data.</p>';
            return;
        }

        const game = games.find(g => g.id === gameId);

        if (!game) {
            gameTitle.textContent = 'Game not found';
            gameLoading.innerHTML = `<p>Game "${gameId}" not found. <a href="index.html" style="color: #7c3aed;">Go back to arcade</a></p>`;
            return;
        }

        document.title = `${game.title} - Arcade`;
        gameTitle.textContent = game.title;
        gameCategory.textContent = game.category;

        // Check file size before loading
        let sizeMB = 0;
        try {
            const head = await fetch(game.path, { method: 'HEAD' });
            const size = parseInt(head.headers.get('content-length') || '0', 10);
            sizeMB = size / 1024 / 1024;
        } catch {
            // Can't determine size, load normally
        }

        // Large games — offer new tab (better performance) or iframe
        if (sizeMB > LARGE_SIZE_MB && !forceLoad) {
            showLargeGamePrompt(game, sizeMB, gameId);
            return;
        }

        loadGame(game, sizeMB);
    }

    function showLargeGamePrompt(game, sizeMB, gameId) {
        gameLoading.style.display = 'none';
        gameError.style.display = 'flex';
        errorDetail.textContent = `This game is ${sizeMB.toFixed(0)}MB. Large games run better in a new tab.`;

        const actions = gameError.querySelector('.error-actions');
        actions.innerHTML = '';

        const newTabBtn = document.createElement('a');
        newTabBtn.className = 'retry-btn';
        newTabBtn.href = game.path;
        newTabBtn.target = '_blank';
        newTabBtn.textContent = 'Open in new tab';
        actions.appendChild(newTabBtn);

        const iframeBtn = document.createElement('a');
        iframeBtn.className = 'retry-btn secondary';
        iframeBtn.href = `play.html?game=${encodeURIComponent(gameId)}&force=1`;
        iframeBtn.textContent = 'Load here (may crash)';
        actions.appendChild(iframeBtn);

        const backBtn = document.createElement('a');
        backBtn.className = 'retry-btn secondary';
        backBtn.href = 'index.html';
        backBtn.textContent = 'Back to Arcade';
        actions.appendChild(backBtn);
    }

    function loadGame(game, sizeMB) {
        if (sizeMB > 15) {
            loadingText.innerHTML = `Loading game... <span style="color:#f59e0b;">(${sizeMB.toFixed(0)}MB - this may take a while)</span>`;
        } else {
            loadingText.innerHTML = `Loading game... <span style="color:#888;">(some games download large assets and may take a minute)</span>`;
        }

        let loaded = false;
        const crashTimeout = setTimeout(() => {
            if (!loaded) {
                showError('The game is taking too long to load. Try opening it in a new tab for better performance.');
            }
        }, 300000);

        gameFrame.addEventListener('load', () => {
            loaded = true;
            clearTimeout(crashTimeout);
            gameLoading.classList.add('hidden');
        });

        gameFrame.addEventListener('error', () => {
            loaded = true;
            clearTimeout(crashTimeout);
            showError('The game file could not be loaded.');
        });

        gameFrame.src = game.path;
    }

    function showError(msg) {
        gameLoading.style.display = 'none';
        gameError.style.display = 'flex';
        errorDetail.textContent = msg;
    }

    // Fullscreen toggle
    fullscreenBtn.addEventListener('click', () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            playerContainer.requestFullscreen().catch(() => {
                gameFrame.requestFullscreen().catch(() => {});
            });
        }
    });

    // Favorite button on player page
    function updateFavBtn() {
        if (!favBtn || !currentGameId) return;
        if (!ArcadeAuth.isLoggedIn()) {
            favBtn.style.display = 'none';
            return;
        }
        favBtn.style.display = '';
        favBtn.classList.toggle('fav-active', ArcadeAuth.isFavorite(currentGameId));
    }

    favBtn.addEventListener('click', () => {
        if (!ArcadeAuth.isLoggedIn() || !currentGameId) return;
        ArcadeAuth.toggleFavorite(currentGameId).then(() => updateFavBtn());
    });

    // ===== Cloud Save Sync =====
    let saveStatusEl = null;

    function showSaveStatus(msg) {
        if (!saveStatusEl) {
            saveStatusEl = document.createElement('div');
            saveStatusEl.style.cssText = 'position:fixed;bottom:12px;right:12px;background:#1a1a2e;color:#aaa;padding:6px 14px;border-radius:8px;font-size:13px;z-index:9999;transition:opacity 0.3s;';
            document.body.appendChild(saveStatusEl);
        }
        saveStatusEl.textContent = msg;
        saveStatusEl.style.opacity = '1';
        clearTimeout(saveStatusEl._timer);
        saveStatusEl._timer = setTimeout(() => { saveStatusEl.style.opacity = '0'; }, 3000);
    }

    window.addEventListener('message', async (e) => {
        if (!e.data || !e.data.type) return;

        if (e.data.type === 'emu-ready' && e.data.gameId) {
            // Game emulator is ready — send cloud save if user is logged in
            await ArcadeAuth.waitForAuth();
            if (!ArcadeAuth.isLoggedIn()) {
                showSaveStatus('Not logged in — cloud save disabled');
                return;
            }
            showSaveStatus('Loading cloud save...');
            const data = await ArcadeAuth.loadGameData(e.data.gameId);
            if (data) {
                gameFrame.contentWindow.postMessage({ type: 'load-save', data: data }, '*');
                showSaveStatus('Cloud save loaded!');
            } else {
                showSaveStatus('No cloud save found — will create one');
            }
        }

        if (e.data.type === 'save-data' && e.data.gameId && e.data.data) {
            await ArcadeAuth.waitForAuth();
            if (!ArcadeAuth.isLoggedIn()) {
                showSaveStatus('Not logged in — save skipped');
                return;
            }
            showSaveStatus('Saving to cloud...');
            const ok = await ArcadeAuth.saveGameData(e.data.gameId, e.data.data);
            showSaveStatus(ok ? 'Saved to cloud!' : 'Cloud save failed');
        }
    });

    // Auth integration
    ArcadeAuth.bindAuthUI();
    ArcadeAuth.onAuthChange(() => updateFavBtn());
    ArcadeAuth.onFavoritesChange(() => updateFavBtn());

    init();
})();
