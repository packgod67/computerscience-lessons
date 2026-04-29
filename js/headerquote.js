// Header-quote: a small personal tagline rendered between the settings
// gear and the install button in the top header.
//
// Behavior:
//   - Sourced from profile.headerQuote (Firestore) if signed in,
//     otherwise from localStorage `arcade-header-quote` so logged-out
//     users still get to set one (saved on this device).
//   - Click (or focus + Enter) to edit inline. Esc cancels, Enter or
//     blur commits. Empty string is allowed and clears the quote;
//     nothing renders when the value is empty.
//   - Renders `:emoji:` codes through the chat emoji renderer when
//     ArcadeEmojis is loaded, so the quote can include shared emojis.
//   - Max 80 chars (matches the profile status field cap).
//
// Visible only to the user who set it (it's tied to the local session,
// not the public profile). Other users browsing your profile see the
// `status` field on your profile card instead.

(function () {
    const KEY_LOCAL = 'arcade-header-quote';
    const MAX_LEN = 80;
    const PLACEHOLDER = '+ add quote';

    function el() { return document.getElementById('headerQuote'); }

    function readLocal() {
        try { return localStorage.getItem(KEY_LOCAL) || ''; } catch { return ''; }
    }
    function writeLocal(v) {
        try { localStorage.setItem(KEY_LOCAL, v || ''); } catch {}
    }

    // Render the quote. Empty values fall back to a faint placeholder so
    // the user has something to click on to start editing.
    function render(value) {
        const node = el();
        if (!node) return;
        node.dataset.value = value || '';
        if (!value) {
            node.classList.add('is-empty');
            node.textContent = PLACEHOLDER;
            return;
        }
        node.classList.remove('is-empty');
        // Pass through the emoji renderer if it's available so :wave: etc.
        // become inline images. The renderer expects already-escaped text;
        // we escape here.
        const escaped = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        node.innerHTML = window.ArcadeEmojis
            ? ArcadeEmojis.replaceEmojis(escaped)
            : escaped;
    }

    function startEdit() {
        const node = el();
        if (!node) return;
        if (node.dataset.editing === '1') return;
        node.dataset.editing = '1';
        const current = node.dataset.value || '';
        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = MAX_LEN;
        input.value = current;
        input.placeholder = 'your quote…';
        input.className = 'header-quote-input';
        node.innerHTML = '';
        node.appendChild(input);
        input.focus();
        input.select();

        let committed = false;
        const commit = async (newVal) => {
            if (committed) return;
            committed = true;
            const trimmed = (newVal || '').slice(0, MAX_LEN);
            node.dataset.editing = '0';
            render(trimmed);
            // Persist locally always
            writeLocal(trimmed);
            // Sync to profile if logged in
            try {
                if (window.ArcadeAuth?.isLoggedIn?.()) {
                    await ArcadeAuth.updateProfile({ headerQuote: trimmed });
                }
            } catch (e) {
                // localStorage is the source of truth for offline; no UI
                // alert here, the failure is logged to the errors view.
                console.warn('headerQuote sync failed:', e);
            }
        };
        const cancel = () => {
            if (committed) return;
            committed = true;
            node.dataset.editing = '0';
            render(current);
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(input.value); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', () => commit(input.value));
    }

    function init() {
        const node = el();
        if (!node) return;
        node.addEventListener('click', startEdit);
        node.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                startEdit();
            }
        });

        // Initial paint from localStorage (instant), then upgrade when
        // the profile arrives.
        render(readLocal());

        // When auth resolves, prefer the profile value if set. We use it
        // even when empty so deleting from one device clears everywhere.
        if (window.ArcadeAuth?.waitForAuth) {
            ArcadeAuth.waitForAuth().then(async () => {
                if (!ArcadeAuth.isLoggedIn()) return;
                try {
                    const profile = await ArcadeAuth.getProfile(ArcadeAuth.getUser().uid);
                    if (profile && typeof profile.headerQuote === 'string') {
                        writeLocal(profile.headerQuote);
                        render(profile.headerQuote);
                    }
                } catch {}
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
