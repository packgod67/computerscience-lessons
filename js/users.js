(function () {
    let db;
    let allRoles = [];
    let allUsers = [];
    let rolesMap = {};
    let usersViewActive = false;
    let banViewActive = false;
    let unsubUsers = null;
    let unsubRoles = null;

    function getDb() {
        if (!db) db = ArcadeAuth.getDb();
        return db;
    }

    async function loadRoles() {
        try {
            const snap = await getDb().collection('roles').get();
            allRoles = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            allRoles.sort((a, b) => (a.priority || 0) - (b.priority || 0));
            rolesMap = {};
            allRoles.forEach(r => { rolesMap[r.id] = r; });
        } catch {
            allRoles = [];
            rolesMap = {};
        }
    }

    async function loadUsers() {
        try {
            const snap = await getDb().collection('users').get();
            allUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
            allUsers.sort((a, b) => (a.username || '').localeCompare(b.username || ''));
        } catch {
            allUsers = [];
        }
    }

    function startListeners() {
        if (unsubUsers) return; // already listening

        unsubRoles = getDb().collection('roles').onSnapshot((snap) => {
            allRoles = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            allRoles.sort((a, b) => (a.priority || 0) - (b.priority || 0));
            rolesMap = {};
            allRoles.forEach(r => { rolesMap[r.id] = r; });
            if (usersViewActive) rerenderUsersView();
            if (banViewActive) rerenderBanView();
        }, () => {});

        unsubUsers = getDb().collection('users').onSnapshot((snap) => {
            allUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
            allUsers.sort((a, b) => (a.username || '').localeCompare(b.username || ''));
            if (usersViewActive) rerenderUsersView();
            if (banViewActive) rerenderBanView();
        }, () => {});
    }

    function renderRoleBadges(roleIds) {
        if (!roleIds || roleIds.length === 0) return '';
        return roleIds
            .map(id => rolesMap[id])
            .filter(Boolean)
            .sort((a, b) => (a.priority || 0) - (b.priority || 0))
            .map(r => `<span class="role-badge" style="background:${esc(r.color)}">${esc(r.name)}</span>`)
            .join('');
    }

    function getTopRoleColor(roleIds) {
        if (!roleIds || roleIds.length === 0) return null;
        let best = null;
        for (const id of roleIds) {
            const role = rolesMap[id];
            if (!role) continue;
            if (!best || (role.priority || 99) < (best.priority || 99)) {
                best = role;
            }
        }
        return best ? best.color : null;
    }

    function rerenderUsersView() {
        const container = document.getElementById('usersView');
        if (!container) return;
        buildUsersHTML(container);
    }

    function rerenderBanView() {
        const container = document.getElementById('banView');
        if (!container) return;
        buildBanHTML(container);
    }

    async function renderUsersView() {
        const container = document.getElementById('usersView');
        if (!container) return;
        container.innerHTML = '<div class="users-loading">Loading users...</div>';

        await loadRoles();
        await loadUsers();
        startListeners();
        usersViewActive = true;

        buildUsersHTML(container);
    }

    function buildUsersHTML(container) {
        const isAdmin = ArcadeAuth.isAdmin();

        let html = '<div class="users-panel">';

        if (isAdmin) {
            html += '<div class="users-admin-bar"><button class="manage-roles-btn" id="manageRolesBtn">Manage Roles</button></div>';
        }

        html += '<div class="users-list">';
        const currentUid = ArcadeAuth.getUser()?.uid;
        for (const u of allUsers) {
            if (u.banned) continue; // Hide banned users from main list
            const adminBadge = u.role === 'admin' ? '<span class="role-badge role-badge-admin">ADMIN</span>' : '';
            const customBadges = renderRoleBadges(u.roleIds);
            const nameColor = getTopRoleColor(u.roleIds);
            const nameStyle = nameColor ? ` style="color:${esc(nameColor)}"` : '';
            const assignBtn = isAdmin ? `<button class="assign-role-btn" data-uid="${esc(u.uid)}" title="Assign Roles">+</button>` : '';
            const isSelf = u.uid === currentUid;
            const banBtn = (isAdmin && !isSelf && u.role !== 'admin') ? `<button class="ban-user-btn" data-uid="${esc(u.uid)}" data-banned="0">Ban</button>` : '';
            html += `<div class="user-row">
                <div class="user-row-info">
                    <span class="user-row-name" data-open-profile-uid="${esc(u.uid)}" role="button" tabindex="0"${nameStyle}>${esc(u.username || 'unknown')}</span>
                    ${assignBtn}
                    ${adminBadge}${customBadges}
                </div>
                ${banBtn}
            </div>`;
        }
        html += '</div></div>';

        container.innerHTML = html;

        if (isAdmin) {
            document.getElementById('manageRolesBtn')?.addEventListener('click', showRoleManagementModal);
            container.querySelectorAll('.assign-role-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const uid = btn.dataset.uid;
                    const user = allUsers.find(u => u.uid === uid);
                    if (user) showAssignRolesModal(user);
                });
            });
            container.querySelectorAll('.ban-user-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const uid = btn.dataset.uid;
                    if (!confirm('Are you sure you want to ban this user?')) return;
                    try {
                        await ArcadeAuth.banUser(uid, true);
                    } catch (e) { alert('Failed: ' + e.message); }
                });
            });
        }
    }

    // ===== Role Management Modal =====
    function showRoleManagementModal() {
        closeModal();
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'roleModal';

        let rolesHtml = allRoles.map(r => `
            <div class="role-list-item">
                <span class="role-badge" style="background:${esc(r.color)}">${esc(r.name)}</span>
                <span class="role-priority">Priority: ${r.priority}</span>
                <button class="role-edit-btn" data-id="${r.id}">Edit</button>
                <button class="role-delete-btn" data-id="${r.id}">Delete</button>
            </div>`).join('');

        overlay.innerHTML = `
            <div class="modal-box">
                <div class="modal-header">
                    <h2>Manage Roles</h2>
                    <button class="modal-close" id="closeRoleModal">&times;</button>
                </div>
                <div class="role-form" id="roleForm">
                    <input type="text" id="roleName" placeholder="Role name" class="auth-input">
                    <div class="role-form-row">
                        <input type="color" id="roleColor" value="#7c3aed" class="role-color-input">
                        <input type="number" id="rolePriority" placeholder="Priority (0=highest)" class="auth-input" value="10" min="0">
                    </div>
                    <button class="auth-submit" id="createRoleBtn">Create Role</button>
                </div>
                <div class="role-list" id="roleList">${rolesHtml || '<p class="text-muted">No roles yet.</p>'}</div>
            </div>`;

        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
        document.getElementById('closeRoleModal').addEventListener('click', closeModal);

        document.getElementById('createRoleBtn').addEventListener('click', async () => {
            const name = document.getElementById('roleName').value.trim();
            const color = document.getElementById('roleColor').value;
            const priority = parseInt(document.getElementById('rolePriority').value) || 10;
            if (!name) return;
            try {
                await getDb().collection('roles').add({ name, color, priority, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
                await loadRoles();
                showRoleManagementModal();
            } catch (e) {
                alert('Failed to create role: ' + e.message);
            }
        });

        document.getElementById('roleList').addEventListener('click', async (e) => {
            const delBtn = e.target.closest('.role-delete-btn');
            if (delBtn) {
                if (!confirm('Delete this role?')) return;
                try {
                    await getDb().collection('roles').doc(delBtn.dataset.id).delete();
                    await loadRoles();
                    showRoleManagementModal();
                } catch (err) {
                    alert('Failed to delete: ' + err.message);
                }
                return;
            }
            const editBtn = e.target.closest('.role-edit-btn');
            if (editBtn) {
                showEditRoleForm(editBtn.dataset.id);
            }
        });
    }

    function showEditRoleForm(roleId) {
        const role = rolesMap[roleId];
        if (!role) return;
        const form = document.getElementById('roleForm');
        document.getElementById('roleName').value = role.name;
        document.getElementById('roleColor').value = role.color;
        document.getElementById('rolePriority').value = role.priority;

        const btn = document.getElementById('createRoleBtn');
        btn.textContent = 'Save Changes';
        btn.onclick = async () => {
            const name = document.getElementById('roleName').value.trim();
            const color = document.getElementById('roleColor').value;
            const priority = parseInt(document.getElementById('rolePriority').value) || 10;
            if (!name) return;
            try {
                await getDb().collection('roles').doc(roleId).update({ name, color, priority });
                await loadRoles();
                showRoleManagementModal();
            } catch (e) {
                alert('Failed to update: ' + e.message);
            }
        };
    }

    // ===== Assign Roles Modal =====
    function showAssignRolesModal(user) {
        closeModal();
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'assignModal';

        const currentIds = new Set(user.roleIds || []);
        let checksHtml = allRoles.map(r => {
            const checked = currentIds.has(r.id) ? 'checked' : '';
            return `<label class="role-check-label">
                <input type="checkbox" value="${r.id}" ${checked}>
                <span class="role-badge" style="background:${esc(r.color)}">${esc(r.name)}</span>
            </label>`;
        }).join('');

        if (!checksHtml) checksHtml = '<p class="text-muted">No roles created yet. Create roles first.</p>';

        overlay.innerHTML = `
            <div class="modal-box">
                <div class="modal-header">
                    <h2>Assign Roles to ${esc(user.username)}</h2>
                    <button class="modal-close" id="closeAssignModal">&times;</button>
                </div>
                <div class="role-checks" id="roleChecks">${checksHtml}</div>
                <button class="auth-submit" id="saveAssignBtn" style="margin-top:1rem;">Save</button>
            </div>`;

        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
        document.getElementById('closeAssignModal').addEventListener('click', closeModal);

        document.getElementById('saveAssignBtn').addEventListener('click', async () => {
            const checked = [...document.querySelectorAll('#roleChecks input:checked')].map(c => c.value);
            try {
                await getDb().collection('users').doc(user.uid).update({ roleIds: checked });
                closeModal();
            } catch (e) {
                alert('Failed to assign roles: ' + e.message);
            }
        });
    }

    // ===== Ban View =====
    async function renderBanView() {
        const container = document.getElementById('banView');
        if (!container) return;
        container.innerHTML = '<div class="users-loading">Loading banned users...</div>';

        await loadUsers();
        startListeners();
        banViewActive = true;

        buildBanHTML(container);
    }

    function buildBanHTML(container) {
        const bannedUsers = allUsers.filter(u => u.banned);

        let html = '<div class="users-panel">';
        html += '<h2 class="ban-view-title">Banned Users</h2>';

        if (bannedUsers.length === 0) {
            html += '<div class="gallery-empty">No banned users.</div>';
        } else {
            html += '<div class="users-list">';
            for (const u of bannedUsers) {
                html += `<div class="user-row user-row-banned">
                    <div class="user-row-info">
                        <span class="user-row-name">${esc(u.username || 'unknown')}</span>
                        <span class="role-badge role-badge-banned">BANNED</span>
                    </div>
                    <button class="ban-user-btn banned" data-uid="${esc(u.uid)}">Unban</button>
                </div>`;
            }
            html += '</div>';
        }
        html += '</div>';
        container.innerHTML = html;

        container.querySelectorAll('.ban-user-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Unban this user?')) return;
                try {
                    await ArcadeAuth.banUser(btn.dataset.uid, false);
                } catch (e) { alert('Failed: ' + e.message); }
            });
        });
    }

    function closeModal() {
        document.getElementById('roleModal')?.remove();
        document.getElementById('assignModal')?.remove();
    }

    function esc(s) {
        if (!s) return '';
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    window.ArcadeUsers = {
        renderUsersView,
        renderBanView,
        renderRoleBadges,
        loadRoles,
        getRolesMap: () => rolesMap,
        getAllRoles: () => allRoles
    };
})();
