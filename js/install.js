// PWA install prompt helper.
//
// Two paths to "Add to Home Screen":
//   1. Android Chrome / Edge / Brave fire `beforeinstallprompt` — we
//      capture the event, hide it from auto-display, and show our own
//      "Install" pill in the header. Click → call event.prompt().
//   2. iOS Safari does NOT fire that event. Apple makes users use the
//      share sheet manually ("Share → Add to Home Screen"). We detect
//      iOS-Safari (excluding standalone mode) and show a one-time
//      hint with the actual instructions.
//
// Either way, after install the standalone app gets the home-screen
// icon, theme color, and starts at /. Behaves like a native app.

(function () {
    let deferredPrompt = null;
    let installButton = null;
    const HINT_DISMISSED_KEY = 'arcade-ios-install-hint-dismissed';

    // ─── Detect environment ───────────────────────────────────────────
    function isStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true; // iOS Safari
    }
    function isIosSafari() {
        const ua = navigator.userAgent;
        const isIos = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
        const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
        return isIos && isSafari;
    }

    // ─── Android Chrome install button ────────────────────────────────
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        showInstallButton();
    });

    window.addEventListener('appinstalled', () => {
        // Hide the button after install. Browser also removes our
        // beforeinstallprompt handler so we don't re-show.
        deferredPrompt = null;
        if (installButton) installButton.remove();
        installButton = null;
    });

    function showInstallButton() {
        if (installButton) return;
        if (isStandalone()) return; // Already installed
        installButton = document.createElement('button');
        installButton.id = 'pwaInstallBtn';
        installButton.className = 'pwa-install-btn';
        installButton.type = 'button';
        installButton.title = 'Install the arcade as an app';
        installButton.innerHTML = '&#128229; Install';
        installButton.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            installButton.disabled = true;
            installButton.textContent = 'Installing…';
            try {
                deferredPrompt.prompt();
                const choice = await deferredPrompt.userChoice;
                deferredPrompt = null;
                if (choice.outcome === 'accepted') {
                    installButton.remove();
                    installButton = null;
                } else {
                    // User dismissed. Hide for this session.
                    installButton.remove();
                    installButton = null;
                }
            } catch (e) {
                installButton.disabled = false;
                installButton.innerHTML = '&#128229; Install';
            }
        });
        // Slot into the auth area beside Log in / Sign out etc.
        const authArea = document.getElementById('authArea');
        if (authArea && authArea.parentNode) {
            authArea.parentNode.insertBefore(installButton, authArea);
        } else {
            // Fallback: header
            document.querySelector('.header-content')?.appendChild(installButton);
        }
    }

    // ─── iOS Safari hint (one-time per device) ────────────────────────
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

    // Fire iOS hint on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', showIosHint);
    } else {
        showIosHint();
    }

    // Also expose the install button manually for users who dismissed it
    // and want to re-trigger from settings (we don't have settings UI yet
    // but the hook is here for future).
    window.ArcadeInstall = {
        showInstallButton,
        isStandalone,
        isIosSafari,
    };
})();
