(function () {
    const firebaseConfig = {
        apiKey: "AIzaSyCcjeCiENcULSONqmojguCUiIBXX3AomEg",
        authDomain: "computersciencelessons.firebaseapp.com",
        projectId: "computersciencelessons",
        storageBucket: "computersciencelessons.firebasestorage.app",
        messagingSenderId: "711030877905",
        appId: "1:711030877905:web:d8f177eb58bc46f4d89ff0"
    };

    const EMAIL_SUFFIX = '@arcade.local';
    const ADMIN_USERNAME = 'packgod67';
    let auth, db;
    let currentUser = null;
    let userRole = null;
    let userRoleIds = [];
    let favorites = new Set();
    let authReady = false;
    const authCallbacks = [];
    const favCallbacks = [];
    let authReadyResolve;
    const authReadyPromise = new Promise(r => { authReadyResolve = r; });

    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db = firebase.firestore();

    auth.onAuthStateChanged(async (user) => {
        currentUser = user;
        if (user) {
            await loadUserData();
            // Check if banned
            const doc = await db.collection('users').doc(user.uid).get();
            if (doc.exists && doc.data().banned) {
                await auth.signOut();
                currentUser = null;
                userRole = null;
                favorites.clear();
                alert('Your account has been banned.');
                authReady = true;
                authReadyResolve();
                authCallbacks.forEach(cb => cb(null));
                return;
            }
            // Check if approved — only block if explicitly set to false (new registrations)
            // Users with approved:true, approved:undefined, or missing field can log in fine
            if (doc.exists && doc.data().approved === false && doc.data().role !== 'admin') {
                await auth.signOut();
                currentUser = null;
                userRole = null;
                favorites.clear();
                showPendingApproval();
                authReady = true;
                authReadyResolve();
                authCallbacks.forEach(cb => cb(null));
                return;
            }
        } else {
            favorites.clear();
            userRole = null;
        }
        authReady = true;
        authReadyResolve();
        authCallbacks.forEach(cb => cb(user));
        favCallbacks.forEach(cb => cb(favorites));

        // Backfill joinedAt for existing users who registered before the field existed.
        // Fire-and-forget so it doesn't block login.
        if (user) ensureJoinedAt();
        // Track daily login streak (fire-and-forget). On consecutive days
        // streak.count increments; on a same-day login it stays; on a gap
        // it resets to 1.
        if (user) updateLoginStreak();
    });

    async function updateLoginStreak() {
        if (!currentUser) return;
        try {
            const ref = db.collection('users').doc(currentUser.uid);
            const doc = await ref.get();
            const data = doc.exists ? doc.data() : {};
            const today = new Date().toISOString().slice(0, 10);
            const prev = data.loginStreak || { count: 0, lastDay: '' };
            if (prev.lastDay === today) return; // already counted today
            // Compute "yesterday" string in same UTC day basis
            const y = new Date();
            y.setUTCDate(y.getUTCDate() - 1);
            const yest = y.toISOString().slice(0, 10);
            const newCount = prev.lastDay === yest ? (prev.count || 0) + 1 : 1;
            await ref.set({
                loginStreak: { count: newCount, lastDay: today }
            }, { merge: true });
        } catch {}
    }

    async function loadUserData() {
        if (!currentUser) return;
        try {
            const doc = await db.collection('users').doc(currentUser.uid).get();
            const username = toUsername(currentUser);
            const role = username === ADMIN_USERNAME ? 'admin' : 'user';
            if (doc.exists) {
                const data = doc.data();
                favorites = new Set(data.favorites || []);
                userRole = data.role || null;
                userRoleIds = data.roleIds || [];
                // Auto-fix: ensure username and admin role are always set
                const fixes = {};
                if (!data.username) fixes.username = username;
                if (username === ADMIN_USERNAME && userRole !== 'admin') fixes.role = 'admin';
                if (Object.keys(fixes).length > 0) {
                    await db.collection('users').doc(currentUser.uid).set(fixes, { merge: true });
                    if (fixes.role) userRole = 'admin';
                }
            } else {
                // Doc missing — recreate it
                userRole = role;
                favorites = new Set();
                userRoleIds = [];
                const approved = role === 'admin';
                await db.collection('users').doc(currentUser.uid).set({
                    username, role, favorites: [], roleIds: [], approved
                });
                // Also ensure username reservation exists
                await db.collection('usernames').doc(username).set({ uid: currentUser.uid }).catch(() => {});
            }
        } catch {
            favorites = new Set();
            userRole = null;
            userRoleIds = [];
        }
    }

    function toEmail(username) {
        return username.toLowerCase().trim() + EMAIL_SUFFIX;
    }

    function toUsername(user) {
        if (!user) return '';
        return user.email.replace(EMAIL_SUFFIX, '');
    }

    async function isUsernameTaken(username) {
        try {
            const snap = await db.collection('usernames').doc(username.toLowerCase().trim()).get();
            return snap.exists;
        } catch {
            return false;
        }
    }

    async function register(username, password) {
        const cleanName = username.toLowerCase().trim();
        // Check username uniqueness
        const taken = await isUsernameTaken(cleanName);
        if (taken) {
            throw new Error('Username is already taken.');
        }
        const cred = await auth.createUserWithEmailAndPassword(toEmail(username), password);
        // Reserve the username and set role
        const role = cleanName === ADMIN_USERNAME ? 'admin' : 'user';
        const approved = role === 'admin';
        await db.collection('usernames').doc(cleanName).set({ uid: cred.user.uid });
        await db.collection('users').doc(cred.user.uid).set(
            { username: cleanName, role: role, favorites: [], approved: approved },
            { merge: true }
        );
        userRole = role;
        if (!approved) {
            await auth.signOut();
            currentUser = null;
            userRole = null;
            showPendingApproval();
            throw new Error('__PENDING__');
        }
        return cred;
    }

    async function login(username, password) {
        return auth.signInWithEmailAndPassword(toEmail(username), password);
    }

    async function logout() {
        return auth.signOut();
    }

    async function toggleFavorite(gameId) {
        if (!currentUser) return false;
        if (favorites.has(gameId)) {
            favorites.delete(gameId);
        } else {
            favorites.add(gameId);
        }
        try {
            await db.collection('users').doc(currentUser.uid).set(
                { favorites: [...favorites] },
                { merge: true }
            );
        } catch (e) {
            console.error('Failed to save favorite:', e);
        }
        favCallbacks.forEach(cb => cb(favorites));
        return favorites.has(gameId);
    }

    function isFavorite(gameId) {
        return favorites.has(gameId);
    }

    function isLoggedIn() {
        return currentUser !== null;
    }

    function isAdmin() {
        return userRole === 'admin';
    }

    function getUser() {
        return currentUser;
    }

    function getUsername() {
        return toUsername(currentUser);
    }

    function isAuthReady() {
        return authReady;
    }

    function waitForAuth() {
        return authReadyPromise;
    }

    function onAuthChange(cb) {
        authCallbacks.push(cb);
        cb(currentUser);
    }

    function onFavoritesChange(cb) {
        favCallbacks.push(cb);
    }

    function showPendingApproval() {
        let el = document.getElementById('pendingApproval');
        if (el) { el.style.display = 'flex'; return; }
        el = document.createElement('div');
        el.id = 'pendingApproval';
        el.className = 'login-gate';
        el.innerHTML = `
            <div class="login-gate-box">
                <div class="login-gate-logo">
                    <span class="logo-icon">&#9203;</span>
                    <h1>PENDING APPROVAL</h1>
                </div>
                <p class="login-gate-tagline">Your account is waiting for admin approval.<br>Please check back later.</p>
                <button class="auth-submit" id="pendingBackBtn">Back to Login</button>
            </div>`;
        document.body.appendChild(el);
        document.getElementById('pendingBackBtn').addEventListener('click', () => {
            el.style.display = 'none';
            showLoginGate();
        });
    }

    function hidePendingApproval() {
        const el = document.getElementById('pendingApproval');
        if (el) el.style.display = 'none';
    }

    async function approveUser(uid, approve) {
        await db.collection('users').doc(uid).set({ approved: !!approve }, { merge: true });
    }

    async function getPendingUsers() {
        const snap = await db.collection('users').where('approved', '==', false).get();
        return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    }

    function showApprovalPanel() {
        let modal = document.getElementById('approvalModal');
        if (modal) modal.remove();
        modal = document.createElement('div');
        modal.id = 'approvalModal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-box" style="max-width:500px;">
                <h2 style="margin:0 0 12px;">Pending Approvals</h2>
                <div id="approvalList" style="max-height:400px;overflow-y:auto;">Loading...</div>
                <button class="auth-submit" id="closeApprovalBtn" style="margin-top:12px;">Close</button>
            </div>`;
        document.body.appendChild(modal);
        document.getElementById('closeApprovalBtn').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
        loadPendingUsers();
    }

    async function loadPendingUsers() {
        const list = document.getElementById('approvalList');
        if (!list) return;
        const pending = await getPendingUsers();
        if (pending.length === 0) {
            list.innerHTML = '<p style="color:#aaa;">No pending users.</p>';
            return;
        }
        list.innerHTML = pending.map(u => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;border-bottom:1px solid #333;">
                <span style="color:#fff;font-weight:bold;">${u.username || u.uid}</span>
                <div>
                    <button class="auth-submit approve-btn" data-uid="${u.uid}" style="padding:4px 12px;font-size:13px;margin-right:6px;">Approve</button>
                    <button class="auth-submit auth-secondary reject-btn" data-uid="${u.uid}" style="padding:4px 12px;font-size:13px;">Reject</button>
                </div>
            </div>
        `).join('');
        list.querySelectorAll('.approve-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await approveUser(btn.dataset.uid, true);
                loadPendingUsers();
            });
        });
        list.querySelectorAll('.reject-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                await db.collection('users').doc(btn.dataset.uid).delete();
                loadPendingUsers();
            });
        });
    }

    function showLoginGate() {
        document.body.classList.add('auth-gated');
        let gate = document.getElementById('loginGate');
        if (gate) { gate.style.display = 'flex'; return; }

        gate = document.createElement('div');
        gate.id = 'loginGate';
        gate.className = 'login-gate';
        gate.innerHTML = `
            <div class="login-gate-box">
                <div class="login-gate-logo">
                    <span class="logo-icon">&#127918;</span>
                    <h1>ARCADE</h1>
                </div>
                <p class="login-gate-tagline">Log in or register to access the arcade</p>
                <form class="auth-form" onsubmit="return false;" autocomplete="on">
                    <input type="text" id="gateUsername" placeholder="Username" class="auth-input" autocomplete="username">
                    <input type="password" id="gatePassword" placeholder="Password" class="auth-input" autocomplete="current-password">
                    <div class="auth-actions">
                        <button type="submit" class="auth-submit" id="gateLoginBtn">Log in</button>
                        <button type="button" class="auth-submit auth-secondary" id="gateRegisterBtn">Register</button>
                    </div>
                </form>
                <p class="auth-error" id="gateError"></p>
            </div>`;
        document.body.appendChild(gate);

        const userInput = document.getElementById('gateUsername');
        const passInput = document.getElementById('gatePassword');
        const errorEl = document.getElementById('gateError');

        function cleanError(msg) {
            return msg.replace('Firebase: ', '')
                .replace(/\(auth\/.*\)\.?/, '')
                .replace('email address', 'username')
                .replace('email', 'username')
                .trim();
        }

        async function doLogin() {
            errorEl.textContent = '';
            if (!userInput.value || !passInput.value) {
                errorEl.textContent = 'Enter username and password.';
                return;
            }
            try {
                await login(userInput.value, passInput.value);
            } catch (e) {
                errorEl.textContent = cleanError(e.message);
            }
        }

        async function doRegister() {
            errorEl.textContent = '';
            if (!userInput.value || !passInput.value) {
                errorEl.textContent = 'Enter username and password.';
                return;
            }
            if (passInput.value.length < 6) {
                errorEl.textContent = 'Password must be at least 6 characters.';
                return;
            }
            try {
                await register(userInput.value, passInput.value);
            } catch (e) {
                if (e.message === '__PENDING__') return;
                errorEl.textContent = cleanError(e.message);
            }
        }

        document.getElementById('gateLoginBtn').addEventListener('click', doLogin);
        document.getElementById('gateRegisterBtn').addEventListener('click', doRegister);
        passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
        userInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') passInput.focus(); });
    }

    function hideLoginGate() {
        document.body.classList.remove('auth-gated');
        const gate = document.getElementById('loginGate');
        if (gate) gate.style.display = 'none';
    }

    function bindAuthUI() {
        const authArea = document.getElementById('authArea');
        if (!authArea) return;

        function renderLoggedOut() {
            authArea.innerHTML = `
                <button class="auth-btn" id="authToggle">Log in</button>
                <div class="auth-dropdown" id="authDropdown">
                    <form class="auth-form" onsubmit="return false;" autocomplete="on">
                        <input type="text" id="authUsername" placeholder="Username" class="auth-input" autocomplete="username">
                        <input type="password" id="authPassword" placeholder="Password" class="auth-input" autocomplete="current-password">
                        <div class="auth-actions">
                            <button type="submit" class="auth-submit" id="loginBtn">Log in</button>
                            <button type="button" class="auth-submit auth-secondary" id="registerBtn">Register</button>
                        </div>
                    </form>
                    <p class="auth-error" id="authError"></p>
                </div>`;
            bindDropdown();
            showLoginGate();
        }

        function renderLoggedIn() {
            const adminBadge = isAdmin() ? '<span class="auth-admin-badge">ADMIN</span>' : '';
            const approvalBtn = isAdmin() ? '<button class="auth-btn" id="approvalBtn" title="Pending Approvals">&#9998; Approvals</button>' : '';
            const uid = currentUser ? currentUser.uid : '';
            // data-open-profile-uid hooks into profiles.js's delegated click handler
            // so the username opens your own profile modal when clicked.
            authArea.innerHTML = `
                <span class="auth-user-info">
                    ${adminBadge}
                    <span class="auth-username" data-open-profile-uid="${uid}" role="button" tabindex="0" title="View my profile">${getUsername()}</span>
                    ${approvalBtn}
                    <button class="auth-btn" id="logoutBtn">Log out</button>
                </span>`;
            document.getElementById('logoutBtn').addEventListener('click', () => logout());
            const appBtn = document.getElementById('approvalBtn');
            if (appBtn) appBtn.addEventListener('click', showApprovalPanel);
            hideLoginGate();
        }

        function bindDropdown() {
            const toggle = document.getElementById('authToggle');
            const dropdown = document.getElementById('authDropdown');
            const loginBtn = document.getElementById('loginBtn');
            const registerBtn = document.getElementById('registerBtn');
            const userInput = document.getElementById('authUsername');
            const passInput = document.getElementById('authPassword');
            const errorEl = document.getElementById('authError');

            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdown.classList.toggle('open');
            });

            document.addEventListener('click', (e) => {
                if (!dropdown.contains(e.target) && e.target !== toggle) {
                    dropdown.classList.remove('open');
                }
            });

            function cleanError(msg) {
                return msg.replace('Firebase: ', '')
                    .replace(/\(auth\/.*\)\.?/, '')
                    .replace('email address', 'username')
                    .replace('email', 'username')
                    .trim();
            }

            async function doLogin() {
                errorEl.textContent = '';
                if (!userInput.value || !passInput.value) {
                    errorEl.textContent = 'Enter username and password.';
                    return;
                }
                try {
                    await login(userInput.value, passInput.value);
                    dropdown.classList.remove('open');
                } catch (e) {
                    errorEl.textContent = cleanError(e.message);
                }
            }

            async function doRegister() {
                errorEl.textContent = '';
                if (!userInput.value || !passInput.value) {
                    errorEl.textContent = 'Enter username and password.';
                    return;
                }
                if (passInput.value.length < 6) {
                    errorEl.textContent = 'Password must be at least 6 characters.';
                    return;
                }
                try {
                    await register(userInput.value, passInput.value);
                    dropdown.classList.remove('open');
                } catch (e) {
                    if (e.message === '__PENDING__') return;
                    errorEl.textContent = cleanError(e.message);
                }
            }

            loginBtn.addEventListener('click', doLogin);
            registerBtn.addEventListener('click', doRegister);
            passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
            userInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') passInput.focus(); });
        }

        onAuthChange((user) => {
            if (user) renderLoggedIn();
            else renderLoggedOut();
        });
    }

    // ===== Active Users Presence =====
    let presenceInterval = null;
    let currentGameId = null; // which game this tab is playing, if any

    function startPresence() {
        if (presenceInterval) return;
        sendHeartbeat();
        presenceInterval = setInterval(sendHeartbeat, 60000); // every 60s
    }

    function stopPresence() {
        if (presenceInterval) {
            clearInterval(presenceInterval);
            presenceInterval = null;
        }
        if (currentUser) {
            db.collection('presence').doc(currentUser.uid).delete().catch(() => {});
        }
    }

    async function sendHeartbeat() {
        if (!currentUser) return;
        try {
            const payload = {
                username: toUsername(currentUser),
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            };
            if (currentGameId) payload.currentGame = currentGameId;
            else payload.currentGame = firebase.firestore.FieldValue.delete();
            await db.collection('presence').doc(currentUser.uid).set(payload, { merge: true });
        } catch {}
    }

    // Set the game this tab is currently playing, e.g. from player.js
    function setCurrentGame(gameId) {
        currentGameId = gameId || null;
        if (currentUser) sendHeartbeat();
    }

    function listenActiveUsers(callback) {
        // Legacy count-only listener (kept for backwards compat).
        // listenActiveUsersDetailed is the preferred API.
        return listenActiveUsersDetailed((users) => callback(users.length));
    }

    // Detailed listener — returns full user list including currentGame.
    // Cleans out stale entries (>2min) client-side in case the where()
    // filter misses server clock skew edges.
    function listenActiveUsersDetailed(callback) {
        const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
        return db.collection('presence')
            .where('lastSeen', '>', twoMinAgo)
            .onSnapshot((snap) => {
                const cutoff = Date.now() - 2 * 60 * 1000;
                const users = snap.docs.map(doc => {
                    const d = doc.data();
                    const ts = d.lastSeen && d.lastSeen.toMillis ? d.lastSeen.toMillis() : 0;
                    return {
                        uid: doc.id,
                        username: d.username || '',
                        currentGame: d.currentGame || null,
                        lastSeen: ts,
                    };
                }).filter(u => u.lastSeen >= cutoff);
                callback(users);
            }, () => {
                callback([]);
            });
    }

    // Start/stop presence on auth change
    onAuthChange((user) => {
        if (user) {
            startPresence();
        } else {
            stopPresence();
        }
    });

    // Cleanup on page unload — use visibilitychange + beforeunload
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && currentUser) {
            // Set lastSeen to past so they expire immediately
            db.collection('presence').doc(currentUser.uid).delete().catch(() => {});
        } else if (document.visibilityState === 'visible' && currentUser) {
            sendHeartbeat();
        }
    });

    window.addEventListener('beforeunload', () => {
        if (currentUser) {
            db.collection('presence').doc(currentUser.uid).delete().catch(() => {});
        }
    });

    async function banUser(uid, ban) {
        await db.collection('users').doc(uid).set({ banned: !!ban }, { merge: true });
    }

    // ===== Profile: read/write profile fields on users/{uid} =====
    // Fields: avatar, bio, wallpaper, accent, showcase[], recentPlays[], joinedAt
    async function getProfile(uid) {
        if (!uid) return null;
        try {
            const doc = await db.collection('users').doc(uid).get();
            if (!doc.exists) return null;
            return { uid, ...doc.data() };
        } catch (e) {
            console.error('getProfile failed:', e);
            return null;
        }
    }

    async function updateProfile(fields) {
        if (!currentUser) throw new Error('Not logged in');
        // Whitelist to prevent clients overwriting protected fields
        // (role, banned, approved are blocked by the Firestore rule
        // anyway — this whitelist is belt-and-suspenders).
        const allowed = [
            'avatar', 'bio', 'wallpaper', 'accent', 'showcase', 'widgets',
            'usernameColor', 'profileBgm',
            // Profile customization v2 (visual)
            'tagline', 'status', 'avatarFrame', 'layoutStyle',
            'bgEffect', 'borderStyle', 'artwork', 'privacy',
            // Personal header tagline (rendered between settings + install)
            'headerQuote',
            // Profile customization v3 (everything fancy)
            'usernameEffect',   // 'none'|'rainbow'|'fire'|'glitch'|'typewriter'|'sparkle'
            'usernameGlow',     // color string
            'avatarAura',       // 'none'|'hearts'|'sparks'|'fire'|'planets'|'butterflies'
            'avatarAccessory',  // 'none'|'crown'|'halo'|'partyhat'|'devilhorns'|'headphones'
            'entryAnimation',   // 'none'|'fade'|'slide'|'pixelate'|'glitch'|'zoom'|'shatter'
            'profileFont',      // 'system'|'pixel'|'gothic'|'futuristic'|'handwritten'|'serif'|'mono'|'rounded'|'elegant'
            'profileCursor',    // 'default'|'sword'|'paw'|'magic'|'pixel'|'crosshair'
            'cursorTrail',      // 'none'|'sparkles'|'hearts'|'stars'|'fire'|'dots'
            'titleText',        // string above username (e.g. "Level 99 Wizard")
            'enterSound',       // url played on profile open
            'intoTags',         // ["RPGs", "Roguelites", ...]
            'quoteWidget',      // pinned quote string
            'musicEmbed',       // spotify/youtube/soundcloud embed url
            'reactions',        // { fire: 12, skull: 4, crown: 3, ... } - written by visitors via cross-user hatch
            // Site-wide
            'tabBackgrounds',   // { games: '#color', users: '...', ... } - per-tab subtle bg color
            // Profile customization v4
            'usernameFont',     // separate font for the username only
            'profileTheme',     // arcade theme id to override visitors with
            'profilePet',       // 'none'|'cat'|'slime'|'duck'|'dragon'|'ghost'
            'onlineStatus',     // { dot: 'green'|'yellow'|'red'|'offline', message: '...' }
            'profileCss',       // sandboxed CSS injection (4KB cap)
            'profileBgmTracks', // [url, url, ...] - array of BGM tracks
            'wallpaperFg',      // foreground parallax layer URL
            'wallpaperBg',      // background parallax layer URL
            'pinnedAchievements', // up to 3 achievement ids displayed front-and-center
            'selectedTitle',    // currently-displayed title string (chosen from `titles`)
            'titles',           // [string] earned titles (server-only via cross-user write usually, but allowed here for client award)
            'badgeIds',         // [string] custom badge ids granted by admin
            'cards',            // [{gameId, rarity, droppedAt}] trading cards earned from plays
            'loginStreak',      // { count, lastDay: 'YYYY-MM-DD' }
            'miniGame',         // 'none'|'snake'|'2048'|'memory'
            'pinnedClip',       // youtube/twitch embed url
        ];
        const safe = {};
        for (const k of allowed) {
            if (fields[k] !== undefined) safe[k] = fields[k];
        }
        if (Object.keys(safe).length === 0) return;
        await db.collection('users').doc(currentUser.uid).set(safe, { merge: true });
    }

    async function trackPlay(gameId) {
        if (!currentUser || !gameId) return;
        try {
            const ref = db.collection('users').doc(currentUser.uid);
            const doc = await ref.get();
            const data = doc.exists ? doc.data() : {};
            let recent = Array.isArray(data.recentPlays) ? data.recentPlays.slice() : [];
            // Remove existing entry so the new one moves to front
            recent = recent.filter(e => e && e.gameId !== gameId);
            recent.unshift({ gameId, at: Date.now() });
            if (recent.length > 12) recent = recent.slice(0, 12);

            // Cumulative play counter — used for the profile's
            // "Top games" ranking. Stored as a flat map keyed by
            // gameId; we'd ideally use Firestore FieldValue.increment
            // on a nested key, but the dotted-path syntax requires
            // splitting and is brittle for unsanitized gameIds, so we
            // do read-modify-write here. recentPlays is already RMW so
            // the cost overlap is zero.
            const playCounts = (data.playCounts && typeof data.playCounts === 'object') ? { ...data.playCounts } : {};
            playCounts[gameId] = (playCounts[gameId] || 0) + 1;

            const updates = { recentPlays: recent, playCounts };
            if (!data.joinedAt) {
                updates.joinedAt = firebase.firestore.FieldValue.serverTimestamp();
            }
            await ref.set(updates, { merge: true });

            // Notify the rest of the app — achievements module checks
            // for milestones every time a play is recorded, friends
            // activity feed picks up the new entry, etc.
            try {
                window.dispatchEvent(new CustomEvent('arcade:play-tracked', {
                    detail: { gameId, count: playCounts[gameId], at: Date.now() }
                }));
            } catch {}
        } catch (e) {
            console.error('trackPlay failed:', e);
        }
    }

    // Also backfill joinedAt for users who existed before this field was added
    async function ensureJoinedAt() {
        if (!currentUser) return;
        try {
            const ref = db.collection('users').doc(currentUser.uid);
            const doc = await ref.get();
            if (doc.exists && !doc.data().joinedAt) {
                await ref.set({
                    joinedAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            }
        } catch (e) {}
    }

    window.ArcadeAuth = {
        register, login, logout,
        toggleFavorite, isFavorite, isLoggedIn, isAdmin, getUser, getUsername,
        onAuthChange, onFavoritesChange, getFavorites: () => favorites,
        bindAuthUI, isAuthReady, waitForAuth,
        showLoginGate, hideLoginGate,
        listenActiveUsers,
        getUserRoleIds: () => userRoleIds,
        getDb: () => db,
        banUser, approveUser, getPendingUsers, showApprovalPanel,
        getProfile, updateProfile, trackPlay, ensureJoinedAt,
        setCurrentGame, listenActiveUsersDetailed
    };
})();
