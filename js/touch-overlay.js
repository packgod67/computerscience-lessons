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
//     and a hide toggle.
//   - Each button on press fires `keydown` + on release fires `keyup`,
//     dispatched to BOTH `document` and `window` (different game engines
//     listen on different targets), with all of `code`/`key`/`keyCode`/
//     `which` populated for maximum compatibility (older games use
//     deprecated `keyCode`; modern ones use `key` or `code`).
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
// inlines into proxied HTML. After editing, re-deploy the worker.
//
// LIMITATIONS
//   - Games using WASD instead of arrows: don't work with default
//     mapping; would need per-game override.
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

    var KEYS = {
        Up:    { code: 'ArrowUp',    key: 'ArrowUp',    keyCode: 38 },
        Down:  { code: 'ArrowDown',  key: 'ArrowDown',  keyCode: 40 },
        Left:  { code: 'ArrowLeft',  key: 'ArrowLeft',  keyCode: 37 },
        Right: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
        A:     { code: 'KeyZ',       key: 'z',          keyCode: 90 },
        B:     { code: 'KeyX',       key: 'x',          keyCode: 88 },
        Start: { code: 'Enter',      key: 'Enter',      keyCode: 13 },
        Space: { code: 'Space',      key: ' ',          keyCode: 32 },
    };

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

    function makeBtn(label, key, opts) {
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

        function press(e) {
            e.preventDefault();
            e.stopPropagation();
            b.style.background = 'rgba(255,255,255,0.45)';
            fireKey('keydown', key);
        }
        function release(e) {
            e.preventDefault();
            e.stopPropagation();
            b.style.background = 'rgba(255,255,255,0.18)';
            fireKey('keyup', key);
        }
        b.addEventListener('touchstart', press, { passive: false });
        b.addEventListener('touchend', release, { passive: false });
        b.addEventListener('touchcancel', release, { passive: false });
        // Mouse fallback for testing on desktop with DevTools mobile
        b.addEventListener('mousedown', press);
        b.addEventListener('mouseup', release);
        b.addEventListener('mouseleave', release);
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
    placeDpadBtn(makeBtn('▲', KEYS.Up,    { ariaLabel: 'Up' }),    '54px', '0');
    placeDpadBtn(makeBtn('▼', KEYS.Down,  { ariaLabel: 'Down' }),  '54px', '108px');
    placeDpadBtn(makeBtn('◀', KEYS.Left,  { ariaLabel: 'Left' }),  '0',    '54px');
    placeDpadBtn(makeBtn('▶', KEYS.Right, { ariaLabel: 'Right' }), '108px', '54px');

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
    placeActionBtn(makeBtn('B', KEYS.B,     { style: { width: '60px', height: '60px' } }), '0',     '50px', 'rgba(239, 68, 68, 0.4)');
    placeActionBtn(makeBtn('A', KEYS.A,     { style: { width: '60px', height: '60px' } }), '100px', '50px', 'rgba(34, 197, 94, 0.4)');
    placeActionBtn(makeBtn('Start', KEYS.Start, { style: { width: '70px', height: '32px', fontSize: '12px', borderRadius: '16px' } }), '45px', '0', 'rgba(124, 58, 237, 0.4)');

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

    // ─── Mount ──────────────────────────────────────────────────────
    function mount() {
        if (!document.body) {
            setTimeout(mount, 50);
            return;
        }
        document.body.appendChild(overlay);
        document.body.appendChild(toggle);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();
