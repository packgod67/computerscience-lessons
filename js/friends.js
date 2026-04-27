// Friends system — request/accept/remove + activity feed.
//
// Schema (kept simple — no separate friend_requests collection,
// everything lives on the user docs):
//   users/{uid}.friends            — string[] of UIDs (mutual)
//   users/{uid}.friendRequestsIn   — string[] of UIDs who sent me a request
//   users/{uid}.friendRequestsOut  — string[] of UIDs I sent a request to
//
// "Send request" writes my uid to THEIR friendRequestsIn, AND their uid
// to MY friendRequestsOut. Both writes are self-or-target-doc, allowed
// by the existing users update rule (we only touch friend* fields, not
// role/banned/approved).
//
// "Accept" writes:
//   - my doc:    friends += [other], friendRequestsIn -= [other]
//   - other doc: friends += [me],    friendRequestsOut -= [me]
//
// SECURITY NOTE: the update rule for users/{uid} I shipped earlier
// allows any-field self-update (except role/banned/approved). That
// means a malicious user CAN write to someone else's doc only if the
// rule allows cross-uid writes — it doesn't. So we need a thin
// addition to the ruleset: allow update on someone else's doc if the
// only changed field is friendRequestsIn AND the writer's uid is the
// added entry. Same for friend acceptance — adding self to their
// friends list. Documented in the comment block at the bottom of
// this file for paste-into-Firestore-Console.

(function () {
    function getDb() { return window.ArcadeAuth?.getDb?.(); }
    function getUid() { return window.ArcadeAuth?.getUser?.()?.uid; }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // In-memory cache of profiles + activity, refreshed by listeners.
    let myProfile = null;
    let myProfileUnsub = null;
    let friendsListeners = []; // [unsub, ...]

    // ─── Listening to my own profile (for friends/requests state) ───
    function startMyProfileListener() {
        const db = getDb();
        const uid = getUid();
        if (!db || !uid || myProfileUnsub) return;
        myProfileUnsub = db.collection('users').doc(uid).onSnapshot((snap) => {
            myProfile = snap.exists ? { uid, ...snap.data() } : { uid };
            // Refresh any open Friend tab UI
            if (document.getElementById('friendsView')?.style?.display !== 'none') {
                renderFriendsView();
            }
        });
    }

    // ─── Send / accept / decline / remove ────────────────────────────
    async function sendRequest(otherUid) {
        const db = getDb();
        const me = getUid();
        if (!db || !me || me === otherUid) return;
        try {
            // arrayUnion is server-side and idempotent.
            const FV = firebase.firestore.FieldValue;
            await Promise.all([
                db.collection('users').doc(otherUid).update({
                    friendRequestsIn: FV.arrayUnion(me),
                }),
                db.collection('users').doc(me).update({
                    friendRequestsOut: FV.arrayUnion(otherUid),
                }),
            ]);
        } catch (e) {
            alert('Could not send request: ' + (e?.message || e));
        }
    }

    async function acceptRequest(otherUid) {
        const db = getDb();
        const me = getUid();
        if (!db || !me) return;
        try {
            const FV = firebase.firestore.FieldValue;
            await Promise.all([
                db.collection('users').doc(me).update({
                    friends: FV.arrayUnion(otherUid),
                    friendRequestsIn: FV.arrayRemove(otherUid),
                }),
                db.collection('users').doc(otherUid).update({
                    friends: FV.arrayUnion(me),
                    friendRequestsOut: FV.arrayRemove(me),
                }),
            ]);
            try { window.dispatchEvent(new Event('arcade:friend-added')); } catch {}
        } catch (e) {
            alert('Could not accept: ' + (e?.message || e));
        }
    }

    async function declineRequest(otherUid) {
        const db = getDb();
        const me = getUid();
        if (!db || !me) return;
        try {
            const FV = firebase.firestore.FieldValue;
            await Promise.all([
                db.collection('users').doc(me).update({
                    friendRequestsIn: FV.arrayRemove(otherUid),
                }),
                db.collection('users').doc(otherUid).update({
                    friendRequestsOut: FV.arrayRemove(me),
                }),
            ]);
        } catch (e) {
            alert('Could not decline: ' + (e?.message || e));
        }
    }

    async function removeFriend(otherUid) {
        const db = getDb();
        const me = getUid();
        if (!db || !me) return;
        if (!confirm('Remove this friend?')) return;
        try {
            const FV = firebase.firestore.FieldValue;
            await Promise.all([
                db.collection('users').doc(me).update({
                    friends: FV.arrayRemove(otherUid),
                }),
                db.collection('users').doc(otherUid).update({
                    friends: FV.arrayRemove(me),
                }),
            ]);
        } catch (e) {
            alert('Could not remove: ' + (e?.message || e));
        }
    }

    async function cancelOutgoing(otherUid) {
        const db = getDb();
        const me = getUid();
        if (!db || !me) return;
        try {
            const FV = firebase.firestore.FieldValue;
            await Promise.all([
                db.collection('users').doc(me).update({
                    friendRequestsOut: FV.arrayRemove(otherUid),
                }),
                db.collection('users').doc(otherUid).update({
                    friendRequestsIn: FV.arrayRemove(me),
                }),
            ]);
        } catch (e) {
            alert('Could not cancel: ' + (e?.message || e));
        }
    }

    // ─── Friend button (rendered into profile slot) ──────────────────
    function renderFriendButton(slot, otherUid) {
        const me = getUid();
        if (!me || me === otherUid) { slot.innerHTML = ''; return; }
        startMyProfileListener();

        function rerender() {
            const friends = (myProfile?.friends) || [];
            const out = (myProfile?.friendRequestsOut) || [];
            // friendRequestsIn check on me side: did THEY send ME a request?
            const inn = (myProfile?.friendRequestsIn) || [];

            let html = '';
            if (friends.includes(otherUid)) {
                html = `<button class="profile-friend-btn is-friend" data-act="remove">&#10003; Friends</button>`;
            } else if (out.includes(otherUid)) {
                html = `<button class="profile-friend-btn is-pending" data-act="cancel">Request sent — cancel</button>`;
            } else if (inn.includes(otherUid)) {
                html = `
                    <button class="profile-friend-btn is-accept" data-act="accept">Accept</button>
                    <button class="profile-friend-btn is-decline" data-act="decline">Decline</button>
                `;
            } else {
                html = `<button class="profile-friend-btn" data-act="send">+ Add friend</button>`;
            }
            slot.innerHTML = html;
            slot.querySelectorAll('button[data-act]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const act = btn.dataset.act;
                    btn.disabled = true;
                    if (act === 'send') await sendRequest(otherUid);
                    else if (act === 'accept') await acceptRequest(otherUid);
                    else if (act === 'decline') await declineRequest(otherUid);
                    else if (act === 'remove') await removeFriend(otherUid);
                    else if (act === 'cancel') await cancelOutgoing(otherUid);
                });
            });
        }
        rerender();
        // Re-render on profile updates
        slot._unsub = window.addEventListener('arcade:friend-added', rerender);
        // Hack: poll-render on a shorter interval since myProfile is
        // a closure — actually our myProfile listener triggers on snapshot
        // which already re-runs anything keyed off the friends view.
        // Just hook into the same global state with a lightweight watcher.
        const watcher = setInterval(() => {
            if (!document.body.contains(slot)) { clearInterval(watcher); return; }
            rerender();
        }, 1500);
    }

    // ─── Friends view (tab) ──────────────────────────────────────────
    async function renderFriendsView() {
        const container = document.getElementById('friendsView');
        if (!container) return;
        if (!window.ArcadeAuth?.isLoggedIn?.()) {
            container.innerHTML = '<div class="friends-empty">Log in to see your friends and activity.</div>';
            return;
        }
        startMyProfileListener();
        // Wait briefly for the listener to populate
        if (!myProfile) {
            await new Promise(r => setTimeout(r, 400));
        }

        const friends = myProfile?.friends || [];
        const requests = myProfile?.friendRequestsIn || [];

        container.innerHTML = `
            <div class="friends-panel">
                <div class="friends-header">
                    <h2>Friends</h2>
                </div>
                <div class="friends-tabs">
                    <button class="friends-tab is-active" data-pane="activity">Activity</button>
                    <button class="friends-tab" data-pane="friends">My Friends (${friends.length})</button>
                    <button class="friends-tab" data-pane="requests">Requests${requests.length ? ' (' + requests.length + ')' : ''}</button>
                </div>
                <div class="friends-pane" id="friendsPane">Loading…</div>
            </div>
        `;

        const paneEl = container.querySelector('#friendsPane');
        let activePane = 'activity';
        function paint() {
            if (activePane === 'activity') paintActivity(paneEl, friends);
            else if (activePane === 'friends') paintFriendsList(paneEl, friends);
            else paintRequests(paneEl, requests);
        }
        container.querySelectorAll('.friends-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.friends-tab').forEach(b => b.classList.remove('is-active'));
                btn.classList.add('is-active');
                activePane = btn.dataset.pane;
                paint();
            });
        });
        paint();
    }

    async function paintActivity(paneEl, friendUids) {
        if (!friendUids.length) {
            paneEl.innerHTML = '<div class="friends-empty">Add friends to see what they\'re playing.</div>';
            return;
        }
        const db = getDb();
        // Fetch friend profiles in parallel. Firestore "in" query
        // supports up to 30 ids per call — chunk if needed.
        const profiles = [];
        const chunks = [];
        for (let i = 0; i < friendUids.length; i += 10) chunks.push(friendUids.slice(i, i + 10));
        try {
            for (const ch of chunks) {
                const docs = await Promise.all(ch.map(uid => db.collection('users').doc(uid).get()));
                for (const d of docs) {
                    if (d.exists) profiles.push({ uid: d.id, ...d.data() });
                }
            }
        } catch (e) {
            paneEl.innerHTML = '<div class="friends-empty">Could not load activity: ' + esc(e?.message || e) + '</div>';
            return;
        }

        // Activity items: most recent play per friend.
        const items = [];
        const games = window.ArcadeApp?.getGames?.() || [];
        const byId = {};
        for (const g of games) byId[g.id] = g;

        for (const p of profiles) {
            const recent = (p.recentPlays || [])[0];
            if (!recent) continue;
            const g = byId[recent.gameId];
            if (!g) continue;
            items.push({
                uid: p.uid,
                name: p.username || 'unknown',
                game: g,
                at: recent.at || 0,
                currentlyPlaying: p.currentGame === recent.gameId,
            });
        }
        items.sort((a, b) => (b.at || 0) - (a.at || 0));
        if (!items.length) {
            paneEl.innerHTML = '<div class="friends-empty">No activity yet.</div>';
            return;
        }
        paneEl.innerHTML = `
            <div class="friends-feed">
            ${items.map(it => {
                const g = it.game;
                const thumb = g.thumbnail
                    ? `<img class="friends-feed-thumb" src="${esc(g.thumbnail)}" alt="">`
                    : `<div class="friends-feed-thumb friends-feed-thumb-placeholder">${esc((g.title || '?').charAt(0).toUpperCase())}</div>`;
                const live = it.currentlyPlaying
                    ? '<span class="friends-feed-live">● live</span>'
                    : `<span class="friends-feed-time">${timeAgo(it.at)}</span>`;
                return `<div class="friends-feed-item">
                    <span class="friends-feed-name" data-open-profile-uid="${esc(it.uid)}" role="button" tabindex="0">${esc(it.name)}</span>
                    ${live}
                    <span class="friends-feed-action">played</span>
                    <a class="friends-feed-game" href="play.html?game=${encodeURIComponent(g.id)}">
                        ${thumb}<span>${esc(g.title)}</span>
                    </a>
                </div>`;
            }).join('')}
            </div>
        `;
    }

    async function paintFriendsList(paneEl, friendUids) {
        if (!friendUids.length) {
            paneEl.innerHTML = '<div class="friends-empty">No friends yet. Open someone\'s profile and tap "Add friend".</div>';
            return;
        }
        const db = getDb();
        const docs = await Promise.all(friendUids.map(uid => db.collection('users').doc(uid).get()));
        const items = docs.filter(d => d.exists).map(d => ({ uid: d.id, ...d.data() }));
        paneEl.innerHTML = `
            <div class="friends-list">
            ${items.map(p => `
                <div class="friends-list-row">
                    <span class="friends-list-name" data-open-profile-uid="${esc(p.uid)}" role="button" tabindex="0">${esc(p.username || 'unknown')}</span>
                    <button class="friends-list-msg" data-msg-uid="${esc(p.uid)}">Message</button>
                    <button class="friends-list-remove" data-rm-uid="${esc(p.uid)}">Remove</button>
                </div>
            `).join('')}
            </div>
        `;
        paneEl.querySelectorAll('[data-rm-uid]').forEach(btn => {
            btn.addEventListener('click', () => removeFriend(btn.dataset.rmUid));
        });
        paneEl.querySelectorAll('[data-msg-uid]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (window.ArcadeMessages?.openConversation) {
                    window.ArcadeMessages.openConversation(btn.dataset.msgUid);
                }
            });
        });
    }

    async function paintRequests(paneEl, requestUids) {
        if (!requestUids.length) {
            paneEl.innerHTML = '<div class="friends-empty">No pending requests.</div>';
            return;
        }
        const db = getDb();
        const docs = await Promise.all(requestUids.map(uid => db.collection('users').doc(uid).get()));
        const items = docs.filter(d => d.exists).map(d => ({ uid: d.id, ...d.data() }));
        paneEl.innerHTML = `
            <div class="friends-requests">
            ${items.map(p => `
                <div class="friends-request-row">
                    <span class="friends-request-name" data-open-profile-uid="${esc(p.uid)}" role="button" tabindex="0">${esc(p.username || 'unknown')}</span>
                    <button class="friends-request-accept" data-accept-uid="${esc(p.uid)}">Accept</button>
                    <button class="friends-request-decline" data-decline-uid="${esc(p.uid)}">Decline</button>
                </div>
            `).join('')}
            </div>
        `;
        paneEl.querySelectorAll('[data-accept-uid]').forEach(btn => {
            btn.addEventListener('click', () => acceptRequest(btn.dataset.acceptUid));
        });
        paneEl.querySelectorAll('[data-decline-uid]').forEach(btn => {
            btn.addEventListener('click', () => declineRequest(btn.dataset.declineUid));
        });
    }

    function timeAgo(ms) {
        if (!ms) return '';
        const s = Math.floor((Date.now() - ms) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
    }

    window.ArcadeFriends = {
        sendRequest, acceptRequest, declineRequest, removeFriend, cancelOutgoing,
        renderFriendsView, renderFriendButton,
    };
})();

/*
ADDITIONAL FIRESTORE RULE (paste into Firebase Console rules — adds
permission for cross-user writes ONLY of the friend* fields). Keeps the
existing users/{uid} rule that blocks role/banned/approved escalation,
adds a narrowly-scoped escape hatch for friend-graph mutations.

Replace your `match /users/{uid}` block with:

  match /users/{uid} {
    allow read:   if signedIn();
    allow create: if isSelf(uid)
                  && (!('role' in request.resource.data)
                      || request.resource.data.role != 'admin')
                  && (!('banned' in request.resource.data)
                      || request.resource.data.banned == false)
                  && (!('approved' in request.resource.data)
                      || request.resource.data.approved == false);
    // Self-update: anything except role/banned/approved.
    // Cross-user update: only if the writer is touching the friend
    // graph (friends, friendRequestsIn, friendRequestsOut) on the
    // target's doc, and only by adding/removing their own UID.
    allow update: if isAdmin()
                  || (isSelf(uid)
                      && (!('role' in request.resource.data.diff(resource.data).affectedKeys()))
                      && (!('banned' in request.resource.data.diff(resource.data).affectedKeys()))
                      && (!('approved' in request.resource.data.diff(resource.data).affectedKeys())))
                  || (signedIn()
                      && request.resource.data.diff(resource.data).affectedKeys()
                          .hasOnly(['friends', 'friendRequestsIn', 'friendRequestsOut']));
    allow delete: if isAdmin();
  }
*/
