// Custom badge admin — admins create badges in Firestore, then award
// them to users by editing user.badgeIds.
//
// Schema:
//   badges/{badgeId}
//     { name, description, icon, color, createdAt }
//
// Rules:
//   match /badges/{id} {
//     allow read: if signedIn();
//     allow write: if isAdmin();
//   }
//
// Granting a badge updates users/{uid}.badgeIds — admins can already
// write that via the existing rule on /users/{uid}.
//
// UI:
//   - "Manage badges" button surfaces a modal with create + delete
//   - "Award badge" appears on each user card in the users panel for admins
// We piggyback on the role-management UI in users.js (mostly for delete);
// the create form here is its own modal.

(function () {
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function getDb() { return window.ArcadeAuth?.getDb?.(); }

    async function loadBadges() {
        const db = getDb();
        if (!db) return [];
        try {
            const snap = await db.collection('badges').orderBy('name').get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch { return []; }
    }

    async function createBadge({ name, description, icon, color }) {
        const db = getDb();
        if (!db) throw new Error('No DB');
        await db.collection('badges').add({
            name, description: description || '',
            icon: icon || '🎖', color: color || '#7c3aed',
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
    }

    async function deleteBadge(id) {
        const db = getDb();
        if (!db) throw new Error('No DB');
        await db.collection('badges').doc(id).delete();
    }

    async function awardBadge(uid, badgeId) {
        const db = getDb();
        if (!db) throw new Error('No DB');
        await db.collection('users').doc(uid).set({
            badgeIds: firebase.firestore.FieldValue.arrayUnion(badgeId),
        }, { merge: true });
    }

    async function revokeBadge(uid, badgeId) {
        const db = getDb();
        if (!db) throw new Error('No DB');
        await db.collection('users').doc(uid).set({
            badgeIds: firebase.firestore.FieldValue.arrayRemove(badgeId),
        }, { merge: true });
    }

    async function showBadgeAdminModal() {
        if (!window.ArcadeAuth?.isAdmin?.()) return;
        document.getElementById('badgeAdminModal')?.remove();
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'badgeAdminModal';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        const badges = await loadBadges();
        overlay.innerHTML = `
            <div class="modal-box">
                <div class="modal-header">
                    <h2>Manage badges</h2>
                    <button class="modal-close" id="closeBadgeAdmin">&times;</button>
                </div>
                <div class="badge-create-form">
                    <input type="text" id="bAdminName" placeholder="Badge name" class="auth-input" maxlength="40">
                    <input type="text" id="bAdminDesc" placeholder="Description (optional)" class="auth-input" maxlength="120">
                    <div class="badge-create-row">
                        <input type="text" id="bAdminIcon" placeholder="Icon emoji" class="auth-input" maxlength="4" style="width:80px;">
                        <input type="color" id="bAdminColor" value="#7c3aed" class="profile-edit-accent-input">
                        <button class="auth-submit" id="bAdminCreate">Create badge</button>
                    </div>
                </div>
                <div class="badge-admin-list">
                    ${badges.length ? badges.map(b => `
                        <div class="badge-admin-item">
                            <span class="profile-custom-badge" style="background:${esc(b.color || '#7c3aed')}">
                                <span class="profile-custom-badge-icon">${b.icon || '🎖'}</span>
                                <span class="profile-custom-badge-name">${esc(b.name)}</span>
                            </span>
                            <span class="badge-admin-desc">${esc(b.description || '')}</span>
                            <button class="badge-admin-delete" data-id="${esc(b.id)}">Delete</button>
                        </div>
                    `).join('') : '<p class="text-muted">No badges yet.</p>'}
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('#closeBadgeAdmin').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#bAdminCreate').addEventListener('click', async () => {
            const name = overlay.querySelector('#bAdminName').value.trim();
            const description = overlay.querySelector('#bAdminDesc').value.trim();
            const icon = overlay.querySelector('#bAdminIcon').value.trim() || '🎖';
            const color = overlay.querySelector('#bAdminColor').value;
            if (!name) { alert('Need a name'); return; }
            try {
                await createBadge({ name, description, icon, color });
                showBadgeAdminModal(); // refresh
            } catch (e) {
                alert('Create failed: ' + e.message);
            }
        });
        overlay.querySelectorAll('.badge-admin-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this badge?')) return;
                try {
                    await deleteBadge(btn.dataset.id);
                    showBadgeAdminModal();
                } catch (e) { alert('Delete failed: ' + e.message); }
            });
        });
    }

    window.ArcadeBadgesAdmin = {
        loadBadges, createBadge, deleteBadge,
        awardBadge, revokeBadge,
        showBadgeAdminModal,
    };
})();
