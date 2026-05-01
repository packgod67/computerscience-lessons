// Site-wide branding — admin can override the logo, site name,
// announcement banner, and footer for the whole arcade. All readers
// pull from a single Firestore doc:
//
//   siteConfig/branding
//     {
//       logoUrl:    string (override for assets/logo.png)
//       siteName:   string (replaces "Arcade" in <title> + <h*>)
//       banner:     { text, color, dismissable, expiresAt } | null
//       footer:     { html }   // sanitized text + a few allowed tags
//     }
//
// Firestore rule (paste into your console):
//
//   match /siteConfig/{key} {
//     allow read:  if true;
//     allow write: if isAdmin();
//   }
//
// The doc is read-once on page load. Real-time updates would be nice
// but most branding changes are infrequent enough to not warrant a
// listener.

(function () {
    function getDb() { return window.ArcadeAuth?.getDb?.(); }

    async function load() {
        const db = getDb();
        if (!db) return null;
        try {
            const doc = await db.collection('siteConfig').doc('branding').get();
            return doc.exists ? doc.data() : null;
        } catch { return null; }
    }

    async function save(patch) {
        const db = getDb();
        if (!db) throw new Error('No DB');
        await db.collection('siteConfig').doc('branding').set(patch, { merge: true });
    }

    function applyLogo(url) {
        if (!url) return;
        document.querySelectorAll('.header-logo').forEach(img => {
            img.src = url;
        });
        // Update favicon too if no animated favicon is running
        const link = document.querySelector('link[rel~="icon"]:not([data-arcade-avatar])');
        if (link) link.href = url;
    }

    function applySiteName(name) {
        if (!name) return;
        // <title>
        const t = document.querySelector('title');
        if (t) t.textContent = name;
        // <meta name="application-name"> + apple-mobile-web-app-title
        document.querySelectorAll('meta[name="application-name"], meta[name="apple-mobile-web-app-title"]')
            .forEach(m => m.setAttribute('content', name));
        // Header logo alt text
        document.querySelectorAll('.header-logo').forEach(img => img.alt = name);
    }

    function applyBanner(banner) {
        // Remove any existing banner first
        document.querySelector('.site-banner')?.remove();
        if (!banner || !banner.text) return;
        // Honor expiry
        if (banner.expiresAt) {
            const exp = banner.expiresAt.toMillis ? banner.expiresAt.toMillis() : new Date(banner.expiresAt).getTime();
            if (exp && Date.now() > exp) return;
        }
        // Honor user dismissal
        const dismissKey = `arcade-banner-dismissed-${(banner.text || '').slice(0, 50)}`;
        if (banner.dismissable && localStorage.getItem(dismissKey) === '1') return;

        const el = document.createElement('div');
        el.className = 'site-banner';
        el.style.background = banner.color || 'linear-gradient(90deg, #7c3aed, #06b6d4)';
        el.innerHTML = `
            <span class="site-banner-text">${escapeHtml(banner.text)}</span>
            ${banner.dismissable ? '<button class="site-banner-close" aria-label="Dismiss">&times;</button>' : ''}
        `;
        document.body.prepend(el);
        if (banner.dismissable) {
            el.querySelector('.site-banner-close').addEventListener('click', () => {
                localStorage.setItem(dismissKey, '1');
                el.remove();
            });
        }
    }

    function applyFooter(footer) {
        document.querySelector('.site-footer')?.remove();
        if (!footer || !footer.html) return;
        const el = document.createElement('footer');
        el.className = 'site-footer';
        // Sanitize: strip script/style/iframe/on* attrs but allow basic
        // formatting tags + links. We're only letting admins write here
        // (rule enforces it) so this is belt-and-suspenders.
        el.innerHTML = sanitize(footer.html);
        document.body.appendChild(el);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function sanitize(html) {
        // Strip <script>, <style>, <iframe>, and on* event attributes.
        // Allow common formatting tags. This is a coarse filter — admins
        // shouldn't paste hostile HTML, but we err safe.
        return String(html)
            .replace(/<\/?(?:script|style|iframe|object|embed|form|meta|link)[^>]*>/gi, '')
            .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
            .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
            .replace(/javascript:/gi, '');
    }

    async function applyAll() {
        const cfg = await load();
        if (!cfg) return;
        if (cfg.logoUrl)  applyLogo(cfg.logoUrl);
        if (cfg.siteName) applySiteName(cfg.siteName);
        if (cfg.banner)   applyBanner(cfg.banner);
        if (cfg.footer)   applyFooter(cfg.footer);
    }

    // Apply on load. Wait for auth so reads are authorized.
    if (window.ArcadeAuth?.waitForAuth) {
        ArcadeAuth.waitForAuth().then(() => applyAll().catch(() => {}));
    }

    window.ArcadeBranding = { load, save, applyAll };
})();
