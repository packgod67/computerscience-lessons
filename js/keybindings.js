// Custom keybindings for arcade-wide shortcuts.
//
// Defaults:
//   r  → random game
//   /  → focus search
//   ?  → cheats / help (admin only — opens cheat manager)
//   g  → go to games tab
//   c  → chat tab
//   m  → messages tab
//
// User overrides stored in localStorage under `arcade-keybindings` as
// { action: keyChar }. Settings UI lives in settings.js.

(function () {
    const STORAGE = 'arcade-keybindings';
    const DEFAULTS = {
        random: 'r',
        search: '/',
        cheats: '?',
        tabGames: 'g',
        tabChat:  'c',
        tabMessages: 'm',
    };

    function load() {
        try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORAGE) || '{}')); }
        catch { return Object.assign({}, DEFAULTS); }
    }
    function save(map) {
        try { localStorage.setItem(STORAGE, JSON.stringify(map)); } catch {}
    }
    let bindings = load();

    function trigger(action) {
        switch (action) {
            case 'random':
                document.getElementById('randomGameBtn')?.click();
                break;
            case 'search':
                const s = document.getElementById('search');
                if (s) { s.focus(); s.select(); }
                break;
            case 'cheats':
                if (window.ArcadeAuth?.isAdmin?.()) {
                    document.querySelector('[data-tab="cheats"]')?.click();
                }
                break;
            case 'tabGames':    document.querySelector('[data-tab="games"]')?.click();    break;
            case 'tabChat':     document.querySelector('[data-tab="chat"]')?.click();     break;
            case 'tabMessages': document.querySelector('[data-tab="messages"]')?.click(); break;
        }
    }

    document.addEventListener('keydown', (e) => {
        // Ignore if typing in an input/textarea/contenteditable
        const t = e.target;
        if (t.matches?.('input, textarea, select, [contenteditable]')) return;
        // No modifier-only sequences — straight char only
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const key = e.key;
        for (const [action, bound] of Object.entries(bindings)) {
            if (bound === key) {
                e.preventDefault();
                trigger(action);
                return;
            }
        }
    });

    function set(action, key) {
        bindings[action] = key;
        save(bindings);
    }
    function reset() {
        bindings = Object.assign({}, DEFAULTS);
        save(bindings);
    }

    window.ArcadeKeybindings = {
        get: () => Object.assign({}, bindings),
        defaults: () => Object.assign({}, DEFAULTS),
        set, reset, trigger,
    };
})();
