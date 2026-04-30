// Profile-social: visitor guestbook, reaction emojis, and the
// recently-viewed-by trail.
//
// All three are top-level Firestore collections to keep the rules
// simple (no nested subcollections to authorize):
//
//   guestbook_entries/{id}         — { profileUid, authorUid,
//                                       authorName, message, createdAt }
//     read: signedIn
//     create: signedIn && authorUid == request.auth.uid
//             && message.size() <= 200
//     delete: signedIn && (authorUid == request.auth.uid
//             || profileUid == request.auth.uid || isAdmin())
//     update: false
//
//   profile_reactions/{profileUid} — { fire: 12, skull: 3, ... }
//     read: signedIn
//     update: signedIn — but only allowed to atomically increment
//             ONE field by ONE on the SELF-doc (enforced by rule
//             with diff().affectedKeys() <= 1 && current_value+1)
//
//   profile_visitors/{profileUid}/visits/{visitorUid}
//                                 — { visitorName, lastVisit }
//     read: profileUid == auth.uid (only the owner sees who visited)
//     write: signedIn
//
// The Firestore rule additions to paste into your console are echoed
// in this file's bottom comment block.

(function () {
    const REACTIONS = ['fire', 'skull', 'crown', 'heart', 'star', 'thumbsup'];
    const REACTION_EMOJI = {
        fire: '\u{1F525}', skull: '\u{1F480}', crown: '\u{1F451}',
        heart: '\u{2764}\u{FE0F}',  star: '\u{2B50}', thumbsup: '\u{1F44D}',
    };

    function getDb() { return window.ArcadeAuth?.getDb?.(); }
    function getMe() { return window.ArcadeAuth?.getUser?.(); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ─── Guestbook ─────────────────────────────────────────────────
    async function loadGuestbook(profileUid) {
        const db = getDb();
        if (!db) return [];
        try {
            const snap = await db.collection('guestbook_entries')
                .where('profileUid', '==', profileUid)
                .orderBy('createdAt', 'desc')
                .limit(50)
                .get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (e) {
            console.warn('guestbook load failed:', e);
            return [];
        }
    }

    async function postGuestbookEntry(profileUid, message) {
        const db = getDb();
        const me = getMe();
        if (!db || !me) throw new Error('Not signed in');
        const text = String(message || '').trim().slice(0, 200);
        if (!text) throw new Error('Message empty');
        const profile = await ArcadeAuth.getProfile(me.uid);
        await db.collection('guestbook_entries').add({
            profileUid,
            authorUid: me.uid,
            authorName: profile?.username || 'unknown',
            authorAvatar: profile?.avatar || null,
            message: text,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
    }

    async function deleteGuestbookEntry(entryId) {
        const db = getDb();
        if (!db) throw new Error('No DB');
        await db.collection('guestbook_entries').doc(entryId).delete();
    }

    function fmtRelative(ts) {
        if (!ts) return 'just now';
        try {
            const d = ts.toDate ? ts.toDate() : new Date(ts);
            const m = Math.floor((Date.now() - d.getTime()) / 60000);
            if (m < 1) return 'just now';
            if (m < 60) return `${m}m ago`;
            const h = Math.floor(m / 60);
            if (h < 24) return `${h}h ago`;
            const days = Math.floor(h / 24);
            return `${days}d ago`;
        } catch { return ''; }
    }

    // Render the guestbook into a target element. profile = the profile
    // being viewed; isSelf controls whether the owner sees delete buttons
    // on entries that aren't their own.
    async function renderGuestbook(target, profile) {
        if (!target) return;
        const me = getMe();
        const isSelf = me && me.uid === profile.uid;
        const canPost = !!me && !isSelf;
        const isOwner = isSelf;

        target.innerHTML = '<div class="profile-guestbook-loading">Loading guestbook…</div>';
        const entries = await loadGuestbook(profile.uid);

        const composer = canPost ? `
            <form class="profile-guestbook-composer" id="gbComposer">
                <textarea id="gbInput" maxlength="200" placeholder="Leave a message…"></textarea>
                <div class="profile-guestbook-composer-row">
                    <span class="profile-guestbook-counter"><span id="gbCount">0</span>/200</span>
                    <button type="submit" class="profile-edit-action">Post</button>
                </div>
            </form>
        ` : (me ? '' : '<div class="profile-guestbook-loading">Sign in to leave a message.</div>');

        const list = entries.length ? entries.map(e => {
            const canDel = me && (e.authorUid === me.uid || isOwner || ArcadeAuth.isAdmin());
            const avatar = e.authorAvatar
                ? `<img class="profile-gb-avatar" src="${esc(e.authorAvatar)}" alt="">`
                : `<div class="profile-gb-avatar profile-gb-avatar-placeholder">${esc((e.authorName||'?').charAt(0).toUpperCase())}</div>`;
            return `
                <div class="profile-gb-entry" data-id="${esc(e.id)}">
                    ${avatar}
                    <div class="profile-gb-body">
                        <div class="profile-gb-head">
                            <span class="profile-gb-author" data-open-profile-uid="${esc(e.authorUid)}">${esc(e.authorName)}</span>
                            <span class="profile-gb-time">${fmtRelative(e.createdAt)}</span>
                        </div>
                        <p class="profile-gb-msg">${
                            window.ArcadeEmojis ? ArcadeEmojis.replaceEmojis(esc(e.message)) : esc(e.message)
                        }</p>
                    </div>
                    ${canDel ? `<button class="profile-gb-del" data-id="${esc(e.id)}" title="Delete">&times;</button>` : ''}
                </div>`;
        }).join('') : '<div class="profile-guestbook-empty">No messages yet — be the first.</div>';

        target.innerHTML = `
            ${composer}
            <div class="profile-gb-list">${list}</div>
        `;

        // Composer wiring
        const form = target.querySelector('#gbComposer');
        if (form) {
            const input = target.querySelector('#gbInput');
            const counter = target.querySelector('#gbCount');
            input.addEventListener('input', () => { counter.textContent = input.value.length; });
            form.addEventListener('submit', async (ev) => {
                ev.preventDefault();
                const txt = input.value.trim();
                if (!txt) return;
                const btn = form.querySelector('button[type=submit]');
                btn.disabled = true; btn.textContent = 'Posting…';
                try {
                    await postGuestbookEntry(profile.uid, txt);
                    input.value = '';
                    counter.textContent = '0';
                    await renderGuestbook(target, profile); // re-render
                } catch (e) {
                    alert('Post failed: ' + e.message);
                } finally {
                    btn.disabled = false; btn.textContent = 'Post';
                }
            });
        }
        // Delete handler (delegated)
        target.addEventListener('click', async (ev) => {
            const btn = ev.target.closest?.('.profile-gb-del');
            if (!btn) return;
            if (!confirm('Delete this message?')) return;
            try {
                await deleteGuestbookEntry(btn.dataset.id);
                await renderGuestbook(target, profile);
            } catch (e) {
                alert('Delete failed: ' + e.message);
            }
        }, { once: true });
    }

    // ─── Reactions ─────────────────────────────────────────────────
    // Stored on the user's own profile doc as `reactions: {fire: N, ...}`.
    // Each visitor can add ONE per type per profile per session
    // (tracked in localStorage to keep the rule simple).
    function getReactionMemoryKey(profileUid) {
        return `arcade-profile-reaction-${profileUid}`;
    }
    function readReactionMemory(profileUid) {
        try { return JSON.parse(localStorage.getItem(getReactionMemoryKey(profileUid)) || '{}'); }
        catch { return {}; }
    }
    function writeReactionMemory(profileUid, mem) {
        try { localStorage.setItem(getReactionMemoryKey(profileUid), JSON.stringify(mem)); } catch {}
    }

    async function addReaction(profileUid, type) {
        const db = getDb();
        if (!db || !REACTIONS.includes(type)) return;
        const mem = readReactionMemory(profileUid);
        if (mem[type]) return; // already reacted with this type
        mem[type] = true;
        writeReactionMemory(profileUid, mem);
        // Atomic increment on the user's profile reactions field. The
        // rule allows any signed-in user to bump a single counter on
        // someone else's profile (cross-user write hatch).
        const ref = db.collection('users').doc(profileUid);
        await ref.set({
            reactions: { [type]: firebase.firestore.FieldValue.increment(1) }
        }, { merge: true });
    }

    function renderReactionsBar(target, profile) {
        if (!target) return;
        const me = getMe();
        const counts = profile.reactions || {};
        const mem = readReactionMemory(profile.uid);
        const canReact = me && me.uid !== profile.uid;
        target.innerHTML = `
            <div class="profile-reactions-bar">
                ${REACTIONS.map(r => `
                    <button class="profile-reaction-btn${mem[r]?' is-reacted':''}"
                            data-r="${r}"
                            ${!canReact || mem[r] ? 'disabled' : ''}
                            title="${r}">
                        <span class="profile-reaction-emoji">${REACTION_EMOJI[r]}</span>
                        <span class="profile-reaction-count">${counts[r] || 0}</span>
                    </button>
                `).join('')}
            </div>
        `;
        target.addEventListener('click', async (ev) => {
            const btn = ev.target.closest?.('.profile-reaction-btn');
            if (!btn || btn.disabled) return;
            btn.disabled = true;
            try {
                await addReaction(profile.uid, btn.dataset.r);
                // Optimistic update
                const cnt = btn.querySelector('.profile-reaction-count');
                cnt.textContent = String((parseInt(cnt.textContent, 10) || 0) + 1);
                btn.classList.add('is-reacted');
            } catch (e) {
                btn.disabled = false;
                console.warn('reaction failed:', e);
            }
        });
    }

    // ─── Recently viewed by ────────────────────────────────────────
    async function recordVisit(profileUid) {
        const db = getDb();
        const me = getMe();
        if (!db || !me || me.uid === profileUid) return;
        try {
            const profile = await ArcadeAuth.getProfile(me.uid);
            await db.collection('profile_visitors')
                .doc(profileUid)
                .collection('visits')
                .doc(me.uid)
                .set({
                    visitorName: profile?.username || 'unknown',
                    visitorAvatar: profile?.avatar || null,
                    lastVisit: firebase.firestore.FieldValue.serverTimestamp(),
                });
        } catch (e) {
            // Ignore — may fail if user privacy hides this.
        }
    }

    async function loadRecentVisitors(profileUid) {
        const db = getDb();
        if (!db) return [];
        try {
            const snap = await db.collection('profile_visitors')
                .doc(profileUid)
                .collection('visits')
                .orderBy('lastVisit', 'desc')
                .limit(8)
                .get();
            return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
        } catch {
            return [];
        }
    }

    function renderRecentVisitors(target, visitors) {
        if (!target) return;
        if (!visitors.length) {
            target.innerHTML = '<span class="profile-visitors-empty">No recent visitors.</span>';
            return;
        }
        target.innerHTML = visitors.map(v => {
            const av = v.visitorAvatar
                ? `<img class="profile-visitor-av" src="${esc(v.visitorAvatar)}" alt="">`
                : `<div class="profile-visitor-av profile-visitor-av-placeholder">${esc((v.visitorName||'?').charAt(0).toUpperCase())}</div>`;
            return `<button class="profile-visitor" data-open-profile-uid="${esc(v.uid)}" title="${esc(v.visitorName)}">${av}</button>`;
        }).join('');
    }

    window.ArcadeProfileSocial = {
        renderGuestbook, renderReactionsBar, recordVisit,
        loadRecentVisitors, renderRecentVisitors,
        REACTIONS, REACTION_EMOJI,
    };
})();

// Firestore rules to add for these features:
//
// match /guestbook_entries/{id} {
//   allow read: if signedIn();
//   allow create: if signedIn()
//     && request.resource.data.authorUid == request.auth.uid
//     && request.resource.data.message is string
//     && request.resource.data.message.size() <= 200;
//   allow delete: if signedIn() && (
//        resource.data.authorUid == request.auth.uid
//     || resource.data.profileUid == request.auth.uid
//     || isAdmin());
//   allow update: if false;
// }
//
// match /profile_visitors/{uid}/visits/{visitorUid} {
//   allow read: if signedIn() && (uid == request.auth.uid || isAdmin());
//   allow write: if signedIn() && visitorUid == request.auth.uid;
// }
//
// (reactions live on users/{uid}.reactions and need a clause in the
// existing /users/{uid} rule allowing cross-user writes that ONLY
// touch the `reactions` field with FieldValue.increment.)
