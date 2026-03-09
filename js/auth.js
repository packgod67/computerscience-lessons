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
        } else {
            favorites.clear();
            userRole = null;
        }
        authReady = true;
        authReadyResolve();
        authCallbacks.forEach(cb => cb(user));
        favCallbacks.forEach(cb => cb(favorites));
    });

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
                await db.collection('users').doc(currentUser.uid).set({
                    username, role, favorites: [], roleIds: []
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
        await db.collection('usernames').doc(cleanName).set({ uid: cred.user.uid });
        await db.collection('users').doc(cred.user.uid).set(
            { username: cleanName, role: role, favorites: [] },
            { merge: true }
        );
        userRole = role;
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
                <input type="text" id="gateUsername" placeholder="Username" class="auth-input" autocomplete="username">
                <input type="password" id="gatePassword" placeholder="Password" class="auth-input" autocomplete="current-password">
                <div class="auth-actions">
                    <button class="auth-submit" id="gateLoginBtn">Log in</button>
                    <button class="auth-submit auth-secondary" id="gateRegisterBtn">Register</button>
                </div>
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
                    <input type="text" id="authUsername" placeholder="Username" class="auth-input" autocomplete="username">
                    <input type="password" id="authPassword" placeholder="Password" class="auth-input" autocomplete="current-password">
                    <div class="auth-actions">
                        <button class="auth-submit" id="loginBtn">Log in</button>
                        <button class="auth-submit auth-secondary" id="registerBtn">Register</button>
                    </div>
                    <p class="auth-error" id="authError"></p>
                </div>`;
            bindDropdown();
            showLoginGate();
        }

        function renderLoggedIn() {
            const adminBadge = isAdmin() ? '<span class="auth-admin-badge">ADMIN</span>' : '';
            authArea.innerHTML = `
                <span class="auth-user-info">
                    ${adminBadge}
                    <span class="auth-username">${getUsername()}</span>
                    <button class="auth-btn" id="logoutBtn">Log out</button>
                </span>`;
            document.getElementById('logoutBtn').addEventListener('click', () => logout());
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
            await db.collection('presence').doc(currentUser.uid).set({
                username: toUsername(currentUser),
                lastSeen: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch {}
    }

    function listenActiveUsers(callback) {
        // Listen for presence docs updated in last 2 minutes
        const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
        return db.collection('presence')
            .where('lastSeen', '>', twoMinAgo)
            .onSnapshot((snap) => {
                callback(snap.size);
            }, () => {
                callback(0);
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

    window.ArcadeAuth = {
        register, login, logout,
        toggleFavorite, isFavorite, isLoggedIn, isAdmin, getUser, getUsername,
        onAuthChange, onFavoritesChange, getFavorites: () => favorites,
        bindAuthUI, isAuthReady, waitForAuth,
        showLoginGate, hideLoginGate,
        listenActiveUsers,
        getUserRoleIds: () => userRoleIds,
        getDb: () => db,
        banUser
    };
})();
