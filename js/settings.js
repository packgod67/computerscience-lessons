// Arcade-wide user customization.
//
// Sits ON TOP of themes.js (which still owns the theme-preset + wallpaper +
// accent stack). Settings here are the layout / typography / behavior
// knobs that don't belong in the theme system.
//
// Persistence:
//   - All settings live in localStorage under `arcade-settings` (one
//     JSON blob).
//   - When the user is signed in, the same blob is also mirrored to
//     `users/{uid}.settings` so it follows them across devices.
//   - On boot we hydrate from localStorage immediately (zero flicker),
//     then quietly merge in any newer Firestore-side blob.
//
// Applied via:
//   - CSS classes on <body>: `density-*`, `view-*`, `cards-*`, `font-*`,
//     `no-transparency`, `theme-no-motion`.
//   - A user-supplied <style id="arcade-user-css"> tag injected into
//     <head> for the custom-CSS escape hatch.
//
// Modules listen for `arcade:settings-changed` to re-render. App.js
// uses this to honor pinned/hidden games on the home grid; tabs.js
// uses it to honor tab order + visibility.

(function () {
    const KEY = 'arcade-settings';
    const SCHEMA_VERSION = 1;

    // ─── Defaults ────────────────────────────────────────────────────
    const DEFAULTS = {
        v: SCHEMA_VERSION,
        // Layout & density
        density: 'comfortable',           // compact | comfortable | spacious
        viewMode: 'grid',                 // grid | list | detailed
        cardStyle: 'standard',            // standard | minimal | detailed | trading-card
        // Typography
        fontFamily: 'system',             // system|mono|pixel|serif|rounded|handwritten|futuristic|elegant
        fontScale: 1.0,                   // 0.85, 1.0, 1.15, 1.3 (×base)
        dyslexicMode: false,              // separate toggle that overlays a wider font + spacing
        // Motion / transparency
        reducedMotion: false,             // disables animations
        reducedTransparency: false,       // disables backdrop-filter / glass
        // UI feedback
        uiSounds: false,                  // tiny click sound on button presses
        // Tab order + visibility
        tabOrder: ['games','users','gallery','chat','messages','friends','saves','requests'],
        tabHidden: [],                    // ids in tabOrder that are hidden
        // Home grid sections (id -> visible)
        homeSections: {
            continuePlaying: true,
            categories: true,
            new: true,
            random: true,
        },
        // Catalog personalization
        pinnedGames: [],                  // gameIds always at top
        hiddenGames: [],                  // gameIds never shown
        // Power-user
        customCss: '',                    // <= 16 KiB
        // Per-theme wallpaper overrides — { themeId: 'data:...'|'https://...' }.
        // NOT mirrored to Firestore (data URLs can be huge — would blow
        // past Firestore's 1 MB doc limit). Stays in localStorage so it's
        // per-device.
        themeWallpapers: {},
    };

    // ─── Storage ─────────────────────────────────────────────────────
    function load() {
        let s = {};
        try {
            const raw = localStorage.getItem(KEY);
            if (raw) s = JSON.parse(raw);
        } catch {}
        return Object.assign({}, DEFAULTS, s, {
            // Re-merge nested objects (so newly-added defaults appear
            // even on existing saves)
            homeSections: Object.assign({}, DEFAULTS.homeSections, s.homeSections || {}),
        });
    }
    function save(s) {
        try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
        // Mirror to Firestore (best-effort, debounced).
        debouncedRemoteSync(s);
    }
    let _remoteTimer = null;
    function debouncedRemoteSync(s) {
        clearTimeout(_remoteTimer);
        _remoteTimer = setTimeout(async () => {
            try {
                const db = window.ArcadeAuth?.getDb?.();
                const uid = window.ArcadeAuth?.getUser?.()?.uid;
                if (!db || !uid) return;
                // Strip themeWallpapers — they're too big for Firestore
                // (1 MB doc cap; data URLs are routinely 4-6 MB). Per-
                // device storage is fine for these.
                const remoteSafe = Object.assign({}, s);
                delete remoteSafe.themeWallpapers;
                await db.collection('users').doc(uid).set({ settings: remoteSafe }, { merge: true });
            } catch {}
        }, 1200);
    }

    let SETTINGS = load();

    // ─── Apply ──────────────────────────────────────────────────────
    function apply() {
        const body = document.body;
        const root = document.documentElement;
        if (!body || !root) return;

        // Density
        body.classList.remove('density-compact', 'density-comfortable', 'density-spacious');
        body.classList.add('density-' + SETTINGS.density);

        // View mode
        body.classList.remove('view-grid', 'view-list', 'view-detailed');
        body.classList.add('view-' + SETTINGS.viewMode);

        // Card style
        body.classList.remove('cards-standard', 'cards-minimal', 'cards-detailed', 'cards-trading');
        const cs = SETTINGS.cardStyle === 'trading-card' ? 'trading' : SETTINGS.cardStyle;
        body.classList.add('cards-' + cs);

        // Font family
        body.classList.remove(
            'font-system','font-mono','font-pixel','font-serif',
            'font-rounded','font-handwritten','font-futuristic','font-elegant',
            'font-dyslexic' /* legacy class — clean up old saves */
        );
        // Coerce deprecated 'dyslexic' value (from older saves) into
        // the new system: switch to 'system' font + auto-enable
        // dyslexicMode toggle. Keeps users who were on the old option
        // from getting "stuck" on dyslexic font with no way out.
        if (SETTINGS.fontFamily === 'dyslexic') {
            SETTINGS.fontFamily = 'system';
            SETTINGS.dyslexicMode = true;
        }
        body.classList.add('font-' + SETTINGS.fontFamily);

        // Dyslexia mode is independent of font family
        body.classList.toggle('dyslexic-mode', !!SETTINGS.dyslexicMode);

        // Font scale (CSS var)
        root.style.setProperty('--font-scale', String(SETTINGS.fontScale || 1));

        // Motion
        body.classList.toggle('theme-no-motion', !!SETTINGS.reducedMotion);

        // Transparency
        body.classList.toggle('no-transparency', !!SETTINGS.reducedTransparency);

        // UI sounds (handled at click time)
        body.dataset.uiSounds = SETTINGS.uiSounds ? '1' : '0';

        // Custom CSS injection
        let styleEl = document.getElementById('arcade-user-css');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'arcade-user-css';
            document.head.appendChild(styleEl);
        }
        // Cap to 16 KiB so a runaway paste doesn't tank the page.
        styleEl.textContent = (SETTINGS.customCss || '').slice(0, 16384);

        // Per-theme wallpaper override
        applyThemeWallpaper();

        // Notify other modules
        try {
            window.dispatchEvent(new CustomEvent('arcade:settings-changed', {
                detail: { settings: getSnapshot() }
            }));
        } catch {}
    }

    // ─── Per-theme wallpaper override ───────────────────────────────
    // For the currently-active theme, if the user has uploaded or
    // pasted a wallpaper URL, inject a CSS rule that overrides the
    // theme's body background AND suppresses any decorative
    // pseudo-elements (matrix code rain, galaxy stars, etc) so the
    // wallpaper isn't fighting with them.
    //
    // "Revert to default" just removes the override and re-runs apply,
    // which clears the injected style and the theme's own decorations
    // come back unchanged.
    // Sniff whether a stored wallpaper string is a video (mp4/webm/mov).
    // Both data URLs (`data:video/...`) and ordinary URLs (`*.mp4`,
    // `*.webm`) are considered. Anything else (including GIF + APNG)
    // falls through to the image path, which is what we want — animated
    // GIFs animate just fine in CSS background-image, no video element
    // needed.
    function isVideoWallpaper(url) {
        if (!url) return false;
        const s = String(url);
        if (/^data:video\//i.test(s)) return true;
        if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(s)) return true;
        return false;
    }

    function applyThemeWallpaper() {
        let style = document.getElementById('arcade-theme-wallpaper');
        if (!style) {
            style = document.createElement('style');
            style.id = 'arcade-theme-wallpaper';
            document.head.appendChild(style);
        }
        const themeId = document.documentElement.getAttribute('data-theme') || 'midnight';
        const wp = SETTINGS.themeWallpapers || {};
        const url = wp[themeId];

        // Always tear down the video element first (it's wrong for image
        // wallpapers, and tearing down on every apply() keeps state clean
        // when the user switches between video and image wallpapers).
        const oldVideo = document.getElementById('arcade-wallpaper-video');
        if (oldVideo) oldVideo.remove();

        if (!url) {
            style.textContent = '';
            return;
        }

        if (isVideoWallpaper(url)) {
            // Video wallpaper — render a <video> behind the body content.
            // CSS `background: url(<mp4>)` would silently fail — only
            // images work in CSS background-image.
            const video = document.createElement('video');
            video.id = 'arcade-wallpaper-video';
            video.src = url;
            video.autoplay = true;
            video.loop = true;
            video.muted = true;
            video.playsInline = true;
            video.setAttribute('aria-hidden', 'true');
            document.body.prepend(video);
            // Suppress decorative pseudo-elements on the active theme +
            // give the body a transparent background so the video shows.
            style.textContent = `
                html[data-theme="${themeId}"] body {
                    background: #000 !important;
                }
                html[data-theme="${themeId}"] body::before,
                html[data-theme="${themeId}"] body::after {
                    display: none !important;
                }
                #arcade-wallpaper-video {
                    position: fixed;
                    inset: 0;
                    width: 100%; height: 100%;
                    object-fit: cover;
                    z-index: -1;
                    pointer-events: none;
                }
            `;
            return;
        }

        // Image / GIF / APNG wallpaper — CSS background-image animates
        // GIF + APNG natively, so nothing special needed beyond the
        // `cover` sizing keyword for auto-fit.
        const safeUrl = String(url).replace(/"/g, '\\"');
        // Use !important to beat any inline body backgrounds that
        // themes.js sets via setProperty (the bg radial-gradient
        // stack on dark themes).
        style.textContent = `
            html[data-theme="${themeId}"] body {
                background:
                    url("${safeUrl}") center center / cover no-repeat fixed,
                    #000 !important;
            }
            html[data-theme="${themeId}"] body::before,
            html[data-theme="${themeId}"] body::after {
                display: none !important;
            }
        `;
    }
    // Re-apply wallpaper override whenever the user picks a new theme
    // (the wallpaper choice is per-theme, so each theme has its own).
    window.addEventListener('arcade:theme-changed', () => {
        applyThemeWallpaper();
    });

    function getSnapshot() {
        // Clone so callers can't accidentally mutate our state.
        return JSON.parse(JSON.stringify(SETTINGS));
    }

    function set(patch) {
        SETTINGS = Object.assign({}, SETTINGS, patch);
        save(SETTINGS);
        apply();
    }

    // ─── Pin / hide helpers ─────────────────────────────────────────
    function togglePin(gameId) {
        if (!gameId) return;
        const pinned = SETTINGS.pinnedGames.slice();
        const i = pinned.indexOf(gameId);
        if (i >= 0) pinned.splice(i, 1);
        else pinned.unshift(gameId);
        // Trim to 30 — beyond that the home grid is no longer "pinned"
        if (pinned.length > 30) pinned.length = 30;
        set({ pinnedGames: pinned });
    }
    function isPinned(gameId) {
        return SETTINGS.pinnedGames.includes(gameId);
    }
    function toggleHide(gameId) {
        if (!gameId) return;
        const hidden = SETTINGS.hiddenGames.slice();
        const i = hidden.indexOf(gameId);
        if (i >= 0) hidden.splice(i, 1);
        else hidden.push(gameId);
        set({ hiddenGames: hidden });
    }
    function isHidden(gameId) {
        return SETTINGS.hiddenGames.includes(gameId);
    }

    // ─── UI sound (tiny synthesized click) ──────────────────────────
    let _audioCtx = null;
    function clickSound() {
        if (!SETTINGS.uiSounds) return;
        try {
            if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const ctx = _audioCtx;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.06);
            gain.gain.setValueAtTime(0.04, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.07);
            osc.connect(gain).connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.08);
        } catch {}
    }
    // Delegated click sound on common interactive elements
    document.addEventListener('click', (e) => {
        if (!SETTINGS.uiSounds) return;
        const t = e.target.closest?.('button, .tab-btn, .cat-btn, .game-card, a.continue-card, .auth-submit');
        if (t) clickSound();
    }, true);

    // ─── Settings modal ─────────────────────────────────────────────
    function openSettingsModal() {
        const existing = document.getElementById('arcadeSettingsModal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'arcadeSettingsModal';
        overlay.className = 'modal-overlay arcade-settings-overlay';

        overlay.innerHTML = `
            <div class="arcade-settings-modal">
                <button class="modal-close arcade-settings-close" id="arcadeSettingsCloseBtn">&times;</button>
                <h2 class="arcade-settings-title">Settings</h2>
                <div class="arcade-settings-tabs" role="tablist">
                    <button class="arcade-settings-tab is-active" data-pane="appearance">Appearance</button>
                    <button class="arcade-settings-tab" data-pane="layout">Layout</button>
                    <button class="arcade-settings-tab" data-pane="catalog">Catalog</button>
                    <button class="arcade-settings-tab" data-pane="advanced">Advanced</button>
                </div>
                <div class="arcade-settings-pane" id="arcadeSettingsPane"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        document.getElementById('arcadeSettingsCloseBtn').addEventListener('click', () => overlay.remove());

        const paneEl = document.getElementById('arcadeSettingsPane');
        let activeTab = 'appearance';
        function paint() {
            if (activeTab === 'appearance') paintAppearance(paneEl);
            else if (activeTab === 'layout') paintLayout(paneEl);
            else if (activeTab === 'catalog') paintCatalog(paneEl);
            else paintAdvanced(paneEl);
        }
        overlay.querySelectorAll('.arcade-settings-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.querySelectorAll('.arcade-settings-tab').forEach(b => b.classList.remove('is-active'));
                btn.classList.add('is-active');
                activeTab = btn.dataset.pane;
                paint();
            });
        });
        paint();
    }

    // ─── Pane: Appearance ───────────────────────────────────────────
    function paintAppearance(pane) {
        const presets = [
            // Standard color palettes
            { id: 'midnight', label: 'Midnight (default)' },
            { id: 'ocean', label: 'Ocean' },
            { id: 'crimson', label: 'Crimson' },
            { id: 'forest', label: 'Forest' },
            { id: 'sunset', label: 'Sunset' },
            { id: 'synthwave', label: 'Synthwave' },
            { id: 'sakura', label: 'Sakura' },
            { id: 'oled', label: 'OLED Black' },
            { id: 'nord', label: 'Nord' },
            { id: 'monokai', label: 'Monokai' },
            { id: 'light', label: 'Light' },
            { id: 'pastel', label: 'Pastel' },
            { id: 'highcontrast', label: 'High Contrast' },
            // Effect-driven
            { id: 'crt',          label: 'Retro CRT \u{1F4FA}' },
            { id: 'glitch',       label: 'Glitch \u{26A1}' },
            { id: 'matrix',       label: 'Matrix \u{1F7E2}' },
            { id: 'vaporwave',    label: 'Vaporwave \u{1F30A}' },
            { id: 'cyberpunk',    label: 'Cyberpunk \u{1F4A1}' },
            { id: 'aurora',       label: 'Aurora \u{1F30C}' },
            { id: 'amber',        label: 'Amber Terminal \u{1F7E0}' },
            { id: 'galaxy',       label: 'Galaxy \u{2728}' },
            { id: 'blackhole',    label: 'Black Hole \u{1F573}\u{FE0F}' },
            { id: 'holographic',  label: 'Holographic \u{1F308}' },
        ];
        const currentTheme = window.ArcadeThemes?.getCurrentTheme?.() || 'midnight';

        pane.innerHTML = `
            <section class="arcade-settings-section">
                <h3>Theme</h3>
                <div class="arcade-settings-themes">
                    ${presets.map(p => `
                        <button class="arcade-settings-theme${currentTheme === p.id ? ' is-active' : ''}" data-theme="${p.id}">
                            <span class="arcade-settings-theme-swatch" data-swatch="${p.id}"></span>
                            <span>${p.label}</span>
                        </button>
                    `).join('')}
                </div>
            </section>

            <section class="arcade-settings-section">
                <h3>Wallpaper for current theme</h3>
                <p class="arcade-settings-help">Override the active theme's background with your own image, GIF, or video URL. Each theme has its own override slot — switching themes brings the matching wallpaper back. Stored on this device only (too big to sync).</p>
                <div class="arcade-settings-wp-dropzone" id="setWpDropzone" tabindex="0">
                    <div class="arcade-settings-wp-dropzone-hint">
                        <span class="arcade-settings-wp-dropzone-icon">&#128247;</span>
                        Drop an image / GIF / video here, paste from clipboard (Ctrl+V), or use the buttons below.
                    </div>
                </div>
                <div class="arcade-settings-row arcade-settings-wp-row" id="setWpRow">
                    <button class="auth-submit" id="setWpUpload" type="button">Upload file…</button>
                    <button class="auth-submit-secondary" id="setWpUrl" type="button">Paste URL</button>
                    <button class="auth-submit-secondary" id="setWpClear" type="button" style="display:none;">Revert to default</button>
                </div>
                <div class="arcade-settings-wp-status" id="setWpStatus"></div>
            </section>

            <section class="arcade-settings-section">
                <h3>Font</h3>
                <div class="arcade-settings-row">
                    <label>Family</label>
                    <select id="setFontFamily">
                        <option value="system">System (default)</option>
                        <option value="mono">Monospace</option>
                        <option value="pixel">Pixel (Press Start 2P)</option>
                        <option value="serif">Serif</option>
                        <option value="rounded">Rounded (Comic)</option>
                        <option value="handwritten">Handwritten (Caveat)</option>
                        <option value="futuristic">Futuristic (Orbitron)</option>
                        <option value="elegant">Elegant (Cinzel)</option>
                    </select>
                </div>
                <div class="arcade-settings-row">
                    <label>Size</label>
                    <select id="setFontScale">
                        <option value="0.85">Small</option>
                        <option value="1">Default</option>
                        <option value="1.15">Large</option>
                        <option value="1.3">Extra large</option>
                    </select>
                </div>
                <label class="arcade-settings-checkbox">
                    <input type="checkbox" id="setDyslexicMode">
                    Dyslexia-friendly mode
                    <span class="arcade-settings-help" style="margin:0 0 0 6px;">— overrides font with Atkinson Hyperlegible + wider spacing</span>
                </label>
            </section>

            <section class="arcade-settings-section">
                <h3>Motion &amp; transparency</h3>
                <label class="arcade-settings-checkbox">
                    <input type="checkbox" id="setReducedMotion"> Reduce animations
                </label>
                <label class="arcade-settings-checkbox">
                    <input type="checkbox" id="setReducedTransparency"> Reduce transparency / glass effects
                </label>
                <label class="arcade-settings-checkbox">
                    <input type="checkbox" id="setUiSounds"> UI click sounds
                </label>
            </section>
        `;

        // Theme picker
        pane.querySelectorAll('.arcade-settings-theme').forEach(btn => {
            btn.addEventListener('click', () => {
                window.ArcadeThemes?.applyTheme?.(btn.dataset.theme);
                pane.querySelectorAll('.arcade-settings-theme').forEach(b => b.classList.remove('is-active'));
                btn.classList.add('is-active');
            });
        });
        pane.querySelectorAll('[data-swatch]').forEach(el => {
            el.style.background = swatchFor(el.dataset.swatch);
        });

        // Selects
        const ff = pane.querySelector('#setFontFamily');
        ff.value = SETTINGS.fontFamily;
        ff.addEventListener('change', () => set({ fontFamily: ff.value }));

        const fs = pane.querySelector('#setFontScale');
        fs.value = String(SETTINGS.fontScale);
        fs.addEventListener('change', () => set({ fontScale: parseFloat(fs.value) }));

        const rm = pane.querySelector('#setReducedMotion');
        rm.checked = !!SETTINGS.reducedMotion;
        rm.addEventListener('change', () => set({ reducedMotion: rm.checked }));

        const rt = pane.querySelector('#setReducedTransparency');
        rt.checked = !!SETTINGS.reducedTransparency;
        rt.addEventListener('change', () => set({ reducedTransparency: rt.checked }));

        const sn = pane.querySelector('#setUiSounds');
        sn.checked = !!SETTINGS.uiSounds;
        sn.addEventListener('change', () => set({ uiSounds: sn.checked }));

        const dy = pane.querySelector('#setDyslexicMode');
        if (dy) {
            dy.checked = !!SETTINGS.dyslexicMode;
            dy.addEventListener('change', () => set({ dyslexicMode: dy.checked }));
        }

        // ─── Per-theme wallpaper controls ─────────────────────────
        wireWallpaperControls(pane);

        // Wallpaper buttons need to refresh whenever the user picks
        // a different theme (since each theme has its own override).
        function onThemeChange() { refreshWallpaperUi(pane); }
        window.addEventListener('arcade:theme-changed', onThemeChange);
        // Clean up listener if pane is replaced (we don't have a
        // formal teardown; modal close removes the pane node).
        const obs = new MutationObserver(() => {
            if (!document.body.contains(pane)) {
                window.removeEventListener('arcade:theme-changed', onThemeChange);
                obs.disconnect();
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    // ─── Per-theme wallpaper UI handlers ───────────────────────────
    function refreshWallpaperUi(pane) {
        const themeId = document.documentElement.getAttribute('data-theme') || 'midnight';
        const wp = SETTINGS.themeWallpapers || {};
        const cur = wp[themeId];
        const status = pane.querySelector('#setWpStatus');
        const clearBtn = pane.querySelector('#setWpClear');
        if (!status || !clearBtn) return;
        if (cur) {
            const isData = cur.startsWith('data:');
            const summary = isData
                ? 'Custom upload (' + Math.round(cur.length / 1024) + ' KB)'
                : cur.length > 60 ? cur.slice(0, 60) + '…' : cur;
            status.textContent = 'Active: ' + summary;
            clearBtn.style.display = '';
        } else {
            status.textContent = 'Using the theme\'s default background.';
            clearBtn.style.display = 'none';
        }
    }

    // Common path: take a File (from input/clipboard/drop), validate +
    // read it into a data URL, persist as the active theme's wallpaper,
    // refresh the settings UI. Returns true on success.
    async function applyFileAsWallpaper(file, pane) {
        if (!file) return false;
        const themeId = document.documentElement.getAttribute('data-theme') || 'midnight';
        // Reject non-image/non-video silently — drop events deliver any
        // file type, including text and folders, and we don't want a
        // .pdf becoming the wallpaper.
        if (!/^(image|video)\//.test(file.type || '')) {
            alert('That file isn\'t an image or video.');
            return false;
        }
        // 8 MB hard cap — localStorage typically tops out at 5-10 MB
        // per origin. Beyond that the next set() throws QuotaExceeded.
        if (file.size > 8 * 1024 * 1024) {
            alert('That file is ' + Math.round(file.size / 1024 / 1024) + ' MB. Local storage caps around 5–10 MB; please host the file externally and use the "Paste URL" button.');
            return false;
        }
        try {
            const dataUrl = await fileToDataUrl(file);
            const wp = Object.assign({}, SETTINGS.themeWallpapers || {});
            wp[themeId] = dataUrl;
            try {
                set({ themeWallpapers: wp });
            } catch (e) {
                // localStorage quota exceeded — settings.set saves
                // synchronously, so we can catch and surface here.
                alert('Couldn\'t save — local storage is full. Try a smaller file or use the URL option.');
                return false;
            }
            refreshWallpaperUi(pane);
            return true;
        } catch (e) {
            alert('Upload failed: ' + (e?.message || e));
            return false;
        }
    }

    function wireWallpaperControls(pane) {
        const upload = pane.querySelector('#setWpUpload');
        const urlBtn = pane.querySelector('#setWpUrl');
        const clear = pane.querySelector('#setWpClear');
        const dropzone = pane.querySelector('#setWpDropzone');
        if (!upload || !urlBtn || !clear) return;

        upload.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*,video/*,.gif,.webm,.mp4';
            input.style.display = 'none';
            document.body.appendChild(input);
            input.addEventListener('change', async () => {
                const file = input.files?.[0];
                input.remove();
                if (!file) return;
                upload.disabled = true;
                upload.textContent = 'Reading…';
                await applyFileAsWallpaper(file, pane);
                upload.disabled = false;
                upload.textContent = 'Upload file…';
            });
            input.click();
        });

        urlBtn.addEventListener('click', () => {
            const themeId = document.documentElement.getAttribute('data-theme') || 'midnight';
            const url = prompt('Paste an image / GIF / MP4 / WebM URL:', '');
            if (!url || !url.trim()) return;
            const wp = Object.assign({}, SETTINGS.themeWallpapers || {});
            wp[themeId] = url.trim();
            set({ themeWallpapers: wp });
            refreshWallpaperUi(pane);
        });

        clear.addEventListener('click', () => {
            const themeId = document.documentElement.getAttribute('data-theme') || 'midnight';
            const wp = Object.assign({}, SETTINGS.themeWallpapers || {});
            delete wp[themeId];
            set({ themeWallpapers: wp });
            refreshWallpaperUi(pane);
        });

        // ─── Drag-and-drop on the dropzone ──────────────────────────
        if (dropzone) {
            ['dragenter', 'dragover'].forEach(evt => {
                dropzone.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropzone.classList.add('is-dragover');
                });
            });
            ['dragleave', 'drop'].forEach(evt => {
                dropzone.addEventListener(evt, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dropzone.classList.remove('is-dragover');
                });
            });
            dropzone.addEventListener('drop', async (e) => {
                const dt = e.dataTransfer;
                if (!dt) return;
                // Files first (drag-from-OS), then URI list (drag from
                // another browser tab which gives us a URL string).
                const file = dt.files && dt.files[0];
                if (file) {
                    await applyFileAsWallpaper(file, pane);
                    return;
                }
                const urlList = dt.getData('text/uri-list') || dt.getData('text/plain');
                if (urlList) {
                    const u = urlList.trim().split(/\s+/)[0];
                    if (/^https?:\/\//i.test(u)) {
                        const themeId = document.documentElement.getAttribute('data-theme') || 'midnight';
                        const wp = Object.assign({}, SETTINGS.themeWallpapers || {});
                        wp[themeId] = u;
                        set({ themeWallpapers: wp });
                        refreshWallpaperUi(pane);
                    }
                }
            });

            // ─── Clipboard paste (Ctrl+V on the dropzone or its
            // container while it has focus) ─────────────────────────
            // We listen on the dropzone (focusable via tabindex="0")
            // AND on the modal container as a whole, so the user can
            // paste anywhere in the settings panel without having to
            // tab into the dropzone first.
            const onPaste = async (e) => {
                const items = e.clipboardData?.items;
                if (!items) return;
                for (const it of items) {
                    if (it.kind === 'file') {
                        const file = it.getAsFile();
                        if (file) {
                            e.preventDefault();
                            await applyFileAsWallpaper(file, pane);
                            return;
                        }
                    }
                }
                // No file in clipboard — try a URL string
                const text = e.clipboardData.getData('text/plain');
                if (text && /^https?:\/\//i.test(text.trim())) {
                    const u = text.trim().split(/\s+/)[0];
                    e.preventDefault();
                    const themeId = document.documentElement.getAttribute('data-theme') || 'midnight';
                    const wp = Object.assign({}, SETTINGS.themeWallpapers || {});
                    wp[themeId] = u;
                    set({ themeWallpapers: wp });
                    refreshWallpaperUi(pane);
                }
            };
            dropzone.addEventListener('paste', onPaste);
            // Modal-wide paste — only fires when the settings modal is
            // the active container (paste events bubble to document).
            // Scoped via the pane node so we don't leak past close.
            pane.addEventListener('paste', onPaste);

            // Click the dropzone → triggers the file picker (so users
            // who don't know about drag-and-drop still get a hint).
            dropzone.addEventListener('click', () => upload.click());
        }

        // Initial state
        refreshWallpaperUi(pane);
    }

    function fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => reject(new Error('read failed'));
            r.readAsDataURL(file);
        });
    }

    function swatchFor(themeId) {
        const map = {
            midnight: 'linear-gradient(135deg,#7c3aed,#06b6d4)',
            ocean: 'linear-gradient(135deg,#0ea5e9,#22d3ee)',
            crimson: 'linear-gradient(135deg,#ef4444,#f97316)',
            forest: 'linear-gradient(135deg,#22c55e,#84cc16)',
            sunset: 'linear-gradient(135deg,#f59e0b,#ec4899)',
            synthwave: 'linear-gradient(135deg,#ff2e9a,#01f9ff)',
            sakura: 'linear-gradient(135deg,#ec4899,#fb7185)',
            oled: 'linear-gradient(135deg,#0a0a0a,#a78bfa)',
            nord: 'linear-gradient(135deg,#88c0d0,#81a1c1)',
            monokai: 'linear-gradient(135deg,#a6e22e,#f92672)',
            light: 'linear-gradient(135deg,#f4f4f5,#7c3aed)',
            crt: 'linear-gradient(135deg,#001100,#00ff66)',
            pastel: 'linear-gradient(135deg,#fbcfe8,#a78bfa)',
            highcontrast: 'linear-gradient(135deg,#000,#ffff00)',
            // Effect themes — swatches hint at their visual signature
            glitch: 'linear-gradient(135deg,#ff006e 0%,#ff006e 33%,#00f0ff 67%,#00f0ff 100%)',
            matrix: 'linear-gradient(180deg,#000000,#00ff41)',
            vaporwave: 'linear-gradient(135deg,#ff77e9,#66e2ff)',
            cyberpunk: 'linear-gradient(135deg,#ff2a6d,#fcee0a 50%,#05d9e8)',
            aurora: 'linear-gradient(135deg,#22d3ee,#a855f7,#22c55e)',
            amber: 'linear-gradient(135deg,#1a0e00,#ffb000)',
            galaxy: 'radial-gradient(circle at 30% 30%,#fff 1%,transparent 2%),radial-gradient(circle at 70% 70%,#fff 1%,transparent 2%),linear-gradient(135deg,#03001e,#1a0080)',
            blackhole: 'radial-gradient(circle at 50% 50%,#000 28%,#cce8ff 32%,#88ddff 40%,#5530a0 70%,#000 100%)',
            holographic: 'linear-gradient(135deg,#ff00ff,#00ffff,#ffff00,#ff00ff)',
        };
        return map[themeId] || map.midnight;
    }

    // ─── Pane: Layout ───────────────────────────────────────────────
    function paintLayout(pane) {
        pane.innerHTML = `
            <section class="arcade-settings-section">
                <h3>Density</h3>
                <div class="arcade-settings-radios">
                    ${['compact','comfortable','spacious'].map(d => `
                        <label class="arcade-settings-radio">
                            <input type="radio" name="density" value="${d}" ${SETTINGS.density===d?'checked':''}>
                            <span>${d.charAt(0).toUpperCase() + d.slice(1)}</span>
                        </label>
                    `).join('')}
                </div>
            </section>

            <section class="arcade-settings-section">
                <h3>View mode</h3>
                <div class="arcade-settings-radios">
                    ${[['grid','Grid'],['list','List'],['detailed','Detailed list']].map(([v,l]) => `
                        <label class="arcade-settings-radio">
                            <input type="radio" name="viewMode" value="${v}" ${SETTINGS.viewMode===v?'checked':''}>
                            <span>${l}</span>
                        </label>
                    `).join('')}
                </div>
            </section>

            <section class="arcade-settings-section">
                <h3>Card style</h3>
                <div class="arcade-settings-radios">
                    ${[['standard','Standard'],['minimal','Thumbnail-only'],['detailed','Show description'],['trading-card','Trading card']].map(([v,l]) => `
                        <label class="arcade-settings-radio">
                            <input type="radio" name="cardStyle" value="${v}" ${SETTINGS.cardStyle===v?'checked':''}>
                            <span>${l}</span>
                        </label>
                    `).join('')}
                </div>
            </section>

            <section class="arcade-settings-section">
                <h3>Tab bar</h3>
                <p class="arcade-settings-help">Drag to reorder. Uncheck to hide.</p>
                <ul class="arcade-settings-taborder" id="setTabOrder">
                    ${SETTINGS.tabOrder.map(id => `
                        <li class="arcade-settings-tabitem" draggable="true" data-id="${id}">
                            <span class="arcade-settings-grip">⋮⋮</span>
                            <input type="checkbox" ${SETTINGS.tabHidden.includes(id)?'':'checked'} data-toggle="${id}">
                            <span class="arcade-settings-tab-label">${id.charAt(0).toUpperCase() + id.slice(1)}</span>
                        </li>
                    `).join('')}
                </ul>
            </section>

            <section class="arcade-settings-section">
                <h3>Home page sections</h3>
                ${[['continuePlaying','Continue Playing strip'],['categories','Category bar'],['new','NEW games at top'],['random','Random Picks']].map(([k,l]) => `
                    <label class="arcade-settings-checkbox">
                        <input type="checkbox" data-section="${k}" ${SETTINGS.homeSections[k]?'checked':''}>
                        ${l}
                    </label>
                `).join('')}
            </section>
        `;

        // Density
        pane.querySelectorAll('input[name=density]').forEach(r => {
            r.addEventListener('change', () => { if (r.checked) set({ density: r.value }); });
        });
        pane.querySelectorAll('input[name=viewMode]').forEach(r => {
            r.addEventListener('change', () => { if (r.checked) set({ viewMode: r.value }); });
        });
        pane.querySelectorAll('input[name=cardStyle]').forEach(r => {
            r.addEventListener('change', () => { if (r.checked) set({ cardStyle: r.value }); });
        });

        // Tab order: drag-and-drop + visibility
        const tabUl = pane.querySelector('#setTabOrder');
        let dragId = null;
        tabUl.querySelectorAll('.arcade-settings-tabitem').forEach(li => {
            li.addEventListener('dragstart', () => { dragId = li.dataset.id; li.classList.add('is-dragging'); });
            li.addEventListener('dragend', () => { dragId = null; li.classList.remove('is-dragging'); });
            li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
            li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
            li.addEventListener('drop', (e) => {
                e.preventDefault();
                li.classList.remove('drag-over');
                if (!dragId || dragId === li.dataset.id) return;
                const order = Array.from(tabUl.querySelectorAll('.arcade-settings-tabitem')).map(x => x.dataset.id);
                const fromIdx = order.indexOf(dragId);
                const toIdx = order.indexOf(li.dataset.id);
                order.splice(toIdx, 0, order.splice(fromIdx, 1)[0]);
                set({ tabOrder: order });
                paintLayout(pane); // re-render
            });
        });
        tabUl.querySelectorAll('input[type=checkbox][data-toggle]').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = cb.dataset.toggle;
                let hidden = SETTINGS.tabHidden.slice();
                if (cb.checked) hidden = hidden.filter(x => x !== id);
                else if (!hidden.includes(id)) hidden.push(id);
                set({ tabHidden: hidden });
            });
        });

        // Home sections
        pane.querySelectorAll('input[type=checkbox][data-section]').forEach(cb => {
            cb.addEventListener('change', () => {
                const k = cb.dataset.section;
                set({ homeSections: Object.assign({}, SETTINGS.homeSections, { [k]: cb.checked }) });
            });
        });
    }

    // ─── Pane: Catalog ──────────────────────────────────────────────
    function paintCatalog(pane) {
        const games = (window.ArcadeApp?.getGames?.() || []);
        const byId = {};
        for (const g of games) byId[g.id] = g;

        const pinned = (SETTINGS.pinnedGames || []).map(id => byId[id]).filter(Boolean);
        const hidden = (SETTINGS.hiddenGames || []).map(id => byId[id]).filter(Boolean);

        function renderRow(g, kind) {
            const thumb = g.thumbnail
                ? `<img class="arcade-settings-row-thumb" src="${g.thumbnail}" alt="">`
                : `<div class="arcade-settings-row-thumb arcade-settings-row-thumb-placeholder">${(g.title||'?').charAt(0).toUpperCase()}</div>`;
            return `
                <li class="arcade-settings-row-item" data-id="${g.id}">
                    ${thumb}
                    <span class="arcade-settings-row-title">${g.title||g.id}</span>
                    <button class="arcade-settings-row-remove" data-${kind}="${g.id}" title="Remove from ${kind}">&times;</button>
                </li>
            `;
        }

        pane.innerHTML = `
            <section class="arcade-settings-section">
                <h3>Pinned games (${pinned.length})</h3>
                <p class="arcade-settings-help">Always at the top of the home grid. Right-click any game card → Pin.</p>
                ${pinned.length ? `<ul class="arcade-settings-list">${pinned.map(g => renderRow(g, 'unpin')).join('')}</ul>`
                                : `<p class="arcade-settings-empty">No pinned games yet.</p>`}
            </section>

            <section class="arcade-settings-section">
                <h3>Hidden games (${hidden.length})</h3>
                <p class="arcade-settings-help">Filtered out of the home grid. Right-click any card → Hide.</p>
                ${hidden.length ? `<ul class="arcade-settings-list">${hidden.map(g => renderRow(g, 'unhide')).join('')}</ul>`
                                : `<p class="arcade-settings-empty">No hidden games.</p>`}
            </section>
        `;

        pane.querySelectorAll('[data-unpin]').forEach(btn => {
            btn.addEventListener('click', () => { togglePin(btn.dataset.unpin); paintCatalog(pane); });
        });
        pane.querySelectorAll('[data-unhide]').forEach(btn => {
            btn.addEventListener('click', () => { toggleHide(btn.dataset.unhide); paintCatalog(pane); });
        });
    }

    // ─── Pane: Advanced ─────────────────────────────────────────────
    function paintAdvanced(pane) {
        pane.innerHTML = `
            <section class="arcade-settings-section">
                <h3>Custom CSS</h3>
                <p class="arcade-settings-help">
                    Power-user override. Anything you write here gets applied
                    site-wide for your account. Capped at 16 KiB.
                    Only paste CSS you trust — bad rules can hide buttons or
                    break layouts. Clear the box to restore the default look.
                </p>
                <textarea id="setCustomCss" class="arcade-settings-textarea" rows="12"
                          placeholder="/* Try: body { letter-spacing: 0.02em; } */">${(SETTINGS.customCss||'').replace(/</g,'&lt;')}</textarea>
                <div class="arcade-settings-row">
                    <button class="auth-submit" id="setCssApply">Apply</button>
                    <button class="auth-submit-secondary" id="setCssClear">Clear</button>
                    <span class="arcade-settings-help" id="setCssLen"></span>
                </div>
            </section>

            <section class="arcade-settings-section">
                <h3>Reset</h3>
                <button class="auth-submit-secondary" id="setResetAll">Reset all settings to defaults</button>
            </section>
        `;
        const ta = pane.querySelector('#setCustomCss');
        const len = pane.querySelector('#setCssLen');
        function updLen() { len.textContent = `${ta.value.length} / 16384 chars`; }
        updLen();
        ta.addEventListener('input', updLen);
        pane.querySelector('#setCssApply').addEventListener('click', () => {
            set({ customCss: ta.value.slice(0, 16384) });
        });
        pane.querySelector('#setCssClear').addEventListener('click', () => {
            ta.value = '';
            set({ customCss: '' });
            updLen();
        });
        pane.querySelector('#setResetAll').addEventListener('click', () => {
            if (!confirm('Reset every setting to its default? Wallpaper + theme are not affected.')) return;
            SETTINGS = JSON.parse(JSON.stringify(DEFAULTS));
            save(SETTINGS);
            apply();
            paintAdvanced(pane);
        });
    }

    // ─── Right-click context menu on game cards ─────────────────────
    // Wired globally — anywhere a `.game-card[data-game-id]` appears,
    // right-click pops a tiny pin/hide menu.
    document.addEventListener('contextmenu', (e) => {
        const card = e.target.closest?.('.game-card[data-game-id]');
        if (!card) return;
        e.preventDefault();
        const gameId = card.dataset.gameId;
        showCardMenu(e.pageX, e.pageY, gameId);
    });
    function showCardMenu(x, y, gameId) {
        const existing = document.getElementById('arcadeCardMenu');
        if (existing) existing.remove();
        const menu = document.createElement('div');
        menu.id = 'arcadeCardMenu';
        menu.className = 'arcade-card-menu';
        const isP = isPinned(gameId);
        const isH = isHidden(gameId);
        menu.innerHTML = `
            <button data-act="pin">${isP ? 'Unpin' : 'Pin to top'}</button>
            <button data-act="hide">${isH ? 'Unhide' : 'Hide game'}</button>
        `;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth - 6) menu.style.left = (window.innerWidth - rect.width - 6) + 'px';
        if (rect.bottom > window.innerHeight - 6) menu.style.top = (window.innerHeight - rect.height - 6) + 'px';

        const dismiss = () => { menu.remove(); document.removeEventListener('click', dismiss); };
        setTimeout(() => document.addEventListener('click', dismiss), 0);
        menu.querySelector('[data-act=pin]').addEventListener('click', (e) => {
            e.stopPropagation(); togglePin(gameId); dismiss();
        });
        menu.querySelector('[data-act=hide]').addEventListener('click', (e) => {
            e.stopPropagation(); toggleHide(gameId); dismiss();
        });
    }

    // ─── Boot ────────────────────────────────────────────────────────
    function init() {
        apply();

        // Re-merge from Firestore when auth resolves (cross-device sync)
        const tryRemoteHydrate = async () => {
            try {
                const db = window.ArcadeAuth?.getDb?.();
                const uid = window.ArcadeAuth?.getUser?.()?.uid;
                if (!db || !uid) return;
                const snap = await db.collection('users').doc(uid).get();
                const remote = snap.exists ? (snap.data() || {}).settings : null;
                if (remote && typeof remote === 'object') {
                    SETTINGS = Object.assign({}, DEFAULTS, remote, {
                        homeSections: Object.assign({}, DEFAULTS.homeSections, remote.homeSections || {}),
                    });
                    save(SETTINGS);
                    apply();
                }
            } catch {}
        };
        if (window.ArcadeAuth?.waitForAuth) {
            window.ArcadeAuth.waitForAuth().then(tryRemoteHydrate);
        } else {
            setTimeout(tryRemoteHydrate, 1500);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.ArcadeSettings = {
        get: getSnapshot,
        set,
        openSettingsModal,
        togglePin, isPinned,
        toggleHide, isHidden,
    };
})();
