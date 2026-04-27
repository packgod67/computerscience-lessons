// PWA install prompt helper.
//
// Three install paths, depending on browser:
//   1. Android Chrome / Edge / Brave fire `beforeinstallprompt`. We
//      capture the event and trigger it from the Install pill.
//   2. iOS Safari does NOT fire that event — Apple makes users use the
//      share sheet manually. Click → modal with the Share-sheet steps.
//   3. Anything else (iOS Chrome, in-app browsers, desktop visitors on
//      mobile-emulator) → modal with browser-specific guidance and a
//      "open in your default browser" hint.
//
// The Install pill is ALWAYS visible (unless already standalone) so users
// don't have to wait for Chrome's engagement heuristic to fire — they
// can ask for instructions any time. If `deferredPrompt` arrives later,
// the same button switches from "show instructions" to "trigger native
// install" silently.

(function () {
    let deferredPrompt = null;
    let installButton = null;
    const HINT_DISMISSED_KEY = 'arcade-ios-install-hint-dismissed';

    // ─── Detect environment ───────────────────────────────────────────
    function isStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true; // iOS Safari
    }
    function isIos() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    }
    function isIosSafari() {
        if (!isIos()) return false;
        const ua = navigator.userAgent;
        return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    }
    function isAndroid() {
        return /Android/.test(navigator.userAgent);
    }
    function isInAppBrowser() {
        // Instagram, Facebook, TikTok, LinkedIn — none can install PWAs
        const ua = navigator.userAgent;
        return /(FBAN|FBAV|Instagram|Line|TikTok|Twitter|LinkedInApp|Pinterest)/i.test(ua);
    }
    function isChromeBased() {
        const ua = navigator.userAgent;
        // Detect Chromium engines (Chrome, Edge, Brave, Samsung Internet,
        // Opera). Excludes iOS Chrome — that's WebKit underneath and can't
        // install PWAs.
        return /(Chrome|CriOS|EdgA|EdgiOS|SamsungBrowser|OPR)/.test(ua) && !isIos();
    }

    // ─── beforeinstallprompt capture ─────────────────────────────────
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        // Already-rendered button? Switch from instructions-mode to
        // native-prompt mode by re-binding the click handler.
        if (installButton) {
            installButton.title = 'Install the arcade as an app';
        }
    });

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        if (installButton) installButton.remove();
        installButton = null;
        // Also kill the iOS hint banner if it's still up.
        const banner = document.getElementById('iosInstallBanner');
        if (banner) banner.remove();
    });

    // ─── Always-visible install button ────────────────────────────────
    function showInstallButton() {
        if (installButton) return;
        if (isStandalone()) return; // Already installed — hide

        installButton = document.createElement('button');
        installButton.id = 'pwaInstallBtn';
        installButton.className = 'pwa-install-btn';
        installButton.type = 'button';
        installButton.title = 'Install the arcade as an app';
        installButton.innerHTML = '&#128229; Install';
        installButton.addEventListener('click', handleInstallClick);
        // Slot into the auth area beside Log in / Sign out etc.
        const authArea = document.getElementById('authArea');
        if (authArea && authArea.parentNode) {
            authArea.parentNode.insertBefore(installButton, authArea);
        } else {
            document.querySelector('.header-content')?.appendChild(installButton);
        }
    }

    async function handleInstallClick() {
        // Path 1: Android Chrome captured a beforeinstallprompt → fire native dialog
        if (deferredPrompt) {
            installButton.disabled = true;
            installButton.textContent = 'Installing…';
            try {
                deferredPrompt.prompt();
                const choice = await deferredPrompt.userChoice;
                deferredPrompt = null;
                if (choice.outcome === 'accepted') {
                    installButton.remove();
                    installButton = null;
                    return;
                }
                // User dismissed — keep the button so they can retry,
                // restore label.
                installButton.disabled = false;
                installButton.innerHTML = '&#128229; Install';
            } catch (e) {
                installButton.disabled = false;
                installButton.innerHTML = '&#128229; Install';
            }
            return;
        }

        // Path 2 + 3: no captured prompt → show a how-to modal tailored
        // to the user's browser/OS combo.
        showInstallInstructionsModal();
    }

    // ─── Browser-specific instructions modal ─────────────────────────
    function showInstallInstructionsModal() {
        // Prevent stacking
        const existing = document.getElementById('arcadeInstallModal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'arcadeInstallModal';
        overlay.className = 'modal-overlay';
        // Inline minimal styling so it works even if a CSS update
        // hasn't reached cache yet.
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0',
            background: 'rgba(0,0,0,0.85)',
            zIndex: '99999',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '16px',
            paddingTop: 'calc(16px + env(safe-area-inset-top, 0px))',
            paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
        });

        const card = document.createElement('div');
        Object.assign(card.style, {
            background: '#1a1a2a',
            color: 'white',
            borderRadius: '14px',
            padding: '20px',
            width: '100%',
            maxWidth: '380px',
            maxHeight: '100%',
            overflowY: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            border: '1px solid rgba(255,255,255,0.1)',
            font: '14px/1.5 system-ui, sans-serif',
        });

        const { title, body, footer } = pickInstructions();

        const h = document.createElement('h3');
        h.textContent = title;
        Object.assign(h.style, { margin: '0 0 12px', fontSize: '18px', fontWeight: '700' });
        card.appendChild(h);

        const p = document.createElement('div');
        p.innerHTML = body;
        Object.assign(p.style, { opacity: '0.9', marginBottom: '16px' });
        card.appendChild(p);

        if (footer) {
            const f = document.createElement('div');
            f.innerHTML = footer;
            Object.assign(f.style, { fontSize: '12px', opacity: '0.6', marginBottom: '16px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '12px' });
            card.appendChild(f);
        }

        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Got it';
        Object.assign(closeBtn.style, {
            width: '100%',
            padding: '12px 16px',
            borderRadius: '8px',
            background: 'var(--accent, #7c3aed)',
            color: 'white',
            border: 'none',
            fontWeight: '700',
            fontSize: '15px',
            cursor: 'pointer',
        });
        closeBtn.addEventListener('click', () => overlay.remove());
        card.appendChild(closeBtn);

        overlay.appendChild(card);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
    }

    function pickInstructions() {
        if (isStandalone()) {
            return {
                title: 'Already installed',
                body: '<p>You’re running Arcade as an installed app right now — no action needed.</p>',
                footer: '',
            };
        }
        if (isInAppBrowser()) {
            return {
                title: 'Open in your browser',
                body: '<p>You’re viewing Arcade inside another app’s built-in browser, which can’t install web apps.</p>'
                    + '<p>Tap the <strong>⋮</strong> menu → <strong>Open in browser</strong> (or copy the URL into Safari/Chrome), then come back to this Install button.</p>',
                footer: '',
            };
        }
        if (isIosSafari()) {
            return {
                title: 'Install on iPhone / iPad',
                body: '<ol style="padding-left: 1.2em; margin: 0;">'
                    + '<li>Tap the <strong>Share</strong> button (the box with an up-arrow at the bottom of Safari).</li>'
                    + '<li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>'
                    + '<li>Tap <strong>Add</strong> in the top-right.</li>'
                    + '</ol>',
                footer: 'iOS only allows the Add-to-Home-Screen flow through Safari’s share sheet.',
            };
        }
        if (isIos()) {
            return {
                title: 'Switch to Safari to install',
                body: '<p>iOS only lets <strong>Safari</strong> install web apps. Other browsers (Chrome, Firefox, Edge on iPhone) can’t.</p>'
                    + '<p>Open <strong>arcade in Safari</strong>, then tap Share → Add to Home Screen.</p>',
                footer: '',
            };
        }
        if (isAndroid() && isChromeBased()) {
            return {
                title: 'Install on Android',
                body: '<p>Tap the <strong>⋮</strong> menu in the top-right of Chrome, then choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>'
                    + '<p>If you don’t see those options yet, browse Arcade for ~30 seconds first — Chrome unlocks installation after a bit of engagement.</p>',
                footer: 'When the option is ready, this Install button can also trigger it directly.',
            };
        }
        if (isAndroid()) {
            return {
                title: 'Switch to Chrome to install',
                body: '<p>Your current Android browser can’t install web apps. Open Arcade in <strong>Chrome</strong>, <strong>Edge</strong>, <strong>Brave</strong>, or <strong>Samsung Internet</strong> — then tap menu → Install app.</p>',
                footer: '',
            };
        }
        // Desktop fallback
        return {
            title: 'Install on desktop',
            body: '<p>In the URL bar (Chrome / Edge / Brave) you should see a small <strong>install</strong> icon — click it.</p>'
                + '<p>Or open the menu → <strong>Install Arcade</strong>.</p>',
            footer: 'Firefox and Safari on desktop don’t support PWA installation.',
        };
    }

    // ─── iOS Safari one-time hint banner ──────────────────────────────
    function showIosHint() {
        if (isStandalone()) return;
        if (!isIosSafari()) return;
        if (localStorage.getItem(HINT_DISMISSED_KEY)) return;

        const banner = document.createElement('div');
        banner.id = 'iosInstallBanner';
        banner.className = 'ios-install-banner';
        banner.innerHTML = `
            <div class="ios-install-banner-inner">
                <img src="assets/logo.png" alt="" class="ios-install-banner-icon">
                <div class="ios-install-banner-text">
                    <strong>Install Arcade</strong>
                    <span>Tap <span aria-label="share">&#x1F5D2;</span> Share, then "Add to Home Screen".</span>
                </div>
                <button class="ios-install-banner-close" aria-label="Dismiss">&times;</button>
            </div>`;
        document.body.appendChild(banner);
        banner.querySelector('.ios-install-banner-close').addEventListener('click', () => {
            try { localStorage.setItem(HINT_DISMISSED_KEY, '1'); } catch {}
            banner.remove();
        });
    }

    // ─── Boot ─────────────────────────────────────────────────────────
    function boot() {
        showInstallButton();
        showIosHint();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    window.ArcadeInstall = {
        showInstallButton,
        isStandalone,
        isIosSafari,
        showInstallInstructionsModal,
    };
})();
