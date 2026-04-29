// Pull-to-refresh on the home grid (mobile only).
//
// Watches touchstart/move/end on the document. When the user is scrolled
// to the top and pulls down by more than 80px, releasing triggers a
// reload of games.json + a re-render. While dragging, a subtle indicator
// fades in showing how close they are to the threshold.
//
// Skipped on desktop (no touch input expected) and inside iframes (game
// pages have their own scroll behavior).

(function () {
    if (window.self !== window.top) return;             // skip in iframes
    if (!('ontouchstart' in window)) return;            // desktop / no touch
    // Skip if not the home page (no game grid to refresh)
    if (!document.getElementById('gameGrid')) return;

    const TRIGGER_PX = 80;
    const MAX_PULL = 140;
    let startY = 0;
    let pulling = false;
    let armed = false;
    let indicator = null;

    function ensureIndicator() {
        if (indicator) return indicator;
        indicator = document.createElement('div');
        indicator.id = 'arcade-ptr-indicator';
        indicator.innerHTML = `
            <div class="arcade-ptr-spinner"></div>
            <div class="arcade-ptr-label">Pull to refresh</div>
        `;
        document.body.appendChild(indicator);
        return indicator;
    }

    document.addEventListener('touchstart', (e) => {
        if (window.scrollY > 4) return;
        if (!e.touches || !e.touches[0]) return;
        startY = e.touches[0].clientY;
        pulling = true;
        armed = false;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!pulling) return;
        if (window.scrollY > 4) { pulling = false; reset(); return; }
        const dy = e.touches[0].clientY - startY;
        if (dy <= 0) return;
        const ind = ensureIndicator();
        const t = Math.min(dy, MAX_PULL);
        ind.style.transform = `translate(-50%, ${t - 20}px)`;
        ind.style.opacity = String(Math.min(1, t / TRIGGER_PX));
        ind.classList.toggle('is-armed', t >= TRIGGER_PX);
        if (t >= TRIGGER_PX) {
            armed = true;
            ind.querySelector('.arcade-ptr-label').textContent = 'Release to refresh';
        } else {
            armed = false;
            ind.querySelector('.arcade-ptr-label').textContent = 'Pull to refresh';
        }
    }, { passive: true });

    document.addEventListener('touchend', () => {
        if (!pulling) return;
        pulling = false;
        if (armed) {
            armed = false;
            indicator.classList.add('is-loading');
            indicator.querySelector('.arcade-ptr-label').textContent = 'Refreshing…';
            // Bust caches and force a fresh fetch of games.json. We trigger
            // a full reload so app.js picks up the new catalog + any
            // updated wrappers / scripts.
            setTimeout(() => location.reload(), 120);
        } else {
            reset();
        }
    });

    function reset() {
        if (!indicator) return;
        indicator.style.transition = 'transform 0.2s, opacity 0.2s';
        indicator.style.transform = 'translate(-50%, -60px)';
        indicator.style.opacity = '0';
        setTimeout(() => {
            if (indicator) {
                indicator.style.transition = '';
                indicator.classList.remove('is-armed', 'is-loading');
            }
        }, 240);
    }
})();
