// ===== Profile System =====
// Steam-style profile modal: avatar, bio, wallpaper, showcase, recently played,
// favorite games, join date. Any username in the app can be clicked to open
// the target user's profile. The profile owner sees an Edit button.
(function () {
    let gamesIndex = null; // id -> game object, loaded lazily
    let rolesMap = {};     // id -> role, cached while modal is open

    // Public: open profile for a uid. Fetches latest data then renders.
    async function openProfile(uid) {
        if (!uid) return;
        closeModal();

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay profile-modal-overlay';
        overlay.id = 'profileModal';
        overlay.innerHTML = '<div class="profile-modal-loading">Loading profile…</div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        // Load profile + games index + roles + presence (currently playing) in parallel
        const [profile, _games, _roles, presence] = await Promise.all([
            ArcadeAuth.getProfile(uid),
            ensureGamesIndex(),
            ensureRolesMap(),
            fetchPresence(uid),
        ]);

        if (!profile) {
            overlay.innerHTML = '<div class="profile-modal-loading">User not found</div>';
            return;
        }
        profile.currentGame = presence && presence.currentGame;
        renderProfile(overlay, profile);
    }

    async function fetchPresence(uid) {
        try {
            const db = ArcadeAuth.getDb();
            if (!db) return null;
            const doc = await db.collection('presence').doc(uid).get();
            if (!doc.exists) return null;
            const data = doc.data();
            // Only count as "playing" if seen in last 2 minutes
            const ts = data.lastSeen && data.lastSeen.toMillis ? data.lastSeen.toMillis() : 0;
            if (Date.now() - ts > 2 * 60 * 1000) return null;
            return data;
        } catch (e) {
            return null;
        }
    }

    async function ensureGamesIndex() {
        if (gamesIndex) return gamesIndex;
        try {
            const res = await fetch('games/games.json');
            const list = await res.json();
            gamesIndex = {};
            list.forEach(g => { gamesIndex[g.id] = g; });
        } catch (e) {
            gamesIndex = {};
        }
        return gamesIndex;
    }

    async function ensureRolesMap() {
        try {
            const db = ArcadeAuth.getDb();
            if (!db) return rolesMap;
            const snap = await db.collection('roles').get();
            rolesMap = {};
            snap.docs.forEach(d => { rolesMap[d.id] = { id: d.id, ...d.data() }; });
        } catch (e) {}
        return rolesMap;
    }

    function formatJoinDate(ts) {
        if (!ts) return 'unknown';
        let d;
        if (ts.toDate) d = ts.toDate();
        else if (ts.seconds) d = new Date(ts.seconds * 1000);
        else if (typeof ts === 'number') d = new Date(ts);
        else d = new Date(ts);
        if (!d || isNaN(d.getTime())) return 'unknown';
        return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }

    function roleBadgesHTML(roleIds) {
        if (!roleIds || !roleIds.length) return '';
        return roleIds
            .map(id => rolesMap[id])
            .filter(Boolean)
            .sort((a, b) => (a.priority || 0) - (b.priority || 0))
            .map(r => `<span class="role-badge" style="background:${escape(r.color)}">${escape(r.name)}</span>`)
            .join('');
    }

    function topRoleColor(roleIds) {
        if (!roleIds || !roleIds.length) return null;
        let best = null;
        for (const id of roleIds) {
            const r = rolesMap[id];
            if (!r) continue;
            if (!best || (r.priority || 99) < (best.priority || 99)) best = r;
        }
        return best ? best.color : null;
    }

    function renderProfile(overlay, profile) {
        const currentUid = ArcadeAuth.getUser()?.uid;
        const isSelf = currentUid === profile.uid;
        const isAdmin = ArcadeAuth.isAdmin();

        // Color priority: admin/role color (if assigned) > user-picked
        // usernameColor > none. Role colors win to keep mod/admin badges
        // visually distinct.
        const roleColor = topRoleColor(profile.roleIds);
        const nameColor = roleColor || profile.usernameColor || null;
        const accent = profile.accent || nameColor || '';
        const accentStyle = accent ? `style="--profile-accent:${escape(accent)}"` : '';

        const wallpaperStyle = profile.wallpaper
            ? `style="background-image:url(${escape(profile.wallpaper)})"`
            : '';

        const avatarHTML = profile.avatar
            ? `<img class="profile-avatar-img" src="${escape(profile.avatar)}" alt="">`
            : `<div class="profile-avatar-placeholder">${escape((profile.username || '?').charAt(0).toUpperCase())}</div>`;

        const adminBadge = profile.role === 'admin'
            ? '<span class="role-badge role-badge-admin">ADMIN</span>' : '';
        const customBadges = roleBadgesHTML(profile.roleIds);

        const showcase = Array.isArray(profile.showcase) ? profile.showcase : [];
        const recent = Array.isArray(profile.recentPlays) ? profile.recentPlays : [];
        const favs = Array.isArray(profile.favorites) ? profile.favorites : [];

        const showcaseGames = showcase.map(id => gamesIndex[id]).filter(Boolean);
        const recentGames = recent.map(e => e && gamesIndex[e.gameId]).filter(Boolean);
        const favGames = favs.map(id => gamesIndex[id]).filter(Boolean).slice(0, 8);

        // Top 5 games by play count. playCounts is `{[gameId]: number}` —
        // see auth.js trackPlay(). Falls back to gracefully-empty when
        // the field doesn't exist yet (e.g. accounts created before this
        // shipped).
        const playCounts = (profile.playCounts && typeof profile.playCounts === 'object')
            ? profile.playCounts : {};
        const topByPlays = Object.entries(playCounts)
            .map(([id, count]) => ({ id, count, game: gamesIndex[id] }))
            .filter(x => x.game)
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        // Achievements unlocked by this user. Definitions live in
        // js/achievements.js — we render badges inline here.
        const unlocked = Array.isArray(profile.achievements) ? profile.achievements : [];
        const achievementDefs = (window.ArcadeAchievements?.byIds?.(unlocked)) || [];

        const nameStyle = nameColor ? `style="color:${escape(nameColor)}"` : '';

        const badgesHTML = (adminBadge || customBadges)
            ? `<span class="profile-badges">${adminBadge}${customBadges}</span>`
            : '';

        // BGM audio: if the profile has a BGM URL set, mount an <audio>
        // element + a mute toggle. Default volume is intentionally low
        // (0.25) so it's not jarring when opening a profile. Stored
        // mute state in localStorage so users who hate BGM globally
        // stay muted across sessions.
        const bgmMuted = localStorage.getItem('arcade-profile-bgm-muted') === '1';
        const bgmHtml = profile.profileBgm ? `
            <audio id="profileBgmAudio" loop autoplay ${bgmMuted ? 'muted' : ''} style="display:none;">
                <source src="${escape(profile.profileBgm)}">
            </audio>
            <button class="profile-bgm-toggle" id="profileBgmToggle" type="button" title="Toggle profile background music">
                ${bgmMuted ? '\u{1F507}' : '\u{1F50A}'}
            </button>
        ` : '';

        overlay.innerHTML = `
            <div class="profile-modal" ${accentStyle}>
                <button class="modal-close profile-close" id="closeProfileModal">&times;</button>
                ${bgmHtml}
                <div class="profile-header" ${wallpaperStyle}>
                    <div class="profile-header-overlay"></div>
                </div>
                <div class="profile-identity">
                    <div class="profile-avatar">${avatarHTML}</div>
                    <div class="profile-name" ${nameStyle}><span>${escape(profile.username || 'unknown')}</span>${badgesHTML}</div>
                    <div class="profile-meta">
                        <span>Joined ${formatJoinDate(profile.joinedAt)}</span>
                        <span>·</span>
                        <span>${favs.length} favorite${favs.length === 1 ? '' : 's'}</span>
                    </div>
                    ${isSelf
                        ? '<button class="profile-edit-btn" id="editProfileBtn">Edit profile</button>'
                        : '<button class="profile-edit-btn profile-message-btn" id="profileMessageBtn">&#128172; Message</button>'
                    }
                </div>
                <div class="profile-body">
                    ${profile.currentGame && gamesIndex[profile.currentGame] ? `
                    <div class="profile-playing-now">
                        <span class="profile-playing-dot"></span>
                        Currently playing
                        <a class="profile-playing-link" href="play.html?game=${encodeURIComponent(profile.currentGame)}">${escape(gamesIndex[profile.currentGame].title)}</a>
                    </div>` : ''}

                    ${profile.bio ? `<div class="profile-section">
                        <h3 class="profile-section-title">About</h3>
                        <p class="profile-bio">${escape(profile.bio)}</p>
                    </div>` : (isSelf ? '<div class="profile-bio-empty">Add a bio in Edit profile →</div>' : '')}

                    ${(Array.isArray(profile.widgets) && profile.widgets.length) || isSelf ? `
                    <div class="profile-section profile-widgets-section">
                        <div class="profile-widgets-header">
                            <h3 class="profile-section-title">Widgets</h3>
                            ${isSelf ? `<div class="profile-widgets-actions">
                                <button class="profile-widget-btn" id="profileWidgetAddImage" type="button">+ Image</button>
                                <button class="profile-widget-btn" id="profileWidgetAddText" type="button">+ Text</button>
                                <button class="profile-widget-btn profile-widget-btn-secondary" id="profileWidgetAddUrl" type="button" title="Paste an image URL instead">+ URL</button>
                                <button class="profile-widget-btn profile-widget-btn-secondary" id="profileWidgetEditToggle" type="button">Edit</button>
                            </div>` : ''}
                        </div>
                        <div class="profile-widgets-canvas" id="profileWidgetsCanvas" data-self="${isSelf?'1':'0'}">
                            <!-- widgets rendered by ArcadeProfileWidgets after innerHTML mount -->
                        </div>
                    </div>` : ''}

                    ${showcaseGames.length ? `<div class="profile-section">
                        <h3 class="profile-section-title">Showcase</h3>
                        <div class="profile-game-grid profile-game-grid-lg">
                            ${showcaseGames.map(gameCardHTML).join('')}
                        </div>
                    </div>` : ''}

                    ${topByPlays.length ? `<div class="profile-section">
                        <h3 class="profile-section-title">Top games</h3>
                        <div class="profile-top-games">
                            ${topByPlays.map((entry, i) => {
                                const g = entry.game;
                                const thumb = g.thumbnail
                                    ? `<img class="profile-top-thumb" src="${escape(g.thumbnail)}" alt="">`
                                    : `<div class="profile-top-thumb profile-top-thumb-placeholder">${escape((g.title || '?').charAt(0).toUpperCase())}</div>`;
                                return `<a class="profile-top-card" href="play.html?game=${encodeURIComponent(g.id)}" title="${escape(g.title)} — ${entry.count} play${entry.count===1?'':'s'}">
                                    <span class="profile-top-rank">#${i + 1}</span>
                                    ${thumb}
                                    <span class="profile-top-title">${escape(g.title || g.id)}</span>
                                    <span class="profile-top-count">${entry.count} play${entry.count===1?'':'s'}</span>
                                </a>`;
                            }).join('')}
                        </div>
                    </div>` : ''}

                    ${achievementDefs.length ? `<div class="profile-section">
                        <h3 class="profile-section-title">Achievements (${achievementDefs.length})</h3>
                        <div class="profile-achievements">
                            ${achievementDefs.map(a => `
                                <div class="profile-ach" title="${escape(a.title)} — ${escape(a.desc)}">
                                    <span class="profile-ach-icon">${a.icon || '\u{1F3C6}'}</span>
                                    <span class="profile-ach-name">${escape(a.title)}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>` : ''}

                    ${(!isSelf && ArcadeAuth.isLoggedIn() && window.ArcadeFriends) ? `<div class="profile-section">
                        <div id="profileFriendBtnSlot" data-target-uid="${escape(profile.uid)}"></div>
                    </div>` : ''}

                    ${favGames.length ? `<div class="profile-section">
                        <h3 class="profile-section-title">Favorites${favs.length > 8 ? ` (${favs.length})` : ''}</h3>
                        <div class="profile-game-grid">
                            ${favGames.map(gameCardHTML).join('')}
                        </div>
                    </div>` : ''}
                </div>
            </div>`;

        // BGM toggle wiring
        const bgmAudio = document.getElementById('profileBgmAudio');
        const bgmToggle = document.getElementById('profileBgmToggle');
        if (bgmAudio && bgmToggle) {
            // Set volume to be unobtrusive
            bgmAudio.volume = 0.25;
            bgmToggle.addEventListener('click', () => {
                bgmAudio.muted = !bgmAudio.muted;
                bgmToggle.textContent = bgmAudio.muted ? '\u{1F507}' : '\u{1F50A}';
                try { localStorage.setItem('arcade-profile-bgm-muted', bgmAudio.muted ? '1' : '0'); } catch {}
                if (!bgmAudio.muted) bgmAudio.play().catch(() => {});
            });
            // Stop audio when modal closes (handled by closeModal removing the overlay)
        }

        // Render the friend request/accept/remove button into its slot
        // if friends.js is loaded and we're viewing someone else's profile.
        const friendSlot = document.getElementById('profileFriendBtnSlot');
        if (friendSlot && window.ArcadeFriends?.renderFriendButton) {
            try { window.ArcadeFriends.renderFriendButton(friendSlot, profile.uid); } catch {}
        }

        // Mount the profile widgets canvas. The canvas is interactive
        // (drag/resize/delete) for the owner and read-only for visitors.
        const widgetsCanvas = document.getElementById('profileWidgetsCanvas');
        if (widgetsCanvas && window.ArcadeProfileWidgets) {
            try {
                window.ArcadeProfileWidgets.mount(widgetsCanvas, profile, isSelf);
            } catch (e) { console.warn('widgets mount failed', e); }
        }

        document.getElementById('closeProfileModal').addEventListener('click', closeModal);
        if (isSelf) {
            document.getElementById('editProfileBtn').addEventListener('click', () => {
                renderEditProfile(overlay, profile);
            });
        } else {
            const msgBtn = document.getElementById('profileMessageBtn');
            if (msgBtn) {
                msgBtn.addEventListener('click', () => {
                    if (!ArcadeAuth.isLoggedIn()) {
                        alert('Log in to send messages');
                        return;
                    }
                    closeModal();
                    if (window.ArcadeMessages && ArcadeMessages.openConversation) {
                        ArcadeMessages.openConversation(profile.uid);
                    }
                });
            }
        }
    }

    function gameCardHTML(g) {
        if (!g) return '';
        const thumb = g.thumbnail
            ? `<img class="profile-game-thumb" src="${escape(g.thumbnail)}" alt="">`
            : `<div class="profile-game-thumb profile-game-thumb-placeholder">${escape((g.title || '?').charAt(0).toUpperCase())}</div>`;
        return `<a class="profile-game-card" href="play.html?game=${encodeURIComponent(g.id)}">
            ${thumb}
            <span class="profile-game-title">${escape(g.title || g.id)}</span>
        </a>`;
    }

    // ===== Edit Profile =====

    function renderEditProfile(overlay, profile) {
        // Use favorites (which most users have populated) as the pool for showcase
        const favs = Array.isArray(profile.favorites) ? profile.favorites : [];
        const favGames = favs.map(id => gamesIndex[id]).filter(Boolean);

        let localAvatar = profile.avatar || '';
        let localWallpaper = profile.wallpaper || '';
        let localShowcase = Array.isArray(profile.showcase) ? profile.showcase.slice() : [];
        let localAccent = profile.accent || '';

        overlay.innerHTML = `
            <div class="profile-modal profile-modal-edit">
                <button class="modal-close profile-close" id="closeProfileEdit">&times;</button>
                <div class="profile-edit-header">
                    <h2>Edit profile</h2>
                </div>
                <div class="profile-edit-body">
                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Avatar</label>
                        <div class="profile-edit-avatar-area">
                            <div class="profile-avatar" id="avatarPreview"></div>
                            <div class="profile-edit-buttons">
                                <button class="profile-edit-action" id="changeAvatarBtn">Upload</button>
                                <button class="profile-edit-action" id="removeAvatarBtn">Remove</button>
                            </div>
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Wallpaper</label>
                        <div class="profile-edit-wallpaper-area">
                            <div class="profile-edit-wallpaper-preview" id="wallpaperPreview"></div>
                            <div class="profile-edit-buttons">
                                <button class="profile-edit-action" id="changeWallpaperBtn">Upload</button>
                                <button class="profile-edit-action" id="removeWallpaperBtn">Remove</button>
                            </div>
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="bioInput">Bio</label>
                        <textarea id="bioInput" class="profile-edit-bio" maxlength="500" placeholder="Tell the arcade about yourself (500 char max)">${escape(profile.bio || '')}</textarea>
                        <div class="profile-edit-hint"><span id="bioCount">${(profile.bio || '').length}</span>/500</div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="accentInput">Accent color</label>
                        <div class="profile-edit-accent-area">
                            <input type="color" id="accentInput" value="${escape(localAccent || '#7c3aed')}" class="profile-edit-accent-input">
                            <button class="profile-edit-action" id="clearAccentBtn">Use theme</button>
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="usernameColorInput">Username color</label>
                        <div class="profile-edit-accent-area">
                            <input type="color" id="usernameColorInput" value="${escape(profile.usernameColor || '#7c3aed')}" class="profile-edit-accent-input">
                            <button class="profile-edit-action" id="clearUsernameColorBtn">Default</button>
                        </div>
                        <span class="profile-edit-hint">Role badges still override your username color.</span>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="bgmInput">Profile background music</label>
                        <input type="url" id="bgmInput" class="profile-edit-bio" placeholder="https://… direct mp3 / ogg / m4a URL (leave blank for none)" value="${escape(profile.profileBgm || '')}" style="min-height:auto;height:38px;padding:6px 10px;">
                        <span class="profile-edit-hint">Plays softly when others view your profile. Visitors can mute.</span>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Showcase <span class="profile-edit-hint">(up to 5, picked from your favorites)</span></label>
                        <div class="profile-edit-showcase-grid" id="showcaseGrid"></div>
                        ${favGames.length === 0 ? '<div class="profile-bio-empty">Favorite some games first to pick them for your showcase.</div>' : ''}
                    </div>

                    <div class="profile-edit-footer">
                        <button class="profile-edit-cancel" id="cancelEditBtn">Cancel</button>
                        <button class="profile-edit-save" id="saveProfileBtn">Save changes</button>
                    </div>
                </div>
            </div>`;

        const avatarPreview = document.getElementById('avatarPreview');
        const wallpaperPreview = document.getElementById('wallpaperPreview');
        const showcaseGrid = document.getElementById('showcaseGrid');

        function renderAvatar() {
            if (localAvatar) {
                avatarPreview.innerHTML = `<img class="profile-avatar-img" src="${escape(localAvatar)}" alt="">`;
            } else {
                avatarPreview.innerHTML = `<div class="profile-avatar-placeholder">${escape((profile.username || '?').charAt(0).toUpperCase())}</div>`;
            }
        }
        function renderWallpaper() {
            if (localWallpaper) {
                wallpaperPreview.style.backgroundImage = `url(${localWallpaper})`;
                wallpaperPreview.classList.remove('empty');
            } else {
                wallpaperPreview.style.backgroundImage = '';
                wallpaperPreview.classList.add('empty');
                wallpaperPreview.textContent = 'No wallpaper';
            }
        }
        function renderShowcase() {
            showcaseGrid.innerHTML = favGames.map(g => {
                const picked = localShowcase.includes(g.id);
                const thumb = g.thumbnail
                    ? `<img class="profile-game-thumb" src="${escape(g.thumbnail)}" alt="">`
                    : `<div class="profile-game-thumb profile-game-thumb-placeholder">${escape((g.title || '?').charAt(0).toUpperCase())}</div>`;
                return `<button type="button" class="profile-edit-showcase-item${picked ? ' picked' : ''}" data-id="${escape(g.id)}">
                    ${thumb}
                    <span class="profile-game-title">${escape(g.title || g.id)}</span>
                </button>`;
            }).join('');
            showcaseGrid.querySelectorAll('.profile-edit-showcase-item').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = btn.dataset.id;
                    const idx = localShowcase.indexOf(id);
                    if (idx >= 0) {
                        localShowcase.splice(idx, 1);
                    } else if (localShowcase.length < 5) {
                        localShowcase.push(id);
                    } else {
                        return; // cap
                    }
                    renderShowcase();
                });
            });
        }

        renderAvatar();
        renderWallpaper();
        renderShowcase();

        // Bio live count
        const bioInput = document.getElementById('bioInput');
        const bioCount = document.getElementById('bioCount');
        bioInput.addEventListener('input', () => {
            bioCount.textContent = bioInput.value.length;
        });

        // Upload handlers
        document.getElementById('changeAvatarBtn').addEventListener('click', async () => {
            const data = await promptImageUpload(256, 256, 0.7, 120 * 1024);
            if (data) { localAvatar = data; renderAvatar(); }
        });
        document.getElementById('removeAvatarBtn').addEventListener('click', () => {
            localAvatar = ''; renderAvatar();
        });
        document.getElementById('changeWallpaperBtn').addEventListener('click', async () => {
            const data = await promptImageUpload(1024, 512, 0.55, 500 * 1024);
            if (data) { localWallpaper = data; renderWallpaper(); }
        });
        document.getElementById('removeWallpaperBtn').addEventListener('click', () => {
            localWallpaper = ''; renderWallpaper();
        });
        document.getElementById('clearAccentBtn').addEventListener('click', () => {
            localAccent = '';
            document.getElementById('accentInput').value = '#7c3aed';
        });
        let localUsernameColor = profile.usernameColor || '';
        document.getElementById('usernameColorInput')?.addEventListener('input', (e) => {
            localUsernameColor = e.target.value;
        });
        document.getElementById('clearUsernameColorBtn')?.addEventListener('click', () => {
            localUsernameColor = '';
            const inp = document.getElementById('usernameColorInput');
            if (inp) inp.value = '#7c3aed';
        });

        document.getElementById('closeProfileEdit').addEventListener('click', closeModal);
        document.getElementById('cancelEditBtn').addEventListener('click', () => {
            renderProfile(overlay, profile);
        });
        document.getElementById('saveProfileBtn').addEventListener('click', async () => {
            const saveBtn = document.getElementById('saveProfileBtn');
            saveBtn.textContent = 'Saving…';
            saveBtn.disabled = true;
            try {
                const accentRaw = document.getElementById('accentInput').value;
                const accent = localAccent === '' ? '' : accentRaw;
                const bgmUrl = (document.getElementById('bgmInput')?.value || '').trim();
                await ArcadeAuth.updateProfile({
                    usernameColor: localUsernameColor,
                    profileBgm: bgmUrl,
                    avatar: localAvatar,
                    wallpaper: localWallpaper,
                    bio: bioInput.value.trim().slice(0, 500),
                    accent: accent,
                    showcase: localShowcase,
                });
                // Refetch so we see fresh data, then re-render
                const fresh = await ArcadeAuth.getProfile(profile.uid);
                renderProfile(overlay, fresh || profile);
            } catch (e) {
                alert('Save failed: ' + e.message);
                saveBtn.textContent = 'Save changes';
                saveBtn.disabled = false;
            }
        });
    }

    // Prompt for image upload, resize, return base64 data URL within sizeLimit bytes (approx).
    //
    // Special-cases ANIMATED formats (GIF, WebP, APNG): drawing them onto
    // a canvas freezes the animation to the first frame. To preserve
    // motion, we keep the original file as-is when it's an animated type
    // — but then we have no compression budget, so the size cap is
    // enforced by rejecting files over `sizeLimit`. Static images get
    // the existing canvas resize + JPEG re-encode.
    function promptImageUpload(maxW, maxH, quality, sizeLimit) {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            // Accept GIF/WebP/APNG explicitly so the OS file picker
            // surfaces them; image/* would too but being explicit is
            // friendlier on some Android pickers.
            input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/apng,image/*';
            input.addEventListener('change', async () => {
                const file = input.files[0];
                if (!file) { resolve(null); return; }
                const isAnimated = /^image\/(gif|webp|apng)$/i.test(file.type);
                try {
                    if (isAnimated) {
                        // Reject if larger than ~1.5x sizeLimit raw —
                        // even a 1MB animated avatar would bloat the user
                        // doc significantly. 1.5x because base64 is ~1.37x
                        // larger than raw bytes.
                        if (file.size > sizeLimit * 1.5) {
                            alert('Animated image is too large (' + Math.round(file.size / 1024) + ' KB). Please use a smaller GIF/WebP or a static PNG/JPG.');
                            resolve(null);
                            return;
                        }
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result));
                        reader.onerror = () => { alert('Failed to read image'); resolve(null); };
                        reader.readAsDataURL(file);
                        return;
                    }
                    let q = quality;
                    let out = await resizeImage(file, maxW, maxH, q);
                    while (out.length > sizeLimit * 1.37 && q > 0.2) {
                        q -= 0.1;
                        out = await resizeImage(file, maxW, maxH, q);
                    }
                    resolve(out);
                } catch (e) {
                    alert('Failed to process image');
                    resolve(null);
                }
            });
            input.click();
        });
    }

    function resizeImage(file, maxW, maxH, quality) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    let w = img.width, h = img.height;
                    if (w > maxW || h > maxH) {
                        const scale = Math.min(maxW / w, maxH / h);
                        w = Math.round(w * scale);
                        h = Math.round(h * scale);
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                };
                img.onerror = reject;
                img.src = reader.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function closeModal() {
        const existing = document.getElementById('profileModal');
        if (existing) existing.remove();
    }

    // Escape HTML
    function escape(s) {
        if (s === undefined || s === null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Convenience: open by username (requires users to already be loaded via ArcadeUsers)
    async function openProfileByUsername(username) {
        if (!username) return;
        try {
            const db = ArcadeAuth.getDb();
            const snap = await db.collection('usernames').doc(username.toLowerCase().trim()).get();
            if (snap.exists && snap.data().uid) {
                openProfile(snap.data().uid);
            }
        } catch (e) {
            console.error('lookup by username failed:', e);
        }
    }

    window.ArcadeProfile = {
        openProfile,
        openProfileByUsername,
    };

    // ===== Delegated click handler =====
    // Any element with data-open-profile-uid or data-open-profile-username will
    // open the matching profile when clicked.
    document.addEventListener('click', (e) => {
        const uidEl = e.target.closest('[data-open-profile-uid]');
        if (uidEl) {
            e.preventDefault();
            e.stopPropagation();
            openProfile(uidEl.dataset.openProfileUid);
            return;
        }
        const nameEl = e.target.closest('[data-open-profile-username]');
        if (nameEl) {
            e.preventDefault();
            e.stopPropagation();
            openProfileByUsername(nameEl.dataset.openProfileUsername);
        }
    });
})();
