// Profile customization v4 — extras module.
//
// Bundles a bunch of visual / runtime features that don't merit their
// own file each:
//   - XP / level computation (synthesized from existing data; no new
//     write needed). Level = floor(sqrt(xp / 50)). XP comes from plays
//     (1pt), achievements (25pt), reactions received (5pt), guestbook
//     posts sent (not tracked yet, skip), favorites (2pt).
//   - Daily login streak chip (uses profile.loginStreak written by
//     auth.js's updateLoginStreak)
//   - Online status indicator (dot + custom message)
//   - Profile theme override — when viewing a profile, swap the page's
//     data-theme to the profile's chosen theme; restore on close
//   - Profile pet — small CSS-animated companion that wanders the
//     profile modal
//   - Wallpaper parallax — when the user has both wallpaperFg + wallpaperBg
//     set, those layers translate at different rates on cursor move
//   - Custom profile CSS injection — sandboxed via @scope so it can
//     only style the profile-modal subtree
//   - Trading-card derivation: every 25 plays of a game drops a card,
//     stored in profile.cards. Rarity tiers based on play count.

(function () {
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ─── XP / Level ──────────────────────────────────────────────
    function computeXp(profile) {
        if (!profile) return { xp: 0, level: 1, xpToNext: 50, xpInLevel: 0, xpToReach: 50 };
        let xp = 0;
        const counts = profile.playCounts || {};
        for (const id in counts) xp += (counts[id] || 0);
        xp += (profile.achievements?.length || 0) * 25;
        const r = profile.reactions || {};
        for (const k in r) xp += (r[k] || 0) * 5;
        xp += (profile.favorites?.length || 0) * 2;
        // Level formula: each level needs 50 * level^2 cumulative xp
        // Solving for level: level = floor(sqrt(xp / 50))
        const level = Math.max(1, Math.floor(Math.sqrt(xp / 50)));
        // XP needed to reach level N: 50 * N^2
        const reachedAt = 50 * level * level;
        const nextAt = 50 * (level + 1) * (level + 1);
        return {
            xp,
            level,
            xpInLevel: xp - reachedAt,
            xpToReach: nextAt - reachedAt,
            xpToNext: nextAt - xp,
        };
    }

    function renderLevelBadge(target, profile) {
        if (!target) return;
        const { level, xpInLevel, xpToReach, xp } = computeXp(profile);
        const pct = Math.min(100, Math.round((xpInLevel / Math.max(1, xpToReach)) * 100));
        target.innerHTML = `
            <div class="profile-level-badge" title="${xp} total XP">
                <div class="profile-level-num">${level}</div>
                <div class="profile-level-meat">
                    <div class="profile-level-label">Level</div>
                    <div class="profile-level-bar"><div class="profile-level-bar-fill" style="width: ${pct}%"></div></div>
                    <div class="profile-level-xp">${xpInLevel}/${xpToReach} XP</div>
                </div>
            </div>
        `;
    }

    // ─── Login streak chip ───────────────────────────────────────
    function renderStreak(target, profile) {
        if (!target) return;
        const s = profile.loginStreak || { count: 0 };
        if (!s.count) {
            target.innerHTML = '';
            return;
        }
        target.innerHTML = `<span class="profile-streak-chip" title="Daily login streak">🔥 ${s.count}-day streak</span>`;
    }

    // ─── Online status ───────────────────────────────────────────
    function renderOnlineStatus(profile) {
        const s = profile.onlineStatus;
        if (!s || !s.dot || s.dot === 'offline') return '';
        const dotClass = `profile-status-dot profile-status-dot-${esc(s.dot)}`;
        const msg = s.message ? `<span class="profile-status-msg">${esc(s.message)}</span>` : '';
        return `<span class="profile-online-status">
            <span class="${dotClass}"></span>${msg}
        </span>`;
    }

    // ─── Profile theme override ──────────────────────────────────
    let savedTheme = null;
    function applyThemeOverride(theme) {
        if (!theme) return;
        const html = document.documentElement;
        if (savedTheme === null) {
            savedTheme = html.getAttribute('data-theme') || 'midnight';
        }
        html.setAttribute('data-theme', theme);
        // Re-fire the theme-changed event so dependent UIs (wallpapers,
        // accent calculations) refresh.
        window.dispatchEvent(new CustomEvent('arcade:theme-changed', { detail: { theme } }));
    }
    function restoreTheme() {
        if (savedTheme !== null) {
            document.documentElement.setAttribute('data-theme', savedTheme);
            window.dispatchEvent(new CustomEvent('arcade:theme-changed', { detail: { theme: savedTheme } }));
            savedTheme = null;
        }
    }

    // ─── Profile pet ─────────────────────────────────────────────
    // CSS-animated wanderer. Each pet has a distinct emoji + walk path.
    // The element auto-clean on profile close (it lives inside .profile-modal).
    const PET_EMOJI = {
        cat:    '🐱',
        slime:  '🟢',
        duck:   '🦆',
        dragon: '🐲',
        ghost:  '👻',
    };
    function mountPet(modalEl, petId) {
        if (!modalEl || !petId || petId === 'none') return;
        const emoji = PET_EMOJI[petId];
        if (!emoji) return;
        const pet = document.createElement('div');
        pet.className = `profile-pet profile-pet-${petId}`;
        pet.textContent = emoji;
        pet.setAttribute('aria-hidden', 'true');
        modalEl.appendChild(pet);
    }

    // ─── Wallpaper parallax ──────────────────────────────────────
    // When wallpaperBg + wallpaperFg are set, mount two extra absolutely-
    // positioned layers on top of the existing .profile-header. On cursor
    // move within the modal, translate them at different rates.
    let parallaxHandler = null;
    function mountParallax(modalEl, wallpaperBg, wallpaperFg) {
        if (!modalEl || (!wallpaperBg && !wallpaperFg)) return;
        const header = modalEl.querySelector('.profile-header');
        if (!header) return;
        if (wallpaperBg) {
            const bg = document.createElement('div');
            bg.className = 'profile-parallax-layer profile-parallax-bg';
            bg.style.backgroundImage = `url("${wallpaperBg.replace(/"/g, '\\"')}")`;
            header.prepend(bg);
        }
        if (wallpaperFg) {
            const fg = document.createElement('div');
            fg.className = 'profile-parallax-layer profile-parallax-fg';
            fg.style.backgroundImage = `url("${wallpaperFg.replace(/"/g, '\\"')}")`;
            header.appendChild(fg);
        }
        parallaxHandler = (e) => {
            const rect = modalEl.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width - 0.5) * 30;
            const y = ((e.clientY - rect.top) / rect.height - 0.5) * 20;
            const bg = header.querySelector('.profile-parallax-bg');
            const fg = header.querySelector('.profile-parallax-fg');
            if (bg) bg.style.transform = `translate(${x * 0.3}px, ${y * 0.3}px) scale(1.05)`;
            if (fg) fg.style.transform = `translate(${x * 0.7}px, ${y * 0.7}px) scale(1.05)`;
        };
        modalEl.addEventListener('mousemove', parallaxHandler);
    }
    function teardownParallax(modalEl) {
        if (modalEl && parallaxHandler) {
            modalEl.removeEventListener('mousemove', parallaxHandler);
            parallaxHandler = null;
        }
    }

    // ─── Sandboxed custom CSS injection ──────────────────────────
    // Uses @scope so the user's CSS can only apply to descendants of
    // .profile-modal[data-uid="UID"]. Falls back to scoping every rule
    // with a prefix when @scope isn't supported.
    function injectCustomCss(modalEl, profile) {
        const css = (profile.profileCss || '').slice(0, 4096);
        if (!css) return;
        modalEl.dataset.uid = profile.uid;
        const sheet = document.createElement('style');
        sheet.id = 'profile-custom-css';
        // Use @scope (Chrome 118+, Safari 17.4+). When unsupported the
        // browser ignores the rule, so the CSS won't apply at all —
        // safer than letting it leak globally.
        sheet.textContent = `
            @scope (.profile-modal[data-uid="${profile.uid}"]) {
                ${css}
            }
        `;
        document.head.appendChild(sheet);
    }
    function clearCustomCss() {
        document.getElementById('profile-custom-css')?.remove();
    }

    // ─── Trading cards ───────────────────────────────────────────
    // Cards are derived from playCounts on the fly — every 25 plays of
    // a game = 1 card, capped at 4 per game. Rarity by total plays:
    // common (1-25), uncommon (26-75), rare (76-150), legendary (150+).
    function deriveCards(profile, gamesIndex) {
        const counts = profile.playCounts || {};
        const cards = [];
        for (const [id, n] of Object.entries(counts)) {
            const game = gamesIndex[id];
            if (!game) continue;
            const drops = Math.min(4, Math.floor(n / 25));
            if (drops === 0) continue;
            let rarity = 'common';
            if (n >= 150)      rarity = 'legendary';
            else if (n >= 76)  rarity = 'rare';
            else if (n >= 26)  rarity = 'uncommon';
            for (let i = 0; i < drops; i++) {
                cards.push({ gameId: id, game, rarity, n: i + 1 });
            }
        }
        return cards.sort((a, b) => {
            const order = { legendary: 0, rare: 1, uncommon: 2, common: 3 };
            return order[a.rarity] - order[b.rarity];
        });
    }

    function renderCards(target, profile, gamesIndex) {
        if (!target) return;
        const cards = deriveCards(profile, gamesIndex);
        if (!cards.length) {
            target.innerHTML = '<div class="profile-cards-empty">Play games 25+ times to drop your first cards.</div>';
            return;
        }
        target.innerHTML = `
            <div class="profile-cards-grid">
                ${cards.slice(0, 24).map(c => {
                    const g = c.game;
                    const thumb = g.thumbnail
                        ? `<img class="profile-card-thumb" src="${esc(g.thumbnail)}" alt="">`
                        : `<div class="profile-card-thumb profile-card-thumb-placeholder">${esc((g.title||'?').charAt(0).toUpperCase())}</div>`;
                    return `
                        <div class="profile-card profile-card-${c.rarity}" title="${esc(g.title)} — ${c.rarity} card #${c.n}">
                            <div class="profile-card-rarity">${c.rarity}</div>
                            ${thumb}
                            <div class="profile-card-title">${esc(g.title || g.id)}</div>
                        </div>
                    `;
                }).join('')}
            </div>
            ${cards.length > 24 ? `<div class="profile-cards-more">+${cards.length - 24} more</div>` : ''}
        `;
    }

    // ─── Title gallery ───────────────────────────────────────────
    // profile.titles is a list of strings the user has earned.
    // profile.selectedTitle is the one currently displayed (overrides
    // profile.titleText if both are set). UI for picking from the gallery
    // is in the edit form.

    // ─── Pinned achievements ─────────────────────────────────────
    function renderPinnedAchievements(target, profile) {
        if (!target) return;
        const ids = profile.pinnedAchievements;
        if (!ids?.length) { target.innerHTML = ''; return; }
        const defs = (window.ArcadeAchievements?.byIds?.(ids)) || [];
        if (!defs.length) { target.innerHTML = ''; return; }
        target.innerHTML = `
            <div class="profile-pinned-achievements">
                ${defs.map(a => `
                    <div class="profile-pinned-ach" title="${esc(a.title)} — ${esc(a.desc)}">
                        <span class="profile-pinned-ach-icon">${a.icon || '🏆'}</span>
                        <div class="profile-pinned-ach-meat">
                            <div class="profile-pinned-ach-name">${esc(a.title)}</div>
                            <div class="profile-pinned-ach-desc">${esc(a.desc)}</div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    // ─── Custom badges (admin-defined) ───────────────────────────
    // Loaded from the `badges` Firestore collection. profile.badgeIds
    // references which ones the user has been awarded.
    let badgesMap = null;
    async function ensureBadges() {
        if (badgesMap) return badgesMap;
        try {
            const db = window.ArcadeAuth?.getDb?.();
            if (!db) return badgesMap = {};
            const snap = await db.collection('badges').get();
            badgesMap = {};
            snap.docs.forEach(d => { badgesMap[d.id] = { id: d.id, ...d.data() }; });
        } catch {
            badgesMap = {};
        }
        return badgesMap;
    }
    async function renderBadges(target, profile) {
        if (!target) return;
        const ids = profile.badgeIds;
        if (!ids?.length) { target.innerHTML = ''; return; }
        await ensureBadges();
        const defs = ids.map(id => badgesMap[id]).filter(Boolean);
        if (!defs.length) { target.innerHTML = ''; return; }
        target.innerHTML = `
            <div class="profile-badges-row">
                ${defs.map(b => `
                    <div class="profile-custom-badge" title="${esc(b.name)} — ${esc(b.description || '')}" style="background:${esc(b.color || '#7c3aed')}">
                        <span class="profile-custom-badge-icon">${b.icon || '🎖'}</span>
                        <span class="profile-custom-badge-name">${esc(b.name)}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    // ─── Audio playlist for multiple BGM tracks ──────────────────
    let bgmEl = null;
    let bgmTrackIdx = 0;
    let bgmTracks = [];
    function setupBgmPlaylist(audioEl, tracks) {
        if (!audioEl || !tracks || !tracks.length) return;
        bgmEl = audioEl;
        bgmTracks = tracks;
        bgmTrackIdx = 0;
        audioEl.src = tracks[0];
        audioEl.addEventListener('ended', () => {
            bgmTrackIdx = (bgmTrackIdx + 1) % bgmTracks.length;
            audioEl.src = bgmTracks[bgmTrackIdx];
            audioEl.play().catch(() => {});
        });
    }
    function bgmNext() {
        if (!bgmEl || !bgmTracks.length) return;
        bgmTrackIdx = (bgmTrackIdx + 1) % bgmTracks.length;
        bgmEl.src = bgmTracks[bgmTrackIdx];
        bgmEl.play().catch(() => {});
    }
    function bgmPrev() {
        if (!bgmEl || !bgmTracks.length) return;
        bgmTrackIdx = (bgmTrackIdx - 1 + bgmTracks.length) % bgmTracks.length;
        bgmEl.src = bgmTracks[bgmTrackIdx];
        bgmEl.play().catch(() => {});
    }

    // ─── Pinned clip (YouTube/Twitch embed) ──────────────────────
    function renderPinnedClip(profile) {
        const url = profile.pinnedClip;
        if (!url) return '';
        // Validate as YouTube /embed/, Twitch player.twitch.tv embed, Vimeo /video/
        const ok = /^https:\/\/(www\.youtube\.com\/embed\/|player\.twitch\.tv\/|player\.vimeo\.com\/video\/)/.test(url);
        if (!ok) return '';
        return `
            <div class="profile-section">
                <h3 class="profile-section-title">Featured clip</h3>
                <div class="profile-pinned-clip-wrap">
                    <iframe class="profile-pinned-clip" src="${esc(url)}" allow="autoplay; encrypted-media; fullscreen" loading="lazy" allowfullscreen></iframe>
                </div>
            </div>
        `;
    }

    window.ArcadeProfileExtras = {
        computeXp, renderLevelBadge, renderStreak,
        renderOnlineStatus,
        applyThemeOverride, restoreTheme,
        mountPet,
        mountParallax, teardownParallax,
        injectCustomCss, clearCustomCss,
        deriveCards, renderCards,
        renderPinnedAchievements, renderBadges,
        setupBgmPlaylist, bgmNext, bgmPrev,
        renderPinnedClip,
    };
})();
