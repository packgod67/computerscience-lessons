// ===== Theme System =====
(function () {
    const THEMES = {
        midnight: {
            label: 'Midnight',
            vars: {
                '--bg-primary': '#0a0a0f',
                '--bg-secondary': '#12121a',
                '--bg-card': '#16161f',
                '--bg-card-hover': '#1c1c28',
                '--border': '#2a2a3a',
                '--text-primary': '#e8e8f0',
                '--text-secondary': '#8888a0',
                '--accent': '#7c3aed',
                '--accent-secondary': '#06b6d4',
                '--accent-glow': 'rgba(124, 58, 237, 0.4)',
                '--accent-secondary-glow': 'rgba(6, 182, 212, 0.3)',
                '--accent-subtle': 'rgba(124, 58, 237, 0.15)',
                '--accent-grid': 'rgba(124, 58, 237, 0.03)',
                '--accent-header': 'rgba(124, 58, 237, 0.08)',
                '--chat-self-bg': 'rgba(124, 58, 237, 0.15)',
                '--chat-self-border': 'rgba(124, 58, 237, 0.2)',
            }
        },
        ocean: {
            label: 'Ocean',
            vars: {
                '--bg-primary': '#0a0f14',
                '--bg-secondary': '#101a22',
                '--bg-card': '#142028',
                '--bg-card-hover': '#1a2830',
                '--border': '#1e3a4a',
                '--text-primary': '#e0f0f8',
                '--text-secondary': '#7a9ab0',
                '--accent': '#0ea5e9',
                '--accent-secondary': '#22d3ee',
                '--accent-glow': 'rgba(14, 165, 233, 0.4)',
                '--accent-secondary-glow': 'rgba(34, 211, 238, 0.3)',
                '--accent-subtle': 'rgba(14, 165, 233, 0.15)',
                '--accent-grid': 'rgba(14, 165, 233, 0.03)',
                '--accent-header': 'rgba(14, 165, 233, 0.08)',
                '--chat-self-bg': 'rgba(14, 165, 233, 0.15)',
                '--chat-self-border': 'rgba(14, 165, 233, 0.2)',
            }
        },
        crimson: {
            label: 'Crimson',
            vars: {
                '--bg-primary': '#0f0a0a',
                '--bg-secondary': '#1a1212',
                '--bg-card': '#1f1616',
                '--bg-card-hover': '#281c1c',
                '--border': '#3a2a2a',
                '--text-primary': '#f0e8e8',
                '--text-secondary': '#a08888',
                '--accent': '#ef4444',
                '--accent-secondary': '#f97316',
                '--accent-glow': 'rgba(239, 68, 68, 0.4)',
                '--accent-secondary-glow': 'rgba(249, 115, 22, 0.3)',
                '--accent-subtle': 'rgba(239, 68, 68, 0.15)',
                '--accent-grid': 'rgba(239, 68, 68, 0.03)',
                '--accent-header': 'rgba(239, 68, 68, 0.08)',
                '--chat-self-bg': 'rgba(239, 68, 68, 0.15)',
                '--chat-self-border': 'rgba(239, 68, 68, 0.2)',
            }
        },
        forest: {
            label: 'Forest',
            vars: {
                '--bg-primary': '#0a0f0a',
                '--bg-secondary': '#121a12',
                '--bg-card': '#161f16',
                '--bg-card-hover': '#1c281c',
                '--border': '#2a3a2a',
                '--text-primary': '#e8f0e8',
                '--text-secondary': '#88a088',
                '--accent': '#22c55e',
                '--accent-secondary': '#84cc16',
                '--accent-glow': 'rgba(34, 197, 94, 0.4)',
                '--accent-secondary-glow': 'rgba(132, 204, 22, 0.3)',
                '--accent-subtle': 'rgba(34, 197, 94, 0.15)',
                '--accent-grid': 'rgba(34, 197, 94, 0.03)',
                '--accent-header': 'rgba(34, 197, 94, 0.08)',
                '--chat-self-bg': 'rgba(34, 197, 94, 0.15)',
                '--chat-self-border': 'rgba(34, 197, 94, 0.2)',
            }
        },
        sunset: {
            label: 'Sunset',
            vars: {
                '--bg-primary': '#0f0c0a',
                '--bg-secondary': '#1a1510',
                '--bg-card': '#1f1a14',
                '--bg-card-hover': '#28201a',
                '--border': '#3a3028',
                '--text-primary': '#f0ece8',
                '--text-secondary': '#a09888',
                '--accent': '#f59e0b',
                '--accent-secondary': '#ec4899',
                '--accent-glow': 'rgba(245, 158, 11, 0.4)',
                '--accent-secondary-glow': 'rgba(236, 72, 153, 0.3)',
                '--accent-subtle': 'rgba(245, 158, 11, 0.15)',
                '--accent-grid': 'rgba(245, 158, 11, 0.03)',
                '--accent-header': 'rgba(245, 158, 11, 0.08)',
                '--chat-self-bg': 'rgba(245, 158, 11, 0.15)',
                '--chat-self-border': 'rgba(245, 158, 11, 0.2)',
            }
        },
        light: {
            label: 'Light',
            vars: {
                '--bg-primary': '#f5f5f7',
                '--bg-secondary': '#ffffff',
                '--bg-card': '#ffffff',
                '--bg-card-hover': '#f0f0f5',
                '--border': '#d4d4dc',
                '--text-primary': '#1a1a2e',
                '--text-secondary': '#64648a',
                '--accent': '#7c3aed',
                '--accent-secondary': '#0891b2',
                '--accent-glow': 'rgba(124, 58, 237, 0.25)',
                '--accent-secondary-glow': 'rgba(8, 145, 178, 0.2)',
                '--accent-subtle': 'rgba(124, 58, 237, 0.1)',
                '--accent-grid': 'rgba(124, 58, 237, 0.04)',
                '--accent-header': 'rgba(124, 58, 237, 0.06)',
                '--chat-self-bg': 'rgba(124, 58, 237, 0.1)',
                '--chat-self-border': 'rgba(124, 58, 237, 0.15)',
            }
        }
    };

    const STORAGE_KEY = 'arcade-theme';
    const WALLPAPER_KEY = 'arcade-wallpaper';
    const COMMUNITY_CACHE_KEY = 'arcade-community-theme-img';
    const DEFAULT_THEME = 'midnight';

    // Cache of loaded community themes
    let communityThemes = [];

    function applyWallpaper(dataUrl) {
        let el = document.getElementById('custom-wallpaper');
        if (!el) {
            el = document.createElement('div');
            el.id = 'custom-wallpaper';
            document.body.prepend(el);
        }
        if (dataUrl) {
            el.style.backgroundImage = `url(${dataUrl})`;
            el.style.display = 'block';
            document.body.classList.add('has-wallpaper');
        } else {
            el.style.backgroundImage = '';
            el.style.display = 'none';
            document.body.classList.remove('has-wallpaper');
        }
    }

    function applyTheme(themeId) {
        const root = document.documentElement;

        if (themeId === 'custom') {
            // Custom local wallpaper — midnight colors with transparency
            const base = THEMES.midnight.vars;
            for (const [prop, val] of Object.entries(base)) {
                root.style.setProperty(prop, val);
            }
            root.style.setProperty('--bg-primary', 'rgba(10, 10, 15, 0.7)');
            root.style.setProperty('--bg-secondary', 'rgba(18, 18, 26, 0.85)');
            root.style.setProperty('--bg-card', 'rgba(22, 22, 31, 0.85)');
            root.style.setProperty('--bg-card-hover', 'rgba(28, 28, 40, 0.9)');
            const wallpaper = localStorage.getItem(WALLPAPER_KEY);
            applyWallpaper(wallpaper);
        } else if (themeId && themeId.startsWith('community:')) {
            // Community theme
            const docId = themeId.replace('community:', '');
            const base = THEMES.midnight.vars;
            for (const [prop, val] of Object.entries(base)) {
                root.style.setProperty(prop, val);
            }
            root.style.setProperty('--bg-primary', 'rgba(10, 10, 15, 0.7)');
            root.style.setProperty('--bg-secondary', 'rgba(18, 18, 26, 0.85)');
            root.style.setProperty('--bg-card', 'rgba(22, 22, 31, 0.85)');
            root.style.setProperty('--bg-card-hover', 'rgba(28, 28, 40, 0.9)');
            // Check cache first
            const cached = localStorage.getItem(COMMUNITY_CACHE_KEY + ':' + docId);
            if (cached) {
                applyWallpaper(cached);
            } else {
                // Load from Firestore
                loadCommunityImage(docId);
            }
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
                // Cache it locally
                try { localStorage.setItem(COMMUNITY_CACHE_KEY + ':' + docId, imgData); } catch (e) {}
            }
        } catch (e) {
            console.error('Failed to load community theme:', e);
        }
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
                    canvas.width = w;
                    canvas.height = h;
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
                try {
                    localStorage.setItem(WALLPAPER_KEY, dataUrl);
                } catch (e) {
                    dataUrl = await resizeImage(file, 1280, 720, 0.5);
                    try {
                        localStorage.setItem(WALLPAPER_KEY, dataUrl);
                    } catch (e2) {
                        alert('Image is too large. Try a smaller image.');
                        callback(false);
                        return;
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

    // Publish current wallpaper as a community theme
    async function publishTheme(name) {
        const db = window.ArcadeAuth && window.ArcadeAuth.getDb();
        const user = window.ArcadeAuth && window.ArcadeAuth.getUser();
        const username = window.ArcadeAuth && window.ArcadeAuth.getUsername();
        if (!db || !user) throw new Error('Must be logged in');

        const wallpaper = localStorage.getItem(WALLPAPER_KEY);
        if (!wallpaper) throw new Error('No wallpaper set');

        // Resize smaller for Firestore (keep under ~700KB base64)
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

    // Delete a community theme (only by creator or admin)
    async function deleteCommunityTheme(docId) {
        const db = window.ArcadeAuth && window.ArcadeAuth.getDb();
        if (!db) return;
        await db.collection('themes').doc(docId).delete();
        try { localStorage.removeItem(COMMUNITY_CACHE_KEY + ':' + docId); } catch (e) {}
    }

    // Load community themes list from Firestore
    async function loadCommunityThemes() {
        try {
            const db = window.ArcadeAuth && window.ArcadeAuth.getDb();
            if (!db) return [];
            const snap = await db.collection('themes').orderBy('createdAt', 'desc').limit(50).get();
            communityThemes = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            return communityThemes;
        } catch (e) {
            console.error('Failed to load community themes:', e);
            return [];
        }
    }

    function createThemePicker() {
        const btn = document.createElement('button');
        btn.className = 'theme-picker-btn';
        btn.title = 'Change Theme';
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';

        const popup = document.createElement('div');
        popup.className = 'theme-picker-popup';
        popup.style.display = 'none';

        const current = getCurrentTheme();

        // Built-in themes
        for (const [id, theme] of Object.entries(THEMES)) {
            popup.appendChild(createThemeItem(id, theme.label,
                `linear-gradient(135deg, ${theme.vars['--accent']}, ${theme.vars['--accent-secondary']})`,
                id === current, popup));
        }

        // Divider
        const divider = document.createElement('div');
        divider.className = 'theme-picker-divider';
        popup.appendChild(divider);

        // Custom wallpaper option
        const customItem = document.createElement('button');
        customItem.className = 'theme-picker-item theme-picker-custom' + (current === 'custom' ? ' active' : '');
        customItem.setAttribute('data-theme-id', 'custom');
        customItem.innerHTML = '<span class="theme-swatch theme-swatch-custom"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></span><span class="theme-label">My Wallpaper</span>';

        customItem.addEventListener('click', () => {
            if (localStorage.getItem(WALLPAPER_KEY)) {
                applyTheme('custom');
                setActive(popup, customItem);
                setTimeout(() => { popup.style.display = 'none'; }, 150);
            } else {
                promptWallpaperUpload((ok) => {
                    if (ok) {
                        applyTheme('custom');
                        setActive(popup, customItem);
                        setTimeout(() => { popup.style.display = 'none'; }, 150);
                    }
                });
            }
        });
        popup.appendChild(customItem);

        // Change / Publish row for custom wallpaper
        const customActions = document.createElement('div');
        customActions.className = 'theme-custom-actions';

        const changeBtn = document.createElement('button');
        changeBtn.className = 'theme-picker-action-btn';
        changeBtn.textContent = 'Change image';
        changeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            promptWallpaperUpload((ok) => {
                if (ok) {
                    applyTheme('custom');
                    setActive(popup, customItem);
                }
            });
        });
        customActions.appendChild(changeBtn);

        const publishBtn = document.createElement('button');
        publishBtn.className = 'theme-picker-action-btn theme-picker-publish-btn';
        publishBtn.textContent = 'Publish';
        publishBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!window.ArcadeAuth || !window.ArcadeAuth.isLoggedIn()) {
                alert('Log in to publish themes');
                return;
            }
            if (!localStorage.getItem(WALLPAPER_KEY)) {
                alert('Set a wallpaper first');
                return;
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
                    refreshCommunitySection(popup);
                }, 1500);
            }).catch(err => {
                alert('Failed to publish: ' + err.message);
                publishBtn.textContent = 'Publish';
                publishBtn.disabled = false;
            });
        });
        customActions.appendChild(publishBtn);
        popup.appendChild(customActions);

        // Community themes section
        const communityDivider = document.createElement('div');
        communityDivider.className = 'theme-picker-divider';
        popup.appendChild(communityDivider);

        const communityHeader = document.createElement('div');
        communityHeader.className = 'theme-community-header';
        communityHeader.textContent = 'Community Themes';
        popup.appendChild(communityHeader);

        const communityList = document.createElement('div');
        communityList.className = 'theme-community-list';
        communityList.innerHTML = '<div class="theme-community-loading">Loading...</div>';
        popup.appendChild(communityList);

        // Toggle popup
        btn.addEventListener('click', () => {
            const isOpen = popup.style.display === 'block';
            popup.style.display = isOpen ? 'none' : 'block';
            if (!isOpen) refreshCommunitySection(popup);
        });

        document.addEventListener('click', (e) => {
            if (!wrapper.contains(e.target)) {
                popup.style.display = 'none';
            }
        });

        const wrapper = document.createElement('div');
        wrapper.className = 'theme-picker-wrapper';
        wrapper.appendChild(btn);
        wrapper.appendChild(popup);
        return wrapper;
    }

    function createThemeItem(id, label, swatchBg, isActive, popup) {
        const item = document.createElement('button');
        item.className = 'theme-picker-item' + (isActive ? ' active' : '');
        item.setAttribute('data-theme-id', id);

        const swatch = document.createElement('span');
        swatch.className = 'theme-swatch';
        swatch.style.background = swatchBg;

        const lbl = document.createElement('span');
        lbl.className = 'theme-label';
        lbl.textContent = label;

        item.appendChild(swatch);
        item.appendChild(lbl);

        item.addEventListener('click', () => {
            applyTheme(id);
            setActive(popup, item);
            setTimeout(() => { popup.style.display = 'none'; }, 150);
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
        list.innerHTML = '<div class="theme-community-loading">Loading...</div>';

        const themes = await loadCommunityThemes();
        list.innerHTML = '';

        if (themes.length === 0) {
            list.innerHTML = '<div class="theme-community-empty">No community themes yet</div>';
            return;
        }

        const current = getCurrentTheme();
        const currentUser = window.ArcadeAuth && window.ArcadeAuth.getUser();
        const isAdmin = window.ArcadeAuth && window.ArcadeAuth.isAdmin();

        themes.forEach(t => {
            const themeId = 'community:' + t.id;
            const row = document.createElement('div');
            row.className = 'theme-community-item' + (current === themeId ? ' active' : '');

            // Thumbnail from the stored image (tiny preview)
            const thumb = document.createElement('div');
            thumb.className = 'theme-community-thumb';
            if (t.image) {
                thumb.style.backgroundImage = `url(${t.image})`;
            }

            const info = document.createElement('div');
            info.className = 'theme-community-info';

            const nameEl = document.createElement('span');
            nameEl.className = 'theme-community-name';
            nameEl.textContent = t.name;

            const author = document.createElement('span');
            author.className = 'theme-community-author';
            author.textContent = 'by ' + (t.createdByName || 'Unknown');

            info.appendChild(nameEl);
            info.appendChild(author);

            row.appendChild(thumb);
            row.appendChild(info);

            // Delete button for creator or admin
            if (currentUser && (currentUser.uid === t.createdBy || isAdmin)) {
                const delBtn = document.createElement('button');
                delBtn.className = 'theme-community-delete';
                delBtn.innerHTML = '&times;';
                delBtn.title = 'Delete theme';
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!confirm('Delete "' + t.name + '"?')) return;
                    deleteCommunityTheme(t.id).then(() => {
                        // If currently using this theme, switch to midnight
                        if (getCurrentTheme() === themeId) applyTheme('midnight');
                        refreshCommunitySection(popup);
                    });
                });
                row.appendChild(delBtn);
            }

            row.addEventListener('click', () => {
                applyTheme(themeId);
                // Cache the image locally for instant load next time
                if (t.image) {
                    try { localStorage.setItem(COMMUNITY_CACHE_KEY + ':' + t.id, t.image); } catch (e) {}
                }
                popup.querySelectorAll('.theme-picker-item').forEach(el => el.classList.remove('active'));
                popup.querySelectorAll('.theme-community-item').forEach(el => el.classList.remove('active'));
                row.classList.add('active');
                setTimeout(() => { popup.style.display = 'none'; }, 150);
            });

            list.appendChild(row);
        });
    }

    // Apply saved theme immediately
    applyTheme(getCurrentTheme());

    // Insert theme picker into the page
    document.addEventListener('DOMContentLoaded', () => {
        const header = document.querySelector('.header-content') || document.querySelector('.player-actions');
        if (header) {
            const picker = createThemePicker();
            const authArea = header.querySelector('.auth-area');
            if (authArea) {
                header.insertBefore(picker, authArea);
            } else {
                header.appendChild(picker);
            }
        }
    });

    window.ArcadeThemes = { applyTheme, getCurrentTheme, THEMES, publishTheme, loadCommunityThemes };
})();
