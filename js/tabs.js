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
    const friendsView = document.getElementById('friendsView');
    const cataloghealthView = document.getElementById('cataloghealthView');

    const views = {
        games: gamesView,
        users: usersView,
        gallery: galleryView,
        chat: chatView,
        messages: messagesView,
        friends: friendsView,
        saves: savesView,
        requests: requestsView,
        ban: banView,
        cheats: cheatsView,
        cataloghealth: cataloghealthView,
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
    let friendsLoaded = false;

    // Honor user-customized tab order + visibility (settings.js).
    // Reorders the .tab-btn children of #tabBar to match `tabOrder` and
    // hides ones in `tabHidden`. Re-runs on every settings change.
    function applyTabSettings() {
        const settings = window.ArcadeSettings?.get?.();
        if (!settings) return;
        const order = settings.tabOrder || [];
        const hidden = new Set(settings.tabHidden || []);
        const allBtns = Array.from(tabBar.querySelectorAll('.tab-btn'));
        // Sort by index in user's order; unknown ids go to the end in their
        // original DOM order.
        const idxOf = (id) => {
            const i = order.indexOf(id);
            return i === -1 ? 1e6 : i;
        };
        allBtns.sort((a, b) => idxOf(a.dataset.tab) - idxOf(b.dataset.tab));
        for (const btn of allBtns) {
            tabBar.appendChild(btn);
            btn.dataset.tabHidden = hidden.has(btn.dataset.tab) ? '1' : '0';
        }
    }
    window.addEventListener('arcade:settings-changed', applyTabSettings);

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

            const chBtn = document.createElement('button');
            chBtn.className = 'tab-btn tab-btn-cataloghealth';
            chBtn.dataset.tab = 'cataloghealth';
            chBtn.innerHTML = '&#129514; Health'; // 🧪
            chBtn.title = 'Catalog health dashboard (admin only)';
            tabBar.appendChild(chBtn);
        }
        // Apply user-customized order/visibility AFTER admin tabs are added
        // (so admins can reorder/hide Bans + Cheats too if they want).
        applyTabSettings();
    });
    // Apply once on boot for non-admin users (admin path covers admins).
    applyTabSettings();

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
        if (tab === 'friends' && window.ArcadeFriends) {
            // Always re-render — feed is time-sensitive
            ArcadeFriends.renderFriendsView();
            friendsLoaded = true;
        }
        if (tab === 'cataloghealth' && window.ArcadeCatalogHealth) {
            ArcadeCatalogHealth.renderCatalogHealthView();
        }
    });
})();
