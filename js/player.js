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

    async function init() {
        const params = new URLSearchParams(window.location.search);
        const gameId = params.get('game');

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
        try {
            const head = await fetch(game.path, { method: 'HEAD' });
            const size = parseInt(head.headers.get('content-length') || '0', 10);
            const sizeMB = (size / 1024 / 1024).toFixed(1);

            if (size > 50 * 1024 * 1024) {
                loadingText.innerHTML = `Loading game... <span style="color:#f59e0b;">(${sizeMB}MB - this may take a while)</span>`;
            }
        } catch {
            // Ignore - just load normally
        }

        // Set a crash/timeout detection
        let loaded = false;
        const crashTimeout = setTimeout(() => {
            if (!loaded) {
                showError('The game is taking too long to load. It may be too large for your browser.');
            }
        }, 60000); // 60 second timeout

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

    init();
})();
