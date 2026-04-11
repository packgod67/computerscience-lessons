// ===== 3DS Foldable Mode for NDS Games =====
// Detects foldable/large touchscreens and creates a 3DS-style layout:
// Top half = game screen, Bottom half = D-pad + buttons
(function () {
    // Detect: touchscreen + large enough screen (foldable unfolded or tablet)
    // Honor Magic V3 unfolded: ~2156x2344, ratio close to 1:1
    function isFoldableMode() {
        const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        if (!hasTouch) return false;
        const w = window.screen.width;
        const h = window.screen.height;
        const minDim = Math.min(w, h);
        // Foldable unfolded or large tablet in portrait: min dimension > 600px
        return minDim > 600;
    }

    if (!isFoldableMode()) return;

    // Disable EmulatorJS default virtual gamepad — we'll provide our own
    window.EJS_VirtualGamepadEnabled = false;

    // EmulatorJS key mappings for NDS
    const KEY_MAP = {
        'dpad-up': 'ArrowUp',
        'dpad-down': 'ArrowDown',
        'dpad-left': 'ArrowLeft',
        'dpad-right': 'ArrowRight',
        'btn-a': 'z',
        'btn-b': 'x',
        'btn-x': 'a',
        'btn-y': 's',
        'btn-l': 'q',
        'btn-r': 'e',
        'btn-start': 'Enter',
        'btn-select': 'v',
    };

    function sendKey(key, type) {
        const event = new KeyboardEvent(type, {
            key: key,
            code: key === 'ArrowUp' ? 'ArrowUp' :
                  key === 'ArrowDown' ? 'ArrowDown' :
                  key === 'ArrowLeft' ? 'ArrowLeft' :
                  key === 'ArrowRight' ? 'ArrowRight' :
                  key === 'Enter' ? 'Enter' :
                  'Key' + key.toUpperCase(),
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(event);
    }

    function setupLayout() {
        const body = document.body || document.documentElement;

        // Restructure: game on top, controls on bottom
        body.classList.add('ds-mode');

        // Inject CSS
        const style = document.createElement('style');
        style.textContent = `
            .ds-mode {
                display: flex !important;
                flex-direction: column !important;
                height: 100vh !important;
                height: 100dvh !important;
                overflow: hidden !important;
                margin: 0 !important;
                padding: 0 !important;
                background: #1a1a2e !important;
                align-items: stretch !important;
                justify-content: flex-start !important;
            }
            .ds-mode #game-container {
                flex: 1 !important;
                display: flex !important;
                flex-direction: column !important;
                min-height: 0 !important;
            }
            .ds-mode #game {
                flex: 1 !important;
                min-height: 0 !important;
            }
            .ds-mode #game canvas,
            .ds-mode #game > div {
                width: 100% !important;
                height: 100% !important;
            }

            /* ===== 3DS Gamepad ===== */
            .ds-gamepad {
                flex-shrink: 0;
                height: 46vh;
                background: linear-gradient(180deg, #1e1e30 0%, #14142a 100%);
                border-top: 3px solid #2d2d5e;
                display: grid;
                grid-template-columns: 1fr 1fr;
                grid-template-rows: auto 1fr auto;
                padding: 8px 12px;
                gap: 0;
                touch-action: none;
                user-select: none;
                -webkit-user-select: none;
                position: relative;
            }

            /* Top row: L and R shoulder buttons */
            .ds-shoulders {
                grid-column: 1 / -1;
                display: flex;
                justify-content: space-between;
                padding: 0 4px 6px;
            }
            .ds-shoulder-btn {
                width: 80px;
                height: 36px;
                border-radius: 18px 18px 6px 6px;
                background: linear-gradient(180deg, #3a3a6e, #2a2a5a);
                border: 2px solid #4a4a8e;
                color: #b0b0e0;
                font-size: 14px;
                font-weight: 700;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: background 0.1s;
            }
            .ds-shoulder-btn:active, .ds-shoulder-btn.pressed {
                background: linear-gradient(180deg, #5a5aae, #3a3a7e);
                border-color: #7a7ace;
                color: #fff;
            }

            /* Left side: D-pad */
            .ds-left {
                display: flex;
                align-items: center;
                justify-content: center;
                padding-left: 10px;
            }
            .ds-dpad {
                position: relative;
                width: 140px;
                height: 140px;
            }
            .ds-dpad-btn {
                position: absolute;
                background: linear-gradient(180deg, #2e2e58, #222248);
                border: 2px solid #3e3e78;
                color: #8888bb;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 22px;
                cursor: pointer;
                border-radius: 8px;
                transition: background 0.05s;
            }
            .ds-dpad-btn:active, .ds-dpad-btn.pressed {
                background: linear-gradient(180deg, #4e4e98, #3a3a7e);
                border-color: #6a6abe;
                color: #fff;
            }
            .ds-dpad-center {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 40px;
                height: 40px;
                background: #252550;
                border-radius: 50%;
                border: 2px solid #3a3a6e;
                z-index: 1;
            }
            .ds-dpad-up {
                top: 0; left: 50%; transform: translateX(-50%);
                width: 44px; height: 52px;
                border-radius: 10px 10px 4px 4px;
            }
            .ds-dpad-down {
                bottom: 0; left: 50%; transform: translateX(-50%);
                width: 44px; height: 52px;
                border-radius: 4px 4px 10px 10px;
            }
            .ds-dpad-left {
                left: 0; top: 50%; transform: translateY(-50%);
                width: 52px; height: 44px;
                border-radius: 10px 4px 4px 10px;
            }
            .ds-dpad-right {
                right: 0; top: 50%; transform: translateY(-50%);
                width: 52px; height: 44px;
                border-radius: 4px 10px 10px 4px;
            }

            /* Right side: A/B/X/Y diamond */
            .ds-right {
                display: flex;
                align-items: center;
                justify-content: center;
                padding-right: 10px;
            }
            .ds-buttons {
                position: relative;
                width: 140px;
                height: 140px;
            }
            .ds-action-btn {
                position: absolute;
                width: 48px;
                height: 48px;
                border-radius: 50%;
                border: 2px solid #3e3e78;
                color: #b0b0e0;
                font-size: 16px;
                font-weight: 800;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: background 0.05s;
            }
            /* A = right (green tint) */
            .ds-btn-a {
                background: linear-gradient(180deg, #1e5e3e, #184830);
                border-color: #2e8e5e;
                right: 0; top: 50%; transform: translateY(-50%);
            }
            .ds-btn-a:active, .ds-btn-a.pressed {
                background: linear-gradient(180deg, #2eae6e, #1e8e4e);
                color: #fff;
            }
            /* B = bottom (red tint) */
            .ds-btn-b {
                background: linear-gradient(180deg, #5e1e1e, #481818);
                border-color: #8e2e2e;
                bottom: 0; left: 50%; transform: translateX(-50%);
            }
            .ds-btn-b:active, .ds-btn-b.pressed {
                background: linear-gradient(180deg, #ae2e2e, #8e1e1e);
                color: #fff;
            }
            /* X = top (blue tint) */
            .ds-btn-x {
                background: linear-gradient(180deg, #1e1e5e, #181848);
                border-color: #2e2e8e;
                top: 0; left: 50%; transform: translateX(-50%);
            }
            .ds-btn-x:active, .ds-btn-x.pressed {
                background: linear-gradient(180deg, #2e2eae, #1e1e8e);
                color: #fff;
            }
            /* Y = left (yellow tint) */
            .ds-btn-y {
                background: linear-gradient(180deg, #5e5e1e, #484818);
                border-color: #8e8e2e;
                left: 0; top: 50%; transform: translateY(-50%);
            }
            .ds-btn-y:active, .ds-btn-y.pressed {
                background: linear-gradient(180deg, #aeae2e, #8e8e1e);
                color: #fff;
            }

            /* Bottom row: Start / Select */
            .ds-bottom-row {
                grid-column: 1 / -1;
                display: flex;
                justify-content: center;
                gap: 24px;
                padding-top: 4px;
            }
            .ds-small-btn {
                width: 64px;
                height: 28px;
                border-radius: 14px;
                background: linear-gradient(180deg, #2a2a50, #1e1e40);
                border: 2px solid #3a3a6e;
                color: #8888bb;
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 1px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: background 0.1s;
            }
            .ds-small-btn:active, .ds-small-btn.pressed {
                background: linear-gradient(180deg, #4a4a90, #3a3a7e);
                border-color: #6a6abe;
                color: #fff;
            }

            /* Hinge line between screens */
            .ds-hinge {
                height: 3px;
                background: linear-gradient(90deg, #0a0a1a, #2d2d5e, #0a0a1a);
                flex-shrink: 0;
            }
        `;
        document.head.appendChild(style);

        // Create gamepad HTML
        const hinge = document.createElement('div');
        hinge.className = 'ds-hinge';

        const gamepad = document.createElement('div');
        gamepad.className = 'ds-gamepad';
        gamepad.innerHTML = `
            <div class="ds-shoulders">
                <button class="ds-shoulder-btn" data-btn="btn-l">L</button>
                <button class="ds-shoulder-btn" data-btn="btn-r">R</button>
            </div>
            <div class="ds-left">
                <div class="ds-dpad">
                    <div class="ds-dpad-center"></div>
                    <button class="ds-dpad-btn ds-dpad-up" data-btn="dpad-up">▲</button>
                    <button class="ds-dpad-btn ds-dpad-down" data-btn="dpad-down">▼</button>
                    <button class="ds-dpad-btn ds-dpad-left" data-btn="dpad-left">◀</button>
                    <button class="ds-dpad-btn ds-dpad-right" data-btn="dpad-right">►</button>
                </div>
            </div>
            <div class="ds-right">
                <div class="ds-buttons">
                    <button class="ds-action-btn ds-btn-a" data-btn="btn-a">A</button>
                    <button class="ds-action-btn ds-btn-b" data-btn="btn-b">B</button>
                    <button class="ds-action-btn ds-btn-x" data-btn="btn-x">X</button>
                    <button class="ds-action-btn ds-btn-y" data-btn="btn-y">Y</button>
                </div>
            </div>
            <div class="ds-bottom-row">
                <button class="ds-small-btn" data-btn="btn-select">SELECT</button>
                <button class="ds-small-btn" data-btn="btn-start">START</button>
            </div>
        `;

        // Insert after game container
        body.appendChild(hinge);
        body.appendChild(gamepad);

        // Wire up touch events
        const activeButtons = new Set();

        gamepad.addEventListener('touchstart', handleTouch, { passive: false });
        gamepad.addEventListener('touchmove', handleTouch, { passive: false });
        gamepad.addEventListener('touchend', handleTouchEnd, { passive: false });
        gamepad.addEventListener('touchcancel', handleTouchEnd, { passive: false });

        // Also support mouse for testing
        gamepad.addEventListener('mousedown', (e) => {
            const btn = e.target.closest('[data-btn]');
            if (!btn) return;
            e.preventDefault();
            pressButton(btn.dataset.btn, btn);
        });
        document.addEventListener('mouseup', () => {
            releaseAll();
        });

        function handleTouch(e) {
            e.preventDefault();
            const nowActive = new Set();

            for (const touch of e.touches) {
                const el = document.elementFromPoint(touch.clientX, touch.clientY);
                if (el) {
                    const btn = el.closest('[data-btn]');
                    if (btn) {
                        nowActive.add(btn.dataset.btn);
                        if (!activeButtons.has(btn.dataset.btn)) {
                            pressButton(btn.dataset.btn, btn);
                        }
                    }
                }
            }

            // Release buttons no longer touched
            for (const btnId of activeButtons) {
                if (!nowActive.has(btnId)) {
                    releaseButton(btnId);
                }
            }
        }

        function handleTouchEnd(e) {
            e.preventDefault();
            const stillActive = new Set();

            for (const touch of e.touches) {
                const el = document.elementFromPoint(touch.clientX, touch.clientY);
                if (el) {
                    const btn = el.closest('[data-btn]');
                    if (btn) stillActive.add(btn.dataset.btn);
                }
            }

            for (const btnId of activeButtons) {
                if (!stillActive.has(btnId)) {
                    releaseButton(btnId);
                }
            }
        }

        function pressButton(btnId, el) {
            const key = KEY_MAP[btnId];
            if (!key) return;
            activeButtons.add(btnId);
            sendKey(key, 'keydown');
            // Visual feedback
            if (el) el.classList.add('pressed');
            else {
                const found = gamepad.querySelector(`[data-btn="${btnId}"]`);
                if (found) found.classList.add('pressed');
            }
        }

        function releaseButton(btnId) {
            const key = KEY_MAP[btnId];
            if (!key) return;
            activeButtons.delete(btnId);
            sendKey(key, 'keyup');
            const found = gamepad.querySelector(`[data-btn="${btnId}"]`);
            if (found) found.classList.remove('pressed');
        }

        function releaseAll() {
            for (const btnId of activeButtons) {
                releaseButton(btnId);
            }
        }
    }

    // Wait for DOM then set up
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupLayout);
    } else {
        setupLayout();
    }
})();
