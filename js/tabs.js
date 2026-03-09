(function () {
    const tabBar = document.getElementById('tabBar');
    const gamesView = document.getElementById('gamesView');
    const usersView = document.getElementById('usersView');
    const galleryView = document.getElementById('galleryView');
    const chatView = document.getElementById('chatView');
    const banView = document.getElementById('banView');

    const views = { games: gamesView, users: usersView, gallery: galleryView, chat: chatView, ban: banView };
    let activeTab = 'games';
    let usersLoaded = false;
    let galleryLoaded = false;
    let chatLoaded = false;
    let banLoaded = false;

    // Add Ban tab for admin after auth is ready
    ArcadeAuth.waitForAuth().then(() => {
        if (ArcadeAuth.isAdmin()) {
            const banBtn = document.createElement('button');
            banBtn.className = 'tab-btn tab-btn-ban';
            banBtn.dataset.tab = 'ban';
            banBtn.textContent = 'Bans';
            tabBar.appendChild(banBtn);
        }
    });

    tabBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        const tab = btn.dataset.tab;
        if (tab === activeTab) return;

        tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        Object.values(views).forEach(v => { if (v) v.style.display = 'none'; });
        if (views[tab]) views[tab].style.display = '';
        activeTab = tab;

        if (tab === 'users' && !usersLoaded && window.ArcadeUsers) {
            ArcadeUsers.renderUsersView();
            usersLoaded = true;
        }
        if (tab === 'gallery' && !galleryLoaded && window.ArcadeGallery) {
            ArcadeGallery.renderGalleryView();
            galleryLoaded = true;
        }
        if (tab === 'chat' && !chatLoaded && window.ArcadeChat) {
            ArcadeChat.init();
            chatLoaded = true;
        }
        if (tab === 'ban' && !banLoaded && window.ArcadeUsers) {
            ArcadeUsers.renderBanView();
            banLoaded = true;
        }
    });
})();
