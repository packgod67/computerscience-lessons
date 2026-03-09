(function () {
    let db;
    let unsubscribe = null;
    const EXPIRY_MS = 5 * 60 * 60 * 1000; // 5 hours
    let usersMap = {}; // uid -> { username, role, roleIds }
    let rolesMap = {}; // roleId -> { name, color, priority }

    function getDb() {
        if (!db) db = ArcadeAuth.getDb();
        return db;
    }

    function esc(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatTime(timestamp) {
        if (!timestamp) return '';
        const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    async function loadUsersAndRoles() {
        try {
            const [usersSnap, rolesSnap] = await Promise.all([
                getDb().collection('users').get(),
                getDb().collection('roles').get()
            ]);
            usersMap = {};
            usersSnap.docs.forEach(d => { usersMap[d.id] = d.data(); });
            rolesMap = {};
            rolesSnap.docs.forEach(d => { rolesMap[d.id] = d.data(); });
        } catch {}
    }

    function getUserNameColor(uid) {
        const user = usersMap[uid];
        if (!user || !user.roleIds || user.roleIds.length === 0) return null;
        // Find highest priority role (lowest number = highest priority)
        let best = null;
        for (const id of user.roleIds) {
            const role = rolesMap[id];
            if (!role) continue;
            if (!best || (role.priority || 99) < (best.priority || 99)) {
                best = role;
            }
        }
        return best ? best.color : null;
    }

    function getUserRoleBadges(uid) {
        const user = usersMap[uid];
        if (!user || !user.roleIds || user.roleIds.length === 0) return '';
        return user.roleIds
            .map(id => rolesMap[id])
            .filter(Boolean)
            .sort((a, b) => (a.priority || 0) - (b.priority || 0))
            .map(r => `<span class="chat-role-badge" style="background:${esc(r.color)}">${esc(r.name)}</span>`)
            .join('');
    }

    async function init() {
        const container = document.getElementById('chatView');
        if (!container) return;

        const isAdmin = ArcadeAuth.isAdmin();
        const manageBtn = isAdmin ? '<button class="emoji-manage-btn" id="emojiManageBtn">Manage Emojis</button>' : '';

        container.innerHTML = `
            <div class="chat-panel">
                <div class="chat-header-bar">${manageBtn}</div>
                <div class="chat-messages" id="chatMessages">
                    <div class="chat-empty">No messages yet. Say something!</div>
                </div>
                <div class="chat-input-bar">
                    <input type="text" id="chatInput" class="chat-input" placeholder="Type a message..." maxlength="500" autocomplete="off">
                    <button class="emoji-picker-btn" id="emojiPickerBtn" title="Emojis">&#128578;</button>
                    <button class="chat-send-btn" id="chatSendBtn">Send</button>
                </div>
            </div>`;

        const input = document.getElementById('chatInput');
        const sendBtn = document.getElementById('chatSendBtn');

        sendBtn.addEventListener('click', sendMessage);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // Emoji picker button
        const inputBar = document.querySelector('.chat-input-bar');
        document.getElementById('emojiPickerBtn')?.addEventListener('click', () => {
            if (window.ArcadeEmojis) {
                ArcadeEmojis.renderEmojiPicker(inputBar, input);
            }
        });

        // Admin: manage emojis button
        if (isAdmin) {
            document.getElementById('emojiManageBtn')?.addEventListener('click', () => {
                if (window.ArcadeEmojis) ArcadeEmojis.showEmojiManagementModal();
            });
        }

        // Load emojis + start listener
        if (window.ArcadeEmojis) {
            await ArcadeEmojis.loadEmojis();
            ArcadeEmojis.startListener();
        }

        // Load users/roles for name coloring
        await loadUsersAndRoles();

        // Start listening for messages
        listenMessages();

        // Cleanup expired messages periodically
        cleanupExpired();
    }

    async function sendMessage() {
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if (!text) return;

        const user = ArcadeAuth.getUser();
        if (!user) return;

        input.value = '';
        input.focus();

        try {
            await getDb().collection('chat').add({
                uid: user.uid,
                username: ArcadeAuth.getUsername(),
                text: text,
                role: ArcadeAuth.isAdmin() ? 'admin' : 'user',
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch (e) {
            input.value = text;
            alert('Failed to send: ' + e.message);
        }
    }

    function listenMessages() {
        if (unsubscribe) unsubscribe();

        const cutoff = new Date(Date.now() - EXPIRY_MS);

        unsubscribe = getDb().collection('chat')
            .where('createdAt', '>', cutoff)
            .orderBy('createdAt', 'asc')
            .onSnapshot((snap) => {
                renderMessages(snap.docs.map(d => ({ id: d.id, ...d.data() })));
            }, () => {
                getDb().collection('chat').get().then(snap => {
                    const msgs = snap.docs
                        .map(d => ({ id: d.id, ...d.data() }))
                        .filter(m => {
                            const t = m.createdAt?.toMillis?.() || 0;
                            return t > Date.now() - EXPIRY_MS;
                        })
                        .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
                    renderMessages(msgs);
                }).catch(() => {});
            });
    }

    function renderMessages(messages) {
        const container = document.getElementById('chatMessages');
        if (!container) return;

        const currentUid = ArcadeAuth.getUser()?.uid;
        const isAdmin = ArcadeAuth.isAdmin();
        const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;

        if (messages.length === 0) {
            container.innerHTML = '<div class="chat-empty">No messages yet. Say something!</div>';
            return;
        }

        let html = '';
        for (const msg of messages) {
            const isSelf = msg.uid === currentUid;
            const isAdminMsg = msg.role === 'admin';
            const adminBadge = isAdminMsg ? '<span class="chat-admin-badge">ADMIN</span>' : '';
            const roleBadges = getUserRoleBadges(msg.uid);
            const nameColor = getUserNameColor(msg.uid);
            const nameStyle = nameColor ? ` style="color:${esc(nameColor)}"` : '';
            const deleteBtn = (isAdmin || isSelf) ? `<button class="chat-delete-btn" data-id="${esc(msg.id)}" title="Delete">&times;</button>` : '';
            const selfClass = isSelf ? ' chat-msg-self' : '';

            html += `<div class="chat-msg${selfClass}">
                <div class="chat-msg-header">
                    <span class="chat-msg-user${isAdminMsg && !nameColor ? ' chat-msg-user-admin' : ''}"${nameStyle}>${esc(msg.username || 'unknown')}</span>${adminBadge}${roleBadges}
                    <span class="chat-msg-time">${formatTime(msg.createdAt)}</span>
                    ${deleteBtn}
                </div>
                <div class="chat-msg-text">${window.ArcadeEmojis ? ArcadeEmojis.replaceEmojis(esc(msg.text)) : esc(msg.text)}</div>
            </div>`;
        }

        container.innerHTML = html;

        if (wasAtBottom) {
            container.scrollTop = container.scrollHeight;
        }

        container.querySelectorAll('.chat-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await getDb().collection('chat').doc(btn.dataset.id).delete();
                } catch (e) { alert('Delete failed: ' + e.message); }
            });
        });
    }

    async function cleanupExpired() {
        try {
            const cutoff = new Date(Date.now() - EXPIRY_MS);
            const snap = await getDb().collection('chat').where('createdAt', '<', cutoff).get();
            const batch = getDb().batch();
            snap.docs.forEach(doc => batch.delete(doc.ref));
            if (snap.size > 0) await batch.commit();
        } catch {}
    }

    window.ArcadeChat = { init };
})();
