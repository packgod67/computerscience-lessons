// Admin UI for site branding. Surfaces a modal where admins can edit
// the logo URL, site name, announcement banner, and footer HTML.
// Live-applies on save.
//
// Wired into the admin tools menu (settings panel admin section).

(function () {
    function getDb() { return window.ArcadeAuth?.getDb?.(); }
    function isAdmin() { return window.ArcadeAuth?.isAdmin?.(); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    async function showBrandingAdminModal() {
        if (!isAdmin()) return;
        document.getElementById('brandingAdminModal')?.remove();
        const cfg = (await window.ArcadeBranding?.load?.()) || {};
        const banner = cfg.banner || {};
        const footer = cfg.footer || {};

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'brandingAdminModal';
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

        overlay.innerHTML = `
            <div class="modal-box modal-box-wide">
                <div class="modal-header">
                    <h2>Site branding</h2>
                    <button class="modal-close" id="closeBrandingAdmin">&times;</button>
                </div>
                <div class="branding-admin-body">
                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Custom logo URL <span class="profile-edit-hint">(replaces the arcade logo across the whole site)</span></label>
                        <input type="url" id="bAdminLogo" class="auth-input" placeholder="https://… (PNG, SVG, GIF)" value="${esc(cfg.logoUrl || '')}">
                    </div>
                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Site name <span class="profile-edit-hint">(replaces "Arcade" in the title bar)</span></label>
                        <input type="text" id="bAdminName" class="auth-input" maxlength="40" placeholder="Arcade" value="${esc(cfg.siteName || '')}">
                    </div>

                    <h3 class="branding-admin-section">Announcement banner</h3>
                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Banner text</label>
                        <textarea id="bAdminBannerText" class="profile-edit-bio" maxlength="200" placeholder="e.g. New games dropped! Check the Pokemon section.">${esc(banner.text || '')}</textarea>
                    </div>
                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Banner background</label>
                        <input type="text" id="bAdminBannerColor" class="auth-input" placeholder="CSS color or gradient (e.g. linear-gradient(90deg,#7c3aed,#06b6d4))" value="${esc(banner.color || '')}">
                    </div>
                    <div class="profile-edit-row">
                        <label class="arcade-settings-checkbox">
                            <input type="checkbox" id="bAdminBannerDismiss" ${banner.dismissable !== false ? 'checked' : ''}>
                            Visitors can dismiss
                        </label>
                    </div>

                    <h3 class="branding-admin-section">Footer</h3>
                    <div class="profile-edit-row">
                        <label class="profile-edit-label">Footer HTML <span class="profile-edit-hint">(safe tags only — links / formatting)</span></label>
                        <textarea id="bAdminFooter" class="profile-edit-bio" style="min-height:120px;font-family:ui-monospace,monospace;" maxlength="4000">${esc(footer.html || '')}</textarea>
                    </div>

                    <div class="branding-admin-actions">
                        <button class="auth-submit-secondary" id="bAdminClear">Clear all branding</button>
                        <button class="auth-submit" id="bAdminSave">Save</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('#closeBrandingAdmin').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#bAdminSave').addEventListener('click', async () => {
            const patch = {
                logoUrl:  overlay.querySelector('#bAdminLogo').value.trim().slice(0, 500) || null,
                siteName: overlay.querySelector('#bAdminName').value.trim().slice(0, 40)  || null,
                banner: {
                    text: overlay.querySelector('#bAdminBannerText').value.trim().slice(0, 200),
                    color: overlay.querySelector('#bAdminBannerColor').value.trim().slice(0, 200) || null,
                    dismissable: overlay.querySelector('#bAdminBannerDismiss').checked,
                },
                footer: {
                    html: overlay.querySelector('#bAdminFooter').value.slice(0, 4000),
                },
            };
            try {
                await window.ArcadeBranding.save(patch);
                await window.ArcadeBranding.applyAll();
                overlay.remove();
            } catch (e) {
                alert('Save failed: ' + e.message);
            }
        });
        overlay.querySelector('#bAdminClear').addEventListener('click', async () => {
            if (!confirm('Clear all custom branding?')) return;
            try {
                await window.ArcadeBranding.save({
                    logoUrl: null, siteName: null, banner: null, footer: null
                });
                location.reload();
            } catch (e) { alert('Clear failed: ' + e.message); }
        });
    }

    window.ArcadeBrandingAdmin = { showBrandingAdminModal };
})();
