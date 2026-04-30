// Profile customization v3 runtime effects.
//
// Centralizes the small bits of JS that the pure-CSS visual layer
// can't pull off on its own:
//   - cursor trail (sparkles / hearts / stars / fire / dots)
//   - animated favicon (cycles the user's avatar through frames)
//   - profile entry sound (plays once per profile open)
//   - username typewriter effect (clears + retypes the username)
//
// These are all opt-in per-profile. The static CSS handles everything
// else (avatar aura particles, accessories, name effects, fonts,
// cursor presets, entry animation, etc.) — see style.css §"PROFILE
// CUSTOMIZATION V3".

(function () {
    // ─── Cursor trail ───────────────────────────────────────────────
    // A tiny particle emitter that drops a fading element at the cursor
    // position every ~30ms while the cursor is over an element with
    // `data-cursor-trail` set. Class on the element controls which
    // particle character is emitted.
    let trailActive = false;
    let trailType = 'none';
    let lastEmit = 0;
    const TRAIL_PARTICLES = {
        sparkles: ['✨', '⭐', '✦'],
        hearts:   ['❤', '💖', '💗'],
        stars:    ['★', '☆', '✦'],
        fire:     ['🔥', '✦'],
        dots:     ['•'],
    };

    function spawnParticle(x, y) {
        const set = TRAIL_PARTICLES[trailType];
        if (!set) return;
        const ch = set[Math.floor(Math.random() * set.length)];
        const span = document.createElement('span');
        span.className = 'profile-cursor-particle';
        span.textContent = ch;
        span.style.left = x + 'px';
        span.style.top  = y + 'px';
        span.style.setProperty('--dx', (Math.random() - 0.5) * 60 + 'px');
        span.style.setProperty('--dy', (Math.random() * -40 - 20) + 'px');
        document.body.appendChild(span);
        // Animation handles fade + drift; clean up after.
        setTimeout(() => span.remove(), 1100);
    }

    document.addEventListener('mousemove', (e) => {
        if (!trailActive || trailType === 'none') return;
        const now = Date.now();
        if (now - lastEmit < 30) return;
        lastEmit = now;
        // Only emit while cursor is inside a profile modal (so the trail
        // doesn't follow the user across the whole site).
        const modal = e.target.closest?.('.profile-modal');
        if (!modal) return;
        spawnParticle(e.clientX, e.clientY);
    });

    function setCursorTrail(type) {
        trailType = type || 'none';
        trailActive = trailType !== 'none';
    }

    // ─── Profile entry sound ────────────────────────────────────────
    // Plays the URL once when the profile modal opens. Volume capped low
    // so it's not jarring. Visitors can mute via the existing BGM toggle
    // or browser tab mute.
    function playEnterSound(url) {
        if (!url) return;
        try {
            const a = new Audio(url);
            a.volume = 0.3;
            // Most browsers require a user gesture before audio plays.
            // Profile-open is itself a click, so this should be permitted
            // on the first open after page load. Subsequent opens that
            // chain off other clicks should also be fine.
            a.play().catch(() => {});
        } catch {}
    }

    // ─── Username typewriter effect ─────────────────────────────────
    // The static CSS handles "static effects" (rainbow/fire/glitch/
    // sparkle). Typewriter has to retype the text in JS so it animates
    // letter-by-letter on profile open. This runs ONCE when the profile
    // mounts; subsequent re-renders by the parent reset it.
    function applyTypewriter(rootEl) {
        const nameSpan = rootEl?.querySelector('.profile-name > span');
        if (!nameSpan) return;
        const full = nameSpan.textContent;
        nameSpan.textContent = '';
        nameSpan.classList.add('profile-name-typewriter-active');
        let i = 0;
        const tick = () => {
            if (i >= full.length) {
                nameSpan.classList.remove('profile-name-typewriter-active');
                return;
            }
            nameSpan.textContent += full[i++];
            setTimeout(tick, 70);
        };
        tick();
    }

    // ─── Animated favicon ───────────────────────────────────────────
    // Cycles the page's <link rel="icon"> through a few frames so the
    // tab favicon feels alive. Currently a single mode: pulse between
    // a base avatar and a slightly-tinted version. Caller passes the
    // user's avatar URL; if absent, no-op.
    let faviconTimer = null;
    function applyAnimatedFavicon(avatarUrl) {
        clearAnimatedFavicon();
        if (!avatarUrl) return;
        const link = ensureFaviconLink();
        const orig = link.href;
        // Two-frame cycle: avatar / accent-tinted avatar. The tint is
        // accomplished by drawing the avatar to a canvas and overlaying
        // a translucent fill.
        const tinted = tintImage(avatarUrl).catch(() => null);
        Promise.resolve(tinted).then(tintedUrl => {
            if (!tintedUrl) return;
            let on = false;
            faviconTimer = setInterval(() => {
                link.href = on ? avatarUrl : tintedUrl;
                on = !on;
            }, 1200);
            // Restore original favicon when we navigate away.
            window.addEventListener('beforeunload', () => {
                if (link) link.href = orig;
            }, { once: true });
        });
    }

    function clearAnimatedFavicon() {
        if (faviconTimer) {
            clearInterval(faviconTimer);
            faviconTimer = null;
        }
    }

    function ensureFaviconLink() {
        let link = document.querySelector('link[rel~="icon"]');
        if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.head.appendChild(link);
        }
        return link;
    }

    function tintImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 64;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, 64, 64);
                ctx.globalCompositeOperation = 'source-atop';
                ctx.fillStyle = 'rgba(124, 58, 237, 0.45)';
                ctx.fillRect(0, 0, 64, 64);
                try {
                    resolve(canvas.toDataURL('image/png'));
                } catch (e) {
                    reject(e); // tainted canvas if avatar is cross-origin without CORS
                }
            };
            img.onerror = reject;
            img.src = url;
        });
    }

    // ─── Public API ─────────────────────────────────────────────────
    // profiles.js calls applyProfileFx(profile, modalEl) right after
    // mounting the modal innerHTML. The profile object carries every
    // v3 field we care about.
    function applyProfileFx(profile, modalEl) {
        if (!profile || !modalEl) return;

        // Cursor trail — scoped to the modal via mousemove handler
        setCursorTrail(profile.cursorTrail || 'none');

        // Profile sound on enter
        if (profile.enterSound) playEnterSound(profile.enterSound);

        // Username typewriter — only when usernameEffect is 'typewriter'
        if (profile.usernameEffect === 'typewriter') applyTypewriter(modalEl);

        // Animated favicon — only on the user's OWN profile (don't
        // hijack the tab favicon when viewing someone else)
        const me = window.ArcadeAuth?.getUser?.();
        if (me && profile.uid === me.uid && profile.avatar) {
            // Opt-in: only enable when the user has set usernameEffect
            // to anything non-default. This is a "show off" feature,
            // we don't want to flicker every visitor's tab. Using
            // titleText as the trigger so the user has to set SOMETHING
            // intentional first.
            if (profile.titleText || profile.usernameEffect !== 'none') {
                applyAnimatedFavicon(profile.avatar);
            }
        }
    }

    function teardownProfileFx() {
        setCursorTrail('none');
        clearAnimatedFavicon();
    }

    window.ArcadeProfileFx = {
        applyProfileFx,
        teardownProfileFx,
    };
})();
