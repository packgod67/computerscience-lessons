// ===== Cloud Save Helper =====
// Drop-in script for EmulatorJS games. Set window.CLOUD_SAVE_GAME_ID before
// loading this script. It auto-detects the emulator (across both newer
// genizy/emu and older seraph CDNs), announces readiness to the parent
// play.html, loads any cloud save, and auto-saves on an interval and on
// tab close. A small status pill in the top-right corner shows live state
// so users on mobile can see what's happening without devtools.
(function () {
    var GAME_ID = window.CLOUD_SAVE_GAME_ID;
    if (!GAME_ID) {
        console.warn('[cloud-save] no CLOUD_SAVE_GAME_ID set — cloud save disabled');
        return;
    }

    var announced = false;
    var pendingLoad = null;
    var statusEl = null;

    function log(msg) {
        try { console.log('[cloud-save:' + GAME_ID + ']', msg); } catch (e) {}
    }

    function showStatus(msg, color) {
        try {
            if (!statusEl) {
                statusEl = document.createElement('div');
                statusEl.style.cssText =
                    'position:fixed;top:8px;right:8px;' +
                    'background:rgba(26,26,46,0.95);color:#ddd;' +
                    'padding:5px 12px;border-radius:6px;' +
                    'font:500 12px/1 sans-serif;' +
                    'z-index:2147483647;pointer-events:none;' +
                    'transition:opacity 0.3s;border:1px solid #333;';
                (document.body || document.documentElement).appendChild(statusEl);
            }
            statusEl.style.color = color || '#ddd';
            statusEl.textContent = msg;
            statusEl.style.opacity = '1';
            clearTimeout(statusEl._t);
            statusEl._t = setTimeout(function () {
                if (statusEl) statusEl.style.opacity = '0.3';
            }, 3000);
        } catch (e) {}
    }

    function findEmulator() {
        try { if (typeof EJS_emulator !== 'undefined' && EJS_emulator) return EJS_emulator; } catch (e) {}
        try { if (window.EJS_emulator) return window.EJS_emulator; } catch (e) {}
        return null;
    }

    function getState() {
        var emu = findEmulator();
        if (!emu) return null;
        try {
            if (emu.gameManager && typeof emu.gameManager.getState === 'function') {
                var s = emu.gameManager.getState();
                if (s && s.byteLength > 0) return s;
            }
        } catch (e) { log('getState err: ' + e.message); }
        try {
            if (typeof emu.saveState === 'function') {
                var s2 = emu.saveState();
                if (s2 && s2.byteLength > 0) return s2;
            }
        } catch (e) {}
        return null;
    }

    function loadState(buffer) {
        var emu = findEmulator();
        if (!emu) return false;
        try {
            if (emu.gameManager && typeof emu.gameManager.loadState === 'function') {
                emu.gameManager.loadState(buffer);
                return true;
            }
        } catch (e) { log('loadState err: ' + e.message); }
        try {
            if (typeof emu.loadState === 'function') {
                emu.loadState(buffer);
                return true;
            }
        } catch (e) {}
        return false;
    }

    // Guardrails against mobile tab OOM + giving up gracefully when
    // Firestore rejects a save as too big.
    //   - small states (<800KB raw): save every 30s like before
    //   - big states (DS/PSX, 800KB-6MB): save every 3 min
    //   - huge states (>6MB): skip interval saves entirely
    //   - if the parent reports 'too-large' → disable cloud save for
    //     this session entirely, no more attempts
    var BIG_SAVE_THRESHOLD = 800 * 1024;
    var HUGE_SAVE_THRESHOLD = 6 * 1024 * 1024;
    var lastStateSize = 0;
    var cloudSaveDisabled = false;   // flipped true after 'too-large' event
    var disabledReason = '';

    function saveToCloud(reason) {
        if (cloudSaveDisabled) {
            // Silent — already told user once, don't spam
            return false;
        }
        var state = getState();
        if (!state) {
            log('save skipped — no state (' + (reason || '') + ')');
            return false;
        }
        lastStateSize = state.byteLength;

        // Mobile OOM safety: on HUGE saves, only allow save on explicit
        // page exit (tab close / visibility-hidden). Interval saves get
        // skipped to keep the tab alive.
        if (state.byteLength > HUGE_SAVE_THRESHOLD && reason === 'interval') {
            log('skipping interval save — state too big (' +
                Math.round(state.byteLength / 1024) + 'KB)');
            return false;
        }

        try {
            var bytes = new Uint8Array(state);
            var binary = '';
            // Chunked to avoid call stack overflow on large states
            var chunk = 0x8000;
            for (var i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode.apply(
                    null,
                    bytes.subarray(i, Math.min(i + chunk, bytes.length))
                );
            }
            window.parent.postMessage({
                type: 'save-data',
                gameId: GAME_ID,
                data: btoa(binary)
            }, '*');
            log('sent ' + bytes.length + ' bytes (' + (reason || '') + ')');
            showStatus('Saving… (' + Math.round(bytes.length / 1024) + 'KB)', '#60a5fa');
            // Free references so the GC can reclaim the big strings
            binary = null;
            bytes = null;
            return true;
        } catch (e) {
            log('save error: ' + e.message);
            showStatus('Save error: ' + e.message, '#f87171');
            return false;
        }
    }

    function applyPendingLoad() {
        if (!pendingLoad) return;
        var data = pendingLoad;
        try {
            var binary = atob(data);
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            if (loadState(bytes.buffer)) {
                log('loaded ' + bytes.length + ' bytes from cloud');
                showStatus('Cloud save loaded', '#4ade80');
                pendingLoad = null;
            } else {
                log('loadState API unavailable — will retry');
            }
        } catch (e) {
            log('apply load err: ' + e.message);
            pendingLoad = null;
        }
    }

    function announceReady() {
        if (announced) return;
        announced = true;
        log('emulator ready — announcing');
        showStatus('Cloud save active', '#4ade80');
        try {
            window.parent.postMessage({ type: 'emu-ready', gameId: GAME_ID }, '*');
        } catch (e) {}

        // If we already received cloud data, apply it now (retry a few times
        // in case gameManager.loadState needs a moment to be callable).
        var tries = 0;
        var loadTimer = setInterval(function () {
            tries++;
            if (!pendingLoad) { clearInterval(loadTimer); return; }
            applyPendingLoad();
            if (!pendingLoad || tries > 30) clearInterval(loadTimer);
        }, 1000);

        // NO initial save. Previously we saved at 15s to "capture early
        // progress", but this captured a mostly-empty state (user hasn't
        // played yet) and then stayed in the cloud. When the user later
        // refreshed + clicked "Load cloud save", that stale empty state
        // overwrote their in-progress SRAM. Interval saves + pagehide
        // save are enough — no bogus initial snapshot.

        // All cores save every 3 minutes. Previously small-state cores
        // (GBA/NES/SNES) fired every 30s — too aggressive. It chewed
        // mobile battery/memory, uploaded mostly-identical states, and
        // increased the chance of a bad state (captured mid-animation,
        // etc.) being in the cloud when the user comes back. 3 min is
        // the sweet spot: captures progress reliably without spamming.
        // Huge states (>6MB) still skip interval saves entirely.
        var INTERVAL_MS = 3 * 60 * 1000;
        var HUGE_INTERVAL_MS = 5 * 60 * 1000;  // re-check in case state shrinks
        function scheduleNextSave() {
            var delay = (lastStateSize > HUGE_SAVE_THRESHOLD)
                ? HUGE_INTERVAL_MS
                : INTERVAL_MS;
            setTimeout(function () {
                saveToCloud('interval');
                scheduleNextSave();
            }, delay);
        }
        scheduleNextSave();
    }

    // ----- Detection strategy 1: EJS_onGameStart (newer EmulatorJS) -----
    try {
        var prevOnGameStart = (typeof EJS_onGameStart === 'function') ? EJS_onGameStart : null;
        window.EJS_onGameStart = function () {
            if (prevOnGameStart) { try { prevOnGameStart(); } catch (e) {} }
            log('EJS_onGameStart fired');
            // Give gameManager a moment to attach
            setTimeout(announceReady, 500);
        };
    } catch (e) {}

    // ----- Detection strategy 2: Poll for the emulator global (older EJS) -----
    var pollCount = 0;
    var poll = setInterval(function () {
        pollCount++;
        var emu = findEmulator();
        if (emu && (emu.gameManager || typeof emu.saveState === 'function')) {
            clearInterval(poll);
            log('emulator detected by poll after ' + pollCount + ' tries');
            // Small delay so gameManager methods are fully wired
            setTimeout(announceReady, 2000);
        }
    }, 1000);
    setTimeout(function () { clearInterval(poll); }, 600000);

    // ----- Cheats from parent =====
    // Applies a list of {name, codes, type} objects via the EmulatorJS cheat
    // API. Held in `pendingCheats` until the emulator is ready, then drained.
    var pendingCheats = null;
    var cheatsApplied = false;

    function applyCheats(list) {
        var emu = findEmulator();
        if (!emu || !emu.gameManager) {
            pendingCheats = list;
            return false;
        }
        try {
            var gm = emu.gameManager;
            // Most EmulatorJS builds expose Module.ccall for libretro cheats,
            // or setCheat via the emulator frontend. Try the friendly API first.
            var applied = 0;
            for (var i = 0; i < list.length; i++) {
                var c = list[i];
                var codeText = (c.codes || '').trim();
                if (!codeText) continue;
                try {
                    if (typeof gm.setCheat === 'function') {
                        gm.setCheat(i, true, codeText);
                    } else if (typeof gm.addCheat === 'function') {
                        gm.addCheat(codeText, c.name || 'Cheat', true);
                    } else if (emu.cheats && Array.isArray(emu.cheats)) {
                        emu.cheats.push({ name: c.name || 'Cheat', code: codeText, enabled: true });
                    }
                    applied++;
                } catch (err) {
                    log('cheat apply err [' + (c.name || '') + ']: ' + err.message);
                }
            }
            log('applied ' + applied + '/' + list.length + ' cheats');
            showStatus(applied + ' cheats active', '#fbbf24');
            cheatsApplied = true;
            pendingCheats = null;
            return true;
        } catch (e) {
            log('applyCheats error: ' + e.message);
            return false;
        }
    }

    // ----- Messages from parent (cloud save data + cheats + failure signals) -----
    window.addEventListener('message', function (e) {
        if (!e.data || !e.data.type) return;
        if (e.data.type === 'load-save' && e.data.data) {
            log('load-save received (' + e.data.data.length + ' chars)');
            pendingLoad = e.data.data;
            applyPendingLoad();
        }
        if (e.data.type === 'apply-cheats' && Array.isArray(e.data.cheats)) {
            log('apply-cheats received (' + e.data.cheats.length + ' codes)');
            if (!applyCheats(e.data.cheats)) {
                // Emulator not ready yet; stash and try again post-announce
                pendingCheats = e.data.cheats;
            }
        }
        // Parent says cloud save is broken for this game (too big, auth,
        // or other permanent fail). Stop the interval and show the reason
        // once so we don't burn CPU and mobile RAM re-trying every cycle.
        if (e.data.type === 'cloud-save-disabled') {
            cloudSaveDisabled = true;
            disabledReason = e.data.reason || 'unavailable';
            log('cloud save disabled: ' + disabledReason);
            showStatus('Cloud save disabled — ' + disabledReason, '#f87171');
        }
    });

    // Retry any pending cheats every second until applied (complements
    // the emu-ready flow for older EmulatorJS builds where we can't hook
    // EJS_onGameStart cleanly).
    setInterval(function () {
        if (pendingCheats && !cheatsApplied) {
            applyCheats(pendingCheats);
        }
    }, 2000);

    // ----- Save on tab close / background -----
    window.addEventListener('beforeunload', function () { saveToCloud('beforeunload'); });
    window.addEventListener('pagehide', function () { saveToCloud('pagehide'); });
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') saveToCloud('visibility');
    });

    // Expose a manual trigger for debugging
    window.cloudSaveNow = function () { return saveToCloud('manual'); };

    log('script loaded, waiting for emulator…');
    showStatus('Waiting for emulator…', '#fbbf24');
})();
