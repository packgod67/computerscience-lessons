// Site-wide animated favicon: when the user is signed in and has an
// avatar, swap the page favicon to their avatar (lightly tinted on a
// 1.2s cycle). Gives the open arcade tab personality and helps users
// find it among many tabs.
//
// Why not in profile-fx.js? That module's animated-favicon is scoped
// to viewing your own profile modal. THIS module runs across every
// page (index, play, install) so the favicon reflects who you are
// even when no profile is open.

(function () {
    let timer = null;

    function ensureLink() {
        let link = document.querySelector('link[rel~="icon"][data-arcade-avatar]');
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            link.dataset.arcadeAvatar = '1';
            document.head.appendChild(link);
        }
        return link;
    }

    function tintAvatar(url, color) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = c.height = 64;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0, 64, 64);
                ctx.globalCompositeOperation = 'source-atop';
                ctx.fillStyle = color;
                ctx.fillRect(0, 0, 64, 64);
                try { resolve(c.toDataURL('image/png')); }
                catch { resolve(null); }
            };
            img.onerror = () => resolve(null);
            img.src = url;
        });
    }

    async function start(avatarUrl) {
        stop();
        if (!avatarUrl) return;
        const link = ensureLink();
        const tinted = await tintAvatar(avatarUrl, 'rgba(124, 58, 237, 0.45)');
        if (!tinted) return; // CORS-tainted, give up silently
        let on = false;
        link.href = avatarUrl;
        timer = setInterval(() => {
            link.href = on ? avatarUrl : tinted;
            on = !on;
        }, 1200);
    }

    function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    // Wait for auth, then if we have an avatar URL, kick off the
    // animation. We watch profile updates so changing your avatar
    // refreshes the favicon without a reload.
    if (window.ArcadeAuth?.waitForAuth) {
        ArcadeAuth.waitForAuth().then(async () => {
            if (!ArcadeAuth.isLoggedIn()) return;
            try {
                const profile = await ArcadeAuth.getProfile(ArcadeAuth.getUser().uid);
                if (profile?.avatar) start(profile.avatar);
            } catch {}
        });
    }

    window.ArcadeAnimatedFavicon = { start, stop };
})();
