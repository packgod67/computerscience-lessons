// Konami code easter egg.
//
// ↑ ↑ ↓ ↓ ← → ← → B A → unlocks "Rainbow mode" and rains confetti.
// Once unlocked, persists in localStorage; rainbow mode applies a
// continuously-cycling-hue accent across the site. Toggle off by
// running the code again (or via settings if we expose it there).
//
// Plays nicely with everything else: the rainbow accent is set on
// :root --accent / --profile-accent so all the other customization
// inherits, and toggling it off restores whatever wallpaper / theme
// accent was active.

(function () {
    const SEQUENCE = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown',
                       'ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
    const STORAGE_KEY = 'arcade-konami-unlocked';
    let position = 0;

    function isUnlocked() {
        return localStorage.getItem(STORAGE_KEY) === '1';
    }
    function setUnlocked(yes) {
        if (yes) localStorage.setItem(STORAGE_KEY, '1');
        else localStorage.removeItem(STORAGE_KEY);
    }

    document.addEventListener('keydown', (e) => {
        // Don't trigger while typing
        const t = e.target;
        if (t?.matches?.('input, textarea, select, [contenteditable]')) return;

        const wanted = SEQUENCE[position];
        const got = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (got === wanted) {
            position++;
            if (position === SEQUENCE.length) {
                position = 0;
                if (isUnlocked()) {
                    deactivate();
                    toast('🌈 Rainbow mode OFF');
                } else {
                    setUnlocked(true);
                    activate();
                    confetti();
                    toast('🌈 RAINBOW MODE UNLOCKED!');
                }
            }
        } else {
            position = got === SEQUENCE[0] ? 1 : 0;
        }
    });

    function activate() {
        document.documentElement.dataset.konami = '1';
    }
    function deactivate() {
        delete document.documentElement.dataset.konami;
        setUnlocked(false);
    }

    function toast(msg) {
        const el = document.createElement('div');
        el.className = 'konami-toast';
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.classList.add('konami-toast-fade'), 2400);
        setTimeout(() => el.remove(), 3000);
    }

    // Confetti burst — 80 particles drift down with random hues, sizes,
    // and rotations. Simple enough to not need a library.
    function confetti() {
        const layer = document.createElement('div');
        layer.className = 'konami-confetti-layer';
        document.body.appendChild(layer);
        for (let i = 0; i < 80; i++) {
            const p = document.createElement('div');
            p.className = 'konami-confetti';
            const hue = Math.random() * 360;
            p.style.background = `hsl(${hue}, 90%, 60%)`;
            p.style.left = Math.random() * 100 + '%';
            p.style.animationDelay = Math.random() * 0.4 + 's';
            p.style.animationDuration = (2 + Math.random() * 2) + 's';
            p.style.transform = `rotate(${Math.random() * 360}deg)`;
            p.style.width = (6 + Math.random() * 10) + 'px';
            p.style.height = (10 + Math.random() * 10) + 'px';
            layer.appendChild(p);
        }
        setTimeout(() => layer.remove(), 4500);
    }

    // Apply on load if previously unlocked
    if (isUnlocked()) activate();

    // Public API for settings UI
    window.ArcadeKonami = {
        isUnlocked, activate, deactivate,
        // Manual trigger for an admin's "test the easter egg" button
        triggerCelebration: () => { confetti(); toast('🎉'); },
    };
})();
