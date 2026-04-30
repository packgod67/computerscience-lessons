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

        // Profile-customization v2 fields. All optional; when absent the
        // profile renders the same as before. Each one drives a CSS class
        // or data-attribute on the modal root so styling is centralized.
        const tagline   = profile.tagline   || '';
        const status    = profile.status    || '';
        const frame     = profile.avatarFrame || 'none';     // none|glow|rainbow|gold|neon|glitch|snake
        const layout    = profile.layoutStyle || 'default';  // default|compact|magazine
        const bgEffect  = profile.bgEffect  || 'none';       // none|vignette|stars|swirl|scanlines|dust
        const borderStyle = profile.borderStyle || 'none';   // none|ornate|tape|circuit|ribbon
        const privacy   = profile.privacy || {};
        const artwork   = Array.isArray(profile.artwork) ? profile.artwork.slice(0, 4) : []; // up to 4 large showcase images

        // Profile-customization v3 fields
        const usernameEffect  = profile.usernameEffect  || 'none';
        const usernameGlow    = profile.usernameGlow    || '';
        const avatarAura      = profile.avatarAura      || 'none';
        const avatarAccessory = profile.avatarAccessory || 'none';
        const entryAnimation  = profile.entryAnimation  || 'none';
        const profileFont     = profile.profileFont     || 'system';
        const profileCursor   = profile.profileCursor   || 'default';
        const titleText       = profile.titleText       || '';
        const intoTags        = Array.isArray(profile.intoTags) ? profile.intoTags : [];
        const quoteWidget     = profile.quoteWidget     || '';
        const musicEmbed      = profile.musicEmbed      || '';

        // v4 fields
        const usernameFont    = profile.usernameFont    || '';
        const profileTheme    = profile.profileTheme    || '';
        const profilePet      = profile.profilePet      || 'none';
        const profileMiniGame = profile.miniGame        || 'none';
        const selectedTitle   = profile.selectedTitle   || '';
        // Use selectedTitle from gallery if set, else fall back to titleText
        const finalTitleText  = selectedTitle || titleText;

        const accentStyle = accent ? `style="--profile-accent:${escape(accent)}"` : '';

        const wallpaperStyle = profile.wallpaper
            ? `style="background-image:url(${escape(profile.wallpaper)})"`
            : '';

        const avatarInner = profile.avatar
            ? `<img class="profile-avatar-img" src="${escape(profile.avatar)}" alt="">`
            : `<div class="profile-avatar-placeholder">${escape((profile.username || '?').charAt(0).toUpperCase())}</div>`;
        const avatarHTML = `<span class="profile-avatar-frame profile-frame-${escape(frame)}">${avatarInner}</span>`;

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

        // Status chip — runs through the emoji renderer so :wave: etc. work
        const statusHtml = status
            ? `<div class="profile-status-chip">${
                window.ArcadeEmojis ? ArcadeEmojis.replaceEmojis(escape(status)) : escape(status)
            }</div>`
            : '';
        const taglineHtml = tagline
            ? `<div class="profile-tagline">${escape(tagline)}</div>`
            : '';

        // Decorative background effect overlay layer — purely visual,
        // sits between the wallpaper and the body content. Each variant
        // corresponds to a CSS pattern in style.css.
        const bgEffectHtml = bgEffect && bgEffect !== 'none'
            ? `<div class="profile-bg-effect profile-bg-${escape(bgEffect)}" aria-hidden="true"></div>`
            : '';

        // Decorative outer border (frame around the whole modal). Empty
        // for the default look; otherwise a CSS class drives ornate
        // corners / circuit traces / etc.
        const borderClass = borderStyle && borderStyle !== 'none' ? ` profile-border-${escape(borderStyle)}` : '';
        const layoutClass = ` profile-layout-${escape(layout)}`;

        // Artwork showcase (up to 4 large featured images, like Steam's
        // Artwork Showcase). Each artwork is { url, caption }.
        const artworkHtml = (!privacy.hideArtwork && artwork.length)
            ? `<div class="profile-section profile-artwork-section">
                <h3 class="profile-section-title">Featured artwork</h3>
                <div class="profile-artwork-grid profile-artwork-grid-${Math.min(artwork.length, 4)}">
                    ${artwork.map(a => `
                        <figure class="profile-artwork-card">
                            <img src="${escape(a.url || '')}" alt="${escape(a.caption || '')}">
                            ${a.caption ? `<figcaption>${escape(a.caption)}</figcaption>` : ''}
                        </figure>
                    `).join('')}
                </div>
            </div>` : '';

        // Avatar aura wrapper (orbital particles) + accessory overlay
        const auraClass = avatarAura !== 'none' ? ` profile-aura-${escape(avatarAura)}` : '';
        const accessoryHtml = avatarAccessory !== 'none'
            ? `<span class="profile-avatar-accessory profile-accessory-${escape(avatarAccessory)}" aria-hidden="true"></span>`
            : '';

        // Username effect class. usernameStyle (color) + usernameGlow
        // (drop shadow) compose with the effect.
        const nameEffectClass = usernameEffect !== 'none' ? ` profile-name-effect-${escape(usernameEffect)}` : '';
        const glowStyle = usernameGlow
            ? `text-shadow: 0 0 8px ${escape(usernameGlow)}, 0 0 18px ${escape(usernameGlow)};`
            : '';
        const combinedNameStyle = (nameColor || glowStyle)
            ? `style="${nameColor ? `color:${escape(nameColor)};` : ''}${glowStyle}"`
            : '';

        // Title text rendered above the username — gallery selection wins
        const titleHtml = finalTitleText
            ? `<div class="profile-title-text">${escape(finalTitleText)}</div>` : '';

        // Username font (independent of profile font)
        const usernameFontClass = usernameFont ? ` profile-uname-font-${escape(usernameFont)}` : '';

        // "What I'm into" chip row
        const intoTagsHtml = intoTags.length ? `
            <div class="profile-section profile-into-section">
                <h3 class="profile-section-title">What I'm into</h3>
                <div class="profile-into-tags">
                    ${intoTags.map(t => `<span class="profile-into-tag">${escape(t)}</span>`).join('')}
                </div>
            </div>` : '';

        // Pinned quote widget
        const quoteWidgetHtml = quoteWidget ? `
            <div class="profile-section profile-quote-widget-section">
                <blockquote class="profile-quote-widget">${escape(quoteWidget)}</blockquote>
            </div>` : '';

        // Music embed widget — accept Spotify, YouTube, SoundCloud iframe srcs.
        // Other URLs we leave unrendered; user has to paste a URL the host
        // permits in an iframe (Spotify embed URL, etc.).
        const musicEmbedHtml = musicEmbed && /^https:\/\/(open\.spotify\.com\/embed|w\.soundcloud\.com\/player|www\.youtube\.com\/embed|youtube\.com\/embed)/.test(musicEmbed) ? `
            <div class="profile-section profile-music-embed-section">
                <h3 class="profile-section-title">Now spinning</h3>
                <iframe class="profile-music-embed" src="${escape(musicEmbed)}" allow="autoplay; encrypted-media" loading="lazy"></iframe>
            </div>` : '';

        // Modal-level data attrs drive font + cursor presets via CSS.
        const fontClass = profileFont !== 'system' ? ` profile-font-${escape(profileFont)}` : '';
        const cursorClass = profileCursor !== 'default' ? ` profile-cursor-${escape(profileCursor)}` : '';
        const entryClass = entryAnimation !== 'none' ? ` profile-entry-${escape(entryAnimation)}` : '';

        overlay.innerHTML = `
            <div class="profile-modal${borderClass}${layoutClass}${fontClass}${cursorClass}${entryClass}" data-frame="${escape(frame)}" data-bg-effect="${escape(bgEffect)}" ${accentStyle}>
                <button class="modal-close profile-close" id="closeProfileModal">&times;</button>
                ${bgmHtml}
                ${bgEffectHtml}
                <div class="profile-header" ${wallpaperStyle}>
                    <div class="profile-header-overlay"></div>
                </div>
                <div class="profile-identity">
                    <div class="profile-avatar${auraClass}">${avatarHTML}${accessoryHtml}</div>
                    ${titleHtml}
                    <div class="profile-name${nameEffectClass}${usernameFontClass}" ${combinedNameStyle}><span>${escape(profile.username || 'unknown')}</span>${badgesHTML}</div>
                    <div id="profileOnlineStatusSlot"></div>
                    ${taglineHtml}
                    ${statusHtml}
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
                    <div class="profile-progress-row">
                        <div id="profileLevelSlot"></div>
                        <div id="profileStreakSlot"></div>
                    </div>

                    <div id="profileBadgesSlot"></div>

                    <div id="profilePinnedAchSlot"></div>

                    ${profile.currentGame && gamesIndex[profile.currentGame] ? `
                    <div class="profile-playing-now">
                        <span class="profile-playing-dot"></span>
                        Currently playing
                        <a class="profile-playing-link" href="play.html?game=${encodeURIComponent(profile.currentGame)}">${escape(gamesIndex[profile.currentGame].title)}</a>
                    </div>` : ''}

                    ${artworkHtml}

                    ${profile.bio ? `<div class="profile-section">
                        <h3 class="profile-section-title">About</h3>
                        <p class="profile-bio">${escape(profile.bio)}</p>
                    </div>` : (isSelf ? '<div class="profile-bio-empty">Add a bio in Edit profile →</div>' : '')}

                    ${quoteWidgetHtml}
                    ${intoTagsHtml}
                    ${musicEmbedHtml}

                    <div id="profilePinnedClipSlot"></div>

                    ${profileMiniGame !== 'none' ? `
                    <div class="profile-section">
                        <h3 class="profile-section-title">Minigame: ${escape(profileMiniGame)}</h3>
                        <div id="profileMinigameSlot"></div>
                    </div>` : ''}

                    <div class="profile-section">
                        <h3 class="profile-section-title">Trading cards</h3>
                        <div id="profileCardsSlot"></div>
                    </div>

                    <div class="profile-section profile-reactions-section" id="profileReactionsSlot"></div>

                    <div class="profile-section profile-heatmap-section">
                        <h3 class="profile-section-title">Activity</h3>
                        <div id="profileHeatmapSlot"></div>
                    </div>

                    ${(!privacy.hidePlayCounts) ? `<div class="profile-section">
                        <h3 class="profile-section-title">Most played</h3>
                        <div id="profileLeaderboardSlot"></div>
                    </div>` : ''}

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

                    ${(!privacy.hideShowcase && showcaseGames.length) ? `<div class="profile-section">
                        <h3 class="profile-section-title">Showcase</h3>
                        <div class="profile-game-grid profile-game-grid-lg">
                            ${showcaseGames.map(gameCardHTML).join('')}
                        </div>
                    </div>` : ''}

                    ${(!privacy.hidePlayCounts && topByPlays.length) ? `<div class="profile-section">
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

                    ${(!privacy.hideAchievements && achievementDefs.length) ? `<div class="profile-section">
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

                    ${(!privacy.hideFavorites && favGames.length) ? `<div class="profile-section">
                        <h3 class="profile-section-title">Favorites${favs.length > 8 ? ` (${favs.length})` : ''}</h3>
                        <div class="profile-game-grid">
                            ${favGames.map(gameCardHTML).join('')}
                        </div>
                    </div>` : ''}

                    <div class="profile-section">
                        <h3 class="profile-section-title">Guestbook</h3>
                        <div id="profileGuestbookSlot"></div>
                    </div>

                    ${isSelf ? `<div class="profile-section">
                        <h3 class="profile-section-title">Recently visited by</h3>
                        <div class="profile-visitors-row" id="profileVisitorsSlot"></div>
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

        // ─── v3 module hooks (FX + social + heatmap + leaderboard) ──
        const modalEl = overlay.querySelector('.profile-modal');
        if (window.ArcadeProfileFx) {
            try { ArcadeProfileFx.applyProfileFx(profile, modalEl); } catch {}
        }

        // ─── v4 module hooks (level/streak/theme override/pet/parallax/cards) ──
        if (window.ArcadeProfileExtras) {
            const X = window.ArcadeProfileExtras;
            try { X.renderLevelBadge(document.getElementById('profileLevelSlot'), profile); } catch {}
            try { X.renderStreak(document.getElementById('profileStreakSlot'), profile); } catch {}
            // Online status: prepend rendered HTML into the slot
            try {
                const slot = document.getElementById('profileOnlineStatusSlot');
                if (slot) slot.innerHTML = X.renderOnlineStatus(profile);
            } catch {}
            // Theme override (only when viewing someone else's profile, and they have one set)
            if (!isSelf && profileTheme) {
                try { X.applyThemeOverride(profileTheme); } catch {}
            }
            // Pet
            try { X.mountPet(modalEl, profilePet); } catch {}
            // Parallax
            try { X.mountParallax(modalEl, profile.wallpaperBg, profile.wallpaperFg); } catch {}
            // Custom CSS injection (sandboxed via @scope)
            try { X.injectCustomCss(modalEl, profile); } catch {}
            // Trading cards
            try { X.renderCards(document.getElementById('profileCardsSlot'), profile, gamesIndex); } catch {}
            // Pinned achievements
            try { X.renderPinnedAchievements(document.getElementById('profilePinnedAchSlot'), profile); } catch {}
            // Custom badges (admin-defined)
            try { X.renderBadges(document.getElementById('profileBadgesSlot'), profile); } catch {}
            // Pinned clip
            try {
                const slot = document.getElementById('profilePinnedClipSlot');
                if (slot) slot.innerHTML = X.renderPinnedClip(profile);
            } catch {}
            // Multi-track BGM playlist
            const tracks = Array.isArray(profile.profileBgmTracks) ? profile.profileBgmTracks.filter(Boolean) : [];
            const audio = document.getElementById('profileBgmAudio');
            if (audio && tracks.length > 1) {
                try { X.setupBgmPlaylist(audio, tracks); } catch {}
            }
        }
        // Minigame
        if (window.ArcadeMinigame && profileMiniGame !== 'none') {
            try { ArcadeMinigame.mount(document.getElementById('profileMinigameSlot'), profileMiniGame); } catch {}
        }
        // Social: reactions, guestbook, visitor record + recent visitors list
        if (window.ArcadeProfileSocial) {
            try {
                ArcadeProfileSocial.renderReactionsBar(
                    document.getElementById('profileReactionsSlot'), profile);
            } catch {}
            try {
                ArcadeProfileSocial.renderGuestbook(
                    document.getElementById('profileGuestbookSlot'), profile);
            } catch {}
            // Record visit (other people's profiles only)
            if (!isSelf) {
                try { ArcadeProfileSocial.recordVisit(profile.uid); } catch {}
            } else {
                // Show recent visitors to the owner
                ArcadeProfileSocial.loadRecentVisitors(profile.uid).then(v => {
                    ArcadeProfileSocial.renderRecentVisitors(
                        document.getElementById('profileVisitorsSlot'), v);
                }).catch(() => {});
            }
        }
        // Heatmap + leaderboard
        if (window.ArcadePlayHeatmap) {
            try {
                ArcadePlayHeatmap.renderHeatmap(
                    document.getElementById('profileHeatmapSlot'), profile);
            } catch {}
            try {
                ArcadePlayHeatmap.renderLeaderboard(
                    document.getElementById('profileLeaderboardSlot'), profile, gamesIndex);
            } catch {}
        }

        document.getElementById('closeProfileModal').addEventListener('click', () => {
            if (window.ArcadeProfileFx) ArcadeProfileFx.teardownProfileFx();
            closeModal();
        });
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
        // Profile customization v2 locals
        let localFrame    = profile.avatarFrame || 'none';
        let localLayout   = profile.layoutStyle || 'default';
        let localBgEffect = profile.bgEffect || 'none';
        let localBorder   = profile.borderStyle || 'none';
        let localArtwork  = Array.isArray(profile.artwork) ? profile.artwork.slice(0, 4) : [];
        let localPrivacy  = Object.assign({
            hideShowcase: false, hideArtwork: false, hidePlayCounts: false,
            hideAchievements: false, hideFavorites: false,
        }, profile.privacy || {});
        // v3 locals
        let localUsernameEffect  = profile.usernameEffect  || 'none';
        let localUsernameGlow    = profile.usernameGlow    || '';
        let localAvatarAura      = profile.avatarAura      || 'none';
        let localAvatarAccessory = profile.avatarAccessory || 'none';
        let localEntryAnim       = profile.entryAnimation  || 'none';
        let localProfileFont     = profile.profileFont     || 'system';
        let localProfileCursor   = profile.profileCursor   || 'default';
        let localCursorTrail     = profile.cursorTrail     || 'none';
        let localIntoTags        = Array.isArray(profile.intoTags) ? profile.intoTags.slice() : [];
        // v4 locals
        let localUsernameFont    = profile.usernameFont    || '';
        let localProfileTheme    = profile.profileTheme    || '';
        let localPet             = profile.profilePet      || 'none';
        let localOnlineDot       = profile.onlineStatus?.dot || 'offline';
        let localOnlineMsg       = profile.onlineStatus?.message || '';
        let localProfileCss      = profile.profileCss      || '';
        let localBgmTracks       = Array.isArray(profile.profileBgmTracks) ? profile.profileBgmTracks.slice() : [];
        let localPinnedAch       = Array.isArray(profile.pinnedAchievements) ? profile.pinnedAchievements.slice() : [];
        let localSelectedTitle   = profile.selectedTitle   || '';
        let localMiniGame        = profile.miniGame        || 'none';
        let localPinnedClip      = profile.pinnedClip      || '';
        let localWallpaperBg     = profile.wallpaperBg     || '';
        let localWallpaperFg     = profile.wallpaperFg     || '';

        const FRAMES = [
            { id: 'none',    label: 'None' },
            { id: 'glow',    label: 'Glow' },
            { id: 'rainbow', label: 'Rainbow' },
            { id: 'gold',    label: 'Gold' },
            { id: 'neon',    label: 'Neon Pulse' },
            { id: 'glitch',  label: 'Glitch' },
            { id: 'snake',   label: 'Snake' },
        ];
        const LAYOUTS = [
            { id: 'default',  label: 'Default' },
            { id: 'compact',  label: 'Compact' },
            { id: 'magazine', label: 'Magazine' },
        ];
        const BG_EFFECTS = [
            { id: 'none',      label: 'None' },
            { id: 'vignette',  label: 'Vignette' },
            { id: 'stars',     label: 'Stars' },
            { id: 'swirl',     label: 'Swirl' },
            { id: 'scanlines', label: 'Scanlines' },
            { id: 'dust',      label: 'Floating dust' },
        ];
        const BORDERS = [
            { id: 'none',    label: 'None' },
            { id: 'ornate',  label: 'Ornate' },
            { id: 'tape',    label: 'Tape' },
            { id: 'circuit', label: 'Circuit' },
            { id: 'ribbon',  label: 'Ribbon' },
        ];
        const USERNAME_EFFECTS = [
            { id: 'none',       label: 'None' },
            { id: 'rainbow',    label: 'Rainbow' },
            { id: 'fire',       label: 'Fire' },
            { id: 'glitch',     label: 'Glitch' },
            { id: 'typewriter', label: 'Typewriter' },
            { id: 'sparkle',    label: 'Sparkle' },
        ];
        const AVATAR_AURAS = [
            { id: 'none',         label: 'None' },
            { id: 'hearts',       label: 'Hearts' },
            { id: 'sparks',       label: 'Sparks' },
            { id: 'fire',         label: 'Fire' },
            { id: 'planets',      label: 'Planets' },
            { id: 'butterflies',  label: 'Butterflies' },
        ];
        const ACCESSORIES = [
            { id: 'none',        label: 'None' },
            { id: 'crown',       label: 'Crown 👑' },
            { id: 'halo',        label: 'Halo 👼' },
            { id: 'partyhat',    label: 'Party 🎉' },
            { id: 'devilhorns',  label: 'Devil 😈' },
            { id: 'headphones',  label: 'Headphones 🎧' },
        ];
        const ENTRY_ANIMS = [
            { id: 'none',     label: 'None' },
            { id: 'fade',     label: 'Fade' },
            { id: 'slide',    label: 'Slide' },
            { id: 'pixelate', label: 'Pixelate' },
            { id: 'glitch',   label: 'Glitch' },
            { id: 'zoom',     label: 'Zoom' },
            { id: 'shatter',  label: 'Shatter' },
        ];
        const FONTS = [
            { id: 'system',       label: 'System' },
            { id: 'pixel',        label: 'Pixel (Press Start 2P)' },
            { id: 'gothic',       label: 'Gothic (Cinzel)' },
            { id: 'futuristic',   label: 'Futuristic (Orbitron)' },
            { id: 'handwritten',  label: 'Handwritten (Caveat)' },
            { id: 'serif',        label: 'Serif' },
            { id: 'mono',         label: 'Monospace' },
            { id: 'rounded',      label: 'Rounded (Comic)' },
            { id: 'elegant',      label: 'Elegant (Cinzel)' },
        ];
        const CURSORS = [
            { id: 'default',    label: 'Default' },
            { id: 'sword',      label: 'Sword ⚔️' },
            { id: 'paw',        label: 'Paw 🐾' },
            { id: 'magic',      label: 'Magic 🪄' },
            { id: 'pixel',      label: 'Pixel arrow' },
            { id: 'crosshair',  label: 'Crosshair ⊕' },
        ];
        const CURSOR_TRAILS = [
            { id: 'none',     label: 'None' },
            { id: 'sparkles', label: 'Sparkles ✨' },
            { id: 'hearts',   label: 'Hearts ❤' },
            { id: 'stars',    label: 'Stars ★' },
            { id: 'fire',     label: 'Fire 🔥' },
            { id: 'dots',     label: 'Dots' },
        ];
        const INTO_TAG_POOL = [
            'RPGs', 'Roguelites', 'Speedrunning', 'Retro', 'Fighting',
            'Pokemon', 'FPS', 'Indie', 'Horror', 'Co-op',
            'Racing', 'Platformers', 'Puzzle', 'Strategy', 'Sandbox',
            'Multiplayer', 'Card Games', 'Visual Novels', 'Souls-like',
            'Bullet Hell', 'Metroidvania', 'Idle', 'Rhythm', 'Sports',
        ];
        const PETS = [
            { id: 'none',   label: 'None' },
            { id: 'cat',    label: 'Cat (pixel sprite)' },
            { id: 'dog',    label: 'Dog (pixel sprite)' },
            { id: 'slime',  label: 'Slime 🟢' },
            { id: 'duck',   label: 'Duck 🦆' },
            { id: 'dragon', label: 'Dragon 🐲' },
            { id: 'ghost',  label: 'Ghost 👻' },
        ];
        const ONLINE_DOTS = [
            { id: 'offline', label: '⚫ Offline / hide' },
            { id: 'green',   label: '🟢 Online' },
            { id: 'yellow',  label: '🟡 Away' },
            { id: 'red',     label: '🔴 Do not disturb' },
        ];
        const MINIGAMES = [
            { id: 'none',   label: 'None' },
            { id: 'snake',  label: 'Snake 🐍' },
            { id: '2048',   label: '2048' },
            { id: 'memory', label: 'Memory 🧠' },
        ];
        // Same theme list themes.js uses
        const PROFILE_THEMES = [
            { id: '',          label: 'Use visitor\'s theme' },
            { id: 'midnight',  label: 'Midnight' },
            { id: 'ocean',     label: 'Ocean' },
            { id: 'crimson',   label: 'Crimson' },
            { id: 'forest',    label: 'Forest' },
            { id: 'sunset',    label: 'Sunset' },
            { id: 'synthwave', label: 'Synthwave' },
            { id: 'sakura',    label: 'Sakura' },
            { id: 'oled',      label: 'OLED' },
            { id: 'nord',      label: 'Nord' },
            { id: 'monokai',   label: 'Monokai' },
            { id: 'light',     label: 'Light' },
            { id: 'crt',       label: 'CRT' },
            { id: 'pastel',    label: 'Pastel' },
            { id: 'highcontrast', label: 'High contrast' },
        ];
        const titlesEarned = Array.isArray(profile.titles) ? profile.titles.slice() : [];
        // Always include any current titleText so it's selectable
        if (profile.titleText && !titlesEarned.includes(profile.titleText)) {
            titlesEarned.unshift(profile.titleText);
        }

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
                        <label class="profile-edit-label" for="taglineInput">Tagline <span class="profile-edit-hint">(short subtitle under your name)</span></label>
                        <input type="text" id="taglineInput" class="profile-edit-bio" maxlength="60" placeholder="e.g. speedrunner / shitposter / vibing" value="${escape(profile.tagline || '')}" style="min-height:auto;height:38px;padding:6px 10px;">
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="statusInput">Status <span class="profile-edit-hint">(supports :emoji: codes)</span></label>
                        <input type="text" id="statusInput" class="profile-edit-bio" maxlength="80" placeholder="e.g. :fire: grinding pokemon emerald" value="${escape(profile.status || '')}" style="min-height:auto;height:38px;padding:6px 10px;">
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Avatar frame</label>
                        <div class="profile-edit-preset-grid" id="frameGrid">
                            ${FRAMES.map(f => `
                                <button type="button" class="profile-edit-preset profile-frame-preview-${f.id}${localFrame === f.id ? ' picked' : ''}" data-frame="${f.id}">
                                    <span class="profile-edit-preset-swatch profile-avatar-frame profile-frame-${f.id}">
                                        <span class="profile-edit-preset-mock"></span>
                                    </span>
                                    <span class="profile-edit-preset-label">${f.label}</span>
                                </button>
                            `).join('')}
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Layout</label>
                        <div class="profile-edit-pill-row" id="layoutRow">
                            ${LAYOUTS.map(l => `<button type="button" class="profile-edit-pill${localLayout === l.id ? ' picked' : ''}" data-layout="${l.id}">${l.label}</button>`).join('')}
                        </div>
                        <span class="profile-edit-hint">Default = roomy, Compact = denser, Magazine = artwork-first feature layout.</span>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Background effect</label>
                        <div class="profile-edit-pill-row" id="bgEffectRow">
                            ${BG_EFFECTS.map(b => `<button type="button" class="profile-edit-pill${localBgEffect === b.id ? ' picked' : ''}" data-bg="${b.id}">${b.label}</button>`).join('')}
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Border style</label>
                        <div class="profile-edit-pill-row" id="borderRow">
                            ${BORDERS.map(b => `<button type="button" class="profile-edit-pill${localBorder === b.id ? ' picked' : ''}" data-border="${b.id}">${b.label}</button>`).join('')}
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Featured artwork <span class="profile-edit-hint">(up to 4, large gallery on your profile)</span></label>
                        <div class="profile-edit-artwork-grid" id="artworkGrid"></div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="titleTextInput">Title <span class="profile-edit-hint">(small text above your name, e.g. "Level 99 Wizard")</span></label>
                        <input type="text" id="titleTextInput" class="profile-edit-bio" maxlength="50" placeholder="e.g. Pokemon Master" value="${escape(profile.titleText || '')}" style="min-height:auto;height:38px;padding:6px 10px;">
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Username text effect</label>
                        <div class="profile-edit-pill-row" id="usernameEffectRow">
                            ${USERNAME_EFFECTS.map(u => `<button type="button" class="profile-edit-pill${localUsernameEffect === u.id ? ' picked' : ''}" data-ueffect="${u.id}">${u.label}</button>`).join('')}
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="usernameGlowInput">Username glow color</label>
                        <div class="profile-edit-accent-area">
                            <input type="color" id="usernameGlowInput" value="${escape(profile.usernameGlow || '#7c3aed')}" class="profile-edit-accent-input">
                            <button class="profile-edit-action" id="clearUsernameGlowBtn">No glow</button>
                        </div>
                        <span class="profile-edit-hint">Soft halo around your name. Leave blank for none.</span>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Avatar aura <span class="profile-edit-hint">(orbital particles)</span></label>
                        <div class="profile-edit-pill-row" id="avatarAuraRow">
                            ${AVATAR_AURAS.map(a => `<button type="button" class="profile-edit-pill${localAvatarAura === a.id ? ' picked' : ''}" data-aura="${a.id}">${a.label}</button>`).join('')}
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Avatar accessory</label>
                        <div class="profile-edit-pill-row" id="accessoryRow">
                            ${ACCESSORIES.map(a => `<button type="button" class="profile-edit-pill${localAvatarAccessory === a.id ? ' picked' : ''}" data-accessory="${a.id}">${a.label}</button>`).join('')}
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Entry animation</label>
                        <div class="profile-edit-pill-row" id="entryAnimRow">
                            ${ENTRY_ANIMS.map(e => `<button type="button" class="profile-edit-pill${localEntryAnim === e.id ? ' picked' : ''}" data-entry="${e.id}">${e.label}</button>`).join('')}
                        </div>
                        <span class="profile-edit-hint">How your profile modal appears.</span>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="profileFontSel">Profile font</label>
                        <select id="profileFontSel" class="profile-edit-bio" style="min-height:auto;height:38px;">
                            ${FONTS.map(f => `<option value="${f.id}" ${localProfileFont === f.id ? 'selected' : ''}>${f.label}</option>`).join('')}
                        </select>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Cursor</label>
                        <div class="profile-edit-pill-row" id="cursorPresetRow">
                            ${CURSORS.map(c => `<button type="button" class="profile-edit-pill${localProfileCursor === c.id ? ' picked' : ''}" data-cursor="${c.id}">${c.label}</button>`).join('')}
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Cursor trail</label>
                        <div class="profile-edit-pill-row" id="cursorTrailRow">
                            ${CURSOR_TRAILS.map(c => `<button type="button" class="profile-edit-pill${localCursorTrail === c.id ? ' picked' : ''}" data-trail="${c.id}">${c.label}</button>`).join('')}
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="enterSoundInput">Profile enter sound URL</label>
                        <input type="url" id="enterSoundInput" class="profile-edit-bio" maxlength="500" placeholder="https://… mp3 / ogg / wav (plays once when someone opens your profile)" value="${escape(profile.enterSound || '')}" style="min-height:auto;height:38px;padding:6px 10px;">
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="quoteWidgetInput">Pinned quote widget</label>
                        <textarea id="quoteWidgetInput" class="profile-edit-bio" maxlength="240" placeholder="A favorite quote — shows pinned on your profile">${escape(profile.quoteWidget || '')}</textarea>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="musicEmbedInput">Music embed URL</label>
                        <input type="url" id="musicEmbedInput" class="profile-edit-bio" maxlength="500" placeholder="https://open.spotify.com/embed/… or YouTube /embed/ or SoundCloud player URL" value="${escape(profile.musicEmbed || '')}" style="min-height:auto;height:38px;padding:6px 10px;">
                        <span class="profile-edit-hint">Spotify embed, YouTube /embed/ or SoundCloud player URLs only.</span>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">What I'm into <span class="profile-edit-hint">(pick up to 6 tags)</span></label>
                        <div class="profile-edit-pill-row" id="intoTagsRow">
                            ${INTO_TAG_POOL.map(t => `<button type="button" class="profile-edit-pill${localIntoTags.includes(t) ? ' picked' : ''}" data-into="${escape(t)}">${escape(t)}</button>`).join('')}
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Online status</label>
                        <div class="profile-edit-pill-row" id="onlineDotRow">
                            ${ONLINE_DOTS.map(d => `<button type="button" class="profile-edit-pill${localOnlineDot === d.id ? ' picked' : ''}" data-dot="${d.id}">${d.label}</button>`).join('')}
                        </div>
                        <input type="text" id="onlineStatusMsg" class="profile-edit-bio" maxlength="80" placeholder="Custom status message (e.g. 'AFK back at 5')" value="${escape(localOnlineMsg)}" style="min-height:auto;height:38px;padding:6px 10px;margin-top:6px;">
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Username font <span class="profile-edit-hint">(separate from page font)</span></label>
                        <div class="profile-edit-pill-row" id="usernameFontRow">
                            ${[{id:'',label:'Inherit'}].concat(FONTS).map(f => `<button type="button" class="profile-edit-pill${localUsernameFont === f.id ? ' picked' : ''}" data-uname-font="${f.id}">${f.label}</button>`).join('')}
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="profileThemeSel">Force visitors to a theme</label>
                        <select id="profileThemeSel" class="profile-edit-bio" style="min-height:auto;height:38px;">
                            ${PROFILE_THEMES.map(t => `<option value="${t.id}" ${localProfileTheme === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}
                        </select>
                        <span class="profile-edit-hint">Visitors temporarily see your chosen theme while on your profile.</span>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Profile pet</label>
                        <div class="profile-edit-pill-row" id="petRow">
                            ${PETS.map(p => `<button type="button" class="profile-edit-pill${localPet === p.id ? ' picked' : ''}" data-pet="${p.id}">${p.label}</button>`).join('')}
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Minigame widget</label>
                        <div class="profile-edit-pill-row" id="miniGameRow">
                            ${MINIGAMES.map(m => `<button type="button" class="profile-edit-pill${localMiniGame === m.id ? ' picked' : ''}" data-minigame="${m.id}">${m.label}</button>`).join('')}
                        </div>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="pinnedClipInput">Pinned clip URL <span class="profile-edit-hint">(YouTube /embed/, Twitch player, Vimeo)</span></label>
                        <input type="url" id="pinnedClipInput" class="profile-edit-bio" maxlength="500" placeholder="https://www.youtube.com/embed/…" value="${escape(localPinnedClip)}" style="min-height:auto;height:38px;padding:6px 10px;">
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="wallpaperBgInput">Wallpaper background layer URL <span class="profile-edit-hint">(parallax)</span></label>
                        <input type="url" id="wallpaperBgInput" class="profile-edit-bio" maxlength="500" placeholder="https://… (deepest layer, moves slowest)" value="${escape(localWallpaperBg)}" style="min-height:auto;height:38px;padding:6px 10px;">
                    </div>
                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="wallpaperFgInput">Wallpaper foreground layer URL <span class="profile-edit-hint">(parallax)</span></label>
                        <input type="url" id="wallpaperFgInput" class="profile-edit-bio" maxlength="500" placeholder="https://… (top layer, moves most)" value="${escape(localWallpaperFg)}" style="min-height:auto;height:38px;padding:6px 10px;">
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">BGM playlist <span class="profile-edit-hint">(one URL per line, plays in order)</span></label>
                        <textarea id="bgmTracksInput" class="profile-edit-bio" maxlength="2000" placeholder="https://...mp3&#10;https://...mp3" style="min-height:80px;">${escape(localBgmTracks.join('\n'))}</textarea>
                    </div>

                    ${titlesEarned.length ? `
                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Choose displayed title</label>
                        <div class="profile-edit-pill-row" id="selectedTitleRow">
                            <button type="button" class="profile-edit-pill${!localSelectedTitle ? ' picked' : ''}" data-title="">None</button>
                            ${titlesEarned.map(t => `<button type="button" class="profile-edit-pill${localSelectedTitle === t ? ' picked' : ''}" data-title="${escape(t)}">${escape(t)}</button>`).join('')}
                        </div>
                    </div>` : ''}

                    <div class="profile-edit-row">
                        <label class="profile-edit-label" for="profileCssInput">Custom profile CSS <span class="profile-edit-hint">(advanced — sandboxed via @scope, 4KB cap)</span></label>
                        <textarea id="profileCssInput" class="profile-edit-bio" maxlength="4096" placeholder=".profile-name { animation: spin 1s linear infinite; }" style="min-height:120px;font-family:ui-monospace,monospace;">${escape(localProfileCss)}</textarea>
                        <span class="profile-edit-hint">Only applies to this profile. Wrapped in @scope to prevent leakage.</span>
                    </div>

                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Privacy</label>
                        <div class="profile-edit-privacy-grid" id="privacyGrid">
                            <label class="profile-edit-privacy-toggle"><input type="checkbox" data-priv="hideArtwork" ${localPrivacy.hideArtwork?'checked':''}> Hide artwork</label>
                            <label class="profile-edit-privacy-toggle"><input type="checkbox" data-priv="hideShowcase" ${localPrivacy.hideShowcase?'checked':''}> Hide showcase</label>
                            <label class="profile-edit-privacy-toggle"><input type="checkbox" data-priv="hidePlayCounts" ${localPrivacy.hidePlayCounts?'checked':''}> Hide top games</label>
                            <label class="profile-edit-privacy-toggle"><input type="checkbox" data-priv="hideAchievements" ${localPrivacy.hideAchievements?'checked':''}> Hide achievements</label>
                            <label class="profile-edit-privacy-toggle"><input type="checkbox" data-priv="hideFavorites" ${localPrivacy.hideFavorites?'checked':''}> Hide favorites</label>
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

        // Render the artwork grid — clickable thumbnails, plus an
        // "Add" tile up to the 4-item cap. Click an existing tile to
        // remove or change its caption.
        function renderArtworkGrid() {
            const grid = document.getElementById('artworkGrid');
            if (!grid) return;
            const tiles = localArtwork.map((a, i) => `
                <div class="profile-edit-artwork-tile">
                    <img src="${escape(a.url || '')}" alt="">
                    <input type="text" class="profile-edit-artwork-caption" data-i="${i}" placeholder="Caption (optional)" maxlength="60" value="${escape(a.caption || '')}">
                    <button type="button" class="profile-edit-artwork-del" data-i="${i}" title="Remove">&times;</button>
                </div>
            `).join('');
            const addBtn = localArtwork.length < 4
                ? `<button type="button" class="profile-edit-artwork-add" id="artworkAddBtn">＋ Add artwork</button>`
                : '';
            grid.innerHTML = tiles + addBtn;
            grid.querySelectorAll('.profile-edit-artwork-del').forEach(btn => {
                btn.addEventListener('click', () => {
                    localArtwork.splice(Number(btn.dataset.i), 1);
                    renderArtworkGrid();
                });
            });
            grid.querySelectorAll('.profile-edit-artwork-caption').forEach(inp => {
                inp.addEventListener('input', () => {
                    const i = Number(inp.dataset.i);
                    if (localArtwork[i]) localArtwork[i].caption = inp.value.slice(0, 60);
                });
            });
            const addEl = document.getElementById('artworkAddBtn');
            if (addEl) addEl.addEventListener('click', async () => {
                // Wider budget than wallpaper — featured artwork shows
                // full-size on the profile so we keep more pixels (up
                // to 2000px on the long edge) and a higher quality
                // setting. Animated GIFs/WebPs preserve animation
                // through promptImageUpload's isAnimated branch.
                const data = await promptImageUpload(2000, 2000, 0.78, 600 * 1024);
                if (data) {
                    localArtwork.push({ url: data, caption: '' });
                    renderArtworkGrid();
                }
            });
        }

        renderAvatar();
        renderWallpaper();
        renderShowcase();
        renderArtworkGrid();

        // ─── Preset pill / grid pickers ─────────────────────────────
        function wirePillRow(rowId, attr, setter) {
            const row = document.getElementById(rowId);
            if (!row) return;
            row.addEventListener('click', (e) => {
                const btn = e.target.closest(`[data-${attr}]`);
                if (!btn) return;
                row.querySelectorAll('.profile-edit-pill').forEach(b => b.classList.remove('picked'));
                btn.classList.add('picked');
                setter(btn.dataset[attr]);
            });
        }
        wirePillRow('layoutRow',   'layout', v => { localLayout   = v; });
        wirePillRow('bgEffectRow', 'bg',     v => { localBgEffect = v; });
        wirePillRow('borderRow',   'border', v => { localBorder   = v; });
        // v3 pill rows
        wirePillRow('usernameEffectRow', 'ueffect',   v => { localUsernameEffect  = v; });
        wirePillRow('avatarAuraRow',     'aura',      v => { localAvatarAura      = v; });
        wirePillRow('accessoryRow',      'accessory', v => { localAvatarAccessory = v; });
        wirePillRow('entryAnimRow',      'entry',     v => { localEntryAnim       = v; });
        wirePillRow('cursorPresetRow',   'cursor',    v => { localProfileCursor   = v; });
        wirePillRow('cursorTrailRow',    'trail',     v => { localCursorTrail     = v; });

        // Multi-select pill row for "What I'm into" (toggles in/out)
        document.getElementById('intoTagsRow')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-into]');
            if (!btn) return;
            const tag = btn.dataset.into;
            const i = localIntoTags.indexOf(tag);
            if (i >= 0) {
                localIntoTags.splice(i, 1);
                btn.classList.remove('picked');
            } else if (localIntoTags.length < 6) {
                localIntoTags.push(tag);
                btn.classList.add('picked');
            }
        });

        // Username glow color picker
        document.getElementById('usernameGlowInput')?.addEventListener('input', (e) => {
            localUsernameGlow = e.target.value;
        });
        document.getElementById('clearUsernameGlowBtn')?.addEventListener('click', () => {
            localUsernameGlow = '';
            const inp = document.getElementById('usernameGlowInput');
            if (inp) inp.value = '#7c3aed';
        });

        // Font select
        document.getElementById('profileFontSel')?.addEventListener('change', (e) => {
            localProfileFont = e.target.value;
        });

        // v4 pill rows
        wirePillRow('onlineDotRow',     'dot',         v => { localOnlineDot     = v; });
        wirePillRow('petRow',           'pet',         v => { localPet           = v; });
        wirePillRow('miniGameRow',      'minigame',    v => { localMiniGame      = v; });
        wirePillRow('selectedTitleRow', 'title',       v => { localSelectedTitle = v; });
        wirePillRow('usernameFontRow',  'uname-font',  v => { localUsernameFont  = v; });
        document.getElementById('profileThemeSel')?.addEventListener('change', (e) => {
            localProfileTheme = e.target.value;
        });
        document.getElementById('onlineStatusMsg')?.addEventListener('input', (e) => {
            localOnlineMsg = e.target.value;
        });

        const frameGridEl = document.getElementById('frameGrid');
        if (frameGridEl) {
            frameGridEl.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-frame]');
                if (!btn) return;
                frameGridEl.querySelectorAll('.profile-edit-preset').forEach(b => b.classList.remove('picked'));
                btn.classList.add('picked');
                localFrame = btn.dataset.frame;
            });
        }

        // Privacy checkbox grid
        document.getElementById('privacyGrid')?.addEventListener('change', (e) => {
            const cb = e.target.closest('input[type="checkbox"][data-priv]');
            if (!cb) return;
            localPrivacy[cb.dataset.priv] = cb.checked;
        });

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
                const taglineVal = (document.getElementById('taglineInput')?.value || '').trim().slice(0, 60);
                const statusVal  = (document.getElementById('statusInput')?.value  || '').trim().slice(0, 80);
                const titleTextVal   = (document.getElementById('titleTextInput')?.value   || '').trim().slice(0, 50);
                const enterSoundVal  = (document.getElementById('enterSoundInput')?.value  || '').trim().slice(0, 500);
                const quoteWidgetVal = (document.getElementById('quoteWidgetInput')?.value || '').trim().slice(0, 240);
                const musicEmbedVal  = (document.getElementById('musicEmbedInput')?.value  || '').trim().slice(0, 500);
                await ArcadeAuth.updateProfile({
                    usernameColor: localUsernameColor,
                    profileBgm: bgmUrl,
                    avatar: localAvatar,
                    wallpaper: localWallpaper,
                    bio: bioInput.value.trim().slice(0, 500),
                    accent: accent,
                    showcase: localShowcase,
                    tagline: taglineVal,
                    status: statusVal,
                    avatarFrame: localFrame,
                    layoutStyle: localLayout,
                    bgEffect: localBgEffect,
                    borderStyle: localBorder,
                    artwork: localArtwork,
                    privacy: localPrivacy,
                    // v3 fields
                    titleText:       titleTextVal,
                    usernameEffect:  localUsernameEffect,
                    usernameGlow:    localUsernameGlow,
                    avatarAura:      localAvatarAura,
                    avatarAccessory: localAvatarAccessory,
                    entryAnimation:  localEntryAnim,
                    profileFont:     localProfileFont,
                    profileCursor:   localProfileCursor,
                    cursorTrail:     localCursorTrail,
                    enterSound:      enterSoundVal,
                    quoteWidget:     quoteWidgetVal,
                    musicEmbed:      musicEmbedVal,
                    intoTags:        localIntoTags,
                    // v4 fields
                    usernameFont:    localUsernameFont,
                    profileTheme:    localProfileTheme,
                    profilePet:      localPet,
                    onlineStatus:    { dot: localOnlineDot, message: localOnlineMsg.slice(0, 80) },
                    profileCss:      (document.getElementById('profileCssInput')?.value || '').slice(0, 4096),
                    profileBgmTracks: (document.getElementById('bgmTracksInput')?.value || '')
                        .split('\n').map(s => s.trim()).filter(Boolean).slice(0, 20),
                    selectedTitle:   localSelectedTitle,
                    miniGame:        localMiniGame,
                    pinnedClip:      (document.getElementById('pinnedClipInput')?.value  || '').trim().slice(0, 500),
                    wallpaperBg:     (document.getElementById('wallpaperBgInput')?.value || '').trim().slice(0, 500),
                    wallpaperFg:     (document.getElementById('wallpaperFgInput')?.value || '').trim().slice(0, 500),
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
        const modalEl = existing?.querySelector('.profile-modal');
        if (existing) existing.remove();
        // Tear down v3 runtime FX (cursor trail, favicon swap, etc.)
        if (window.ArcadeProfileFx) {
            try { ArcadeProfileFx.teardownProfileFx(); } catch {}
        }
        // Tear down v4 features
        if (window.ArcadeProfileExtras) {
            try { ArcadeProfileExtras.restoreTheme(); } catch {}
            try { ArcadeProfileExtras.clearCustomCss(); } catch {}
            try { ArcadeProfileExtras.teardownParallax(modalEl); } catch {}
        }
        // Tear down sprite-based pet (cancels its RAF loop)
        if (window.ArcadeProfilePet) {
            try { ArcadeProfilePet.unmountPet(); } catch {}
        }
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
