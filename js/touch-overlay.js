// Touch-control overlay injected into worker-proxied iframes.
//
// Plays nice with browser-native HTML5 games that ONLY listen for
// keyboard input — turning them into touch-playable phone games by
// synthesizing keyboard events from on-screen buttons.
//
// HOW IT WORKS
//   - The worker proxy at /itch/ inlines this script (as a <script>
//     tag with a literal body) into every HTML response. The iframe
//     ends up running on the worker's origin, so this code lives in
//     the same context as the game and CAN dispatch synthetic events
//     into the game's document.
//   - On mobile (touch-detected at runtime), we render a transparent
//     overlay with a D-pad (4 directions) + 3 action buttons (A/B/Start)
//     and a hide + settings toggle.
//   - Each button on press fires `keydown` + on release fires `keyup`,
//     dispatched to BOTH `document` and `window` (different game engines
//     listen on different targets), with all of `code`/`key`/`keyCode`/
//     `which` populated for maximum compatibility (older games use
//     deprecated `keyCode`; modern ones use `key` or `code`).
//
// USER-CONFIGURABLE CONTROLS
//   - Settings (⚙) opens a remap modal. Each slot (Up/Down/Left/Right/
//     A/B/Start) is a <select> over the KEY_OPTIONS catalog (Arrows,
//     WASD, ZX, JK, Enter, Space, Esc, Shift, common letters, digits).
//   - Save persists mapping to localStorage under
//     'arcade-touch-mapping' (per-origin — same worker proxy origin
//     for every game, so one setting applies everywhere).
//   - Presets: "Arrows + ZX" (default), "WASD + JK", "Reset" buttons
//     for one-tap reconfigure.
//
// DEFAULT KEY MAPPING (covers most 2D platformers / NES/SNES/GBA-style):
//   Up/Down/Left/Right → Arrow keys
//   A → Z (jump in many games)
//   B → X (action/secondary in many games)
//   Start → Enter (menus)
// Hide button collapses the overlay to a small reopen pip.
//
// HOSTED INSIDE THE WORKER PROXY
// This file is the source-of-truth. The worker stringifies it and
// inlines into proxied HTML. After editing, run
//   node scripts/embed-touch-overlay.mjs
// then re-deploy the worker.
//
// LIMITATIONS
//   - Games where canvas captures all events first: keys may not
//     reach the engine. Tested OK on Godot HTML5, GameMaker, GDevelop,
//     Construct, Phaser builds.
//   - Doesn't cover mouse-aim-required games (twin-stick shooters,
//     point-and-click adventures with cursor — those are already
//     touch-friendly natively).

(function () {
    // Don't double-install if already injected
    if (window.__arcadeTouchOverlayInstalled) return;
    window.__arcadeTouchOverlayInstalled = true;

    // Touch capability detection. Avoids showing on desktop where
    // it'd just be visual noise. matchMedia(hover:none) is more
    // reliable than checking ontouchstart (Chrome desktop reports
    // it true when DevTools mobile emulator is on).
    function isTouchDevice() {
        if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) return true;
        if ('ontouchstart' in window && (navigator.maxTouchPoints || 0) > 0) return true;
        return false;
    }

    if (!isTouchDevice()) return;

    // ─── KEY CATALOG ────────────────────────────────────────────────
    // Code → KeyboardEvent init bag. Codes are the stable identifiers
    // across keyboard layouts (KeyW is always the W position, even on
    // AZERTY); games that read `e.code` use these. We also populate
    // `key` (the produced character) and `keyCode` (deprecated but
    // still required by lots of older HTML5 games) so all three
    // listening styles work.
    var KEY_OPTIONS = {
        ArrowUp:    { code: 'ArrowUp',    key: 'ArrowUp',    keyCode: 38, label: '↑ Arrow Up' },
        ArrowDown:  { code: 'ArrowDown',  key: 'ArrowDown',  keyCode: 40, label: '↓ Arrow Down' },
        ArrowLeft:  { code: 'ArrowLeft',  key: 'ArrowLeft',  keyCode: 37, label: '← Arrow Left' },
        ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39, label: '→ Arrow Right' },
        KeyW: { code: 'KeyW', key: 'w', keyCode: 87, label: 'W' },
        KeyA: { code: 'KeyA', key: 'a', keyCode: 65, label: 'A' },
        KeyS: { code: 'KeyS', key: 's', keyCode: 83, label: 'S' },
        KeyD: { code: 'KeyD', key: 'd', keyCode: 68, label: 'D' },
        KeyZ: { code: 'KeyZ', key: 'z', keyCode: 90, label: 'Z' },
        KeyX: { code: 'KeyX', key: 'x', keyCode: 88, label: 'X' },
        KeyC: { code: 'KeyC', key: 'c', keyCode: 67, label: 'C' },
        KeyV: { code: 'KeyV', key: 'v', keyCode: 86, label: 'V' },
        KeyJ: { code: 'KeyJ', key: 'j', keyCode: 74, label: 'J' },
        KeyK: { code: 'KeyK', key: 'k', keyCode: 75, label: 'K' },
        KeyL: { code: 'KeyL', key: 'l', keyCode: 76, label: 'L' },
        KeyM: { code: 'KeyM', key: 'm', keyCode: 77, label: 'M' },
        KeyN: { code: 'KeyN', key: 'n', keyCode: 78, label: 'N' },
        KeyQ: { code: 'KeyQ', key: 'q', keyCode: 81, label: 'Q' },
        KeyE: { code: 'KeyE', key: 'e', keyCode: 69, label: 'E' },
        KeyR: { code: 'KeyR', key: 'r', keyCode: 82, label: 'R' },
        KeyF: { code: 'KeyF', key: 'f', keyCode: 70, label: 'F' },
        Digit1: { code: 'Digit1', key: '1', keyCode: 49, label: '1' },
        Digit2: { code: 'Digit2', key: '2', keyCode: 50, label: '2' },
        Digit3: { code: 'Digit3', key: '3', keyCode: 51, label: '3' },
        Digit4: { code: 'Digit4', key: '4', keyCode: 52, label: '4' },
        Space:      { code: 'Space',      key: ' ',      keyCode: 32, label: 'Space' },
        Enter:      { code: 'Enter',      key: 'Enter',  keyCode: 13, label: 'Enter' },
        Escape:     { code: 'Escape',     key: 'Escape', keyCode: 27, label: 'Esc' },
        ShiftLeft:  { code: 'ShiftLeft',  key: 'Shift',  keyCode: 16, label: 'Shift' },
        ControlLeft:{ code: 'ControlLeft',key: 'Control',keyCode: 17, label: 'Ctrl' },
        AltLeft:    { code: 'AltLeft',    key: 'Alt',    keyCode: 18, label: 'Alt' },
        Tab:        { code: 'Tab',        key: 'Tab',    keyCode: 9,  label: 'Tab' },
        Backspace:  { code: 'Backspace',  key: 'Backspace', keyCode: 8, label: 'Backspace' },
    };

    // Slots = the on-screen buttons. Default mapping covers most
    // arrow-key 2D games (NES/SNES-style + browser platformers).
    var SLOTS = ['Up', 'Down', 'Left', 'Right', 'A', 'B', 'Start'];
    var DEFAULT_MAPPING = {
        Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
        A: 'KeyZ', B: 'KeyX', Start: 'Enter',
    };
    var WASD_MAPPING = {
        Up: 'KeyW', Down: 'KeyS', Left: 'KeyA', Right: 'KeyD',
        A: 'KeyJ', B: 'KeyK', Start: 'Enter',
    };

    var STORAGE_KEY = 'arcade-touch-mapping';
    function loadMapping() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                var parsed = JSON.parse(raw);
                // Validate every slot resolves to a known KEY_OPTIONS
                // entry. Otherwise fall back to defaults — protects
                // against stale localStorage from older versions.
                var valid = SLOTS.every(function (s) { return KEY_OPTIONS[parsed[s]]; });
                if (valid) return parsed;
            }
        } catch (e) {}
        return Object.assign({}, DEFAULT_MAPPING);
    }
    function saveMapping(m) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); } catch (e) {}
    }

    var mapping = loadMapping();

    function fireKey(type, info) {
        try {
            var ev = new KeyboardEvent(type, {
                code: info.code,
                key: info.key,
                keyCode: info.keyCode,
                which: info.keyCode,
                bubbles: true,
                cancelable: true,
                composed: true,
            });
            // Some engines listen on document, some on window, some on
            // canvas/body. Dispatching on document covers ~95%; we also
            // hit window for the remainder.
            document.dispatchEvent(ev);
            window.dispatchEvent(ev);
            // Modern engines often listen on canvas elements directly
            var canvas = document.querySelector('canvas');
            if (canvas) canvas.dispatchEvent(ev);
        } catch (e) {}
    }

    function styleEl(el, css) {
        for (var k in css) el.style[k] = css[k];
    }

    var overlay = document.createElement('div');
    overlay.id = '__arcadeTouchOverlay';
    styleEl(overlay, {
        position: 'fixed',
        left: '0', right: '0', bottom: '0',
        zIndex: '999999',
        pointerEvents: 'none',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        padding: '12px 16px',
        paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
        paddingLeft: 'calc(16px + env(safe-area-inset-left, 0px))',
        paddingRight: 'calc(16px + env(safe-area-inset-right, 0px))',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        touchAction: 'none',
        font: '14px/1 system-ui, sans-serif',
    });

    // Track each button so we can re-render labels when mapping changes.
    var slotButtons = {}; // slot -> { btn, label }

    function makeBtn(label, slot, opts) {
        opts = opts || {};
        var b = document.createElement('button');
        b.textContent = label;
        b.setAttribute('aria-label', opts.ariaLabel || label);
        styleEl(b, Object.assign({
            width: '52px',
            height: '52px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.18)',
            color: 'white',
            border: '2px solid rgba(255,255,255,0.4)',
            fontSize: '18px',
            fontWeight: '700',
            pointerEvents: 'auto',
            cursor: 'pointer',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            textShadow: '0 1px 2px rgba(0,0,0,0.6)',
            boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
            touchAction: 'none',
        }, opts.style || {}));

        // Resolve the actual KeyboardEvent payload at press-time, NOT
        // at button-build-time. This lets remap take effect instantly
        // without rebuilding the overlay.
        function press(e) {
            e.preventDefault();
            e.stopPropagation();
            b.style.background = 'rgba(255,255,255,0.45)';
            var info = KEY_OPTIONS[mapping[slot]] || KEY_OPTIONS[DEFAULT_MAPPING[slot]];
            if (info) fireKey('keydown', info);
        }
        function release(e) {
            e.preventDefault();
            e.stopPropagation();
            b.style.background = opts.releaseBg || 'rgba(255,255,255,0.18)';
            var info = KEY_OPTIONS[mapping[slot]] || KEY_OPTIONS[DEFAULT_MAPPING[slot]];
            if (info) fireKey('keyup', info);
        }
        b.addEventListener('touchstart', press, { passive: false });
        b.addEventListener('touchend', release, { passive: false });
        b.addEventListener('touchcancel', release, { passive: false });
        // Mouse fallback for testing on desktop with DevTools mobile
        b.addEventListener('mousedown', press);
        b.addEventListener('mouseup', release);
        b.addEventListener('mouseleave', release);
        slotButtons[slot] = { btn: b, defaultLabel: label };
        return b;
    }

    // ─── D-pad cluster (left side) ──────────────────────────────────
    var dpad = document.createElement('div');
    styleEl(dpad, {
        position: 'relative',
        width: '160px',
        height: '160px',
        pointerEvents: 'none',
    });
    function placeDpadBtn(btn, x, y) {
        styleEl(btn, { position: 'absolute', left: x, top: y });
        dpad.appendChild(btn);
    }
    placeDpadBtn(makeBtn('▲', 'Up',    { ariaLabel: 'Up' }),    '54px', '0');
    placeDpadBtn(makeBtn('▼', 'Down',  { ariaLabel: 'Down' }),  '54px', '108px');
    placeDpadBtn(makeBtn('◀', 'Left',  { ariaLabel: 'Left' }),  '0',    '54px');
    placeDpadBtn(makeBtn('▶', 'Right', { ariaLabel: 'Right' }), '108px', '54px');

    // ─── Action buttons cluster (right side) ────────────────────────
    var actions = document.createElement('div');
    styleEl(actions, {
        position: 'relative',
        width: '160px',
        height: '160px',
        pointerEvents: 'none',
    });
    function placeActionBtn(btn, x, y, color) {
        styleEl(btn, {
            position: 'absolute',
            left: x, top: y,
            background: color,
        });
        actions.appendChild(btn);
    }
    var bBtn = makeBtn('B', 'B', { style: { width: '60px', height: '60px' }, releaseBg: 'rgba(239, 68, 68, 0.4)' });
    var aBtn = makeBtn('A', 'A', { style: { width: '60px', height: '60px' }, releaseBg: 'rgba(34, 197, 94, 0.4)' });
    var startBtn = makeBtn('Start', 'Start', { style: { width: '70px', height: '32px', fontSize: '12px', borderRadius: '16px' }, releaseBg: 'rgba(124, 58, 237, 0.4)' });
    placeActionBtn(bBtn,     '0',     '50px', 'rgba(239, 68, 68, 0.4)');
    placeActionBtn(aBtn,     '100px', '50px', 'rgba(34, 197, 94, 0.4)');
    placeActionBtn(startBtn, '45px', '0',     'rgba(124, 58, 237, 0.4)');

    overlay.appendChild(dpad);
    overlay.appendChild(actions);

    // ─── Hide / show toggle ─────────────────────────────────────────
    var hidden = false;
    var toggle = document.createElement('button');
    toggle.textContent = '⊟';
    toggle.setAttribute('aria-label', 'Hide controls');
    styleEl(toggle, {
        position: 'fixed',
        top: 'calc(8px + env(safe-area-inset-top, 0px))',
        right: '8px',
        width: '32px',
        height: '32px',
        borderRadius: '50%',
        background: 'rgba(0,0,0,0.5)',
        color: 'white',
        border: '1px solid rgba(255,255,255,0.3)',
        zIndex: '999999',
        fontSize: '16px',
        cursor: 'pointer',
        pointerEvents: 'auto',
    });
    toggle.addEventListener('click', function () {
        hidden = !hidden;
        overlay.style.display = hidden ? 'none' : 'flex';
        toggle.textContent = hidden ? '⊞' : '⊟';
        toggle.setAttribute('aria-label', hidden ? 'Show controls' : 'Hide controls');
    });

    // ─── Settings (remap) toggle ────────────────────────────────────
    var settingsBtn = document.createElement('button');
    settingsBtn.textContent = '⚙';
    settingsBtn.setAttribute('aria-label', 'Remap controls');
    styleEl(settingsBtn, {
        position: 'fixed',
        top: 'calc(8px + env(safe-area-inset-top, 0px))',
        right: '48px',
        width: '32px',
        height: '32px',
        borderRadius: '50%',
        background: 'rgba(0,0,0,0.5)',
        color: 'white',
        border: '1px solid rgba(255,255,255,0.3)',
        zIndex: '999999',
        fontSize: '16px',
        cursor: 'pointer',
        pointerEvents: 'auto',
    });
    settingsBtn.addEventListener('click', openRemapModal);

    // ─── Remap modal ────────────────────────────────────────────────
    // Built lazily on first open. Pause game-style: while open,
    // overlay buttons stay clickable but the modal is in front so
    // the user can configure without accidentally hitting D-pad.
    var modal = null;
    function buildModal() {
        modal = document.createElement('div');
        styleEl(modal, {
            position: 'fixed',
            inset: '0',
            background: 'rgba(0,0,0,0.85)',
            zIndex: '9999999',
            display: 'none',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            paddingTop: 'calc(16px + env(safe-area-inset-top, 0px))',
            paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
            font: '14px/1.4 system-ui, sans-serif',
        });

        var card = document.createElement('div');
        styleEl(card, {
            background: '#1a1a2a',
            color: 'white',
            borderRadius: '12px',
            padding: '20px',
            width: '100%',
            maxWidth: '360px',
            maxHeight: '100%',
            overflowY: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            border: '1px solid rgba(255,255,255,0.1)',
        });

        var title = document.createElement('h3');
        title.textContent = 'Remap Controls';
        styleEl(title, { margin: '0 0 4px', fontSize: '18px', fontWeight: '700' });
        card.appendChild(title);

        var sub = document.createElement('p');
        sub.textContent = 'Pick which keyboard key each button sends.';
        styleEl(sub, { margin: '0 0 16px', opacity: '0.7', fontSize: '13px' });
        card.appendChild(sub);

        // Preset row: one-tap apply common schemes.
        var presetRow = document.createElement('div');
        styleEl(presetRow, { display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' });
        function presetBtn(label, m) {
            var pb = document.createElement('button');
            pb.textContent = label;
            styleEl(pb, {
                flex: '1', minWidth: '0',
                padding: '8px 10px',
                borderRadius: '6px',
                background: 'rgba(124, 58, 237, 0.3)',
                color: 'white',
                border: '1px solid rgba(124, 58, 237, 0.6)',
                fontSize: '12px',
                fontWeight: '600',
                cursor: 'pointer',
            });
            pb.addEventListener('click', function () {
                Object.assign(mapping, m);
                refreshSelects();
            });
            return pb;
        }
        presetRow.appendChild(presetBtn('Arrows + ZX', DEFAULT_MAPPING));
        presetRow.appendChild(presetBtn('WASD + JK', WASD_MAPPING));
        card.appendChild(presetRow);

        // Build a row per slot: label + <select>.
        var selects = {}; // slot -> <select>
        SLOTS.forEach(function (slot) {
            var row = document.createElement('div');
            styleEl(row, {
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '8px 0',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
            });

            var lbl = document.createElement('div');
            lbl.textContent = slot;
            styleEl(lbl, { flex: '0 0 60px', fontWeight: '600', opacity: '0.9' });
            row.appendChild(lbl);

            var sel = document.createElement('select');
            styleEl(sel, {
                flex: '1',
                padding: '8px 10px',
                borderRadius: '6px',
                background: '#0e0e1a',
                color: 'white',
                border: '1px solid rgba(255,255,255,0.15)',
                fontSize: '14px',
            });
            Object.keys(KEY_OPTIONS).forEach(function (code) {
                var opt = document.createElement('option');
                opt.value = code;
                opt.textContent = KEY_OPTIONS[code].label;
                sel.appendChild(opt);
            });
            sel.value = mapping[slot];
            sel.addEventListener('change', function () {
                mapping[slot] = sel.value;
            });
            selects[slot] = sel;
            row.appendChild(sel);
            card.appendChild(row);
        });

        function refreshSelects() {
            SLOTS.forEach(function (slot) { selects[slot].value = mapping[slot]; });
        }

        // Footer: Save / Reset / Cancel.
        var footer = document.createElement('div');
        styleEl(footer, { display: 'flex', gap: '8px', marginTop: '16px' });

        var resetBtn = document.createElement('button');
        resetBtn.textContent = 'Reset';
        styleEl(resetBtn, {
            padding: '10px 14px',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.08)',
            color: 'white',
            border: '1px solid rgba(255,255,255,0.15)',
            fontWeight: '600',
            cursor: 'pointer',
        });
        resetBtn.addEventListener('click', function () {
            Object.assign(mapping, DEFAULT_MAPPING);
            refreshSelects();
        });

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        styleEl(cancelBtn, {
            flex: '1',
            padding: '10px 14px',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.08)',
            color: 'white',
            border: '1px solid rgba(255,255,255,0.15)',
            fontWeight: '600',
            cursor: 'pointer',
        });
        cancelBtn.addEventListener('click', function () {
            // Restore mapping to whatever's persisted, in case user
            // changed selects but doesn't want to save.
            mapping = loadMapping();
            refreshSelects();
            modal.style.display = 'none';
        });

        var saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        styleEl(saveBtn, {
            flex: '1',
            padding: '10px 14px',
            borderRadius: '6px',
            background: 'rgba(34, 197, 94, 0.7)',
            color: 'white',
            border: '1px solid rgba(34, 197, 94, 0.9)',
            fontWeight: '700',
            cursor: 'pointer',
        });
        saveBtn.addEventListener('click', function () {
            saveMapping(mapping);
            modal.style.display = 'none';
        });

        footer.appendChild(resetBtn);
        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);
        card.appendChild(footer);

        modal.appendChild(card);
        // Don't dismiss on backdrop click — too easy to lose changes
        // by accident. Cancel button is the only exit.
        document.body.appendChild(modal);
    }
    function openRemapModal() {
        if (!modal) buildModal();
        // Always re-sync selects to current mapping in case it was
        // changed elsewhere (e.g. another open-then-cancel).
        var selects = modal.querySelectorAll('select');
        var i = 0;
        SLOTS.forEach(function (slot) {
            if (selects[i]) selects[i].value = mapping[slot];
            i++;
        });
        modal.style.display = 'flex';
    }

    // ─── Mount ──────────────────────────────────────────────────────
    function mount() {
        if (!document.body) {
            setTimeout(mount, 50);
            return;
        }
        document.body.appendChild(overlay);
        document.body.appendChild(toggle);
        document.body.appendChild(settingsBtn);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
