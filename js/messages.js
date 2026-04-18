// ===== Direct Messages =====
// User-to-user chat with real-time delivery + slide-in toast
// notifications that pop in from the top of any page (home, player,
// anywhere). Messages live in a flat Firestore collection for simple
// queries; conversation grouping happens client-side.
//
// Schema:
//   dm_messages/{id} = {
//     from:       uid string,
//     fromName:   display name cached at send time,
//     to:         uid string,
//     text:       string (<= 2000 chars),
//     pair:       sorted-uid pair joined with "_" (for per-conversation queries),
//     createdAt:  server timestamp,
//     deleteAt:   server timestamp (createdAt + 24h) — used by Firestore
//                 TTL to auto-delete stale messages. Client also filters
//                 expired messages so deletion appears instant.
//   }
//
// Firestore rule required (admin — add to rules):
//   match /dm_messages/{id} {
//     allow read: if request.auth != null
//       && (request.auth.uid == resource.data.from
//        || request.auth.uid == resource.data.to);
//     allow create: if request.auth != null
//       && request.auth.uid == request.resource.data.from
//       && request.resource.data.keys().hasAll(['from','to','text','pair','createdAt'])
//       && request.resource.data.text is string
//       && request.resource.data.text.size() <= 2000;
//     allow delete: if request.auth != null
//       && request.auth.uid == resource.data.from;
//   }

(function () {
    let db = null;
    let currentUid = null;
    let currentUsername = null;
    let inboxUnsub = null;
    let outboxUnsub = null;

    // conversations: Map<otherUid, { lastMessage, lastAt, lastFrom, unread }>
    const conversations = new Map();

    // Track which message ids we've seen so the initial snapshot doesn't
    // spam toasts with old messages. Populated during the "first page" of
    // the listener.
    const seenIds = new Set();
    let initialLoadDone = { inbox: false, outbox: false };

    // Callbacks that fire when the conversation list changes. Used by the
    // Messages tab renderer.
    const changeCallbacks = [];
    const onChange = (cb) => changeCallbacks.push(cb);
    const fireChange = () => { for (const c of changeCallbacks) { try { c(); } catch (e) {} } };

    // If the user is actively viewing a conversation with someone, we don't
    // show toasts for their messages — set by renderMessagesView().
    let activeConversationWith = null;

    // ─────────────────────────────────────────────────────────────
    // Firestore listeners
    // ─────────────────────────────────────────────────────────────

    function startListeners() {
        if (!db || !currentUid) return;

        // ONE listener for everything — uses `participants` array-contains so
        // the Firestore rules engine can always prove read access with the
        // simple rule:  `allow read: if uid in resource.data.participants`
        //
        // This replaces the old split inbox(to=me) / outbox(from=me) queries
        // which each needed their own rule branch and their own composite
        // index. Now there's only one query, one rule, one index.
        inboxUnsub = db.collection('dm_messages')
            .where('participants', 'array-contains', currentUid)
            .orderBy('createdAt', 'desc')
            .limit(200)
            .onSnapshot((snap) => {
                snap.docChanges().forEach((change) => {
                    if (change.type !== 'added') return;
                    const msg = { id: change.doc.id, ...change.doc.data() };
                    if (isExpired(msg)) return;  // skip 24h+ old

                    // The "other" party of the convo — used as the key in
                    // the conversation list regardless of who sent it.
                    const otherUid = (msg.from === currentUid) ? msg.to : msg.from;
                    updateConversation(otherUid, msg);

                    // Toast only for INCOMING (someone else → me), and only
                    // for messages that arrived AFTER the initial snapshot
                    // (so we don't spam the user with history on page load).
                    if (msg.from === currentUid) return;
                    if (!initialLoadDone.inbox) return;
                    if (seenIds.has(msg.id)) return;
                    seenIds.add(msg.id);
                    if (activeConversationWith === msg.from) return;
                    showToast(msg);
                });
                // Mark ids from the initial snapshot so subsequent changes
                // know they're truly new.
                if (!initialLoadDone.inbox) {
                    snap.forEach((d) => seenIds.add(d.id));
                    initialLoadDone.inbox = true;
                    initialLoadDone.outbox = true;
                }
                fireChange();
            }, (err) => console.warn('DM listener error:', err));

        // Outbox listener retired — single listener above covers both.
        outboxUnsub = null;

        startExpirySweep();
    }

    function stopListeners() {
        if (inboxUnsub) inboxUnsub();
        if (outboxUnsub) outboxUnsub();
        inboxUnsub = outboxUnsub = null;
        stopExpirySweep();
        conversations.clear();
        seenIds.clear();
        initialLoadDone = { inbox: false, outbox: false };
        fireChange();
    }

    function updateConversation(otherUid, msg) {
        if (!otherUid) return;
        const tsMs = msg.createdAt && msg.createdAt.toMillis
            ? msg.createdAt.toMillis()
            : Date.now();
        const existing = conversations.get(otherUid);
        if (!existing || tsMs > existing.lastAt) {
            conversations.set(otherUid, {
                other: otherUid,
                lastMessage: msg.text || '',
                lastAt: tsMs,
                lastFrom: msg.from,
                fromName: msg.fromName,
            });
        }
    }

    // Periodic sweep — evict conversations whose last message has aged past
    // the 24h TTL so they disappear from the inbox even if no new event
    // fires the listener. Fires a change notification if anything moved.
    let expirySweepInterval = null;
    function startExpirySweep() {
        stopExpirySweep();
        expirySweepInterval = setInterval(() => {
            const cutoff = Date.now() - MESSAGE_TTL_MS;
            let changed = false;
            for (const [uid, c] of conversations.entries()) {
                if (c.lastAt <= cutoff) {
                    conversations.delete(uid);
                    changed = true;
                }
            }
            if (changed) fireChange();
        }, 5 * 60 * 1000);  // every 5 minutes
    }
    function stopExpirySweep() {
        if (expirySweepInterval) clearInterval(expirySweepInterval);
        expirySweepInterval = null;
    }

    // ─────────────────────────────────────────────────────────────
    // Sending
    // ─────────────────────────────────────────────────────────────

    function pairId(a, b) {
        return [a, b].sort().join('_');
    }

    // Messages self-delete 24h after they're sent. The `deleteAt` timestamp
    // is what Firestore's TTL policy removes server-side; we also filter
    // expired messages client-side so deletion *looks* instant even when
    // Firestore's TTL cleanup runs behind.
    const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

    async function sendMessage(toUid, text) {
        if (!currentUid) throw new Error('Not logged in');
        if (!toUid) throw new Error('Missing recipient');
        if (toUid === currentUid) throw new Error("Can't message yourself");
        text = String(text || '').trim();
        if (!text) return;
        if (text.length > 2000) text = text.slice(0, 2000);

        const deleteAt = firebase.firestore.Timestamp.fromDate(
            new Date(Date.now() + MESSAGE_TTL_MS)
        );

        // `participants` mirrors [from, to] so Firestore security rules can
        // verify `request.auth.uid in resource.data.participants` for any
        // query that filters by it — solves the query-result-auth problem
        // that `pair` alone can't express.
        await db.collection('dm_messages').add({
            from: currentUid,
            fromName: currentUsername || 'unknown',
            to: toUid,
            text: text,
            pair: pairId(currentUid, toUid),
            participants: [currentUid, toUid],
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            deleteAt: deleteAt,
        });
    }

    // Returns true if a message has passed its deleteAt timestamp (or
    // falls back to createdAt + 24h for legacy messages that predate
    // the field).
    function isExpired(msg) {
        if (!msg) return false;
        const now = Date.now();
        if (msg.deleteAt && msg.deleteAt.toMillis) {
            return msg.deleteAt.toMillis() <= now;
        }
        if (msg.createdAt && msg.createdAt.toMillis) {
            return (msg.createdAt.toMillis() + MESSAGE_TTL_MS) <= now;
        }
        return false;
    }

    async function deleteMessage(msgId) {
        if (!msgId) return;
        try {
            await db.collection('dm_messages').doc(msgId).delete();
        } catch (e) {
            console.warn('Failed to delete DM:', e);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Toast notifications
    // ─────────────────────────────────────────────────────────────

    let toastStack = null;
    function ensureToastStack() {
        if (toastStack) return toastStack;
        toastStack = document.createElement('div');
        toastStack.className = 'dm-toast-stack';
        toastStack.id = 'dmToastStack';
        document.body.appendChild(toastStack);
        return toastStack;
    }

    function showToast(msg) {
        ensureToastStack();
        const senderName = esc(msg.fromName || 'someone');
        const preview = esc(truncate(msg.text, 120));
        const toast = document.createElement('button');
        toast.className = 'dm-toast';
        toast.type = 'button';
        toast.innerHTML = `
            <span class="dm-toast-icon" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
            </span>
            <span class="dm-toast-body">
                <span class="dm-toast-name">${senderName}</span>
                <span class="dm-toast-text">${preview}</span>
            </span>
            <span class="dm-toast-close" aria-hidden="true">&times;</span>
        `;
        toast.addEventListener('click', () => {
            openConversation(msg.from);
            dismiss(toast);
        });
        const closer = toast.querySelector('.dm-toast-close');
        closer.addEventListener('click', (e) => { e.stopPropagation(); dismiss(toast); });

        toastStack.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('is-shown'));
        // auto-dismiss after 6 seconds
        const t = setTimeout(() => dismiss(toast), 6000);
        toast._dismissTimer = t;
    }

    function dismiss(toast) {
        clearTimeout(toast._dismissTimer);
        toast.classList.remove('is-shown');
        toast.classList.add('is-leaving');
        setTimeout(() => toast.remove(), 300);
    }

    // ─────────────────────────────────────────────────────────────
    // Messages tab — inbox list + active conversation view
    // ─────────────────────────────────────────────────────────────

    async function renderMessagesView() {
        const container = document.getElementById('messagesView');
        if (!container) return;
        if (!ArcadeAuth.isLoggedIn()) {
            container.innerHTML = '<div class="dm-empty">Log in to send messages.</div>';
            return;
        }

        container.innerHTML = `
            <div class="dm-panel">
                <aside class="dm-sidebar" id="dmSidebar"></aside>
                <section class="dm-main" id="dmMain">
                    <div class="dm-empty-main">Pick a conversation, or click a username anywhere to start one.</div>
                </section>
            </div>
        `;

        const sidebar = document.getElementById('dmSidebar');
        function renderSidebar() {
            const list = [...conversations.values()]
                .sort((a, b) => b.lastAt - a.lastAt);
            if (list.length === 0) {
                sidebar.innerHTML = `<div class="dm-sidebar-empty">
                    No conversations yet. Click a username anywhere (chat, users tab) to start one.
                </div>`;
                return;
            }
            sidebar.innerHTML = list.map((c) => `
                <button class="dm-convo-item ${c.other === activeConversationWith ? 'is-active' : ''}"
                        data-uid="${esc(c.other)}">
                    <div class="dm-convo-row">
                        <span class="dm-convo-name" data-lookup-uid="${esc(c.other)}">…</span>
                        <span class="dm-convo-time">${timeAgo(c.lastAt)}</span>
                    </div>
                    <div class="dm-convo-preview ${c.lastFrom === currentUid ? 'from-me' : ''}">
                        ${c.lastFrom === currentUid ? 'You: ' : ''}${esc(truncate(c.lastMessage, 80))}
                    </div>
                </button>
            `).join('');
            // Async-fill usernames
            sidebar.querySelectorAll('[data-lookup-uid]').forEach(async (el) => {
                const uid = el.dataset.lookupUid;
                const name = await getUsername(uid);
                el.textContent = name;
            });
            // Click to open
            sidebar.querySelectorAll('.dm-convo-item').forEach((btn) => {
                btn.addEventListener('click', () => openConversation(btn.dataset.uid));
            });
        }
        renderSidebar();

        // Re-render sidebar when conversations change
        onChange(renderSidebar);
    }

    // Cache of uid → username to avoid repeated Firestore reads
    const usernameCache = new Map();
    async function getUsername(uid) {
        if (!uid) return 'unknown';
        if (usernameCache.has(uid)) return usernameCache.get(uid);
        try {
            const doc = await db.collection('users').doc(uid).get();
            const name = (doc.exists && doc.data().username) || uid.slice(0, 6);
            usernameCache.set(uid, name);
            return name;
        } catch {
            return uid.slice(0, 6);
        }
    }

    let currentConvoUnsub = null;
    async function openConversation(otherUid) {
        // If we're on the Messages tab, switch view. Otherwise switch TO it
        // first (triggers tabs.js) and it'll render the sidebar.
        const messagesViewEl = document.getElementById('messagesView');
        const messagesTabBtn = document.querySelector('.tab-btn[data-tab="messages"]');
        if (messagesViewEl && messagesViewEl.style.display === 'none' && messagesTabBtn) {
            messagesTabBtn.click();
            // Wait a tick for the view to render then open
            setTimeout(() => openConversation(otherUid), 50);
            return;
        }

        activeConversationWith = otherUid;
        fireChange();

        const main = document.getElementById('dmMain');
        if (!main) return;

        const otherName = await getUsername(otherUid);
        main.innerHTML = `
            <header class="dm-convo-header">
                <button class="dm-convo-back" id="dmBack" aria-label="Back to list">&larr;</button>
                <div class="dm-convo-title">
                    <span class="dm-convo-title-name" data-open-profile-uid="${esc(otherUid)}" role="button" tabindex="0">${esc(otherName)}</span>
                </div>
            </header>
            <div class="dm-convo-body" id="dmBody">
                <div class="dm-convo-loading">Loading…</div>
            </div>
            <form class="dm-convo-form" id="dmForm">
                <textarea id="dmInput" class="dm-convo-input" placeholder="Write something…"
                    rows="1" maxlength="2000" autocomplete="off"></textarea>
                <button type="submit" class="dm-convo-send" title="Send" aria-label="Send">&#10148;</button>
            </form>
        `;

        document.getElementById('dmBack').addEventListener('click', () => {
            activeConversationWith = null;
            if (currentConvoUnsub) currentConvoUnsub();
            main.innerHTML = '<div class="dm-empty-main">Pick a conversation, or click a username anywhere to start one.</div>';
            fireChange();
        });

        const form = document.getElementById('dmForm');
        const input = document.getElementById('dmInput');
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(140, input.scrollHeight) + 'px';
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                form.requestSubmit();
            }
        });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) return;
            const orig = input.value;
            input.value = '';
            input.style.height = 'auto';
            try {
                await sendMessage(otherUid, text);
            } catch (err) {
                console.error('DM send failed:', err);
                // Restore text so user can retry
                input.value = orig;
                const msg = err.code === 'permission-denied'
                    ? "Can't send — Firestore rules aren't letting this through. Check the dm_messages rule is published."
                    : (err.message || 'Send failed');
                alert('Send failed: ' + msg);
            }
        });

        // Subscribe to this conversation's messages. We query with BOTH
        // filters: `pair` for exact-conversation scoping, AND `participants`
        // array-contains for Firestore rule compatibility (the rule allows
        // reads where request.auth.uid is in participants).
        const pair = pairId(currentUid, otherUid);
        if (currentConvoUnsub) currentConvoUnsub();
        const body = document.getElementById('dmBody');
        currentConvoUnsub = db.collection('dm_messages')
            .where('participants', 'array-contains', currentUid)
            .where('pair', '==', pair)
            .orderBy('createdAt', 'asc')
            .onSnapshot((snap) => {
                // Filter out expired (>24h) messages client-side so they
                // disappear immediately even if Firestore TTL is slow.
                const msgs = snap.docs
                    .map((d) => ({ id: d.id, ...d.data() }))
                    .filter((m) => !isExpired(m));
                if (msgs.length === 0) {
                    body.innerHTML = `<div class="dm-convo-empty">No messages yet. Say hi. <br><span style="font-size:0.75rem;opacity:0.65">Messages auto-delete after 24 hours.</span></div>`;
                    return;
                }
                renderConvoMessages(body, msgs);
            }, (err) => {
                console.warn('DM convo listener:', err);
                body.innerHTML = `<div class="dm-convo-empty">Couldn't load messages.<br><code style="font-size:0.72rem">${esc(err.message || err.code || 'unknown error')}</code></div>`;
            });
    }

    function renderConvoMessages(body, msgs) {
        const wasAtBottom =
            body.scrollHeight - body.scrollTop - body.clientHeight < 100;
        body.innerHTML = msgs.map((m) => {
            const mine = m.from === currentUid;
            const time = m.createdAt && m.createdAt.toMillis
                ? formatTime(m.createdAt.toMillis())
                : '';
            const delBtn = mine
                ? `<button class="dm-msg-delete" data-id="${esc(m.id)}" title="Delete">&times;</button>`
                : '';
            return `<div class="dm-msg ${mine ? 'dm-msg-mine' : 'dm-msg-theirs'}">
                <div class="dm-msg-text">${esc(m.text)}</div>
                <div class="dm-msg-meta">
                    <span class="dm-msg-time">${esc(time)}</span>
                    ${delBtn}
                </div>
            </div>`;
        }).join('');
        body.querySelectorAll('.dm-msg-delete').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('Delete this message?')) deleteMessage(btn.dataset.id);
            });
        });
        if (wasAtBottom) body.scrollTop = body.scrollHeight;
    }

    // ─────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function truncate(s, n) {
        s = String(s || '');
        return s.length <= n ? s : s.slice(0, n - 1) + '…';
    }
    function timeAgo(ms) {
        const s = Math.floor((Date.now() - ms) / 1000);
        if (s < 60) return 'now';
        if (s < 3600) return Math.floor(s / 60) + 'm';
        if (s < 86400) return Math.floor(s / 3600) + 'h';
        return Math.floor(s / 86400) + 'd';
    }
    function formatTime(ms) {
        const d = new Date(ms);
        const sameDay = new Date().toDateString() === d.toDateString();
        if (sameDay) {
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
            ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // ─────────────────────────────────────────────────────────────
    // Bootstrap
    // ─────────────────────────────────────────────────────────────

    ArcadeAuth.waitForAuth().then(() => {
        ArcadeAuth.onAuthChange((user) => {
            stopListeners();
            if (!user) return;
            db = ArcadeAuth.getDb();
            currentUid = user.uid;
            currentUsername = ArcadeAuth.getUsername();
            startListeners();
        });
        if (ArcadeAuth.isLoggedIn()) {
            db = ArcadeAuth.getDb();
            currentUid = ArcadeAuth.getUser().uid;
            currentUsername = ArcadeAuth.getUsername();
            startListeners();
        }
    });

    window.ArcadeMessages = {
        sendMessage,
        openConversation,
        renderMessagesView,
        getConversations: () => [...conversations.values()],
    };
})();
