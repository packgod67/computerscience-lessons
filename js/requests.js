// ===== Feature / game requests =====
// Any logged-in user can submit a request. Admins can mark it done, reject
// it with a reason, or delete it. Simple upvote system so admins can see
// which requests are most popular.
//
// Schema — `requests/{id}`:
//   title       string (<=200 chars)
//   details     string (<=2000 chars, optional)
//   kind        'game' | 'feature' | 'fix' | 'other'
//   status      'open' | 'done' | 'rejected'
//   statusNote  string (admin note when setting done/rejected)
//   authorUid   uid
//   authorName  cached username
//   createdAt   server timestamp
//   upvotes     string[]  uids that voted
//
// Firestore rule:
//   match /requests/{id} {
//     allow read: if request.auth != null;
//     allow create: if request.auth != null
//       && request.resource.data.authorUid == request.auth.uid
//       && request.resource.data.status == 'open';
//     allow update: if request.auth != null && (
//       // Author can edit their own open requests (title/details)
//       (resource.data.authorUid == request.auth.uid
//         && request.resource.data.authorUid == resource.data.authorUid)
//       // Anyone can toggle their vote (write only affects upvotes field)
//       || request.auth.uid in request.resource.data.upvotes
//       || request.auth.uid in resource.data.upvotes
//       // Admins can update anything
//       || get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin'
//     );
//     allow delete: if request.auth != null
//       && (resource.data.authorUid == request.auth.uid
//        || get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin');
//   }

(function () {
    let db = null;
    let items = [];
    let unsub = null;
    let activeFilter = 'open';  // open | done | rejected | all
    let requestsActive = false;

    function getDb() {
        if (!db) db = ArcadeAuth.getDb();
        return db;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function timeAgo(ms) {
        if (!ms) return '';
        const s = Math.floor((Date.now() - ms) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
    }

    // ─────────────────────────────────────────────────────────────

    async function renderRequestsView() {
        const container = document.getElementById('requestsView');
        if (!container) return;
        if (!ArcadeAuth.isLoggedIn()) {
            container.innerHTML = '<div class="requests-empty">Log in to view or submit requests.</div>';
            return;
        }

        requestsActive = true;
        startListener();
        build(container);
    }

    function startListener() {
        if (unsub) return;
        unsub = getDb().collection('requests').onSnapshot((snap) => {
            items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            if (requestsActive) {
                const container = document.getElementById('requestsView');
                if (container) build(container);
            }
        }, (err) => console.warn('Requests listener error:', err));
    }

    function build(container) {
        const isAdmin = ArcadeAuth.isAdmin();
        const uid = ArcadeAuth.getUser()?.uid;

        // Filter + sort: pinned-status first (open on top), then upvotes desc,
        // then newest first.
        const filtered = items.filter(x => activeFilter === 'all' ? true : x.status === activeFilter);
        filtered.sort((a, b) => {
            const av = (a.upvotes || []).length;
            const bv = (b.upvotes || []).length;
            if (av !== bv) return bv - av;
            const ta = a.createdAt?.toMillis?.() || 0;
            const tb = b.createdAt?.toMillis?.() || 0;
            return tb - ta;
        });

        const listHtml = filtered.length
            ? filtered.map(r => renderCard(r, uid, isAdmin)).join('')
            : `<div class="requests-empty">No ${activeFilter === 'all' ? '' : activeFilter + ' '}requests yet.</div>`;

        const counts = items.reduce((acc, x) => {
            acc[x.status || 'open'] = (acc[x.status || 'open'] || 0) + 1;
            return acc;
        }, {});

        container.innerHTML = `
            <div class="requests-panel">
                <div class="requests-header">
                    <h2>Requests</h2>
                    <button class="requests-new-btn" id="requestsNewBtn" type="button">+ New request</button>
                </div>
                <div class="requests-filters">
                    ${['open', 'done', 'rejected', 'all'].map(f =>
                        `<button class="requests-filter${activeFilter === f ? ' is-active' : ''}" data-filter="${f}">
                            ${f[0].toUpperCase() + f.slice(1)}${f !== 'all' ? ` (${counts[f] || 0})` : ''}
                        </button>`
                    ).join('')}
                </div>
                <div class="requests-list">${listHtml}</div>
            </div>
        `;

        // Wrap the click handler instead of passing showSubmitModal directly —
        // addEventListener calls the handler with the MouseEvent as the first
        // arg, which made `existing` truthy and sent the submit code down the
        // .update() path with a random doc id. Explicit () => shows intent
        // and keeps `existing` null for new requests.
        document.getElementById('requestsNewBtn').addEventListener('click', () => showSubmitModal(null));
        container.querySelectorAll('.requests-filter').forEach(b => {
            b.addEventListener('click', () => {
                activeFilter = b.dataset.filter;
                build(container);
            });
        });
        wireCardEvents(container, uid, isAdmin);
    }

    function renderCard(r, uid, isAdmin) {
        const voted = (r.upvotes || []).includes(uid);
        const isAuthor = r.authorUid === uid;
        const isOpen = r.status === 'open' || !r.status;
        const statusBadge = r.status && r.status !== 'open'
            ? `<span class="request-status request-status-${esc(r.status)}">${esc(r.status)}</span>`
            : '';
        const kindBadge = r.kind
            ? `<span class="request-kind request-kind-${esc(r.kind)}">${esc(r.kind)}</span>`
            : '';
        const statusNote = r.statusNote
            ? `<div class="request-status-note">${esc(r.statusNote)}</div>`
            : '';

        const adminActions = isAdmin && isOpen ? `
            <button class="request-action request-mark-done" data-id="${esc(r.id)}" title="Mark as done">&#10003; Done</button>
            <button class="request-action request-mark-rejected" data-id="${esc(r.id)}" title="Reject">&times; Reject</button>
        ` : '';
        const reopenAction = isAdmin && !isOpen
            ? `<button class="request-action request-reopen" data-id="${esc(r.id)}" title="Reopen">Reopen</button>`
            : '';
        const deleteAction = (isAdmin || isAuthor)
            ? `<button class="request-action request-delete" data-id="${esc(r.id)}" title="Delete">Delete</button>`
            : '';
        const editAction = (isAuthor && isOpen)
            ? `<button class="request-action request-edit" data-id="${esc(r.id)}" title="Edit">Edit</button>`
            : '';

        return `
            <div class="request-card request-card-${esc(r.status || 'open')}">
                <div class="request-vote-col">
                    <button class="request-upvote${voted ? ' is-voted' : ''}" data-id="${esc(r.id)}" title="${voted ? 'Remove vote' : 'Upvote'}">
                        &#9650;
                    </button>
                    <span class="request-vote-count">${(r.upvotes || []).length}</span>
                </div>
                <div class="request-main">
                    <div class="request-title-row">
                        <h3 class="request-title">${esc(r.title || '')}</h3>
                        ${kindBadge}${statusBadge}
                    </div>
                    ${r.details ? `<p class="request-details">${esc(r.details).replace(/\n/g, '<br>')}</p>` : ''}
                    ${statusNote}
                    <div class="request-footer">
                        <span class="request-author">${esc(r.authorName || 'unknown')}</span>
                        <span class="request-time">${esc(timeAgo(r.createdAt?.toMillis?.()))}</span>
                        <span class="request-actions">${editAction}${adminActions}${reopenAction}${deleteAction}</span>
                    </div>
                </div>
            </div>
        `;
    }

    function wireCardEvents(container, uid, isAdmin) {
        container.querySelectorAll('.request-upvote').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                const r = items.find(x => x.id === id);
                if (!r) return;
                const votes = new Set(r.upvotes || []);
                if (votes.has(uid)) votes.delete(uid);
                else votes.add(uid);
                try {
                    await getDb().collection('requests').doc(id).update({
                        upvotes: [...votes],
                    });
                } catch (e) { alert('Vote failed: ' + e.message); }
            });
        });
        container.querySelectorAll('.request-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this request?')) return;
                try {
                    await getDb().collection('requests').doc(btn.dataset.id).delete();
                } catch (e) { alert('Delete failed: ' + e.message); }
            });
        });
        container.querySelectorAll('.request-mark-done').forEach(btn => {
            btn.addEventListener('click', async () => {
                const note = prompt('Optional note (shown under the request):', '');
                if (note === null) return;
                try {
                    await getDb().collection('requests').doc(btn.dataset.id).update({
                        status: 'done',
                        statusNote: note.slice(0, 500),
                    });
                } catch (e) { alert('Failed: ' + e.message); }
            });
        });
        container.querySelectorAll('.request-mark-rejected').forEach(btn => {
            btn.addEventListener('click', async () => {
                const note = prompt('Reason for rejection (shown under the request):', '');
                if (note === null) return;
                try {
                    await getDb().collection('requests').doc(btn.dataset.id).update({
                        status: 'rejected',
                        statusNote: note.slice(0, 500),
                    });
                } catch (e) { alert('Failed: ' + e.message); }
            });
        });
        container.querySelectorAll('.request-reopen').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await getDb().collection('requests').doc(btn.dataset.id).update({
                        status: 'open',
                        statusNote: '',
                    });
                } catch (e) { alert('Failed: ' + e.message); }
            });
        });
        container.querySelectorAll('.request-edit').forEach(btn => {
            btn.addEventListener('click', () => {
                const r = items.find(x => x.id === btn.dataset.id);
                if (r) showSubmitModal(r);
            });
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Submit / edit modal
    // ─────────────────────────────────────────────────────────────

    function showSubmitModal(existing) {
        // Guard: if this function is ever accidentally wired as a direct
        // event listener again, `existing` will be a MouseEvent — which is
        // truthy but has no `.id`. Coerce anything that doesn't look like
        // a real existing-request object back to null so we hit the .add()
        // path instead of .update() on a random Firestore doc.
        if (existing && typeof existing.id !== 'string') existing = null;
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'requestModal';
        overlay.innerHTML = `
            <div class="modal-box request-modal">
                <div class="modal-header">
                    <h2>${existing ? 'Edit request' : 'New request'}</h2>
                    <button class="modal-close" id="requestCloseBtn">&times;</button>
                </div>
                <label class="request-field">
                    <span>Type</span>
                    <select id="requestKind" class="auth-input">
                        <option value="game" ${existing?.kind === 'game' ? 'selected' : ''}>Game request</option>
                        <option value="feature" ${existing?.kind === 'feature' ? 'selected' : ''}>Feature request</option>
                        <option value="fix" ${existing?.kind === 'fix' ? 'selected' : ''}>Bug / fix</option>
                        <option value="other" ${existing?.kind === 'other' ? 'selected' : ''}>Other</option>
                    </select>
                </label>
                <label class="request-field">
                    <span>Title</span>
                    <input type="text" id="requestTitle" class="auth-input" maxlength="200" placeholder="Short summary" value="${esc(existing?.title || '')}">
                </label>
                <label class="request-field">
                    <span>Details <span style="opacity:.5;">(optional)</span></span>
                    <textarea id="requestDetails" class="auth-input" rows="5" maxlength="2000" placeholder="Any extra context — why, where, etc.">${esc(existing?.details || '')}</textarea>
                </label>
                <div class="request-modal-actions">
                    <button class="auth-submit" id="requestSaveBtn">${existing ? 'Save' : 'Submit'}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.getElementById('requestCloseBtn').addEventListener('click', close);

        document.getElementById('requestSaveBtn').addEventListener('click', async () => {
            const title = document.getElementById('requestTitle').value.trim().slice(0, 200);
            const details = document.getElementById('requestDetails').value.trim().slice(0, 2000);
            const kind = document.getElementById('requestKind').value;
            if (!title) { showError('Title is required.'); return; }
            const user = ArcadeAuth.getUser();
            if (!user) { showError('You must be logged in to submit a request.'); return; }

            // authorName must be a real string for Firestore — undefined would
            // trigger a client-side schema error before the network call.
            const authorName = ArcadeAuth.getUsername() || (user.email || 'unknown').split('@')[0];

            const saveBtn = document.getElementById('requestSaveBtn');
            saveBtn.disabled = true;
            saveBtn.textContent = existing ? 'Saving…' : 'Submitting…';

            try {
                if (existing) {
                    await getDb().collection('requests').doc(existing.id).update({
                        title, details, kind,
                    });
                } else {
                    await getDb().collection('requests').add({
                        title, details, kind,
                        status: 'open',
                        statusNote: '',
                        authorUid: user.uid,
                        authorName,
                        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                        upvotes: [user.uid],  // author auto-upvotes their own request
                    });
                }
                close();
            } catch (e) {
                saveBtn.disabled = false;
                saveBtn.textContent = existing ? 'Save' : 'Submit';
                handleWriteError(e, !!existing);
            }
        });

        // Inline error banner inside the modal (replaces alert() — alerts get
        // suppressed in some PWA standalone modes, and don't surface enough
        // info to debug Firestore rule failures).
        function showError(msg, opts) {
            opts = opts || {};
            let bar = document.getElementById('requestErrorBar');
            if (!bar) {
                bar = document.createElement('div');
                bar.id = 'requestErrorBar';
                bar.style.cssText = 'background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.5);color:#fecaca;padding:10px 12px;border-radius:8px;margin:0 0 12px;font-size:13px;line-height:1.4;white-space:pre-wrap;word-break:break-word;';
                const actionsEl = overlay.querySelector('.request-modal-actions');
                if (actionsEl) actionsEl.parentNode.insertBefore(bar, actionsEl);
            }
            bar.textContent = msg;
            if (opts.html) bar.innerHTML = msg;
        }

        function handleWriteError(e, isUpdate) {
            const code = e && e.code ? e.code : '';
            const msg = e && e.message ? e.message : String(e);
            if (code === 'permission-denied' || /permission/i.test(msg)) {
                // Most common cause: Firestore rule for /requests/{id} hasn't
                // been deployed (or was deployed without create permission for
                // regular users). Surface the exact rule to paste into Firebase
                // Console → Firestore → Rules.
                const rule = [
                    'match /requests/{id} {',
                    '  allow read: if request.auth != null;',
                    '  allow create: if request.auth != null',
                    '    && request.resource.data.authorUid == request.auth.uid',
                    "    && request.resource.data.status == 'open';",
                    '  allow update: if request.auth != null && (',
                    '    (resource.data.authorUid == request.auth.uid)',
                    '    || (request.auth.uid in request.resource.data.upvotes)',
                    '    || (request.auth.uid in resource.data.upvotes)',
                    "    || get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin'",
                    '  );',
                    '  allow delete: if request.auth != null',
                    '    && (resource.data.authorUid == request.auth.uid',
                    "      || get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin');",
                    '}',
                ].join('\n');
                showError(
                    'Permission denied (' + (code || 'no code') + ').\n\n' +
                    'Your Firestore rules for /requests are missing or too strict. Paste this into Firebase Console → Firestore Database → Rules:\n\n' +
                    rule
                );
                return;
            }
            showError((isUpdate ? 'Update' : 'Submit') + ' failed: ' + msg + (code ? ' [' + code + ']' : ''));
        }
    }

    window.ArcadeRequests = {
        renderRequestsView,
    };
})();
