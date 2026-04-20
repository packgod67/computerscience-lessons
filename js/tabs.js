(function () {
    const tabBar = document.getElementById('tabBar');
    const gamesView = document.getElementById('gamesView');
    const usersView = document.getElementById('usersView');
    const galleryView = document.getElementById('galleryView');
    const chatView = document.getElementById('chatView');
    const messagesView = document.getElementById('messagesView');
    const savesView = document.getElementById('savesView');
    const requestsView = document.getElementById('requestsView');
    const banView = document.getElementById('banView');
    const cheatsView = document.getElementById('cheatsView');

    const views = {
        games: gamesView,
        users: usersView,
        gallery: galleryView,
        chat: chatView,
        messages: messagesView,
        saves: savesView,
        requests: requestsView,
        ban: banView,
        cheats: cheatsView,
    };
    let activeTab = 'games';
    let usersLoaded = false;
    let galleryLoaded = false;
    let chatLoaded = false;
    let banLoaded = false;
    let cheatsLoaded = false;
    let messagesLoaded = false;
    let savesLoaded = false;
    let requestsLoaded = false;

    // Add admin-only tabs after auth is ready
    ArcadeAuth.waitForAuth().then(() => {
        if (ArcadeAuth.isAdmin()) {
            const banBtn = document.createElement('button');
            banBtn.className = 'tab-btn tab-btn-ban';
            banBtn.dataset.tab = 'ban';
            banBtn.textContent = 'Bans';
            tabBar.appendChild(banBtn);

            const cheatsBtn = document.createElement('button');
            cheatsBtn.className = 'tab-btn tab-btn-cheats';
            cheatsBtn.dataset.tab = 'cheats';
            cheatsBtn.innerHTML = '&#128299; Cheats'; // 🔫
            cheatsBtn.title = 'Cheat code manager (admin only)';
            tabBar.appendChild(cheatsBtn);
        }
    });

    tabBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        const tab = btn.dataset.tab;
        if (tab === activeTab) return;

        tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // On mobile, make sure the just-tapped tab is fully visible.
        // If it was partly off-screen (e.g. "Bans" peeking from the right),
        // this smoothly scrolls it into view inside the scrollable tab bar.
        if (typeof btn.scrollIntoView === 'function') {
            btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }

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
        if (tab === 'cheats' && !cheatsLoaded && window.ArcadeCheats) {
            ArcadeCheats.renderCheatsView();
            cheatsLoaded = true;
        }
        if (tab === 'messages' && !messagesLoaded && window.ArcadeMessages) {
            ArcadeMessages.renderMessagesView();
            messagesLoaded = true;
        }
        if (tab === 'saves' && !savesLoaded && window.ArcadeSaves) {
            ArcadeSaves.renderSavesView();
            savesLoaded = true;
        }
        if (tab === 'requests' && !requestsLoaded && window.ArcadeRequests) {
            ArcadeRequests.renderRequestsView();
            requestsLoaded = true;
        }
    });
})();
