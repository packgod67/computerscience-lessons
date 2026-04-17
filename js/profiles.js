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

        const nameColor = topRoleColor(profile.roleIds);
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

        const nameStyle = nameColor ? `style="color:${escape(nameColor)}"` : '';

        const badgesHTML = (adminBadge || customBadges)
            ? `<span class="profile-badges">${adminBadge}${customBadges}</span>`
            : '';

        overlay.innerHTML = `
            <div class="profile-modal" ${accentStyle}>
                <button class="modal-close profile-close" id="closeProfileModal">&times;</button>
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
                        <span>·</span>
                        <span>${recent.length} played</span>
                    </div>
                    ${isSelf ? '<button class="profile-edit-btn" id="editProfileBtn">Edit profile</button>' : ''}
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

                    ${showcaseGames.length ? `<div class="profile-section">
                        <h3 class="profile-section-title">Showcase</h3>
                        <div class="profile-game-grid profile-game-grid-lg">
                            ${showcaseGames.map(gameCardHTML).join('')}
                        </div>
                    </div>` : ''}

                    ${recentGames.length ? `<div class="profile-section">
                        <h3 class="profile-section-title">Recently played</h3>
                        <div class="profile-game-grid">
                            ${recentGames.map(gameCardHTML).join('')}
                        </div>
                    </div>` : ''}

                    ${favGames.length ? `<div class="profile-section">
                        <h3 class="profile-section-title">Favorites${favs.length > 8 ? ` (${favs.length})` : ''}</h3>
                        <div class="profile-game-grid">
                            ${favGames.map(gameCardHTML).join('')}
                        </div>
                    </div>` : ''}
                </div>
            </div>`;

        document.getElementById('closeProfileModal').addEventListener('click', closeModal);
        if (isSelf) {
            document.getElementById('editProfileBtn').addEventListener('click', () => {
                renderEditProfile(overlay, profile);
            });
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
                await ArcadeAuth.updateProfile({
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

    // Prompt for image upload, resize, return base64 data URL within sizeLimit bytes (approx)
    function promptImageUpload(maxW, maxH, quality, sizeLimit) {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.addEventListener('change', async () => {
                const file = input.files[0];
                if (!file) { resolve(null); return; }
                try {
                    let q = quality;
                    let out = await resizeImage(file, maxW, maxH, q);
                    // If too big, keep shrinking quality
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
