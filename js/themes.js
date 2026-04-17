// ===== Theme System v2 =====
// - 10 built-in color themes
// - Custom wallpaper with dim + blur controls
// - Community themes with search
// - Tabbed picker UI (Colors / Wallpaper / Community)
// - Smooth transitions between themes
(function () {
    // Small helper that builds a theme's vars from a concise config.
    // Avoids the repetitive copy-paste from v1.
    function buildTheme(label, cfg) {
        const bg = cfg.bg;
        const accent = cfg.accent;
        const accent2 = cfg.accent2 || accent;
        const text = cfg.text;
        // Parse the accent hex into rgba() with alpha for translucent derivatives.
        function rgba(hex, a) {
            const h = hex.replace('#', '');
            const r = parseInt(h.substring(0, 2), 16);
            const g = parseInt(h.substring(2, 4), 16);
            const b = parseInt(h.substring(4, 6), 16);
            return `rgba(${r}, ${g}, ${b}, ${a})`;
        }
        return {
            label,
            vars: {
                '--bg-primary': bg[0],
                '--bg-secondary': bg[1],
                '--bg-card': bg[2],
                '--bg-card-hover': bg[3],
                '--border': bg[4],
                '--text-primary': text[0],
                '--text-secondary': text[1],
                '--accent': accent,
                '--accent-secondary': accent2,
                '--accent-glow': rgba(accent, 0.4),
                '--accent-secondary-glow': rgba(accent2, 0.3),
                '--accent-subtle': rgba(accent, 0.15),
                '--accent-grid': rgba(accent, 0.03),
                '--accent-header': rgba(accent, 0.08),
                '--chat-self-bg': rgba(accent, 0.15),
                '--chat-self-border': rgba(accent, 0.2),
            }
        };
    }

    const THEMES = {
        midnight: buildTheme('Midnight', {
            bg: ['#0a0a0f', '#12121a', '#16161f', '#1c1c28', '#2a2a3a'],
            text: ['#e8e8f0', '#8888a0'],
            accent: '#7c3aed', accent2: '#06b6d4',
        }),
        ocean: buildTheme('Ocean', {
            bg: ['#0a0f14', '#101a22', '#142028', '#1a2830', '#1e3a4a'],
            text: ['#e0f0f8', '#7a9ab0'],
            accent: '#0ea5e9', accent2: '#22d3ee',
        }),
        crimson: buildTheme('Crimson', {
            bg: ['#0f0a0a', '#1a1212', '#1f1616', '#281c1c', '#3a2a2a'],
            text: ['#f0e8e8', '#a08888'],
            accent: '#ef4444', accent2: '#f97316',
        }),
        forest: buildTheme('Forest', {
            bg: ['#0a0f0a', '#121a12', '#161f16', '#1c281c', '#2a3a2a'],
            text: ['#e8f0e8', '#88a088'],
            accent: '#22c55e', accent2: '#84cc16',
        }),
        sunset: buildTheme('Sunset', {
            bg: ['#0f0c0a', '#1a1510', '#1f1a14', '#28201a', '#3a3028'],
            text: ['#f0ece8', '#a09888'],
            accent: '#f59e0b', accent2: '#ec4899',
        }),
        synthwave: buildTheme('Synthwave', {
            bg: ['#0d081a', '#170e2b', '#1d1235', '#261745', '#3b2464'],
            text: ['#f1e4ff', '#a890c8'],
            accent: '#ff2e9a', accent2: '#01f9ff',
        }),
        sakura: buildTheme('Sakura', {
            bg: ['#1a0f15', '#25161e', '#2e1b25', '#3a2230', '#4a2c3e'],
            text: ['#fce7ef', '#c497a9'],
            accent: '#ec4899', accent2: '#fb7185',
        }),
        oled: buildTheme('OLED Black', {
            bg: ['#000000', '#050505', '#0a0a0a', '#121212', '#262626'],
            text: ['#ffffff', '#9ca3af'],
            accent: '#a78bfa', accent2: '#22d3ee',
        }),
        nord: buildTheme('Nord', {
            bg: ['#2e3440', '#3b4252', '#434c5e', '#4c566a', '#5e6779'],
            text: ['#eceff4', '#a9b2c0'],
            accent: '#88c0d0', accent2: '#81a1c1',
        }),
        monokai: buildTheme('Monokai', {
            bg: ['#1e1f1c', '#272822', '#2d2e27', '#383931', '#49483e'],
            text: ['#f8f8f2', '#a6a29a'],
            accent: '#a6e22e', accent2: '#f92672',
        }),
        light: buildTheme('Light', {
            bg: ['#f5f5f7', '#ffffff', '#ffffff', '#f0f0f5', '#d4d4dc'],
            text: ['#1a1a2e', '#64648a'],
            accent: '#7c3aed', accent2: '#0891b2',
        }),
    };

    const STORAGE_KEY = 'arcade-theme';
    const WALLPAPER_KEY = 'arcade-wallpaper';
    const WALLPAPER_DIM_KEY = 'arcade-wallpaper-dim';
    const WALLPAPER_BLUR_KEY = 'arcade-wallpaper-blur';
    const COMMUNITY_CACHE_KEY = 'arcade-community-theme-img';
    const DEFAULT_THEME = 'midnight';

    let communityThemes = [];

    function getWallpaperDim() {
        const v = parseFloat(localStorage.getItem(WALLPAPER_DIM_KEY));
        return Number.isFinite(v) ? v : 0.5;
    }
    function getWallpaperBlur() {
        const v = parseFloat(localStorage.getItem(WALLPAPER_BLUR_KEY));
        return Number.isFinite(v) ? v : 2;
    }

    function applyWallpaper(dataUrl) {
        let el = document.getElementById('custom-wallpaper');
        if (!el) {
            el = document.createElement('div');
            el.id = 'custom-wallpaper';
            document.body.prepend(el);
        }
        let overlay = document.getElementById('custom-wallpaper-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'custom-wallpaper-overlay';
            document.body.prepend(overlay);
        }

        if (dataUrl) {
            el.style.backgroundImage = `url(${dataUrl})`;
            el.style.filter = `blur(${getWallpaperBlur()}px)`;
            el.style.display = 'block';
            overlay.style.background = `rgba(0, 0, 0, ${getWallpaperDim()})`;
            overlay.style.display = 'block';
            document.body.classList.add('has-wallpaper');
        } else {
            el.style.backgroundImage = '';
            el.style.display = 'none';
            overlay.style.display = 'none';
            document.body.classList.remove('has-wallpaper');
        }
    }

    // Allow live tweaking of dim/blur without reloading the image
    function updateWallpaperEffects() {
        const el = document.getElementById('custom-wallpaper');
        const overlay = document.getElementById('custom-wallpaper-overlay');
        if (el) el.style.filter = `blur(${getWallpaperBlur()}px)`;
        if (overlay) overlay.style.background = `rgba(0, 0, 0, ${getWallpaperDim()})`;
    }

    function applyTheme(themeId) {
        const root = document.documentElement;

        // Add transition class briefly so color changes are smooth
        document.body.classList.add('theme-transitioning');
        setTimeout(() => document.body.classList.remove('theme-transitioning'), 400);

        if (themeId === 'custom') {
            const base = THEMES.midnight.vars;
            for (const [prop, val] of Object.entries(base)) root.style.setProperty(prop, val);
            root.style.setProperty('--bg-primary', 'rgba(10, 10, 15, 0.7)');
            root.style.setProperty('--bg-secondary', 'rgba(18, 18, 26, 0.85)');
            root.style.setProperty('--bg-card', 'rgba(22, 22, 31, 0.85)');
            root.style.setProperty('--bg-card-hover', 'rgba(28, 28, 40, 0.9)');
            const wallpaper = localStorage.getItem(WALLPAPER_KEY);
            applyWallpaper(wallpaper);
        } else if (themeId && themeId.startsWith('community:')) {
            const docId = themeId.replace('community:', '');
            const base = THEMES.midnight.vars;
            for (const [prop, val] of Object.entries(base)) root.style.setProperty(prop, val);
            root.style.setProperty('--bg-primary', 'rgba(10, 10, 15, 0.7)');
            root.style.setProperty('--bg-secondary', 'rgba(18, 18, 26, 0.85)');
            root.style.setProperty('--bg-card', 'rgba(22, 22, 31, 0.85)');
            root.style.setProperty('--bg-card-hover', 'rgba(28, 28, 40, 0.9)');
            const cached = localStorage.getItem(COMMUNITY_CACHE_KEY + ':' + docId);
            if (cached) applyWallpaper(cached);
            else loadCommunityImage(docId);
        } else {
            const theme = THEMES[themeId];
            if (!theme) return;
            for (const [prop, val] of Object.entries(theme.vars)) {
                root.style.setProperty(prop, val);
            }
            applyWallpaper(null);
        }

        document.documentElement.setAttribute('data-theme', themeId);
        localStorage.setItem(STORAGE_KEY, themeId);
    }

    async function loadCommunityImage(docId) {
        try {
            const db = window.ArcadeAuth && window.ArcadeAuth.getDb();
            if (!db) return;
            const doc = await db.collection('themes').doc(docId).get();
            if (doc.exists && doc.data().image) {
                const imgData = doc.data().image;
                applyWallpaper(imgData);
                try { localStorage.setItem(COMMUNITY_CACHE_KEY + ':' + docId, imgData); } catch (e) {}
            }
        } catch (e) { console.error('Failed to load community theme:', e); }
    }

    function getCurrentTheme() {
        return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME;
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

    function promptWallpaperUpload(callback) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', async () => {
            const file = input.files[0];
            if (!file) return;
            try {
                let dataUrl = await resizeImage(file, 1920, 1080, 0.8);
                try { localStorage.setItem(WALLPAPER_KEY, dataUrl); }
                catch (e) {
                    dataUrl = await resizeImage(file, 1280, 720, 0.5);
                    try { localStorage.setItem(WALLPAPER_KEY, dataUrl); }
                    catch (e2) {
                        alert('Image is too large. Try a smaller image.');
                        callback(false); return;
                    }
                }
                callback(true);
            } catch (e) {
                alert('Failed to process image.');
                callback(false);
            }
        });
        input.click();
    }

    async function publishTheme(name) {
        const db = window.ArcadeAuth && window.ArcadeAuth.getDb();
        const user = window.ArcadeAuth && window.ArcadeAuth.getUser();
        const username = window.ArcadeAuth && window.ArcadeAuth.getUsername();
        if (!db || !user) throw new Error('Must be logged in');

        const wallpaper = localStorage.getItem(WALLPAPER_KEY);
        if (!wallpaper) throw new Error('No wallpaper set');

        const blob = await fetch(wallpaper).then(r => r.blob());
        const file = new File([blob], 'wallpaper.jpg', { type: 'image/jpeg' });
        const image = await resizeImage(file, 1280, 720, 0.6);

        const docRef = await db.collection('themes').add({
            name: name,
            image: image,
            createdBy: user.uid,
            createdByName: username || 'Unknown',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        return docRef.id;
    }

    async function deleteCommunityTheme(docId) {
        const db = window.ArcadeAuth && window.ArcadeAuth.getDb();
        if (!db) return;
        await db.collection('themes').doc(docId).delete();
        try { localStorage.removeItem(COMMUNITY_CACHE_KEY + ':' + docId); } catch (e) {}
    }

    async function loadCommunityThemes() {
        try {
            const db = window.ArcadeAuth && window.ArcadeAuth.getDb();
            if (!db) return [];
            const snap = await db.collection('themes').orderBy('createdAt', 'desc').limit(100).get();
            communityThemes = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            return communityThemes;
        } catch (e) {
            console.error('Failed to load community themes:', e);
            return [];
        }
    }

    // ===== Picker UI =====

    function createThemePicker() {
        const wrapper = document.createElement('div');
        wrapper.className = 'theme-picker-wrapper';

        const btn = document.createElement('button');
        btn.className = 'theme-picker-btn';
        btn.title = 'Change theme';
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.5 0 1-.5 1-1v-1c0-.5-.5-1-1-1-.5 0-1-.5-1-1v-1c0-.5.5-1 1-1h3c3.3 0 6-2.7 6-6 0-5.5-4.5-10-9-10z"/></svg>';

        const popup = document.createElement('div');
        popup.className = 'theme-picker-popup';
        popup.style.display = 'none';

        // Tab bar
        const tabs = document.createElement('div');
        tabs.className = 'theme-tabs';
        const tabColors = makeTab('Colors', true);
        const tabWallpaper = makeTab('Wallpaper');
        const tabCommunity = makeTab('Community');
        tabs.append(tabColors, tabWallpaper, tabCommunity);
        popup.appendChild(tabs);

        // Panels
        const panelColors = document.createElement('div');
        panelColors.className = 'theme-panel';
        const panelWallpaper = document.createElement('div');
        panelWallpaper.className = 'theme-panel';
        panelWallpaper.style.display = 'none';
        const panelCommunity = document.createElement('div');
        panelCommunity.className = 'theme-panel';
        panelCommunity.style.display = 'none';
        popup.append(panelColors, panelWallpaper, panelCommunity);

        tabColors.addEventListener('click', () => switchTab(0));
        tabWallpaper.addEventListener('click', () => switchTab(1));
        tabCommunity.addEventListener('click', () => {
            switchTab(2);
            refreshCommunitySection(popup);
        });

        function switchTab(idx) {
            [tabColors, tabWallpaper, tabCommunity].forEach((t, i) => t.classList.toggle('active', i === idx));
            [panelColors, panelWallpaper, panelCommunity].forEach((p, i) => p.style.display = i === idx ? '' : 'none');
        }

        // ----- Colors panel -----
        const current = getCurrentTheme();
        const colorsGrid = document.createElement('div');
        colorsGrid.className = 'theme-color-grid';
        for (const [id, theme] of Object.entries(THEMES)) {
            colorsGrid.appendChild(createThemeItem(id, theme.label,
                `linear-gradient(135deg, ${theme.vars['--accent']}, ${theme.vars['--accent-secondary']})`,
                id === current, popup));
        }
        panelColors.appendChild(colorsGrid);

        // ----- Wallpaper panel -----
        const customHint = document.createElement('div');
        customHint.className = 'theme-hint';
        customHint.textContent = 'Use your own image as a background, tune dim and blur, then optionally publish it for everyone.';
        panelWallpaper.appendChild(customHint);

        const customItem = document.createElement('button');
        customItem.className = 'theme-picker-item theme-picker-custom' + (current === 'custom' ? ' active' : '');
        customItem.setAttribute('data-theme-id', 'custom');
        customItem.innerHTML = '<span class="theme-swatch theme-swatch-custom"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></span><span class="theme-label">My Wallpaper</span>';

        customItem.addEventListener('click', () => {
            if (localStorage.getItem(WALLPAPER_KEY)) {
                applyTheme('custom');
                setActive(popup, customItem);
            } else {
                promptWallpaperUpload((ok) => {
                    if (ok) { applyTheme('custom'); setActive(popup, customItem); }
                });
            }
        });
        panelWallpaper.appendChild(customItem);

        const customActions = document.createElement('div');
        customActions.className = 'theme-custom-actions';

        const changeBtn = document.createElement('button');
        changeBtn.className = 'theme-picker-action-btn';
        changeBtn.textContent = 'Change image';
        changeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            promptWallpaperUpload((ok) => {
                if (ok) { applyTheme('custom'); setActive(popup, customItem); }
            });
        });
        customActions.appendChild(changeBtn);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'theme-picker-action-btn';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            localStorage.removeItem(WALLPAPER_KEY);
            if (getCurrentTheme() === 'custom') applyTheme(DEFAULT_THEME);
            applyWallpaper(null);
        });
        customActions.appendChild(removeBtn);

        const publishBtn = document.createElement('button');
        publishBtn.className = 'theme-picker-action-btn theme-picker-publish-btn';
        publishBtn.textContent = 'Publish';
        publishBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!window.ArcadeAuth || !window.ArcadeAuth.isLoggedIn()) {
                alert('Log in to publish themes'); return;
            }
            if (!localStorage.getItem(WALLPAPER_KEY)) {
                alert('Set a wallpaper first'); return;
            }
            const name = prompt('Name your theme:');
            if (!name || !name.trim()) return;
            publishBtn.textContent = 'Publishing...';
            publishBtn.disabled = true;
            publishTheme(name.trim()).then(() => {
                publishBtn.textContent = 'Published!';
                setTimeout(() => {
                    publishBtn.textContent = 'Publish';
                    publishBtn.disabled = false;
                }, 1500);
            }).catch(err => {
                alert('Failed to publish: ' + err.message);
                publishBtn.textContent = 'Publish';
                publishBtn.disabled = false;
            });
        });
        customActions.appendChild(publishBtn);
        panelWallpaper.appendChild(customActions);

        // Dim/blur sliders
        const sliderGroup = document.createElement('div');
        sliderGroup.className = 'theme-sliders';
        sliderGroup.appendChild(makeSlider('Dim', 0, 0.9, 0.05, getWallpaperDim(), (v) => {
            localStorage.setItem(WALLPAPER_DIM_KEY, String(v));
            updateWallpaperEffects();
        }));
        sliderGroup.appendChild(makeSlider('Blur', 0, 12, 0.5, getWallpaperBlur(), (v) => {
            localStorage.setItem(WALLPAPER_BLUR_KEY, String(v));
            updateWallpaperEffects();
        }));
        panelWallpaper.appendChild(sliderGroup);

        // ----- Community panel -----
        const searchWrap = document.createElement('div');
        searchWrap.className = 'theme-search-wrap';
        const searchInput = document.createElement('input');
        searchInput.className = 'theme-search-input';
        searchInput.type = 'search';
        searchInput.placeholder = 'Search themes…';
        searchInput.addEventListener('input', () => renderCommunityList(popup, searchInput.value.trim().toLowerCase()));
        searchWrap.appendChild(searchInput);
        panelCommunity.appendChild(searchWrap);

        const communityList = document.createElement('div');
        communityList.className = 'theme-community-list';
        communityList.innerHTML = '<div class="theme-community-loading">Loading…</div>';
        panelCommunity.appendChild(communityList);

        btn.addEventListener('click', () => {
            const isOpen = popup.style.display === 'block';
            popup.style.display = isOpen ? 'none' : 'block';
            if (!isOpen && [...tabs.children].indexOf(tabCommunity) === 2 && tabCommunity.classList.contains('active')) {
                refreshCommunitySection(popup);
            }
        });

        document.addEventListener('click', (e) => {
            if (!wrapper.contains(e.target)) popup.style.display = 'none';
        });

        wrapper.appendChild(btn);
        wrapper.appendChild(popup);
        return wrapper;
    }

    function makeTab(label, active) {
        const t = document.createElement('button');
        t.className = 'theme-tab' + (active ? ' active' : '');
        t.textContent = label;
        return t;
    }

    function makeSlider(label, min, max, step, value, onInput) {
        const row = document.createElement('label');
        row.className = 'theme-slider-row';
        const lbl = document.createElement('span');
        lbl.className = 'theme-slider-label';
        lbl.textContent = label;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(min); input.max = String(max); input.step = String(step);
        input.value = String(value);
        const val = document.createElement('span');
        val.className = 'theme-slider-value';
        val.textContent = input.value;
        input.addEventListener('input', () => {
            val.textContent = input.value;
            onInput(parseFloat(input.value));
        });
        row.append(lbl, input, val);
        return row;
    }

    function createThemeItem(id, label, swatchBg, isActive, popup) {
        const item = document.createElement('button');
        item.className = 'theme-picker-item theme-color-item' + (isActive ? ' active' : '');
        item.setAttribute('data-theme-id', id);

        const swatch = document.createElement('span');
        swatch.className = 'theme-swatch';
        swatch.style.background = swatchBg;

        const lbl = document.createElement('span');
        lbl.className = 'theme-label';
        lbl.textContent = label;

        item.append(swatch, lbl);

        item.addEventListener('click', () => {
            applyTheme(id);
            setActive(popup, item);
        });
        return item;
    }

    function setActive(popup, activeItem) {
        popup.querySelectorAll('.theme-picker-item').forEach(el => el.classList.remove('active'));
        activeItem.classList.add('active');
    }

    async function refreshCommunitySection(popup) {
        const list = popup.querySelector('.theme-community-list');
        if (!list) return;
        list.innerHTML = '<div class="theme-community-loading">Loading…</div>';
        await loadCommunityThemes();
        renderCommunityList(popup, '');
    }

    function renderCommunityList(popup, query) {
        const list = popup.querySelector('.theme-community-list');
        if (!list) return;
        list.innerHTML = '';

        let themes = communityThemes;
        if (query) {
            themes = themes.filter(t =>
                (t.name || '').toLowerCase().includes(query) ||
                (t.createdByName || '').toLowerCase().includes(query)
            );
        }

        if (themes.length === 0) {
            list.innerHTML = '<div class="theme-community-empty">'
                + (query ? 'No matches' : 'No community themes yet')
                + '</div>';
            return;
        }

        const current = getCurrentTheme();
        const currentUser = window.ArcadeAuth && window.ArcadeAuth.getUser();
        const isAdmin = window.ArcadeAuth && window.ArcadeAuth.isAdmin();

        themes.forEach(t => {
            const themeId = 'community:' + t.id;
            const row = document.createElement('div');
            row.className = 'theme-community-item' + (current === themeId ? ' active' : '');

            const thumb = document.createElement('div');
            thumb.className = 'theme-community-thumb';
            if (t.image) thumb.style.backgroundImage = `url(${t.image})`;

            const info = document.createElement('div');
            info.className = 'theme-community-info';

            const nameEl = document.createElement('span');
            nameEl.className = 'theme-community-name';
            nameEl.textContent = t.name;

            const author = document.createElement('span');
            author.className = 'theme-community-author';
            author.textContent = 'by ' + (t.createdByName || 'Unknown');

            info.append(nameEl, author);
            row.append(thumb, info);

            if (currentUser && (currentUser.uid === t.createdBy || isAdmin)) {
                const delBtn = document.createElement('button');
                delBtn.className = 'theme-community-delete';
                delBtn.innerHTML = '&times;';
                delBtn.title = 'Delete theme';
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!confirm('Delete "' + t.name + '"?')) return;
                    deleteCommunityTheme(t.id).then(() => {
                        if (getCurrentTheme() === themeId) applyTheme(DEFAULT_THEME);
                        refreshCommunitySection(popup);
                    });
                });
                row.appendChild(delBtn);
            }

            row.addEventListener('click', () => {
                applyTheme(themeId);
                if (t.image) {
                    try { localStorage.setItem(COMMUNITY_CACHE_KEY + ':' + t.id, t.image); } catch (e) {}
                }
                popup.querySelectorAll('.theme-picker-item').forEach(el => el.classList.remove('active'));
                popup.querySelectorAll('.theme-community-item').forEach(el => el.classList.remove('active'));
                row.classList.add('active');
            });

            list.appendChild(row);
        });
    }

    // Apply saved theme immediately
    applyTheme(getCurrentTheme());

    // Insert picker into the page
    document.addEventListener('DOMContentLoaded', () => {
        const header = document.querySelector('.header-content') || document.querySelector('.player-actions');
        if (header) {
            const picker = createThemePicker();
            const authArea = header.querySelector('.auth-area');
            if (authArea) header.insertBefore(picker, authArea);
            else header.appendChild(picker);
        }
    });

    window.ArcadeThemes = {
        applyTheme, getCurrentTheme, THEMES,
        publishTheme, loadCommunityThemes,
        getWallpaperDim, getWallpaperBlur
    };
})();
